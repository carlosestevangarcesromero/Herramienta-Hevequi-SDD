# Fase 0 · Base de datos en Supabase

Archivos:
- `schema.sql`: crea tablas, permisos por rol, funciones de negocio, auditoría y vistas de tablero y cuadre.
- `seed_prueba.sql`: datos ficticios (3 municipios, 2 proveedores, 3 usuarios de prueba, 2 órdenes, 20 ítems con QR `HVQ-PRUEBA-01` a `HVQ-PRUEBA-20`).

## Pasos para instalar

1. Entra a https://supabase.com/dashboard y crea un proyecto nuevo (por ejemplo `hevequi-pruebas`).
2. Abre `schema.sql` y, en la última línea, reemplaza `REEMPLAZA_CON_TU_CORREO@gmail.com` y `REEMPLAZA CON TU NOMBRE` con tu correo de Google y tu nombre.
3. En Supabase, entra a **SQL Editor > New query**, pega todo `schema.sql` y pulsa **Run**. Debe terminar con "Success. No rows returned".
4. Abre otra consulta nueva, pega `seed_prueba.sql` y pulsa **Run**.

## Cómo comprobar que quedó bien

Ejecuta esto en el SQL Editor:

```sql
select estado_actual, count(*) from items group by 1;       -- GENERADO | 20
select count(*) from movimientos_estado;                     -- 20 (uno por ítem creado)
select count(*) from transiciones;                           -- 10
select correo, rol from usuarios order by id;                -- tu correo (coordinador) + 3 de prueba
```

En **Table Editor** deben aparecer 10 tablas: municipios, proveedores, usuarios, usuario_municipio, ordenes_compra, items, transiciones, movimientos_estado, incidencias, auditoria. Todas con el candado de RLS activo.

## Reglas que ya están en la base de datos (probadas)

Las probé en PostgreSQL 16 con los 3 usuarios de prueba; los 20 casos dieron el resultado esperado:

| Caso | Resultado |
| --- | --- |
| Correo no registrado consulta ítems | Ve 0 ítems |
| QR válido / inexistente / de otra orden | `valido` / `qr_no_registrado` / `otra_orden`, con incidencia |
| QR ya recibido | Bloquea y muestra quién lo recibió |
| Supervisor intenta marcar VALIDADO | Rechazado: transición no permitida |
| Auxiliar cambia un ítem de otro municipio | Rechazado: sin permiso sobre el municipio |
| Salida de un ítem EN VALIDACIÓN | Rechazada, con incidencia |
| Salida de un ítem VALIDADO | Pasa a ENTREGADO; repetirla se rechaza |
| Auxiliar intenta registrar salida | Rechazado |
| Editar el estado directamente o borrar historial | No se aplica |
| Comprador corrige un ítem ya recibido | Rechazado |
| Comprador crea un usuario | Rechazado |
| PNC → VALIDADO sin motivo | Rechazado: motivo obligatorio |
| Cuadre | 4 COMPLETO, 17 FALTANTE, 2 SOBRANTE |

## Decisiones mías dentro del SQL (revísalas)

1. Motivo obligatorio solo en PNC → VALIDADO y DEVOLUCIÓN → VALIDADO (marcadas [SUPUESTO] en FL-11). El resto queda en "no" hasta que respondas P5. Se cambia en la tabla `transiciones`, sin tocar código.
2. "Datos consistentes" (FL-07) = el ítem tiene producto y su municipio está activo. Falta tu definición.
3. Todo usuario activo puede ver nombre y rol de los demás, porque el historial muestra quién hizo cada cambio.
4. El código QR se genera solo con el formato `HVQ-` + 12 caracteres, por ejemplo `HVQ-26FA1953F63A`.
