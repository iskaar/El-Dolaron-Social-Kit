/**
 * Clave de rastreo SPEI de cada transferencia (#593, paso 1). El cajero la copia del comprobante del cliente y
 * queda «confirmado por cajero». El indice unico de transferencias_spei (migracion 060) es quien impide usarla
 * dos veces: aqui solo se arma el insert y se explica el choque. Una venta o un pago cancelado NO libera la clave.
 */
import { transferenciaDe } from '../public/venta.js';

export type Transferencia = Extract<ReturnType<typeof transferenciaDe>, { ok: true }>;

/** Valida lo capturado (cuerpo.clave_rastreo, cuerpo.monto_transferido en centavos) contra lo que se cobra por transferencia. */
export function leerTransferencia(cuerpo: { clave_rastreo?: unknown; monto_transferido?: unknown }, debido: number) {
  return transferenciaDe({ clave: cuerpo.clave_rastreo, transferido: Number(cuerpo.monto_transferido), debido });
}

/** El insert va DESPUES de la fila que respalda (venta, pedido o movimiento): sus llaves foraneas lo exigen. */
export const sentenciaTransferencia = (env: Env, t: Transferencia, quien: string, ahora: string,
  origen: 'venta' | 'anticipo' | 'abono', ids: { venta?: string; pedido?: string; movimiento?: string }) => env.DB.prepare(
  `insert into transferencias_spei (clave_rastreo, monto, aplicado, origen, venta_id, pedido_id, movimiento_id, registrado_por, registrado_en)
   values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(t.clave, t.transferido, t.aplicado, origen, ids.venta ?? null, ids.pedido ?? null, ids.movimiento ?? null, quien, ahora);

/** Donde se uso ya la clave, para decirselo al cajero; null si esta libre. */
export async function dondeSeUso(env: Env, clave: string): Promise<string | null> {
  const f = await env.DB.prepare(
    `select t.venta_id, (select folio from pedidos where id = t.pedido_id) as folio from transferencias_spei t where t.clave_rastreo = ?`,
  ).bind(clave).first<{ venta_id: string | null; folio: number | null }>();
  if (!f) return null;
  return f.folio != null ? `el pedido P-${f.folio}` : `el ticket ${String(f.venta_id).slice(0, 8).toUpperCase()}`;
}

/** 409 con campo «clave» si ya se uso; null si esta libre. */
export async function respuestaClaveUsada(env: Env, clave: string): Promise<Response | null> {
  const donde = await dondeSeUso(env, clave);
  return donde === null ? null : new Response(JSON.stringify({
    error: `Esa clave de rastreo ya se usó en ${donde}. Cada transferencia respalda un solo pago: pídele al cliente su comprobante de esta transferencia.`,
    campo: 'clave',
  }), { status: 409, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** El batch fallo por el indice unico: otra solicitud se quedo con la clave entre la lectura y el insert. */
export const esChoqueDeClave = (error: unknown) => String(error).includes('transferencias_spei.clave_rastreo');

/** Lo que sobro de esa transferencia (centavos), para repetirlo igual en un reintento. */
export async function excedenteDe(env: Env, origen: 'venta' | 'anticipo', id: string): Promise<number> {
  const columna = origen === 'venta' ? 'venta_id' : 'pedido_id';
  const f = await env.DB.prepare(`select monto - aplicado as x from transferencias_spei where origen = ? and ${columna} = ?`)
    .bind(origen, id).first<{ x: number }>();
  return f?.x ?? 0;
}
