-- Portadas con IA (Issue #888, parte de #886 «Publicar solo», Proyecto 1): para cada pieza vendible con foto de anaquel, el cron
-- genera una portada de estudio (fondo blanco, 1200x1200), comprueba que es la misma pieza y la deja aprobada, en revision o por
-- retomar. APAGADO por omision: sin la fila `portadas_activo` = '1' el cron no hace nada.
--
-- Correr una vez, ANTES de desplegar el codigo que la usa (sandbox primero, luego prod):
--   npx wrangler d1 execute el-dolaron --remote --file=migracion-087-portadas.sql
-- Va despues de 086. La 088 esta reservada para #637.
--
-- Despues, las perillas son filas de `config` (una linea de SQL cada una, sin pantalla):
--   encender:          insert into config (clave, valor) values ('portadas_activo', '1') on conflict (clave) do update set valor = '1';
--   apagar:            update config set valor = '0' where clave = 'portadas_activo';
--   tope diario:       insert into config (clave, valor) values ('portadas_tope_diario', '100') on conflict (clave) do update set valor = excluded.valor;
--   quitar aprobacion: insert into config (clave, valor) values ('portadas_aprobacion', '0') on conflict (clave) do update set valor = '0';
--   volver a pedirla:  delete from config where clave = 'portadas_aprobacion';   -- ausente o distinto de '0' = CON aprobacion
-- El tope cuenta imagenes generadas por dia (portadas_generadas_AAAA-MM-DD, lo escribe el cron); sin fila el tope es 100.
--
-- Solo una portada aprobada llega a R2 `extras/{id}/01.jpg` (publicar sube todo `extras/` sin leer estados). Lo generado y no
-- aprobado vive en `portadas/{id}.jpg`; `portadas/{id}.cruda` es lo que devolvio el modelo, antes de normalizarlo.
--
-- `oficial` = la pieza ya usa la imagen de Target: recorte_estado = 'original' Y una referencia confirmada en imagenes_upc para su UPC
-- (confirmado_en <> '' con su manifiesto, la clave sin ceros iniciales). Un 'original' sin referencia (el boton «original» de /admin sobre
-- una foto de anaquel) NO es oficial: recibe portada generada como cualquier foto de anaquel.
--
-- Aditiva: columnas nuevas e indice. No toca foto_key, precio, stock ni estado_analisis.

alter table productos add column portada_estado text check (portada_estado is null or portada_estado in ('lista','revisar','retomar','oficial','error'));
alter table productos add column portada_origen text check (portada_origen is null or portada_origen in ('ia','manual'));
alter table productos add column portada_fecha text;
alter table productos add column portada_revision text;
-- Cola del cron: las mas caras primero. Solo lo que no depende de existencia_tienda (la existencia se comprueba en la consulta).
create index productos_portadas_pendientes on productos (precio desc) where portada_estado is null and destino='etiqueta' and sin_inventario=0 and estado_analisis='listo' and estado_fisico<>'danado' and estado_fisico<>'liquidacion' and estado_fisico<>'caducado' and propietario='dolaron' and foto_key<>'' and codigo like 'ED-%';
