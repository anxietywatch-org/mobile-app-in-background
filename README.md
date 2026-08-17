# mobile-app-in-background

Nodo fog móvil de AnxietyWatch: puente entre el reloj (Wear OS) y el backend, con entrega en segundo plano garantizada por WorkManager aunque la app esté cerrada.

## Qué hace

- Recoge los sobres del reloj por el Wear Data Layer (`WearFogListenerService` + `WearFogModule`) y los persiste en una cola Room (`FogOutboxDao`).
- Los enriquece (`src/fog/enricher.ts`) con identidad (userId/deviceId/sessionId/sequence) y acelerómetro, y los entrega al API: `POST /api/v1/telemetry/batch`, `POST /api/v1/sos/trigger`, `POST /api/v1/sos/cancel` contra `https://api.mangoon.xyz`.
- Entrega nativa en segundo plano (`FogNativeSync` + `FogBackgroundWorker` + `FogSyncScheduler`): con la app cerrada, el worker drena la cola con backoff (15 s → 15 min) y re-programa el siguiente ciclo solo si quedan pendientes.
- ACK al reloj solo cuando el API aceptó (202) o detectó duplicado (200).

## Autenticación

- Login con email/contraseña (`/api/auth/login`) o vinculación por código: el web genera un token (`/api/tokens`) y el teléfono lo acepta con `POST /api/tokens/accept-by-code`.
- El JWT se persiste cifrado con `androidx.security:security-crypto` (EncryptedSharedPreferences + Android Keystore) con migración del almacén legacy.

## Entrega en segundo plano (app cerrada)

`FogBackgroundWorker` (CoroutineWorker + WorkManager OneTimeWork con constraint de conectividad) ejecuta `FogNativeSync.drain()`:

- entrada `COMPLETE` → eliminada de la cola;
- `PENDING` (sin red) → reintento con backoff y re-programación del worker;
- `UNAUTHORIZED` (401/403) → se limpia la sesión local y el teléfono pide reautenticación.

## Tests

- Jest: `__tests__/` (auth, enricher, nodo fog, E2E smoke contra producción con `E2E_API_TOKEN`).
- Android: `android/app/src/test/` (FogNativeSyncTest, FogSecureStoreTest, FogOutboxDaoTest, FogLegacyQueueMigrationTest) y `androidTest/` (FogOutboxDaoTest).