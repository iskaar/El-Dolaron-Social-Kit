/**
 * Descuentos con aprobacion del dueno (Issue #119). El cajero pide un % o un
 * monto sobre el ticket completo, con motivo. Lo aprueba el dueno de tres
 * maneras, todas en `solicitudes` (tipo `descuento`), igual que las cancelaciones
 * (cancelaciones.ts): a distancia desde /cuentas (via 'remoto'), con su PIN en la
 * misma caja (via 'pin') o directo, si quien cobra es el dueno (via 'dueno').
 * Al cobrar, el servidor lo valida otra vez y lo resta: la aprobacion vale para
 * ese ticket exacto (mismo subtotal), una sola venta y hasta 50%.
 */
import { descuentoDe } from '../public/venta.js';
import { leerUsuario, leerRoles } from './cuentas.ts';
import { verificarPin } from './cajeros.ts';

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

interface Datos { tipo: string; valor: number; subtotal: number; monto: number; via?: string }

/**
 * El cajero pide un descuento. Una sola pendiente por persona: pedir otra
 * reemplaza la anterior. Con `aprobador` + `pin` (dueno) o siendo dueno quien
 * pide, nace aprobado; si no, queda pendiente para /cuentas.
 */
export async function pedirDescuento(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const motivo = String(cuerpo.motivo ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!motivo) return json({ error: 'Escribe el motivo del descuento.' }, 400);
  const pedido = { tipo: String(cuerpo.tipo ?? ''), valor: Number(cuerpo.valor) };
  const subtotal = Number(cuerpo.subtotal);
  const calculo = descuentoDe(pedido, subtotal);
  if ('error' in calculo) return json({ error: calculo.error }, 400);

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

  const id = crypto.randomUUID();
  const ahora = new Date().toISOString();
  const datos: Datos = { ...pedido, subtotal, monto: calculo.monto, via: aprobo?.via ?? 'remoto' };
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
  return json({ id, estado: aprobo ? 'aprobada' : 'pendiente', monto: calculo.monto }, 201);
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
  // Un solo UPDATE condicionado: si dos duenos la resuelven a la vez, gana uno.
  const gano = await env.DB.prepare(
    `update solicitudes set estado = ?, resuelto_en = ?, resuelto_por = ? where id = ? and estado = 'pendiente'`,
  ).bind(aprobar ? 'aprobada' : 'rechazada', new Date().toISOString(), dueno, id).run();
  if (!gano.meta.changes) return json({ error: 'Otro dueño ya la resolvió.' }, 409);
  return json({ id, estado: aprobar ? 'aprobada' : 'rechazada' });
}

/** Para /cuentas: los descuentos esperando al dueno, con lo que hace falta para decidir. */
export async function listarDescuentos(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select id, correo, nombre, justificacion as motivo, creado_en,
       json_extract(datos, '$.tipo') as tipo, json_extract(datos, '$.valor') as valor,
       json_extract(datos, '$.subtotal') as subtotal, json_extract(datos, '$.monto') as monto
     from solicitudes where tipo = 'descuento' and estado = 'pendiente' order by creado_en`,
  ).all();
  return json(results);
}

/**
 * Al cobrar: la solicitud tiene que estar aprobada, ser de este mismo ticket y
 * no haberse usado. El monto se recalcula aqui, no se le cree a la caja.
 */
export async function validarDescuento(
  env: Env, id: string, subtotal: number,
): Promise<{ ok: true; monto: number } | { ok: false; error: string; status: number }> {
  const fila = await env.DB.prepare(`select estado, datos from solicitudes where id = ? and tipo = 'descuento'`)
    .bind(id)
    .first<{ estado: string; datos: string }>();
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
