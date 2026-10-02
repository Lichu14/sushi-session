# API de Sushi Session

NestJS 12 + TypeScript estricto + Prisma 7.10.0, dentro del workspace pnpm.
Conectada al PostgreSQL de desarrollo de Supabase mediante el Session pooler.
La Fase 2 integra Supabase Auth: valida el JWT, provisiona el perfil público con el
mismo UUID y expone `GET /me` protegido. `GET /health` sigue siendo público.
La Fase 3 implementa check-in QR, visitas y sesiones de conteo con concurrencia
optimista. Las migraciones se aplican únicamente en `sushi-session-dev`.
La Fase 5 agrega autorización comercial y revisión de visitas con los modelos
existentes, sin nuevas migraciones.
La Fase 6A agrega Reward, RewardLocation y RewardRule: persistencia y restricciones,
sin evaluador, emisión ni canje. El historial contiene tres migraciones aplicadas.

## Arranque desde PowerShell

Desde la raíz del monorepo:

```powershell
pnpm install --frozen-lockfile
pnpm dev:api
```

La configuración local existente está en `apps/api/.env`. En una nueva instalación,
crear ese archivo copiando `.env.example` y completar `DATABASE_URL`. No sobrescribir
un `.env` que ya tenga credenciales.

La API usa `PORT=3001`. El puerto PostgreSQL de la URL es 5432 y es independiente.
En otra terminal:

```powershell
Invoke-RestMethod -Uri 'http://localhost:3001/health'
```

Respuesta: HTTP 200, JSON `{"status":"ok"}`. Este endpoint sigue siendo una prueba
de vida del servidor; no ejecuta una consulta a la base en cada petición.
La API comprueba la conexión al iniciar y cierra el pool al apagarse. Ctrl+C detiene
el servidor de desarrollo.

### Acceso desde un iPhone u otro dispositivo de la LAN

`src/main.ts` escucha explícitamente en `0.0.0.0`: todas las interfaces IPv4 de la PC.
Antes se omitía el host y Node elegía la dirección no especificada (`::` en esta PC),
que ya permitía conexiones IPv4 de la LAN, conforme al [comportamiento de Node.js](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback). El host explícito hace ese comportamiento
IPv4 independiente de la selección predeterminada. `PORT` sigue siendo configurable
en `apps/api/.env` o en el entorno del proceso, con valor predeterminado `3001`.

1. Conectar la PC y el teléfono a la misma red local del router.
2. Desde la raíz, ejecutar `pnpm dev:api` y mantenerlo abierto.
3. En otra terminal PowerShell, ejecutar `ipconfig` y buscar la dirección IPv4 del
   adaptador Wi-Fi o Ethernet conectado al router. Evitar adaptadores virtuales/VPN.
4. En Safari del iPhone, abrir `http://IP_LAN_DE_LA_PC:3001/health`, reemplazando
   `IP_LAN_DE_LA_PC` por esa dirección. Si se cambió `PORT`, usar ese mismo puerto.

La respuesta esperada es HTTP 200 con `{"status":"ok"}`. Desde el teléfono,
`localhost` y `127.0.0.1` identifican al propio teléfono; `0.0.0.0` es la dirección
de escucha del servidor, no la dirección que se escribe en Safari.

Si funciona en la PC pero no en el teléfono, revisar que Firewall de Windows permita
Node.js en la red privada de confianza y que el router no aísle dispositivos o use
una red de invitados. No hace falta abrir puertos en el router hacia Internet.
No se modificaron las reglas del firewall, CORS ni las rutas de la API. Las rutas
autenticadas conservan su guard y `/health` sigue siendo público. Los servidores
aislados de los tests continúan escuchando en `127.0.0.1`.

Se verificó el arranque compilado real en `0.0.0.0`, `/health` por loopback y por la
IPv4 LAN desde la PC, y la configuración de `PORT` en 3001 y 3002. Esa comprobación
local no sustituye abrir la URL desde el teléfono para verificar también el firewall
y la conectividad entre dispositivos.

## Variables de entorno

- `DATABASE_URL`: obligatoria. Copiar la URI desde Supabase → Connect → Session pooler.
  Usar la contraseña PostgreSQL, con sus caracteres especiales codificados para URL.
  Por ejemplo, un `%` literal se representa como `%25`.
- La URL debe tener `schema=public&sslmode=require&sslaccept=strict`.
- `DATABASE_CA_CERT_PATH`: `certs/supabase-ca.crt`, relativo a `apps/api`.
- `PORT`: puerto HTTP; por defecto 3001.
- `SUPABASE_URL`: URL HTTPS del proyecto, `https://PROJECT_REF.supabase.co`, sin
  rutas, parámetros ni credenciales. El emisor y la dirección JWKS se derivan de ella.
- `SUPABASE_PUBLISHABLE_KEY`: clave `sb_publishable_...` del mismo proyecto.
  Permite consultar Auth con el JWT del usuario; no concede privilegios administrativos.

Solo se agregaron estas dos variables de Auth. No se necesita JWT secret, secret key,
service role ni una clave privada. Las claves administrativas y la URL PostgreSQL
nunca deben colocarse en Expo. La app móvil ya usa la clave publicable para el login
implementado en Fase 4; el dashboard usa su propia configuración pública de Auth.

`ConfigModule` carga únicamente el `.env` de la API, independientemente del directorio
desde el que se ejecute Node. Las variables del proceso tienen prioridad sobre el
archivo. La expansión de variables está desactivada para preservar contraseñas con `$`.
La validación rechaza URLs incompletas, codificación inválida, otros schemas y TLS
inseguro, sin incluir valores secretos en los errores.

`.env` está excluido por el `.gitignore` raíz. `.env.example` tiene exclusivamente
marcadores de ejemplo y puede versionarse. El certificado CA incluido es público,
no contiene una clave privada. Su origen y huella están en `certs/README.md`.

## Fase 2: autenticación y perfil

```text
Supabase Auth emite el JWT al iniciar sesión
        ↓ Authorization: Bearer <access_token>
AuthGuard global de NestJS
        ↓ SupabaseJwtService: firma/claims con JWKS + consulta a Auth
AuthProfileService: busca o crea public.users con id = sub
        ↓ @CurrentUser(): identidad verificada y perfil ACTIVE
GET /me → perfil de la identidad autenticada
```

`AuthModule` registra `AuthGuard` con `APP_GUARD`: las rutas quedan protegidas por
defecto. `@Public()` permite la excepción explícita de `GET /health`. Los futuros
controladores deben obtener la identidad de `@CurrentUser()`, nunca de un `userId`
del body, query o un header inventado por el cliente. La autenticación no otorga
roles comerciales; las autorizaciones por membresía se implementarán después.

### Validación del token

Se acepta un único header `Authorization: Bearer <access_token>`. Tokens en cookies,
query strings, headers duplicados o tokens que excedan 8192 caracteres se rechazan.
`jose` 6.2.12 verifica la firma con las claves públicas de
`${SUPABASE_URL}/auth/v1/.well-known/jwks.json` y comprueba:

- Algoritmo ES256 o RS256, tipo JWT y `kid` presente. El proyecto de desarrollo usa ES256.
- Emisor exacto `${SUPABASE_URL}/auth/v1` y audiencia `authenticated`.
- `sub` y `session_id` con formato UUID; `role = authenticated`.
- `exp` e `iat` obligatorios y válidos; vencimiento, `nbf` si existe y tolerancia de 5 segundos.

Las direcciones de red son configuración del servidor: no se toman del `iss`, `jku`
o `jwk` enviado por un token. Se cachean las claves públicas por hasta 10 minutos,
con timeout de 5 segundos y pausa de 30 segundos entre recargas por claves desconocidas.
No hay fallback a HS256, claves compartidas ni simples tokens decodificados.

Después de la verificación criptográfica, cada solicitud protegida consulta
`GET ${SUPABASE_URL}/auth/v1/user` con la clave publicable y el JWT del usuario. Esto
confirma la identidad actual de Auth; su UUID debe coincidir exactamente con `sub`.
Se usan HTTPS, timeout, redirecciones deshabilitadas y ninguna caché de usuarios.
No se ejecutan consultas Prisma sobre `auth` ni se agrega un trigger a `auth.users`.

| Resultado | HTTP |
| --- | --- |
| Token faltante, inválido, vencido o identidad inexistente | 401 |
| Perfil BLOCKED, DELETED o con `deletedAt` | 403 |
| JWKS/Auth/PostgreSQL no disponibles | 503, sin conceder acceso |
| Identidad válida y perfil habilitado | 200 |

La consulta a Auth añade una dependencia de red a las rutas protegidas. Esta fase
no implementa una lista propia de revocación ni consulta `auth.sessions`: no promete
revocación inmediata de un access token al cerrar sesión. La expiración del JWT y
las comprobaciones de Auth siguen aplicando. El refresh y login pertenecen a Supabase;
NestJS no emite tokens ni conserva sesiones, contraseñas o refresh tokens.

### Aprovisionamiento de `public.users`

El guard llama a `AuthProfileService.getOrCreate()` después de validar la identidad.
Si no existe el perfil, se inserta con:

| Campo | Valor inicial |
| --- | --- |
| `id` | UUID exacto de `sub`, confirmado por Auth |
| `displayName` | `Usuario` |
| `locale` | `es-AR` |
| `timeZone` | `UTC` |
| `status` | `ACTIVE` |
| Opcionales | NULL; no se presume consentimiento de marketing |

Se usa `createMany` con `skipDuplicates` (INSERT ON CONFLICT DO NOTHING) para admitir
primeras solicitudes simultáneas. Después se lee el perfil persistido. No se
sobrescriben preferencias, fechas ni estados existentes. No se usa `user_metadata`
para decidir identidad, estado, rol o permisos; tampoco se copia automáticamente al
perfil. Un perfil bloqueado o borrado lógicamente no se reactiva al iniciar sesión.
La FK existente hacia Auth permanece habilitada y protege también ante eliminaciones
concurrentes de la identidad.

`GET /me` devuelve los campos de `User`, con fechas serializadas en ISO, y header
`Cache-Control: no-store`. No recibe un ID de usuario ni devuelve email, datos de Auth,
contraseña, access token, refresh token o datos de otras entidades. No se agregaron
endpoints de edición de perfil, login, logout, membresías o entidades posteriores.

### Pruebas de Auth desde PowerShell

```powershell
pnpm test:api:auth
pnpm test:api:config
```

Estas pruebas usan claves de firma efímeras y dobles de red/almacenamiento. Ejercitan
el guard y el controlador reales de NestJS por HTTP, además de la verificación
criptográfica real de `jose`. No requieren un usuario real ni contactan Supabase.

Para repetir la comprobación completa con el proyecto de desarrollo y un usuario
existente, completar `apps/api/.env.auth-test` a partir de `.env.auth-test.example`:
`TEST_AUTH_EMAIL` y `TEST_AUTH_PASSWORD` se cargan **solo por el script de prueba**;
la API no lee ese archivo. Ambos `.env` locales están ignorados por Git.

```powershell
pnpm test:api:auth:live
```

El script comprueba el proyecto de desarrollo, inicia sesión con esa cuenta, levanta
NestJS en el puerto configurado, prueba 401 para token faltante/inválido y 200 para
`/health`. Luego hace cuatro llamadas simultáneas a `/me`, comprueba la coincidencia
del UUID y que exista un único perfil. También envía un `userId` ajeno en la query
para comprobar que se ignora. Cierra NestJS y hace sign-out de la sesión de prueba;
no imprime ni guarda tokens. El perfil se conserva para poder inspeccionarlo.
El puerto 3001 debe estar libre; detener antes otra instancia de la API.

Comprobación real completada en `sushi-session-dev`: la identidad
`68b1f9ab-1ab8-48b5-87fe-ca62770f01cc` obtuvo cuatro HTTP 200 y se provisionó un único
perfil `ACTIVE`. Una consulta independiente desde Supabase confirmó su relación con
`auth.users`. No se escribió en tablas de Auth mediante SQL.

## Prisma y alcance de la base

`prisma/schema.prisma` declara `provider = "postgresql"` y `schemas = ["public"]`.
Contiene doce modelos y dieciséis enums de las Fases 1, 3 y 6A del documento
`Modelo_de_datos_MVP_Sushi_Counter_v1.1_Normalizado.docx`.
Todos usan `@@schema("public")`, con tablas, columnas y tipos enum en `snake_case`.
Supabase administra `auth` y `storage`: no se modelan ni se ejecuta DDL sobre ellos.
La migración agrega sobre `public.users` la FK hacia la PK existente `auth.users.id`.

`prisma.config.ts` carga la misma URL para la CLI, incorporando la CA y manteniendo
TLS estricto. El Session pooler en puerto 5432 sirve para esta etapa local; no se usa
el pooler transaccional 6543 para comandos de administración.

El `PrismaService` usa `@prisma/adapter-pg`, un pool de hasta 5 conexiones, un timeout
de conexión de 10 segundos y TLS con `rejectUnauthorized: true`. Configura `public`
explícitamente en el adaptador. Los parámetros de la URL no pueden reemplazar la
configuración explícita de TLS del servicio.

La selección de `public` delimita la configuración de Prisma; no modifica privilegios
del rol PostgreSQL ni constituye una barrera para SQL manual con nombres calificados.
Las migraciones incluyen SQL controlado para las reglas no representables en Prisma.
No usar `prisma db push`, `migrate reset` ni un diff automático contra Auth. Los futuros
diffs deben revisarse: Prisma no representa esta FK externa, los CHECK ni los triggers.
No eliminar estas restricciones porque no aparezcan en `schema.prisma`.

Para reutilizar el servicio, importar `PrismaModule` en el módulo NestJS que lo necesite
e inyectar `PrismaService` por constructor. Una instancia y su pool se comparten a
través del módulo exportado.

## Archivos principales

```text
prisma/schema.prisma             # Cinco modelos, seis enums, relaciones e índices
prisma/migrations/20261001010000_phase_1_identity_and_merchants/
  migration.sql                  # DDL generado + FK Auth, CHECK, triggers y RLS
  REVIEW.md                      # Alcance, decisiones y evidencia de revisión
prisma/migrations/migration_lock.toml # Proveedor PostgreSQL del historial Prisma
prisma.config.ts                 # Configuración de la CLI y carga de .env
.env.example                     # Plantilla sin secretos
.env                             # Credenciales locales, ignorado por Git
certs/supabase-ca.crt             # CA pública oficial
certs/README.md                   # Procedencia y huella del certificado
src/config/environment.ts        # Ruta estable del .env y validación
src/prisma/prisma.module.ts       # Exporta PrismaService
src/prisma/prisma.service.ts      # Cliente reutilizable, pool y ciclo de vida
src/prisma/check-connection.ts    # SELECT 1 usando el contexto NestJS
src/generated/prisma/            # Cliente generado, ignorado por Git
src/app.module.ts                # Integra ConfigModule y PrismaModule
src/main.ts                      # Puerto validado y apagado ordenado
src/health.controller.ts         # GET /health
src/auth/auth.module.ts          # Guard global y módulo Auth
src/auth/supabase-jwt.service.ts  # JWT/JWKS y consulta segura a Supabase Auth
src/auth/auth.guard.ts           # Bearer -> identidad verificada -> perfil activo
src/auth/current-user.decorator.ts # Acceso a la identidad verificada
src/auth/public.decorator.ts     # Excepción explícita para health
src/auth/auth-profile.service.ts # Provisionamiento idempotente del perfil
src/auth/auth.types.ts           # Identidad y request autenticado
src/auth/me.controller.ts        # GET /me protegido
test/environment.test.mjs        # Pruebas de validación sin credenciales reales
test/auth-jwt.test.mjs           # Firma, claims, emisor, audiencia y fallos de Auth
test/auth-http.test.mjs          # Guard/controlador reales con persistencia aislada
test/helpers/auth-fixture.mjs    # Claves y JWT efímeros para pruebas
test/persistence.integration.test.mjs # Catálogo e integridad SQL; rollback total
test/prisma.integration.test.mjs  # Modelos desde NestJS/Prisma y GET /health
scripts/development-database.mjs  # TLS y comprobación del proyecto de desarrollo
scripts/migrate-development.mjs  # Ejecuta deploy/status sin interpolar credenciales
scripts/verify-auth-development.mjs # Prueba real de Auth, /me y perfil persistido
.env.auth-test.example           # Plantilla opcional para esa prueba, sin secretos
```

`nest-cli.json`, `tsconfig.json`, `tsconfig.build.json`, `.oxlintrc.json` y
`.prettierrc` configuran la compilación y el lint. `.prettierignore` y Oxlint excluyen
el cliente generado. `dist/` y las dependencias permanecen fuera de Git.

## Comandos desde la raíz

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm typecheck:api
pnpm lint:api
pnpm test:api:config
pnpm test:api:auth
pnpm test:api:persistence
pnpm test:api:visits
pnpm db:check
pnpm db:status
pnpm build:api
pnpm start:api
```

- Generar/validar Prisma no consulta ni modifica tablas.
- La compilación y el arranque de desarrollo generan el cliente automáticamente.
- `db:check` compila, inicia un contexto NestJS, obtiene el `PrismaService`, ejecuta
  `SELECT 1::integer AS ok`, comprueba el resultado y cierra las conexiones.
- `start:api` usa la última compilación; necesita `build:api` primero.
- `test:api:persistence` necesita la base de desarrollo migrada y el puerto de la API
  disponible. Levanta NestJS, prueba HTTP y lo cierra; revierte todos los datos de prueba.
- `db:status` consulta el historial de Prisma. `db:migrate:dev` aplica solo migraciones
  pendientes, después de compilar y comprobar el destino. No hay script de `db push`.

## Fase 1 del contrato v1.1

| Modelo | Tabla | Integridad principal |
| --- | --- | --- |
| `User` | `users` | UUID recibido de Auth, sin `default(uuid())`; FK externa RESTRICT |
| `Restaurant` | `restaurants` | `slug` único |
| `RestaurantLocation` | `restaurant_locations` | UNIQUE `(restaurant_id, slug)`; restaurante inmutable |
| `MerchantMembership` | `merchant_memberships` | UNIQUE `(user_id, restaurant_id)`; usuario y restaurante inmutables |
| `MerchantMembershipLocation` | `merchant_membership_locations` | PK `(membership_id, location_id)`, sin ID artificial ni restaurante duplicado |

Enums: `UserStatus`, `RestaurantStatus`, `LocationStatus`, `MerchantRole`,
`MembershipStatus` y `MembershipScopeType`, con los valores exactos del documento.
Se respetan longitudes varchar, `char(2)`, fechas sin hora, `numeric(9,6)`, campos
opcionales y `timestamptz(6)`. Los UUID de las otras tres entidades se generan en
Prisma mediante `uuid()`, como indica el contrato; al escribir SQL directo hay que
proveerlos. `created_at` y `updated_at` tienen hora inicial del servidor; un trigger
actualiza `updated_at` también en escrituras SQL.

Además de las cinco PK hay tres índices UNIQUE, dos índices de consulta y siete FK.
Todas las FK usan `ON DELETE RESTRICT ON UPDATE RESTRICT`, incluida la del invitador
opcional. El CHECK de membresía exige `accepted_at` cuando `status = ACTIVE`.
No se agregan estados, atributos, índices redundantes ni entidades de otras fases.

### Alcance y transacciones

Los constraint triggers `merchant_memberships_scope` y
`merchant_membership_locations_scope` son `DEFERRABLE INITIALLY DEFERRED` y revisan
el estado final al COMMIT:

- `ALL_LOCATIONS`: cero filas puente.
- `SELECTED_LOCATIONS`: al menos una, también para `INVITED`.
- Todas las sucursales seleccionadas pertenecen al restaurante de la membresía.
- INSERT, UPDATE y DELETE revisan ambos extremos afectados, incluso al mover una
  asociación. Archivar una sucursal conserva sus asociaciones.

Un trigger de la tabla puente actualiza/bloquea las membresías afectadas en orden de
UUID. La escritura real sobre la membresía impide anomalías con snapshots antiguos
en `REPEATABLE READ`. Al implementar servicios, bloquear primero **todas** las
membresías involucradas, en orden de UUID, y luego modificar las asociaciones dentro
de la misma transacción. Reintentar la transacción completa ante `40001` o `40P01`.
El trigger es una protección de integridad; no sustituye ese orden en los servicios.

La pertenencia de la sucursal queda congelada desde su alta para que una reasignación
posterior no invalide selecciones o historial. `TRUNCATE` de la tabla puente se
rechaza porque omitiría los triggers por fila. La Fase 1 no implementó servicios ni
endpoints de gestión de comercios. La autorización contextual del invitador y la distinción entre
alta interna e invitación del dashboard se validarán en esos futuros servicios;
el contrato no contiene una columna que permita deducir ese contexto mediante CHECK.

### Migración y seguridad

Migración: `20261001010000_phase_1_identity_and_merchants`. Se generó el DDL desde
el esquema vacío con Prisma, se calificaron los objetos con `public` y se incorporó
el SQL de integridad. Se revisó el archivo completo y se ejecutó una prueba con
ROLLBACK antes del despliegue. No contiene DROP, borrado de datos ni DDL sobre los
schemas administrados por Supabase. Se aplica en una transacción.

El historial único está en `prisma/migrations` y `public._prisma_migrations`.
No se abrió otro historial con Supabase CLI. Para aplicar futuras migraciones
**después de revisar su SQL**, desde PowerShell en la raíz:

```powershell
pnpm db:migrate:dev
pnpm db:status
```

El comando admite exclusivamente `sushi-session-dev` (`qmlwqrfnfjphvgzjfnly`) por
conexión directa o Session pooler en 5432 y rechaza `NODE_ENV=production`. Las
credenciales siguen en `.env`, ignorado por Git; no se pasan como argumentos de CLI.

RLS está activado en las cinco tablas y en el historial de Prisma, sin políticas de
cliente en esta fase. Los accesos de `anon`/`authenticated` quedan cerrados; no se
adelantó el diseño de autorización. El rol PostgreSQL de desarrollo usado por NestJS
tiene bypass de RLS, por lo que los futuros servicios deberán verificar permisos.
Las seis funciones agregadas son `SECURITY INVOKER`, fijan `search_path=pg_catalog`
y no tienen permiso EXECUTE para PUBLIC, `anon` ni `authenticated`.

## Verificación

Prisma validate/generate, TypeScript, compilación, lint y las 140 comprobaciones de
configuración, Auth, persistencia y HTTP pasan (79 existentes + 61 de Fase 3).
Se comprobaron `SELECT 1` desde NestJS y `GET /health` con
HTTP 200 y `{"status":"ok"}`. Prisma confirma que no quedan migraciones pendientes.

Las pruebas de persistencia verifican en PostgreSQL las columnas, tipos, nulabilidad,
enums, PK, FK, índices, CHECK, RLS y triggers; además prueban estados válidos, cambios
atómicos de alcance, duplicados, asignaciones cruzadas, referencias inválidas,
inmutabilidad, RESTRICT y conservación de asociaciones al archivar. Una prueba desde
NestJS escribe/lee los cinco modelos con Prisma, comprueba sus relaciones y revierte.

Las pruebas de integridad funcionan incluso con Auth vacío: crean perfiles sintéticos solo
dentro de una transacción que se revierte por completo. La FK a Auth es
`DEFERRABLE INITIALLY IMMEDIATE`: las pruebas difieren explícitamente esa FK sin
deshabilitarla y comprueban que rechaza los UUID inexistentes al hacerla inmediata.
Las reglas de alcance se fuerzan con `SET CONSTRAINTS ... IMMEDIATE` por nombre,
ejecutando los mismos triggers que se ejecutan al COMMIT. No se insertan identidades
en Auth ni se conservan fixtures. Esta suite no simula carreras entre dos sesiones.

El advisor de Supabase solo informa RLS sin políticas para las tablas nuevas, que es
intencional en esta fase. También señala permisos sobre `public.rls_auto_enable()`,
una función preexistente de tipo `event_trigger`, ajena a esta migración; no se cambió.
La prueba de relaciones anidadas registra un aviso de deprecación de `pg` sobre
consultas encoladas por el adaptador; todas las comprobaciones pasan con las versiones
actuales y no se cambiaron dependencias. El servidor de verificación queda cerrado.

Al finalizar la Fase 1 se confirmó el checksum del SQL aplicado, las definiciones de
columnas de los otros schemas sin cambios y las cinco tablas sin fixtures. Se
revisaron 51 archivos visibles para Git: cero coincidencias con la URL o contraseña
reales; `.env` permanece excluido. La Fase 2 conserva el mismo esquema y la misma
migración; agrega únicamente la integración Auth y el perfil de la cuenta de prueba.
En Fase 2 no se ejecutó ninguna migración adicional. La siguiente sección describe
la migración aditiva de Fase 3.

En la revisión de Supabase de esta fase también se observó el aviso de configuración
`auth_leaked_password_protection`: la protección contra contraseñas filtradas no está
activada en el proyecto. No se cambiaron ajustes de Auth. Los avisos anteriores sobre
RLS sin políticas y la función preexistente `rls_auto_enable()` siguen documentados arriba.

## Fase 3: check-in, Visit y SushiSession

Contrato: `Modelo_de_datos_MVP_Sushi_Counter_v1.1_Normalizado.docx`. Se agregaron
`CheckInCode`, `Visit`, `VisitCheckInEvidence` y `SushiSession`, con los seis enums
del contrato, campos opcionales, longitudes y relaciones explícitas. `Visit` puede
existir sin sesión; `SushiSession.visitId` es UNIQUE. La evidencia tiene `visitId`
como PK/FK y no duplica ubicación ni usuario.

### Migración e integridad

`prisma/migrations/20261001030000_phase_3_check_ins_and_sessions/migration.sql`
se generó comparando el esquema Prisma anterior con el nuevo, se revisó y se probó
con ROLLBACK antes de aplicarlo con `pnpm db:migrate:dev`. Se conservaron el historial
y el checksum de Fase 1. El SQL agrega únicamente objetos en `public`; no contiene
DDL para `auth`, `storage` ni otros schemas de Supabase. No se usó `db push`.

- Cuatro PK, siete FK RESTRICT y once índices en total (incluidas las PK y los
  UNIQUE de token, idempotencia y sesión por visita), sin copias redundantes.
- Once CHECK para vigencias, vencimiento obligatorio de ROTATING/ONE_TIME,
  `ONE_TIME.maxUses = 1` no nulo, límites positivos, hash SHA-256 hexadecimal,
  verificación/cierre de visita, conteo 0–1000, versión positiva y cierre de sesión.
- Triggers diferidos sobre INSERT/UPDATE/DELETE en visita y evidencia: al COMMIT,
  QR exige exactamente una evidencia y MANUAL/IMPORT ninguna; sucursales coinciden.
  Se revisan ambos padres al mover evidencia. Un cambio de sucursal del código
  está prohibido. El token también es inmutable: una rotación crea otro código,
  conservando la identidad de los reintentos. TRUNCATE de evidencia se rechaza.
- Al aceptar evidencia se bloquea/escribe la fila del código antes de contar sus
  usos y se comprueban estado, vigencia y capacidad. Cuenta toda evidencia aceptada,
  incluso de visitas PENDING: cerrar una sesión no libera el uso. La escritura
  protege también contra snapshots antiguos en REPEATABLE READ. La evidencia
  serializa cambios con su visita para mantener las restricciones cruzadas.
- Si se informa `createdByMembershipId`, un trigger exige una membresía activa que
  cubra la sucursal al crear/asignar ese actor. No se expone aún una API de gestión
  de códigos; sus permisos comerciales por rol pertenecen a esa futura operación.
- El trigger de sesión exige avanzar `version` exactamente en uno por actualización,
  conserva visita e inicio y permite pasar de ACTIVE a COMPLETED o CANCELLED.
  Los estados cerrados son terminales. Al completar, PostgreSQL fija `endedAt`.
- Las cuatro tablas tienen RLS sin políticas de acceso directo. Las siete funciones
  nuevas usan SECURITY INVOKER y `search_path=pg_catalog`; se revoca su ejecución a
  PUBLIC, anon y authenticated. NestJS verifica propiedad porque el rol SQL actual
  de desarrollo tiene bypass de RLS.

El catálogo real confirmó columnas, nulabilidad, tipos, enums, claves, índices,
restricciones y RLS. No se agregaron atributos ni tablas de fidelización.

### Servicios e identidad

`VisitsModule` conecta `CheckInService` y `SushiSessionService` con Prisma. El guard
global de Auth protege las seis rutas; todas obtienen `user.id` de `@CurrentUser()`.
Los cuerpos se validan en runtime, sin conversión implícita de strings a números;
campos adicionales como `userId`, `status`, `increment` o `endedAt` se rechazan.
No se incorporaron dependencias ni variables de entorno nuevas.

El check-in bloquea primero User y luego CheckInCode. Reutilizar la misma clave con
el mismo usuario, sucursal y token devuelve la visita existente, aunque el código
ya esté agotado o revocado. Cambiar esos datos conservando la clave devuelve 409.
La clave es globalmente única, como exige el contrato. No se registra ni devuelve
el token QR o su hash; solo se conserva SHA-256 en CheckInCode.

**Decisión del piloto confirmada durante esta fase:** claves distintas para el mismo
usuario y sucursal se rechazan con 409 durante 4 horas desde el primer check-in.
Los reintentos no desplazan la ventana ni consumen usos. La ventana considera las
visitas de cualquier estado/origen; otra sucursal tiene su propia ventana. Se usa
tiempo transcurrido en UTC, no cambio de día calendario. El valor está en
`CHECK_IN_WINDOW_MS`; v1.1 exigía una ventana, pero no fijaba su duración.

Este bloqueo devuelve `{ statusCode: 409, code: "CHECK_IN_COOLDOWN", message,
visitId }`. El UUID corresponde únicamente a una visita del usuario autenticado
en esa sucursal. Permite al móvil consultar la sesión asociada sin confundirla
con otra visita ni inferir que el conteo siga abierto. No se incluyen tokens,
hashes ni datos de otros usuarios. Los demás conflictos 409 no llevan este código.
Finalizar una SushiSession no elimina ni reinicia la ventana: se sigue contando
desde `Visit.checkedInAt`, nunca desde `SushiSession.endedAt`.

Los códigos deben estar activos, vigentes y pertenecer a una sucursal/restaurante
activos. Todas las visitas creadas por esta API son QR/PENDING, también para códigos
ROTATING y ONE_TIME: todavía no hay proceso autorizado de verificación. El servicio
no crea MANUAL/IMPORT. La base sí admite esos orígenes sin evidencia según el contrato.

Las actualizaciones de sesión usan un UPDATE condicionado por `id`, propietario,
estado ACTIVE y versión esperada. Una sola operación cambia el conteo absoluto e
incrementa la versión; cero filas devuelve 409. Un padre ajeno devuelve 404 y los
historiales filtran siempre por propietario. Los conflictos de serialización o
deadlock reintentan la transacción completa hasta tres veces. Errores de base no
exponen consultas, hashes ni credenciales.

Inicio y cierre usan el reloj de PostgreSQL para evitar diferencias entre máquinas.
Completar la sesión conserva `Visit.status`, `verifiedAt` y `checkedOutAt`; el conteo
no es evidencia de presencia. No hay premios, evaluación ni validación automática.
La transición CANCELLED está protegida en SQL; no se agregó un endpoint de cancelación.

### Contrato HTTP

Todas las rutas requieren `Authorization: Bearer <access_token>` y responden
`Cache-Control: no-store`. Los UUID son strings. Los timestamps se devuelven en UTC.

| Método y ruta | Cuerpo JSON / query | Resultado |
| --- | --- | --- |
| POST `/check-ins` | `{ "locationId": "uuid", "token": "token-del-QR", "idempotencyKey": "clave-única" }` | 201 con Visit, también en reintentos |
| POST `/visits/:visitId/session` | `{ "entryMode": "TAP", "notes": null }`; ambos opcionales | 201, ACTIVE, pieceCount=0, version=1 |
| PATCH `/sessions/:sessionId` | `{ "pieceCount": 12, "version": 1 }` | 200 con valor absoluto y nueva versión |
| POST `/sessions/:sessionId/complete` | `{ "version": 2 }` | 200, COMPLETED, endedAt del servidor |
| GET `/me/visits` | `?limit=50&cursor=uuid` opcional | `{ "items": [...], "nextCursor": null }` |
| GET `/me/sessions` | `?limit=50&cursor=uuid` opcional | Mismo formato; incluye solo sesiones propias |

`entryMode` acepta TAP o MANUAL; `notes`, hasta 500 caracteres. `idempotencyKey` debe
ser no vacía y tener hasta 120 caracteres. `pieceCount` es entero 0–1000; `version`
es obligatoria en cambios/cierre. Historia: límite 1–100, por defecto 50; cursor de
la última fila de la página anterior, orden descendente por inicio e ID. Se valida
también la propiedad del cursor y se conserva la precisión de timestamps en SQL.

Errores: 400 para entrada/código inválidos, revocados, fuera de vigencia, agotados o
de otra sucursal; 401 sin JWT válido; 403 para perfil bloqueado; 404 para visita/sesión
inexistente o ajena; 409 para clave incompatible, ventana de 4 horas, sesión duplicada,
versión desactualizada o sesión cerrada. Ante 409 de versión, releer `/me/sessions` y
decidir el próximo valor absoluto con la versión vigente.

### Archivos y pruebas de esta fase

```text
prisma/schema.prisma                        # Cuatro modelos y seis enums nuevos
prisma/migrations/20261001030000_phase_3_check_ins_and_sessions/migration.sql
src/app.module.ts                           # Importa VisitsModule
src/visits/visits.module.ts                  # Proveedores y controlador
src/visits/visits.controller.ts              # Seis rutas, CurrentUser, no-store
src/visits/check-in.service.ts               # Idempotencia, ventana, consumo QR e historial
src/visits/sushi-session.service.ts          # Propiedad, conteo absoluto, CAS y cierre
src/visits/inputs.ts                         # Validación estricta de body/query/UUID
src/visits/database-operation.ts             # Errores seguros y reintentos acotados
test/visits-persistence.integration.test.mjs # Catálogo y restricciones con rollback
test/visits-http.integration.test.mjs        # HTTP y carreras con PostgreSQL real
test/helpers/visit-fixture.mjs               # Fixtures aislados y limpieza por IDs propios
scripts/verify-visits-development.mjs        # Flujo con Supabase Auth real
```

Se actualizaron los scripts en ambos `package.json`, este README y el README raíz.
La prueba de enums de Fase 1 ahora consulta sus seis enums por nombre, conservando
la comprobación exacta de sus valores al coexistir los seis nuevos. El helper de
conexión de desarrollo usa un nombre de aplicación común para ambas fases.

Desde PowerShell en la raíz:

```powershell
pnpm test:api:visits
pnpm test:api:visits:live
```

La primera suite tiene 61 comprobaciones: 41 SQL y 20 HTTP. Las pruebas HTTP usan
JWT firmados con claves efímeras y PostgreSQL real. El dueño es un perfil existente
de desarrollo; la segunda identidad es un doble solo para comprobar denegaciones,
sin crear usuarios en Auth ni persistir perfiles falsos. Se prueban solicitudes
simultáneas, capacidad ONE_TIME con dos conexiones PostgreSQL independientes,
claves iguales/distintas, ventana de cuatro horas, cambio absoluto, versión, cierre,
aislamiento, cursor y protección de todas las rutas.

La prueba `:live` reutiliza `.env.auth-test`, ignorado por Git. Inicia sesión realmente
en Supabase, recorre los seis endpoints sin sustituir Auth, confirma 409 por versión,
cierra una sesión de inmediato y comprueba `/health` y `/me`. Los tokens quedan
solo en memoria; al finalizar cierra esa sesión Auth y el servidor. Las pruebas
crean datos de negocio temporales bajo un restaurante nuevo y eliminan únicamente
esos fixtures; conservan el usuario y el perfil existentes. No quedan códigos QR
de prueba utilizables ni visitas de prueba.

Verificación final: 140 pruebas automatizadas aprobadas, flujo Auth real aprobado,
Prisma validate/generate, TypeScript, lint y build correctos; historial Prisma al día.
Los avisos preexistentes del advisor de Supabase sobre `rls_auto_enable()` y protección
contra contraseñas filtradas permanecen. RLS sin políticas en las diez tablas públicas
(incluido el historial Prisma) es intencional para el acceso exclusivo por NestJS.
El advisor de rendimiento informa dos FK de auditoría sin índice dedicado:
`created_by_membership_id` e `invited_by_user_id`. Se conserva la decisión explícita
de v1.1: agregar índices de actores de auditoría cuando una consulta real los justifique.

La Fase 3 incorporó únicamente check-in y sesiones. El login móvil y el dashboard
se implementaron posteriormente en las Fases 4 y 5; la Fase 6A incorpora la
persistencia de beneficios y reglas descrita más abajo. Emisión y canje siguen pendientes.

## Fase 5: autorización comercial y revisión de visitas

El AuthGuard global valida el JWT y el perfil. Cada endpoint recibe exclusivamente
la identidad de `@CurrentUser()`. `MerchantAuthorizationService` aplica el alcance
en las consultas de Prisma y vuelve a validarlo dentro de la transacción de cada
confirmación/rechazo. Los IDs del cliente sólo sirven como filtros o referencias;
no pueden conceder permisos ni cambiar el restaurante de una visita.

| Rol ACTIVE | Consultar | Confirmar / rechazar |
| --- | --- | --- |
| OWNER, ADMIN, MANAGER, STAFF | Sí, dentro de su alcance | Sí, dentro de su alcance |
| ANALYST | Sí, dentro de su alcance | No |

El restaurante y la sucursal deben estar `ACTIVE`. `ALL_LOCATIONS` cubre todas las
sucursales activas del restaurante de la membresía. `SELECTED_LOCATIONS` cubre sólo
sus asociaciones en `MerchantMembershipLocation`. Las restricciones de Fase 1
garantizan que esas asociaciones pertenezcan al mismo restaurante. Una membresía
INVITED, SUSPENDED o REVOKED nunca autoriza. No se confía en roles de user_metadata.

| Método / ruta | Entrada | Respuesta |
| --- | --- | --- |
| GET `/merchant/locations` | Sin query | `{ items: [{ id, name, restaurant, canReview }] }` |
| GET `/merchant/visits` | `locationId`, `status`, `limit`, `cursor` opcionales | `{ items, nextCursor }` |
| POST `/merchant/visits/:visitId/verify` | `{}` | 200, visita VERIFIED |
| POST `/merchant/visits/:visitId/reject` | `{ "reason": "Motivo del rechazo" }` | 200, visita REJECTED |

El listado predetermina `status=PENDING`, `limit=50` (1–100). También admite
VERIFIED, REJECTED y CANCELLED. Orden descendente por `checkedInAt` e ID; enviar el
`nextCursor` anterior sin cambiar filtros. Un cursor que perdió estado/alcance da
404: actualizar desde la primera página. Un filtro vacío debe omitirse.
Los campos desconocidos, arrays, UUID malformados y parámetros repetidos se rechazan.

Sólo PENDING puede resolverse. Confirmar fija `verifiedAt` con el reloj de PostgreSQL.
Rechazar requiere un motivo recortado de 1–300 caracteres y conserva la visita.
Repetir confirmación devuelve el mismo resultado sin modificar timestamps; repetir
rechazo exige el mismo motivo. Otra transición o un motivo diferente devuelve 409.
Se preservan `checkedInAt`, evidencia QR y SushiSession; ni `pieceCount` ni el cierre
de sesión deciden la verificación. No se generan premios.

La transacción bloquea la membresía y las filas de restaurante/sucursal durante la
autorización, y la visita al resolverla. Los triggers de alcance existentes bloquean
la membresía al cambiar su selección. Así se serializan los cambios de permisos y
las dobles decisiones; la segunda operación relee el estado confirmado. Un conflicto
transaccional puede reintentarse de forma acotada mediante `databaseOperation`.

401: falta Auth válida. 403: no hay membresía activa o ANALYST intenta resolver.
404: visita/sucursal/cursor inexistente o fuera de alcance. 400: entrada inválida.
409: transición incompatible. 503: dependencia temporalmente indisponible.
Todas las respuestas comerciales son `no-store`. Se exponen únicamente datos de
la visita, sucursal/restaurante y `displayName`; no se devuelven notas, conteo,
credenciales, hash del QR ni datos privados del perfil. `/health` y `/me` siguen igual.

### Archivos y verificaciones

- `src/merchant/merchant.module.ts` y `merchant.controller.ts`: cuatro endpoints protegidos.
- `merchant-authorization.service.ts`: permisos reutilizables y bloqueos transaccionales.
- `merchant-visits.service.ts`: consultas, paginación y decisiones idempotentes.
- `merchant-inputs.ts`: validación estricta de entradas.
- `src/app.module.ts`: incorpora MerchantModule.
- `test/merchant-http.integration.test.mjs`: 22 pruebas con PostgreSQL de desarrollo.
- `package.json`, README raíz y scripts del workspace: comandos de Fase 5.

```powershell
pnpm test:api:merchant
pnpm typecheck:api
pnpm lint:api
pnpm build:api
```

La suite comercial comprueba JWT faltantes/inválidos, aislamiento entre restaurantes,
alcance SELECTED/ALL, estados de membresía y establecimiento, los cinco roles,
confirmaciones/rechazos simultáneos, motivos obligatorios, paginación y preservación
de evidencia/sesiones. Usa restaurantes y membresías temporales y sólo elimina esos
fixtures. Los usuarios Auth existentes no se modifican. Una identidad adicional de
cliente se prueba con rollback, sin persistir perfiles sin Auth.

El dashboard se documenta en [su README](../dashboard/README.md). Sus operaciones de
negocio pasan por NestJS; no necesita DATABASE_URL ni secret key. Prisma sigue
administrando únicamente `public`, con las dos migraciones anteriores.

Verificación de Fase 5: 162 pruebas de API aprobadas (140 existentes + 22 comerciales),
Prisma validate/generate, TypeScript, lint y build correctos. El historial de
migraciones permanece al día. El flujo del dashboard también se comprobó con
Supabase Auth real y PostgreSQL, sin dejar membresías ni restaurantes de prueba.

## Herramienta dev:qr

Herramienta local de desarrollo; no registra endpoints ni modifica el modelo o las
migraciones. Requiere Node.js 24 (el runtime comprobado del monorepo) y dependencias
de desarrollo instaladas. Ejecutar desde la raíz:

```powershell
pnpm dev:qr
pnpm dev:qr --owner-user-id '<UUID_DE_PUBLIC_USERS>'
```

La segunda variante es opcional: el UUID debe identificar un User existente, ACTIVE
y no eliminado. No se elige un usuario automáticamente, no se crean identidades y
no se escribe en Supabase Auth. La opción crea o actualiza **sólo** su membresía en
el restaurante de prueba como OWNER + ACTIVE + ALL_LOCATIONS; establece acceptedAt
si faltaba y elimina selecciones previas de esa membresía en la misma transacción.
Omitir el argumento conserva las membresías existentes. No hay variables privadas nuevas.

`scripts/dev-qr.mjs` compila Prisma/Nest localmente con salida capturada, carga la
configuración habitual y usa el mismo PrismaService/TLS. Antes de conectar verifica
el proyecto fijo `sushi-session-dev`, puerto PostgreSQL 5432, base postgres, schema
public y SUPABASE_URL del mismo proyecto. Rechaza NODE_ENV ajeno a development/test.
No abre un servidor ni aplica migraciones. Sus errores son genéricos y no imprimen
excepciones de PostgreSQL, credenciales, tokens o hashes.

`scripts/dev-qr-fixture.mjs` reserva los slugs `dev-sushi-session-test` y
`dev-local-de-prueba`, con nombres **Sushi Session Test** y **Local de prueba**.
La dirección es ficticia. Reutiliza sólo esos registros si sus nombres coinciden y
están activos; ante colisión o estado inactivo aborta sin reconvertir otros datos.

Cada ejecución genera 32 bytes aleatorios (256 bits), los representa en base64url
y guarda únicamente SHA-256 en `CheckInCode.tokenHash`. Revoca los códigos anteriores
de esa sucursal con label exacto `DEV_TEST_QR`, fijando revokedAt. No afecta códigos
con otro label o de otras sucursales. Inserta un código nuevo STATIC + ACTIVE con
validFrom del reloj de PostgreSQL, validUntil=null y maxUses=null, permitido por las
restricciones actuales. Las visitas, evidencia y sesiones anteriores se conservan.

El PNG de 768 px contiene exclusivamente JSON con `v: 1`, `locationId` real y `token`.
Se genera con [node-qrcode](https://github.com/soldair/node-qrcode), se decodifica con
[jsQR](https://github.com/cozmo/jsQR) y se valida usando `parseCheckInQr` de mobile
antes de confirmar la transacción. Las tres bibliotecas de imagen son dependencias
de desarrollo. No se produce un archivo de texto con el token.

Un bloqueo transaccional PostgreSQL serializa rotaciones. Un lock local evita que dos
procesos de esta carpeta publiquen PNGs fuera de orden. Se escribe/sincroniza un PNG
temporal antes del commit y se renombra a `work/dev-checkin-qr.png` después. Un fallo
previo al commit revierte cambios; si falla la publicación tras el commit, se intenta
revocar el código nuevo y se devuelve error. Base de datos y filesystem no comparten
una transacción: después de una interrupción brusca, volver a ejecutar para generar
un QR vigente. Si quedó `work/.dev-checkin-qr.lock`, comprobar que no haya otro
`dev:qr` ejecutándose antes de eliminar únicamente ese lock local.

`work/` y todos sus PNGs quedan ignorados. El comando aborta si falta esa exclusión
o si ya hay archivos de work versionados. La salida correcta contiene sólo seis
datos: pngPath, restaurant, location, restaurantId, locationId y checkInCodeId.
Al regenerarlo, las copias o capturas anteriores del QR dejan de servir.

### Prueba manual

1. Iniciar `pnpm dev:api`, `pnpm dev:mobile` y `pnpm dev:dashboard` en terminales separadas.
2. Generar el QR, opcionalmente con el UUID explícito del usuario comercial.
3. Abrirlo en la PC: `Invoke-Item .\work\dev-checkin-qr.png`.
4. En el iPhone, entrar a Sushi Session y usar su scanner de sucursal. API y teléfono
   deben ser accesibles por LAN según la configuración móvil existente.
5. Registrar el check-in: la Visit queda PENDING. Iniciar SushiSession, contar y completar.
6. En `http://localhost:3000`, entrar con la cuenta asociada y elegir **Local de prueba**
   del restaurante **Sushi Session Test**. Confirmar la visita y verla en Verificadas.

La herramienta no crea visitas para mostrar en el dashboard: la primera se crea
cuando escaneás desde la app. La ventana de deduplicación de cuatro horas sigue
vigente aunque se regenere el código; no se borran visitas ni se altera ese control.

### Pruebas automatizadas

```powershell
pnpm test:api:dev-qr
```

La suite usa registros aislados y elimina sólo esos fixtures. Comprueba la restricción
de proyecto, argumentos, PNG decodificable con el parser móvil, hash persistido,
rotación concurrente, aislamiento de labels/sucursales, OWNER explícito, rollback
ante fallo de escritura y colisión de slugs. Recorre además por HTTP el PNG → check-in
PENDING → SushiSession/conteo/cierre → confirmación comercial VERIFIED, preservando
evidencia e historial al revocar el QR. No consume la visita del fixture manual.

## Fase 6A: persistencia de beneficios y reglas

Contrato: `Modelo_de_datos_MVP_Sushi_Counter_v1.1_Normalizado.docx`, diccionario de
fidelización y secciones 9–11. Se agregaron sólo `Reward`, `RewardLocation`,
`RewardRule` y cuatro enums: `RewardType`, `LifecycleStatus`, `RuleMetric`,
`RuleOperator`. Prisma continúa limitado a `public`. No hay referencias Prisma
a Coupon, Campaign o Redemption porque esos modelos todavía no existen.

### Modelo y validaciones

`Reward` pertenece a Restaurant, sin `locationId` directo. Sus importes y
porcentajes usan `Decimal(12,2)`; moneda `char(3)`, referencia de producto
`varchar(100)`, condiciones/descripción `text` y fechas `timestamptz(6)`.
`RewardLocation` sólo contiene `(rewardId, locationId)`, PK compuesta y dos FK.
`RewardRule` obtiene restaurante y alcance mediante Reward; no los duplica.

Las restricciones SQL complementarias implementan:

- Porcentaje: valor no nulo en `(0,100]` y moneda nula. Descuento fijo: valor
  positivo y moneda obligatoria. Se excluye `NaN` y el formato de moneda exige
  tres letras mayúsculas; no se agregó un catálogo ISO de monedas.
- FREE_ITEM requiere referencia no vacía ni sólo espacios; CUSTOM requiere
  términos explícitos. Los demás campos opcionales conservan la opcionalidad
  del documento; guardar un tipo de descuento no calcula ni aplica descuentos.
- `validDaysAfterIssue` es nulo o positivo, coherente con el requisito futuro
  `Coupon.expiresAt > issuedAt`. No se calcula vencimiento de cupones en esta fase.
- Toda ventana de Reward/RewardRule con ambos extremos exige `endsAt > startsAt`.
  Ambos extremos son opcionales; no se presupone una ventana cerrada.
- `VISIT_COUNT` y `GTE` son los únicos valores de sus enums. `threshold` es integer
  positivo; `windowDays` es smallint positivo o NULL; `minVisitSpacingHours` es
  smallint no negativo; `maxAwardsPerUser` es smallint igual a 1. Son datos de
  configuración, no un motor de evaluación ni una garantía de emisión única aún.

`minVisitSpacingHours` **no es** `CHECK_IN_WINDOW_MS`: la ventana operativa sigue
siendo cuatro horas desde `Visit.checkedInAt`, por usuario y sucursal. No depende
de `SushiSession.endedAt`. Se conservan `CHECK_IN_COOLDOWN`, la recuperación del
conteo y la confirmación de “Sesión terminada” sólo con COMPLETED confirmado.

### Alcance e integridad entre tablas

Cero selecciones cubre todas las sucursales actuales y futuras del restaurante.
Con selecciones se usa exactamente ese conjunto. Archivar una sucursal conserva
sus asociaciones. Eliminar la última fila es una ampliación deliberada de alcance;
no hay cascadas ni limpieza automática. Para suspender se cambia el estado del
beneficio. TRUNCATE del puente se rechaza: el cambio debe ser un DELETE explícito,
acotado y transaccional del futuro servicio autorizado.

El trigger de asociaciones serializa INSERT/UPDATE/DELETE mediante una escritura
de `updatedAt` en sus propietarios, bloqueando los UUID en orden. Dos constraint
triggers diferidos comprueban el estado final de Reward y RewardLocation al COMMIT,
incluidos ambos extremos de un cambio de asociación y un cambio de restaurante
en Reward. La reasignación de RestaurantLocation ya está impedida por Fase 1;
su trigger no fue modificado. Las FK usan RESTRICT para proteger referencias.

Los futuros servicios que cambien varios beneficios deben bloquear primero los
propietarios en orden y luego sus asociaciones. Ante 40001/40P01 se reintenta la
transacción completa. La escritura del propietario también evita validaciones
con una fotografía obsoleta bajo REPEATABLE READ. Se probaron ambos órdenes de
una carrera entre selección y cambio de restaurante, además de ese aislamiento.

### Migración y seguridad

Migración nueva: `prisma/migrations/20261001060000_phase_6a_rewards_and_rules/migration.sql`.
Parte de un diff local entre los esquemas Prisma anterior/nuevo, calificado con
`public`, más SQL complementario. Contiene BEGIN/COMMIT para aplicación atómica.
Agrega tres tablas, cuatro enums, tres PK, cuatro FK RESTRICT, diez CHECK y seis
índices totales (tres de PK y tres de consulta, sin duplicarlos).

Las tablas tienen RLS habilitado sin políticas de cliente; además se revocan sus
permisos a PUBLIC, `anon` y `authenticated`. Las tres funciones nuevas usan
SECURITY INVOKER y `search_path=pg_catalog`, sin EXECUTE para clientes. Los futuros
servicios NestJS serán responsables de autorización y escrituras de negocio,
como los módulos actuales. Ver la [guía de RLS de Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security).

El SQL fue revisado y probado dentro de una transacción con ROLLBACK antes de
aplicarse mediante `scripts/migrate-development.mjs deploy`, que comprueba el
destino `sushi-session-dev`. No se usaron db push/reset ni se alteraron auth,
storage, migraciones anteriores, `.env` o versiones de dependencias.

Se compararon conteos y huellas de las nueve tablas existentes antes/después y
los checksums del historial: se conservaron datos y migraciones, incluido el
restaurante de prueba con sus visitas/sesiones. El historial Prisma está al día.
El catálogo PostgreSQL verifica tipos, columnas, PK/FK, índices, CHECK, triggers,
RLS y permisos. `prisma migrate diff` global no pudo introspectar la FK controlada
`public.users -> auth.users` (P4002); no se añadió `auth` al datasource para evitar
ese error y no se presenta ese comando como aprobado.

El advisor de Supabase sólo agregó el aviso informativo esperado de RLS sin
políticas en las tres tablas nuevas. Persisten los avisos previos sobre
`rls_auto_enable()` y protección de contraseñas filtradas; esta fase no modifica
esa función ni la configuración de Auth.

### Pruebas y verificaciones

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm typecheck:api
pnpm lint:api
pnpm build:api
pnpm test:api:rewards
pnpm test:api:persistence
pnpm test:api:visits
pnpm test:api:merchant
pnpm test:api:auth
pnpm test:api:config
pnpm test:api:dev-qr
pnpm test:mobile
pnpm test:dashboard
pnpm db:status
```

`test/rewards-persistence.integration.test.mjs` comprueba catálogo, valores válidos
e inválidos, duplicados, pertenencia en inserciones/cambios, eliminación/archivo,
vigencias, límites numéricos, permisos reales, Prisma Decimal y concurrencia.
Los escenarios principales usan SAVEPOINT y ROLLBACK; las pruebas concurrentes
crean dos restaurantes temporales con UUID propios y eliminan sólo esos fixtures.
El modo opcional `REWARD_SCHEMA_PREVIEW=1` sirvió antes de migrar para ensayar el
SQL con rollback; exige que `public.rewards` aún no exista. No usarlo tras aplicar.

Resultado de esta fase: 83 pruebas nuevas y 174 de regresión de API aprobadas,
24 móviles y 7 del dashboard. También se ejecutó el cliente móvil contra Supabase
Auth/NestJS/PostgreSQL reales: recuperó visitas sin sesión, ACTIVE y COMPLETED,
confirmó un cierre cuya respuesta se perdió y mantuvo Visit PENDING. Prisma
validate/generate, TypeScript, lint y build de API aprobados. Las regresiones incluyen `/health`, `/me`, aislamiento comercial,
verificación de visitas, idempotencia, cierre y bloqueo de cuatro horas.

Las verificaciones de Fase 6A fueron locales. El workflow CI incorporado después
ejecuta sólo las pruebas aisladas descritas abajo; estos resultados de PostgreSQL
no se atribuyen a GitHub Actions.

### Pendientes deliberados

No están implementados RewardEvaluationService, emisión de premios, puntos,
Coupon y sus orígenes, Campaign, Redemption, endpoints de gestión ni pantallas.
La futura evaluación deberá contar únicamente visitas VERIFIED, ordenar por
`checkedInAt` e `id`, aplicar ventana/espaciado y emitir de forma idempotente.
`pieceCount` no es criterio de recompensa.

También queda pendiente congelar condiciones, FK y selecciones de Reward,
RewardRule y Campaign después de la primera emisión, respaldado por los futuros
orígenes de Coupon. Hoy no existe esa inmutabilidad ligada a emisión. El posterior
desarrollo deberá impedir que una edición o eliminación de asociaciones cambie
lo prometido en cupones emitidos, capturar snapshots y resolver expiración/canje.
Pausar una definición no equivaldrá a revocar cupones.

No hay fórmulas de descuento grupal ni distribución aprobada por importe promedio
por comensal. La Fase 6A se detiene en persistencia validada, sin avanzar a emisión
o canje.

## Pruebas aisladas para CI

```powershell
pnpm test:api:unit
```

Compila la API y ejecuta explícitamente `environment.test.mjs`, `auth-jwt.test.mjs`,
`auth-http.test.mjs` y `dev-qr.unit.test.mjs`. No requiere PostgreSQL ni Supabase:
Auth/JWKS se simulan, Prisma se sustituye en memoria y el servidor HTTP de prueba
escucha sólo en loopback. La prueba del guard QR usa configuración ficticia y
valida opciones sin crear un cliente ni conectarse.

Las dos pruebas unitarias del QR fueron extraídas de `dev-qr.integration.test.mjs`.
`pnpm test:api:dev-qr` sigue ejecutando ambos archivos, preservando las pruebas
unitarias y la integración real. Los scripts `test:config` y `test:auth` también
siguen disponibles por separado.

Persistencia, visitas, membresías, rewards, QR real y los runners `:live` permanecen
como integración local contra el entorno autorizado; no se ejecutan en CI. No se
agregaron condiciones para omitir silenciosamente esos tests si faltan credenciales.
El workflow no invoca migraciones ni pruebas que importen AppModule para conectarse
a una base real. Detalles, valores ficticios y primera ejecución remota pendiente:
[CI en el README raíz](../../README.md#ci-con-github-actions).

## Referencias

- [NestJS: configuración](https://docs.nestjs.com/techniques/configuration)
- [Prisma 7: schemas PostgreSQL](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/multi-schema)
- [Supabase: conexiones PostgreSQL](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase: certificados SSL](https://supabase.com/docs/guides/platform/ssl-enforcement)
- [Prisma: SQL adicional en migraciones](https://docs.prisma.io/docs/orm/prisma-migrate/workflows/unsupported-database-features)
- [PostgreSQL 17: constraint triggers](https://www.postgresql.org/docs/17/sql-createtrigger.html)
- [PostgreSQL 17: aislamiento de transacciones](https://www.postgresql.org/docs/17/transaction-iso.html)
- [Supabase: JWT y verificación con JWKS](https://supabase.com/docs/guides/auth/jwts)
- [Supabase: identidad actual mediante getUser](https://supabase.com/docs/reference/javascript/auth-getuser)
- [Supabase: sesiones](https://supabase.com/docs/guides/auth/sessions)
