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
 * - Con motivo. Devolver en cupon lo hace el cajero solo dentro de 7 dias (despues, #948, tambien lo aprueba el supervisor); devolver DINERO lo aprueba el dueno o un supervisor (#837, 16/11/2026): ver cancelarPieza.
 */

import { cajaDe, nombreCaja } from './corte.ts';
import { sentenciasMover } from './existencias.ts';
import { leerCupon, nuevoCupon, porcentajeCupon, usadosEnVenta, valeDeVenta, papelDeVenta, pagoConPapel, papelPorReemitir } from './vales.ts';
import { saldo, canjeDeCuentaPendiente } from './dolarones.ts';
import { sentenciasDeReverso } from './reversos.ts';
import { TICKET_CON_ANTICIPO } from './pedidos.ts';
import { datosCorreccion } from './correcciones-pago.ts';
import { insertarSolicitud, aprobadorConPin, aprobadoresDeDinero, devolucionPendiente, HAY_DEVOLUCION } from './cancelaciones.ts';
import { delDia, hoyTienda } from './reportes.ts';
import { leerUsuario, apruebaDinero, TIENDA_CENTRAL, tiendaDeCaja } from './cuentas.ts';
import { avisarDueno } from './avisos.ts';

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

/**
 * Lo que vale `cantidad` de una linea. Con descuento (Issue #119) `total` ya viene descontado:
 * cada pieza vale su parte de lo cobrado, y la ultima se lleva el resto (sin perder centavos).
 */
export function importePiezas(p: {
  precio: number; cantidad: number; restan: number; total: number; descuento: number; devuelto: number; dolaronesDevueltos: number;
}): number {
  if (p.descuento <= 0) return p.precio * p.cantidad;
  return p.cantidad === p.restan
    ? Math.max(0, p.total - p.devuelto - p.dolaronesDevueltos)
    : Math.round((p.precio * p.cantidad * p.total) / (p.total + p.descuento));
}

interface VentaFila {
  id: string; total: number; descuento: number; forma_pago: string; efectivo: number; cambio: number; dolarones: number;
  cancelada: number; cancelada_en: string; cancelada_por: string; cancelada_caja: string; motivo_cancelacion: string;
  creado_en: string; caja: string; cajero: string; cliente_id: string | null; anticipo: number; pedido_id: string | null;
  devuelto: number; devuelto_cupon: number; dolarones_devueltos: number; revision: number;
  imprimir_en: string | null; impreso_en: string | null;
}

const leerVenta = (env: Env, id: string) =>
  env.DB.prepare(
    `select id, total, descuento, forma_pago, efectivo, cambio, dolarones, cancelada, cancelada_en, cancelada_por, cancelada_caja,
            motivo_cancelacion, creado_en, caja, cajero, cliente_id, anticipo, pedido_id, devuelto, devuelto_cupon, dolarones_devueltos, revision, imprimir_en, impreso_en
     from ventas where id = ?`,
  ).bind(id).first<VentaFila>();

/**
 * ¿El ticket pagó algo con vale o cupón? Lo dice la bitácora de vales; `dolarones > 0` sin socio cubre también un ticket de vale
 * que no tenga renglón (datos anteriores a que el canje se registrara así). Antes bastaba mirar `cliente_id`: con socio y papel juntos (#927) ya no.
 */
const ticketConPapel = async (env: Env, venta: Pick<VentaFila, 'id' | 'dolarones' | 'cliente_id'>) =>
  venta.dolarones > 0 && (!venta.cliente_id || await pagoConPapel(env, venta.id));

/** El ticket con sus piezas y lo que ya se devolvio: para la ventana de la caja y de reportes. `sesion`: tienda, rol y caja de quien mira, para saber si aqui se puede corregir su forma de pago (#831). */
export async function detalleVenta(id: string, env: Env, paraImprimir = false, sesion?: { tienda: string; dueno: boolean; caja: string }): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador de venta invalido.' }, 400);
  const venta = await leerVenta(env, id);
  if (!venta) return json({ error: 'La venta no existe.' }, 404);

  const { results: lineas } = await env.DB.prepare(
    `select id, producto_id, codigo, nombre, precio, cantidad, cancelada_cantidad
     from venta_lineas where venta_id = ? order by id`,
  ).bind(id).all();
  const { results: devoluciones } = await env.DB.prepare(
    `select d.id, d.creado_en, d.autor, d.motivo, d.cantidad, d.importe, d.dolarones, d.cupon, d.vale_id, d.caja, d.forma_pago, l.nombre
     from devoluciones d join venta_lineas l on l.id = d.linea_id
     where d.venta_id = ? order by d.creado_en`,
  ).bind(id).all();
  const socio = venta.cliente_id
    ? await env.DB.prepare('select numero, nombre from clientes where id = ?').bind(venta.cliente_id).first<{ numero:number; nombre:string }>()
    : null;
  // Para reimprimir el renglon «Anticipo P-17»: el folio del pedido que pago parte del ticket.
  const folio = venta.pedido_id
    ? (await env.DB.prepare('select folio from pedidos where id = ?').bind(venta.pedido_id).first<{ folio:number }>())?.folio ?? null
    : null;
  // Lo que de `dolarones` salió de vales o cupones (el resto, de la cuenta del socio): #927.
  const dolaronesPapel = venta.dolarones > 0 ? (venta.cliente_id ? await papelDeVenta(env, id) : venta.dolarones) : 0;
  if (!paraImprimir) return json({ ...venta, cliente_id:undefined, pedido_id:undefined, pedido_folio:folio, socio, lineas, devoluciones,
    dolarones_papel:dolaronesPapel, devolucion_pendiente: await devolucionPendiente(env, id), ...(await datosCorreccion(env, id, sesion)) });
  const ganados = socio ? await env.DB.prepare(`select coalesce(sum(importe), 0) as importe
    from dolarones_movimientos where venta_id = ? and tipo = 'compra'`).bind(id).first<{ importe:number }>() : null;
  const bono = socio ? await env.DB.prepare(`select coalesce(sum(importe), 0) as importe
    from dolarones_movimientos where venta_id = ? and tipo = 'promo'`).bind(id).first<{ importe:number }>() : null;
  const saldoActual = venta.cliente_id ? await saldo(env, venta.cliente_id, new Date().toISOString()) : null;
  const respuesta = json({ ...venta, cliente_id: undefined, pedido_id: undefined, pedido_folio: folio,
    socio:socio && { ...socio, ganados:ganados?.importe ?? 0, bono_promo:bono?.importe ?? 0, saldo:saldoActual?.disponible ?? 0 }, lineas, devoluciones,
    dolarones_papel:dolaronesPapel, vale_emitido:await valeDeVenta(env, id), ...(await usadosEnVenta(env, id)) });
  respuesta.headers.set('cache-control', 'no-store');
  return respuesta;
}

type Resultado = { status: number; cuerpo: Record<string, unknown> };
const responder = (r: Resultado) => json(r.cuerpo, r.status);

interface PedidoPieza { id: string; cantidad: number; motivo: string; devolverEn: unknown; caja: unknown }

/**
 * Lo que haria devolver esas piezas, sin escribir nada: las mismas validaciones y el mismo reparto que usa la
 * escritura. Asi la solicitud al dueno (#837) nace solo si la devolucion procede, y al aprobarse se vuelve a calcular
 * con el ticket como esta ahora.
 */
async function prepararPieza(env: Env, ventaId: string, lineaId: number, p: PedidoPieza) {
  const falla = (status: number, error: string) => ({ res: { status, cuerpo: { error } } as Resultado });
  const venta = await leerVenta(env, ventaId);
  if (!venta) return falla(404, 'La venta no existe.');
  if (venta.cancelada) return falla(409, 'El ticket ya estaba cancelado completo.');
  // Devolver dinero de un ticket que uso saldo de pedido descuadra el corte de dos cajas (pedidos.ts).
  if (venta.anticipo > 0) return falla(409, TICKET_CON_ANTICIPO);
  // Un ticket que pagó algo con vale o cupón (PR #134) se cancela completo. Con socio (#927) la pieza se devuelve en cupón (devolverEnCupon), y solo
  // por esta ruta se acepta una pieza sin dinero y pagada toda con lo que la CUENTA aún tiene canjeado en el ticket (más abajo): el dinero de una pieza
  // no se reparte entre papel y cuenta.
  const conPapel = await ticketConPapel(env, venta);
  if (conPapel && !venta.cliente_id) return falla(409, 'Este ticket se pagó con un vale: cancélalo completo.');

  const linea = await env.DB.prepare(
    `select l.id, l.producto_id, l.nombre, l.precio, l.cantidad, l.cancelada_cantidad
     from venta_lineas l where l.id = ? and l.venta_id = ?`,
  ).bind(lineaId, ventaId).first<{
    id: number; producto_id: string | null; nombre: string; precio: number; cantidad: number; cancelada_cantidad: number;
  }>();
  if (!linea) return falla(404, 'La pieza no es de este ticket.');
  const quedan = linea.cantidad - linea.cancelada_cantidad;
  if (quedan <= 0) return falla(409, 'Esa pieza ya estaba cancelada.');
  if (p.cantidad > quedan) return falla(400, `Solo quedan ${quedan} de esa pieza en el ticket.`);

  // Un ticket con tarjeta o transferencia puede devolverse en efectivo del cajon (Isaac, 17/10); el corte lo cuenta asi.
  const devolverEn = p.devolverEn === 'efectivo' ? 'efectivo' : venta.forma_pago;
  const pagado = venta.total - venta.dolarones;
  const importe = importePiezas({
    precio: linea.precio, cantidad: p.cantidad, restan: venta.descuento > 0 ? await piezasQueQuedan(env, ventaId) : 0,
    total: venta.total, descuento: venta.descuento, devuelto: venta.devuelto, dolaronesDevueltos: venta.dolarones_devueltos,
  });
  const reparto = repartirDevolucion({
    importe, pagado, devuelto: venta.devuelto,
    dolarones: venta.dolarones, dolaronesDevueltos: venta.dolarones_devueltos,
  });
  // Ticket con papel: solo pasa una pieza que no mueve dinero y cuyos Dolarones regresan todos a la cuenta (sin tocar un cupón). Es la pieza que
  // devolverEnCupon no puede dar en cupón («Cancélalas normal») y que de otro modo no tendría salida: cancelar completo ya no se puede tras un cupón.
  if (conPapel && !(importe > 0 && reparto.dinero === 0 && reparto.dolarones === importe && importe <= await canjeDeCuentaPendiente(env, ventaId)))
    return falla(409, 'Este ticket se pagó con un vale o cupón: devuelve la pieza en cupón o cancélalo completo.');
  return { venta, linea, devolverEn, pagado, reparto };
}

/**
 * La devolucion en si: una sola escritura. `extra` agrega sentencias al mismo batch (el rastro de la aprobacion con PIN),
 * asi que se devuelve y se registra quien aprobo, o ninguna de las dos. El id de la devolucion es unico: un reintento
 * (o la aprobacion remota repetida) no devuelve dos veces.
 */
async function escribirPieza(
  env: Env, ventaId: string, p: PedidoPieza, prep: Exclude<Awaited<ReturnType<typeof prepararPieza>>, { res: Resultado }>,
  correo: string, tienda: string, extra: (ahora: string) => D1PreparedStatement[] = () => [],
): Promise<Resultado> {
  const { venta, linea, devolverEn, pagado, reparto } = prep;
  const ahora = new Date().toISOString();
  try {
    await env.DB.batch([
      // Primero el candado: si otra cancelacion de este ticket se adelanto, aborta todo.
      env.DB.prepare(
        `update ventas set revision = ?, devuelto = devuelto + ?, dolarones_devueltos = dolarones_devueltos + ?
         where id = ?`,
      ).bind(venta.revision + 1, reparto.dinero, reparto.dolarones, ventaId),
      env.DB.prepare('update venta_lineas set cancelada_cantidad = cancelada_cantidad + ? where id = ?')
        .bind(p.cantidad, linea.id),
      env.DB.prepare(
        `insert into devoluciones (id, venta_id, linea_id, cantidad, importe, dolarones, forma_pago, caja, autor, motivo, creado_en, tienda)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(p.id, ventaId, linea.id, p.cantidad, reparto.dinero, reparto.dolarones, devolverEn,
        await cajaDe(env, correo, p.caja, tienda), correo, p.motivo, ahora, tienda),
      // Los bins no regresan existencia: nadie cuenta cuantas piezas hay en un bote. La pieza entra a la tienda donde se devuelve (R3 de #793).
      ...(linea.producto_id ? sentenciasMover(env, tienda, linea.producto_id, p.cantidad, ahora, true) : []),
      ...(await sentenciasDeReverso(env, {
        ventaId, clienteId: venta.cliente_id, autor: correo, ahora, completa: false,
        dolarones: reparto.dolarones, pagadoRestante: pagado - venta.devuelto - reparto.dinero,
      })),
      ...extra(ahora),
    ]);
  } catch (error) {
    const texto = String(error);
    if (texto.includes('UNIQUE') && texto.includes('devoluciones')) {
      const ya = await env.DB.prepare('select id, importe, dolarones from devoluciones where id = ?').bind(p.id).first();
      if (ya) return { status: 200, cuerpo: { ...ya, venta_id: ventaId, duplicada: true } };
    }
    if (texto.includes('ticket cambio') || texto.includes('pieza ya cancelada')) {
      return { status: 409, cuerpo: { error: 'Alguien mas cambio este ticket. Vuelve a abrirlo.' } };
    }
    if (texto.includes('saldo insuficiente')) {
      return { status: 409, cuerpo: { error: 'Los Dolarones ganados con esta compra ya se usaron. Requiere aclaración presencial antes de cancelar.' } };
    }
    if (texto.includes('saldo de vale invalido')) {
      return { status: 409, cuerpo: { error: 'El vale de esta compra ya se usó. Requiere aclaración presencial antes de cancelar.' } };
    }
    throw error;
  }
  return { status: 201, cuerpo: { id: p.id, venta_id: ventaId, cantidad: p.cantidad, devuelto: reparto.dinero, dolarones: reparto.dolarones } };
}

const pesos = (centavos: number) => `$${(centavos / 100).toFixed(2)}`;

/**
 * Cancela `cantidad` piezas de una linea. Idempotente por `id`, que la caja
 * genera al abrir el formulario: un reintento tras red caida no devuelve dos veces.
 *
 * Devolver DINERO (efectivo, tarjeta o transferencia) lo autoriza el dueno o un supervisor (#837, regla de Isaac del 16/11/2026):
 * ellos devuelven directo; el cajero lo hace con el PIN de uno de ellos en la misma caja, o a distancia (`solicitudes`, tipo `devolucion`,
 * con el id de esta devolucion como id de la solicitud). Lo que no es dinero (pieza pagada toda con Dolarones) no pide a nadie.
 * Devolver en cupon es otra ruta (devolverEnCupon) y la hace el cajero solo.
 */
export async function cancelarPieza(
  ventaId: string, lineaId: number, request: Request, env: Env, correo: string, tienda: string, ctx?: ExecutionContext,
): Promise<Response> {
  if (!UUID.test(ventaId)) return json({ error: 'Identificador de venta invalido.' }, 400);
  const cuerpo = (await request.json().catch(() => ({}))) as {
    id?: unknown; cantidad?: unknown; motivo?: unknown; caja?: unknown; devolver_en?: unknown; aprobador?: unknown; pin?: unknown; solicitar?: unknown;
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
  // Un reintento de la solicitud a distancia: la misma sigue pendiente (o ya fue resuelta, y la caja se entera preguntando por ella).
  const pedida = await env.DB.prepare(`select estado from solicitudes where id = ? and tipo = 'devolucion'`).bind(id).first<{ estado: string }>();
  if (pedida) return pedida.estado === 'pendiente' ? json({ pendiente: true, solicitud_id: id }, 202)
    : json({ error: `Esa solicitud ya estaba ${pedida.estado}: abre el ticket otra vez.` }, 409);

  // Mientras otra devolución de dinero espera al dueño el ticket no se toca por otro camino: la solicitud quedó atada a cómo estaba.
  if (await devolucionPendiente(env, ventaId)) return json({ error: HAY_DEVOLUCION }, 409);

  const pedido: PedidoPieza = { id, cantidad, motivo, devolverEn: cuerpo.devolver_en, caja: cuerpo.caja };
  const prep = await prepararPieza(env, ventaId, lineaId, pedido);
  if ('res' in prep) return responder(prep.res);

  const usuario = await leerUsuario(env, correo);
  if (prep.reparto.dinero === 0 || (usuario && apruebaDinero(usuario.roles))) {
    return responder(await escribirPieza(env, ventaId, pedido, prep, correo, tienda));
  }

  const nombre = usuario?.nombre ?? '';
  // La caja y la tienda se validan aquí (una caja de otra tienda es 400) y es lo que se guarda: al aprobarse la pieza entra a esa tienda.
  // `revision`, `devolver_en` y `dinero` atan la solicitud a como está el ticket ahora: si cambia, la aprobación se rechaza (resolverDevolucion).
  const caja = await cajaDe(env, correo, cuerpo.caja, tienda);
  const datos = { venta_id: ventaId, linea_id: lineaId, cantidad, devolver_en: prep.devolverEn, caja, tienda, dinero: prep.reparto.dinero,
    revision: prep.venta.revision };

  // Aprobada en la caja con el PIN del dueno: se devuelve y se deja el rastro en el mismo batch.
  if (cuerpo.aprobador) {
    const aprobo = await aprobadorConPin(env, correo, cuerpo.aprobador, cuerpo.pin, caja, tienda);
    if ('error' in aprobo) return json({ error: aprobo.error }, aprobo.status);
    return responder(await escribirPieza(env, ventaId, pedido, prep, correo, tienda, (ahora) => [
      insertarSolicitud(env, id, correo, nombre, motivo, { ...datos, via: 'pin' }, ahora, aprobo.por, 'devolucion'),
    ]));
  }

  // Aprobacion a distancia: queda pendiente para /avisos. No se mueve dinero, existencia ni Dolarones hasta que el dueno la apruebe.
  if (cuerpo.solicitar === true) {
    // Una terminal de sucursal debe decir su caja: de ella sale la tienda donde entra la pieza al aprobarse.
    if (tienda !== TIENDA_CENTRAL && !nombreCaja(cuerpo.caja)) return json({ error: 'Elige arriba qué caja es esta computadora.' }, 400);
    const resumen = `${cantidad} × ${prep.linea.nombre} por ${pesos(prep.reparto.dinero)} (${prep.devolverEn})`;
    try {
      await insertarSolicitud(env, id, correo, nombre, motivo, { ...datos, resumen, via: 'remoto' }, new Date().toISOString(), null, 'devolucion').run();
    } catch (error) {
      if (!String(error).includes('UNIQUE')) throw error;
      return json({ pendiente: true, solicitud_id: id }, 202);   // doble clic: ya quedo pedida
    }
    avisarDueno(env, ctx, request, `Devolución de dinero por aprobar: ${pesos(prep.reparto.dinero)}`,
      `${nombre || correo} pide devolver ${resumen} de una venta de ${pesos(prep.venta.total)}.\nMotivo: ${motivo}`);
    return json({ pendiente: true, solicitud_id: id }, 202);
  }

  return json({
    requiere_aprobacion: true,
    error: 'Devolver dinero necesita la aprobación del supervisor o de gerencia. Ofrece primero «Devolver en cupón» (lo haces tú). '
      + 'Si el cliente insiste en dinero: aprueba con el PIN del supervisor o de gerencia, o envía la solicitud a gerencia (si esta pantalla no lo ofrece, recarga la caja).',
    duenos: await aprobadoresDeDinero(env, tienda),   // dueño y supervisores de esta tienda con PIN
  }, 403);
}

/**
 * El dueno aprueba o rechaza una devolucion de dinero pendiente (la llama resolverSolicitud). Mismo patron que
 * resolverCancelacion: se reclama la solicitud (solo gana uno si dos duenos la resuelven juntos), luego se escribe.
 * Una sola vez: el id de la devolucion es el id de la solicitud y `devoluciones.id` es unico, asi que un reintento
 * (o un dueno que la aprueba dos veces) no devuelve dos veces. Piezas, cantidad y forma salen de la solicitud, no de quien aprueba.
 * La solicitud solo vale para el ticket como estaba al pedirla (misma `revision`, mismo monto y forma), el mismo dia de la tienda y
 * mientras no cierre un corte de su caja; si no, la aprobacion responde 409 y la deja rechazada.
 */
export async function resolverDevolucion(env: Env, id: string, aprobar: boolean, dueno: string): Promise<Response> {
  const solicitud = await env.DB.prepare('select correo, justificacion, datos, creado_en from solicitudes where id = ?')
    .bind(id).first<{ correo: string; justificacion: string; datos: string; creado_en: string }>();
  if (!solicitud) return json({ error: 'La solicitud no existe.' }, 404);
  const marcar = (estado: string) => env.DB.prepare(
    `update solicitudes set estado = ?, resuelto_en = ?, resuelto_por = ? where id = ? and estado = 'pendiente'`,
  ).bind(estado, new Date().toISOString(), dueno, id);
  const yaResuelta = () => json({ error: 'Otra persona ya la resolvió.' }, 409);
  if (!aprobar) {
    if (!(await marcar('rechazada').run()).meta.changes) return yaResuelta();
    return json({ id, estado: 'rechazada' });
  }
  // ponytail: entre reclamar y escribir no hay transaccion (igual que resolverCancelacion); si el Worker muere en ese
  // hueco queda aprobada sin devolver y se ve en /cuentas como aprobada (la caja no la da por hecha sin su devolucion: listarSolicitudes).
  if (!(await marcar('aprobada').run()).meta.changes) return yaResuelta();
  // Un 4xx al aprobar es definitivo (el ticket ya no es el que se pidio): queda RECHAZADA con la razon, no pendiente, para que deje de
  // frenar el ticket y la venta «en la mano»; la caja la ve rechazada y la vuelve a pedir. Una excepcion (D1 caido) si la regresa a pendiente.
  const rechazar = async (r: Resultado): Promise<Response> => {
    await env.DB.prepare(
      `update solicitudes set estado = 'rechazada', datos = json_set(datos, '$.rechazo', ?) where id = ? and estado = 'aprobada' and resuelto_por = ?`,
    ).bind(String(r.cuerpo.error ?? 'No se pudo devolver.'), id, dueno).run();
    return responder(r);
  };
  try {
    const datos = JSON.parse(solicitud.datos) as { venta_id: string; linea_id: number; cantidad: number; devolver_en: string; caja?: string; tienda?: string; dinero?: number; revision?: number };
    // Solo vale el mismo dia de la tienda y mientras no se haya cerrado un corte de esa caja: el dinero de un corte ya cerrado no se mueve despues.
    if (solicitud.creado_en < delDia(hoyTienda())[0]) return await rechazar({ status: 409, cuerpo: { error: 'Pasó el día de la tienda: vuelve a pedirla.' } });
    if (datos.caja && await env.DB.prepare('select 1 as x from cortes where caja = ? and hasta > ? limit 1').bind(datos.caja, solicitud.creado_en).first())
      return await rechazar({ status: 409, cuerpo: { error: 'Pasó el corte: vuelve a pedirla.' } });
    const pedido: PedidoPieza = { id, cantidad: datos.cantidad, motivo: solicitud.justificacion, devolverEn: datos.devolver_en, caja: datos.caja };
    const prep = await prepararPieza(env, datos.venta_id, datos.linea_id, pedido);
    if ('res' in prep) return await rechazar(prep.res);
    // El ticket tiene que seguir como estaba al pedirla: otra devolucion, un cupon, una correccion de pago o una cancelacion suben `revision`.
    if (prep.venta.revision !== datos.revision || prep.reparto.dinero !== datos.dinero || prep.devolverEn !== datos.devolver_en)
      return await rechazar({ status: 409, cuerpo: { error: 'El ticket cambió desde que se pidió la devolución: vuelve a pedirla.' } });
    // La pieza entra a la tienda de la terminal que pidio la devolucion (la guardada; las anteriores a #837 la sacan de su caja).
    const r = await escribirPieza(env, datos.venta_id, pedido, prep, solicitud.correo, datos.tienda ?? tiendaDeCaja(datos.caja));
    if (r.status >= 400) return await rechazar(r);
    return json({ ...r.cuerpo, id, solicitud_id: id, estado: 'aprobada', linea_id: datos.linea_id });
  } catch (error) {
    await env.DB.prepare(
      `update solicitudes set estado = 'pendiente', resuelto_en = null, resuelto_por = null where id = ? and estado = 'aprobada' and resuelto_por = ?`,
    ).bind(id, dueno).run();
    throw error;
  }
}

/**
 * El cajero retira su solicitud pendiente desde la ventana del ticket (#837): queda rechazada, sin mover nada. La retira quien la pidio, o
 * quien puede aprobar. Compite con la aprobacion por el mismo `update ... where estado = 'pendiente'`: gana una.
 */
export async function retirarSolicitud(ventaId: string, request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as { id?: unknown };
  const id = String(cuerpo.id ?? '');
  if (!UUID.test(ventaId) || !UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  const fila = await env.DB.prepare(`select correo, estado, json_extract(datos, '$.venta_id') as venta_id from solicitudes where id = ? and tipo = 'devolucion'`)
    .bind(id).first<{ correo: string; estado: string; venta_id: string }>();
  if (!fila || fila.venta_id !== ventaId) return json({ error: 'La solicitud no existe.' }, 404);
  const usuario = await leerUsuario(env, correo);
  if (fila.correo !== correo && !(usuario && apruebaDinero(usuario.roles))) return json({ error: 'Solo quien la pidió la puede retirar.' }, 403);
  const gano = await env.DB.prepare(
    `update solicitudes set estado = 'rechazada', resuelto_en = ?, resuelto_por = ?, datos = json_set(datos, '$.rechazo', 'La retiró quien la pidió.')
     where id = ? and estado = 'pendiente'`,
  ).bind(new Date().toISOString(), correo, id).run();
  if (!gano.meta.changes) return json({ error: `Ya estaba ${fila.estado}.`, estado: fila.estado }, 409);
  return json({ id, estado: 'rechazada' });
}

/**
 * Las solicitudes de devolucion de dinero de esta caja (pedidas por quien tiene la sesion o desde esta caja): las pendientes y las resueltas
 * en las ultimas 24 horas. La caja la pregunta al cargar y mientras espera, asi no depende de una ventana abierta ni de la memoria de la pagina.
 * `hecha`: existe la devolucion con el mismo id; una `aprobada` sin ella NO esta hecha.
 */
export async function listarSolicitudes(env: Env, correo: string, caja: string): Promise<Response> {
  const desde = new Date(Date.now() - 86_400_000).toISOString();
  const { results } = await env.DB.prepare(
    `select s.id, s.estado, s.creado_en, s.resuelto_en, json_extract(s.datos, '$.venta_id') as venta_id, json_extract(s.datos, '$.resumen') as resumen,
       json_extract(s.datos, '$.rechazo') as rechazo, d.id is not null as hecha, d.importe
     from solicitudes s left join devoluciones d on d.id = s.id
     where s.tipo = 'devolucion' and (s.correo = ?1 or (?2 != '' and json_extract(s.datos, '$.caja') = ?2))
       and (s.estado = 'pendiente' or s.creado_en >= ?3) order by s.creado_en`,
  ).bind(correo, caja, desde).all();
  return json(results.map((f) => ({ ...f, hecha: !!f.hecha })));
}

/**
 * Plazo de devoluciones (#948): hasta 7 dias despues de la compra la devolucion en cupon la autoriza el cajero; pasado ese plazo, el encargado
 * (regla de gerencia que ya cita la guia de la caja, ayuda-contenido.js: «pasaron más de 7 días … llama al encargado»). Dias corridos de 24 h.
 */
export const PLAZO_DEVOLUCION_MS = 7 * 86_400_000;

/**
 * ¿Ya paso el plazo? `creado_en` lo manda la caja (G1 del 16/11: sin limite inferior), asi que se toma la mas antigua entre ella y `registrado_en`
 * (la hora a la que la venta llego al servidor, que la caja no controla): una hora recien puesta a mano no rejuvenece una venta vieja, y una venta
 * cobrada sin red se mide desde que se cobro. Una fecha ilegible se ignora; sin ninguna legible se trata como fuera de plazo.
 */
export function fueraDePlazo(creadoEn: string, registradoEn: string, ahoraMs: number): boolean {
  const fechas = [creadoEn, registradoEn].map((f) => Date.parse(f)).filter(Number.isFinite);
  return fechas.length === 0 || ahoraMs - Math.min(...fechas) > PLAZO_DEVOLUCION_MS;
}

/**
 * Cupon de una venta fuera de plazo: lo aprueba el supervisor o gerencia, igual que devolver dinero (#837): ellos mismos con su sesion, o el cajero con el
 * PIN de uno de ellos en esta caja (aprobadorConPin: mismo contador de intentos). Sin solicitud a distancia: esa resuelve UNA pieza de dinero (resolverDevolucion).
 * `por`: quien aprobo (queda en el cupon, `aprobado_por`), o null dentro del plazo. Se llama ya validado el pedido: nada se escribe aqui.
 */
async function aprobacionFueraDePlazo(
  env: Env, venta: Pick<VentaFila, 'id' | 'creado_en'>, cuerpo: { aprobador?: unknown; pin?: unknown }, correo: string, caja: string, tienda: string,
): Promise<{ por: string | null } | { res: Response }> {
  const registrada = await env.DB.prepare('select registrado_en from ventas where id = ?').bind(venta.id).first<{ registrado_en: string }>();
  if (!fueraDePlazo(venta.creado_en, registrada?.registrado_en ?? '', Date.now())) return { por: null };
  const usuario = await leerUsuario(env, correo);
  if (usuario && apruebaDinero(usuario.roles)) return { por: correo };
  if (cuerpo.aprobador) {
    const aprobo = await aprobadorConPin(env, correo, cuerpo.aprobador, cuerpo.pin, caja, tienda);
    return 'error' in aprobo ? { res: json({ error: aprobo.error }, aprobo.status) } : { por: aprobo.por };
  }
  return { res: json({
    requiere_aprobacion: true, fuera_de_plazo: true,
    error: 'Esta compra tiene más de 7 días: devolverla en cupón necesita la aprobación del supervisor o de gerencia. '
      + 'Aprueba con el PIN del supervisor o de gerencia (si esta pantalla no lo ofrece, recarga la caja).',
    duenos: await aprobadoresDeDinero(env, tienda),
  }, 403) };
}

const piezasQueQuedan = async (env: Env, ventaId: string) => (await env.DB.prepare(
  'select sum(cantidad - cancelada_cantidad) as restan from venta_lineas where venta_id = ?',
).bind(ventaId).first<{ restan: number }>())!.restan;

/**
 * Devolver piezas con un cupón de Dolarones en lugar de dinero (Issue #330). Como
 * cancelarPieza, pieza por pieza y en un solo batch, pero el dinero no sale del cajon:
 * queda en `devoluciones.cupon` y `ventas.devuelto_cupon` (el corte lo vuelve a sumar) y
 * sale un cupón por `porcentajeCupon` de ese dinero. Lo pagado con Dolarones regresa al socio
 * como siempre. `id` (de la caja) es el id del cupón: un reenvio no emite dos.
 * Fuera del plazo de devoluciones (PLAZO_DEVOLUCION_MS) pide la aprobacion del supervisor o de gerencia (#948).
 * `lineas`: [{ linea, cantidad }] o 'todo' (lo que queda del ticket).
 */
export async function devolverEnCupon(ventaId: string, request: Request, env: Env, correo: string, tienda: string): Promise<Response> {
  if (!UUID.test(ventaId)) return json({ error: 'Identificador de venta invalido.' }, 400);
  const cuerpo = (await request.json().catch(() => ({}))) as { id?: unknown; lineas?: unknown; motivo?: unknown; caja?: unknown; aprobador?: unknown; pin?: unknown };
  const id = String(cuerpo.id ?? '');
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  const motivo = String(cuerpo.motivo ?? '').trim().slice(0, 200);
  if (!motivo) return json({ error: 'Escribe el motivo de la devolucion.' }, 400);

  const previo = await leerCupon(env, id);
  if (previo) return json({ id, venta_id: ventaId, cupon: previo, duplicada: true });

  const venta = await leerVenta(env, ventaId);
  if (!venta) return json({ error: 'La venta no existe.' }, 404);
  if (venta.cancelada) return json({ error: 'El ticket ya estaba cancelado completo.' }, 409);
  if (venta.anticipo > 0) return json({ error: TICKET_CON_ANTICIPO }, 409);
  // Sin socio, un ticket pagado con vale solo se cancela completo. Con socio y cupón (#927) la pieza sí se devuelve en cupón.
  if (venta.dolarones > 0 && !venta.cliente_id) {
    return json({ error: 'Este ticket se pagó con un vale: cancélalo completo, en dinero.' }, 409);
  }
  if (await devolucionPendiente(env, ventaId)) return json({ error: HAY_DEVOLUCION }, 409);

  const { results: todas } = await env.DB.prepare(
    'select id, producto_id, precio, cantidad, cancelada_cantidad from venta_lineas where venta_id = ? order by id',
  ).bind(ventaId).all<{ id: number; producto_id: string | null; precio: number; cantidad: number; cancelada_cantidad: number }>();
  const pedidas = cuerpo.lineas === 'todo'
    ? todas.filter((l) => l.cantidad > l.cancelada_cantidad).map((l) => ({ linea: l.id, cantidad: l.cantidad - l.cancelada_cantidad }))
    : Array.isArray(cuerpo.lineas)
      ? (cuerpo.lineas as { linea?: unknown; cantidad?: unknown }[]).map((l) => ({ linea: Number(l?.linea), cantidad: Number(l?.cantidad ?? 1) }))
      : [];
  if (pedidas.length === 0 || pedidas.length > 100) return json({ error: 'Elige las piezas que se devuelven.' }, 400);
  if (new Set(pedidas.map((p) => p.linea)).size !== pedidas.length) return json({ error: 'Pieza repetida.' }, 400);

  // Pieza por pieza, como si se cancelaran una tras otra (mismo reparto que cancelarPieza).
  const pagado = venta.total - venta.dolarones;
  let devuelto = venta.devuelto;
  let dolaronesDevueltos = venta.dolarones_devueltos;
  let restan = todas.reduce((n, l) => n + l.cantidad - l.cancelada_cantidad, 0);
  let base = 0;
  const ahora = new Date();
  const iso = ahora.toISOString();
  const caja = await cajaDe(env, correo, cuerpo.caja, tienda);
  const sentencias: D1PreparedStatement[] = [];
  for (const p of pedidas) {
    const linea = todas.find((l) => l.id === p.linea);
    if (!linea) return json({ error: 'La pieza no es de este ticket.' }, 404);
    const quedan = linea.cantidad - linea.cancelada_cantidad;
    if (!Number.isInteger(p.cantidad) || p.cantidad < 1) return json({ error: 'Cantidad invalida.' }, 400);
    if (quedan <= 0) return json({ error: 'Esa pieza ya estaba cancelada.' }, 409);
    if (p.cantidad > quedan) return json({ error: `Solo quedan ${quedan} de esa pieza en el ticket.` }, 400);
    const importe = importePiezas({ precio: linea.precio, cantidad: p.cantidad, restan, total: venta.total,
      descuento: venta.descuento, devuelto, dolaronesDevueltos });
    const reparto = repartirDevolucion({ importe, pagado, devuelto, dolarones: venta.dolarones, dolaronesDevueltos });
    devuelto += reparto.dinero;
    dolaronesDevueltos += reparto.dolarones;
    restan -= p.cantidad;
    base += reparto.dinero;
    sentencias.push(
      env.DB.prepare('update venta_lineas set cancelada_cantidad = cancelada_cantidad + ? where id = ?').bind(p.cantidad, linea.id),
      env.DB.prepare(
        `insert into devoluciones (id, venta_id, linea_id, cantidad, importe, dolarones, cupon, vale_id, forma_pago, caja, autor, motivo, creado_en, tienda)
         values (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), ventaId, linea.id, p.cantidad, reparto.dolarones, reparto.dinero, id, venta.forma_pago,
        caja, correo, motivo, iso, tienda),
      // Los bins no regresan existencia: nadie cuenta cuantas piezas hay en un bote.
      ...(linea.producto_id ? sentenciasMover(env, tienda, linea.producto_id, p.cantidad, iso, true) : []),
    );
  }
  const porcentaje = await porcentajeCupon(env);
  // Lo que se pagó con Dolarones (la parte de la pieza que pasa del dinero) regresa primero a la CUENTA, hasta lo que ella aún tiene canjeado en
  // este ticket; lo demás lo pagó un cupón viejo, que no se restaura: se suma 1:1 (sin el porcentaje) al cupón nuevo (#927). Todo sale de las bitácoras.
  const dolaronesDelta = dolaronesDevueltos - venta.dolarones_devueltos;
  const papelPendiente = dolaronesDelta > 0 && venta.cliente_id ? await papelPorReemitir(env, ventaId) : 0;
  const cuentaPendiente = papelPendiente > 0 ? await canjeDeCuentaPendiente(env, ventaId) : dolaronesDelta;
  const papel = Math.min(Math.max(0, dolaronesDelta - cuentaPendiente), papelPendiente);
  const importeCupon = Math.round((base * porcentaje) / 100) + papel;
  if (importeCupon <= 0) {
    return json({ error: 'Esas piezas se pagaron con Dolarones: no hay dinero que pasar a cupón. Cancélalas normal.' }, 409);
  }
  const plazo = await aprobacionFueraDePlazo(env, venta, cuerpo, correo, caja, tienda);   // #948
  if ('res' in plazo) return plazo.res;
  const { cupon, sentencia } = nuevoCupon(env, {
    id, origen: 'devolucion', importe: importeCupon, ahora, ventaOrigen: ventaId, motivo, autor: correo, aprobadoPor: plazo.por ?? undefined,
  });

  try {
    await env.DB.batch([
      // Primero el candado: si otra cancelacion de este ticket se adelanto, aborta todo.
      env.DB.prepare(
        `update ventas set revision = ?, devuelto = devuelto + ?, devuelto_cupon = devuelto_cupon + ?,
           dolarones_devueltos = dolarones_devueltos + ? where id = ?`,
      ).bind(venta.revision + 1, base, base, dolaronesDevueltos - venta.dolarones_devueltos, ventaId),
      ...sentencias,
      ...(await sentenciasDeReverso(env, {
        ventaId, clienteId: venta.cliente_id, autor: correo, ahora: iso, completa: false,
        dolarones: dolaronesDelta - papel, papel, pagadoRestante: pagado - devuelto,
      })),
      sentencia,
    ]);
  } catch (error) {
    const texto = String(error);
    if (texto.includes('UNIQUE') && texto.includes('vales_dolarones')) {
      const ya = await leerCupon(env, id);
      if (ya) return json({ id, venta_id: ventaId, cupon: ya, duplicada: true });
    }
    if (texto.includes('ticket cambio') || texto.includes('pieza ya cancelada')) {
      return json({ error: 'Alguien mas cambio este ticket. Vuelve a abrirlo.' }, 409);
    }
    if (texto.includes('saldo insuficiente')) {
      return json({ error: 'Los Dolarones ganados con esta compra ya se usaron. Requiere aclaración presencial.' }, 409);
    }
    if (texto.includes('saldo de vale invalido')) {
      return json({ error: 'El vale de esta compra ya se usó. Requiere aclaración presencial.' }, 409);
    }
    throw error;
  }
  return json({ id, venta_id: ventaId, cupon, base, porcentaje, dolarones: dolaronesDelta, dolarones_cuenta: dolaronesDelta - papel, cupon_papel: papel }, 201);
}

/** Reimprimir el cupón de una devolucion de este ticket: mismo codigo, saldo y vencimiento. */
export async function reimprimirCupon(ventaId: string, valeId: string, env: Env): Promise<Response> {
  if (!UUID.test(ventaId) || !UUID.test(valeId)) return json({ error: 'Identificador invalido.' }, 400);
  const cupon = await env.DB.prepare(`select id, codigo, importe, restante, disponible_desde, vence_en, creado_en, origen
    from vales_dolarones where id = ? and venta_origen = ? and restante > 0 and vence_en > ?`)
    .bind(valeId, ventaId, new Date().toISOString()).first();
  if (!cupon) return json({ error: 'Ese cupón ya se usó o venció.' }, 404);
  const respuesta = json(cupon);
  respuesta.headers.set('cache-control', 'no-store');
  return respuesta;
}
