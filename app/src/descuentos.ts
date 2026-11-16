/**
 * Descuentos con aprobacion del dueno (Issue #119). El cajero pide un % o un
 * monto sobre el ticket completo, con motivo. Lo aprueba el dueno de tres
 * maneras, todas en `solicitudes` (tipo `descuento`), igual que las cancelaciones
 * (cancelaciones.ts): a distancia desde /cuentas (via 'remoto'), con su PIN en la
 * misma caja (via 'pin') o directo, si quien cobra es el dueno (via 'dueno').
 * Al cobrar, el servidor lo valida otra vez y lo resta: la aprobacion vale para
 * una sola venta y hasta 50%.
 *
 * Issue #845 (16/11): un cajero solo puede pedir hasta 10 %; mas, hasta el tope, lo
 * aprueba solo el dueno (su sesion o su PIN; un supervisor no). El descuento vale 30
 * minutos (aprobado: desde que se aprobo; pendiente: desde que se pidio), para el ticket
 * exacto que se pidio (huella de piezas, cantidades y subtotal; sustituye la regla del
 * 17/10 en que uno en pesos sobrevivia a los cambios) y solo para la caja que lo pidio.
 */
import { descuentoDe, huellaTicket, TOPE_DESCUENTO_CAJERO, VIGENCIA_DESCUENTO_MS } from '../public/venta.js';
import { leerUsuario, leerRoles } from './cuentas.ts';
import { verificarPin } from './cajeros.ts';
import { avisarDueno } from './avisos.ts';
import { cajaDe, CajaAjena } from './corte.ts';

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const pesos = (centavos: number) => `$${(centavos / 100).toFixed(2)}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Datos { tipo: string; valor: number; subtotal: number; monto: number; via?: string; huella?: string; caja?: string }

/** Cuando vence un descuento pedido o aprobado en `desde` (ISO). */
export const venceEn = (desde: string) => new Date(Date.parse(desde) + VIGENCIA_DESCUENTO_MS).toISOString();
/** Lo mas viejo que puede ser el inicio (creado_en o resuelto_en) de un descuento que aun vale. */
export const limiteVigencia = (ahoraMs = Date.now()) => new Date(ahoraMs - VIGENCIA_DESCUENTO_MS).toISOString();
/** El estado que ve la caja: un pendiente o aprobado pasado de 30 minutos es `vencida`. */
export function estadoVigente(fila: { estado: string; creado_en: string; resuelto_en: string | null }, ahoraMs = Date.now()) {
  const inicio = fila.estado === 'pendiente' ? fila.creado_en : fila.estado === 'aprobada' ? fila.resuelto_en : null;
  if (!inicio) return { estado: fila.estado, vence_en: null };
  return { estado: inicio < limiteVigencia(ahoraMs) ? 'vencida' : fila.estado, vence_en: venceEn(inicio) };
}

/**
 * El cajero pide un descuento. Una sola pendiente por persona: pedir otra
 * reemplaza la anterior. Con `aprobador` + `pin` (dueno) o siendo dueno quien
 * pide, nace aprobado; si no, queda pendiente para /cuentas.
 */
export async function pedirDescuento(request: Request, env: Env, correo: string, ctx: ExecutionContext | undefined, tienda: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const motivo = String(cuerpo.motivo ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!motivo) return json({ error: 'Escribe el motivo del descuento.' }, 400);
  const pedido = { tipo: String(cuerpo.tipo ?? ''), valor: Number(cuerpo.valor) };
  const subtotal = Number(cuerpo.subtotal);
  const calculo = descuentoDe(pedido, subtotal);
  if ('error' in calculo) return json({ error: calculo.error }, 400);
  // El ticket para el que se pide: sin sus piezas no hay a que atar el descuento (una caja sin recargar no las manda).
  const lineas = cuerpo.lineas;
  if (!Array.isArray(lineas) || !lineas.length || lineas.some((l) => !l || !UUID.test(String(l.producto_id)) || !Number.isInteger(Number(l.cantidad)) || Number(l.cantidad) < 1))
    return json({ error: 'Falta el detalle del ticket. Recarga la caja y vuelve a pedir el descuento.' }, 400);
  let caja: string;
  try { caja = await cajaDe(env, correo, cuerpo.caja, tienda); } catch (e) { if (e instanceof CajaAjena) return json({ error: e.message }, 400); throw e; }

  const usuario = await leerUsuario(env, correo);
  let aprobo: { por: string; via: 'dueno' | 'pin' } | null = null;
  if (usuario?.roles.includes('dueno')) {
    aprobo = { por: correo, via: 'dueno' };
  } else if (cuerpo.aprobador) {
    const dueno = String(cuerpo.aprobador).trim().toLowerCase();
    const verificado = await verificarPin(env, dueno, String(cuerpo.pin ?? ''), (roles) => roles.includes('dueno'));
    if ('error' in verificado) return json({ error: verificado.error }, verificado.status);
    aprobo = { por: dueno, via: 'pin' };
  }
  // Quien pide sin el dueno (ni su PIN) llega a 10 %; hasta 50 % solo con el dueno. Lo decide el servidor, no la caja.
  if (!aprobo && 'error' in descuentoDe(pedido, subtotal, TOPE_DESCUENTO_CAJERO))
    return json({ error: `Más de ${TOPE_DESCUENTO_CAJERO} %: lo aprueba el dueño con su PIN.` }, 403);

  const id = crypto.randomUUID();
  const ahora = new Date().toISOString();
  const datos: Datos = { ...pedido, subtotal, monto: calculo.monto, via: aprobo?.via ?? 'remoto', huella: huellaTicket(lineas, subtotal), caja };
  await env.DB.batch([
    env.DB.prepare(
      `update solicitudes set estado = 'rechazada', resuelto_en = ?, resuelto_por = 'reemplazada'
       where tipo = 'descuento' and correo = ? and estado = 'pendiente'`,
    ).bind(ahora, correo),
    env.DB.prepare(
      `insert into solicitudes (id, tipo, correo, nombre, justificacion, datos, estado, creado_en, resuelto_en, resuelto_por)
       values (?, 'descuento', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, correo, usuario?.nombre ?? '', motivo, JSON.stringify(datos), aprobo ? 'aprobada' : 'pendiente', ahora,
      aprobo ? ahora : null, aprobo?.por ?? null),
  ]);
  if (!aprobo) {
    avisarDueno(env, ctx, request, `Descuento por aprobar: ${pesos(calculo.monto)}`,
      `${usuario?.nombre || correo} pide ${pesos(calculo.monto)} de descuento sobre un ticket de ${pesos(subtotal)}.\nMotivo: ${motivo}`);
  }
  return json({ id, estado: aprobo ? 'aprobada' : 'pendiente', monto: calculo.monto, vence_en: venceEn(ahora) }, 201);
}

/** «Quitar descuento» en la caja: cierra la solicitud propia (pendiente o aprobada) si aun no se uso en una venta. */
export async function quitarDescuento(env: Env, id: string, correo: string): Promise<Response> {
  const propia = await env.DB.prepare(`select 1 as x from solicitudes where id = ? and tipo = 'descuento' and correo = ?`).bind(id, correo).first();
  if (!propia) return json({ error: 'La solicitud no existe.' }, 404);
  await env.DB.prepare(
    `update solicitudes set estado = 'rechazada', resuelto_en = ?, resuelto_por = 'quitada'
     where id = ? and estado in ('pendiente', 'aprobada') and not exists (select 1 from ventas where descuento_id = solicitudes.id)`,
  ).bind(new Date().toISOString(), id).run();
  return json({ id, estado: 'rechazada' });
}

/** Los duenos que pueden aprobar con PIN en la caja (activos y con PIN). */
export async function listarDuenos(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select correo, nombre, roles from usuarios where activo = 1 and pin_hash != '' order by nombre`,
  ).all<{ correo: string; nombre: string; roles: string }>();
  return json(results.filter((u) => leerRoles(u.roles).includes('dueno')).map(({ correo, nombre }) => ({ correo, nombre })));
}

/** El dueno aprueba o rechaza un descuento pendiente (la llama resolverSolicitud). */
export async function resolverDescuento(env: Env, id: string, aprobar: boolean, dueno: string): Promise<Response> {
  // Un solo UPDATE condicionado: si dos duenos la resuelven a la vez, gana uno. Una pendiente de mas de 30 minutos ya no se aprueba.
  const gano = await env.DB.prepare(
    `update solicitudes set estado = ?, resuelto_en = ?, resuelto_por = ? where id = ? and estado = 'pendiente' and creado_en >= ?`,
  ).bind(aprobar ? 'aprobada' : 'rechazada', new Date().toISOString(), dueno, id, limiteVigencia()).run();
  if (!gano.meta.changes) {
    const fila = await env.DB.prepare('select estado from solicitudes where id = ?').bind(id).first<{ estado: string }>();
    return json({ error: fila?.estado === 'pendiente' ? 'Esa solicitud venció (pasaron 30 minutos): que la pidan otra vez.' : 'Otro dueño ya la resolvió.' }, 409);
  }
  return json({ id, estado: aprobar ? 'aprobada' : 'rechazada' });
}

/** Para /cuentas y /avisos: los descuentos esperando al dueno (los de mas de 30 minutos ya no), con lo que hace falta para decidir. */
export async function listarDescuentos(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select id, correo, nombre, justificacion as motivo, creado_en,
       json_extract(datos, '$.tipo') as tipo, json_extract(datos, '$.valor') as valor,
       json_extract(datos, '$.subtotal') as subtotal, json_extract(datos, '$.monto') as monto
     from solicitudes where tipo = 'descuento' and estado = 'pendiente' and creado_en >= ? order by creado_en`,
  ).bind(limiteVigencia()).all();
  return json(results);
}

/** El ticket que cobra y quien lo cobra: contra esto se compara el descuento (Issue #845). */
export interface TicketDeCobro { subtotal: number; huella: string; correo: string; caja: string; ahoraMs: number }

/**
 * Al cobrar: la solicitud tiene que estar aprobada, vigente (30 minutos), ser de este mismo ticket
 * y de esta caja y no haberse usado. El monto se recalcula aqui, no se le cree a la caja. Devuelve
 * ademas la sentencia que lo vuelve a comprobar DENTRO del batch de la venta (una lectura previa no
 * ve lo que pase hasta que se escribe): si ya no vale, aborta toda la venta.
 */
export async function validarDescuento(
  env: Env, id: string, ticket: TicketDeCobro,
): Promise<{ ok: true; monto: number; guarda: D1PreparedStatement } | { ok: false; error: string; status: number }> {
  const fila = await env.DB.prepare(`select estado, datos, correo, resuelto_en from solicitudes where id = ? and tipo = 'descuento'`)
    .bind(id)
    .first<{ estado: string; datos: string; correo: string; resuelto_en: string | null }>();
  const falla = (error: string, status = 409) => ({ ok: false as const, error, status });
  if (!fila) return falla('El descuento no existe.', 400);
  if (fila.estado !== 'aprobada') {
    return falla(`El descuento esta ${fila.estado}: pide otro.`);
  }
  const limite = limiteVigencia(ticket.ahoraMs);
  if (!fila.resuelto_en || fila.resuelto_en < limite) return falla('El descuento venció (pasaron 30 minutos de aprobado): pide otro.');
  const datos = JSON.parse(fila.datos) as Datos;
  if (fila.correo !== ticket.correo || datos.caja !== ticket.caja) {
    return falla('Ese descuento lo pidió otra caja u otro cajero: pide otro.');
  }
  if (datos.huella !== ticket.huella) {
    return falla('El ticket cambio despues de aprobar el descuento: pide otro.');
  }
  const calculo = descuentoDe(datos, ticket.subtotal);
  if ('error' in calculo) return falla(String(calculo.error), 400);
  const usado = await env.DB.prepare('select id from ventas where descuento_id = ?').bind(id).first();
  if (usado) return falla('Ese descuento ya se uso en otra venta.');
  // Cero filas no aborta un batch; un NOT NULL violado si: `datos` queda en null (y la venta entera revierte) si algo de arriba cambio.
  const guarda = env.DB.prepare(
    `update solicitudes set datos = case when tipo = 'descuento' and estado = 'aprobada' and correo = ? and resuelto_en >= ?
       and json_extract(datos, '$.caja') = ? and json_extract(datos, '$.huella') = ? then datos else null end where id = ?`,
  ).bind(ticket.correo, limite, ticket.caja, ticket.huella, id);
  return { ok: true, monto: calculo.monto, guarda };
}

/** Ventana de la promo de inauguracion; null si no esta configurada. La usan la caja y el asistente (#499). */
export const promoDe = (env: Env) =>
  env.PROMO_DESDE && env.PROMO_HASTA && Date.parse(env.PROMO_DESDE) < Date.parse(env.PROMO_HASTA)
    ? { desde: env.PROMO_DESDE, hasta: env.PROMO_HASTA } : null;
/** Ventana del Buen Fin (#772); null si no esta configurada. La usan la venta del servidor y la caja (/api/vales/config). */
export const buenFinDe = (env: Env) =>
  env.BUENFIN_DESDE && env.BUENFIN_HASTA && Date.parse(env.BUENFIN_DESDE) < Date.parse(env.BUENFIN_HASTA)
    ? { desde: env.BUENFIN_DESDE, hasta: env.BUENFIN_HASTA } : null;
/**
 * Cuantas promos quedan del cupo (Issue #250, «a las primeras 100 personas»); null sin PROMO_CUPO = sin tope.
 * Un ticket cancelado devuelve su lugar. Solo cuentan las ventas de la ventana vigente: las de una
 * promo anterior (preinauguracion 10-12/10) se comian el cupo de la inauguracion (24/10).
 */
export async function promoRestantes(env: Env): Promise<number | null> {
  const cupo = Number(env.PROMO_CUPO);
  if (!env.PROMO_CUPO || !Number.isInteger(cupo) || cupo < 0) return null;
  const ventana = promoDe(env);
  // creado_en es ISO en UTC con milisegundos: se compara como texto contra el mismo formato.
  const limites = ventana ? [new Date(ventana.desde).toISOString(), new Date(ventana.hasta).toISOString()] : [];
  // ponytail: recorre ventas sin indice; un indice parcial en (promo) si la tabla crece a cientos de miles.
  const fila = await env.DB.prepare(`select count(*) as n from ventas where promo > 0 and cancelada = 0${
    ventana ? ' and creado_en >= ? and creado_en < ?' : ''}`).bind(...limites).first<{ n:number }>();
  return Math.max(0, cupo - (fila?.n ?? 0));
}
