import { useState } from 'react';
import { Host, TextInput, useNativeState } from '@expo/ui';
import { useAuth } from '@/auth/auth-provider';
import { Action, ErrorMessage, Message, Screen } from '@/components/ui';
export default function Login() {
  const auth = useAuth(),
    email = useNativeState(''),
    password = useNativeState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit() {
    if (busy) return;
    if (!email.value.trim() || !password.value) {
      setError('Ingresá tu email y contraseña.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.login(email.value, password.value);
      password.value = '';
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos iniciar sesión.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Screen>
      <Message>
        Ingresá con tu cuenta de Sushi Session. Usá el usuario de prueba
        existente; el registro queda fuera de esta fase.
      </Message>
      <Message>Email</Message>
      <Host matchContents>
        <TextInput
          value={email}
          onChangeText={(text) => {
            email.value = text;
          }}
          autoComplete="email"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="tu@email.com"
          editable={!busy}
          style={{ padding: 12, borderWidth: 1, borderRadius: 8 }}
          testID="login-email"
        />
      </Host>
      <Message>Contraseña</Message>
      <Host matchContents>
        <TextInput
          value={password}
          onChangeText={(text) => {
            password.value = text;
          }}
          secureTextEntry
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Contraseña"
          editable={!busy}
          returnKeyType="go"
          onSubmitEditing={() => {
            void submit();
          }}
          style={{ padding: 12, borderWidth: 1, borderRadius: 8 }}
          testID="login-password"
        />
      </Host>
      <ErrorMessage message={error} />
      <Action
        title={busy ? 'Ingresando…' : 'Ingresar'}
        disabled={busy}
        onPress={() => {
          void submit();
        }}
      />
    </Screen>
  );
}
