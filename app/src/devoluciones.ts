/**
 * Desglose de un ticket y cancelacion por pieza (Issue #138).
 *
 * Cancelar una pieza no toca la venta ni su linea original: suma a
 * `venta_lineas.cancelada_cantidad`, a `ventas.devuelto` y deja un renglon en
 * `devoluciones` con quien, por que, cuanto y en que caja. El corte de esa caja
 * resta el dinero devuelto (corte.ts), igual que una cancelacion completa.
 *
 * Reglas de Isaac (30/09):
 * - Dinero primero: la pieza se devuelve en dinero hasta lo que el cliente pago
 *   en dinero; solo el excedente regresa como Dolarones al saldo.
 * - La cancela cualquier cajero, con motivo, como el ticket completo.
 */

import { cajaDe } from './corte.ts';
import { dolaronesGanados } from '../public/venta.js';
import { retirarVale, valeDeVenta, valeUsadoEnVenta } from './vales.ts';
import { saldo } from './dolarones.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Cuanto de `importe` sale en dinero y cuanto en Dolarones. Pura, para probarla
 * sin D1. `pagado` es lo que el ticket cobro en dinero (total - dolarones).
 */
export function repartirDevolucion(p: {
  importe: number; pagado: number; devuelto: number; dolarones: number; dolaronesDevueltos: number;
}): { dinero: number; dolarones: number } {
  const dinero = Math.min(p.importe, Math.max(0, p.pagado - p.devuelto));
  const dolarones = Math.min(p.importe - dinero, Math.max(0, p.dolarones - p.dolaronesDevueltos));
  return { dinero, dolarones };
}

interface VentaFila {
  id: string; total: number; forma_pago: string; efectivo: number; cambio: number; dolarones: number;
  cancelada: number; cancelada_en: string; cancelada_por: string; cancelada_caja: string; motivo_cancelacion: string;
  creado_en: string; caja: string; cajero: string; cliente_id: string | null;
  devuelto: number; dolarones_devueltos: number; revision: number;
  imprimir_en: string | null; impreso_en: string | null;
}

const leerVenta = (env: Env, id: string) =>
  env.DB.prepare(
    `select id, total, forma_pago, efectivo, cambio, dolarones, cancelada, cancelada_en, cancelada_por, cancelada_caja,
            motivo_cancelacion, creado_en, caja, cajero, cliente_id, devuelto, dolarones_devueltos, revision, imprimir_en, impreso_en
     from ventas where id = ?`,
  ).bind(id).first<VentaFila>();

/** El ticket con sus piezas y lo que ya se devolvio: para la ventana de la caja y de reportes. */
export async function detalleVenta(id: string, env: Env, paraImprimir = false): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador de venta invalido.' }, 400);
  const venta = await leerVenta(env, id);
  if (!venta) return json({ error: 'La venta no existe.' }, 404);

  const { results: lineas } = await env.DB.prepare(
    `select id, producto_id, codigo, nombre, precio, cantidad, cancelada_cantidad
     from venta_lineas where venta_id = ? order by id`,
  ).bind(id).all();
  const { results: devoluciones } = await env.DB.prepare(
    `select d.id, d.creado_en, d.autor, d.motivo, d.cantidad, d.importe, d.dolarones, d.caja, l.nombre
     from devoluciones d join venta_lineas l on l.id = d.linea_id
     where d.venta_id = ? order by d.creado_en`,
  ).bind(id).all();
  const socio = venta.cliente_id
    ? await env.DB.prepare('select numero, nombre from clientes where id = ?').bind(venta.cliente_id).first<{ numero:number; nombre:string }>()
    : null;
  if (!paraImprimir) return json({ ...venta, cliente_id:undefined, socio, lineas, devoluciones });
  const ganados = socio ? await env.DB.prepare(`select coalesce(sum(importe), 0) as importe
    from dolarones_movimientos where venta_id = ? and tipo = 'compra'`).bind(id).first<{ importe:number }>() : null;
  const saldoActual = venta.cliente_id ? await saldo(env, venta.cliente_id, new Date().toISOString()) : null;
  const respuesta = json({ ...venta, cliente_id: undefined,
    socio:socio && { ...socio, ganados:ganados?.importe ?? 0, saldo:saldoActual?.disponible ?? 0 }, lineas, devoluciones,
    vale_emitido:await valeDeVenta(env, id), vale_usado:await valeUsadoEnVenta(env, id) });
  respuesta.headers.set('cache-control', 'no-store');
  return respuesta;
}

/**
 * Cancela `cantidad` piezas de una linea. Idempotente por `id`, que la caja
 * genera al abrir el formulario: un reintento tras red caida no devuelve dos veces.
 */
export async function cancelarPieza(
  ventaId: string, lineaId: number, request: Request, env: Env, correo: string,
): Promise<Response> {
  if (!UUID.test(ventaId)) return json({ error: 'Identificador de venta invalido.' }, 400);
  const cuerpo = (await request.json().catch(() => ({}))) as {
    id?: unknown; cantidad?: unknown; motivo?: unknown; caja?: unknown;
  };
  const id = String(cuerpo.id ?? '');
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  const motivo = String(cuerpo.motivo ?? '').trim().slice(0, 200);
  if (!motivo) return json({ error: 'Escribe el motivo de la cancelacion.' }, 400);
  const cantidad = Number(cuerpo.cantidad ?? 1);
  if (!Number.isInteger(cantidad) || cantidad < 1) return json({ error: 'Cantidad invalida.' }, 400);

  const previa = await env.DB.prepare('select id, importe, dolarones from devoluciones where id = ?')
    .bind(id).first<{ id: string; importe: number; dolarones: number }>();
  if (previa) return json({ ...previa, venta_id: ventaId, duplicada: true });

  const venta = await leerVenta(env, ventaId);
  if (!venta) return json({ error: 'La venta no existe.' }, 404);
  if (venta.cancelada) return json({ error: 'El ticket ya estaba cancelado completo.' }, 409);
  // Dolarones sin socio son de un vale (PR #134): aqui solo se sabe regresarlos
  // a los lotes de un socio. Ese ticket se cancela completo, sin restitución parcial al vale.
  if (venta.dolarones > 0 && !venta.cliente_id) {
    return json({ error: 'Este ticket se pagó con un vale: cancélalo completo.' }, 409);
  }

  const linea = await env.DB.prepare(
    `select l.id, l.producto_id, l.precio, l.cantidad, l.cancelada_cantidad
     from venta_lineas l where l.id = ? and l.venta_id = ?`,
  ).bind(lineaId, ventaId).first<{
    id: number; producto_id: string | null; precio: number; cantidad: number; cancelada_cantidad: number;
  }>();
  if (!linea) return json({ error: 'La pieza no es de este ticket.' }, 404);
  const quedan = linea.cantidad - linea.cancelada_cantidad;
  if (quedan <= 0) return json({ error: 'Esa pieza ya estaba cancelada.' }, 409);
  if (cantidad > quedan) return json({ error: `Solo quedan ${quedan} de esa pieza en el ticket.` }, 400);

  const pagado = venta.total - venta.dolarones;
  const reparto = repartirDevolucion({
    importe: linea.precio * cantidad, pagado, devuelto: venta.devuelto,
    dolarones: venta.dolarones, dolaronesDevueltos: venta.dolarones_devueltos,
  });
  const ahora = new Date().toISOString();

  try {
    await env.DB.batch([
      // Primero el candado: si otra cancelacion de este ticket se adelanto, aborta todo.
      env.DB.prepare(
        `update ventas set revision = ?, devuelto = devuelto + ?, dolarones_devueltos = dolarones_devueltos + ?
         where id = ?`,
      ).bind(venta.revision + 1, reparto.dinero, reparto.dolarones, ventaId),
      env.DB.prepare('update venta_lineas set cancelada_cantidad = cancelada_cantidad + ? where id = ?')
        .bind(cantidad, linea.id),
      env.DB.prepare(
        `insert into devoluciones (id, venta_id, linea_id, cantidad, importe, dolarones, forma_pago, caja, autor, motivo, creado_en)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, ventaId, linea.id, cantidad, reparto.dinero, reparto.dolarones, venta.forma_pago,
        await cajaDe(env, correo, cuerpo.caja), correo, motivo, ahora),
      // Los bins no regresan existencia: nadie cuenta cuantas piezas hay en un bote.
      ...(linea.producto_id
        ? [env.DB.prepare(
          'update productos set stock = stock + ?, actualizado_en = ? where id = ? and sin_inventario = 0',
        ).bind(cantidad, ahora, linea.producto_id)]
        : []),
      ...(venta.cliente_id
        ? await sentenciasDeDevolucion(env, {
          ventaId, dolarones: reparto.dolarones, pagadoRestante: pagado - venta.devuelto - reparto.dinero,
          autor: correo, ahora,
        })
        : await retirarVale(env, ventaId, correo, ahora, pagado - venta.devuelto - reparto.dinero)),
    ]);
  } catch (error) {
    const texto = String(error);
    if (texto.includes('UNIQUE') && texto.includes('devoluciones')) {
      const ya = await env.DB.prepare('select id, importe, dolarones from devoluciones where id = ?').bind(id).first();
      if (ya) return json({ ...ya, venta_id: ventaId, duplicada: true });
    }
    if (texto.includes('ticket cambio') || texto.includes('pieza ya cancelada')) {
      return json({ error: 'Alguien mas cambio este ticket. Vuelve a abrirlo.' }, 409);
    }
    if (texto.includes('saldo insuficiente')) {
      return json({ error: 'Los Dolarones ganados con esta compra ya se usaron. Requiere aclaración presencial antes de cancelar.' }, 409);
    }
    if (texto.includes('saldo de vale invalido')) {
      return json({ error: 'El vale de esta compra ya se usó. Requiere aclaración presencial antes de cancelar.' }, 409);
    }
    throw error;
  }

  return json({ id, venta_id: ventaId, cantidad, devuelto: reparto.dinero, dolarones: reparto.dolarones }, 201);
}

/** Lo canjeado en una venta que todavia no regresa a su lote, por lote; el que vence al ultimo primero. */
async function canjesPendientes(env: Env, ventaId: string) {
  const { results } = await env.DB.prepare(
    `select m.cliente_id, m.lote_id, -sum(m.importe) as importe
     from dolarones_movimientos m join dolarones_lotes l on l.id = m.lote_id
     where m.venta_id = ? and m.tipo in ('canje', 'reverso_canje')
     group by m.cliente_id, m.lote_id having sum(m.importe) < 0
     order by max(l.vence_en) desc, m.lote_id`,
  )
    .bind(ventaId)
    .all<{ cliente_id: string; lote_id: string; importe: number }>();
  return results;
}

/**
 * Cancelar una pieza del ticket (Issue #138): regresan `dolarones` al saldo y
 * lo ganado se recalcula sobre `pagadoRestante`, el dinero que el ticket sigue
 * teniendo cobrado. Para el mismo batch que registra la devolucion.
 *
 * Lo que regresa va al lote que vence al ultimo: al cliente le dura mas. Lo
 * ganado de más se retira; si ya se gastó, el batch aborta como al cancelar
 * el ticket completo (decisión de Isaac, #135).
 */
async function sentenciasDeDevolucion(env: Env, p: {
  ventaId: string; dolarones: number; pagadoRestante: number; autor: string; ahora: string;
}): Promise<D1PreparedStatement[]> {
  const sentencias: D1PreparedStatement[] = [];

  let falta = p.dolarones;
  for (const canje of falta > 0 ? await canjesPendientes(env, p.ventaId) : []) {
    if (falta === 0) break;
    const regresa = Math.min(canje.importe, falta);
    falta -= regresa;
    sentencias.push(
      env.DB.prepare('update dolarones_lotes set restante = restante + ? where id = ?').bind(regresa, canje.lote_id),
      env.DB.prepare(
        `insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
         values (?, ?, ?, 'reverso_canje', ?, ?, ?)`,
      ).bind(canje.cliente_id, canje.lote_id, p.ventaId, regresa, p.autor, p.ahora),
    );
  }

  const compra = await env.DB.prepare(
    `select l.id, l.cliente_id, l.importe, l.restante,
       coalesce((select -sum(importe) from dolarones_movimientos
                 where lote_id = l.id and tipo = 'reverso_compra'), 0) as retirado
     from dolarones_lotes l where l.venta_id = ?`,
  )
    .bind(p.ventaId)
    .first<{ id: string; cliente_id: string; importe: number; restante: number; retirado: number }>();
  if (compra) {
    const retira = Math.max(0, compra.importe - compra.retirado - dolaronesGanados(p.pagadoRestante));
    if (retira > 0) {
      sentencias.push(
        // Si ya se gastó crédito (también desde otra caja), aborta todo.
        env.DB.prepare(`update dolarones_lotes set restante = case
          when restante = importe + coalesce((select sum(importe) from dolarones_movimientos
            where lote_id = dolarones_lotes.id and tipo = 'reverso_compra'), 0)
          then restante - ? else -1 end where id = ?`).bind(retira, compra.id),
        env.DB.prepare(
          `insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
           values (?, ?, ?, 'reverso_compra', ?, ?, ?)`,
        ).bind(compra.cliente_id, compra.id, p.ventaId, -retira, p.autor, p.ahora),
      );
    }
  }
  return sentencias;
}

