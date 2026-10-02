# Dashboard comercial — Fase 5

Next.js 16.3.8 + React 19.2.3 + TypeScript, paquete `@sushi-session/dashboard` del
monorepo pnpm. Interfaz mínima para login, consulta y resolución de visitas.

## Arranque en PowerShell

Desde la raíz del monorepo, iniciar la API en una terminal y el dashboard en otra:

```powershell
pnpm dev:api
```

```powershell
pnpm dev:dashboard
```

Abrir `http://localhost:3000`. Desde otro dispositivo de la LAN:
`http://IP_LAN_DE_LA_PC:3000`. El navegador se comunica con el mismo origen del panel;
la conexión con NestJS se realiza desde el servidor Next.js.

En esta instalación `.env.local` ya contiene los valores públicos del mismo proyecto
Supabase de mobile/API y `API_URL=http://127.0.0.1:3001`. Está ignorado por Git.
Para una instalación nueva, crear el archivo sin sobrescribir uno existente:

```powershell
Copy-Item apps/dashboard/.env.example apps/dashboard/.env.local
```

Completar sólo:

| Variable | Uso |
| --- | --- |
| NEXT_PUBLIC_SUPABASE_URL | URL HTTPS del proyecto Supabase |
| NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY | Clave pública publishable del mismo proyecto |
| API_URL | Origen fijo de NestJS, sólo en el servidor Next.js |

Los valores `NEXT_PUBLIC_*` se incorporan al bundle: reiniciar desarrollo o recompilar
si cambian. No copiar DATABASE_URL, contraseña PostgreSQL, secret/service-role keys
ni las credenciales del usuario de prueba a este archivo.

## Cuenta y permisos

Usar una cuenta existente de Supabase Auth con membresía comercial `ACTIVE` en un
restaurante activo y alcance a sucursales activas. La cuenta de consumidor no recibe
permisos comerciales automáticamente. No hay registro público, invitaciones ni
gestión de membresías en esta fase. La asignación inicial se administra de forma
controlada en desarrollo respetando las restricciones de Fase 1.

OWNER, ADMIN, MANAGER y STAFF pueden confirmar/rechazar dentro de su alcance.
ANALYST sólo consulta. La lista de sucursales y `canReview` provienen de NestJS;
ocultar botones ayuda a la interfaz, pero la API vuelve a comprobar cada permiso.
Una cuenta sin membresía obtiene un error explícito; no equivale a un listado vacío.

## Arquitectura

1. Supabase JS autentica email/contraseña directamente con Auth; las tablas de negocio
   no se consultan ni escriben mediante Supabase desde el navegador.
2. La sesión vive en `sessionStorage` de la pestaña. Se restaura al recargar, se renueva
   con Auth y se elimina al cerrar sesión. El cierre es local a esa sesión Auth.
3. El navegador envía Bearer al proxy `/api/merchant/...` del mismo origen.
4. El Route Handler reenvía únicamente las cuatro operaciones comerciales a `API_URL`.
   No acepta destinos del cliente, cookies, IDs de actor ni permisos adicionales.
5. NestJS valida Auth, membresía, rol, sucursal y estado, y persiste la decisión.

No se cambió CORS en la API. Proxy y respuestas comerciales usan `no-store`, timeout
de 15 segundos y errores de conexión legibles. El proxy limita JSON a 4 KiB, rechaza
consultas desconocidas/duplicadas y no sigue redirecciones del upstream.
Una respuesta 401 permite una sola renovación/repetición, conservando el mismo UUID.
La UI limpia los datos al cambiar de identidad e ignora respuestas de filtros viejos.

El listado arranca en PENDING y admite filtros de sucursal/estado y paginación de 20.
Confirmar fija VERIFIED; rechazar abre un formulario de motivo obligatorio, hasta
300 caracteres. Durante una acción se bloquean los controles para evitar doble envío.
Un fallo de red conserva el motivo para reintentar la misma operación; NestJS garantiza
la idempotencia. Una decisión incompatible devuelve 409 y exige actualizar el listado.

## Archivos

```text
src/app/layout.tsx, page.tsx, globals.css  # Entrada y estilos funcionales
src/components/merchant-dashboard.tsx    # Login, listado, filtros y decisiones
src/app/api/merchant/[...path]/route.ts   # Proxy Next.js con runtime Node
src/lib/merchant-proxy.ts                # Allowlist y reenvío limitado a NestJS
src/lib/merchant-api.ts                  # Cliente HTTP y contratos de respuestas
src/lib/supabase.ts                      # Cliente público exclusivo para Auth
test/merchant-proxy.test.mjs             # Siete tests de proxy y límites
.env.example                            # Plantilla sin secretos
next.config.ts, tsconfig.json            # Next.js y TypeScript estricto
eslint.config.mjs, package.json          # Lint, scripts y dependencias fijadas
AGENTS.md, CLAUDE.md                     # Guías generadas por Next.js al iniciar
```

## Verificación

Desde PowerShell en la raíz:

```powershell
pnpm test:dashboard
pnpm typecheck:dashboard
pnpm lint:dashboard
pnpm build:dashboard
pnpm start:dashboard
```

Detener `dev:dashboard` antes de `start:dashboard`; ambos usan puerto 3000.
Las pruebas comprueban Auth faltante, rutas/métodos permitidos, rechazo de permisos
y destinos arbitrarios, filtros, Bearer, ausencia de cookies/CORS, no-cache, estados
de error, JSON inválido y límite de tamaño. Las decisiones/permisos se prueban en
la suite PostgreSQL de la API con `pnpm test:api:merchant`.

Prueba manual: iniciar sesión con un miembro autorizado, verificar las sucursales
permitidas, confirmar una visita PENDING, rechazar otra con motivo y consultar los
estados finales. Repetir con ANALYST y membresía SUSPENDED. Comprobar carga, lista
vacía, error si se detiene la API y cierre de sesión. La evidencia QR y SushiSession
deben permanecer intactas. Desde Fase 6B, confirmar una visita también evalúa y
emite cupones RULE en NestJS de forma atómica. La respuesta del dashboard se
conserva; no hay pantallas de beneficios, campañas ni canje en este panel.

Verificación realizada: siete tests del proxy, TypeScript, lint y build aprobados;
navegador con login real, listado y alcance de sucursales, confirmación QR, rechazo
con motivo, estado vacío, filtro de estado, ANALYST, membresía SUSPENDED y logout.
Se comprobó en PostgreSQL que evidencia QR, checkedInAt y SushiSession permanecieran
intactos. No hubo errores JavaScript en el navegador. Se retiraron únicamente los
fixtures temporales; no quedó una membresía comercial permanente para la cuenta
de prueba. La app móvil conservó sus 17 tests y comprobación de tipos aprobados.
