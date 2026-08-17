import { NativeModules } from 'react-native';

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  RN.NativeModules.WearFog = {
    getIdentity: jest.fn().mockResolvedValue(
      JSON.stringify({
        userId: '',
        deviceId: 'dev-1',
        sessionId: 'ses-1',
        sequence: 0,
      }),
    ),
    setIdentity: jest.fn().mockResolvedValue(true),
    nextSequence: jest.fn().mockResolvedValue(1),
    peek: jest.fn().mockResolvedValue('[]'),
    inboundCount: jest.fn().mockResolvedValue(0),
    announceFogPhone: jest.fn().mockResolvedValue(true),
    markCloudAcked: jest.fn().mockResolvedValue(true),
    markWatchAcked: jest.fn().mockResolvedValue(true),
    markFailed: jest.fn().mockResolvedValue(true),
    complete: jest.fn().mockResolvedValue(true),
    ackTelemetry: jest.fn().mockResolvedValue(true),
    ackSos: jest.fn().mockResolvedValue(true),
    ackSosCancel: jest.fn().mockResolvedValue(true),
    getAuth: jest.fn().mockResolvedValue(''),
    setAuth: jest.fn().mockResolvedValue(true),
    clearAuth: jest.fn().mockResolvedValue(true),
    getToken: jest.fn().mockResolvedValue(''),
    setToken: jest.fn().mockResolvedValue(true),
    scheduleSync: jest.fn().mockResolvedValue(true),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  return RN;
});

jest.mock('../src/fog/api', () => ({
  deliverEntry: jest.fn(),
}));

import { deliverEntry } from '../src/fog/api';
import { fogNode } from '../src/fog/fogNode';
import type { FogEntry, FogKind } from '../src/fog/types';

const WearFog = NativeModules.WearFog as {
  [key: string]: jest.Mock;
};

function entry(
  kind: FogKind | 'mystery',
  key = `${kind}:${kind}-id-1`,
): FogEntry {
  return {
    kind: kind as FogKind,
    key,
    entityId: key.substring(key.indexOf(':') + 1),
    envelope: '{}',
    receivedAt: 1,
  };
}

function mockDeliver(
  status: 'accepted' | 'duplicate' | 'unauthorized' | 'retry' | 'failed',
) {
  (deliverEntry as jest.Mock).mockResolvedValue({ status });
}

/** setAuthenticated re-ejecuta flush() con los mocks ya configurados. */
function flushOnce() {
  return fogNode.setAuthenticated({
    token: 't',
    expiresAt: '2030-01-01T00:00:00Z',
    user: { id: 'user-1', email: 'user@test.dev' },
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  WearFog.getIdentity.mockResolvedValue(
    JSON.stringify({
      userId: '',
      deviceId: 'dev-1',
      sessionId: 'ses-1',
      sequence: 0,
    }),
  );
  WearFog.nextSequence.mockResolvedValue(1);
  WearFog.peek.mockResolvedValue('[]');
  WearFog.ackTelemetry.mockResolvedValue(true);
  WearFog.ackSos.mockResolvedValue(true);
  WearFog.ackSosCancel.mockResolvedValue(true);
  WearFog.setAuth.mockResolvedValue(true);
  WearFog.clearAuth.mockResolvedValue(true);
  WearFog.getToken.mockResolvedValue('');
  WearFog.setToken.mockResolvedValue(true);
  WearFog.scheduleSync.mockResolvedValue(true);
  await flushOnce();
});

describe('fogNode flush', () => {
  it('ACK OK: marca cloud -> confirma al reloj por entityId pelado -> marca watch -> completa', async () => {
    WearFog.peek.mockResolvedValue(JSON.stringify([entry('telemetry')]));
    mockDeliver('accepted');

    await flushOnce();

    const order: string[] = [];
    for (const fn of [
      'markCloudAcked',
      'ackTelemetry',
      'markWatchAcked',
      'complete',
    ]) {
      for (const call of WearFog[fn].mock.calls) {
        order.push(`${fn}:${call[0]}`);
      }
    }
    expect(order).toEqual([
      'markCloudAcked:telemetry:telemetry-id-1',
      'ackTelemetry:telemetry-id-1',
      'markWatchAcked:telemetry:telemetry-id-1',
      'complete:telemetry:telemetry-id-1',
    ]);
  });

  it('ACK falla: no completa ni marca watch, marca FAILED para reintento', async () => {
    WearFog.peek.mockResolvedValue(JSON.stringify([entry('telemetry')]));
    WearFog.ackTelemetry.mockResolvedValue(false);
    mockDeliver('accepted');

    await flushOnce();

    expect(WearFog.markCloudAcked).toHaveBeenCalledTimes(1);
    expect(WearFog.ackTelemetry).toHaveBeenCalledTimes(1);
    expect(WearFog.markWatchAcked).not.toHaveBeenCalled();
    expect(WearFog.complete).not.toHaveBeenCalled();
    expect(WearFog.markFailed).toHaveBeenCalledWith('telemetry:telemetry-id-1');
  });

  it('kind desconocido: se descarta sin pasar por el API', async () => {
    WearFog.peek.mockResolvedValue(
      JSON.stringify([entry('mystery', 'mystery:x')]),
    );

    await flushOnce();

    expect(deliverEntry).not.toHaveBeenCalled();
    expect(WearFog.complete).toHaveBeenCalledTimes(1);
    expect(WearFog.complete).toHaveBeenCalledWith('mystery:x');
  });

  it('status failed (veneno): marca FAILED para backoff, no borra', async () => {
    WearFog.peek.mockResolvedValue(JSON.stringify([entry('telemetry')]));
    mockDeliver('failed');

    await flushOnce();

    expect(WearFog.markFailed).toHaveBeenCalledWith('telemetry:telemetry-id-1');
    expect(WearFog.complete).not.toHaveBeenCalled();
    expect(WearFog.ackTelemetry).not.toHaveBeenCalled();
  });

  it('error de red: marca FAILED y no aborta el flush', async () => {
    WearFog.peek.mockResolvedValue(
      JSON.stringify([
        entry('telemetry', 'telemetry:a'),
        entry('sos', 'sos:b'),
      ]),
    );
    (deliverEntry as jest.Mock)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ status: 'accepted' });

    await flushOnce();

    expect(WearFog.markFailed).toHaveBeenCalledWith('telemetry:a');
    expect(WearFog.markFailed).not.toHaveBeenCalledWith('sos:b');
    expect(WearFog.ackSos).toHaveBeenCalledWith('b');
  });

  it('no autorizado: marca estado y no confirma al reloj', async () => {
    WearFog.peek.mockResolvedValue(JSON.stringify([entry('sos')]));
    mockDeliver('unauthorized');

    await flushOnce();

    expect(fogNode.getState().unauthorized).toBe(true);
    expect(WearFog.ackSos).not.toHaveBeenCalled();
    expect(WearFog.complete).not.toHaveBeenCalled();
  });

  it('persiste el token y agenda el worker cuando quedan pendientes', async () => {
    WearFog.peek.mockResolvedValue(JSON.stringify([entry('telemetry')]));
    WearFog.inboundCount.mockResolvedValue(1);
    mockDeliver('accepted');

    await flushOnce();

    expect(WearFog.setToken).toHaveBeenCalledWith('t');
    expect(WearFog.scheduleSync).toHaveBeenCalledWith(600_000);
  });

  it('un duplicado 200 sigue la misma secuencia de ACK que un 202', async () => {
    WearFog.peek.mockResolvedValue(JSON.stringify([entry('sos-cancel')]));
    mockDeliver('duplicate');

    await flushOnce();

    expect(WearFog.markCloudAcked).toHaveBeenCalledWith('sos-cancel:sos-cancel-id-1');
    expect(WearFog.ackSosCancel).toHaveBeenCalledWith('sos-cancel-id-1');
    expect(WearFog.markWatchAcked).toHaveBeenCalled();
    expect(WearFog.complete).toHaveBeenCalled();
  });

  it('SOS y sos-cancel con el mismo eventId no colisionan', async () => {
    WearFog.peek.mockResolvedValue(
      JSON.stringify([
        entry('sos', 'sos:event-1'),
        entry('sos-cancel', 'sos-cancel:event-1'),
      ]),
    );
    mockDeliver('accepted');

    await flushOnce();

    expect(WearFog.markCloudAcked).toHaveBeenCalledWith('sos:event-1');
    expect(WearFog.markCloudAcked).toHaveBeenCalledWith('sos-cancel:event-1');
    expect(WearFog.ackSos).toHaveBeenCalledWith('event-1');
    expect(WearFog.ackSosCancel).toHaveBeenCalledWith('event-1');
    expect(WearFog.complete).toHaveBeenCalledWith('sos:event-1');
    expect(WearFog.complete).toHaveBeenCalledWith('sos-cancel:event-1');
  });

  it('reinicio sin token: no envía al API y marca unauthorized si hay pendientes', async () => {
    WearFog.getAuth.mockResolvedValue('');
    WearFog.getToken.mockResolvedValue('');
    WearFog.inboundCount.mockResolvedValue(2);
    WearFog.peek.mockResolvedValue(JSON.stringify([entry('telemetry')]));

    await fogNode.runOnce();

    expect(deliverEntry).not.toHaveBeenCalled();
    expect(WearFog.ackTelemetry).not.toHaveBeenCalled();
    expect(fogNode.getState().unauthorized).toBe(true);
  });

  it('reinicio con token persistido: recupera token y drena la cola', async () => {
    WearFog.getAuth.mockResolvedValue(
      JSON.stringify({
        token: 'persisted',
        expiresAt: '2030-01-01T00:00:00Z',
        user: { id: 'user-1', email: 'user@test.dev' },
      }),
    );
    WearFog.getToken.mockResolvedValue('persisted');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'persisted',
        expiresAt: '2030-01-01T00:00:00Z',
        user: { id: 'user-1', email: 'user@test.dev' },
      }),
    }) as jest.Mock;
    WearFog.peek.mockResolvedValue(JSON.stringify([entry('telemetry')]));
    mockDeliver('accepted');

    await fogNode.runOnce();

    expect(WearFog.ackTelemetry).toHaveBeenCalledWith('telemetry-id-1');
    expect(fogNode.getState().token).toBe('persisted');
  });
});
