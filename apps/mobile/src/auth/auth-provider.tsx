import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import { AppState } from 'react-native';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';
interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  error: string | null;
  restore(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: PropsWithChildren) {
  const client = getSupabase();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const restore = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.auth.getSession();
      if (result.error) throw result.error;
      setSession(result.data.session);
    } catch {
      setError(
        'No pudimos restaurar la sesión de forma segura. Reintentá con conexión.',
      );
    } finally {
      setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    let active = true;
    const { data } = client.auth.onAuthStateChange((_event, value) => {
      if (active) {
        setSession(value);
        setLoading(false);
      }
    });
    void restore();
    const refresh = (state: string) => {
      if (state === 'active') client.auth.startAutoRefresh();
      else client.auth.stopAutoRefresh();
    };
    refresh(AppState.currentState);
    const listener = AppState.addEventListener('change', refresh);
    return () => {
      active = false;
      data.subscription.unsubscribe();
      listener.remove();
      client.auth.stopAutoRefresh();
    };
  }, [client, restore]);
  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      error,
      restore,
      async login(email, password) {
        const result = await client.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (result.error)
          throw new Error(
            'No pudimos iniciar sesión. Revisá email, contraseña y conexión.',
          );
        setSession(result.data.session);
      },
      async logout() {
        const result = await client.auth.signOut({ scope: 'local' });
        if (result.error)
          throw new Error(
            'No pudimos cerrar la sesión. Revisá la conexión y reintentá.',
          );
        setSession(null);
      },
    }),
    [session, loading, error, restore, client],
  );
  return <AuthContext value={value}>{children}</AuthContext>;
}
export function useAuth() {
  const value = use(AuthContext);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}
