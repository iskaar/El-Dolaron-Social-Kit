/**
 * Corte de caja (Issue #100).
 *
 * Por caja, no por dia ni por cajero: cada cajon tiene su dinero. Un corte
 * junta lo de su caja desde el corte anterior:
 * - lo cobrado en esa caja y todavia vigente al cortar, sin lo ya devuelto de
 *   ella por piezas sueltas: una venta cancelada antes de su corte no aparece
 *   en ningun corte (Isaac, 28/09, Issue #123);
 * - lo devuelto en esa caja, de ticket completo o de piezas sueltas (Issue
 *   #138), solo de ventas que ya se contaron en un corte ANTERIOR a la
 *   devolucion: dinero de otro turno que sale de este cajon;
 * - los retiros y gastos de efectivo de esa caja.
 * El orden de los cortes de cada caja no importa: se compara la hora del
 * corte que conto la venta con la hora de la devolucion.
 * ponytail: una venta cobrada en una caja y devuelta en otra antes de
 * cualquier corte no sale en ninguna; si de verdad se devolvio efectivo de
 * otro cajon, en uno sobra y en otro falta lo mismo (regla de Isaac).
 *
 * Conteo ciego: la caja manda solo lo contado, por billete y moneda (Isaac lo
 * simplifico a un total el 28/09 y el 3/10 pidio volver al conteo; `efectivo_contado`
 * sigue aceptandose para una caja con la pagina vieja). Lo esperado se calcula aqui, en
 * el mismo batch que marca las ventas, y se guarda junto con lo contado: ya no
 * se puede volver a contar para que cuadre.
 */

import { lineasNetas } from './netas.ts';
import { contadoDe } from '../public/venta.js';
import { leerUsuario } from './cuentas.ts';
import { CATEGORIAS_GASTO } from '../public/categorias.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FONDO_POR_OMISION = 50000;

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** El nombre de la caja que manda la computadora («Caja 1»). '' si no viene. */
export const nombreCaja = (valor: unknown) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);

/**
 * La caja de lo que hace esta persona (Issue #105): la suya si el dueno se la
 * asigno en /cuentas, entre en la computadora que entre; si no tiene, la que se
 * eligio en la computadora.
 */
export async function cajaDe(env: Env, correo: string, pedida: unknown): Promise<string> {
  const usuario = await leerUsuario(env, correo);
  return usuario?.caja || nombreCaja(pedida);
}

const texto = (valor: unknown, max: number) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Gastos que el cajero paga del cajon sin aprobacion (decision de Isaac del
 * 28/09). Uno mayor lo registra el dueno. ponytail: fijo; si cambia seguido, a
 * `config` como el fondo.
 */
export const LIMITE_GASTO_CAJERO = 10000;

/**
 * Efectivo que sale del cajon a media jornada: un retiro (a la caja fuerte, al
 * banco) o un gasto. Se registra antes de abrir el cajon: nunca sale dinero sin
 * rastro.
 */
export async function registrarRetiro(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  const tipo = cuerpo.tipo === 'gasto' || cuerpo.tipo === 'terminal' ? cuerpo.tipo
    : cuerpo.tipo === undefined || cuerpo.tipo === 'retiro' ? 'retiro' : '';
  const caja = await cajaDe(env, correo, cuerpo.caja);
  const importe = Number(cuerpo.importe);
  const motivo = texto(cuerpo.motivo, 200) || (tipo === 'terminal' ? 'Pago de la terminal' : '');
  const categoria = tipo === 'gasto' ? String(cuerpo.categoria ?? '') : '';
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!tipo) return json({ error: 'Tipo invalido.' }, 400);
  if (tipo === 'gasto' && !CATEGORIAS_GASTO.some(([clave]) => clave === categoria)) return json({ error: 'Categoría invalida.' }, 400);
  if (!caja) return json({ error: 'Falta la caja.' }, 400);
  if (!Number.isInteger(importe) || importe <= 0 || importe > 10_000_000) return json({ error: 'Importe invalido.' }, 400);
  if (!motivo) return json({ error: tipo === 'gasto' ? 'Escribe en que se gasto.' : 'Escribe el motivo del retiro.' }, 400);
  if (tipo === 'gasto' && importe > LIMITE_GASTO_CAJERO) {
    const usuario = await leerUsuario(env, correo);
    if (!usuario?.roles.includes('dueno')) {
      return json({ error: `Los gastos de mas de $${LIMITE_GASTO_CAJERO / 100} los registra el dueno.` }, 403);
    }
  }
  await env.DB.prepare(
    `insert into retiros (id, tipo, caja, cajero, importe, motivo, creado_en, categoria) values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do nothing`,
  )
    .bind(id, tipo, caja, correo, importe, motivo, new Date().toISOString(), categoria)
    .run();
  const retiro = await env.DB.prepare('select id, tipo, caja, cajero, importe, motivo, creado_en, categoria from retiros where id = ?')
    .bind(id)
    .first();
  return json(retiro, 201);
}

export interface Corte {
  id: string; caja: string; cajero: string; desde: string | null; hasta: string; tickets: number;
  fondo_inicial: number; efectivo_ventas: number; efectivo_devoluciones: number; retiros: number; gastos: number; nomina: number;
  efectivo_esperado: number; efectivo_contado: number; diferencia: number;
  tarjeta_sistema: number; tarjeta_terminal: number; transferencias: number; dolarones: number;
  fondo_siguiente: number; entregado: number; conteo: string; notas: string; creado_en: string;
  fep_por_pagar: number;   // lo cobrado de piezas de FEP en esta caja, a pagarle a FEP (Issue #298)
  entrada_terminal: number;   // efectivo que entrego el dueno de la terminal a este cajon (Issue #515)
}

// Sin columna en `cortes` (sin migracion): sale de los retiros 'terminal' que marco el corte.
const CON_TERMINAL = `select c.*, (select coalesce(sum(importe), 0) from retiros
  where corte_id = c.id and tipo = 'terminal') as entrada_terminal from cortes c`;
const leerCorte = (env: Env, id: string) =>
  env.DB.prepare(`${CON_TERMINAL} where c.id = ?`).bind(id).first<Corte>();

// Lo cobrado (o devuelto) de una forma de pago, sin la parte pagada con Dolarones.
const dinero = (forma: string, importe = 'total - dolarones') =>
  `coalesce(sum(case when forma_pago = '${forma}' then ${importe} end), 0)`;
// Lo que queda de un ticket despues de lo devuelto por piezas sueltas (Issue #138) y de lo que
// pago el saldo de un pedido (Issue #269): ese dinero entro antes, con el anticipo.
const NETO = 'total - dolarones - anticipo - devuelto';
// Lo devuelto en cupón (Issue #330) se quedó en el cajón: para lo cobrado vigente se vuelve a sumar.
const COBRADO = `${NETO} + devuelto_cupon`;
// Anticipos de pedidos recibidos en esta caja desde su corte anterior, aunque el pedido ya se haya cancelado o vencido.
const anticipos = (forma: string) => `((select ${dinero(forma, 'anticipo')} from pedidos where corte_id = ?1)
  + (select ${dinero(forma, 'importe')} from pedido_movimientos where corte_id = ?1 and tipo = 'abono'))`;
// Lo cobrado: ventas de este corte que siguen vigentes, netas de lo ya devuelto.
const VIGENTES = 'corte_id = ?1 and cancelada = 0';
// La venta ya se habia contado en un corte anterior a `cuando` (la hora de la devolucion).
const contadaAntes = (cuando: string) => `corte_id in (select id from cortes where hasta < ${cuando})`;
// Ticket completo cancelado en esta caja, de una venta ya contada: sale lo que quedaba.
const CANCELADAS = `corte_cancelacion_id = ?1 and ${contadaAntes('cancelada_en')}`;
// Piezas sueltas devueltas en esta caja, de una venta ya contada (tabla devoluciones).
const DEVUELTAS = `d.corte_id = ?1 and d.venta_id in (select id from ventas where ${contadaAntes('d.creado_en')})`;
const devuelto = (forma: string) => `(select ${dinero(forma, 'importe')} from devoluciones d where ${DEVUELTAS})`;
// Pieza de un ticket de este corte, cobrado con tarjeta o transferencia, que se devolvio en efectivo de este cajon:
// el ticket la resto de su forma (ventas.devuelto) pero el dinero salio del cajon. Sin filtrar `forma` es todo lo
// que salio en efectivo; con `forma`, lo que hay que regresarle a esa forma.
const enEfectivo = (forma = '') => `(select coalesce(sum(d.importe), 0) from devoluciones d join ventas v on v.id = d.venta_id
  where v.corte_id = ?1 and d.corte_id = ?1 and d.forma_pago = 'efectivo' and v.forma_pago != 'efectivo'${forma ? ` and v.forma_pago = '${forma}'` : ''})`;

export async function registrarCorte(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  const caja = await cajaDe(env, correo, cuerpo.caja);
  const conteo = cuerpo.conteo as Record<string, number> | undefined;
  const contado = conteo ? contadoDe(conteo) : Number(cuerpo.efectivo_contado);
  const terminal = Number(cuerpo.tarjeta_terminal ?? 0);
  const notas = texto(cuerpo.notas, 500);
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!caja) return json({ error: 'Falta la caja.' }, 400);
  if (contado === null || !Number.isInteger(contado) || contado < 0 || contado > 100_000_000) return json({ error: 'Efectivo contado invalido.' }, 400);
  if (!Number.isInteger(terminal) || terminal < 0 || terminal > 100_000_000) return json({ error: 'Total de la terminal invalido.' }, 400);
  // 24/10: un corte cerrado sin contar dejo el fondo del dia siguiente en $0 y descuadro todo. Un cajon
  // vacio de verdad se confirma en la caja (`sin_efectivo`); una caja vieja que no lo manda no puede.
  if (contado === 0 && cuerpo.sin_efectivo !== true)
    return json({ error: 'No se contó el efectivo. Cuenta billetes y monedas; si el cajón de verdad está vacío, confírmalo en la caja.' }, 400);

  const previo = await leerCorte(env, id);
  if (previo) return json(previo);   // reenvio tras red caida: el mismo corte, sin volver a contar

  const config = await env.DB.prepare(`select valor from config where clave = 'fondo_caja'`).first<{ valor: string }>();
  const fondo = Number.parseInt(config?.valor ?? '', 10);
  const fondoConfig = Number.isFinite(fondo) && fondo >= 0 ? fondo : FONDO_POR_OMISION;
  const ahora = new Date().toISOString();

  // Primero se marcan ventas, devoluciones y retiros con este corte; luego el
  // corte se calcula de lo marcado. Todo en un batch: una venta que llegue en
  // medio va entera a este corte o entera al siguiente, nunca a medias.
  try {
    await env.DB.batch([
      env.DB.prepare('update ventas set corte_id = ? where caja = ? and corte_id is null').bind(id, caja),
      env.DB.prepare(
        `update ventas set corte_cancelacion_id = ?
         where cancelada = 1 and cancelada_caja = ? and corte_cancelacion_id is null`,
      ).bind(id, caja),
      env.DB.prepare('update pedidos set corte_id = ? where caja = ? and corte_id is null').bind(id, caja),
      env.DB.prepare(`update pedido_movimientos set corte_id = ? where caja = ? and corte_id is null and tipo = 'abono'`).bind(id, caja),
      env.DB.prepare('update retiros set corte_id = ? where caja = ? and corte_id is null').bind(id, caja),
      env.DB.prepare('update devoluciones set corte_id = ? where caja = ? and corte_id is null').bind(id, caja),
      env.DB.prepare(
        `insert into cortes (id, caja, cajero, desde, hasta, tickets, fondo_inicial, efectivo_ventas,
           efectivo_devoluciones, retiros, gastos, nomina, efectivo_esperado, efectivo_contado, diferencia, tarjeta_sistema,
           tarjeta_terminal, transferencias, dolarones, fondo_siguiente, entregado, conteo, notas, creado_en, fep_por_pagar)
         select ?1, ?2, ?3, desde, ?4, tickets, fondo, ev, ed, re, ga, no,
                fondo + ev - ed - re - ga - no + te, ?5, ?5 - (fondo + ev - ed - re - ga - no + te), tv - td,
                ?6, xv - xd, dv - dd, min(?5, ?7), ?5 - min(?5, ?7), ?9, ?8, ?4, fp
         from (select
           (select max(hasta) from cortes where caja = ?2) as desde,
           coalesce((select fondo_siguiente from cortes where caja = ?2 order by hasta desc limit 1), ?7) as fondo,
           (select count(*) from ventas where ${VIGENTES}) as tickets,
           (select ${dinero('efectivo', COBRADO)} from ventas where ${VIGENTES}) + ${anticipos('efectivo')} as ev,
           (select ${dinero('efectivo', NETO)} from ventas where ${CANCELADAS}) + ${devuelto('efectivo')} + ${enEfectivo()} as ed,
           (select coalesce(sum(importe), 0) from retiros where corte_id = ?1 and tipo = 'retiro') as re,
           (select coalesce(sum(importe), 0) from retiros where corte_id = ?1 and tipo = 'gasto') as ga,
           (select coalesce(sum(importe), 0) from retiros where corte_id = ?1 and tipo = 'nomina') as no,
           -- Entra: el dueno de la terminal paga en efectivo lo cobrado con tarjeta (Issue #515).
           (select coalesce(sum(importe), 0) from retiros where corte_id = ?1 and tipo = 'terminal') as te,
           (select ${dinero('tarjeta', COBRADO)} from ventas where ${VIGENTES}) + ${anticipos('tarjeta')} + ${enEfectivo('tarjeta')} as tv,
           (select ${dinero('tarjeta', NETO)} from ventas where ${CANCELADAS}) + ${devuelto('tarjeta')} as td,
           (select ${dinero('transferencia', COBRADO)} from ventas where ${VIGENTES}) + ${anticipos('transferencia')}
             + ${enEfectivo('transferencia')} as xv,
           (select ${dinero('transferencia', NETO)} from ventas where ${CANCELADAS})
             + ${devuelto('transferencia')} as xd,
           (select coalesce(sum(dolarones - dolarones_devueltos), 0) from ventas where ${VIGENTES}) as dv,
           (select coalesce(sum(dolarones - dolarones_devueltos), 0) from ventas where ${CANCELADAS})
             + (select coalesce(sum(d.dolarones), 0) from devoluciones d where ${DEVUELTAS}) as dd,
           -- FEP: lo cobrado (efectivo, tarjeta, transferencia) de sus piezas en esta caja; lo pagado con Dolarones
           -- se descuenta. Un ticket de FEP cancelado despues resta de este corte; el cancelado en el mismo turno no cuenta.
           -- Mismo reparto por pieza que los reportes (netas.ts).
           (${lineasNetas('v.corte_id = ?1')} select coalesce(sum(cobrado), 0) from cobros where propietario = 'fep')
           - (${lineasNetas('v.corte_cancelacion_id = ?1 and v.corte_id != ?1', true)} select coalesce(sum(cobrado), 0) from cobros where propietario = 'fep') as fp)`,
      ).bind(id, caja, correo, ahora, contado, terminal, fondoConfig, notas, JSON.stringify(conteo ?? {})),
    ]);
  } catch (error) {
    // Dos envios del mismo corte a la vez: el segundo choca con la llave y el primero ya quedo.
    const ya = await leerCorte(env, id);
    if (ya) return json(ya);
    throw error;
  }
  return json(await leerCorte(env, id), 201);
}

/** El ultimo corte de una caja, para reimprimirlo. */
export async function ultimoCorte(url: URL, env: Env, correo: string): Promise<Response> {
  const caja = await cajaDe(env, correo, url.searchParams.get('caja'));
  if (!caja) return json({ error: 'Falta la caja.' }, 400);
  const corte = await env.DB.prepare(`${CON_TERMINAL} where c.caja = ? order by c.hasta desc limit 1`)
    .bind(caja)
    .first<Corte>();
  return corte ? json(corte) : json({ error: 'Esta caja todavia no tiene cortes.' }, 404);
}

/**
 * Cuenta con el dueno de la terminal (Issue #515): cobra con su terminal y paga
 * el 100 % en efectivo cada pocos dias, a veces al cajon (retiro 'terminal' de
 * la caja) y a veces al dueno (retiro 'terminal' sin caja: ningun corte lo toma).
 * Se le cuenta por corte el cierre de la terminal y, si no se capturo (antes del
 * 24/10), lo de tarjeta en el sistema.
 * ponytail: un corte con terminal $0 y tarjeta en el sistema cuenta el sistema;
 * desde #514 el cajero escribe el cierre, asi que solo pasa si de verdad no se cobro con ella.
 */
export async function rutaTerminal(request: Request, env: Env, correo: string): Promise<Response> {
  if (request.method === 'POST') {
    const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(cuerpo.id ?? '');
    const importe = Number(cuerpo.importe);
    if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
    if (!Number.isInteger(importe) || importe <= 0 || importe > 100_000_000) return json({ error: 'Importe invalido.' }, 400);
    await env.DB.prepare(
      `insert into retiros (id, tipo, caja, cajero, importe, motivo, creado_en, categoria) values (?, 'terminal', '', ?, ?, ?, ?, '')
       on conflict (id) do nothing`,
    ).bind(id, correo, importe, texto(cuerpo.motivo, 200) || 'Pago de la terminal al dueño', new Date().toISOString()).run();
  } else if (request.method !== 'GET') return json({ error: 'Metodo no permitido.' }, 405);

  const { results: cortes } = await env.DB.prepare(
    `select hasta, caja, tarjeta_sistema, tarjeta_terminal,
            case when tarjeta_terminal > 0 then tarjeta_terminal else tarjeta_sistema end as cuenta
     from cortes order by hasta desc`,
  ).all<{ hasta: string; caja: string; tarjeta_sistema: number; tarjeta_terminal: number; cuenta: number }>();
  const { results: pagos } = await env.DB.prepare(
    `select id, creado_en, caja, cajero, importe, motivo from retiros where tipo = 'terminal' order by creado_en desc`,
  ).all<{ id: string; creado_en: string; caja: string; cajero: string; importe: number; motivo: string }>();
  const vendido = cortes.reduce((s, c) => s + c.cuenta, 0);
  const pagado = pagos.reduce((s, p) => s + p.importe, 0);
  return json({ vendido, pagado, debe: vendido - pagado, cortes, pagos }, request.method === 'POST' ? 201 : 200);
}
