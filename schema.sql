-- =====================================================================
-- HEVEQUI · Control de bodega · schema.sql (Fase 0)
-- Ejecutar UNA sola vez en Supabase: SQL Editor > New query > pegar > Run.
--
-- Qué crea:
--   1. Tipos (roles y estados del ítem)
--   2. Tablas (catálogos, usuarios, órdenes, ítems, transiciones,
--      movimientos, incidencias, auditoría)
--   3. Funciones de apoyo (quién es el usuario, qué rol tiene)
--   4. Reglas: historial sin sobrescritura y estado solo por función
--   5. Funciones de negocio (validar QR, cambiar estado, salida)
--   6. Auditoría automática
--   7. Permisos por rol (Row Level Security)
--   8. Vistas para tablero y cuadre
--   9. Primer Coordinador (reemplaza el correo antes de ejecutar)
--
-- Fuente de las reglas: Hevequi_Flujogramas_v0.1 (FL-03 a FL-11) y
-- decisiones de Estevan del 2026-11-23.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TIPOS
-- ---------------------------------------------------------------------
-- Los 4 roles confirmados. El Proveedor no tiene rol.
create type rol_usuario as enum ('coordinador', 'supervisor', 'auxiliar', 'comprador');

-- Estados del ítem (FL-11 + ENTREGADO).
create type estado_item as enum
  ('GENERADO', 'EN_VALIDACION', 'VALIDADO', 'PNC', 'DEVOLUCION', 'ENTREGADO');

-- De dónde viene cada cambio de estado.
create type origen_movimiento as enum ('creacion', 'recepcion', 'validacion', 'correccion', 'salida');

-- Tipos de incidencia del escaneo (FL-07) y de la salida.
create type tipo_incidencia as enum
  ('qr_no_registrado', 'ya_recibido', 'otra_orden', 'datos_inconsistentes',
   'salida_no_validado', 'salida_ya_entregado');


-- ---------------------------------------------------------------------
-- 2. TABLAS
-- ---------------------------------------------------------------------
create table municipios (
  id          bigint generated always as identity primary key,
  nombre      text not null unique,
  activo      boolean not null default true
);

create table proveedores (
  id          bigint generated always as identity primary key,
  nombre      text not null unique,
  nit         text,                       -- opcional: no confirmado en los datos actuales
  contacto    text,
  activo      boolean not null default true
);

-- Usuarios de la herramienta. El Coordinador los da de alta por correo
-- ANTES de que ingresen; al primer ingreso con Google se enlaza auth_id.
create table usuarios (
  id          bigint generated always as identity primary key,
  correo      text not null unique check (correo = lower(correo)),
  nombre      text not null,
  rol         rol_usuario not null,
  activo      boolean not null default true,
  auth_id     uuid unique,                -- id de Supabase Auth, se llena solo
  creado_en   timestamptz not null default now()
);

-- Municipios asignados a cada Auxiliar (FL-10: rol Organizador + municipios).
create table usuario_municipio (
  usuario_id   bigint not null references usuarios(id) on delete cascade,
  municipio_id bigint not null references municipios(id),
  primary key (usuario_id, municipio_id)
);

create table ordenes_compra (
  id            bigint generated always as identity primary key,
  numero_oc     text not null unique,
  proveedor_id  bigint not null references proveedores(id),
  comprador_id  bigint not null references usuarios(id),
  fecha         date not null default current_date,
  observaciones text,
  creado_en     timestamptz not null default now()
);

-- Un QR por ítem de la orden (decisión 2026-11-23).
create table items (
  id             bigint generated always as identity primary key,
  orden_id       bigint not null references ordenes_compra(id),
  codigo_qr      text not null unique
                   default ('HVQ-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))),
  municipio_id   bigint not null references municipios(id),
  producto       text not null,
  descripcion    text,
  beneficiario   text,                    -- opcional: no confirmado en los datos actuales
  estado_actual  estado_item not null default 'GENERADO',
  creado_en      timestamptz not null default now()
);
create index on items (orden_id);
create index on items (municipio_id);
create index on items (estado_actual);

-- Tabla de transiciones permitidas (FL-11). Es configurable: cuando
-- respondas qué motivos son obligatorios (P5) se cambia aquí, sin tocar código.
create table transiciones (
  estado_origen      estado_item not null,
  estado_destino     estado_item not null,
  rol                rol_usuario not null,
  motivo_obligatorio boolean not null default false,
  confirmada         boolean not null default true,  -- false = [SUPUESTO] del flujograma
  primary key (estado_origen, estado_destino, rol)
);

-- Historial de estados: SOLO inserción (FL-05, FL-08).
create table movimientos_estado (
  id               bigint generated always as identity primary key,
  item_id          bigint not null references items(id),
  estado_anterior  estado_item,           -- null en la creación
  estado_nuevo     estado_item not null,
  usuario_id       bigint references usuarios(id),
  fecha_hora       timestamptz not null default now(),
  motivo           text,
  origen           origen_movimiento not null
);
create index on movimientos_estado (item_id);

-- Incidencias del escaneo: SOLO inserción (FL-07).
create table incidencias (
  id             bigint generated always as identity primary key,
  tipo           tipo_incidencia not null,
  codigo_leido   text not null,
  item_id        bigint references items(id),
  orden_esperada text,
  usuario_id     bigint references usuarios(id),
  fecha_hora     timestamptz not null default now(),
  detalle        text
);

-- Auditoría de cambios: SOLO inserción (FL-10).
create table auditoria (
  id           bigint generated always as identity primary key,
  tabla        text not null,
  registro_id  text,
  accion       text not null,             -- INSERT, UPDATE, DELETE
  antes        jsonb,
  despues      jsonb,
  usuario_id   bigint,
  fecha_hora   timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 3. FUNCIONES DE APOYO: ¿quién está usando la app?
-- ---------------------------------------------------------------------
-- Devuelve el id (tabla usuarios) del usuario que hizo la petición,
-- solo si está activo. Se identifica por el correo de su cuenta Google.
create or replace function mi_usuario_id() returns bigint
language sql stable security definer set search_path = public as $$
  select id from usuarios
  where correo = lower(coalesce(auth.jwt() ->> 'email', ''))
    and activo
$$;

create or replace function mi_rol() returns rol_usuario
language sql stable security definer set search_path = public as $$
  select rol from usuarios where id = mi_usuario_id()
$$;

-- ¿El usuario actual puede trabajar en este municipio?
-- Coordinador y Supervisor: todos. Auxiliar: solo los asignados.
create or replace function puede_en_municipio(p_municipio bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when mi_rol() in ('coordinador', 'supervisor') then true
    when mi_rol() = 'auxiliar' then exists (
      select 1 from usuario_municipio
      where usuario_id = mi_usuario_id() and municipio_id = p_municipio)
    else false
  end
$$;

-- Al primer ingreso, la app llama esta función para enlazar la cuenta
-- Google con el usuario creado por el Coordinador. Devuelve el perfil.
create or replace function registrar_ingreso()
returns table (id bigint, correo text, nombre text, rol rol_usuario)
language plpgsql security definer set search_path = public as $$
begin
  if mi_usuario_id() is null then
    raise exception 'Tu correo no está autorizado o está inactivo. Pide acceso al Coordinador.';
  end if;
  update usuarios u set auth_id = auth.uid()
   where u.id = mi_usuario_id() and u.auth_id is null;
  return query select u.id, u.correo, u.nombre, u.rol from usuarios u where u.id = mi_usuario_id();
end $$;


-- ---------------------------------------------------------------------
-- 4. REGLAS DE INTEGRIDAD
-- ---------------------------------------------------------------------
-- 4a. Historial sin sobrescritura: bloquea UPDATE y DELETE.
create or replace function bloquear_cambios() returns trigger
language plpgsql as $$
begin
  raise exception 'La tabla % es un historial: no se puede editar ni borrar.', tg_table_name;
end $$;

create trigger solo_insercion before update or delete on movimientos_estado
  for each row execute function bloquear_cambios();
create trigger solo_insercion before update or delete on incidencias
  for each row execute function bloquear_cambios();
create trigger solo_insercion before update or delete on auditoria
  for each row execute function bloquear_cambios();

-- 4b. El estado de un ítem solo cambia a través de cambiar_estado().
create or replace function proteger_estado() returns trigger
language plpgsql as $$
begin
  if new.estado_actual is distinct from old.estado_actual
     and coalesce(current_setting('hevequi.cambio_autorizado', true), '') <> 'si' then
    raise exception 'El estado solo se cambia con la función cambiar_estado().';
  end if;
  -- Los datos del ítem solo se corrigen mientras está GENERADO (FL-03).
  if old.estado_actual <> 'GENERADO'
     and (new.producto, new.descripcion, new.municipio_id, new.orden_id, new.codigo_qr, new.beneficiario)
         is distinct from
         (old.producto, old.descripcion, old.municipio_id, old.orden_id, old.codigo_qr, old.beneficiario) then
    raise exception 'El ítem ya fue recibido: sus datos no se pueden corregir.';
  end if;
  return new;
end $$;

create trigger proteger_estado before update on items
  for each row execute function proteger_estado();

-- 4c. Un ítem nuevo siempre nace GENERADO y deja su primer movimiento.
create or replace function item_creado() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into movimientos_estado (item_id, estado_anterior, estado_nuevo, usuario_id, origen)
  values (new.id, null, 'GENERADO', mi_usuario_id(), 'creacion');
  return new;
end $$;

create or replace function item_nace_generado() returns trigger
language plpgsql as $$
begin
  new.estado_actual := 'GENERADO';
  return new;
end $$;

create trigger item_nace_generado before insert on items
  for each row execute function item_nace_generado();
create trigger item_creado after insert on items
  for each row execute function item_creado();


-- ---------------------------------------------------------------------
-- 5. FUNCIONES DE NEGOCIO (las llama app.js)
-- ---------------------------------------------------------------------

-- 5a. Cambiar estado (FL-08). Valida permiso, municipio, transición y
-- motivo; crea el movimiento y actualiza el estado en una sola operación.
create or replace function cambiar_estado(
  p_item_id  bigint,
  p_nuevo    estado_item,
  p_motivo   text default null,
  p_origen   origen_movimiento default 'validacion'
) returns items
language plpgsql security definer set search_path = public as $$
declare
  v_item  items;
  v_regla transiciones;
  v_rol   rol_usuario := mi_rol();
begin
  if v_rol is null then
    raise exception 'Usuario no autorizado o inactivo.';
  end if;

  select * into v_item from items where id = p_item_id for update;
  if not found then
    raise exception 'El ítem % no existe.', p_item_id;
  end if;

  if not puede_en_municipio(v_item.municipio_id) then
    raise exception 'Cambio denegado: no tienes permiso sobre el municipio de este ítem.';
  end if;

  select * into v_regla from transiciones
   where estado_origen = v_item.estado_actual and estado_destino = p_nuevo and rol = v_rol;
  if not found then
    raise exception 'Transición no permitida para tu rol: % → %.', v_item.estado_actual, p_nuevo;
  end if;

  if v_regla.motivo_obligatorio and coalesce(trim(p_motivo), '') = '' then
    raise exception 'Escribe el motivo del cambio: es obligatorio para % → %.', v_item.estado_actual, p_nuevo;
  end if;

  insert into movimientos_estado (item_id, estado_anterior, estado_nuevo, usuario_id, motivo, origen)
  values (v_item.id, v_item.estado_actual, p_nuevo, mi_usuario_id(), nullif(trim(p_motivo), ''), p_origen);

  perform set_config('hevequi.cambio_autorizado', 'si', true);
  update items set estado_actual = p_nuevo where id = v_item.id returning * into v_item;
  perform set_config('hevequi.cambio_autorizado', 'no', true);

  return v_item;
end $$;

-- Registra una incidencia (uso interno).
create or replace function registrar_incidencia(
  p_tipo tipo_incidencia, p_codigo text, p_item bigint, p_orden text, p_detalle text
) returns void
language sql security definer set search_path = public as $$
  insert into incidencias (tipo, codigo_leido, item_id, orden_esperada, usuario_id, detalle)
  values (p_tipo, p_codigo, p_item, p_orden, mi_usuario_id(), p_detalle);
$$;

-- 5b. Validar QR en la recepción (FL-07). Orden de las validaciones:
-- existe → ya recibido → orden esperada → datos consistentes.
-- (Legible y conexión se revisan en el celular, en app.js.)
-- Devuelve JSON: { ok, tipo, mensaje, item }.
create or replace function validar_qr_recepcion(p_codigo text, p_numero_oc text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_codigo text := upper(trim(p_codigo));
  v_item   items;
  v_oc     ordenes_compra;
  v_ultimo movimientos_estado;
  v_nombre text;
begin
  if mi_rol() not in ('supervisor', 'coordinador') then
    raise exception 'Solo el Supervisor o el Coordinador registran recepciones.';
  end if;

  select * into v_item from items where codigo_qr = v_codigo;
  if not found then
    perform registrar_incidencia('qr_no_registrado', v_codigo, null, p_numero_oc, null);
    return jsonb_build_object('ok', false, 'tipo', 'qr_no_registrado',
      'mensaje', 'QR no registrado. Revisa el código o informa al Comprador.');
  end if;

  if v_item.estado_actual <> 'GENERADO' then
    select * into v_ultimo from movimientos_estado
     where item_id = v_item.id and origen = 'recepcion' order by fecha_hora limit 1;
    select nombre into v_nombre from usuarios where id = v_ultimo.usuario_id;
    perform registrar_incidencia('ya_recibido', v_codigo, v_item.id, p_numero_oc, null);
    return jsonb_build_object('ok', false, 'tipo', 'ya_recibido',
      'mensaje', 'Este ítem ya fue recibido. No se puede recibir de nuevo.',
      'recibido_por', v_nombre, 'recibido_en', v_ultimo.fecha_hora,
      'item', to_jsonb(v_item));
  end if;

  select * into v_oc from ordenes_compra where id = v_item.orden_id;
  if p_numero_oc is not null and trim(p_numero_oc) <> '' and v_oc.numero_oc <> trim(p_numero_oc) then
    perform registrar_incidencia('otra_orden', v_codigo, v_item.id, p_numero_oc,
      'Pertenece a la orden ' || v_oc.numero_oc);
    return jsonb_build_object('ok', false, 'tipo', 'otra_orden',
      'mensaje', 'Este ítem pertenece a la orden ' || v_oc.numero_oc || ', no a la orden esperada.',
      'item', to_jsonb(v_item));
  end if;

  -- [SUPUESTO] "Datos consistentes": el ítem tiene producto y un municipio activo.
  if coalesce(trim(v_item.producto), '') = ''
     or not exists (select 1 from municipios where id = v_item.municipio_id and activo) then
    perform registrar_incidencia('datos_inconsistentes', v_codigo, v_item.id, p_numero_oc, null);
    return jsonb_build_object('ok', false, 'tipo', 'datos_inconsistentes',
      'mensaje', 'Los datos del ítem están incompletos. Informa al Comprador.',
      'item', to_jsonb(v_item));
  end if;

  return jsonb_build_object('ok', true, 'tipo', 'valido',
    'mensaje', 'QR válido. Revisa el producto y asigna su estado.',
    'item', to_jsonb(v_item), 'numero_oc', v_oc.numero_oc);
end $$;

-- 5c. Escaneo de salida: solo VALIDADO pasa a ENTREGADO (decisión 2026-11-23).
create or replace function escanear_salida(p_codigo text, p_observacion text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_codigo text := upper(trim(p_codigo));
  v_item   items;
begin
  if mi_rol() not in ('supervisor', 'coordinador') then
    raise exception 'Solo el Supervisor o el Coordinador registran salidas.';
  end if;

  select * into v_item from items where codigo_qr = v_codigo;
  if not found then
    perform registrar_incidencia('qr_no_registrado', v_codigo, null, null, 'Escaneo de salida');
    return jsonb_build_object('ok', false, 'tipo', 'qr_no_registrado',
      'mensaje', 'QR no registrado. No sale de la bodega.');
  end if;

  if v_item.estado_actual = 'ENTREGADO' then
    perform registrar_incidencia('salida_ya_entregado', v_codigo, v_item.id, null, null);
    return jsonb_build_object('ok', false, 'tipo', 'salida_ya_entregado',
      'mensaje', 'Este ítem ya fue entregado.', 'item', to_jsonb(v_item));
  end if;

  if v_item.estado_actual <> 'VALIDADO' then
    perform registrar_incidencia('salida_no_validado', v_codigo, v_item.id, null,
      'Estado actual: ' || v_item.estado_actual);
    return jsonb_build_object('ok', false, 'tipo', 'salida_no_validado',
      'mensaje', 'No puede salir: el ítem está en ' || v_item.estado_actual || '. Solo sale si está VALIDADO.',
      'item', to_jsonb(v_item));
  end if;

  v_item := cambiar_estado(v_item.id, 'ENTREGADO', p_observacion, 'salida');
  return jsonb_build_object('ok', true, 'tipo', 'entregado',
    'mensaje', 'Ítem entregado.', 'item', to_jsonb(v_item));
end $$;


-- ---------------------------------------------------------------------
-- 6. AUDITORÍA AUTOMÁTICA (quién, qué, antes, después)
-- ---------------------------------------------------------------------
create or replace function auditar() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_antes   jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_despues jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
begin
  insert into auditoria (tabla, registro_id, accion, antes, despues, usuario_id)
  values (tg_table_name,
          coalesce(v_despues ->> 'id', v_antes ->> 'id',
                   coalesce(v_despues, v_antes) ->> 'usuario_id'),
          tg_op, v_antes, v_despues, mi_usuario_id());
  return coalesce(new, old);
end $$;

create trigger auditar after insert or update or delete on usuarios
  for each row execute function auditar();
create trigger auditar after insert or update or delete on usuario_municipio
  for each row execute function auditar();
create trigger auditar after insert or update or delete on municipios
  for each row execute function auditar();
create trigger auditar after insert or update or delete on proveedores
  for each row execute function auditar();
create trigger auditar after insert or update or delete on ordenes_compra
  for each row execute function auditar();
create trigger auditar after insert or update or delete on items
  for each row execute function auditar();
create trigger auditar after insert or update or delete on transiciones
  for each row execute function auditar();


-- ---------------------------------------------------------------------
-- 7. PERMISOS POR ROL (Row Level Security)
-- Sin una política que lo permita, nadie puede leer ni escribir.
-- ---------------------------------------------------------------------
alter table municipios         enable row level security;
alter table proveedores        enable row level security;
alter table usuarios           enable row level security;
alter table usuario_municipio  enable row level security;
alter table ordenes_compra     enable row level security;
alter table items              enable row level security;
alter table transiciones       enable row level security;
alter table movimientos_estado enable row level security;
alter table incidencias        enable row level security;
alter table auditoria          enable row level security;

-- Lectura: cualquier usuario activo (pantalla "Historial del ítem": todos).
create policy leer on municipios         for select to authenticated using (mi_usuario_id() is not null);
create policy leer on proveedores        for select to authenticated using (mi_usuario_id() is not null);
create policy leer on ordenes_compra     for select to authenticated using (mi_usuario_id() is not null);
create policy leer on items              for select to authenticated using (mi_usuario_id() is not null);
create policy leer on transiciones       for select to authenticated using (mi_usuario_id() is not null);
create policy leer on movimientos_estado for select to authenticated using (mi_usuario_id() is not null);
create policy leer on incidencias        for select to authenticated using (mi_usuario_id() is not null);
create policy leer on usuario_municipio  for select to authenticated using (mi_usuario_id() is not null);
-- Usuarios: todo usuario activo ve nombre y rol de los demás (lo
-- necesitan el historial y los filtros "recibido por" / "usuario").
-- Solo el Coordinador los crea o cambia (política de abajo).
create policy leer on usuarios for select to authenticated using (mi_usuario_id() is not null);
-- Auditoría: solo el Coordinador.
create policy leer on auditoria for select to authenticated using (mi_rol() = 'coordinador');

-- Escritura del Coordinador: usuarios, municipios, transiciones.
create policy coordinador on usuarios          for all to authenticated
  using (mi_rol() = 'coordinador') with check (mi_rol() = 'coordinador');
create policy coordinador on usuario_municipio for all to authenticated
  using (mi_rol() = 'coordinador') with check (mi_rol() = 'coordinador');
create policy coordinador on municipios        for all to authenticated
  using (mi_rol() = 'coordinador') with check (mi_rol() = 'coordinador');
create policy coordinador on transiciones      for all to authenticated
  using (mi_rol() = 'coordinador') with check (mi_rol() = 'coordinador');

-- Proveedores: Coordinador y Comprador crean y editan.
create policy escribir on proveedores for all to authenticated
  using (mi_rol() in ('coordinador', 'comprador'))
  with check (mi_rol() in ('coordinador', 'comprador'));

-- Órdenes: el Comprador crea y corrige las suyas; el Coordinador, todas.
create policy escribir on ordenes_compra for insert to authenticated
  with check (mi_rol() = 'coordinador' or (mi_rol() = 'comprador' and comprador_id = mi_usuario_id()));
create policy corregir on ordenes_compra for update to authenticated
  using (mi_rol() = 'coordinador' or (mi_rol() = 'comprador' and comprador_id = mi_usuario_id()))
  with check (mi_rol() = 'coordinador' or (mi_rol() = 'comprador' and comprador_id = mi_usuario_id()));

-- Ítems: el Comprador los crea en sus órdenes y los corrige mientras
-- estén GENERADO (lo controla el trigger 4b). Nadie borra ítems.
create policy escribir on items for insert to authenticated
  with check (mi_rol() = 'coordinador' or (mi_rol() = 'comprador' and exists (
    select 1 from ordenes_compra o where o.id = orden_id and o.comprador_id = mi_usuario_id())));
create policy corregir on items for update to authenticated
  using (mi_rol() = 'coordinador' or (mi_rol() = 'comprador' and exists (
    select 1 from ordenes_compra o where o.id = orden_id and o.comprador_id = mi_usuario_id())));

-- movimientos_estado, incidencias y auditoria: sin políticas de escritura.
-- Solo se llenan a través de las funciones de la sección 5 y 6.

-- La app sin ingresar (anon) no puede ejecutar funciones; solo los
-- usuarios con sesión (authenticated).
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;


-- ---------------------------------------------------------------------
-- 8. VISTAS PARA TABLERO, CUADRE Y EXPORTACIÓN
-- security_invoker = respetan los permisos de quien consulta.
-- ---------------------------------------------------------------------
-- Ítem con todos sus datos para filtros (FL-06: municipio, código, ítem,
-- OC, estado, proveedor, usuario, rango de fechas).
create view vista_items with (security_invoker = true) as
select i.id, i.codigo_qr, i.producto, i.descripcion, i.beneficiario,
       i.estado_actual, i.creado_en,
       m.id as municipio_id, m.nombre as municipio,
       o.id as orden_id, o.numero_oc, o.fecha as fecha_oc,
       p.id as proveedor_id, p.nombre as proveedor,
       c.nombre as comprador,
       rec.fecha_hora as recibido_en, ur.nombre as recibido_por,
       ult.fecha_hora as ultimo_cambio_en, uu.nombre as ultimo_cambio_por
from items i
join municipios m     on m.id = i.municipio_id
join ordenes_compra o on o.id = i.orden_id
join proveedores p    on p.id = o.proveedor_id
join usuarios c       on c.id = o.comprador_id
left join lateral (select fecha_hora, usuario_id from movimientos_estado
                   where item_id = i.id and origen = 'recepcion'
                   order by fecha_hora limit 1) rec on true
left join usuarios ur on ur.id = rec.usuario_id
left join lateral (select fecha_hora, usuario_id from movimientos_estado
                   where item_id = i.id order by fecha_hora desc, id desc limit 1) ult on true
left join usuarios uu on uu.id = ult.usuario_id;

-- Cuadre por ítem (FL-09): esperado vs recibido.
--   COMPLETO   = esperado y recibido
--   FALTANTE   = esperado sin recepción (sigue GENERADO)
create view vista_cuadre_items with (security_invoker = true) as
select v.*,
       case when v.estado_actual = 'GENERADO' then 'FALTANTE' else 'COMPLETO' end as resultado_cuadre
from vista_items v;

-- Lecturas sin ítem esperado (SOBRANTE) o con datos que no coinciden
-- (INCONSISTENCIA), tomadas de las incidencias de recepción.
create view vista_cuadre_incidencias with (security_invoker = true) as
select n.id, n.fecha_hora, n.codigo_leido, n.orden_esperada, n.detalle,
       case when n.tipo in ('qr_no_registrado', 'otra_orden') then 'SOBRANTE'
            else 'INCONSISTENCIA' end as resultado_cuadre,
       n.tipo, u.nombre as usuario
from incidencias n
left join usuarios u on u.id = n.usuario_id
where n.tipo in ('qr_no_registrado', 'otra_orden', 'datos_inconsistentes');


-- ---------------------------------------------------------------------
-- 9. DATOS INICIALES
-- ---------------------------------------------------------------------
-- Transiciones de FL-11 con los 4 roles confirmados.
-- motivo_obligatorio en PNC/DEVOLUCIÓN = false hasta que respondas P5.
insert into transiciones (estado_origen, estado_destino, rol, motivo_obligatorio, confirmada) values
  ('GENERADO',      'EN_VALIDACION', 'supervisor',  false, true),
  ('GENERADO',      'PNC',           'supervisor',  false, true),
  ('GENERADO',      'DEVOLUCION',    'supervisor',  false, true),
  ('EN_VALIDACION', 'VALIDADO',      'auxiliar',    false, true),
  ('EN_VALIDACION', 'PNC',           'auxiliar',    false, true),
  ('EN_VALIDACION', 'DEVOLUCION',    'auxiliar',    false, true),
  ('PNC',           'VALIDADO',      'auxiliar',    true,  false),  -- [SUPUESTO] FL-11
  ('DEVOLUCION',    'VALIDADO',      'auxiliar',    true,  false),  -- [SUPUESTO] FL-11
  ('VALIDADO',      'ENTREGADO',     'supervisor',  false, true),
  ('VALIDADO',      'ENTREGADO',     'coordinador', false, true);

-- PRIMER COORDINADOR: reemplaza el correo y el nombre antes de ejecutar.
-- Debe ser el mismo correo de Google con el que vas a ingresar.
insert into usuarios (correo, nombre, rol)
values (lower('REEMPLAZA_CON_TU_CORREO@gmail.com'), 'REEMPLAZA CON TU NOMBRE', 'coordinador');
