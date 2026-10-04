-- Mercado Libre (Issue #170): publicar piezas con foto y mantener las existencias
-- de acuerdo con D1, que sigue siendo el unico maestro de stock.
-- Correr una vez, antes de desplegar el codigo que la usa. Primero en el
-- sandbox y luego en produccion:
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-025-mercadolibre.sql
--
-- Es repetible: todo es `if not exists` / `insert or ignore`.

-- La cuenta vendedora conectada: una sola fila (id = 1). Los tokens van cifrados
-- con AES-GCM (secreto ML_LLAVE_TOKENS); aqui nunca queda uno en claro. El
-- refresh token de ML es de UN solo uso: `refrescando_hasta` es el candado que
-- evita que dos peticiones gasten el mismo. Tokens vacios = desconectada.
create table if not exists ml_cuenta (
  id                    integer primary key check (id = 1),
  ml_user_id            text not null default '',
  nickname              text not null default '',
  tags                  text not null default '[]',     -- json; 'user_product_seller' cambia el formato de publicacion
  access_token_cifrado  text not null default '',
  refresh_token_cifrado text not null default '',
  expira_en             text not null default '',       -- ISO, del access token
  actualizado_en        text not null default '',
  refrescando_hasta     text not null default ''        -- ISO: candado de refresh en curso
);

-- `state` de OAuth (un solo uso) y el verificador PKCE de ese intento.
create table if not exists ml_oauth_estados (
  state       text primary key,
  verificador text not null default '',
  creado_en   text not null
);

-- Una publicacion por pieza. Sin llave foranea a proposito: descartar una pieza
-- no debe tumbarse por una publicacion, y borrar la fila dejaria viva la de ML.
-- estado: publicando|activa|pausada|pausada_por_venta|vendida|cerrada|error
-- `ml_item_id` es null mientras no existe el articulo en ML (publicando/error).
create table if not exists ml_publicaciones (
  producto_id    text primary key,
  ml_item_id     text unique,
  estado         text not null default 'error',
  precio_ml      integer not null default 0,            -- centavos MXN
  categoria_id   text not null default '',
  permalink      text not null default '',
  ultimo_error   text not null default '',
  publicado_en   text not null default '',
  actualizado_en text not null
);

-- Ventas hechas en Mercado Libre. NO tocan `ventas` ni los cortes (no pasa por
-- el cajon); solo descuentan existencias. La llave (orden, articulo) hace
-- idempotente el descuento: la misma orden llega por notificacion, por reintento
-- y por la conciliacion, y descuenta una sola vez.
-- estado: recibida|descontada|cancelada. `descontado` = piezas que de verdad
-- salieron de D1 (puede ser menos que `cantidad` si ya no habia), para poder
-- devolverlas si ML cancela la orden. `conflicto` = D1 no tenia existencias.
create table if not exists ml_ventas (
  order_id    text not null,
  ml_item_id  text not null,
  producto_id text not null,
  cantidad    integer not null,
  estado      text not null default 'recibida',
  descontado  integer not null default 0,
  conflicto   integer not null default 0,
  recibido_en text not null,
  primary key (order_id, ml_item_id)
);

-- Bitacora de lo que ML avisa: auditoria y diagnostico, no cola de trabajo.
create table if not exists ml_notificaciones (
  id           integer primary key autoincrement,
  topic        text not null default '',
  resource     text not null default '',
  recibido_en  text not null,
  procesado_en text not null default '',
  error        text not null default ''
);

-- Precio en ML = precio de tienda + ml_pct %, quebrado a X9 (cubre comision y envio).
insert or ignore into config (clave, valor) values
  ('ml_pct', '20'),
  ('ml_tipo_publicacion', 'gold_special');
