/**
 * Cancelar una venta completa (Issue #200). El dueno (o un supervisor, #837) cancela directo; el cajero,
 * solo dentro de los primeros minutos de la venta. Pasado ese tiempo necesita la
 * aprobacion del dueno o de un supervisor: con su PIN en la misma caja, o a distancia desde /cuentas
 * (tabla `solicitudes`, tipo `cancelacion`). Cancelar una pieza suelta no cambia
 * (devoluciones.ts).
 */
import { cajaDe, nombreCaja } from './corte.ts';
import { estadoVigente } from './descuentos.ts';
import { sentenciasMover } from './existencias.ts';
import { leerUsuario, leerRoles, apruebaDinero, TIENDA_CENTRAL, tiendaDeCaja } from './cuentas.ts';
import { verificarPinAprobacion, valeEnTienda } from './cajeros.ts';
import { sentenciasDeReverso } from './reversos.ts';
import { TICKET_CON_ANTICIPO } from './pedidos.ts';
import { avisarDueno } from './avisos.ts';

/** Lo que tiene el cajero para cancelar solo, contado desde la hora de la venta. */
export const VENTANA_CANCELACION_MS = 5 * 60_000;

/** Mientras una devolución de dinero espera al dueño, el ticket no cambia por otro camino (#837): la solicitud quedó atada a cómo estaba. */
export const HAY_DEVOLUCION = 'Hay una devolución esperando al dueño en este ticket.';
export const devolucionPendiente = async (env: Env, ventaId: string): Promise<{ id: string; correo: string; resumen: string | null } | null> =>
  env.DB.prepare(`select id, correo, json_extract(datos, '$.resumen') as resumen from solicitudes
    where tipo = 'devolucion' and estado = 'pendiente' and json_extract(datos, '$.venta_id') = ? limit 1`)
    .bind(ventaId).first<{ id: string; correo: string; resumen: string | null }>();

const hora = (iso: string) => new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'short', timeStyle: 'short' });

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
  env: Env, id: string, motivo: string, canceladaPor: string, cajaPedida: unknown, tienda: string,
  extra: (ahora: string) => D1PreparedStatement[] = () => [],
): Promise<Resultado> {
  const venta = await env.DB.prepare(
    'select id, total, dolarones, anticipo, cancelada, devuelto, devuelto_cupon, dolarones_devueltos, revision from ventas where id = ?',
  )
    .bind(id)
    .first<{
      id: string; total: number; dolarones: number; anticipo: number; cancelada: number;
      devuelto: number; devuelto_cupon: number; dolarones_devueltos: number; revision: number;
    }>();
  if (!venta) return { status: 404, cuerpo: { error: 'La venta no existe.' } };
  if (venta.cancelada) return { status: 200, cuerpo: { id, cancelada: true, ya_estaba: true } };
  // Unica puerta de las cancelaciones completas (cajero, PIN del dueno y aprobacion remota); ver pedidos.ts.
  if (venta.anticipo > 0) return { status: 409, cuerpo: { error: TICKET_CON_ANTICIPO } };
  // El dinero de un cupón se quedó en el cajón (Issue #330): cancelado completo, el corte del mismo turno
  // ya no contaría la venta y faltaría ese dinero. Lo que queda se devuelve pieza por pieza.
  if (venta.devuelto_cupon > 0) {
    return { status: 409, cuerpo: { error: 'Este ticket ya tiene piezas devueltas en cupón: devuelve lo que queda pieza por pieza.' } };
  }
  if (await devolucionPendiente(env, id)) return { status: 409, cuerpo: { error: HAY_DEVOLUCION } };

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
        `update ventas set cancelada = 1, cancelada_en = ?, cancelada_por = ?, motivo_cancelacion = ?, cancelada_caja = ?, cancelada_tienda = ?
         where id = ?`,
      ).bind(ahora, canceladaPor, motivo, await cajaDe(env, canceladaPor, cajaPedida, tienda), tienda, id),   // el corte de esa caja cuenta la devolucion
      // R3 de #793: la pieza entra a la existencia de la tienda donde se cancela (el dinero ya sale de esa caja), aunque se vendiera en otra.
      ...lineas.flatMap((l) => sentenciasMover(env, tienda, l.producto_id, l.cantidad, ahora, true)),
      ...(await sentenciasDeReverso(env, { ventaId: id, clienteId: null, autor: canceladaPor, ahora, completa: true })),
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

/** Los que pueden aprobar con PIN en la caja que salga dinero (dueño y supervisores con PIN): lo que ofrece el 403 de cancelar y de devolver dinero. Los descuentos y cupones siguen usando solo duenos. */
export async function aprobadoresDeDinero(env: Env, tienda: string): Promise<{ correo: string; nombre: string }[]> {
  const { results } = await env.DB.prepare(
    `select correo, nombre, roles, tienda from usuarios where activo = 1 and pin_hash != '' order by nombre`,
  ).all<{ correo: string; nombre: string; roles: string; tienda: string }>();
  // #850: el supervisor de otra tienda no se ofrece (no aprobaria); el dueño, en todas.
  return results.filter((u) => apruebaDinero(leerRoles(u.roles)) && valeEnTienda({ roles: leerRoles(u.roles), tienda: u.tienda }, tienda))
    .map(({ correo, nombre }) => ({ correo, nombre }));
}

/**
 * Aprobacion con PIN en la caja (#837): el PIN de otra cuenta con rol de dueño o supervisor, con 5 intentos y 15 minutos por aprobador
 * y por caja (verificarPinAprobacion). Quien cobra no se aprueba a si mismo: si ya es dueño o supervisor, ni llega aqui (cancela directo).
 */
export async function aprobadorConPin(env: Env, solicitante: string, aprobador: unknown, pin: unknown, caja: string, tienda: string):
  Promise<{ por: string } | { error: string; status: number }> {
  const por = String(aprobador).trim().toLowerCase();
  // Los fallos se cuentan aparte de los del acceso a la caja (verificarPinAprobacion, migración 082): equivocarse aquí no bloquea al supervisor.
  const verificado = await verificarPinAprobacion(env, por, String(pin ?? ''), caja, apruebaDinero, tienda);
  if ('error' in verificado) return verificado;
  if (por === solicitante) return { error: 'No puedes aprobar tu propia devolución: pide a otra persona.', status: 403 };
  return { por };
}

/** Una fila de aprobacion del dueno; tipo 'devolucion' es la de devolver dinero de una pieza (devoluciones.ts, #837). */
export const insertarSolicitud = (
  env: Env, id: string, correo: string, nombre: string, motivo: string, datos: object, ahora: string,
  resuelta: string | null, tipo: 'cancelacion' | 'devolucion' = 'cancelacion',
) =>
  env.DB.prepare(
    `insert into solicitudes (id, tipo, correo, nombre, justificacion, datos, estado, creado_en, resuelto_en, resuelto_por)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, tipo, correo, nombre, motivo, JSON.stringify(datos), resuelta ? 'aprobada' : 'pendiente', ahora,
    resuelta ? ahora : null, resuelta);

/**
 * Cancela una venta ya cobrada: devolucion o error de la cajera.
 * La venta no se borra, se marca: el corte del dia tiene que seguir explicando
 * todo lo que paso, incluido lo que se deshizo. Las piezas vuelven al inventario.
 */
export async function cancelarVenta(id: string, request: Request, env: Env, correo: string, tienda: string, ctx?: ExecutionContext): Promise<Response> {
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

  const venta = await env.DB.prepare('select creado_en, cancelada, anticipo, total from ventas where id = ?')
    .bind(id)
    .first<{ creado_en: string; cancelada: number; anticipo: number; total: number }>();
  if (!venta) return json({ error: 'La venta no existe.' }, 404);
  if (venta.cancelada) return json({ id, cancelada: true, ya_estaba: true });
  // Antes de pedir aprobacion: no tiene caso mandar al dueno una solicitud que cancelarCore rechazaria.
  if (venta.anticipo > 0) return json({ error: TICKET_CON_ANTICIPO }, 409);
  if (await devolucionPendiente(env, id)) return json({ error: HAY_DEVOLUCION }, 409);

  // Una terminal de sucursal debe decir su caja: de ella sale la tienda donde entra la pieza si el dueño aprueba a distancia.
  if (tienda !== TIENDA_CENTRAL && !nombreCaja(cuerpo.caja)) return json({ error: 'Elige arriba qué caja es esta computadora.' }, 400);
  const usuario = await leerUsuario(env, correo);
  // Una hora ilegible o del futuro no abre la ventana: cae en pedir aprobacion.
  const edad = Date.now() - Date.parse(venta.creado_en);
  const enVentana = edad > -VENTANA_CANCELACION_MS && edad <= VENTANA_CANCELACION_MS;
  if ((usuario && apruebaDinero(usuario.roles)) || enVentana) {
    return responder(await cancelarCore(env, id, motivo, correo, cuerpo.caja, tienda));
  }

  const nombre = usuario?.nombre ?? '';
  // La caja y la tienda se validan AQUÍ (una caja de otra tienda es 400) y es lo que se guarda: al aprobarse a distancia la pieza entra a esa tienda,
  // no a la que diga un texto sin revisar. Las solicitudes anteriores a #837 solo traen la caja: su tienda sale de ella.
  const caja = await cajaDe(env, correo, cuerpo.caja, tienda);
  const datos = { venta_id: id, caja, tienda };

  // Aprobada en la caja con el PIN del dueno: se cancela y se deja el rastro en el mismo batch.
  if (cuerpo.aprobador) {
    const aprobo = await aprobadorConPin(env, correo, cuerpo.aprobador, cuerpo.pin, caja, tienda);
    if ('error' in aprobo) return json({ error: aprobo.error }, aprobo.status);
    return responder(await cancelarCore(env, id, motivo, correo, cuerpo.caja, tienda, (ahora) => [
      insertarSolicitud(env, crypto.randomUUID(), correo, nombre, motivo, { ...datos, via: 'pin' }, ahora, aprobo.por),
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
    avisarDueno(env, ctx, request, `Cancelación por aprobar: $${(venta.total / 100).toFixed(2)}`,
      `${nombre || correo} pide cancelar una venta de $${(venta.total / 100).toFixed(2)} del ${hora(venta.creado_en)}.\nMotivo: ${motivo}`);
    return json({ pendiente: true, solicitud_id: solicitudId }, 202);
  }

  return json({
    requiere_aprobacion: true,
    error: `Pasaron más de ${VENTANA_CANCELACION_MS / 60_000} minutos: necesita aprobación del supervisor o del dueño.`,
    duenos: await aprobadoresDeDinero(env, tienda),   // dueño y supervisores de esta tienda con PIN; la solicitud a distancia sigue yendo al dueño
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
  const datos = JSON.parse(solicitud.datos) as { venta_id: string; caja?: string; tienda?: string };
  // La pieza entra a la tienda de la terminal que pidió la cancelación: su caja lo dice (los nombres de caja son únicos entre tiendas); las solicitudes anteriores a #795 son de Soledad.
  const r = await cancelarCore(env, datos.venta_id, solicitud.justificacion, solicitud.correo, datos.caja, datos.tienda ?? tiendaDeCaja(datos.caja));
  if (r.status !== 200) {
    await env.DB.prepare(
      `update solicitudes set estado = 'pendiente', resuelto_en = null, resuelto_por = null
       where id = ? and estado = 'aprobada' and resuelto_por = ?`,
    ).bind(id, dueno).run();
    return responder(r);
  }
  return json({ ...r.cuerpo, id: datos.venta_id, solicitud_id: id, estado: 'aprobada' });
}

/** Para /avisos y /cuentas: las cancelaciones y devoluciones de dinero esperando al dueno, con lo que hace falta para decidir. */
export async function listarCancelaciones(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select s.id, s.tipo, s.correo, s.nombre, s.justificacion as motivo, s.creado_en,
       json_extract(s.datos, '$.resumen') as resumen, json_extract(s.datos, '$.venta_id') as venta_id, v.total, v.creado_en as venta_creado_en
     from solicitudes s left join ventas v on v.id = json_extract(s.datos, '$.venta_id')
     where s.tipo in ('cancelacion', 'devolucion') and s.estado = 'pendiente' order by s.creado_en`,
  ).all();
  return json(results);
}

/** Para que la caja sepa como va su solicitud: solo la pide quien la hizo, o el dueno. */
export async function estadoSolicitud(env: Env, id: string, correo: string): Promise<Response> {
  const fila = await env.DB.prepare('select tipo, estado, correo, datos, creado_en, resuelto_en from solicitudes where id = ?')
    .bind(id)
    .first<{ tipo: string; estado: string; correo: string; datos: string; creado_en: string; resuelto_en: string | null }>();
  const usuario = fila && fila.correo !== correo ? await leerUsuario(env, correo) : null;
  if (!fila || (fila.correo !== correo && !usuario?.roles.includes('dueno'))) {
    return json({ error: 'La solicitud no existe.' }, 404);
  }
  // Un descuento pendiente o aprobado de mas de 30 minutos ya es `vencida`; trae cuando vence (#845).
  if (fila.tipo === 'descuento') return json({ ...estadoVigente(fila), venta_id: null });
  const datos = JSON.parse(fila.datos) as { venta_id?: string; rechazo?: string };
  return json({ estado: fila.estado, venta_id: datos.venta_id ?? null, rechazo: datos.rechazo ?? null });
}
