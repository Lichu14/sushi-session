import { useCallback, useRef, useState } from 'react';
import { FlatList, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSessions } from '@/sessions/session-provider';
import type { SushiSession } from '@/core/types';
import { errorMessage } from '@/core/api-client';
import {
  Action,
  ErrorMessage,
  Loading,
  Message,
  sessionStatus,
} from '@/components/ui';
export default function History() {
  const store = useSessions(),
    insets = useSafeAreaInsets();
  const [items, setItems] = useState<SushiSession[] | null>(null),
    [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
  const busy = useRef(false),
    generation = useRef(0);
  const load = useCallback(
    async (after?: string) => {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      setError(null);
      const current = generation.current;
      try {
        const page = await store.api.sessions(after);
        if (current !== generation.current) return;
        setItems((previous) =>
          after
            ? [
                ...new Map(
                  [...(previous ?? []), ...page.items].map((row) => [
                    row.id,
                    row,
                  ]),
                ).values(),
              ]
            : page.items,
        );
        setCursor(page.nextCursor);
      } catch (e) {
        if (current === generation.current) setError(errorMessage(e));
      } finally {
        if (current === generation.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [store],
  );
  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        generation.current++;
        busy.current = false;
      };
    }, [load]),
  );
  return (
    <FlatList
      data={items ?? []}
      keyExtractor={(item) => item.id}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        padding: 24,
        paddingBottom: insets.bottom + 24,
        gap: 20,
      }}
      refreshing={loading && items !== null}
      onRefresh={() => {
        void load();
      }}
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          <ErrorMessage message={error} />
          {error ? (
            <Action
              title="Reintentar historial"
              onPress={() => {
                void load();
              }}
            />
          ) : null}
        </View>
      }
      ListEmptyComponent={
        loading ? (
          <Loading />
        ) : error ? null : (
          <View style={{ gap: 16 }}>
            <Message>
              Todavía no tenés sesiones. Escaneá el QR de una sucursal para
              comenzar.
            </Message>
            <Action
              title="Escanear QR"
              onPress={() => router.push('/scanner')}
            />
          </View>
        )
      }
      renderItem={({ item }) => (
        <View
          style={{
            gap: 8,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderColor: '#dadfe3',
          }}
        >
          <Message>{new Date(item.startedAt).toLocaleString()}</Message>
          <Message>
            {item.pieceCount} piezas · {sessionStatus[item.status]}
          </Message>
          {store.counters.get(item.id)?.dirty ? (
            <Message>Hay un borrador local pendiente de guardar.</Message>
          ) : null}
          <Action
            title={
              item.status === 'ACTIVE' ? 'Continuar sesión' : 'Ver resultado'
            }
            secondary
            onPress={() =>
              router.push({
                pathname: '/session/[id]',
                params: { id: item.id },
              })
            }
          />
        </View>
      )}
      ListFooterComponent={
        <View style={{ gap: 16 }}>
          {cursor ? (
            <Action
              title={loading ? 'Cargando…' : 'Cargar más'}
              disabled={loading}
              onPress={() => {
                void load(cursor);
              }}
            />
          ) : null}
          <Action
            title="Volver a Inicio"
            secondary
            onPress={() => router.replace('/')}
          />
        </View>
      }
    />
  );
}
