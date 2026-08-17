import { NativeModules } from 'react-native';
import type { AuthResult } from './types';
import { FogEndpoints } from './enricher';

const { WearFog } = NativeModules;
const AUTH_BASE = `${FogEndpoints.API_BASE}/api/auth`;

function isAuthResult(value: unknown): value is AuthResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AuthResult>;
  return Boolean(
    candidate.token &&
    candidate.expiresAt &&
    candidate.user?.id &&
    candidate.user?.email,
  );
}

async function readResponse(response: Response): Promise<AuthResult> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && 'detail' in body
        ? String(body.detail)
        : 'No fue posible iniciar sesión.';
    throw new Error(detail);
  }
  if (!isAuthResult(body)) {
    throw new Error('El API devolvió una sesión inválida.');
  }
  return body;
}

export async function persistAuth(auth: AuthResult): Promise<void> {
  await WearFog.setAuth(JSON.stringify(auth));
}

export async function clearPersistedAuth(): Promise<void> {
  await WearFog.clearAuth();
}

export async function login(
  email: string,
  password: string,
): Promise<AuthResult> {
  const response = await fetch(`${AUTH_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
  });
  const auth = await readResponse(response);
  await persistAuth(auth);
  return auth;
}

export async function restoreAuth(): Promise<AuthResult | null> {
  let raw = '';
  try {
    raw = (await WearFog.getAuth()) || '';
  } catch {
    return null;
  }

  let stored: AuthResult;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isAuthResult(parsed)) throw new Error('invalid auth');
    stored = parsed;
  } catch {
    await clearPersistedAuth();
    return null;
  }

  if (Date.parse(stored.expiresAt) <= Date.now()) {
    await clearPersistedAuth();
    return null;
  }

  try {
    const response = await fetch(`${AUTH_BASE}/session`, {
      headers: { Authorization: `Bearer ${stored.token}` },
    });
    if (response.status === 401 || response.status === 403) {
      await clearPersistedAuth();
      return null;
    }
    const refreshed = await readResponse(response);
    await persistAuth(refreshed);
    return refreshed;
  } catch {
    // Sin red conservamos una sesión aún vigente para que la cola pueda
    // reintentarse cuando regrese la conectividad.
    return stored;
  }
}

export async function logout(token: string): Promise<void> {
  try {
    await fetch(`${AUTH_BASE}/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } finally {
    await clearPersistedAuth();
  }
}

/**
 * Acepta un código de vinculación generado en el web (dashboard → Tokens) para
 * este dispositivo. El API devuelve una sesión nueva (mismo shape que login).
 */
export async function acceptByCode(
  code: string,
  deviceId: string,
  token: string,
): Promise<AuthResult> {
  const response = await fetch(
    `${FogEndpoints.API_BASE}/api/tokens/accept-by-code`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code: code.trim().toUpperCase(), deviceId }),
    },
  );
  const auth = await readResponse(response);
  await persistAuth(auth);
  return auth;
}
