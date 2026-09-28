/**
 * Descuentos con aprobacion del dueno (Issue #119). El cajero pide un % o un
 * monto sobre el ticket en curso, con motivo; el dueno lo aprueba o rechaza
 * desde /cuentas (resolverSolicitud); al cobrar, el servidor lo valida otra vez
 * y lo resta. La aprobacion vale para ese ticket exacto (mismo subtotal) y una
 * sola venta.
 */
import { descuentoDe } from '../public/venta.js';
import { leerUsuario } from './cuentas.ts';

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

interface Datos { tipo: string; valor: number; subtotal: number; monto: number }
interface Fila { id: string; correo: string; estado: string; datos: string }

/** El cajero pide un descuento. Una sola pendiente por persona: pedir otra reemplaza la anterior. */
export async function pedirDescuento(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const motivo = String(cuerpo.motivo ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!motivo) return json({ error: 'Escribe el motivo del descuento.' }, 400);
  const pedido = { tipo: String(cuerpo.tipo ?? ''), valor: Number(cuerpo.valor) };
  const subtotal = Number(cuerpo.subtotal);
  const calculo = descuentoDe(pedido, subtotal);
  if ('error' in calculo) return json({ error: calculo.error }, 400);

  const id = crypto.randomUUID();
  const ahora = new Date().toISOString();
  const datos: Datos = { ...pedido, subtotal, monto: calculo.monto };
  const nombre = (await leerUsuario(env, correo))?.nombre ?? '';
  await env.DB.batch([
    env.DB.prepare(
      `update solicitudes set estado = 'rechazada', resuelto_en = ?, resuelto_por = 'reemplazada'
       where tipo = 'descuento' and correo = ? and estado = 'pendiente'`,
    ).bind(ahora, correo),
    env.DB.prepare(
      `insert into solicitudes (id, tipo, correo, nombre, justificacion, datos, creado_en)
       values (?, 'descuento', ?, ?, ?, ?, ?)`,
    ).bind(id, correo, nombre, motivo, JSON.stringify(datos), ahora),
  ]);
  return json({ id, estado: 'pendiente', monto: calculo.monto }, 201);
}

/** La caja pregunta como va su solicitud. Solo la suya (o cualquiera, si es el dueno). */
export async function estadoDescuento(id: string, env: Env, correo: string): Promise<Response> {
  const fila = await env.DB.prepare(`select id, correo, estado, datos from solicitudes where id = ? and tipo = 'descuento'`)
    .bind(id)
    .first<Fila>();
  const dueno = (await leerUsuario(env, correo))?.roles.includes('dueno');
  if (!fila || (fila.correo !== correo && !dueno)) return json({ error: 'La solicitud no existe.' }, 404);
  const { subtotal, monto } = JSON.parse(fila.datos) as Datos;
  return json({ id, estado: fila.estado, subtotal, monto });
}

/**
 * Al cobrar: la solicitud tiene que estar aprobada, ser de este mismo ticket y
 * no haberse usado. El monto se recalcula aqui, no se le cree a la caja.
 */
export async function validarDescuento(
  env: Env, id: string, subtotal: number,
): Promise<{ ok: true; monto: number } | { ok: false; error: string; status: number }> {
  const fila = await env.DB.prepare(`select id, correo, estado, datos from solicitudes where id = ? and tipo = 'descuento'`)
    .bind(id)
    .first<Fila>();
  if (!fila) return { ok: false, error: 'El descuento no existe.', status: 400 };
  if (fila.estado !== 'aprobada') {
    return { ok: false, error: `El descuento esta ${fila.estado}: pide otro.`, status: 409 };
  }
  const datos = JSON.parse(fila.datos) as Datos;
  if (datos.subtotal !== subtotal) {
    return { ok: false, error: 'El ticket cambio despues de aprobar el descuento: pide otro.', status: 409 };
  }
  const calculo = descuentoDe(datos, subtotal);
  if ('error' in calculo) return { ok: false, error: String(calculo.error), status: 400 };
  const usado = await env.DB.prepare('select id from ventas where descuento_id = ?').bind(id).first();
  if (usado) return { ok: false, error: 'Ese descuento ya se uso en otra venta.', status: 409 };
  return { ok: true, monto: calculo.monto };
}
