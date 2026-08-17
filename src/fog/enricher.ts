import type {
  FogIdentity,
  SosCancelPayload,
  SosTriggerPayload,
  TelemetryBatchPayload,
  TelemetrySample,
  WearSosCancelEnvelope,
  WearSosEnvelope,
  WearTelemetryEnvelope,
} from './types';

const API_BASE = 'https://api.mangoon.xyz';

// Tipos de registro tal como los escribe el reloj (WearDatabase, en minúscula).
const HEART_RATE = 'heart_rate';
const MOTION = 'motion';
const SKIN_TEMP = 'skin_temperature';

function toSignalQuality(value: unknown): 'good' | 'fair' | 'poor' | 'unknown' {
  if (typeof value === 'number') {
    if (value >= 0.8) return 'good';
    if (value >= 0.5) return 'fair';
    return 'poor';
  }
  if (typeof value === 'string') {
    return (['good', 'fair', 'poor', 'unknown'] as const).includes(
      value as never,
    )
      ? (value as 'good' | 'fair' | 'poor' | 'unknown')
      : 'unknown';
  }
  return 'unknown';
}

function isoOrNull(timestamp: string | number): string | null {
  if (timestamp === null || timestamp === undefined) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function iso(timestamp: string | number): string {
  return isoOrNull(timestamp) ?? timestamp.toString();
}

function payloadOf(record: {
  payload: Record<string, unknown> | null;
}): Record<string, unknown> {
  return record.payload ?? {};
}

function sampleFromRecord(record: {
  capturedAt: string;
  type: string;
  payload: Record<string, unknown> | null;
}): TelemetrySample | null {
  const timestamp = isoOrNull(record.capturedAt);
  if (!timestamp) return null;
  const p = payloadOf(record);
  const commonQuality = toSignalQuality(p.signalQuality ?? p.quality);

  switch (record.type) {
    case HEART_RATE:
      return {
        timestamp,
        heartRateBpm: typeof p.bpm === 'number' ? p.bpm : null,
        ibiMs: Array.isArray(p.ibiMillis)
          ? (p.ibiMillis as number[])
              .filter(v => typeof v === 'number')
              .slice(0, 16)
          : [],
        accelerometer: null,
        skinTemperatureCelsius: null,
        ambientTemperatureCelsius: null,
        quality: {
          heartRate: commonQuality,
          ibi: commonQuality,
          wearingState: 'unknown',
        },
      };
    case MOTION:
      return {
        timestamp,
        heartRateBpm: null,
        ibiMs: [],
        accelerometer: null,
        skinTemperatureCelsius: null,
        ambientTemperatureCelsius: null,
        quality: {
          heartRate: 'unknown',
          ibi: 'unknown',
          wearingState: 'unknown',
        },
      };
    case SKIN_TEMP:
      return {
        timestamp,
        heartRateBpm: null,
        ibiMs: [],
        accelerometer: null,
        skinTemperatureCelsius:
          typeof p.celsius === 'number' ? (p.celsius as number) : null,
        ambientTemperatureCelsius: null,
        quality: {
          heartRate: 'unknown',
          ibi: 'unknown',
          wearingState: 'unknown',
        },
      };
    default:
      // steps / availability / tipos desconocidos no tienen representación
      // en el DTO público del cloud: se descartan del lote.
      return null;
  }
}

export function enrichTelemetry(
  envelope: WearTelemetryEnvelope,
  identity: FogIdentity,
): TelemetryBatchPayload | null {
  const samples = envelope.records
    .map(sampleFromRecord)
    .filter((s): s is TelemetrySample => s !== null)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (samples.length === 0) {
    return null;
  }

  return {
    batchId: envelope.batchId,
    deviceId: identity.deviceId,
    userId: identity.userId,
    sessionId: identity.sessionId,
    startedAt: iso(envelope.startedAt),
    endedAt: iso(envelope.endedAt),
    sequence: identity.sequence,
    samples,
  };
}

export function enrichSos(
  envelope: WearSosEnvelope,
  identity: FogIdentity,
): SosTriggerPayload {
  return {
    eventId: envelope.eventId,
    userId: identity.userId,
    deviceId: identity.deviceId,
    triggeredAt: iso(envelope.triggeredAt),
    source: envelope.source === 'MOBILE' ? 'MOBILE' : 'WATCH',
    reason: envelope.reason || undefined,
  };
}

export function enrichSosCancel(
  envelope: WearSosCancelEnvelope,
  identity: FogIdentity,
): SosCancelPayload {
  return {
    eventId: envelope.eventId,
    userId: identity.userId,
    deviceId: identity.deviceId,
    cancelledAt: iso(envelope.cancelledAt ?? envelope.triggeredAt),
    reason: envelope.reason || undefined,
  };
}

export type FogEnvelope =
  | WearTelemetryEnvelope
  | WearSosEnvelope
  | WearSosCancelEnvelope;

export function parseEnvelope(raw: string): FogEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as FogEnvelope;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.targetEndpoint === '/fog/v1/telemetry' && 'records' in parsed)
      return parsed;
    if (parsed.targetEndpoint === '/fog/v1/sos' && 'eventId' in parsed)
      return parsed;
    if (
      parsed.targetEndpoint === '/fog/v1/sos/cancel' &&
      'eventId' in parsed &&
      'cancelled' in parsed
    )
      return parsed;
    return null;
  } catch {
    return null;
  }
}

export const FogEndpoints = {
  API_BASE,
  FOG_PHONE_PROTOCOL: 'fog_phone_v1',
  TELEMETRY_BATCH: '/api/v1/telemetry/batch',
  SOS_TRIGGER: '/api/v1/sos/trigger',
  SOS_CANCEL: '/api/v1/sos/cancel',
  ACK_TELEMETRY_PREFIX: '/fog/v1/ack/telemetry/',
  ACK_SOS_PREFIX: '/fog/v1/ack/sos/',
  ACK_SOS_CANCEL_PREFIX: '/fog/v1/ack/sos-cancel/',
};
