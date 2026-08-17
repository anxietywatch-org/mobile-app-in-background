/**
 * Smoke E2E opt-in: reenvía un sobre simulado del reloj a la API real.
 *
 * Uso (con autorización explícita):
 *   E2E_API_TOKEN=<jwt> E2E_USER_ID=<uuid> npx jest __tests__/FogE2E.smoke.ts
 *
 * Por defecto se omite (describe.skip) para no golpear el backend en CI.
 */
import { HttpFogApiClient } from '../src/fog/api';
import {
  enrichSos,
  enrichSosCancel,
  enrichTelemetry,
} from '../src/fog/enricher';
import type {
  FogIdentity,
  WearSosCancelEnvelope,
  WearSosEnvelope,
  WearTelemetryEnvelope,
} from '../src/fog/types';

const BASE = 'https://api.mangoon.xyz';
const TOKEN = process.env.E2E_API_TOKEN ?? '';
const USER_ID = process.env.E2E_USER_ID ?? '';
const DEVICE_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
const SESSION_ID = 'b2c3d4e5-1111-1111-1111-111111111111';

const identity: FogIdentity = {
  userId: USER_ID,
  deviceId: DEVICE_ID,
  sessionId: SESSION_ID,
  sequence: 900,
};

const telemetryEnvelope: WearTelemetryEnvelope = {
  schemaVersion: 'wear-telemetry-records-v2',
  targetEndpoint: '/fog/v1/telemetry',
  transport: 'WEAR_DATA_LAYER',
  batchId: 'f0fbcf4e-3a17-4d6a-9cd2-8e1b2c3d4e5f',
  startedAt: '2026-08-10T21:00:00Z',
  endedAt: '2026-08-10T21:01:00Z',
  mobileEnrichmentRequired: [
    'userId',
    'deviceId',
    'sessionId',
    'sequence',
    'samples',
  ],
  records: [
    {
      id: 'e2e-1',
      capturedAt: '2026-08-10T21:00:30Z',
      type: 'heart_rate',
      payload: { bpm: 81.0, ibiMillis: [755, 760, 748], signalQuality: 0.93 },
    },
    {
      id: 'e2e-2',
      capturedAt: '2026-08-10T21:00:45Z',
      type: 'ACCELEROMETER',
      payload: { magnitudeG: 1.05, variance: 0.02 },
    },
  ],
};

const sosEnvelope: WearSosEnvelope = {
  schemaVersion: 'wear-sos-trigger-v1',
  targetEndpoint: '/fog/v1/sos',
  transport: 'WEAR_DATA_LAYER',
  eventId: 'c3d4e5f6-2222-2222-2222-222222222222',
  triggeredAt: '2026-08-10T21:06:00Z',
  source: 'WATCH',
  reason: 'Smoke E2E fog node',
  state: 'SOS_ACTIVE',
  score: 0.9,
  rulesVersion: 'rules-v2',
  mobileEnrichmentRequired: ['userId', 'deviceId'],
};

const sosCancelEnvelope: WearSosCancelEnvelope = {
  schemaVersion: 'wear-sos-trigger-v1',
  targetEndpoint: '/fog/v1/sos/cancel',
  transport: 'WEAR_DATA_LAYER',
  eventId: 'd4e5f6a7-3333-3333-3333-333333333333',
  triggeredAt: '2026-08-10T21:08:00Z',
  source: 'WATCH',
  reason: 'Usuario canceló la alerta',
  state: 'RESOLVED',
  cancelled: true,
  mobileEnrichmentRequired: ['userId', 'deviceId'],
};

const run = TOKEN ? describe : describe.skip;

run('Fog E2E smoke (API real)', () => {
  const client = new HttpFogApiClient(BASE, identity);

  test('telemetría: 202 accepted o 200 duplicate (idempotente)', async () => {
    expect(TOKEN).toBeTruthy();
    const payload = enrichTelemetry(telemetryEnvelope, identity);
    expect(payload).not.toBeNull();
    const result = await client.postTelemetry(payload!, TOKEN);
    expect(['accepted', 'duplicate']).toContain(result.status);
  });

  test('SOS: 202 accepted o 200 duplicate (idempotente)', async () => {
    const payload = enrichSos(sosEnvelope, identity);
    const result = await client.postSos(payload, TOKEN);
    expect(['accepted', 'duplicate']).toContain(result.status);
  });

  test('SOS cancel: 202 accepted o 200 duplicate (idempotente)', async () => {
    const payload = enrichSosCancel(sosCancelEnvelope, identity);
    const result = await client.postSosCancel(payload, TOKEN);
    expect(['accepted', 'duplicate']).toContain(result.status);
  });

  test('userId ajeno al token → 403 unauthorized', async () => {
    const other = {
      ...identity,
      userId: '11111111-1111-1111-1111-111111111111',
    };
    const clientOther = new HttpFogApiClient(BASE, other);
    const payload = enrichSos(sosEnvelope, other);
    const result = await clientOther.postSos(payload, TOKEN);
    expect(result.status).toBe('unauthorized');
  });
});
