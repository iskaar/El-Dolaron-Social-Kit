/**
 * Pedidos por WhatsApp, fase 1 (Issue #269). Apartar = recibir el anticipo y
 * bajar la existencia en D1 (el maestro de stock). Si el apartado vence o se
 * cancela, las piezas vuelven a la venta y el anticipo queda como saldo a favor
 * un mes. La venta que cierra el pedido pasa por registrarVenta (worker.ts), que
 * gasta el saldo con `sentenciasDePedido`; el corte (corte.ts) cuenta el
 * anticipo en la caja donde entro y las ventas restan lo que pagaron con el.
 */

import { cajaDe } from './corte.ts';
import { sumarMeses } from './dolarones.ts';
import { conciliarSeguro } from './mercadolibre.ts';
import { VENDIBLE } from './catalogo.ts';
import { sentenciasVale } from './vales.ts';
import { envioDe, anticipoMinimoDe, ANTICIPO, viernesDeEnvio, claveRastreoDe } from '../public/venta.js';
import { leerTransferencia, sentenciaTransferencia, respuestaClaveUsada, esChoqueDeClave, excedenteDe } from './transferencias.ts';
import { hayReportePendiente, reportesDe, reportesPendientes, rechazarPago } from './pagos-reportados.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAS_PAGO = new Set(['efectivo', 'tarjeta', 'transferencia']);
export const DIAS_APARTADO = 7;
// Revendedora externa (#575): aparta sin anticipo. El plazo corto lo cierra el cron de siempre (vence_en).
export const HORAS_REVENDEDORA = 48;
// Socio del portal (#668): aparta en linea sin anticipo y paga por transferencia; sin pago, 24 h y la pieza vuelve. Al registrar su abono se extiende a 7 dias.
export const HORAS_PORTAL = 24;
// Apartados sin pago a la vez por socio: frena que una cuenta deje media tienda trabada 24 h.
export const APARTADOS_PORTAL = 3;
// ponytail: el tope se lee justo antes del batch; dos apartados a la vez pueden pasarse por una pieza.
// Mejora: contar dentro del insert del pedido si algun dia importa.
const PIEZAS_REVENDEDORA = 10;
type Modo = 'caja' | 'revendedora' | 'portal';
const LIMITE_LISTA = 200;
const ENVIO_ID = '00000000-0000-4000-8000-000000000099';

/** Lo que dice el 409 de cancelar un ticket que uso saldo de pedido (devoluciones.ts y cancelaciones.ts). */
export const TICKET_CON_ANTICIPO =
  'Este ticket usó saldo de un pedido; por ahora no se cancela en la caja. Avisa al dueño.';
// ponytail: cancelar un ticket con anticipo pide devolver el saldo al pedido (o dinero) y ajustar el corte
// de dos cajas; hasta que se necesite lo resuelve el dueno a mano. Mejora: reponer `saldo` en el mismo batch.

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/* ---------- lectura ---------- */

const COLUMNAS = `id, folio, cliente, telefono, entrega, envio, vendedora, estado, vence_en, anticipo, forma_pago,
  saldo, saldo_vence_en, guia, venta_id, creado_en, actualizado_en, revision, liquidado_en, caja,
  (select u.nombre from usuarios u where u.correo = pedidos.vendedora) as vendedora_nombre`;

interface FilaPedido {
  id: string; folio: number; estado: string; entrega: string; envio: number; saldo: number;
  vendedora: string; cliente: string; telefono: string; creado_en: string;
  anticipo: number; vence_en: string; saldo_vence_en: string; revision: number; liquidado_en: string | null; caja: string; forma_pago: string; guia: string;
  [campo: string]: unknown;
}
interface LineaPedido { pedido_id: string; producto_id: string; codigo: string; nombre: string; precio: number; cantidad: number }

/** El paquete conserva el precio pactado; recoger mantiene el precio de catálogo de #269. */
async function leerPedidos(env: Env, donde: string, args: unknown[], orden = 'folio desc', limite = LIMITE_LISTA) {
  const { results } = await env.DB.prepare(
    `select ${COLUMNAS} from pedidos where ${donde} order by ${orden} limit ${limite}`,
  ).bind(...args).all<FilaPedido>();
  if (!results.length) return [];
  const { results: piezas } = await env.DB.prepare(
    `select l.pedido_id, p.id as producto_id, p.codigo, p.nombre,
       case when pe.entrega = 'envio' then l.precio else p.precio end as precio, l.cantidad
     from pedido_lineas l join productos p on p.id = l.producto_id join pedidos pe on pe.id = l.pedido_id
     where l.pedido_id in (select id from pedidos where ${donde}) order by p.nombre`,
  ).bind(...args).all<LineaPedido>();
  return results.map((fila) => {
    const lineas = piezas.filter((l) => l.pedido_id === fila.id).map(({ pedido_id, ...resto }) => resto);
    const subtotal = lineas.reduce((suma, l) => suma + l.precio * l.cantidad, 0);
    return { ...fila, subtotal, lineas,
      faltante: fila.estado === 'apartado' ? Math.max(0, subtotal + Number(fila.envio) - Number(fila.saldo)) : 0,
      viernes_envio: fila.liquidado_en ? viernesDeEnvio(String(fila.liquidado_en)) : null };
  });
}

const pedidoPor = async (env: Env, donde: string, valor: unknown) => (await leerPedidos(env, donde, [valor], 'folio', 1))[0] ?? null;

/* ---------- stock ---------- */

/**
 * Devuelve a la venta las piezas del pedido, SOLO si sigue apartado. Va siempre
 * antes de la sentencia que cambia su estado, en el mismo batch: la condicion se
 * evalua en SQL, asi que dos cancelaciones (o el cron y una venta) juntas
 * regresan la existencia una sola vez.
 */
export const devolverApartado = (env: Env, pedidoId: string, ahora: string, condicion = '', ...extra: unknown[]) => env.DB.prepare(
  `update productos set stock = stock + (select cantidad from pedido_lineas where pedido_id = ?1 and producto_id = productos.id),
                        actualizado_en = ?2
   where id in (select producto_id from pedido_lineas where pedido_id = ?1)
     and exists (select 1 from pedidos where id = ?1 and estado = 'apartado' ${condicion})`,
).bind(pedidoId, ahora, ...extra);

async function productosDe(env: Env, pedidoId: string): Promise<string[]> {
  const { results } = await env.DB.prepare('select producto_id from pedido_lineas where pedido_id = ?')
    .bind(pedidoId).all<{ producto_id: string }>();
  return results.map((f) => f.producto_id);
}

/** Una pieza que ya esta en algun pedido no se puede borrar de productos (FK): worker.ts responde 409 en vez de 500. */
export async function enPedido(env: Env, productoId: string): Promise<boolean> {
  return (await env.DB.prepare('select 1 as x from pedido_lineas where producto_id = ? limit 1').bind(productoId).first()) !== null;
}

/* ---------- venta con saldo ---------- */

/**
 * El saldo de un pedido pagando parte de una venta, para el batch de registrarVenta
 * (debe ir despues del insert de la venta, por la FK, y antes de descontar su
 * stock). Si el pedido sigue apartado sus piezas regresan a la venta y pasa a
 * `vendido`; lo que la venta no se lleve queda disponible. El CHECK saldo >= 0
 * aborta el batch si otra venta gasto el saldo (o ya vencio) entre la lectura y aqui.
 */
export async function sentenciasDePedido(env: Env, p: {
  pedidoId: string; ventaId: string; anticipo: number; ahora: string;
  total: number; lineas: { producto_id: string; cantidad: number; precio: number }[];
}): Promise<{ ok: true; sentencias: D1PreparedStatement[] } | { ok: false; error: string; status: number }> {
  const pedido = await env.DB.prepare('select saldo, saldo_vence_en, estado, entrega, revision, liquidado_en from pedidos where id = ?')
    .bind(p.pedidoId).first<{ saldo: number; saldo_vence_en: string; estado: string; entrega: string; revision: number; liquidado_en: string | null }>();
  if (!pedido) return { ok: false, status: 409, error: 'El pedido no existe.' };
  const envioApartado = pedido.estado === 'apartado' && pedido.entrega === 'envio';
  if (envioApartado) {
    // Los paquetes nuevos se liquidan con abonos. Los ya pagados de #269 todavía cierran en caja.
    const completo = await pedidoPor(env, 'id = ?', p.pedidoId);
    const esperadas = [...completo!.lineas, ...(Number(completo!.envio) > 0
      ? [{ producto_id: ENVIO_ID, cantidad: 1, precio: Number(completo!.envio) }] : [])];
    if (!pedido.liquidado_en || p.anticipo !== pedido.saldo || p.total !== pedido.saldo
      || p.lineas.length !== esperadas.length
      || esperadas.some((l) => !p.lineas.some((v) => v.producto_id === l.producto_id && v.cantidad === l.cantidad && v.precio === l.precio)))
      return { ok: false, status: 409, error: 'Liquida el paquete completo desde Pedidos; no se puede gastar su saldo en otro ticket.' };
  }
  if (pedido.saldo < p.anticipo || (!envioApartado && pedido.saldo_vence_en <= p.ahora))
    return { ok: false, status: 409, error: 'El saldo del pedido cambió o venció. Vuelve a cargarlo.' };
  return {
    ok: true,
    sentencias: [
      devolverApartado(env, p.pedidoId, p.ahora),
      env.DB.prepare(
        `update pedidos set saldo = case when revision = ?5 and (saldo_vence_en > ?1
                              or (estado = 'apartado' and entrega = 'envio' and liquidado_en is not null))
                              then saldo - ?2 else -1 end,
                            estado = case when estado = 'apartado' then 'vendido' else estado end,
                            venta_id = case when estado = 'apartado' then ?3 else venta_id end,
                            actualizado_en = ?1, revision = revision + 1
         where id = ?4`,
      ).bind(p.ahora, p.anticipo, p.ventaId, p.pedidoId, pedido.revision),
    ],
  };
}

export const saldoDe = async (env: Env, pedidoId: string) =>
  (await env.DB.prepare('select saldo from pedidos where id = ?').bind(pedidoId).first<{ saldo: number }>())?.saldo ?? 0;

/**
 * Al liquidar se emite el ticket en el mismo batch. El stock ya se apartó y el dinero
 * ya entró como anticipo/abonos: ventas.anticipo cubre el total, sin cobrarlos otra vez.
 */
async function ventaDePaquete(env: Env, pedidoId: string, ventaId: string, total: number, ahora: string,
  correo: string, caja: string, formaPago: string): Promise<D1PreparedStatement[]> {
  const vale = await sentenciasVale(env, { ventaId, clienteId: null, codigo: '', dolarones: 0,
    total, autor: correo, ahora: new Date(ahora) });
  if (!vale.ok) throw new Error(vale.error);
  return [
    env.DB.prepare(`insert into ventas (id, total, forma_pago, efectivo, cambio, creado_en, registrado_en,
      caja, cajero, anticipo, pedido_id) values (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`)
      .bind(ventaId, total, formaPago, ahora, ahora, caja, correo, total, pedidoId),
    env.DB.prepare(`insert into venta_lineas (venta_id, producto_id, codigo, nombre, precio, cantidad, propietario)
      select ?1, p.id, p.codigo, p.nombre, l.precio, l.cantidad, 'dolaron'
      from pedido_lineas l join productos p on p.id = l.producto_id where l.pedido_id = ?2
      union all select ?1, ?3, 'ENVIO', 'Envío', envio, 1, 'dolaron' from pedidos where id = ?2 and envio > 0`)
      .bind(ventaId, pedidoId, ENVIO_ID),
    env.DB.prepare(`update pedidos set saldo = case when saldo >= ?1 then saldo - ?1 else -1 end,
      estado = 'vendido', venta_id = ?2, liquidado_en = ?3, actualizado_en = ?3 where id = ?4`)
      .bind(total, ventaId, ahora, pedidoId),
    ...vale.sentencias,
  ];
}

/* ---------- API ---------- */

const texto = (valor: unknown, max: number) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Solo digitos; un 52 al inicio sobra. null si no quedan 10. */
export function telefonoDe(valor: unknown): string | null {
  let digitos = String(valor ?? '').replace(/\D/g, '');
  if (digitos.length === 12 && digitos.startsWith('52')) digitos = digitos.slice(2);
  return digitos.length === 10 ? digitos : null;
}

/**
 * `revendedora` (#575) y `portal` (#668): el mismo pedido sin dinero de por medio. Sin anticipo, saldo ni caja, plazo corto
 * (48 h / 24 h), envio sin cobrar el paquete. Lo decide quien llama segun la cuenta, nunca el cuerpo de la peticion: en `portal`
 * `correo` es la constante 'portal' y el dueno es el telefono del socio.
 */
const crearPedido = async (request: Request, env: Env, ctx: ExecutionContext, correo: string, modo: Modo = 'caja'): Promise<Response> =>
  crearPedidoDe((await request.json().catch(() => ({}))) as Record<string, unknown>, env, ctx, correo, modo);

async function crearPedidoDe(cuerpo: Record<string, unknown>, env: Env, ctx: ExecutionContext, correo: string, modo: Modo): Promise<Response> {
  const sinDinero = modo !== 'caja';
  const id = String(cuerpo.id ?? '');
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  // Reintento tras red caida: el mismo pedido, sin bajar otra vez la existencia.
  const previo = await pedidoPor(env, 'id = ?', id);
  if (previo) {
    const ajeno = modo === 'revendedora' ? previo.vendedora !== correo
      : modo === 'portal' && (previo.vendedora !== correo || previo.telefono !== telefonoDe(cuerpo.telefono));
    return ajeno
      ? json({ error: 'El identificador ya corresponde a otro pedido.' }, 409)
      : json({ pedido: previo, excedente_transferencia: await excedenteDe(env, 'anticipo', id) });
  }

  if (!Array.isArray(cuerpo.lineas) || cuerpo.lineas.length < 1 || cuerpo.lineas.length > 20)
    return json({ error: 'Un pedido lleva de 1 a 20 piezas.' }, 400);
  const cantidades = new Map<string, number>();
  for (const l of cuerpo.lineas as Record<string, unknown>[]) {
    const productoId = String(l?.producto_id ?? '');
    const cantidad = Number(l?.cantidad);
    if (!UUID.test(productoId) || !Number.isInteger(cantidad) || cantidad < 1 || cantidad > 999)
      return json({ error: 'Pieza o cantidad invalida.' }, 400);
    cantidades.set(productoId, (cantidades.get(productoId) ?? 0) + cantidad);
  }
  const cliente = texto(cuerpo.cliente, 81);
  if (!cliente || cliente.length > 80) return json({ error: 'Escribe el nombre del cliente (hasta 80 letras).' }, 400);
  const telefono = telefonoDe(cuerpo.telefono);
  if (!telefono) return json({ error: 'El WhatsApp debe tener 10 digitos.' }, 400);
  const entrega = String(cuerpo.entrega ?? '');
  if (entrega !== 'tienda' && entrega !== 'envio') return json({ error: 'Entrega invalida.' }, 400);
  // forma_pago es NOT NULL con CHECK: sin dinero recibido da igual, 'transferencia' es lo que se cobrara despues.
  const formaPago = sinDinero ? 'transferencia' : String(cuerpo.forma_pago ?? '');
  if (!FORMAS_PAGO.has(formaPago)) return json({ error: 'Forma de pago invalida.' }, 400);
  const caja = sinDinero ? '' : await cajaDe(env, correo, cuerpo.caja);
  if (!sinDinero && !caja) return json({ error: 'Falta la caja.' }, 400);

  const ids = [...cantidades.keys()];
  const { results: filas } = await env.DB.prepare(
    `select id, codigo, precio, sin_inventario, propietario from productos where id in (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<{ id: string; codigo: string | null; precio: number; sin_inventario: number; propietario: string }>();
  // FEP no acepta anticipos en tienda (decision de Isaac, #269): el anticipo no tiene a donde ir en su caja.
  if (filas.some((p) => p.propietario === 'fep'))
    return json({ error: 'Las piezas de FEP no se pueden apartar: no aceptamos anticipos de FEP en tienda.' }, 400);
  if (filas.length !== ids.length || filas.some((p) => !p.codigo || !(p.precio > 0) || p.sin_inventario !== 0))
    return json({ error: 'Solo piezas con etiqueta.' }, 400);

  const subtotal = filas.reduce((suma, p) => suma + p.precio * cantidades.get(p.id)!, 0);
  const envio = entrega === 'envio' ? envioDe(subtotal) : 0;
  const total = subtotal + envio;
  const anticipo = sinDinero ? 0 : Number(cuerpo.anticipo);
  const minimo = sinDinero ? 0 : anticipoMinimoDe(subtotal);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(anticipo) || anticipo < minimo || anticipo > total)
    return json({ error: `El anticipo mínimo es $${minimo / 100} y no pasa del total.` }, 400);
  // Envío: el paquete abre con $100 (o el total de las piezas si cuestan menos); el resto entra como abonos.
  if (!sinDinero && entrega === 'envio' && anticipo !== minimo && anticipo !== ANTICIPO)
    return json({ error: 'El paquete de envío se abre con $100 (o el total de las piezas si cuestan menos); el resto se recibe como abonos.' }, 400);
  // Transferencia (#593): todo anticipo de apartado o envio por transferencia lleva la clave de rastreo del comprobante.
  const transf = !sinDinero && formaPago === 'transferencia' && anticipo > 0 ? leerTransferencia(cuerpo, anticipo) : null;
  if (transf && !transf.ok) return json({ error: transf.error, campo: transf.campo }, 400);
  const usada = transf && await respuestaClaveUsada(env, transf.clave);
  if (usada) return usada;
  if (modo === 'portal') {
    // ponytail: el tope se lee justo antes del batch; dos apartados a la vez pueden pasarse por uno (como el de revendedora).
    // Mejora: contar dentro del insert del pedido si algun dia importa. Solo cuentan los que siguen sin pago.
    const abiertos = (await env.DB.prepare("select count(*) as n from pedidos where vendedora = ? and telefono = ? and estado = 'apartado' and saldo = 0")
      .bind(correo, telefono).first<{ n: number }>())?.n ?? 0;
    if (abiertos >= APARTADOS_PORTAL)
      return json({ error: `Ya tienes ${APARTADOS_PORTAL} apartados sin pago. Paga o cancela alguno para apartar otra pieza.` }, 409);
  }
  if (modo === 'revendedora') {
    // Solo cuentan las que siguen sin pago: una ya pagada y por recoger no bloquea seguir vendiendo.
    const abiertas = (await env.DB.prepare(`select coalesce(sum(l.cantidad), 0) as n from pedidos d
      join pedido_lineas l on l.pedido_id = d.id where d.estado = 'apartado' and d.saldo = 0 and d.vendedora = ?`)
      .bind(correo).first<{ n: number }>())?.n ?? 0;
    if (abiertas + [...cantidades.values()].reduce((suma, n) => suma + n, 0) > PIEZAS_REVENDEDORA)
      return json({ error: `Máximo ${PIEZAS_REVENDEDORA} piezas apartadas sin pago a la vez (ahora tienes ${abiertas}). Espera a que la tienda registre el pago o cancela alguna.` }, 409);
  }

  const momento = new Date();
  const ahora = momento.toISOString();
  const vence = new Date(momento.getTime() + (modo === 'portal' ? HORAS_PORTAL * 3_600_000 : modo === 'revendedora' ? HORAS_REVENDEDORA * 3_600_000 : DIAS_APARTADO * 86_400_000));
  try {
    await env.DB.batch([
      env.DB.prepare(
        `insert into pedidos (id, folio, cliente, telefono, entrega, envio, vendedora, estado, vence_en, anticipo,
                              forma_pago, caja, saldo, saldo_vence_en, creado_en, actualizado_en)
         values (?, (select coalesce(max(folio), 0) + 1 from pedidos), ?, ?, ?, ?, ?, 'apartado', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, cliente, telefono, entrega, envio, correo, vence.toISOString(), anticipo, formaPago, caja,
        anticipo, sumarMeses(vence, 1), ahora, ahora),
      ...(transf ? [sentenciaTransferencia(env, transf, correo, ahora, 'anticipo', { pedido: id })] : []),
      ...ids.map((productoId) => env.DB.prepare(
        'insert into pedido_lineas (pedido_id, producto_id, cantidad, precio) values (?, ?, ?, ?)',
      ).bind(id, productoId, cantidades.get(productoId), filas.find((p) => p.id === productoId)!.precio)),
      // Sin max(0, ...): el trigger stock_no_negativo (migracion 006) aborta todo el batch si ya no hay.
      ...ids.map((productoId) => env.DB.prepare(
        `update productos set stock = case when precio = ?4 and propietario = 'dolaron' and sin_inventario = 0
           and codigo is not null and codigo != '' then stock - ?1 else -1 end, actualizado_en = ?2 where id = ?3`,
      ).bind(cantidades.get(productoId), ahora, productoId, filas.find((p) => p.id === productoId)!.precio)),
      ...(entrega === 'envio' && anticipo === total ? await ventaDePaquete(env, id, id, total, ahora, correo, caja, formaPago) : []),
    ]);
  } catch (error) {
    // Dos envios del mismo pedido a la vez: el segundo choca con la llave y el primero ya quedo.
    const ya = await pedidoPor(env, 'id = ?', id);
    if (ya) return json({ pedido: ya, excedente_transferencia: await excedenteDe(env, 'anticipo', id) });
    if (transf && esChoqueDeClave(error)) return (await respuestaClaveUsada(env, transf.clave)) ?? json({ error: 'Esa clave de rastreo ya se usó.', campo: 'clave' }, 409);
    if (String(error).includes('stock insuficiente')) return json({ error: 'Alguna pieza ya no está disponible.' }, 409);
    throw error;
  }
  // Las piezas apartadas dejan de estar a la venta tambien en Mercado Libre (D1 manda).
  ctx.waitUntil(conciliarSeguro(env, { productoIds: ids }));
  return json({ pedido: await pedidoPor(env, 'id = ?', id), excedente_transferencia: transf?.ok ? transf.excedente : 0 }, 201);
}

/** Apartados, envios por mandar y saldos a favor vigentes. */
async function listarPedidos(env: Env): Promise<Response> {
  const ahora = new Date().toISOString();
  const pedidos = await leerPedidos(
    env,
    `(estado = 'apartado' or (estado = 'vendido' and entrega = 'envio' and guia = '')
      or (estado != 'apartado' and saldo > 0 and saldo_vence_en > ?))`,
    [ahora],
    `estado != 'apartado', case when estado = 'apartado' then vence_en else '' end, actualizado_en desc`,
  );
  // #609: el pago que reporto la revendedora y la tienda aun no revisa, junto a su apartado.
  const reportes = await reportesPendientes(env);
  return json({ pedidos: pedidos.map((p) => ({ ...p, reporte: reportes.get(p.id) ?? null })) });
}

/** Apartar como revendedora (#575): `POST /api/vender/apartar`. */
export const apartarRevendedora = (request: Request, env: Env, ctx: ExecutionContext, correo: string) =>
  crearPedido(request, env, ctx, correo, 'revendedora');

/** `vendedora` de todo apartado que levanta el portal: no es un correo, es el canal. /pedidos lo muestra como «Portal». */
export const VENDEDORA_PORTAL = 'portal';
const CODIGO_PIEZA = /^ED-\d{1,10}$/;

/** Piezas por pedido del portal (#681): el carrito del navegador topa en lo mismo. */
export const PIEZAS_PORTAL = 10;

/** De las piezas pedidas, las que ya no se pueden apartar (no vendibles o sin existencia). Se consulta tambien tras un 409 del batch. */
async function noDisponibles(env: Env, codigos: string[]): Promise<string[]> {
  const { results } = await env.DB.prepare(`select p.codigo from productos p where p.codigo in (${codigos.map(() => '?').join(',')}) and (${VENDIBLE})`)
    .bind(...codigos).all<{ codigo: string }>();
  const hay = new Set(results.map((f) => f.codigo));
  return codigos.filter((c) => !hay.has(c));
}
const textoNoDisponibles = (n: number, de: number) => n === 1 ? (de === 1 ? 'Esa pieza ya no está disponible.' : 'Una pieza ya no está disponible.') : `${n} piezas ya no están disponibles.`;

/**
 * Apartar desde el portal (#668, carrito en #681): `POST /api/portal/apartar { id, codigos: ['ED-…', …], entrega }` (`codigo` suelto
 * sigue valiendo: es una lista de una). Nada del cuerpo es de confianza salvo las piezas y la entrega: nombre y telefono salen del socio
 * autenticado y el precio, el anticipo y el envio de `productos` / `venta.js`. Lo demas es `crearPedido` en modo portal
 * (stock - 1 de cada pieza en el mismo batch que el pedido, UUID idempotente, 24 h de plazo, tope de 3 pedidos sin pago).
 * Si alguna ya no esta, el batch entero se deshace: 409 con `no_disponibles` para que la pantalla las quite y reintente.
 */
export async function apartarPortal(request: Request, env: Env, ctx: ExecutionContext, socio: { nombre: string; telefono: string }): Promise<Response> {
  const sinCache = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  const cuerpo = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return json({ error: 'Pedido inválido.' }, 400);
  const id = String(cuerpo.id ?? '');
  const telefono = telefonoDe(socio.telefono);
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!telefono) return json({ error: 'Tu teléfono necesita revisión en la tienda antes de apartar.' }, 409);
  // El reintento de un apartado que ya bajo la existencia no vuelve a buscar las piezas (ya no son VENDIBLE): lo responde crearPedidoDe.
  let lineas: { producto_id: string; cantidad: number }[] = [];
  let codigos: string[] = [];
  if (!await pedidoPor(env, 'id = ?', id)) {
    const pedidos = Array.isArray(cuerpo.codigos) ? cuerpo.codigos : [cuerpo.codigo];
    codigos = [...new Set(pedidos.map((c) => String(c ?? '').trim().toUpperCase()))];   // son piezas unicas: una unidad por codigo
    if (pedidos.length > PIEZAS_PORTAL || codigos.length > PIEZAS_PORTAL) return json({ error: `Un pedido lleva hasta ${PIEZAS_PORTAL} piezas.` }, 400);
    if (!codigos.length || codigos.some((c) => !CODIGO_PIEZA.test(c))) return json({ error: 'Código de pieza inválido.' }, 400);
    const { results } = await env.DB.prepare(`select p.id, p.codigo, (${VENDIBLE}) as vendible from productos p where p.codigo in (${codigos.map(() => '?').join(',')})`)
      .bind(...codigos).all<{ id: string; codigo: string; vendible: number }>();
    const faltan = codigos.filter((c) => !results.some((f) => f.codigo === c));
    if (faltan.length) return json({ error: codigos.length === 1 ? 'La pieza no existe.' : `${faltan.length === 1 ? 'Una pieza no existe' : `${faltan.length} piezas no existen`}.`, no_disponibles: faltan }, 404);
    const fuera = results.filter((f) => !f.vendible).map((f) => f.codigo);
    if (fuera.length) return json({ error: textoNoDisponibles(fuera.length, codigos.length), no_disponibles: fuera }, 409);
    lineas = results.map((f) => ({ producto_id: f.id, cantidad: 1 }));
  }
  const r = await crearPedidoDe({ id, lineas, cliente: socio.nombre.slice(0, 80), telefono, entrega: cuerpo.entrega }, env, ctx, VENDEDORA_PORTAL, 'portal');
  if (r.status !== 200 && r.status !== 201) {
    // Ganada por otro entre la lectura y el batch: el batch se deshizo completo; se dice cuales ya no estan.
    const falla = await r.json() as Record<string, unknown>;
    const fuera = r.status === 409 && codigos.length && /ya no está disponible/.test(String(falla.error)) ? await noDisponibles(env, codigos) : [];
    return new Response(JSON.stringify(fuera.length ? { ...falla, error: textoNoDisponibles(fuera.length, codigos.length), no_disponibles: fuera } : falla),
      { status: r.status, headers: sinCache });
  }
  const { pedido } = await r.json() as { pedido: NonNullable<Awaited<ReturnType<typeof pedidoPor>>> };
  return new Response(JSON.stringify({
    pedido: { folio: pedido.folio, vence_en: pedido.vence_en, entrega: pedido.entrega, envio: pedido.envio, subtotal: pedido.subtotal,
      lineas: pedido.lineas.map(({ codigo, nombre, precio, cantidad }) => ({ codigo, nombre, precio, cantidad })) },
    // Envio: el paquete abre con esto y el resto entra como abonos (misma regla de crearPedido); recoger: es el apartado.
    a_pagar: anticipoMinimoDe(pedido.subtotal), concepto: `P-${pedido.folio}`,
    // Banco, CLABE y titular los pone Isaac en el panel de Cloudflare; nunca viven en el repo.
    datos_pago: env.PORTAL_DATOS_PAGO?.trim() || null,
  }), { status: r.status, headers: sinCache });
}

/**
 * Los apartados de un dueno (la revendedora por `vendedora`, el socio del portal por `telefono`): los abiertos (indice por estado)
 * y lo de los ultimos 60 dias, con el ultimo reporte de pago de cada uno.
 * ponytail: pedidos no tiene indice por vendedora ni telefono; el historial se acota a los ultimos 400 folios.
 * Mejora: indice (vendedora, creado_en) / (telefono, creado_en) en una migracion cuando el volumen lo pida.
 */
async function pedidosDe(env: Env, dueno: 'vendedora' | 'telefono', valor: string) {
  const columna = dueno === 'telefono' ? 'telefono' : 'vendedora';
  const desde = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const [abiertos, recientes, reportes] = await Promise.all([
    leerPedidos(env, `estado = 'apartado' and ${columna} = ?`, [valor], 'folio desc', 50),
    leerPedidos(env, `folio > (select coalesce(max(folio), 0) - 400 from pedidos) and ${columna} = ? and creado_en >= ?`, [valor, desde], 'folio desc', 100),
    reportesDe(env, dueno, valor, desde),
  ]);
  const porFolio = new Map([...recientes, ...abiertos].map((p) => [p.folio, p]));
  return { pedidos: [...porFolio.values()].sort((a, b) => b.folio - a.folio), reportes };
}

/** Los apartados de una revendedora (#575). */
export async function pedidosDeRevendedora(env: Env, correo: string): Promise<Response> {
  const { pedidos: todos, reportes } = await pedidosDe(env, 'vendedora', correo);
  const pedidos = todos.map((p) => ({
    folio: p.folio, estado: p.estado, vence_en: p.vence_en, cliente: p.cliente, telefono: p.telefono, entrega: p.entrega,
    envio: p.envio, saldo: p.saldo, creado_en: p.creado_en, subtotal: p.subtotal, liquidado_en: p.liquidado_en,
    lineas: p.lineas.map(({ codigo, nombre, precio, cantidad }) => ({ codigo, nombre, precio, cantidad })),
    // Con dinero registrado, o con un pago por revisar (#609), ya solo lo cancela la tienda.
    cancelable: p.estado === 'apartado' && Number(p.saldo) === 0 && reportes.get(p.folio)?.estado !== 'pendiente',
    // Lo ultimo que paso con el pago que ella reporto: { estado: pendiente | aceptado | rechazado, motivo, reportado_en } o null.
    pago_reportado: reportes.get(p.folio) ?? null,
  }));
  return json({ pedidos });
}

/**
 * Los apartados de un socio del portal (#669): por telefono (el vinculo socio-pedido), asi tambien salen los que la tienda levanto
 * por WhatsApp a ese numero. Nunca `caja`, `corte_id`, `vendedora` ni nada de otros clientes.
 */
export async function apartadosDeSocio(env: Env, telefono: string): Promise<Response> {
  const { pedidos, reportes } = await pedidosDe(env, 'telefono', telefono);
  return new Response(JSON.stringify({ datos_pago: env.PORTAL_DATOS_PAGO?.trim() || null, apartados: pedidos.map((p) => ({
    folio: p.folio, estado: p.estado, vence_en: p.vence_en, entrega: p.entrega, envio: p.envio, subtotal: p.subtotal,
    saldo: p.saldo, faltante: p.faltante, liquidado_en: p.liquidado_en, guia: p.guia,
    viernes_envio: p.entrega === 'envio' ? p.viernes_envio : null, creado_en: p.creado_en,
    lineas: p.lineas.map(({ codigo, nombre, precio, cantidad }) => ({ codigo, nombre, precio, cantidad })),
    // Solo lo que levanto el portal y sigue sin dinero ni pago por revisar; lo demas lo cancela la tienda.
    cancelable: p.estado === 'apartado' && Number(p.saldo) === 0 && p.vendedora === VENDEDORA_PORTAL && reportes.get(p.folio)?.estado !== 'pendiente',
    pago_reportado: reportes.get(p.folio) ?? null,
  })) }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Cancelar uno suyo y sin pago (revendedora: su correo; socio del portal: 'portal' + su telefono). */
export const cancelarDeRevendedora = (folio: number, env: Env, ctx: ExecutionContext, correo: string) => cancelarSuyo(folio, env, ctx, correo);
export const cancelarDeSocio = (folio: number, env: Env, ctx: ExecutionContext, telefono: string) => cancelarSuyo(folio, env, ctx, VENDEDORA_PORTAL, telefono);

/** Las condiciones van en SQL: dos cancelaciones (o el cron) devuelven la existencia una vez. */
async function cancelarSuyo(folio: number, env: Env, ctx: ExecutionContext, vendedora: string, telefono?: string): Promise<Response> {
  const pedido = await pedidoPor(env, 'folio = ?', folio);
  if (!pedido || pedido.vendedora !== vendedora || (telefono !== undefined && pedido.telefono !== telefono))
    return json({ error: 'El pedido no existe.' }, 404);
  if (pedido.estado !== 'apartado' || Number(pedido.saldo) !== 0)
    return json({ error: 'Ya no se puede cancelar aquí: pídelo a la tienda.' }, 409);
  const momento = new Date();
  const ahora = momento.toISOString();
  // #609: con un pago reportado sin revisar la pieza no se cancela (el cliente ya pago); lo decide la tienda.
  const sinReporte = `and not ${hayReportePendiente('?1')}`;
  const [, marca] = await env.DB.batch([
    devolverApartado(env, pedido.id, ahora, `and vendedora = ?3 ${telefono === undefined ? '' : 'and telefono = ?4'} and saldo = 0 and liquidado_en is null ${sinReporte}`,
      vendedora, ...(telefono === undefined ? [] : [telefono])),
    env.DB.prepare(`update pedidos set estado = 'cancelado', saldo_vence_en = ?2, actualizado_en = ?3, revision = revision + 1
      where id = ?1 and estado = 'apartado' and saldo = 0 and liquidado_en is null and vendedora = ?4 ${telefono === undefined ? '' : 'and telefono = ?5'} ${sinReporte}`)
      .bind(pedido.id, sumarMeses(momento, 1), ahora, vendedora, ...(telefono === undefined ? [] : [telefono])),
  ]);
  if (!marca.meta.changes) return json({ error: 'Ya no se puede cancelar aquí: pídelo a la tienda.' }, 409);
  ctx.waitUntil(conciliarSeguro(env, { productoIds: await productosDe(env, pedido.id) }));
  return json({ ok: true, folio });
}

/** Un movimiento tiene ID del navegador y contenido fijo: una respuesta perdida no cobra ni aparta dos veces. */
async function moverPaquete(folio: number, tipo: 'pieza' | 'abono', request: Request,
  env: Env, ctx: ExecutionContext, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  if (!UUID.test(id)) return json({ error: 'Identificador inválido.' }, 400);
  const productoId = String(cuerpo.producto_id ?? '');
  const cantidad = Number(cuerpo.cantidad);
  const importe = Number(cuerpo.importe);
  const formaPago = String(cuerpo.forma_pago ?? '');
  const caja = tipo === 'abono' ? await cajaDe(env, correo, cuerpo.caja) : '';
  if (tipo === 'pieza' && (!UUID.test(productoId) || !Number.isInteger(cantidad) || cantidad < 1 || cantidad > 999))
    return json({ error: 'Pieza o cantidad inválida.' }, 400);
  if (tipo === 'abono' && (!Number.isSafeInteger(importe) || importe <= 0 || !FORMAS_PAGO.has(formaPago) || !caja))
    return json({ error: 'Escribe un abono en centavos enteros, su forma de pago y su caja.' }, 400);
  // #593: una transferencia lleva clave y monto del comprobante. Entran a la solicitud solo si vienen, para que el
  // reintento de un abono anterior a este cambio (sin clave) siga devolviendo su resultado original.
  const conClave = tipo === 'abono' && formaPago === 'transferencia';
  const solicitud = JSON.stringify(tipo === 'pieza' ? { folio, tipo, productoId, cantidad }
    : { folio, tipo, importe, formaPago, caja, ...(conClave && cuerpo.clave_rastreo ? { clave: claveRastreoDe(cuerpo.clave_rastreo), transferido: Number(cuerpo.monto_transferido) } : {}) });
  const reintento = async () => {
    const previo = await env.DB.prepare('select solicitud, respuesta from pedido_movimientos where id = ?')
      .bind(id).first<{ solicitud: string; respuesta: string }>();
    if (!previo) return null;
    return previo.solicitud === solicitud ? json(JSON.parse(previo.respuesta))
      : json({ error: 'Este identificador ya pertenece a otro movimiento. Revisa el original.' }, 409);
  };
  const previo = await reintento();
  if (previo) return previo;
  const transf = conClave ? leerTransferencia(cuerpo, importe) : null;
  if (transf && !transf.ok) return json({ error: transf.error, campo: transf.campo }, 400);
  const usada = transf && await respuestaClaveUsada(env, transf.clave);
  if (usada) return usada;
  const pedido = await pedidoPor(env, 'folio = ?', folio);
  if (!pedido) return json({ error: 'El pedido no existe.' }, 404);
  const momento = new Date();
  const ahora = momento.toISOString();
  // #575: el apartado de revendedora (tienda, anticipo 0) recibe abonos como un paquete, pero no se liquida:
  // lo que falte se cobra en caja al recoger. Un apartado normal (anticipo > 0) sigue sin aceptarlos.
  const sinAnticipo = tipo === 'abono' && pedido.entrega === 'tienda' && Number(pedido.anticipo) === 0;
  // #609: un apartado con pago reportado sin revisar no vence (el cron lo salta); su abono se registra aunque el plazo ya pasara.
  const vencido = String(pedido.vence_en) <= ahora;
  const reportado = tipo === 'abono' && vencido && !!await env.DB.prepare("select 1 as x from pagos_reportados where pedido_id = ? and estado = 'pendiente'").bind(pedido.id).first();
  if ((pedido.entrega !== 'envio' && !sinAnticipo) || pedido.estado !== 'apartado' || pedido.liquidado_en || (vencido && !reportado))
    return json({ error: 'El paquete ya no está abierto o venció. Actualiza la lista.' }, 409);
  const vence = new Date(momento.getTime() + DIAS_APARTADO * 86_400_000);
  let precio = 0;
  let precioCatalogo = 0;
  if (tipo === 'pieza') {
    const producto = await env.DB.prepare('select precio, propietario, codigo, sin_inventario from productos where id = ?')
      .bind(productoId).first<{ precio: number; propietario: string; codigo: string | null; sin_inventario: number }>();
    if (!producto || producto.propietario !== 'dolaron' || !producto.codigo || producto.sin_inventario || !Number.isSafeInteger(producto.precio) || producto.precio <= 0)
      return json({ error: 'Solo piezas con etiqueta de El Dolarón.' }, 400);
    // Si se suma otra unidad del mismo producto, conserva el precio de esa línea.
    precioCatalogo = producto.precio;
    precio = pedido.lineas.find((l) => l.producto_id === productoId)?.precio ?? precioCatalogo;
  }
  const subtotal = pedido.subtotal + (tipo === 'pieza' ? precio * cantidad : 0);
  const envio = tipo === 'pieza' ? envioDe(subtotal) : Number(pedido.envio);
  const total = subtotal + envio;
  const nuevoSaldo = Number(pedido.saldo) + (tipo === 'abono' ? importe : 0);
  if (!Number.isSafeInteger(total) || (tipo === 'abono' && nuevoSaldo > total))
    return json({ error: 'El abono no puede pasar de lo que falta por pagar.' }, 400);
  const liquidado = pedido.entrega === 'envio' && nuevoSaldo >= total;
  try {
    await env.DB.batch([
      // La revisión y el estado se comprueban DENTRO del batch. Un WHERE que no modifica filas no lo aborta.
      env.DB.prepare(`update pedidos set saldo = case when revision = ?1 and estado = 'apartado'
        and (entrega = 'envio'${sinAnticipo ? " or (entrega = 'tienda' and anticipo = 0)" : ''})
        and liquidado_en is null and (vence_en > ?2 or ${tipo === 'abono' ? hayReportePendiente('pedidos.id') : '0'}) ${tipo === 'pieza' ? `and exists (select 1 from productos
          where id = ?4 and propietario = 'dolaron' and sin_inventario = 0 and codigo is not null and codigo != ''
          and stock >= ?5 and precio = ?6)` : ''} then saldo else -1 end where id = ?3`)
        .bind(pedido.revision, ahora, pedido.id, ...(tipo === 'pieza' ? [productoId, cantidad, precioCatalogo] : [])),
      env.DB.prepare(`insert into pedido_movimientos
        (id, pedido_id, tipo, solicitud, importe, forma_pago, caja, autor, creado_en, respuesta)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, '')`)
        .bind(id, pedido.id, tipo, solicitud, tipo === 'abono' ? importe : 0, tipo === 'abono' ? formaPago : '', caja, correo, ahora),
      ...(transf ? [sentenciaTransferencia(env, transf, correo, ahora, 'abono', { pedido: pedido.id, movimiento: id })] : []),
      // #609: el abono es el pago que la revendedora reporto: el reporte se acepta en el mismo batch (si el abono falla, sigue pendiente).
      ...(tipo === 'abono' ? [env.DB.prepare(`update pagos_reportados set estado = 'aceptado', revisado_por = ?, revisado_en = ?, movimiento_id = ?
        where pedido_id = ? and estado = 'pendiente'`).bind(correo, ahora, id, pedido.id)] : []),
      ...(tipo === 'pieza' ? [
        env.DB.prepare(`insert into pedido_lineas (pedido_id, producto_id, cantidad, precio) values (?, ?, ?, ?)
          on conflict (pedido_id, producto_id) do update set cantidad = cantidad + excluded.cantidad`)
          .bind(pedido.id, productoId, cantidad, precio),
        // El trigger rechaza stock negativo; también revierte línea, movimiento y plazo si cambió el producto.
        env.DB.prepare(`update productos set stock = case when propietario = 'dolaron' and sin_inventario = 0
          and codigo is not null and codigo != '' then stock - ?1 else -1 end, actualizado_en = ?2 where id = ?3`)
          .bind(cantidad, ahora, productoId),
      ] : []),
      env.DB.prepare(`update pedidos set saldo = saldo + ?1, envio = ?2, vence_en = ?3,
        saldo_vence_en = ?4, actualizado_en = ?5, revision = revision + 1 where id = ?6`)
        .bind(tipo === 'abono' ? importe : 0, envio, vence.toISOString(), sumarMeses(vence, 1), ahora, pedido.id),
      ...(liquidado ? await ventaDePaquete(env, pedido.id, id, total, ahora, correo,
        tipo === 'abono' ? caja : pedido.caja, tipo === 'abono' ? formaPago : String(pedido.forma_pago)) : []),
      // La respuesta se guarda en el mismo batch: conserva el resultado original incluso después de otros movimientos.
      env.DB.prepare(`update pedido_movimientos set respuesta = json_object('movimiento_id', id, 'pedido_id', pedido_id,
        'folio', ?1, 'saldo', ?2, 'faltante', ?3, 'liquidado_en', ?4, 'viernes_envio', ?5, 'excedente_transferencia', ?7) where id = ?6`)
        .bind(folio, liquidado ? nuevoSaldo - total : nuevoSaldo, Math.max(0, total - nuevoSaldo), liquidado ? ahora : null,
          liquidado ? viernesDeEnvio(ahora) : null, id, transf?.ok ? transf.excedente : 0),
    ]);
  } catch (error) {
    const repetido = await reintento();
    if (repetido) return repetido;
    if (transf && esChoqueDeClave(error)) return (await respuestaClaveUsada(env, transf.clave)) ?? json({ error: 'Esa clave de rastreo ya se usó.', campo: 'clave' }, 409);
    if (String(error).includes('stock insuficiente')) return json({ error: 'Alguna pieza ya no está disponible.' }, 409);
    if (String(error).includes('saldo de pedido invalido')) return json({ error: 'El paquete cambió o venció. Actualiza la lista.' }, 409);
    throw error;
  }
  if (tipo === 'pieza') ctx.waitUntil(conciliarSeguro(env, { productoIds: [productoId] }));
  return (await reintento())!;
}

async function cancelarPedido(folio: number, env: Env, ctx: ExecutionContext): Promise<Response> {
  const pedido = await pedidoPor(env, 'folio = ?', folio);
  if (!pedido) return json({ error: 'El pedido no existe.' }, 404);
  if (pedido.estado !== 'apartado' || pedido.liquidado_en) return json({ error: 'Solo se cancela un apartado sin liquidar.' }, 409);
  const momento = new Date();
  const ahora = momento.toISOString();
  const [, marca] = await env.DB.batch([
    devolverApartado(env, pedido.id, ahora, 'and liquidado_en is null'),
    env.DB.prepare(
      `update pedidos set estado = 'cancelado', saldo_vence_en = ?, actualizado_en = ?, revision = revision + 1
       where id = ? and estado = 'apartado' and liquidado_en is null`,
    ).bind(sumarMeses(momento, 1), ahora, pedido.id),
  ]);
  if (!marca.meta.changes) return json({ error: 'Alguien más cambió este pedido. Vuelve a abrirlo.' }, 409);
  ctx.waitUntil(conciliarSeguro(env, { productoIds: await productosDe(env, pedido.id) }));
  return json({ pedido: await pedidoPor(env, 'id = ?', pedido.id) });
}

async function guardarGuia(folio: number, request: Request, env: Env): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as { guia?: unknown };
  const guia = texto(cuerpo.guia, 61);
  if (!guia || guia.length > 60) return json({ error: 'Escribe la guia (hasta 60 caracteres).' }, 400);
  const pedido = await pedidoPor(env, 'folio = ?', folio);
  if (!pedido) return json({ error: 'El pedido no existe.' }, 404);
  if (pedido.entrega !== 'envio' || pedido.estado !== 'vendido' || !pedido.liquidado_en)
    return json({ error: 'Solo se guarda guía de un envío liquidado con ticket.' }, 409);
  const guardada = await env.DB.prepare(`update pedidos set guia = ?, actualizado_en = ?
    where id = ? and estado = 'vendido' and liquidado_en is not null`)
    .bind(guia, new Date().toISOString(), pedido.id).run();
  if (!guardada.meta.changes) return json({ error: 'El pedido cambió. Actualiza la lista.' }, 409);
  return json({ pedido: await pedidoPor(env, 'id = ?', pedido.id) });
}

/** null = la ruta no es de pedidos. El permiso (CAJA) ya lo cobro cuentas.ts. */
export async function rutaPedidos(request: Request, env: Env, ctx: ExecutionContext, pathname: string, correo: string): Promise<Response | null> {
  const m = /^\/api\/pedidos(?:\/(\d{1,9})(?:\/(cancelar|guia|piezas|abonos|rechazar-pago))?)?$/.exec(pathname);
  if (!m) return null;
  const metodo = request.method;
  const folio = m[1] === undefined ? null : Number(m[1]);
  if (folio === null) {
    if (metodo === 'POST') return crearPedido(request, env, ctx, correo);
    if (metodo === 'GET') return listarPedidos(env);
  } else if (m[2] === undefined) {
    if (metodo === 'GET') {
      const pedido = await pedidoPor(env, 'folio = ?', folio);
      return pedido ? json({ pedido }) : json({ error: 'El pedido no existe.' }, 404);
    }
  } else if (m[2] === 'cancelar') {
    if (metodo === 'POST') return cancelarPedido(folio, env, ctx);
  } else if (m[2] === 'rechazar-pago') {
    if (metodo === 'POST') return rechazarPago(folio, request, env, correo);
  } else if (m[2] === 'piezas' || m[2] === 'abonos') {
    if (metodo === 'POST') return moverPaquete(folio, m[2] === 'piezas' ? 'pieza' : 'abono', request, env, ctx, correo);
  } else if (metodo === 'PUT') {
    return guardarGuia(folio, request, env);
  }
  return json({ error: 'Metodo no permitido.' }, 405);
}

/**
 * El cron (cada 15 min): cada apartado cuyo plazo llego pasa a `vencido`, sus piezas
 * vuelven a la venta y el anticipo queda de saldo un mes desde hoy. Con un pago reportado por revisar (#609) no vence. Cada pedido en su
 * batch: uno que falle no frena a los demas. Devuelve cuantos vencieron.
 */
export async function vencerPedidos(env: Env, momento = new Date()): Promise<number> {
  const ahora = momento.toISOString();
  let vencidos = 0;
  const tocados: string[] = [];
  try {
    const { results } = await env.DB.prepare(
      `select id from pedidos where estado = 'apartado' and liquidado_en is null and vence_en <= ? and not ${hayReportePendiente('pedidos.id')} order by vence_en limit 100`,
    ).bind(ahora).all<{ id: string }>();
    for (const { id } of results) {
      try {
        const [, marca] = await env.DB.batch([
          devolverApartado(env, id, ahora, `and liquidado_en is null and vence_en <= ?2 and not ${hayReportePendiente('?1')}`),
          env.DB.prepare(
            `update pedidos set estado = 'vencido', saldo_vence_en = ?1, actualizado_en = ?2, revision = revision + 1
             where id = ?3 and estado = 'apartado' and liquidado_en is null and vence_en <= ?2 and not ${hayReportePendiente('?3')}`,
          ).bind(sumarMeses(momento, 1), ahora, id),
        ]);
        if (marca.meta.changes) { vencidos++; tocados.push(...await productosDe(env, id)); }
      } catch (error) {
        console.error(JSON.stringify({ mensaje: 'vencer pedido', id, error: String(error) }));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'vencer pedidos', error: String(error) }));
  }
  if (tocados.length) await conciliarSeguro(env, { productoIds: [...new Set(tocados)] });
  return vencidos;
}
