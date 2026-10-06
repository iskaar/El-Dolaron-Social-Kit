/**
 * Cancelar una venta completa (Issue #200). El dueno cancela directo; el cajero,
 * solo dentro de los primeros minutos de la venta. Pasado ese tiempo necesita la
 * aprobacion del dueno: con su PIN en la misma caja, o a distancia desde /cuentas
 * (tabla `solicitudes`, tipo `cancelacion`). Cancelar una pieza suelta no cambia
 * (devoluciones.ts).
 */
import { cajaDe } from './corte.ts';
import { leerUsuario, leerRoles } from './cuentas.ts';
import { verificarPin } from './cajeros.ts';
import { sentenciasDeCancelacion } from './dolarones.ts';
import { cancelarVales } from './vales.ts';

/** Lo que tiene el cajero para cancelar solo, contado desde la hora de la venta. */
export const VENTANA_CANCELACION_MS = 5 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

type Resultado = { status: number; cuerpo: Record<string, unknown> };
const responder = (r: Resultado) => json(r.cuerpo, r.status);

/**
 * La cancelacion en si: marca, existencias, Dolarones y vales en un solo batch.
 * `extra` agrega sentencias al mismo batch (el rastro de la aprobacion), asi que
 * se cancela y se registra quien aprobo, o ninguna de las dos.
 */
export async function cancelarCore(
  env: Env, id: string, motivo: string, canceladaPor: string, cajaPedida: unknown,
  extra: (ahora: string) => D1PreparedStatement[] = () => [],
): Promise<Resultado> {
  const venta = await env.DB.prepare(
    'select id, total, dolarones, cancelada, devuelto, dolarones_devueltos, revision from ventas where id = ?',
  )
    .bind(id)
    .first<{
      id: string; total: number; dolarones: number; cancelada: number;
      devuelto: number; dolarones_devueltos: number; revision: number;
    }>();
  if (!venta) return { status: 404, cuerpo: { error: 'La venta no existe.' } };
  if (venta.cancelada) return { status: 200, cuerpo: { id, cancelada: true, ya_estaba: true } };

  const ahora = new Date().toISOString();
  // Solo lo que sigue en el ticket: las piezas ya canceladas sueltas (Issue #138) ya regresaron.
  const { results: lineas } = await env.DB.prepare(
    `select producto_id, cantidad - cancelada_cantidad as cantidad from venta_lineas
     where venta_id = ? and producto_id is not null and cantidad > cancelada_cantidad`,
  )
    .bind(id)
    .all<{ producto_id: string; cantidad: number }>();

  // Si dos cancelaciones llegan juntas, el trigger venta_cancelada_una_vez
  // (migracion 011) aborta la segunda completa: nada se devuelve dos veces.
  try {
    await env.DB.batch([
      // Candado de migracion 020: si una pieza se cancelo entre la lectura y aqui, aborta todo.
      env.DB.prepare('update ventas set revision = ? where id = ?').bind(venta.revision + 1, id),
      env.DB.prepare(
        `update ventas set cancelada = 1, cancelada_en = ?, cancelada_por = ?, motivo_cancelacion = ?, cancelada_caja = ?
         where id = ?`,
      ).bind(ahora, canceladaPor, motivo, await cajaDe(env, canceladaPor, cajaPedida), id),   // el corte de esa caja cuenta la devolucion
      ...lineas.map((l) =>
        env.DB.prepare(
          `update productos set stock = stock + ?, actualizado_en = ?
           where id = ? and sin_inventario = 0`,
        ).bind(l.cantidad, ahora, l.producto_id),
      ),
      ...(await sentenciasDeCancelacion(env, id, canceladaPor, ahora)),
      ...(await cancelarVales(env, id, canceladaPor, ahora)),
      ...extra(ahora),
    ]);
  } catch (error) {
    if (String(error).includes('saldo de vale invalido'))
      return { status: 409, cuerpo: { error: 'El vale de esta compra ya se usó. Requiere aclaración presencial antes de cancelar.' } };
    if (String(error).includes('saldo insuficiente'))
      return { status: 409, cuerpo: { error: 'Los Dolarones ganados con esta compra ya se usaron. Requiere aclaración presencial antes de cancelar.' } };
    if (String(error).includes('venta ya cancelada')) return { status: 200, cuerpo: { id, cancelada: true, ya_estaba: true } };
    if (String(error).includes('ticket cambio'))
      return { status: 409, cuerpo: { error: 'Alguien mas cambio este ticket. Vuelve a abrirlo.' } };
    throw error;
  }

  // Lo que se regresa en dinero; lo pagado con Dolarones regresa al saldo.
  // Sin lo ya devuelto por piezas canceladas sueltas.
  return {
    status: 200,
    cuerpo: {
      id, cancelada: true,
      devuelto: venta.total - venta.dolarones - venta.devuelto,
      dolarones: venta.dolarones - venta.dolarones_devueltos,
    },
  };
}

const insertarSolicitud = (
  env: Env, id: string, correo: string, nombre: string, motivo: string, datos: object, ahora: string,
  resuelta: string | null,
) =>
  env.DB.prepare(
    `insert into solicitudes (id, tipo, correo, nombre, justificacion, datos, estado, creado_en, resuelto_en, resuelto_por)
     values (?, 'cancelacion', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, correo, nombre, motivo, JSON.stringify(datos), resuelta ? 'aprobada' : 'pendiente', ahora,
    resuelta ? ahora : null, resuelta);

/**
 * Cancela una venta ya cobrada: devolucion o error de la cajera.
 * La venta no se borra, se marca: el corte del dia tiene que seguir explicando
 * todo lo que paso, incluido lo que se deshizo. Las piezas vuelven al inventario.
 */
export async function cancelarVenta(id: string, request: Request, env: Env, correo: string): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador de venta invalido.' }, 400);
  }
  // Con dinero real de por medio, una cancelacion sin motivo no se distingue
  // de una para quedarse el efectivo de una venta que si se cobro. El motivo
  // y quien la hizo (Cloudflare Access, igual que capturado_por en las fotos)
  // son lo minimo para poder auditar despues.
  const cuerpo = (await request.json().catch(() => ({}))) as {
    motivo?: unknown; caja?: unknown; aprobador?: unknown; pin?: unknown; solicitar?: unknown;
  };
  const motivo = String(cuerpo.motivo ?? '').trim().slice(0, 200);
  if (!motivo) {
    return json({ error: 'Escribe el motivo de la cancelacion.' }, 400);
  }

  const venta = await env.DB.prepare('select creado_en, cancelada from ventas where id = ?')
    .bind(id)
    .first<{ creado_en: string; cancelada: number }>();
  if (!venta) return json({ error: 'La venta no existe.' }, 404);
  if (venta.cancelada) return json({ id, cancelada: true, ya_estaba: true });

  const usuario = await leerUsuario(env, correo);
  // Una hora ilegible o del futuro no abre la ventana: cae en pedir aprobacion.
  const edad = Date.now() - Date.parse(venta.creado_en);
  const enVentana = edad > -VENTANA_CANCELACION_MS && edad <= VENTANA_CANCELACION_MS;
  if (usuario?.roles.includes('dueno') || enVentana) {
    return responder(await cancelarCore(env, id, motivo, correo, cuerpo.caja));
  }

  const nombre = usuario?.nombre ?? '';
  const datos = { venta_id: id, caja: String(cuerpo.caja ?? '') };

  // Aprobada en la caja con el PIN del dueno: se cancela y se deja el rastro en el mismo batch.
  if (cuerpo.aprobador) {
    const dueno = String(cuerpo.aprobador).trim().toLowerCase();
    const verificado = await verificarPin(env, dueno, String(cuerpo.pin ?? ''), (roles) => roles.includes('dueno'));
    if ('error' in verificado) return json({ error: verificado.error }, verificado.status);
    return responder(await cancelarCore(env, id, motivo, correo, cuerpo.caja, (ahora) => [
      insertarSolicitud(env, crypto.randomUUID(), correo, nombre, motivo, { ...datos, via: 'pin' }, ahora, dueno),
    ]));
  }

  // Aprobacion a distancia: queda pendiente para /cuentas.
  if (cuerpo.solicitar === true) {
    const pendiente = await env.DB.prepare(
      `select id from solicitudes where tipo = 'cancelacion' and estado = 'pendiente'
       and json_extract(datos, '$.venta_id') = ?`,
    ).bind(id).first<{ id: string }>();
    if (pendiente) return json({ pendiente: true, solicitud_id: pendiente.id }, 202);
    const solicitudId = crypto.randomUUID();
    await insertarSolicitud(env, solicitudId, correo, nombre, motivo, { ...datos, via: 'remoto' },
      new Date().toISOString(), null).run();
    return json({ pendiente: true, solicitud_id: solicitudId }, 202);
  }

  const { results } = await env.DB.prepare(
    `select correo, nombre, roles from usuarios where activo = 1 and pin_hash != '' order by nombre`,
  ).all<{ correo: string; nombre: string; roles: string }>();
  return json({
    requiere_aprobacion: true,
    error: `Pasaron más de ${VENTANA_CANCELACION_MS / 60_000} minutos: necesita aprobación del dueño.`,
    duenos: results.filter((u) => leerRoles(u.roles).includes('dueno')).map(({ correo, nombre }) => ({ correo, nombre })),
  }, 403);
}

/** El dueno aprueba o rechaza una cancelacion pendiente (la llama resolverSolicitud). */
export async function resolverCancelacion(env: Env, id: string, aprobar: boolean, dueno: string): Promise<Response> {
  const solicitud = await env.DB.prepare('select correo, justificacion, datos from solicitudes where id = ?')
    .bind(id)
    .first<{ correo: string; justificacion: string; datos: string }>();
  if (!solicitud) return json({ error: 'La solicitud no existe.' }, 404);
  const marcar = (estado: string, ahora = new Date().toISOString()) => env.DB.prepare(
    `update solicitudes set estado = ?, resuelto_en = ?, resuelto_por = ? where id = ? and estado = 'pendiente'`,
  ).bind(estado, ahora, dueno, id);

  const yaResuelta = () => json({ error: 'Otro dueño ya la resolvió.' }, 409);
  if (!aprobar) {
    if (!(await marcar('rechazada').run()).meta.changes) return yaResuelta();
    return json({ id, estado: 'rechazada' });
  }
  // Se reclama antes de cancelar: si otro dueño la rechaza al mismo tiempo, solo
  // gana uno. Si la cancelacion falla (409), la solicitud vuelve a pendiente.
  // ponytail: entre reclamar y cancelar no hay transaccion; si el Worker muere en
  // ese hueco queda aprobada sin cancelar y se ve en /cuentas como aprobada.
  if (!(await marcar('aprobada').run()).meta.changes) return yaResuelta();
  const datos = JSON.parse(solicitud.datos) as { venta_id: string; caja?: string };
  const r = await cancelarCore(env, datos.venta_id, solicitud.justificacion, solicitud.correo, datos.caja);
  if (r.status !== 200) {
    await env.DB.prepare(
      `update solicitudes set estado = 'pendiente', resuelto_en = null, resuelto_por = null
       where id = ? and estado = 'aprobada' and resuelto_por = ?`,
    ).bind(id, dueno).run();
    return responder(r);
  }
  return json({ ...r.cuerpo, id: datos.venta_id, solicitud_id: id, estado: 'aprobada' });
}

/** Para /cuentas: las cancelaciones esperando al dueno, con lo que hace falta para decidir. */
export async function listarCancelaciones(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select s.id, s.correo, s.nombre, s.justificacion as motivo, s.creado_en,
       json_extract(s.datos, '$.venta_id') as venta_id, v.total, v.creado_en as venta_creado_en
     from solicitudes s left join ventas v on v.id = json_extract(s.datos, '$.venta_id')
     where s.tipo = 'cancelacion' and s.estado = 'pendiente' order by s.creado_en`,
  ).all();
  return json(results);
}

/** Para que la caja sepa como va su solicitud: solo la pide quien la hizo, o el dueno. */
export async function estadoSolicitud(env: Env, id: string, correo: string): Promise<Response> {
  const fila = await env.DB.prepare('select estado, correo, datos from solicitudes where id = ?')
    .bind(id)
    .first<{ estado: string; correo: string; datos: string }>();
  const usuario = fila && fila.correo !== correo ? await leerUsuario(env, correo) : null;
  if (!fila || (fila.correo !== correo && !usuario?.roles.includes('dueno'))) {
    return json({ error: 'La solicitud no existe.' }, 404);
  }
  return json({ estado: fila.estado, venta_id: (JSON.parse(fila.datos) as { venta_id?: string }).venta_id ?? null });
}
