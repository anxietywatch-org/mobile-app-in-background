import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { acceptByCode, login, logout } from './src/fog/auth';
import { BASE_URL, fogNode } from './src/fog/fogNode';
import type { FogNodeState } from './src/fog/fogNode';

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const [state, setState] = useState<FogNodeState | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    const unsubscribe = fogNode.subscribe(next => {
      if (mounted) setState(next);
    });
    void fogNode.start().finally(() => {
      if (mounted) setRestoring(false);
    });
    return () => {
      mounted = false;
      unsubscribe();
      fogNode.stop();
    };
  }, []);

  async function handleLogin() {
    if (!email.trim() || !password) {
      setError('Escribe tu correo y contraseña.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const auth = await login(email, password);
      await fogNode.setAuthenticated(auth);
      setPassword('');
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'No fue posible iniciar sesión.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    setSubmitting(true);
    setError('');
    try {
      await logout(state?.token ?? '');
    } catch {
      // El cierre local sigue siendo efectivo aunque el API esté sin conexión.
    } finally {
      await fogNode.clearAuthentication();
      setSubmitting(false);
    }
  }

  async function handleLinkCode() {
    if (!code.trim() || !state?.token) {
      setError('Escribe el código de vinculación.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const auth = await acceptByCode(
        code.trim(),
        state.identity.deviceId,
        state.token,
      );
      await fogNode.setAuthenticated(auth);
      setCode('');
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'El código no fue aceptado.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  const statusLabel = state?.unauthorized
    ? 'Reautenticación requerida'
    : state?.token
      ? 'Conectado'
      : 'Sin credenciales';

  if (restoring) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color="#9FE0C8" size="large" />
        <Text style={styles.restoring}>Restaurando sesión segura…</Text>
      </View>
    );
  }

  return (
    <>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <View style={styles.screen}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>NODO FOG</Text>
        </View>
        <Text style={styles.title}>AnxietyWatch</Text>
        <Text style={styles.subtitle}>Puente reloj → backend</Text>

        {!state?.token ? (
          <View style={styles.loginCard}>
            <Text style={styles.loginTitle}>Inicia sesión</Text>
            <Text style={styles.loginHelp}>
              Usa la misma cuenta de AnxietyWatch para vincular este teléfono.
            </Text>
            <TextInput
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              onChangeText={setEmail}
              placeholder="correo@ejemplo.com"
              placeholderTextColor="#70847E"
              style={styles.input}
              value={email}
            />
            <TextInput
              autoCapitalize="none"
              autoComplete="current-password"
              onChangeText={setPassword}
              onSubmitEditing={() => void handleLogin()}
              placeholder="Contraseña"
              placeholderTextColor="#70847E"
              secureTextEntry
              style={styles.input}
              value={password}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable
              disabled={submitting}
              onPress={() => void handleLogin()}
              style={({ pressed }) => [
                styles.primaryButton,
                (pressed || submitting) && styles.buttonDisabled,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color="#0D1715" />
              ) : (
                <Text style={styles.primaryButtonText}>Vincular teléfono</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Estado</Text>
              <Text style={styles.cardValue}>{statusLabel}</Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Usuario</Text>
              <Text style={styles.cardValue}>{state.identity.userId}</Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Dispositivo</Text>
              <Text style={styles.cardValue}>{state.identity.deviceId}</Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Sobres pendientes del reloj</Text>
              <Text style={styles.cardValue}>{state.pending}</Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Última entrega</Text>
              <Text style={styles.cardValue}>
                {state.lastDelivery
                  ? `${state.lastDelivery.kind}: ${state.lastDelivery.status}`
                  : 'Sin entregas'}
              </Text>
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Text style={styles.codeLabel}>
              Código de vinculación (web → Tokens)
            </Text>
            <TextInput
              autoCapitalize="characters"
              autoCorrect={false}
              onChangeText={setCode}
              onSubmitEditing={() => void handleLinkCode()}
              placeholder="AW-XXXX-XXXX-XXXX"
              placeholderTextColor="#70847E"
              style={styles.input}
              value={code}
            />
            <Pressable
              disabled={submitting || !code.trim()}
              onPress={() => void handleLinkCode()}
              style={({ pressed }) => [
                styles.primaryButton,
                (pressed || submitting) && styles.buttonDisabled,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color="#0D1715" />
              ) : (
                <Text style={styles.primaryButtonText}>Vincular por código</Text>
              )}
            </Pressable>
            <Pressable
              disabled={submitting}
              onPress={() => void handleLogout()}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Cerrar sesión</Text>
            </Pressable>
          </>
        )}

        <Text style={styles.notice}>
          API: {BASE_URL}
          {'\n'}La cola permanece guardada y reintenta las entregas cuando
          vuelve la conectividad. La sesión se almacena cifrada.
        </Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0D1715',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  centered: { alignItems: 'center', justifyContent: 'center' },
  restoring: { color: '#AEBDB8', fontSize: 16, marginTop: 16 },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: '#17362E',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  badgeText: {
    color: '#9FE0C8',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  title: { color: '#F2F7F5', fontSize: 36, fontWeight: '700', marginTop: 28 },
  subtitle: { color: '#AEBDB8', fontSize: 17, marginBottom: 24, marginTop: 8 },
  loginCard: {
    backgroundColor: '#14221F',
    borderColor: '#24423A',
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
  },
  loginTitle: { color: '#F2F7F5', fontSize: 22, fontWeight: '700' },
  loginHelp: {
    color: '#AEBDB8',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
    marginTop: 6,
  },
  input: {
    backgroundColor: '#0D1715',
    borderColor: '#36584F',
    borderRadius: 12,
    borderWidth: 1,
    color: '#F2F7F5',
    fontSize: 16,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  error: { color: '#FF9D9D', fontSize: 14, marginTop: 12 },
  codeLabel: {
    color: '#89A39B',
    fontSize: 12,
    textTransform: 'uppercase',
    marginTop: 14,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#9FE0C8',
    borderRadius: 12,
    marginTop: 18,
    padding: 14,
  },
  primaryButtonText: { color: '#0D1715', fontSize: 16, fontWeight: '700' },
  buttonDisabled: { opacity: 0.65 },
  secondaryButton: {
    alignItems: 'center',
    borderColor: '#50746A',
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 8,
    padding: 12,
  },
  secondaryButtonText: { color: '#C7D8D2', fontSize: 15, fontWeight: '600' },
  card: {
    backgroundColor: '#14221F',
    borderColor: '#24423A',
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: 10,
    padding: 16,
  },
  cardLabel: { color: '#89A39B', fontSize: 12, textTransform: 'uppercase' },
  cardValue: {
    color: '#E6F0EC',
    fontSize: 15,
    fontWeight: '600',
    marginTop: 5,
  },
  notice: {
    color: '#93A29D',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 'auto',
    paddingTop: 16,
  },
});

export default App;
