import type {
  DeliveryResult,
  FogEntry,
  FogIdentity,
  SosCancelPayload,
  TelemetryBatchPayload,
  SosTriggerPayload,
  WearTelemetryEnvelope,
  WearSosEnvelope,
  WearSosCancelEnvelope,
} from './types';
import {
  type FogEnvelope,
  enrichSos,
  enrichSosCancel,
  enrichTelemetry,
  parseEnvelope,
} from './enricher';

export interface FogApiClient {
  postTelemetry(
    payload: TelemetryBatchPayload,
    token: string,
  ): Promise<DeliveryResult>;
  postSos(payload: SosTriggerPayload, token: string): Promise<DeliveryResult>;
  postSosCancel(
    payload: SosCancelPayload,
    token: string,
  ): Promise<DeliveryResult>;
}

function isTelemetry(
  envelope: FogEnvelope,
): envelope is WearTelemetryEnvelope {
  return envelope.targetEndpoint === '/fog/v1/telemetry';
}

function isSosCancel(
  envelope: FogEnvelope,
): envelope is WearSosCancelEnvelope {
  return envelope.targetEndpoint === '/fog/v1/sos/cancel';
}

export class HttpFogApiClient implements FogApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly identity: FogIdentity,
  ) {}

  private static async post(
    url: string,
    payload: unknown,
    token: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async postTelemetry(
    payload: TelemetryBatchPayload,
    token: string,
  ): Promise<DeliveryResult> {
    const response = await HttpFogApiClient.post(
      `${this.baseUrl}/api/v1/telemetry/batch`,
      payload,
      token,
    );
    return this.toResult(payload.batchId, 'telemetry', response);
  }

  async postSos(
    payload: SosTriggerPayload,
    token: string,
  ): Promise<DeliveryResult> {
    const response = await HttpFogApiClient.post(
      `${this.baseUrl}/api/v1/sos/trigger`,
      payload,
      token,
    );
    return this.toResult(payload.eventId, 'sos', response);
  }

  async postSosCancel(
    payload: SosCancelPayload,
    token: string,
  ): Promise<DeliveryResult> {
    const response = await HttpFogApiClient.post(
      `${this.baseUrl}/api/v1/sos/cancel`,
      payload,
      token,
    );
    return this.toResult(payload.eventId, 'sos-cancel', response);
  }

  private async toResult(
    key: string,
    kind: DeliveryResult['kind'],
    response: Response,
  ): Promise<DeliveryResult> {
    if (response.status === 202) {
      return { entryKey: key, kind, status: 'accepted', httpCode: 202 };
    }
    if (response.status === 200) {
      return { entryKey: key, kind, status: 'duplicate', httpCode: 200 };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        entryKey: key,
        kind,
        status: 'unauthorized',
        httpCode: response.status,
      };
    }
    return { entryKey: key, kind, status: 'failed', httpCode: response.status };
  }
}

export function selectApiClient(
  baseUrl: string,
  identity: FogIdentity,
): FogApiClient {
  return new HttpFogApiClient(baseUrl, identity);
}

export async function deliverEntry(
  entry: FogEntry,
  identity: FogIdentity,
  token: string,
  baseUrl: string,
): Promise<DeliveryResult> {
  const envelope = parseEnvelope(entry.envelope);
  if (!envelope) {
    return { entryKey: entry.key, kind: entry.kind, status: 'failed' };
  }
  const client = selectApiClient(baseUrl, identity);
  if (isSosCancel(envelope)) {
    const payload = enrichSosCancel(envelope, identity);
    return client.postSosCancel(payload, token);
  }
  if (isTelemetry(envelope)) {
    const payload = enrichTelemetry(envelope, identity);
    if (!payload) {
      return { entryKey: entry.key, kind: 'telemetry', status: 'failed' };
    }
    return client.postTelemetry(payload, token);
  }
  const payload = enrichSos(envelope as WearSosEnvelope, identity);
  return client.postSos(payload, token);
}
