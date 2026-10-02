# Sushi Session

Monorepo con pnpm workspaces. La carpeta actual es la raíz del proyecto y contiene
un único repositorio Git y un único `pnpm-lock.yaml`.

## Estado

La app móvil está creada con Expo SDK 57, React Native 0.86.3, React 19.2.3,
TypeScript estricto y Expo Router. La Fase 4 integra login email/password con
Supabase Auth, restauración segura de sesión, rutas protegidas, cámara QR,
check-in, contador sincronizado y un historial real consumiendo NestJS.

La API en `apps/api` está creada con NestJS 12 y TypeScript estricto. Expone
`GET /health` en el puerto 3001. `apps/dashboard` contiene el panel comercial Next.js.
`packages/shared` conserva su manifiesto vacío. La API usa Prisma 7.10.0 para
conectarse al PostgreSQL de desarrollo de Supabase con TLS verificado. Prisma está
limitado al schema `public`. La primera migración del contrato v1.1 ya incorpora
usuarios, restaurantes, sucursales, membresías y su selección de sucursales.
La Fase 2 incorpora Supabase Auth: JWT verificados en NestJS, perfiles vinculados con
el mismo UUID y `GET /me` protegido. Todavía no hay endpoints para crear o administrar
restaurantes, sucursales o membresías.
La Fase 3 agrega check-in QR idempotente, visitas y sesiones de conteo independientes,
con control de versión y endpoints autenticados. La ventana de deduplicación del
piloto es de 4 horas por usuario y sucursal. El conteo no verifica visitas ni otorga premios.

La Fase 5 incorpora autorización comercial por membresía y sucursal, consulta de
visitas y confirmación/rechazo desde un dashboard mínimo Next.js + TypeScript.
`OWNER`, `ADMIN`, `MANAGER` y `STAFF` pueden resolver visitas; `ANALYST` sólo consulta.
Se utilizan los modelos existentes: no hubo nuevas migraciones ni cambios en Auth,
Storage, rewards, campañas o cupones.

La Fase 6A agrega únicamente persistencia para `Reward`, `RewardLocation` y
`RewardRule`, con restricciones SQL y RLS. No hay evaluación, emisión, canje,
cálculo de descuentos ni nuevas pantallas de beneficios. Las tres migraciones
están aplicadas en `sushi-session-dev`; el contador y su recuperación conservan
el comportamiento ya implementado.

## Estructura

```text
apps/
  mobile/
    assets/              # Iconos originales de la plantilla
    src/app/             # Login, Home, scanner, session/[id] e historial
    src/auth/            # AuthProvider y renovación de sesión
    src/core/            # Cliente HTTP, contratos, QR, contador y storage testeables
    src/lib/             # Entorno público, Supabase y adaptadores Expo
    src/sessions/        # Borradores en memoria, separados por usuario
    src/components/      # Controles compartidos
    test/                # Pruebas unitarias y cliente móvil contra API real
    .env.example         # Solo URL de Supabase, publishable key y URL de API
    .gitignore
    app.json             # Expo, Router y referencia al proyecto EAS
    package.json         # @sushi-session/mobile y sus dependencias
    tsconfig.json        # TypeScript estricto y alias @/* -> src/*
    LICENSE              # Licencia incluida en la plantilla oficial
  api/
    src/
      main.ts            # Arranque del servidor (PORT o 3001)
      app.module.ts      # Módulo raíz
      health.controller.ts # GET /health
      config/environment.ts # Carga y validación de variables de entorno
      prisma/             # PrismaModule, PrismaService y comprobación SELECT 1
      auth/               # AuthGuard, CurrentUser, AuthProfileService y GET /me
      visits/             # CheckInService, SushiSessionService y sus endpoints
      merchant/           # Autorización por alcance y revisión de visitas
    prisma/schema.prisma  # Doce modelos y dieciséis enums (Fases 1, 3 y 6A), solo public
    prisma/migrations/    # Historial Prisma con integridad SQL adicional
    scripts/              # Migración y verificación limitadas a desarrollo
    test/                 # Configuración, catálogo, integridad, Prisma y HTTP
    prisma.config.ts
    .env.example          # Plantilla de configuración sin secretos
    certs/                # Certificado raíz público oficial de Supabase
    nest-cli.json
    tsconfig.json
    tsconfig.build.json
    .oxlintrc.json        # Lint con análisis de tipos
    .prettierrc
    package.json         # @sushi-session/api
    README.md
  dashboard/
    src/app/             # Página y proxy restringido hacia NestJS
    src/components/      # Login, listado, filtros y acciones comerciales
    src/lib/             # Supabase Auth, cliente HTTP y proxy testeable
    test/                # Pruebas del proxy y de sus límites
    .env.example         # Dos valores públicos de Auth y API_URL del servidor
    README.md            # Arranque, arquitectura y prueba manual
packages/
  shared/package.json
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
```

`.expo/`, `expo-env.d.ts` y `node_modules/` se generan localmente y están excluidos
de Git. `work/` contiene archivos temporales de instalación y verificación, también
excluidos. Los dos documentos Word originales permanecen en la raíz.

## Arrancar desde PowerShell

Herramientas verificadas: Node.js 24.17.0, pnpm 11.25.0 y Git 2.51.0.
`.node-version` fija ese mismo Node para CI; `packageManager` en `package.json`
fija pnpm. La instalación usa el `pnpm-lock.yaml` existente sin actualizar versiones.

```powershell
Set-Location -LiteralPath 'C:\Users\lichu\OneDrive\Documents\Personal Projects\Sushi Session'
pnpm install --frozen-lockfile
Copy-Item apps/mobile/.env.example apps/mobile/.env # Solo si todavía no existe
# Completar las tres variables públicas en apps/mobile/.env.
# Iniciar pnpm dev:api en otra terminal antes de usar la app.
pnpm dev:mobile
```

Expo muestra las opciones de apertura y el QR en la terminal. Para probar en un
celular con Expo Go, usar una versión compatible con SDK 57 y conectar el equipo y
el celular a la misma red. En `EXPO_PUBLIC_API_URL`, usar la IP LAN del equipo, no
`localhost`. El arranque en un dispositivo físico está pendiente. Ver la
[guía móvil de Fase 4](apps/mobile/README.md) para configuración, QR y pruebas.

Para abrir la versión web de esta misma app móvil:

```powershell
pnpm dev:mobile:web
```

La vista web sirve como preview de UI/login; su sesión se mantiene solo en memoria.
La API actual no habilita CORS para el navegador: el flujo de negocio soportado en
esta fase es nativo. El dashboard comercial ya está implementado en `apps/dashboard`
y usa su proxy Next.js para comunicarse con NestJS.
Detener el servidor con Ctrl+C.

## Configuración de Expo y EAS

- Nombre visible: `Sushi Session`.
- Slug y esquema de enlaces: `sushi-session-dev`.
- `extra.eas.projectId`: `5a2de9cd-01d4-41f4-ba6f-0327c40b45a9`.
- Entrada de la app: `expo-router/entry`.
- Rutas en `src/app`, con `typedRoutes: true`.
- Plugins: `expo-router`, `expo-status-bar`, `expo-secure-store` y `expo-camera`
  (QR y cámara, sin permiso de micrófono).
- Metro usa el soporte integrado para monorepos de Expo.

La vinculación local apunta al Project ID existente proporcionado por el usuario.
El conector Expo pudo consultar sus builds (lista vacía). La CLI local de EAS no
tiene sesión iniciada; no se ejecutaron builds ni se creó otro proyecto EAS.
Para consultar la identidad remota desde la terminal cuando sea necesario:

```powershell
Set-Location -LiteralPath 'C:\Users\lichu\OneDrive\Documents\Personal Projects\Sushi Session\apps\mobile'
npx eas-cli@latest login
npx eas-cli@latest project:info
```

No hace falta iniciar sesión en EAS para probar la app localmente. La configuración
de perfiles de build (`eas.json`) queda para la etapa de compilación.

## Workspace y dependencias

Los patrones `apps/*` y `packages/*` incluyen cuatro paquetes actuales: la raíz,
`@sushi-session/mobile`, `@sushi-session/api` y `@sushi-session/shared`.
Se conserva el modo aislado de pnpm.

Se fijaron overrides en `pnpm-workspace.yaml` para `react-native-worklets` 0.10.1,
`react-native-reanimated` 4.5.1 y `@react-native/metro-config` 0.86.3: pnpm había
resuelto peers automáticos más nuevos e incompatibles con este SDK. Revisar esos
valores al actualizar Expo/React Native.

Instalar futuros módulos móviles desde la carpeta de la app usando `pnpm exec expo
install <paquete>` para seleccionar versiones compatibles con el SDK.

## Verificación

Desde la raíz:

```powershell
pnpm typecheck:mobile
pnpm test:mobile
pnpm test:mobile:live # Opcional: entorno de desarrollo y usuario de prueba configurados
pnpm peers check
pnpm --filter @sushi-session/mobile exec expo install --check
pnpm --filter @sushi-session/mobile exec expo export --platform all --output-dir ../../work/mobile-export
pnpm workspace:list
```

En Fase 4 se verificaron TypeScript, compatibilidad de dependencias, empaquetado
JavaScript/Hermes para Android e iOS y exportación web. Se verificó el render del
login y su validación de campos vacíos en el navegador integrado. Las pruebas
automatizadas cubren sincronización, conflictos, errores, refresh y storage.
El cliente móvil se probó además contra Supabase Auth, NestJS y PostgreSQL reales:
login, QR, check-in/reintento, sesión, conteo, 409, refresh, cierre e historiales.
Esto no sustituye cámara, SecureStore y restauración en un celular ni constituye
una compilación APK/IPA. El diagnóstico `expo-doctor` de la etapa inicial pasó
21 comprobaciones; no se presenta como una nueva prueba de dispositivo.

## Punto de revisión

La etapa actual termina en Fase 6A: app móvil y dashboard comercial implementados,
verificación de visitas disponible y persistencia de beneficios/reglas preparada.
Quedan pendientes evaluación y emisión de beneficios, campañas, cupones y canje.
Las pruebas automatizadas no sustituyen la aceptación física en un teléfono.
La arquitectura, los contratos HTTP y las pruebas están en [apps/api/README.md](apps/api/README.md).

## API NestJS desde PowerShell

Desde la raíz, iniciar el servidor con recarga automática:

```powershell
pnpm dev:api
```

En otra terminal, comprobar la respuesta HTTP 200 con JSON `{"status":"ok"}`:

```powershell
Invoke-RestMethod -Uri 'http://localhost:3001/health'
```

La API escucha en `0.0.0.0` para aceptar conexiones IPv4 de la red local. Para
probar desde un iPhone conectado al mismo router, obtener la IPv4 de la PC con
`ipconfig` y abrir `http://IP_LAN_DE_LA_PC:3001/health` en Safari mientras la API está
encendida. Usar el puerto configurado en `PORT` si difiere de 3001. Ver los pasos y
la resolución de problemas en [la guía LAN de la API](apps/api/README.md#acceso-desde-un-iphone-u-otro-dispositivo-de-la-lan).

Para revisar el código y ejecutar la versión compilada:

```powershell
pnpm typecheck:api
pnpm lint:api
pnpm build:api
pnpm start:api
```

Detener el servidor con Ctrl+C antes de iniciar otro en el mismo puerto.
`start:api` necesita una compilación previa. La variable de entorno `PORT` permite
cambiar el puerto predeterminado. La API carga `apps/api/.env`, excluido de Git.
Usar `.env.example` como plantilla en nuevas instalaciones y completar la URL de
PostgreSQL, `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY` localmente. No sobrescribir
el `.env` existente. NestJS usa claves públicas para verificar JWT: no requiere
secret key ni service role de Supabase.

Para comprobar Prisma y la conexión real, desde la raíz:

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm test:api:config
pnpm test:api:auth
pnpm test:api:persistence
pnpm test:api:visits
pnpm db:check
pnpm db:status
```

`db:check` ejecuta solo `SELECT 1` desde el contexto NestJS y cierra el pool.
Prisma administra únicamente `public`; `auth` y `storage` permanecen bajo Supabase.
Más detalles en `apps/api/README.md`.

Las migraciones revisadas se aplican con `pnpm db:migrate:dev`. Este comando verifica
que la conexión corresponda exclusivamente al proyecto de desarrollo; no usa `db push`.
Las migraciones de Fase 1, Fase 3 y Fase 6A ya están aplicadas; volver a ejecutarlo no recrea las tablas.

Para repetir la prueba de login real y `GET /me`, completar el archivo local
`apps/api/.env.auth-test` (ignorado por Git) según su plantilla y ejecutar:

```powershell
pnpm test:api:auth:live
pnpm test:api:visits:live
```

Este script solo trabaja con `sushi-session-dev`, conserva el perfil provisionado
y cierra la sesión y el servidor de prueba. La API no carga las credenciales de ese
archivo. La prueba de visitas crea un restaurante temporal y limpia solo sus códigos,
visitas y sesiones al terminar. No se agregaron variables privadas ni secret keys a Expo.

## Dashboard comercial (Fase 5)

En dos terminales PowerShell, desde esta raíz:

```powershell
pnpm dev:api
```

```powershell
pnpm dev:dashboard
```

Abrir `http://localhost:3000`. La configuración local ya está preparada en
`apps/dashboard/.env.local`, excluido de Git. Para una nueva instalación, usar su
`.env.example`; nunca copiar el `.env` completo de la API al dashboard.

El login usa el mismo Supabase Auth. Para consultar o resolver visitas, la cuenta
necesita una membresía comercial `ACTIVE` en un restaurante activo, con alcance
válido a sucursales activas. Iniciar sesión no concede ese permiso. Las membresías
temporales utilizadas en las pruebas se eliminan al finalizar; esta fase no incluye
una pantalla para invitar miembros o administrar restaurantes.

```powershell
pnpm test:api:merchant
pnpm test:dashboard
pnpm typecheck:dashboard
pnpm lint:dashboard
pnpm build:dashboard
```

Ver [la guía del dashboard](apps/dashboard/README.md) y
[el contrato comercial de la API](apps/api/README.md#fase-5-autorización-comercial-y-revisión-de-visitas).

## QR de desarrollo para probar el flujo completo

Desde esta raíz, con Node.js 24 y las dependencias instaladas:

```powershell
pnpm dev:qr
```

Genera `work/dev-checkin-qr.png` para **Sushi Session Test → Local de prueba**.
Cada ejecución revoca los códigos anteriores `DEV_TEST_QR` de esa sucursal, crea
uno nuevo y reemplaza el PNG. El token sólo se conserva en el QR local; PostgreSQL
guarda su SHA-256. `work/` está ignorado por Git y la herramienta comprueba esa exclusión.
El comando sólo funciona contra `sushi-session-dev` y no crea migraciones.

Para habilitar también el dashboard, elegir explícitamente un UUID existente de
`public.users` (el mismo UUID de Supabase Auth):

```powershell
pnpm dev:qr --owner-user-id '<UUID_DE_PUBLIC_USERS>'
```

Esa opción asigna OWNER + ACTIVE + ALL_LOCATIONS **sólo al restaurante de prueba**.
Sin la opción no se asignan ni cambian membresías; una asignación anterior permanece.

Abrir el PNG en la PC con `Invoke-Item .\work\dev-checkin-qr.png`, iniciar API/mobile/
dashboard y escanear desde **Escanear QR de la sucursal** en la app del iPhone.
El flujo es: **QR → Visit PENDING → Sushi Session → dashboard → Confirmar → VERIFIED**.
El conteo o completar SushiSession no verifican la visita. La ventana de cuatro horas
sigue vigente: regenerar el QR no habilita otra visita del mismo usuario a esa sucursal.

Más detalles y pruebas: [guía dev:qr de la API](apps/api/README.md#herramienta-devqr).

## Confirmación de cierre y check-in reciente

El móvil muestra **Sesión terminada** y el total de piezas sólo cuando NestJS
confirma `COMPLETED`, también al recuperar una respuesta perdida. El resultado
es de sólo lectura y ofrece historial/inicio.

El bloqueo de cuatro horas tiene el código `CHECK_IN_COOLDOWN`. El scanner
explica la espera y consulta la sesión de esa visita para ofrecer **Continuar
conteo** o **Ver resultado**; si todavía no tiene sesión, permite recuperarla.
La ventana permanece anclada a `Visit.checkedInAt`, por usuario y sucursal,
independientemente de la finalización. No cambian la verificación de visitas,
la idempotencia, el modelo de datos ni las recompensas; no hay descuentos.

Pruebas: `pnpm test:mobile`, `pnpm test:api:visits` y, con la configuración de
desarrollo existente, `pnpm test:mobile:live`. Detalles y prueba manual en
[la guía móvil](apps/mobile/README.md#sincronización-del-contador).

## Beneficios y reglas: persistencia de Fase 6A

- `Reward` pertenece al restaurante y guarda tipo, valor `Decimal(12,2)`, moneda,
  condiciones y vigencia. No tiene una sucursal directa.
- `RewardLocation` selecciona sucursales mediante PK compuesta. Cero filas significa
  todas las sucursales del restaurante, incluidas las futuras. Archivar una sucursal
  conserva sus asociaciones; borrar la última es un cambio explícito de alcance.
- `RewardRule` hereda restaurante/alcance de Reward. Sólo admite `VISIT_COUNT`,
  `GTE`, umbral entero positivo y `maxAwardsPerUser = 1`. Sus parámetros no cambian
  la ventana operativa de check-in de cuatro horas.

La migración `20261001060000_phase_6a_rewards_and_rules` es aditiva y sólo opera
sobre `public`. Las tablas nuevas tienen RLS, sin políticas ni permisos para
clientes directos. No hay endpoints nuevos. Se preservaron los datos existentes
y el historial de migraciones; las dependencias y archivos `.env` no cambiaron.

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm typecheck:api
pnpm lint:api
pnpm build:api
pnpm test:api:rewards
pnpm db:status
```

Contrato, restricciones, pruebas y pendientes:
[Fase 6A en la guía de la API](apps/api/README.md#fase-6a-persistencia-de-beneficios-y-reglas).
Las comprobaciones de Fase 6A se ejecutaron localmente y contra desarrollo. El
workflow agregado posteriormente se describe abajo y excluye esas conexiones.

## CI con GitHub Actions

`.github/workflows/ci.yml` define **CI / Monorepo checks** para pushes a `main` y
pull requests cuyo destino es `main`. Corre en Ubuntu 24.04 con Node 24.17.0 y pnpm
11.25.0. Las acciones oficiales están fijadas por SHA y la instalación ejecuta
`pnpm install --frozen-lockfile`; un lockfile desactualizado hace fallar el job.

El workflow realiza estas comprobaciones, sin `continue-on-error`:

| Comprobación | Comandos |
| --- | --- |
| Prisma, sin conexión a PostgreSQL | `pnpm prisma:validate`, `pnpm prisma:generate` |
| TypeScript | `pnpm typecheck:api`, `pnpm typecheck:dashboard`, `pnpm typecheck:mobile` |
| Lint disponible | `pnpm lint:api`, `pnpm lint:dashboard` |
| Compilación API y pruebas aisladas | `pnpm test:api:unit` (incluye build de API) |
| Unitarias móviles y dashboard | `pnpm test:mobile`, `pnpm test:dashboard` |
| Compilación dashboard | `pnpm build:dashboard` |
| Compatibilidad Expo | `pnpm check:mobile:dependencies` (`expo install --check`) |
| Exportación Expo iOS/Android/web | `pnpm export:mobile:ci` |

Mobile y `packages/shared` no tienen scripts propios de lint actualmente. No se
agrega un linter nuevo ni se presenta TypeScript como sustituto de esas revisiones.
La exportación sólo genera JavaScript/Hermes/assets en `work/mobile-ci-export`,
ignorado por Git. No genera APK/IPA/AAB, no usa EAS ni publica artefactos.

**Pruebas incluidas:** configuración de la API, JWT con claves sintéticas y Auth
simulado, HTTP NestJS en loopback con Prisma en memoria, argumentos/guard de la
herramienta QR, lógica del cliente móvil y proxy del dashboard con transporte
simulado. `test:api:unit` enumera sus archivos; no usa un glob que pueda incorporar
accidentalmente `*.integration.test.mjs`.

Las dos pruebas unitarias que estaban junto a la integración QR se trasladaron a
`apps/api/test/dev-qr.unit.test.mjs`. El guard se verifica con una contraseña
ficticia y sin abrir conexiones. `pnpm test:api:dev-qr` conserva ambas partes:
ejecuta ese archivo junto con las pruebas reales de PostgreSQL. No se eliminó ninguna
comprobación ni se omiten fallos mediante detección silenciosa de credenciales.

**Integración local, fuera de CI:** `test:api:persistence`, `test:api:visits`,
`test:api:merchant`, `test:api:rewards`, `test:api:dev-qr`, `test:api:auth:live`,
`test:api:visits:live` y `test:mobile:live`. Requieren la configuración local de
desarrollo y siguen disponibles. CI no ejecuta estos comandos ni `db:check`,
`db:status`, migraciones, seeds o despliegues; no dispone de una base de datos.

### Variables y permisos

No se necesitan secretos de GitHub ni credenciales de Supabase/Expo. El job define
valores ficticios en el YAML, una URL PostgreSQL con host `database.invalid` y una
API `api.invalid`. La URL/key públicas de ejemplo sólo satisfacen el formato de
configuración; los tests de Auth inyectan su transporte simulado y las compilaciones
no inician login ni consultas de negocio. `EXPO_NO_DOTENV=1` impide cargar archivos
locales de Expo. Los `.env` siguen ignorados y un paso falla si se detectan `.env`
versionados que no sean ejemplos. No se muestran ni se cargan secretos de Actions.

Se concede únicamente `contents: read`; checkout no conserva credenciales Git.
No hay `pull_request_target`, permisos de escritura, publicación ni migraciones.
Sólo se cachea el almacén de dependencias de pnpm. Las ejecuciones anteriores de
la misma rama/PR se cancelan cuando llega una nueva; el job tiene límite de 30 min.

### Cómo comprobarlo en GitHub

1. Incluir el workflow y sus archivos relacionados en un commit y subirlo a `main`,
   o subir una rama y abrir un PR dirigido a `main`.
2. Abrir [Actions del repositorio](https://github.com/Lichu14/sushi-session/actions),
   elegir **CI** y verificar que la ejecución corresponda al SHA enviado.
3. Revisar **Monorepo checks** y cada paso; en un PR también aparece en **Checks**.
   Un fallo de instalación, tipos, lint, pruebas o compilación debe dejarlo en rojo.

Verificado localmente en Windows: actionlint, instalación con lockfile congelado,
Prisma validate/generate, los tres chequeos TypeScript, ambos lints, build de API y
dashboard, compatibilidad Expo y exportación iOS/Android/web. Pasaron **43 pruebas
aisladas de API, 24 de mobile y 7 de dashboard**, sin fallos ni pruebas omitidas.
Se usaron las variables ficticias del workflow y no se ejecutó integración contra
Supabase. La verificación local no equivale a una ejecución del runner Ubuntu.
Todavía no se ejecutó este workflow en GitHub Actions; su primer resultado remoto
queda pendiente de subir el commit. No se configuró protección de rama ni despliegue.

## Referencias

- [pnpm workspaces](https://pnpm.io/workspaces)
- [Expo: monorepos](https://docs.expo.dev/guides/monorepos/)
- [Instalación de Expo Router](https://docs.expo.dev/router/installation/)
- [Expo Router para SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/router/)
- [NestJS: primeros pasos](https://docs.nestjs.com/first-steps)
