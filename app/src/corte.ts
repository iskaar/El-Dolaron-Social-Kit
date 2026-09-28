/**
 * Corte de caja (Issue #100).
 *
 * Por caja, no por dia ni por cajero: cada cajon tiene su dinero. Un corte
 * junta lo de su caja desde el corte anterior:
 * - lo cobrado en esa caja (la venta suma donde se cobro, aunque despues se cancele);
 * - lo devuelto por cancelaciones hechas en esa caja (resta donde se devolvio);
 * - los retiros de efectivo de esa caja.
 * Asi una venta cancelada en la misma caja y el mismo turno da cero, y una
 * cancelada en otra caja o en otro turno sale del cajon que de verdad pago.
 *
 * Conteo ciego: la caja manda solo lo contado. Lo esperado se calcula aqui, en
 * el mismo batch que marca las ventas, y se guarda junto con lo contado: ya no
 * se puede volver a contar para que cuadre.
 */

import { contadoDe } from '../public/venta.js';

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

const texto = (valor: unknown, max: number) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Sacar efectivo a media jornada. Queda antes de abrir el cajon: nunca hay retiro sin registro. */
export async function registrarRetiro(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  const caja = nombreCaja(cuerpo.caja);
  const importe = Number(cuerpo.importe);
  const motivo = texto(cuerpo.motivo, 200);
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!caja) return json({ error: 'Falta la caja.' }, 400);
  if (!Number.isInteger(importe) || importe <= 0 || importe > 10_000_000) return json({ error: 'Importe invalido.' }, 400);
  if (!motivo) return json({ error: 'Escribe el motivo del retiro.' }, 400);
  await env.DB.prepare(
    `insert into retiros (id, caja, cajero, importe, motivo, creado_en) values (?, ?, ?, ?, ?, ?)
     on conflict (id) do nothing`,
  )
    .bind(id, caja, correo, importe, motivo, new Date().toISOString())
    .run();
  const retiro = await env.DB.prepare('select id, caja, cajero, importe, motivo, creado_en from retiros where id = ?')
    .bind(id)
    .first();
  return json(retiro, 201);
}

export interface Corte {
  id: string; caja: string; cajero: string; desde: string | null; hasta: string; tickets: number;
  fondo_inicial: number; efectivo_ventas: number; efectivo_devoluciones: number; retiros: number;
  efectivo_esperado: number; efectivo_contado: number; diferencia: number;
  tarjeta_sistema: number; tarjeta_terminal: number; transferencias: number; dolarones: number;
  fondo_siguiente: number; entregado: number; conteo: string; notas: string; creado_en: string;
}

const leerCorte = (env: Env, id: string) =>
  env.DB.prepare('select * from cortes where id = ?').bind(id).first<Corte>();

// Lo cobrado (o devuelto) de una forma de pago, sin la parte pagada con Dolarones.
const dinero = (forma: string) => `coalesce(sum(case when forma_pago = '${forma}' then total - dolarones end), 0)`;

export async function registrarCorte(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  const caja = nombreCaja(cuerpo.caja);
  const conteo = (cuerpo.conteo ?? {}) as Record<string, number>;
  const contado = contadoDe(conteo);
  const terminal = Number(cuerpo.tarjeta_terminal ?? 0);
  const notas = texto(cuerpo.notas, 500);
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!caja) return json({ error: 'Falta la caja.' }, 400);
  if (contado === null) return json({ error: 'Conteo invalido.' }, 400);
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
      env.DB.prepare(
        `insert into cortes (id, caja, cajero, desde, hasta, tickets, fondo_inicial, efectivo_ventas,
           efectivo_devoluciones, retiros, efectivo_esperado, efectivo_contado, diferencia, tarjeta_sistema,
           tarjeta_terminal, transferencias, dolarones, fondo_siguiente, entregado, conteo, notas, creado_en)
         select ?1, ?2, ?3, desde, ?4, tickets, fondo, ev, ed, re,
                fondo + ev - ed - re, ?5, ?5 - (fondo + ev - ed - re), tv - td,
                ?6, xv - xd, dv - dd, min(?5, ?7), ?5 - min(?5, ?7), ?8, ?9, ?4
         from (select
           (select max(hasta) from cortes where caja = ?2) as desde,
           coalesce((select fondo_siguiente from cortes where caja = ?2 order by hasta desc limit 1), ?7) as fondo,
           (select count(*) from ventas where corte_id = ?1) as tickets,
           (select ${dinero('efectivo')} from ventas where corte_id = ?1) as ev,
           (select ${dinero('efectivo')} from ventas where corte_cancelacion_id = ?1) as ed,
           (select coalesce(sum(importe), 0) from retiros where corte_id = ?1) as re,
           (select ${dinero('tarjeta')} from ventas where corte_id = ?1) as tv,
           (select ${dinero('tarjeta')} from ventas where corte_cancelacion_id = ?1) as td,
           (select ${dinero('transferencia')} from ventas where corte_id = ?1) as xv,
           (select ${dinero('transferencia')} from ventas where corte_cancelacion_id = ?1) as xd,
           (select coalesce(sum(dolarones), 0) from ventas where corte_id = ?1) as dv,
           (select coalesce(sum(dolarones), 0) from ventas where corte_cancelacion_id = ?1) as dd)`,
      ).bind(id, caja, correo, ahora, contado, terminal, fondoConfig, JSON.stringify(conteo), notas),
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
export async function ultimoCorte(url: URL, env: Env): Promise<Response> {
  const caja = nombreCaja(url.searchParams.get('caja'));
  if (!caja) return json({ error: 'Falta la caja.' }, 400);
  const corte = await env.DB.prepare('select * from cortes where caja = ? order by hasta desc limit 1')
    .bind(caja)
    .first<Corte>();
  return corte ? json(corte) : json({ error: 'Esta caja todavia no tiene cortes.' }, 404);
}
