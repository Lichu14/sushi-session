import { useCallback, useRef, useState } from 'react';
import { AppState, Linking, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useSessions } from '@/sessions/session-provider';
import {
  Action,
  ErrorMessage,
  Loading,
  Message,
  Screen,
} from '@/components/ui';
import { ApiError, errorMessage } from '@/core/api-client';
import { parseCheckInQr } from '@/core/qr';
import {
  CHECK_IN_COOLDOWN_MESSAGE,
  recentVisitAction,
} from '@/core/check-in-recovery';
import type { CheckInInput, SushiSession } from '@/core/types';
export default function Scanner() {
  const store = useSessions();
  const [permission, requestPermission, getPermission] =
    useCameraPermissions();
  const [focused, setFocused] = useState(false),
    [foreground, setForeground] = useState(
      AppState.currentState === 'active',
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [cooldown, setCooldown] = useState<string | null>(null);
  // undefined means not yet confirmed; null means history confirmed no session.
  const [recentSession, setRecentSession] = useState<
    SushiSession | null | undefined
  >();
  const locked = useRef(false),
    mounted = useRef(false),
    input = useRef<CheckInInput | null>(null),
    visitId = useRef<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      mounted.current = true;
      setFocused(true);
      const subscription = AppState.addEventListener('change', (state) => {
        setForeground(state === 'active');
        if (state === 'active') void getPermission().catch(() => {});
      });
      return () => {
        mounted.current = false;
        setFocused(false);
        subscription.remove();
        input.current = null;
      };
    }, [getPermission]),
  );
  async function readRecentSession(id: string) {
    try {
      const session = await store.api.findVisitSession(id);
      if (mounted.current) setRecentSession(session);
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    }
  }
  async function retrySessionLookup() {
    if (locked.current || !cooldown) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await readRecentSession(cooldown);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function submit() {
    if (locked.current || (!input.current && !visitId.current)) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!visitId.current && input.current) {
        const visit = await store.api.checkIn(input.current);
        if (!mounted.current) return;
        visitId.current = visit.id;
        input.current = null; // The raw QR is no longer needed, including for a retry of session start.
      }
      if (!visitId.current || !mounted.current) return;
      const session = await store.api.startSession(visitId.current);
      if (!mounted.current) return;
      store.accept(session);
      router.replace({
        pathname: '/session/[id]',
        params: { id: session.id },
      });
    } catch (e) {
      if (!mounted.current) return;
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        e.cooldownVisitId &&
        !visitId.current
      ) {
        // The API returns only this user's recent visit at the scanned location.
        // Discard the QR and read that visit's session without another check-in.
        input.current = null;
        visitId.current = e.cooldownVisitId;
        setCooldown(e.cooldownVisitId);
        setRecentSession(undefined);
        await readRecentSession(e.cooldownVisitId);
      } else {
        setError(errorMessage(e));
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function scan(raw: string) {
    if (locked.current || input.current || visitId.current || paused) return;
    setPaused(true);
    try {
      input.current = {
        ...parseCheckInQr(raw),
        idempotencyKey: randomUUID(),
      };
      void submit();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'QR no válido.');
    }
  }
  async function permissionAction() {
    try {
      if (permission?.canAskAgain) await requestPermission();
      else await Linking.openSettings();
    } catch {
      setError(
        'No pudimos abrir la cámara o los ajustes. Revisá los permisos del dispositivo.',
      );
    }
  }
  if (!permission) return <Loading label="Consultando permiso de cámara…" />;
  if (!permission.granted)
    return (
      <Screen>
        <Message>
          Necesitamos la cámara para leer el QR de la sucursal. No guardamos
          fotos ni videos.
        </Message>
        <Action
          title={
            permission.canAskAgain
              ? 'Permitir cámara'
              : 'Abrir ajustes de cámara'
          }
          onPress={() => {
            void permissionAction();
          }}
        />
        <ErrorMessage message={error} />
      </Screen>
    );
  return (
    <Screen>
      <Message>
        Apuntá al QR de la sucursal. El código no se mostrará ni se guardará
        en el teléfono.
      </Message>
      <View
        style={{
          height: 300,
          borderRadius: 16,
          overflow: 'hidden',
          backgroundColor: '#15202b',
        }}
      >
        {focused && foreground && !paused ? (
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={(event) => scan(event.data)}
            onMountError={() => {
              setPaused(true);
              setError(
                'No se pudo iniciar la cámara. Cerrá otras apps que la usen y reintentá.',
              );
            }}
          />
        ) : busy ? (
          <Loading
            label={
              cooldown
                ? 'Consultando la sesión de esta visita…'
                : 'Registrando visita e iniciando sesión…'
            }
          />
        ) : (
          <View
            style={{
              flex: 1,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Text style={{ color: '#ffffff', fontSize: 18 }}>
              Lectura pausada
            </Text>
          </View>
        )}
      </View>
      {cooldown ? <Message>{CHECK_IN_COOLDOWN_MESSAGE}</Message> : null}
      <ErrorMessage message={error} />
      {cooldown && recentSession !== undefined ? (
        <>
          {recentSession === null ? (
            <Message>
              Esta visita todavía no tiene una sesión de conteo.
            </Message>
          ) : null}
          <Action
            title={recentVisitAction(recentSession)}
            disabled={busy}
            onPress={() => {
              if (recentSession) {
                store.accept(recentSession);
                router.replace({
                  pathname: '/session/[id]',
                  params: { id: recentSession.id },
                });
              } else {
                void submit();
              }
            }}
          />
        </>
      ) : null}
      {cooldown && recentSession === undefined && error ? (
        <Action
          title="Reintentar consulta de la sesión"
          disabled={busy}
          onPress={() => {
            void retrySessionLookup();
          }}
        />
      ) : null}
      {!cooldown && error && (input.current || visitId.current) ? (
        <Action
          title={
            visitId.current
              ? 'Reintentar inicio de sesión'
              : 'Reintentar el mismo check-in'
          }
          disabled={busy}
          onPress={() => {
            void submit();
          }}
        />
      ) : null}
      {paused && !busy && !visitId.current ? (
        <Action
          title="Escanear otro QR"
          secondary
          onPress={() => {
            input.current = null;
            setError(null);
            setPaused(false);
          }}
        />
      ) : null}
      <Action
        title="Volver a Inicio"
        secondary
        disabled={busy}
        onPress={() => router.replace('/')}
      />
    </Screen>
  );
}
