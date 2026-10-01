import { Stack } from 'expo-router/stack';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '@/auth/auth-provider';
import { SessionProvider } from '@/sessions/session-provider';
import { configurationError } from '@/lib/config';
import { Action, ErrorMessage, Loading, Screen } from '@/components/ui';

function Routes() {
  const auth = useAuth();
  if (auth.loading) return <Loading label="Restaurando sesión…" />;
  if (auth.error)
    return (
      <Screen>
        <ErrorMessage message={auth.error} />
        <Action
          title="Reintentar"
          onPress={() => {
            void auth.restore();
          }}
        />
      </Screen>
    );
  return (
    <SessionProvider key={auth.session?.user.id ?? 'signed-out'}>
      <StatusBar style="dark" />
      <Stack>
        <Stack.Protected guard={!auth.session}>
          <Stack.Screen name="login" options={{ title: 'Iniciar sesión' }} />
        </Stack.Protected>
        <Stack.Protected guard={!!auth.session}>
          <Stack.Screen name="index" options={{ title: 'Sushi Session' }} />
          <Stack.Screen name="scanner" options={{ title: 'Escanear QR' }} />
          <Stack.Screen
            name="session/[id]"
            options={{ title: 'Tu Sushi Session' }}
          />
          <Stack.Screen
            name="history"
            options={{ title: 'Historial de sesiones' }}
          />
        </Stack.Protected>
      </Stack>
    </SessionProvider>
  );
}

export default function RootLayout() {
  const error = configurationError();
  if (error)
    return (
      <Screen>
        <ErrorMessage message={error} />
      </Screen>
    );
  return (
    <AuthProvider>
      <Routes />
    </AuthProvider>
  );
}
