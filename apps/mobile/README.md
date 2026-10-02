# App móvil — Fase 4

Expo SDK 57, Expo Router, TypeScript estricto y pnpm. Flujo implementado:
login → Home → scanner QR → check-in → Sushi Session → conteo → finalizar → historial.
La app consume la API existente; no accede directamente a tablas de Supabase.
No hay cambios de schema, migraciones, verificación automática de Visit ni rewards.

## Configuración y arranque

Desde la raíz del monorepo, con Node 24 (verificado) y pnpm 11.25.0:

```powershell
pnpm install --frozen-lockfile
Copy-Item apps/mobile/.env.example apps/mobile/.env # No sobrescribir si ya existe
```

Completar **solo** estas variables públicas en `apps/mobile/.env`, excluido de Git:

```dotenv
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_ME
EXPO_PUBLIC_API_URL=http://192.168.1.50:3001
```

La URL y publishable key deben corresponder al mismo proyecto que usa NestJS.
Usar una cuenta email/password existente y confirmada, con acceso permitido por
la API. No hay registro ni recuperación de contraseña en esta fase.
Nunca copiar el `.env` completo de la API al móvil: DATABASE_URL, service role,
secret keys y credenciales de prueba no pertenecen al bundle Expo.
Todo `EXPO_PUBLIC_*` es visible en el bundle; no es un almacén de secretos.

```powershell
# Terminal 1, desde la raíz; usa apps/api/.env
pnpm dev:api
# Terminal 2, desde la raíz; usa apps/mobile/.env
pnpm dev:mobile
```

Teléfono y equipo deben estar en la misma red. En un teléfono, `localhost` apunta
al teléfono: usar la IP LAN del equipo para la API. Android Emulator usa
habitualmente `http://10.0.2.2:3001`. Un simulador iOS en la misma Mac puede usar
`http://localhost:3001`. Revisar acceso al puerto 3001 desde la red privada sin
publicar la API en Internet. El túnel de Metro no expone automáticamente NestJS.
Reiniciar Expo después de cambiar variables. La app muestra un error de
configuración si faltan valores o se intenta usar una clave no publishable.
HTTP solo se admite en desarrollo y hosts locales/LAN; builds distribuidos
requieren API HTTPS. Usar Expo Go compatible con SDK 57 o un development build
compatible; en un build propio, reconstruir después de cambiar plugins nativos.

`pnpm dev:mobile:web` permite previsualizar UI/login, no reemplaza la prueba nativa:
la sesión web es solo en memoria y la API actual no habilita CORS para ese origen.
No se agregó CORS ni se alteró el backend para habilitar web en esta fase.

## Contrato del QR

El backend ya define `locationId` + token opaco, pero no existía un formato de
transporte del QR. Esta fase fija JSON versionado; no requiere cambiar el modelo:

```json
{
  "v": 1,
  "locationId": "00000000-0000-4000-8000-000000000000",
  "token": "TOKEN_OPACO_DEL_CHECK_IN_CODE"
}
```

Es un ejemplo de formato, **no** un código utilizable. Para una prueba real,
usar una sucursal activa y un CheckInCode activo del proyecto de desarrollo.
La base conserva el hash SHA-256 del token: no es posible obtener el token desde
ese hash. Quien emite el código debe entregar el token original dentro del QR.
No se agrega un generador público ni un endpoint administrativo en esta fase.
No se aceptan URLs, versiones desconocidas, campos extra ni tokens vacíos.

El scanner solicita solo cámara, no audio; explica cómo conceder el permiso y
cómo abrir Ajustes si fue denegado permanentemente. La cámara se desmonta al
perder foco, ir a segundo plano o aceptar un QR. No guarda fotos/videos.
Una lectura bloquea lecturas repetidas, genera `idempotencyKey` con UUID seguro
y envía `{locationId, token, idempotencyKey}` a `POST /check-ins`.
El token vive únicamente en memoria durante el intento: no se muestra, registra
en logs, guarda en storage ni se pone en la navegación. Los reintentos mientras
esa pantalla sigue abierta usan la misma clave y el mismo código. Tras obtener
Visit.id se descarta el token y se inicia la sesión con ese Visit.id.

Si se pierde la respuesta y se abandona/cierra la pantalla, no se conserva el QR
para reintentos posteriores. Volver a Home → “Abrir sesión de la última visita”
permite recuperar una visita ya aceptada. El backend mantiene su deduplicación
de cuatro horas; un conflicto no convierte la visita en VERIFIED.

El bloqueo por visita reciente usa exclusivamente HTTP 409 con
`code: CHECK_IN_COOLDOWN` y el `visitId` propio devuelto por NestJS. Otros 409
conservan su manejo de conflicto y no se presentan como un bloqueo temporal.
El scanner muestra:

> Ya registraste una visita a esta sucursal. Para registrar otra deben pasar cuatro horas desde tu último check-in. Esto no significa que tu conteo siga abierto.

Consulta `/me/sessions` con paginación hasta encontrar **esa visita**, sin asumir
que sea la última visita general: ACTIVE ofrece **Continuar conteo**, COMPLETED
ofrece **Ver resultado**, y CANCELLED permite consultar la sesión cancelada.
Si el historial confirma que todavía no existe una sesión, ofrece iniciar el
conteo de esa misma visita. Si falla la consulta, permite reintentar la lectura;
no interpreta el error como ausencia de sesión ni vuelve a enviar el check-in.
Una cámara pausada sin operación pendiente muestra texto estático, sin spinner.
Los errores de red del check-in conservan el reintento con la misma clave.

La ventana sigue siendo **cuatro horas desde Visit.checkedInAt**, por usuario y
sucursal. No depende de SushiSession.endedAt: finalizar, reintentar o regenerar
el QR no la reinician ni la eliminan.

## Auth, API y navegación

- `AuthProvider` restaura con `getSession`, observa cambios de Auth, ofrece login
  y logout local (no cierra otras sesiones del usuario).
- Supabase renueva tokens; AppState activa/detiene auto-refresh y `processLock`
  serializa operaciones de Auth. El listener de cambios no ejecuta callbacks
  asíncronos de Auth dentro de su propio bloqueo.
  Se conserva este lock compatible con la versión 2.117.2 fijada para serializar
  acceso al adaptador fragmentado; Supabase lo marca obsoleto para v3. Revisar
  esa coordinación antes de cambiar la versión mayor, según su
  [guía de migración](https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/migrations/lockless-coordination.md).
- En iOS/Android, la sesión se guarda en `expo-secure-store`, accesible cuando
  el dispositivo está desbloqueado y no migrable a otro dispositivo. Se divide
  en fragmentos para no depender de valores grandes; un manifiesto se publica
  después de escribirlos. No se usa AsyncStorage para access/refresh tokens.
  Debe comprobarse el ciclo real de restauración en un teléfono.
- La variante web usa memoria, no localStorage: recargar exige iniciar sesión.
- Stack.Protected espera la restauración y separa login de Home, scanner,
  `/session/[id]` e historial. Los borradores se aíslan por usuario y se destruyen
  al salir/cambiar de identidad. NestJS sigue siendo la frontera de autorización.
- Cliente centralizado: Bearer automático, timeout de 20 segundos, errores
  sanitizados, sin redirecciones ni payloads sensibles en logs. Un 401 provoca
  un refresh compartido y un solo reintento; no se reenvía para otra identidad.
  No se reintentan escrituras a ciegas ante timeouts.
- Logout informa errores de conexión; si hay un conteo sin sincronizar, solicita
  resolverlo desde su sesión antes de salir para evitar perderlo accidentalmente.

## Sincronización del contador

Una sesión nueva inicia en cero. `+1` y deshacer modifican estado local inmediato,
con límites 0–1000 compatibles con el backend. La app envía valores **absolutos**
`{pieceCount, version}`, nunca incrementos. Debounce de 600 ms y espera máxima de
2 s durante taps continuos; solo un PATCH en vuelo por sesión. Los taps durante
el PATCH se conservan y se envían en la siguiente sincronización.

Ante un 409 se relee la sesión usando el historial paginado existente, pues no
hay GET individual. No se introduce un endpoint nuevo. Si los conteos difieren,
se muestran servidor y borrador y se pide elegir uno antes de seguir. No se suman
ambos ni se sobrescribe silenciosamente el conteo remoto. Un error de red con
resultado incierto conserva el borrador y exige releer antes de otra escritura.

Finalizar bloquea taps/doble envío, espera el PATCH pendiente, guarda el último
conteo y recién entonces llama a `/complete` con la versión actual. Si se pierde
su respuesta, relee para distinguir una sesión ya completada de una pendiente.
Sólo al recibir `COMPLETED` del servidor (en `/complete` o en una relectura)
aparece **Sesión terminada**, con la cantidad final confirmada y accesos a
**Ver historial** / **Volver a Inicio**. El resultado permanece de sólo lectura.
Si fallan tanto el cierre como la relectura, se conserva la recuperación y no se
muestra éxito. Volver a una sesión relee su estado incluso si hay un borrador:
un cierre remoto recupera el total del servidor; una diferencia en una sesión
activa conserva la elección explícita entre conteo local y remoto.

Los borradores sobreviven a la navegación dentro del mismo login. En segundo
plano se intenta sincronizar, pero el sistema operativo puede suspender la app:
no es una garantía. **No hay persistencia offline de borradores en esta fase**;
cerrar/forzar la app antes de “Conteo guardado” puede perder taps aún no enviados.
La siguiente apertura recupera el valor confirmado por la API.

## Pantallas y contratos

| Pantalla      | API y responsabilidad                                                        |
| ------------- | ---------------------------------------------------------------------------- |
| Login         | Supabase email/password, errores y bloqueo durante envío                     |
| Home          | GET /me + GET /me/visits, recuperación de última visita, logout              |
| Scanner       | POST /check-ins y POST /visits/:visitId/session                              |
| Sushi Session | PATCH /sessions/:sessionId y POST /sessions/:sessionId/complete              |
| Historial     | GET /me/sessions, paginación, fecha, piezas, estado y reanudar/ver resultado |

Un inicio de sesión duplicado (409) se recupera buscando por Visit.id en todas
las páginas del historial. Las pantallas distinguen carga, vacío, error/reintento
y datos. Cámara denegada, QR inválido, conflicto y red caída tienen mensajes
específicos; nunca se interpreta un error de red como confirmación de una escritura.

## Pruebas repetibles

```powershell
pnpm test:mobile
pnpm typecheck:mobile
pnpm --filter @sushi-session/mobile exec expo install --check
pnpm --filter @sushi-session/mobile exec expo export --platform all --output-dir ../../work/mobile-phase4-export
```

Las pruebas unitarias usan el soporte TypeScript de Node (usar Node 24 o Node
22.18+). Cubren QR, debounce, límites, taps durante PATCH, control de versión,
relectura tras errores, respuesta perdida de finalización, Bearer/refresh,
paginación, recuperación de inicio y fragmentación/restauración del almacenamiento.
También cubren cierre pendiente, guardado fallido, respuesta de cierre perdida
con relectura fallida y posterior recuperación, sesión remota completada con
borrador local, recuperación ACTIVE/COMPLETED/sin sesión y distinción de otros 409.
El adaptador de storage se prueba en memoria; esto no simula el llavero nativo.

Prueba optativa contra el backend y Auth reales:

```powershell
# Requiere apps/api/.env y apps/api/.env.auth-test existentes, según sus plantillas.
pnpm test:mobile:live
```

`test/live.mjs` es exclusivamente un runner Node de desarrollo, fuera del árbol
`src` y nunca importado por Expo. Usa la configuración privada de la API solo
para levantar NestJS en un puerto efímero y preparar/limpiar sus fixtures; el
cliente móvil recibe únicamente la URL HTTP y una sesión Supabase en memoria.
Está limitado a `sushi-session-dev`, conserva el usuario/perfil existente,
elimina únicamente su restaurante temporal y relaciones, cierra la sesión de
prueba y detiene el servidor. No aplica migraciones. No imprimir tokens ni QR.

Verificado en esta fase: tests unitarios; TypeScript; compatibilidad Expo;
exportación Android/iOS/web; render y validación de login en navegador integrado;
cliente real con login, Bearer, check-in/reintento, inicio/reinicio, conteo,
conflicto 409, refresh, sincronización final, cierre e historial. Visit conservó
PENDING y verifiedAt vacío. No se hizo un build APK/IPA ni una prueba de teléfono.

### Checklist de aceptación en dispositivo — pendiente

1. Ingresar; cerrar y reabrir la app; confirmar restauración y acceso protegido.
2. Denegar cámara, recuperar permiso desde Ajustes y escanear un QR real.
3. Confirmar una sola visita/sesión pese a lecturas repetidas; empezar en cero.
4. Hacer taps rápidos, deshacer hasta cero y esperar “Conteo guardado”.
5. Cortar la red durante un guardado, recuperarla y resolver la relectura.
6. Alterar la versión desde otro cliente de prueba; verificar el conflicto 409.
7. Finalizar con taps recién hechos; ver resultado e historial con el total exacto.
   Confirmar “Sesión terminada” y ausencia de controles de edición. Escanear otra
   vez el mismo QR dentro de cuatro horas: mensaje de bloqueo y “Ver resultado”,
   sin spinner ni reintento de check-in. Repetir con una sesión ACTIVE y comprobar
   “Continuar conteo”. Cortar la red al finalizar: nunca mostrar éxito sin releer
   y confirmar COMPLETED.
8. Pasar a segundo plano y volver; comprobar renovación/continuidad del login.
9. Cerrar sesión; reabrir y confirmar que las rutas privadas no son accesibles.

El dashboard y la verificación comercial de visitas ya están implementados en
Fase 5. La Fase 6A agrega persistencia de beneficios y reglas en la API; no agrega
pantallas ni emisión, canje o cálculo de descuentos al móvil. Campañas, cupones y
publicación en tiendas siguen pendientes.
