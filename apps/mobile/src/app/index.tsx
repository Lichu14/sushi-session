import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { useAuth } from '@/auth/auth-provider';
import { useSessions } from '@/sessions/session-provider';
import {
  Action,
  ErrorMessage,
  Loading,
  Message,
  Screen,
} from '@/components/ui';
import { errorMessage } from '@/core/api-client';
import type { Profile, Visit } from '@/core/types';
export default function Home() {
  const auth = useAuth(),
    store = useSessions();
  const [profile, setProfile] = useState<Profile | null>(null),
    [visit, setVisit] = useState<Visit | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    void Promise.all([store.api.me(), store.api.visits()])
      .then(([user, visits]) => {
        if (current === generation.current) {
          setProfile(user);
          setVisit(visits.items[0] ?? null);
        }
      })
      .catch((e) => {
        if (current === generation.current) setError(errorMessage(e));
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [store]);
  useFocusEffect(load);
  async function resume() {
    if (!visit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await store.api.startSession(visit.id);
      store.accept(session);
      router.push({ pathname: '/session/[id]', params: { id: session.id } });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    if (busy) return;
    const pending = [...store.counters.values()].find(
      (counter) =>
        counter.dirty ||
        counter.getSnapshot().syncing ||
        counter.getSnapshot().finishing ||
        counter.getSnapshot().needsReload,
    );
    if (pending) {
      setError(
        'Hay un conteo pendiente. Abrí la sesión desde el historial y guardá o resolvé la sincronización antes de salir.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.logout();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos cerrar sesión.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Screen>
      {loading && !profile ? (
        <Loading />
      ) : profile ? (
        <Message>
          Hola, {profile.displayName || 'sushi lover'}. Registrá tu visita para
          empezar a contar.
        </Message>
      ) : null}
      <ErrorMessage message={error} />
      {error ? (
        <Action
          title="Reintentar conexión"
          secondary
          onPress={() => {
            load();
          }}
        />
      ) : null}
      <Action
        title="Escanear QR de la sucursal"
        disabled={!profile || busy}
        onPress={() => router.push('/scanner')}
      />
      <Action
        title="Ver historial"
        secondary
        onPress={() => router.push('/history')}
      />
      {visit ? (
        <Action
          title="Abrir sesión de la última visita"
          secondary
          disabled={busy}
          onPress={() => {
            void resume();
          }}
        />
      ) : null}
      <Message>
        El conteo es personal. Registrar una visita no la verifica
        automáticamente ni genera premios en esta fase.
      </Message>
      <Action
        title={busy ? 'Procesando…' : 'Cerrar sesión'}
        secondary
        disabled={busy}
        onPress={() => {
          void logout();
        }}
      />
    </Screen>
  );
}
