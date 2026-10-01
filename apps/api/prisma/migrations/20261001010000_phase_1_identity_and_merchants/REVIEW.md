# Revisión de Fase 1

Contrato: `Modelo_de_datos_MVP_Sushi_Counter_v1.1_Normalizado.docx`, versión 1.1,
30 de septiembre de 2026. SHA256 del documento:
`9fb2d64346801dfe0904ea58edcb3a114b7c81bc52da3ce3213f54c1bd10e715`.

SQL revisado y aplicado, SHA256:
`0f8ad7de71ab884f1508507172c8b4fdf932d4ccb750d4788a3d53f3844dfdc5`.

## Antes de aplicar

- Destino comprobado con Supabase: `sushi-session-dev`, referencia
  `qmlwqrfnfjphvgzjfnly`, PostgreSQL 17; `public` vacío, sin migraciones anteriores.
- DDL base generado con Prisma 7.10, `migrate diff --from-empty --to-schema
  prisma/schema.prisma --script`, sin shadow DB, reset ni db push.
- Inspección del SQL completo: cinco CREATE TABLE y seis CREATE TYPE en `public`;
  ningún DROP ni borrado de datos. Todas las tablas y funciones están calificadas.
- Una sola referencia externa, `REFERENCES auth.users(id)`, desde ALTER TABLE sobre
  `public.users`. Ningún DDL dirigido a `auth`, `storage` u otros schemas.
- CHECK de aceptación, triggers de alcance diferidos, bloqueo de propietarios,
  inmutabilidad de pertenencias, RESTRICT y protección frente a TRUNCATE incluidos.
- RLS sin políticas de cliente; funciones invoker con ruta fija y EXECUTE restringido.
- Ejecución completa sobre desarrollo con COMMIT sustituido por ROLLBACK: válida,
  sin objetos persistidos. Luego aplicación del mismo SQL por `prisma migrate deploy`.

## Decisiones de implementación

- `User.id` no tiene default y recibe la identidad de Auth. Su FK es inmediata por
  defecto, diferible explícitamente y con acciones RESTRICT. Las pruebas la difieren
  para trabajar con fixtures sin crear usuarios Auth, y siempre revierten.
- Los otros UUID siguen `@default(uuid())` del contrato; los provee Prisma.
- Congelar `RestaurantLocation.restaurantId` desde el alta implementa la pertenencia
  estable indicada en la sección 10. Una reasignación requiere otra sucursal.
- Los cambios de asociaciones actualizan la fila propietaria además de bloquearla:
  esto evita validar un snapshot antiguo en REPEATABLE READ. Los futuros servicios
  deben bloquear primero todos los propietarios en orden estable y reintentar
  abortos de serialización/deadlock.
- No se inventa un CHECK para el contexto del invitador: el contrato asigna esa
  autorización al servicio y no incorpora una columna de origen de la invitación.
- No se agregan restricciones geográficas/temporales no especificadas en esta fase.

## Verificación posterior

Se contrastaron los atributos, tipos y nulabilidad con el diccionario v1.1 y el
catálogo real: cinco PK, siete FK validadas, tres UNIQUE, dos índices de consulta,
un CHECK y dos constraint triggers diferidos, además de los triggers auxiliares.
Las pruebas negativas y positivas de SQL se ejecutaron con rollback, y los cinco
modelos se ejercitaron desde NestJS/Prisma con relaciones anidadas y rollback.
`GET /health` devuelve HTTP 200; validación/generación Prisma, compilación, TypeScript,
lint y las pruebas existentes pasan. No hay modelos ni endpoints de fases posteriores.

El detalle y los comandos reproducibles están en `apps/api/README.md`.
