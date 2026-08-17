import { NativeModules } from 'react-native';

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  RN.NativeModules.WearFog = {
    getAuth: jest.fn(),
    setAuth: jest.fn().mockResolvedValue(true),
    clearAuth: jest.fn().mockResolvedValue(true),
  };
  return RN;
});

import { acceptByCode, login, restoreAuth } from '../src/fog/auth';
import type { AuthResult } from '../src/fog/types';

const WearFog = NativeModules.WearFog as {
  getAuth: jest.Mock;
  setAuth: jest.Mock;
  clearAuth: jest.Mock;
};
const fetchMock = jest.fn();
global.fetch = fetchMock;

const auth: AuthResult = {
  token: 'jwt-token',
  expiresAt: '2035-01-01T00:00:00Z',
  user: { id: 'user-1', email: 'user@example.com', planId: 'free' },
};

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('inicia sesión y cifra la respuesta mediante el módulo nativo', async () => {
  fetchMock.mockResolvedValue(response(200, auth));

  await expect(login(' USER@Example.com ', 'secret123')).resolves.toEqual(auth);

  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.mangoon.xyz/api/auth/login',
    expect.objectContaining({
      body: JSON.stringify({
        email: 'user@example.com',
        password: 'secret123',
      }),
    }),
  );
  expect(WearFog.setAuth).toHaveBeenCalledWith(JSON.stringify(auth));
});

it('renueva una sesión persistida antes de usarla', async () => {
  const refreshed = { ...auth, token: 'fresh-token' };
  WearFog.getAuth.mockResolvedValue(JSON.stringify(auth));
  fetchMock.mockResolvedValue(response(200, refreshed));

  await expect(restoreAuth()).resolves.toEqual(refreshed);
  expect(WearFog.setAuth).toHaveBeenCalledWith(JSON.stringify(refreshed));
});

it('elimina una sesión revocada', async () => {
  WearFog.getAuth.mockResolvedValue(JSON.stringify(auth));
  fetchMock.mockResolvedValue(response(401, null));

  await expect(restoreAuth()).resolves.toBeNull();
  expect(WearFog.clearAuth).toHaveBeenCalledTimes(1);
});

it('conserva temporalmente una sesión vigente si no hay red', async () => {
  WearFog.getAuth.mockResolvedValue(JSON.stringify(auth));
  fetchMock.mockRejectedValue(new Error('offline'));

  await expect(restoreAuth()).resolves.toEqual(auth);
  expect(WearFog.clearAuth).not.toHaveBeenCalled();
});

it('acepta un código de vinculación y persiste la sesión nueva', async () => {
  const linked = { ...auth, token: 'linked-token' };
  fetchMock.mockResolvedValue(response(200, linked));

  await expect(
    acceptByCode(' aw-rnxa-gvep-bwmw ', 'dev-1', 'jwt-token'),
  ).resolves.toEqual(linked);

  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.mangoon.xyz/api/tokens/accept-by-code',
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer jwt-token',
      }),
      body: JSON.stringify({
        code: 'AW-RNXA-GVEP-BWMW',
        deviceId: 'dev-1',
      }),
    }),
  );
  expect(WearFog.setAuth).toHaveBeenCalledWith(JSON.stringify(linked));
});

it('falla cuando el código es rechazado por el API', async () => {
  fetchMock.mockResolvedValue(
    response(400, { detail: 'Código inválido o expirado.' }),
  );

  await expect(
    acceptByCode('AW-INVALID-CODE', 'dev-1', 'jwt-token'),
  ).rejects.toThrow('Código inválido o expirado.');
  expect(WearFog.setAuth).not.toHaveBeenCalled();
});
