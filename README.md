# Control de bodega Hevequi

Herramienta web para controlar ingresos, estados y salidas de mercancía en bodega con códigos QR.

## Archivos

| Archivo | Qué hace |
| --- | --- |
| `index.html` | Pantallas: ingreso, órdenes, QR, recepción, validación, salida, tablero, historial, usuarios |
| `style.css` | Apariencia para PC y celular (desde 360 px) e impresión de etiquetas de 50 x 25 mm |
| `app.js` | Lógica de la página y generador de QR propio (sin librería) |
| `schema.sql` | Base de datos en Supabase: tablas, permisos por rol, reglas de estado y auditoría |
| `seed_prueba.sql` | Datos ficticios para probar |

Única librería: `supabase-js` 2.117.2.

## Roles

| Rol | Puede |
| --- | --- |
| Coordinador | Usuarios, municipios, órdenes, salida, tablero y auditoría |
| Supervisor | Recepción, salida y tablero |
| Auxiliar | Validación de los ítems de sus municipios |
| Comprador | Órdenes de compra y QR |

Estados del ítem: GENERADO → EN VALIDACIÓN / PNC / DEVOLUCIÓN → VALIDADO → ENTREGADO.

## Puesta en marcha

1. Crea un proyecto en Supabase y ejecuta `schema.sql` (con tu correo en la última línea) y luego `seed_prueba.sql`. Detalle en `LEEME_fase0.md`.
2. En Supabase, activa Google en **Authentication > Sign In / Providers**.
3. Copia la URL del proyecto y la clave pública (publishable) en las dos primeras constantes de `app.js`.
4. Publica la carpeta en GitHub Pages (**Settings > Pages > Deploy from a branch**) y agrega esa dirección en Supabase, en **Authentication > URL Configuration**.
5. Abre la dirección publicada e ingresa con Google. El ingreso no funciona abriendo el archivo directamente (`file://`).
