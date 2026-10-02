import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Counter } from '@/core/counter';
import { errorMessage } from '@/core/api-client';
import { useSessions } from '@/sessions/session-provider';
import {
  Action,
  ErrorMessage,
  Loading,
  Message,
  Screen,
  sessionStatus,
} from '@/components/ui';
function SessionCounter({ counter }: { counter: Counter }) {
  const state = useSyncExternalStore(
    counter.subscribe,
    counter.getSnapshot,
    counter.getSnapshot,
  );
  const active = state.session.status === 'ACTIVE';
  const blocked =
    state.finishing || state.needsReload || state.conflict || !active;
  if (state.session.status === 'COMPLETED') {
    return (
      <Screen>
        <View
          style={{
            backgroundColor: '#e7f5ed',
            borderRadius: 16,
            padding: 24,
            gap: 16,
          }}
        >
          <Text
            accessibilityRole="header"
            accessibilityLiveRegion="polite"
            style={{
              fontSize: 30,
              fontWeight: '700',
              color: '#185c37',
              textAlign: 'center',
            }}
          >
            Sesión terminada
          </Text>
          <Text
            selectable
            style={{
              fontSize: 64,
              fontWeight: '700',
              textAlign: 'center',
              color: '#185c37',
            }}
          >
            {state.session.pieceCount}
          </Text>
          <Message>Piezas contadas · Resultado final</Message>
        </View>
        <Message>
          Tu conteo quedó guardado. Esta sesión es de sólo lectura.
        </Message>
        <Action
          title="Ver historial"
          onPress={() => router.replace('/history')}
        />
        <Action
          title="Volver a Inicio"
          secondary
          onPress={() => router.replace('/')}
        />
      </Screen>
    );
  }
  return (
    <Screen>
      <Message>
        {sessionStatus[state.session.status]} ·{' '}
        {new Date(state.session.startedAt).toLocaleString()}
      </Message>
      <Text
        selectable
        accessibilityLabel={`${state.count} piezas`}
        style={{
          fontSize: 80,
          fontWeight: '700',
          textAlign: 'center',
          fontVariant: ['tabular-nums'],
        }}
      >
        {state.count}
      </Text>
      <Message>{active ? 'Piezas contadas' : 'Resultado final'}</Message>
      {active ? (
        <>
          <Action
            title="Sumar una pieza"
            disabled={blocked || state.count >= 1000}
            onPress={() => counter.tap(1)}
          />
          <Action
            title="Deshacer una pieza"
            secondary
            disabled={blocked || state.count === 0}
            onPress={() => counter.tap(-1)}
          />
          <Message>
            {state.syncing
              ? 'Sincronizando…'
              : counter.dirty
                ? 'Hay cambios locales sin guardar.'
                : 'Conteo guardado.'}{' '}
            Versión {state.session.version}.
          </Message>
        </>
      ) : null}
      <ErrorMessage message={state.error} />
      {state.needsReload ? (
        <Action
          title="Releer estado y reintentar"
          disabled={state.syncing || state.finishing}
          onPress={() => {
            void counter.reload().catch(() => {});
          }}
        />
      ) : null}
      {state.conflict ? (
        <>
          <Message>
            Servidor: {state.session.pieceCount} piezas. Borrador local:{' '}
            {state.count}. Elegí cuál conservar; finalizar requiere resolverlo
            primero.
          </Message>
          <Action
            title="Usar conteo del servidor"
            onPress={() => counter.resolveConflict(false)}
          />
          <Action
            title="Guardar mi conteo local"
            secondary
            onPress={() => counter.resolveConflict(true)}
          />
        </>
      ) : null}
      {active ? (
        <Action
          title={
            state.finishing ? 'Guardando y finalizando…' : 'Finalizar sesión'
          }
          disabled={blocked}
          onPress={() => {
            void counter.finish().catch(() => {});
          }}
        />
      ) : null}
      <Action
        title="Volver al historial"
        secondary
        disabled={state.finishing}
        onPress={() => router.replace('/history')}
      />
      {active ? (
        <Message>
          Podés volver desde el historial. Esperá a ver “Conteo guardado”
          antes de cerrar la app.
        </Message>
      ) : null}
    </Screen>
  );
}
export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>(),
    store = useSessions();
  const [counter, setCounter] = useState<Counter | null>(null),
    [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(() => {
    const current = ++generation.current;
    setError(null);
    void (async () => {
      if (typeof id !== 'string') throw new Error('Invalid session id');
      const existing = store.counters.get(id);
      if (current === generation.current) setCounter(existing ?? null);
      if (existing) {
        if (
          !existing.getSnapshot().syncing &&
          !existing.getSnapshot().finishing
        ) {
          const hadDraft = existing.dirty;
          await existing.reload();
          if (!hadDraft) existing.resolveConflict(false);
        }
      } else {
        const session = await store.api.findSession(id);
        if (current === generation.current) setCounter(store.accept(session));
      }
    })().catch((e) => {
      if (current === generation.current) setError(errorMessage(e));
    });
    return () => {
      generation.current++;
    };
  }, [id, store]);
  useFocusEffect(load);
  if (counter) return <SessionCounter counter={counter} />;
  return (
    <Screen>
      {error ? (
        <>
          <ErrorMessage message={error} />
          <Action
            title="Reintentar"
            onPress={() => {
              load();
            }}
          />
        </>
      ) : (
        <Loading />
      )}
    </Screen>
  );
}
