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
import { envioDe, ANTICIPO_MINIMO } from '../public/venta.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAS_PAGO = new Set(['efectivo', 'tarjeta', 'transferencia']);
const DIAS_APARTADO = 7;
const LIMITE_LISTA = 200;

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
  saldo, saldo_vence_en, guia, venta_id, creado_en, actualizado_en`;

interface FilaPedido { id: string; estado: string; entrega: string; [campo: string]: unknown }

/** Los pedidos de `donde` (condicion sobre `pedidos`) con sus piezas al precio de hoy y el subtotal. */
async function leerPedidos(env: Env, donde: string, args: unknown[], orden = 'folio desc', limite = LIMITE_LISTA) {
  const { results } = await env.DB.prepare(
    `select ${COLUMNAS} from pedidos where ${donde} order by ${orden} limit ${limite}`,
  ).bind(...args).all<FilaPedido>();
  if (!results.length) return [];
  const { results: piezas } = await env.DB.prepare(
    `select l.pedido_id, p.id as producto_id, p.codigo, p.nombre, p.precio, l.cantidad
     from pedido_lineas l join productos p on p.id = l.producto_id
     where l.pedido_id in (select id from pedidos where ${donde}) order by p.nombre`,
  ).bind(...args).all<{ pedido_id: string; precio: number; cantidad: number }>();
  return results.map((fila) => {
    const lineas = piezas.filter((l) => l.pedido_id === fila.id).map(({ pedido_id, ...resto }) => resto);
    return { ...fila, subtotal: lineas.reduce((suma, l) => suma + l.precio * l.cantidad, 0), lineas };
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
export const devolverApartado = (env: Env, pedidoId: string, ahora: string) => env.DB.prepare(
  `update productos set stock = stock + (select cantidad from pedido_lineas where pedido_id = ?1 and producto_id = productos.id),
                        actualizado_en = ?2
   where id in (select producto_id from pedido_lineas where pedido_id = ?1)
     and exists (select 1 from pedidos where id = ?1 and estado = 'apartado')`,
).bind(pedidoId, ahora);

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
}): Promise<{ ok: true; sentencias: D1PreparedStatement[] } | { ok: false; error: string; status: number }> {
  const pedido = await env.DB.prepare('select saldo, saldo_vence_en from pedidos where id = ?')
    .bind(p.pedidoId).first<{ saldo: number; saldo_vence_en: string }>();
  if (!pedido) return { ok: false, status: 409, error: 'El pedido no existe.' };
  if (pedido.saldo < p.anticipo || pedido.saldo_vence_en <= p.ahora)
    return { ok: false, status: 409, error: 'El saldo del pedido cambió o venció. Vuelve a cargarlo.' };
  return {
    ok: true,
    sentencias: [
      devolverApartado(env, p.pedidoId, p.ahora),
      env.DB.prepare(
        `update pedidos set saldo = case when saldo_vence_en > ?1 then saldo - ?2 else -1 end,
                            estado = case when estado = 'apartado' then 'vendido' else estado end,
                            venta_id = case when estado = 'apartado' then ?3 else venta_id end,
                            actualizado_en = ?1
         where id = ?4`,
      ).bind(p.ahora, p.anticipo, p.ventaId, p.pedidoId),
    ],
  };
}

export const saldoDe = async (env: Env, pedidoId: string) =>
  (await env.DB.prepare('select saldo from pedidos where id = ?').bind(pedidoId).first<{ saldo: number }>())?.saldo ?? 0;

/* ---------- API ---------- */

const texto = (valor: unknown, max: number) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Solo digitos; un 52 al inicio sobra. null si no quedan 10. */
export function telefonoDe(valor: unknown): string | null {
  let digitos = String(valor ?? '').replace(/\D/g, '');
  if (digitos.length === 12 && digitos.startsWith('52')) digitos = digitos.slice(2);
  return digitos.length === 10 ? digitos : null;
}

async function crearPedido(request: Request, env: Env, ctx: ExecutionContext, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  // Reintento tras red caida: el mismo pedido, sin bajar otra vez la existencia.
  const previo = await pedidoPor(env, 'id = ?', id);
  if (previo) return json({ pedido: previo });

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
  const formaPago = String(cuerpo.forma_pago ?? '');
  if (!FORMAS_PAGO.has(formaPago)) return json({ error: 'Forma de pago invalida.' }, 400);
  const caja = await cajaDe(env, correo, cuerpo.caja);
  // ponytail: tarjeta y transferencia sin caja no entran a ningun corte (igual que una venta sin caja); exigirla
  // tambien ahi si se vuelve costumbre cobrar anticipos desde un telefono sin caja asignada.
  if (formaPago === 'efectivo' && !caja) return json({ error: 'Falta la caja.' }, 400);

  const ids = [...cantidades.keys()];
  const { results: filas } = await env.DB.prepare(
    `select id, codigo, precio, sin_inventario from productos where id in (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<{ id: string; codigo: string | null; precio: number; sin_inventario: number }>();
  if (filas.length !== ids.length || filas.some((p) => !p.codigo || !(p.precio > 0) || p.sin_inventario !== 0))
    return json({ error: 'Solo piezas con etiqueta.' }, 400);

  const subtotal = filas.reduce((suma, p) => suma + p.precio * cantidades.get(p.id)!, 0);
  const envio = entrega === 'envio' ? envioDe(subtotal) : 0;
  const total = subtotal + envio;
  const anticipo = Number(cuerpo.anticipo);
  if (!Number.isInteger(anticipo) || anticipo < ANTICIPO_MINIMO || anticipo > total)
    return json({ error: `El anticipo es de $${ANTICIPO_MINIMO / 100} como minimo y no pasa del total.` }, 400);
  if (entrega === 'envio' && anticipo !== total) return json({ error: 'El envio se paga completo.' }, 400);

  const momento = new Date();
  const ahora = momento.toISOString();
  const vence = new Date(momento.getTime() + DIAS_APARTADO * 86_400_000);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `insert into pedidos (id, folio, cliente, telefono, entrega, envio, vendedora, estado, vence_en, anticipo,
                              forma_pago, caja, saldo, saldo_vence_en, creado_en, actualizado_en)
         values (?, (select coalesce(max(folio), 0) + 1 from pedidos), ?, ?, ?, ?, ?, 'apartado', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, cliente, telefono, entrega, envio, correo, vence.toISOString(), anticipo, formaPago, caja,
        anticipo, sumarMeses(vence, 1), ahora, ahora),
      ...ids.map((productoId) => env.DB.prepare(
        'insert into pedido_lineas (pedido_id, producto_id, cantidad) values (?, ?, ?)',
      ).bind(id, productoId, cantidades.get(productoId))),
      // Sin max(0, ...): el trigger stock_no_negativo (migracion 006) aborta todo el batch si ya no hay.
      ...ids.map((productoId) => env.DB.prepare(
        'update productos set stock = stock - ?, actualizado_en = ? where id = ?',
      ).bind(cantidades.get(productoId), ahora, productoId)),
    ]);
  } catch (error) {
    // Dos envios del mismo pedido a la vez: el segundo choca con la llave y el primero ya quedo.
    const ya = await pedidoPor(env, 'id = ?', id);
    if (ya) return json({ pedido: ya });
    if (String(error).includes('stock insuficiente')) return json({ error: 'Alguna pieza ya no está disponible.' }, 409);
    throw error;
  }
  // Las piezas apartadas dejan de estar a la venta tambien en Mercado Libre (D1 manda).
  ctx.waitUntil(conciliarSeguro(env, { productoIds: ids }));
  return json({ pedido: await pedidoPor(env, 'id = ?', id) }, 201);
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
  return json({ pedidos });
}

async function cancelarPedido(folio: number, env: Env, ctx: ExecutionContext): Promise<Response> {
  const pedido = await pedidoPor(env, 'folio = ?', folio);
  if (!pedido) return json({ error: 'El pedido no existe.' }, 404);
  if (pedido.estado !== 'apartado') return json({ error: 'Solo se cancela un apartado.' }, 409);
  const momento = new Date();
  const ahora = momento.toISOString();
  const [, marca] = await env.DB.batch([
    devolverApartado(env, pedido.id, ahora),
    env.DB.prepare(
      `update pedidos set estado = 'cancelado', saldo_vence_en = ?, actualizado_en = ? where id = ? and estado = 'apartado'`,
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
  if (pedido.entrega !== 'envio') return json({ error: 'Este pedido no es de envio.' }, 409);
  await env.DB.prepare('update pedidos set guia = ?, actualizado_en = ? where id = ?')
    .bind(guia, new Date().toISOString(), pedido.id).run();
  return json({ pedido: await pedidoPor(env, 'id = ?', pedido.id) });
}

/** null = la ruta no es de pedidos. El permiso (CAJA) ya lo cobro cuentas.ts. */
export async function rutaPedidos(request: Request, env: Env, ctx: ExecutionContext, pathname: string, correo: string): Promise<Response | null> {
  const m = /^\/api\/pedidos(?:\/(\d{1,9})(?:\/(cancelar|guia))?)?$/.exec(pathname);
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
  } else if (metodo === 'PUT') {
    return guardarGuia(folio, request, env);
  }
  return json({ error: 'Metodo no permitido.' }, 405);
}

/**
 * El cron (cada 15 min): cada apartado cuyo plazo llego pasa a `vencido`, sus piezas
 * vuelven a la venta y el anticipo queda de saldo un mes desde hoy. Cada pedido en su
 * batch: uno que falle no frena a los demas. Devuelve cuantos vencieron.
 */
export async function vencerPedidos(env: Env, momento = new Date()): Promise<number> {
  const ahora = momento.toISOString();
  let vencidos = 0;
  const tocados: string[] = [];
  try {
    const { results } = await env.DB.prepare(
      `select id from pedidos where estado = 'apartado' and vence_en <= ? order by vence_en limit 100`,
    ).bind(ahora).all<{ id: string }>();
    for (const { id } of results) {
      try {
        const [, marca] = await env.DB.batch([
          devolverApartado(env, id, ahora),
          env.DB.prepare(
            `update pedidos set estado = 'vencido', saldo_vence_en = ?, actualizado_en = ? where id = ? and estado = 'apartado'`,
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
