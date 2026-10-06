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

import { contadoDe } from '../public/venta.js';
import { leerUsuario } from './cuentas.ts';

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
  const tipo = cuerpo.tipo === 'gasto' ? 'gasto' : cuerpo.tipo === undefined || cuerpo.tipo === 'retiro' ? 'retiro' : '';
  const caja = await cajaDe(env, correo, cuerpo.caja);
  const importe = Number(cuerpo.importe);
  const motivo = texto(cuerpo.motivo, 200);
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!tipo) return json({ error: 'Tipo invalido.' }, 400);
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
    `insert into retiros (id, tipo, caja, cajero, importe, motivo, creado_en) values (?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do nothing`,
  )
    .bind(id, tipo, caja, correo, importe, motivo, new Date().toISOString())
    .run();
  const retiro = await env.DB.prepare('select id, tipo, caja, cajero, importe, motivo, creado_en from retiros where id = ?')
    .bind(id)
    .first();
  return json(retiro, 201);
}

export interface Corte {
  id: string; caja: string; cajero: string; desde: string | null; hasta: string; tickets: number;
  fondo_inicial: number; efectivo_ventas: number; efectivo_devoluciones: number; retiros: number; gastos: number;
  efectivo_esperado: number; efectivo_contado: number; diferencia: number;
  tarjeta_sistema: number; tarjeta_terminal: number; transferencias: number; dolarones: number;
  fondo_siguiente: number; entregado: number; conteo: string; notas: string; creado_en: string;
}

const leerCorte = (env: Env, id: string) =>
  env.DB.prepare('select * from cortes where id = ?').bind(id).first<Corte>();

// Lo cobrado (o devuelto) de una forma de pago, sin la parte pagada con Dolarones.
const dinero = (forma: string, importe = 'total - dolarones') =>
  `coalesce(sum(case when forma_pago = '${forma}' then ${importe} end), 0)`;
// Lo que queda de un ticket despues de lo devuelto por piezas sueltas (Issue #138).
const NETO = 'total - dolarones - devuelto';
// Lo cobrado: ventas de este corte que siguen vigentes, netas de lo ya devuelto.
const VIGENTES = 'corte_id = ?1 and cancelada = 0';
// La venta ya se habia contado en un corte anterior a `cuando` (la hora de la devolucion).
const contadaAntes = (cuando: string) => `corte_id in (select id from cortes where hasta < ${cuando})`;
// Ticket completo cancelado en esta caja, de una venta ya contada: sale lo que quedaba.
const CANCELADAS = `corte_cancelacion_id = ?1 and ${contadaAntes('cancelada_en')}`;
// Piezas sueltas devueltas en esta caja, de una venta ya contada (tabla devoluciones).
const DEVUELTAS = `d.corte_id = ?1 and d.venta_id in (select id from ventas where ${contadaAntes('d.creado_en')})`;
const devuelto = (forma: string) => `(select ${dinero(forma, 'importe')} from devoluciones d where ${DEVUELTAS})`;

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
      env.DB.prepare('update retiros set corte_id = ? where caja = ? and corte_id is null').bind(id, caja),
      env.DB.prepare('update devoluciones set corte_id = ? where caja = ? and corte_id is null').bind(id, caja),
      env.DB.prepare(
        `insert into cortes (id, caja, cajero, desde, hasta, tickets, fondo_inicial, efectivo_ventas,
           efectivo_devoluciones, retiros, gastos, efectivo_esperado, efectivo_contado, diferencia, tarjeta_sistema,
           tarjeta_terminal, transferencias, dolarones, fondo_siguiente, entregado, conteo, notas, creado_en)
         select ?1, ?2, ?3, desde, ?4, tickets, fondo, ev, ed, re, ga,
                fondo + ev - ed - re - ga, ?5, ?5 - (fondo + ev - ed - re - ga), tv - td,
                ?6, xv - xd, dv - dd, min(?5, ?7), ?5 - min(?5, ?7), ?9, ?8, ?4
         from (select
           (select max(hasta) from cortes where caja = ?2) as desde,
           coalesce((select fondo_siguiente from cortes where caja = ?2 order by hasta desc limit 1), ?7) as fondo,
           (select count(*) from ventas where ${VIGENTES}) as tickets,
           (select ${dinero('efectivo', NETO)} from ventas where ${VIGENTES}) as ev,
           (select ${dinero('efectivo', NETO)} from ventas where ${CANCELADAS}) + ${devuelto('efectivo')} as ed,
           (select coalesce(sum(importe), 0) from retiros where corte_id = ?1 and tipo = 'retiro') as re,
           (select coalesce(sum(importe), 0) from retiros where corte_id = ?1 and tipo = 'gasto') as ga,
           (select ${dinero('tarjeta', NETO)} from ventas where ${VIGENTES}) as tv,
           (select ${dinero('tarjeta', NETO)} from ventas where ${CANCELADAS}) + ${devuelto('tarjeta')} as td,
           (select ${dinero('transferencia', NETO)} from ventas where ${VIGENTES}) as xv,
           (select ${dinero('transferencia', NETO)} from ventas where ${CANCELADAS})
             + ${devuelto('transferencia')} as xd,
           (select coalesce(sum(dolarones - dolarones_devueltos), 0) from ventas where ${VIGENTES}) as dv,
           (select coalesce(sum(dolarones - dolarones_devueltos), 0) from ventas where ${CANCELADAS})
             + (select coalesce(sum(d.dolarones), 0) from devoluciones d where ${DEVUELTAS}) as dd)`,
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
  const corte = await env.DB.prepare('select * from cortes where caja = ? order by hasta desc limit 1')
    .bind(caja)
    .first<Corte>();
  return corte ? json(corte) : json({ error: 'Esta caja todavia no tiene cortes.' }, 404);
}
