/**
 * Conteo nocturno de piezas de alto valor (Issue #219, tras un robo). La lista
 * sale de D1: productos con stock y precio >= CONTEO_UMBRAL. El conteo no se
 * guarda; solo los faltantes que se ajustan, y cada ajuste deja rastro: quien,
 * cuando, antes, despues y motivo (tabla conteo_ajustes, migracion-028).
 * Permisos en cuentas.ts: contar lo puede cualquier cuenta de piso; ajustar y
 * ver el rastro, solo el dueno.
 */

import { ajusteGuardado, escribirExistencia } from './piezas.ts';

/** $300 en centavos, si la configuracion no trae CONTEO_UMBRAL. */
const UMBRAL_POR_OMISION = 30000;
export const MOTIVOS = ['robo', 'merma', 'error de captura'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIA_MS = 86_400_000;

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export function umbralConteo(env: Env): number {
  const umbral = Number(env.CONTEO_UMBRAL);
  return Number.isInteger(umbral) && umbral > 0 ? umbral : UMBRAL_POR_OMISION;
}

/** Las piezas que se cuentan cada noche: en existencia y de precio alto. FEP es otro inquilino: cada cuenta ve solo las suyas (#480). */
export async function listarAltoValor(env: Env, propietario: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select id, codigo, nombre, precio, stock from productos
     where sin_inventario = 0 and stock >= 1 and precio >= ? and propietario = ? order by precio desc, codigo`,
  )
    .bind(umbralConteo(env), propietario)
    .all();
  return json(results);
}

/** Compara lo contado con lo que dice el sistema. No cambia nada: solo devuelve los faltantes. */
export async function revisarConteo(request: Request, env: Env, propietario: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as { conteos?: unknown };
  if (!Array.isArray(cuerpo.conteos) || cuerpo.conteos.length > 200) return json({ error: 'Falta el conteo.' }, 400);

  const faltantes = [];
  for (const linea of cuerpo.conteos as { producto_id?: unknown; contado?: unknown }[]) {
    const id = String(linea?.producto_id ?? '');
    const contado = Number(linea?.contado);
    if (!UUID.test(id) || !Number.isInteger(contado) || contado < 0 || contado > 9999) {
      return json({ error: 'Conteo invalido.' }, 400);
    }
    // Lo que no esta en la lista de alto valor no se cuenta aqui.
    const pieza = await env.DB.prepare(
      `select codigo, nombre, stock from productos where id = ? and sin_inventario = 0 and precio >= ? and propietario = ?`,
    )
      .bind(id, umbralConteo(env), propietario)
      .first<{ codigo: string; nombre: string; stock: number }>();
    if (pieza && pieza.stock > contado) {
      faltantes.push({
        producto_id: id, codigo: pieza.codigo, nombre: pieza.nombre,
        sistema: pieza.stock, contado, faltan: pieza.stock - contado,
      });
    }
  }
  return json({ faltantes });
}

/**
 * Baja las existencias por un faltante y lo anota, por escribirExistencia (#480): el folio lo manda el cliente (`id`), así que
 * reintentar no descuenta dos veces; `esperado` es la existencia que vio quien cuenta, y solo se escribe si sigue igual.
 */
export async function ajustarExistencia(request: Request, env: Env, correo: string, ctx: ExecutionContext, propietario: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.producto_id ?? '');
  const folio = String(cuerpo.id ?? '');
  const cantidad = Number(cuerpo.cantidad);
  const esperado = cuerpo.esperado;
  const motivo = String(cuerpo.motivo ?? '');
  if (!UUID.test(id) || !UUID.test(folio)) return json({ error: 'Identificador invalido.' }, 400);
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 999) return json({ error: 'Cantidad invalida.' }, 400);
  if (typeof esperado !== 'number' || !Number.isInteger(esperado) || esperado < 0 || esperado > 999) return json({ error: 'Falta la existencia que viste (esperado).' }, 400);
  if (!(MOTIVOS as readonly string[]).includes(motivo)) {
    return json({ error: 'Escoge un motivo: robo, merma o error de captura.' }, 400);
  }

  // Un reintento con el mismo folio devuelve lo ya aplicado; el mismo folio con otra cosa es de otro ajuste.
  const responder = (a: NonNullable<Awaited<ReturnType<typeof ajusteGuardado>>>, status: number) =>
    a.producto_id === id && a.ajustado_por === correo && a.motivo === motivo && a.cantidad === cantidad && a.antes === esperado
      ? json({ producto_id: id, antes: a.antes, despues: a.despues }, status)
      : json({ error: 'El folio ya pertenece a otro ajuste.' }, 409);
  const previo = await ajusteGuardado(env, folio);
  if (previo) return responder(previo, 200);

  const pieza = await env.DB.prepare('select stock, sin_inventario from productos where id = ? and propietario = ?')
    .bind(id, propietario)
    .first<{ stock: number; sin_inventario: number }>();
  if (!pieza) return json({ error: 'La pieza no existe.' }, 404);
  if (pieza.sin_inventario) return json({ error: 'Esa pieza no lleva inventario.' }, 400);
  if (pieza.stock < cantidad) return json({ error: 'No hay tantas piezas en existencia.', stock: pieza.stock }, 409);

  const ajuste = await escribirExistencia(env, ctx, { id, propietario, folio, delta: -cantidad, motivo, correo, esperado });
  if (ajuste) return responder(ajuste, 201);
  // Otro intento con el mismo folio pudo ganar entre la lectura y la escritura.
  const ganador = await ajusteGuardado(env, folio);
  if (ganador) return responder(ganador, 200);
  const actual = await env.DB.prepare('select stock from productos where id = ? and propietario = ?').bind(id, propietario).first<{ stock: number }>();
  return json({ error: 'La existencia cambió desde que la viste. Revisa el conteo y vuelve a intentar.', stock: actual?.stock }, 409);
}

/** El rastro de los ultimos 30 dias, para el dueno. */
export async function listarAjustes(env: Env, propietario: string): Promise<Response> {
  const desde = new Date(Date.now() - 30 * DIA_MS).toISOString();
  const { results } = await env.DB.prepare(
    `select producto_id, codigo, nombre, motivo, cantidad, antes, despues, ajustado_por, ajustado_en
     from conteo_ajustes where ajustado_en >= ?
       and not exists (select 1 from productos p where p.id = conteo_ajustes.producto_id and p.propietario <> ?)
     order by ajustado_en desc`,
  )
    .bind(desde, propietario)
    .all();
  return json(results);
}
