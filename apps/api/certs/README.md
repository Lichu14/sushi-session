# Certificado raíz público de Supabase

`supabase-ca.crt` es el certificado público Supabase Root 2021 CA, descargado del
enlace utilizado por el dashboard oficial. No contiene claves privadas ni credenciales.

- Fuente: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
- URL comprobada en: https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json
- Vencimiento: 26 de abril de 2031.
- SHA-256: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.

El adaptador PostgreSQL verifica el certificado y el nombre del servidor con
`rejectUnauthorized: true`. Si Supabase cambia su CA, reemplazar este certificado
usando la descarga oficial y volver a comprobar la conexión.
