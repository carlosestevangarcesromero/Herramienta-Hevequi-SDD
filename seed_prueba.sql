-- =====================================================================
-- HEVEQUI · Datos de PRUEBA (Fase 0)
-- Ejecutar DESPUÉS de schema.sql. Todo lo de aquí es ficticio y lleva
-- la palabra PRUEBA para distinguirlo. Para borrarlo, ver el final.
-- =====================================================================

insert into municipios (nombre) values
  ('PRUEBA Municipio A'), ('PRUEBA Municipio B'), ('PRUEBA Municipio C');

insert into proveedores (nombre) values
  ('PRUEBA Proveedor 1'), ('PRUEBA Proveedor 2');

-- Usuarios de prueba, uno por rol (correos que no existen).
-- Para probar con tu propio Google, cambia el rol de tu usuario Coordinador
-- o crea usuarios con correos reales de tu equipo.
insert into usuarios (correo, nombre, rol) values
  ('prueba.comprador@ejemplo.com',  'PRUEBA Comprador',  'comprador'),
  ('prueba.supervisor@ejemplo.com', 'PRUEBA Supervisor', 'supervisor'),
  ('prueba.auxiliar@ejemplo.com',   'PRUEBA Auxiliar',   'auxiliar');

-- El Auxiliar de prueba solo trabaja el Municipio A.
insert into usuario_municipio (usuario_id, municipio_id)
select u.id, m.id from usuarios u, municipios m
where u.correo = 'prueba.auxiliar@ejemplo.com' and m.nombre = 'PRUEBA Municipio A';

-- 2 órdenes de compra.
insert into ordenes_compra (numero_oc, proveedor_id, comprador_id, observaciones)
select 'PRUEBA-OC-001', p.id, u.id, 'Orden de prueba'
from proveedores p, usuarios u
where p.nombre = 'PRUEBA Proveedor 1' and u.correo = 'prueba.comprador@ejemplo.com';

insert into ordenes_compra (numero_oc, proveedor_id, comprador_id, observaciones)
select 'PRUEBA-OC-002', p.id, u.id, 'Orden de prueba'
from proveedores p, usuarios u
where p.nombre = 'PRUEBA Proveedor 2' and u.correo = 'prueba.comprador@ejemplo.com';

-- 20 ítems: 10 por orden, repartidos entre los 3 municipios.
-- Códigos QR fijos para poder probar el escaneo digitándolos.
insert into items (orden_id, codigo_qr, municipio_id, producto, descripcion)
select o.id,
       'HVQ-PRUEBA-' || lpad(((case when o.numero_oc = 'PRUEBA-OC-001' then 0 else 10 end) + g)::text, 2, '0'),
       (select id from municipios where nombre = 'PRUEBA Municipio ' || chr(64 + ((g - 1) % 3) + 1)),
       'PRUEBA Producto ' || g,
       'Ítem ficticio de prueba'
from ordenes_compra o, generate_series(1, 10) g
where o.numero_oc in ('PRUEBA-OC-001', 'PRUEBA-OC-002');

-- ---------------------------------------------------------------------
-- BORRAR LOS DATOS DE PRUEBA (no ejecutar ahora)
-- Los historiales no permiten borrar; por eso, antes de pasar a uso real,
-- lo más limpio es crear el proyecto de Supabase de producción desde cero
-- con schema.sql, sin este archivo.
-- ---------------------------------------------------------------------
