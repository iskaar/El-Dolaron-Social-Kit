/**
 * Pago reportado por la revendedora (#609): su cliente ya pago un apartado por transferencia y ella manda la foto del
 * comprobante y/o la clave de rastreo desde «Mis ventas». El reporte NO da el pedido por pagado: la tienda lo acepta
 * registrando el abono de siempre (pedidos.ts cierra el reporte en el mismo batch) o lo rechaza con motivo. Mientras
 * esta pendiente el cron no vence el apartado. La foto es privada (solo el dueno, como en #603); el aviso al dueno
 * no lleva clave ni datos del cliente. Tablas: migracion 063.
 */
import { guardarYLeer } from './comprobante.ts';
import { dondeSeUso } from './transferencias.ts';
import { avisarDueno } from './avisos.ts';
import { bancoDe, claveRastreoDe, CLAVE_RASTREO } from '../public/venta.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LLAVE_FOTO = /^comprobantes\/[0-9a-f-]{36}\.jpg$/;
/** Cada foto cuesta una lectura de Claude: tope por venta (las que fallan al subir no cuentan). */
const FOTOS_POR_PEDIDO = 6;
/** Si la tienda rechaza un reporte cuando el apartado ya habia pasado su plazo, la revendedora tiene este margen para mandar el bueno. */
const GRACIA_RECHAZO_MS = 2 * 3_600_000;

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/** SQL: el pedido (expresion de su id) tiene un pago reportado sin revisar. */
export const hayReportePendiente = (pedidoId: string) =>
  `exists (select 1 from pagos_reportados where pedido_id = ${pedidoId} and estado = 'pendiente')`;

interface PedidoSuyo { id: string; folio: number; estado: string; saldo: number; liquidado_en: string | null; vendedora: string; telefono: string }
const SIN_PAGO = 'Ya no se puede mandar el pago de esta venta. Pregunta a la tienda.';

/**
 * Quien manda el pago. `quien` es lo que queda en reportado_por / subido_por: el correo de la revendedora (dueña = `vendedora`)
 * o 'portal:<id del socio>' (#670, dueño = el `telefono` del socio, de cualquier `vendedora`: tambien paga en linea lo que la tienda levanto
 * por WhatsApp a ese numero). `nombre` es solo para el aviso.
 */
export interface Dueno { quien: string; telefono?: string; nombre?: string }
const revendedora = (correo: string): Dueno => ({ quien: correo });

/** Solo su pedido, abierto y sin dinero registrado; null = no existe (o es de otro: no se distingue). */
async function pedidoSuyo(env: Env, folio: number, dueno: Dueno): Promise<PedidoSuyo | null> {
  const p = await env.DB.prepare('select id, folio, estado, saldo, liquidado_en, vendedora, telefono from pedidos where folio = ?')
    .bind(folio).first<PedidoSuyo>();
  return p && (dueno.telefono === undefined ? p.vendedora === dueno.quien : p.telefono === dueno.telefono) ? p : null;
}
const abierto = (p: PedidoSuyo) => p.estado === 'apartado' && Number(p.saldo) === 0 && !p.liquidado_en;

/** POST /api/vender/apartados/:folio/comprobante: sube la foto de SU apartado y devuelve lo que se leyo (mismo servicio que la caja). */
export const subirFotoDeRevendedora = (folio: number, request: Request, env: Env, correo: string) => subirFoto(folio, request, env, revendedora(correo));

export async function subirFoto(folio: number, request: Request, env: Env, dueno: Dueno): Promise<Response> {
  const p = await pedidoSuyo(env, folio, dueno);
  if (!p) return json({ error: 'El pedido no existe.' }, 404);
  if (!abierto(p)) return json({ error: SIN_PAGO }, 409);
  // ponytail: el tope se lee antes de subir; dos fotos a la vez pueden pasarse por una. Mejora: contar dentro del insert.
  const subidas = (await env.DB.prepare('select count(*) as n from comprobantes_subidos where pedido_id = ?').bind(p.id).first<{ n: number }>())?.n ?? 0;
  if (subidas >= FOTOS_POR_PEDIDO) return json({ error: 'Ya mandaste varias fotos de esta venta. Escribe la clave de rastreo o pide ayuda a la tienda.' }, 429);
  const r = await guardarYLeer(request, env);
  if (r instanceof Response) return r;
  await env.DB.prepare('insert into comprobantes_subidos (comprobante_key, pedido_id, subido_por, subido_en) values (?, ?, ?, ?)')
    .bind(r.key, p.id, dueno.quien, new Date().toISOString()).run();
  return json(r);
}

interface Reporte { id: number; pedido_id: string; estado: string; motivo: string; reportado_por: string; reportado_en: string }
const reporteDe = (r: Reporte) => ({ id: r.id, estado: r.estado, motivo: r.motivo, reportado_en: r.reportado_en });

const error = (mensaje: string, campo: string, status = 400) => json({ error: mensaje, campo }, status);

/** POST /api/vender/apartados/:folio/pago: `id` (UUID del navegador) hace idempotente el reintento. */
export const reportarPagoDeRevendedora = (folio: number, request: Request, env: Env, ctx: ExecutionContext, correo: string) =>
  reportarPago(folio, request, env, ctx, revendedora(correo));

export async function reportarPago(folio: number, request: Request, env: Env, ctx: ExecutionContext, dueno: Dueno): Promise<Response> {
  const c = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.id !== 'string' || !UUID.test(c.id)) return json({ error: 'Identificador inválido.' }, 400);
  const p = await pedidoSuyo(env, folio, dueno);
  if (!p) return json({ error: 'El pedido no existe.' }, 404);
  const leerPrevio = () => env.DB.prepare('select id, pedido_id, estado, motivo, reportado_por, reportado_en from pagos_reportados where solicitud_id = ?')
    .bind(c.id).first<Reporte>();
  const responder = (previo: Reporte) => previo.pedido_id === p.id && previo.reportado_por === dueno.quien
    ? json({ reporte: reporteDe(previo) }) : json({ error: 'El identificador ya corresponde a otro reporte.' }, 409);
  const previo = await leerPrevio();
  if (previo) return responder(previo);
  if (!abierto(p)) return json({ error: SIN_PAGO }, 409);

  const clave = claveRastreoDe(c.clave_rastreo);
  if (clave && !CLAVE_RASTREO.test(clave)) return error('La clave de rastreo lleva de 6 a 30 letras y números, sin acentos, guiones ni símbolos.', 'clave');
  const banco = bancoDe(c.banco_emisor);
  if (banco === undefined) return error('Ese banco no está en la lista.', 'banco');
  const monto = c.monto == null || c.monto === '' ? null : Number(c.monto);
  if (monto !== null && (!Number.isSafeInteger(monto) || monto <= 0)) return error('El monto del comprobante no es válido.', 'monto');
  const foto = c.comprobante_key == null || c.comprobante_key === '' ? null : String(c.comprobante_key);
  if (foto !== null && !(LLAVE_FOTO.test(foto) && await env.DB.prepare(
    'select 1 as x from comprobantes_subidos where comprobante_key = ? and pedido_id = ? and subido_por = ?').bind(foto, p.id, dueno.quien).first()))
    return error('Esa foto no es de esta venta. Súbela otra vez.', 'foto');
  if (!clave && !foto) return error('Manda la foto del comprobante o escribe la clave de rastreo.', 'clave');
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(c.fecha_comprobante)) && !Number.isNaN(Date.parse(String(c.fecha_comprobante))) ? String(c.fecha_comprobante) : null;

  // Una clave sirve para un solo pago: ni ya registrada, ni esperando en el reporte de otra venta. No se dice de cual (es ajena).
  if (clave && (await dondeSeUso(env, clave) !== null || await env.DB.prepare(
    "select 1 as x from pagos_reportados where clave_rastreo = ? and estado = 'pendiente' and pedido_id != ?").bind(clave, p.id).first()))
    return error('Esa clave ya se usó en otro pago. Pídele a tu cliente el comprobante de esta transferencia.', 'clave', 409);

  const ahora = new Date().toISOString();
  let marca;
  try {
    marca = await env.DB.prepare(`insert into pagos_reportados (pedido_id, solicitud_id, clave_rastreo, banco_emisor, monto, comprobante_key, fecha_comprobante, reportado_por, reportado_en)
      select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
      where exists (select 1 from pedidos where id = ?1 and estado = 'apartado' and saldo = 0 and liquidado_en is null
        and ${dueno.telefono === undefined ? 'vendedora = ?8' : 'telefono = ?10'})`)
      .bind(p.id, c.id, clave || null, banco, monto, foto, fecha, dueno.quien, ahora, ...(dueno.telefono === undefined ? [] : [dueno.telefono])).run();
  } catch (e) {
    // Dos envios a la vez: el segundo choca con la solicitud o con el unico pendiente del pedido.
    const ya = await leerPrevio();
    if (ya) return responder(ya);
    if (String(e).includes('UNIQUE')) return json({ error: 'Ya mandaste un pago de esta venta: la tienda lo está revisando.' }, 409);
    throw e;
  }
  if (!marca.meta.changes) return json({ error: SIN_PAGO }, 409);
  const creado = (await leerPrevio())!;
  // Sin clave ni telefono en el aviso. El socio del portal va con su nombre y «desde el portal».
  const nombre = dueno.telefono !== undefined ? dueno.nombre || 'Un socio'
    : (await env.DB.prepare('select nombre from usuarios where correo = ?').bind(dueno.quien).first<{ nombre: string }>())?.nombre || dueno.quien.split('@')[0];
  avisarDueno(env, ctx, request, 'Pago reportado', `${nombre} mandó el pago de P-${folio}${dueno.telefono !== undefined ? ' desde el portal' : ''}.`,
    { frase: 'Revísalo y regístralo o recházalo en', ruta: '/pedidos' });
  return json({ reporte: reporteDe(creado) }, 201);
}

/**
 * Lo ultimo que paso con el reporte de cada pedido de su dueno (60 dias): la revendedora por `vendedora` (chip de «Mis ventas»)
 * o el socio del portal por `telefono` (#669, «Mis apartados»; tambien salen los que levanto la tienda a ese numero).
 */
export async function reportesDe(env: Env, dueno: 'vendedora' | 'telefono', valor: string, desde: string) {
  const { results } = await env.DB.prepare(`select d.folio, r.estado, r.motivo, r.reportado_en
    from pagos_reportados r join pedidos d on d.id = r.pedido_id
    where d.${dueno === 'telefono' ? 'telefono' : 'vendedora'} = ? and r.reportado_en >= ? and r.id = (select max(id) from pagos_reportados where pedido_id = r.pedido_id)`)
    .bind(valor, desde).all<{ folio: number; estado: string; motivo: string; reportado_en: string }>();
  return new Map(results.map(({ folio, ...resto }) => [folio, resto]));
}
export const reportesDeRevendedora = (env: Env, correo: string, desde: string) => reportesDe(env, 'vendedora', correo, desde);

/** Los reportes por revisar, por id de pedido: /pedidos los pone junto a su apartado. La llave de la foto no es publica (solo el dueno la sirve). */
export async function reportesPendientes(env: Env) {
  const { results } = await env.DB.prepare(`select r.id, r.pedido_id, r.clave_rastreo as clave, r.banco_emisor, r.monto, r.comprobante_key,
      r.fecha_comprobante, r.reportado_en,
      case when r.reportado_por like 'portal:%' then d.cliente else coalesce(nullif(u.nombre, ''), r.reportado_por) end as revendedora,
      (r.reportado_por like 'portal:%') as desde_portal
    from pagos_reportados r join pedidos d on d.id = r.pedido_id left join usuarios u on u.correo = r.reportado_por where r.estado = 'pendiente'`)
    .all<{ id: number; pedido_id: string; [campo: string]: unknown }>();
  return new Map(results.map(({ pedido_id, ...resto }) => [pedido_id, resto]));
}

/** POST /api/pedidos/:folio/rechazar-pago { motivo }: quien puede recibir abonos. */
export async function rechazarPago(folio: number, request: Request, env: Env, correo: string): Promise<Response> {
  const c = await request.json().catch(() => ({})) as { motivo?: unknown };
  const motivo = String(c.motivo ?? '').replace(/\s+/g, ' ').trim();
  if (!motivo || motivo.length > 140) return json({ error: 'Escribe en pocas palabras por qué (hasta 140 letras). Quien lo mandó lo verá.' }, 400);
  const pedido = await env.DB.prepare('select id from pedidos where folio = ?').bind(folio).first<{ id: string }>();
  if (!pedido) return json({ error: 'El pedido no existe.' }, 404);
  const momento = new Date();
  const ahora = momento.toISOString();
  const gracia = new Date(momento.getTime() + GRACIA_RECHAZO_MS).toISOString();
  const [marca] = await env.DB.batch([
    env.DB.prepare("update pagos_reportados set estado = 'rechazado', motivo = ?, revisado_por = ?, revisado_en = ? where pedido_id = ? and estado = 'pendiente'")
      .bind(motivo, correo, ahora, pedido.id),
    // Vuelve a regir el plazo de siempre; si ya habia pasado (el cron lo saltaba por el reporte), un margen corto para que ella mande el bueno.
    env.DB.prepare(`update pedidos set vence_en = ?1, actualizado_en = ?2 where id = ?3 and estado = 'apartado' and vence_en <= ?2
      and exists (select 1 from pagos_reportados where pedido_id = ?3 and estado = 'rechazado' and revisado_en = ?2)`)
      .bind(gracia, ahora, pedido.id),
  ]);
  if (!marca.meta.changes) return json({ error: 'Ya no hay un pago por revisar en este pedido. Actualiza la lista.' }, 409);
  return json({ ok: true, folio });
}

/** GET /api/pagos-reportados/:id/comprobante: la foto, solo para el dueno (la ruta es suya en cuentas.ts por omision); nunca en cache. */
export async function verFotoReportada(env: Env, id: number): Promise<Response> {
  const f = await env.DB.prepare('select comprobante_key from pagos_reportados where id = ?').bind(id).first<{ comprobante_key: string | null }>();
  const objeto = f?.comprobante_key ? await env.FOTOS.get(f.comprobante_key) : null;
  if (!objeto) return json({ error: 'Este reporte no tiene foto.' }, 404);
  return new Response(objeto.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}
