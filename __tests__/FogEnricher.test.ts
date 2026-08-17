import {
  enrichSos,
  enrichSosCancel,
  enrichTelemetry,
  parseEnvelope,
} from '../src/fog/enricher';
import type { FogIdentity } from '../src/fog/types';

const identity: FogIdentity = {
  userId: 'user-1',
  deviceId: 'device-1',
  sessionId: 'session-1',
  sequence: 7,
};

describe('parseEnvelope', () => {
  test('accepts a telemetry envelope', () => {
    const parsed = parseEnvelope(
      JSON.stringify({
        schemaVersion: 'wear-telemetry-records-v2',
        targetEndpoint: '/fog/v1/telemetry',
        transport: 'WEAR_DATA_LAYER',
        batchId: 'batch-1',
        startedAt: '2026-08-10T21:00:00Z',
        endedAt: '2026-08-10T21:05:00Z',
        mobileEnrichmentRequired: [],
        records: [],
      }),
    );
    expect(parsed?.targetEndpoint).toBe('/fog/v1/telemetry');
  });

  test('accepts an sos envelope', () => {
    const parsed = parseEnvelope(
      JSON.stringify({
        schemaVersion: 'wear-sos-trigger-v1',
        targetEndpoint: '/fog/v1/sos',
        transport: 'WEAR_DATA_LAYER',
        eventId: 'event-1',
        triggeredAt: '2026-08-10T21:06:00Z',
        source: 'WATCH',
      }),
    );
    expect(parsed?.targetEndpoint).toBe('/fog/v1/sos');
  });

  test('accepts an sos cancel envelope', () => {
    const parsed = parseEnvelope(
      JSON.stringify({
        schemaVersion: 'wear-sos-trigger-v1',
        targetEndpoint: '/fog/v1/sos/cancel',
        transport: 'WEAR_DATA_LAYER',
        eventId: 'event-9',
        triggeredAt: '2026-08-10T21:07:00Z',
        source: 'WATCH',
        cancelled: true,
      }),
    );
    expect(parsed?.targetEndpoint).toBe('/fog/v1/sos/cancel');
  });

  test('rejects unknown envelopes', () => {
    expect(parseEnvelope('{"foo":"bar"}')).toBeNull();
    expect(parseEnvelope('not json')).toBeNull();
  });
});

describe('enrichTelemetry', () => {
  test('maps watch records (lowercase types) to the public DTO', () => {
    const payload = enrichTelemetry(
      {
        schemaVersion: 'wear-telemetry-records-v2',
        targetEndpoint: '/fog/v1/telemetry',
        transport: 'WEAR_DATA_LAYER',
        batchId: 'batch-1',
        startedAt: '2026-08-10T21:00:00Z',
        endedAt: '2026-08-10T21:05:00Z',
        mobileEnrichmentRequired: [],
        records: [
          {
            id: 'r1',
            capturedAt: '2026-08-10T21:00:30Z',
            type: 'heart_rate',
            payload: {
              bpm: 82.5,
              ibiMillis: [755, 760, 748],
              signalQuality: 0.9,
            },
          },
          {
            id: 'r2',
            capturedAt: '2026-08-10T21:01:00Z',
            type: 'motion',
            payload: { magnitudeG: 1.1, variance: 0.05 },
          },
          {
            id: 'r3',
            capturedAt: '2026-08-10T21:02:00Z',
            type: 'skin_temperature',
            payload: { celsius: 31.4 },
          },
        ],
      },
      identity,
    );

    expect(payload).not.toBeNull();
    expect(payload!.batchId).toBe('batch-1');
    expect(payload!.userId).toBe('user-1');
    expect(payload!.deviceId).toBe('device-1');
    expect(payload!.sessionId).toBe('session-1');
    expect(payload!.sequence).toBe(7);
    expect(payload!.samples).toHaveLength(3);
    expect(payload!.samples[0].heartRateBpm).toBe(82.5);
    expect(payload!.samples[0].ibiMs).toEqual([755, 760, 748]);
    expect(payload!.samples[0].quality.heartRate).toBe('good');
    expect(payload!.samples[1].heartRateBpm).toBeNull();
    expect(payload!.samples[2].skinTemperatureCelsius).toBe(31.4);
  });

  test('returns null when no samples can be mapped', () => {
    const payload = enrichTelemetry(
      {
        schemaVersion: 'wear-telemetry-records-v2',
        targetEndpoint: '/fog/v1/telemetry',
        transport: 'WEAR_DATA_LAYER',
        batchId: 'batch-2',
        startedAt: '2026-08-10T21:00:00Z',
        endedAt: '2026-08-10T21:05:00Z',
        mobileEnrichmentRequired: [],
        records: [
          {
            id: 'r1',
            capturedAt: '2026-08-10T21:00:30Z',
            type: 'UNKNOWN',
            payload: null,
          },
          {
            id: 'r2',
            capturedAt: '2026-08-10T21:01:00Z',
            type: 'steps',
            payload: { count: 42 },
          },
          {
            id: 'r3',
            capturedAt: '2026-08-10T21:02:00Z',
            type: 'availability',
            payload: { state: 'off_body' },
          },
        ],
      },
      identity,
    );
    expect(payload).toBeNull();
  });
});

describe('enrichSos', () => {
  test('maps sos envelope to the public DTO', () => {
    const payload = enrichSos(
      {
        schemaVersion: 'wear-sos-trigger-v1',
        targetEndpoint: '/fog/v1/sos',
        transport: 'WEAR_DATA_LAYER',
        eventId: 'event-1',
        triggeredAt: '2026-08-10T21:06:00Z',
        source: 'WATCH',
        reason: 'Test',
        mobileEnrichmentRequired: ['userId', 'deviceId'],
      },
      identity,
    );
    expect(payload.eventId).toBe('event-1');
    expect(payload.userId).toBe('user-1');
    expect(payload.deviceId).toBe('device-1');
    expect(payload.source).toBe('WATCH');
    expect(payload.reason).toBe('Test');
  });
});

describe('enrichSosCancel', () => {
  test('maps sos cancel envelope to the public DTO', () => {
    const payload = enrichSosCancel(
      {
        schemaVersion: 'wear-sos-trigger-v1',
        targetEndpoint: '/fog/v1/sos/cancel',
        transport: 'WEAR_DATA_LAYER',
        eventId: 'event-9',
        triggeredAt: '2026-08-10T21:07:00Z',
        source: 'WATCH',
        reason: 'User cancelled',
        cancelled: true,
        mobileEnrichmentRequired: ['userId', 'deviceId'],
      },
      identity,
    );
    expect(payload.eventId).toBe('event-9');
    expect(payload.userId).toBe('user-1');
    expect(payload.deviceId).toBe('device-1');
    expect(payload.cancelledAt).toBe('2026-08-10T21:07:00.000Z');
    expect(payload.reason).toBe('User cancelled');
  });
});
