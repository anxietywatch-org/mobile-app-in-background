import {
  NativeEventEmitter,
  NativeModules,
  type EmitterSubscription,
} from 'react-native';
import type {
  AuthResult,
  DeliveryResult,
  FogEntry,
  FogIdentity,
} from './types';
import { deliverEntry } from './api';
import { FogEndpoints } from './enricher';
import { clearPersistedAuth, persistAuth, restoreAuth } from './auth';

const { WearFog } = NativeModules;
const events = new NativeEventEmitter(WearFog);

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface FogNodeState {
  identity: FogIdentity;
  token: string;
  pending: number;
  lastDelivery: DeliveryResult | null;
  unauthorized: boolean;
}

export type FogStateListener = (state: FogNodeState) => void;

const BASE_URL = FogEndpoints.API_BASE;
const DELIVERABLE_KINDS = ['telemetry', 'sos', 'sos-cancel'];

/**
 * Orquestador del nodo fog.
 *
 *  - recoge sobres del reloj (WearFog.peek / evento FogInbound)
 *  - los enriquece y envía al API del backend
 *  - confirma al reloj por ACK solo cuando el API aceptó (202) o detectó
 *    duplicado (200); el ACK usa el entityId pelado (batchId/eventId), nunca el
 *    key compuesto "kind:entityId"
 *  - si falla la red o el API rechaza, la entrada pasa a FAILED con backoff
 *    nativo y se reintenta; los sobres "veneno" (no parseables) expiran por
 *    retención en la capa nativa
 */
class FogNode {
  private identity: FogIdentity = {
    userId: '',
    deviceId: '',
    sessionId: '',
    sequence: 0,
  };
  private token = '';
  private listeners = new Set<FogStateListener>();
  private busy = false;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inboundSubscription: EmitterSubscription | null = null;
  private pending = 0;
  private lastDelivery: DeliveryResult | null = null;
  private unauthorized = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.loadIdentity();
    const auth = await restoreAuth();
    if (auth) await this.applyAuthentication(auth);
    await WearFog.announceFogPhone();
    this.inboundSubscription = events.addListener('FogInbound', () => {
      void this.flush();
    });
    this.timer = setInterval(() => void this.flush(), 15_000);
    await this.flush();
    this.emit();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.inboundSubscription?.remove();
    this.inboundSubscription = null;
  }

  async loadIdentity(): Promise<void> {
    let raw = '';
    try {
      raw = await WearFog.getIdentity();
    } catch {
      raw = '';
    }
    let parsed: FogIdentity = {
      userId: '',
      deviceId: '',
      sessionId: '',
      sequence: 0,
    };
    try {
      parsed = JSON.parse(raw) as FogIdentity;
    } catch {
      parsed = {
        userId: '',
        deviceId: '',
        sessionId: '',
        sequence: 0,
      };
    }
    this.identity = {
      userId: parsed.userId ?? '',
      deviceId: parsed.deviceId || uuid(),
      sessionId: parsed.sessionId || uuid(),
      sequence: parsed.sequence ?? 0,
    };
    if (
      parsed.deviceId !== this.identity.deviceId ||
      parsed.sessionId !== this.identity.sessionId
    ) {
      await this.persistIdentity();
    }
    try {
      this.token = (await WearFog.getToken()) || this.token;
    } catch {
      // Compatibilidad con instalaciones anteriores del puente nativo.
    }
  }

  private async persistIdentity(): Promise<void> {
    await WearFog.setIdentity(this.identity);
  }

  async setAuthenticated(auth: AuthResult): Promise<void> {
    await persistAuth(auth);
    try {
      await WearFog.setToken(auth.token);
    } catch {
      // Compatibilidad con puentes nativos anteriores.
    }
    await this.applyAuthentication(auth);
    await this.flush();
  }

  private async applyAuthentication(auth: AuthResult): Promise<void> {
    this.token = auth.token;
    this.identity = { ...this.identity, userId: auth.user.id };
    this.unauthorized = false;
    await this.persistIdentity();
    this.emit();
  }

  async clearAuthentication(): Promise<void> {
    await clearPersistedAuth();
    this.token = '';
    try {
      await WearFog.setToken('');
    } catch {
      // clearAuth sigue limpiando versiones anteriores del almacén.
    }
    this.identity = { ...this.identity, userId: '' };
    this.unauthorized = false;
    await this.persistIdentity();
    this.emit();
  }

  async runOnce(): Promise<void> {
    await this.loadIdentity();
    const auth = await restoreAuth();
    if (auth) await this.applyAuthentication(auth);
    await WearFog.announceFogPhone();
    await this.flush();
  }

  async nextSequence(): Promise<number> {
    const next = await WearFog.nextSequence();
    this.identity.sequence = next;
    return next;
  }

  private async failEntry(entry: FogEntry): Promise<void> {
    try {
      await WearFog.markFailed(entry.key);
    } catch {
      // La cola nativa reintenta en el siguiente ciclo de todas formas.
    }
  }

  private async flush(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.token || !this.identity.userId) {
        const pending = await WearFog.inboundCount();
        this.pending = pending;
        if (pending > 0) {
          this.setUnauthorized();
        }
        return;
      }
      const raw = await WearFog.peek();
      let entries: FogEntry[] = [];
      try {
        entries = JSON.parse(raw || '[]');
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!DELIVERABLE_KINDS.includes(entry.kind)) {
          await WearFog.complete(entry.key);
          continue;
        }
        let result: DeliveryResult;
        try {
          result = await deliverEntry(
            entry,
            this.identity,
            this.token,
            BASE_URL,
          );
        } catch {
          // Error de red/timeout: backoff nativo y se reintenta el siguiente ciclo.
          await this.failEntry(entry);
          continue;
        }
        if (result.status === 'accepted' || result.status === 'duplicate') {
          await this.nextSequence();
          await WearFog.markCloudAcked(entry.key);
          if (await this.tryAck(entry)) {
            await WearFog.markWatchAcked(entry.key);
            await WearFog.complete(entry.key);
            this.lastDelivery = result;
          } else {
            // El API aceptó pero el reloj no confirmó: se reintenta el ACK.
            await this.failEntry(entry);
          }
        } else if (result.status === 'unauthorized') {
          await this.invalidateAuthentication();
          break;
        } else {
          // failed (envelope no parseable o rechazo del API): backoff nativo.
          await this.failEntry(entry);
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'fog flush failed',
          detail: String(error),
        }),
      );
    } finally {
      this.busy = false;
      try {
        this.pending = await WearFog.inboundCount();
      } catch {
        // Se conserva el valor anterior de pending.
      }
      if (this.pending > 0) {
        try {
          await WearFog.scheduleSync(600_000);
        } catch {
          // El temporizador JS conserva el reintento en versiones anteriores.
        }
      }
      this.emit();
    }
  }

  private async tryAck(entry: FogEntry): Promise<boolean> {
    try {
      if (entry.kind === 'telemetry') {
        return (await WearFog.ackTelemetry(entry.entityId)) === true;
      }
      if (entry.kind === 'sos') {
        return (await WearFog.ackSos(entry.entityId)) === true;
      }
      if (entry.kind === 'sos-cancel') {
        return (await WearFog.ackSosCancel(entry.entityId)) === true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private setUnauthorized(): void {
    this.unauthorized = true;
  }

  private async invalidateAuthentication(): Promise<void> {
    this.token = '';
    this.setUnauthorized();
    await clearPersistedAuth();
    try {
      await WearFog.setToken('');
    } catch {
      // clearPersistedAuth ya limpió el almacén compatible.
    }
  }

  private emit(): void {
    const state: FogNodeState = {
      identity: this.identity,
      token: this.token,
      pending: this.pending,
      lastDelivery: this.lastDelivery,
      unauthorized: this.unauthorized,
    };
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  subscribe(listener: FogStateListener): () => void {
    this.listeners.add(listener);
    listener({
      identity: this.identity,
      token: this.token,
      pending: this.pending,
      lastDelivery: this.lastDelivery,
      unauthorized: this.unauthorized,
    });
    return () => this.listeners.delete(listener);
  }

  getPending(): Promise<number> {
    return WearFog.inboundCount();
  }

  getState(): FogNodeState {
    return {
      identity: this.identity,
      token: this.token,
      pending: this.pending,
      lastDelivery: this.lastDelivery,
      unauthorized: this.unauthorized,
    };
  }
}

export const fogNode = new FogNode();
export { BASE_URL };
