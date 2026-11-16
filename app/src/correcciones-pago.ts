/**
 * Corregir la forma de pago de un ticket antes del corte (Issue #831, tabla de la migración 080).
 * Una venta cobrada como efectivo que era tarjeta (o al revés) descuadra el corte: aquí el cajero la corrige con motivo.
 * Solo mientras el ticket no entró a un corte, no está cancelado y no tiene devoluciones; entre efectivo, tarjeta y transferencia
 * (a transferencia solo por menos de CLAVE_DESDE: desde ahí hace falta clave de rastreo, y esa se cobra de nuevo).
 *
 * Atomicidad: las condiciones van DENTRO de las sentencias que escriben (no en la lectura de antes). Un batch de D1 es una
 * transacción y ninguna otra escritura se cuela en medio, así que la fila de rastro y el cambio de la venta usan la misma
 * condición sobre el mismo estado: o entran las dos o ninguna (`meta.changes` lo dice). El cambio de `ventas` además exige que
 * el rastro exista, y sube `revision` (migración 020): una devolución o cancelación que ya leyó el ticket con la forma anterior
 * (y la copia a `devoluciones.forma_pago`) aborta con «ticket cambio» en vez de restar del corte una forma equivocada.
 */
import { CLAVE_DESDE } from '../public/venta.js';
import { cajaDe, nombreCaja } from './corte.ts';
import { TIENDA_CENTRAL } from './cuentas.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAS = ['efectivo', 'tarjeta', 'transferencia'];
const pesos = (centavos: number) => `$${(centavos / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export interface VentaCorregible {
  id: string; total: number; dolarones: number; anticipo: number; forma_pago: string; cancelada: number; revision: number;
  imprimir_en: string | null; corte_id: string | null; tienda: string; devuelta: number; con_clave: number;
}

/** Lo que de verdad se pagó en dinero en este ticket: sin Dolarones/vale y sin el saldo de un pedido (entró antes, con el anticipo). */
const enDinero = (v: Pick<VentaCorregible, 'total' | 'dolarones' | 'anticipo'>) => v.total - v.dolarones - v.anticipo;

/** El estado del ticket más la forma que se quiere: el mensaje de por qué no, o null si se puede. Pura, para probarla y para el detalle del ticket. */
export function motivoDeRechazo(v: VentaCorregible, nueva: string): string | null {
  if (v.cancelada) return 'Este ticket está cancelado: no hay forma de pago que corregir.';
  if (v.corte_id) return 'Este ticket ya entró a un corte de caja: su forma de pago ya no se puede corregir aquí. Avísale al dueño.';
  if (v.devuelta) return 'Este ticket tiene piezas devueltas: su forma de pago ya no se puede corregir.';
  if (enDinero(v) <= 0) return 'Este ticket se pagó completo con Dolarones o con el saldo de un pedido: no tiene forma de pago que corregir.';
  if (v.con_clave) return 'Esta transferencia tiene clave de rastreo registrada: no se corrige aquí. Cancela la venta y vuelve a cobrarla.';
  if (nueva === v.forma_pago) return 'Este ticket ya está cobrado con esa forma de pago.';
  if (nueva === 'transferencia' && enDinero(v) >= CLAVE_DESDE)
    return `Desde ${pesos(CLAVE_DESDE)} la transferencia necesita clave de rastreo: cancela la venta y vuelve a cobrarla por transferencia.`;
  if (nueva === 'efectivo' && v.imprimir_en) return 'Esta venta se cobró en el celular: solo puede ser tarjeta o transferencia.';
  return null;
}

/** A qué formas se puede corregir este ticket (vacío: ninguna); la caja solo pinta el botón si hay alguna. */
export const formasCorregibles = (v: VentaCorregible) => FORMAS.filter((f) => !motivoDeRechazo(v, f));

const leerVenta = (env: Env, id: string) => env.DB.prepare(
  `select id, total, dolarones, anticipo, forma_pago, cancelada, revision, imprimir_en, corte_id, tienda,
          exists (select 1 from devoluciones where venta_id = ventas.id) as devuelta,
          exists (select 1 from transferencias_spei where venta_id = ventas.id) as con_clave
   from ventas where id = ?`,
).bind(id).first<VentaCorregible>();

/** Para el detalle del ticket: a qué formas se puede corregir y las correcciones ya hechas. `tienda`: la de la sesión (un ticket de otra tienda no se corrige). */
export async function datosCorreccion(env: Env, id: string, tienda?: string) {
  const venta = await leerVenta(env, id);
  const { results: correcciones } = await env.DB.prepare(
    `select forma_anterior, forma_nueva, motivo, autor, caja, creado_en from correcciones_pago where venta_id = ? order by creado_en, rowid`,
  ).bind(id).all();
  return { corregible: venta && (tienda === undefined || venta.tienda === tienda) ? formasCorregibles(venta) : [], correcciones };
}

// Mismas condiciones para el rastro y para el cambio. `revision` es la que se leyó: toda escritura del ticket (otra corrección, una
// devolución, una cancelación) la sube, así que si algo se movió ninguna de las dos escribe. Las otras tres son por si alguna ruta no la subiera.
const CONDICION = `cancelada = 0 and corte_id is null and revision = ?
  and not exists (select 1 from devoluciones where venta_id = ventas.id)
  and not exists (select 1 from transferencias_spei where venta_id = ventas.id)`;

/** POST /api/ventas/:id/corregir-pago { id, forma_pago, motivo, caja } — del cajero con PIN o el dueño (permiso() de /api/ventas/...). */
export async function corregirFormaPago(ventaId: string, request: Request, env: Env, correo: string, tienda: string): Promise<Response> {
  if (!UUID.test(ventaId)) return json({ error: 'Identificador de venta invalido.' }, 400);
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  const nueva = String(cuerpo.forma_pago ?? '');
  const motivo = String(cuerpo.motivo ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!FORMAS.includes(nueva)) return json({ error: 'Forma de pago invalida.' }, 400);
  if (!motivo) return json({ error: 'Escribe el motivo de la corrección.' }, 400);

  // Un reintento (red caída, doble toque) devuelve lo que ya quedó; se resuelve antes de revisar el ticket, que ya cambió.
  const repetida = async () => {
    const previa = await env.DB.prepare('select id, venta_id, forma_anterior, forma_nueva, importe from correcciones_pago where id = ?').bind(id)
      .first<{ id: string; venta_id: string; forma_anterior: string; forma_nueva: string; importe: number }>();
    if (!previa) return null;
    if (previa.venta_id !== ventaId) return json({ error: 'Ese identificador ya se usó en otra corrección.' }, 409);
    return json({ id, venta_id: ventaId, forma_anterior: previa.forma_anterior, forma_pago: previa.forma_nueva, importe: previa.importe, duplicada: true });
  };
  const ya = await repetida();
  if (ya) return ya;

  // La caja se valida como en el resto de la caja (una ajena es 400); una sucursal debe decir cuál es.
  const caja = await cajaDe(env, correo, cuerpo.caja, tienda);
  if (!caja && tienda !== TIENDA_CENTRAL && !nombreCaja(cuerpo.caja)) return json({ error: 'Elige arriba qué caja es esta computadora.' }, 400);

  const revisar = async () => {
    const venta = await leerVenta(env, ventaId);
    if (!venta) return { respuesta: json({ error: 'La venta no existe.' }, 404) };
    if (venta.tienda !== tienda) return { respuesta: json({ error: 'Ese ticket es de otra tienda: corrígelo desde su tienda.' }, 403) };
    const rechazo = motivoDeRechazo(venta, nueva);
    return rechazo ? { respuesta: json({ error: rechazo }, 409) } : { venta };
  };
  const antes = await revisar();
  if (!antes.venta) return antes.respuesta;
  const venta = antes.venta;

  const [rastro, cambio] = await env.DB.batch([
    env.DB.prepare(
      `insert into correcciones_pago (id, venta_id, forma_anterior, forma_nueva, importe, efectivo_anterior, cambio_anterior, motivo, autor, caja, tienda, creado_en)
       select ?, id, forma_pago, ?, total - dolarones - anticipo, efectivo, cambio, ?, ?, ?, ?, ? from ventas where id = ? and ${CONDICION}`,
    ).bind(id, nueva, motivo, correo, caja, tienda, new Date().toISOString(), ventaId, venta.revision),
    // A efectivo queda exactamente lo pagado en dinero y sin cambio; a tarjeta o transferencia, sin efectivo ni cambio.
    env.DB.prepare(
      `update ventas set forma_pago = ?, efectivo = case when ? = 'efectivo' then total - dolarones - anticipo else 0 end, cambio = 0, revision = revision + 1
       where id = ? and ${CONDICION} and exists (select 1 from correcciones_pago where id = ? and venta_id = ventas.id)`,
    ).bind(nueva, nueva, ventaId, venta.revision, id),
  ]);

  if (cambio.meta.changes && rastro.meta.changes) {
    return json({ id, venta_id: ventaId, forma_anterior: venta.forma_pago, forma_pago: nueva, importe: enDinero(venta) }, 201);
  }
  // No escribió nada: otra corrección, un corte, una devolución o una cancelación se adelantaron entre la lectura y el batch.
  const concurrente = await repetida();
  if (concurrente) return concurrente;
  const ahora = await revisar();
  if (!ahora.venta) return ahora.respuesta;
  return json({ error: 'Alguien más cambió este ticket. Vuelve a abrirlo.' }, 409);
}
