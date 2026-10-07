/**
 * Conteo nocturno de piezas de alto valor (Issue #219, tras un robo). La lista
 * sale de D1: productos con stock y precio >= CONTEO_UMBRAL. El conteo no se
 * guarda; solo los faltantes que se ajustan, y cada ajuste deja rastro: quien,
 * cuando, antes, despues y motivo (tabla conteo_ajustes, migracion-028).
 * Permisos en cuentas.ts: contar lo puede cualquier cuenta de piso; ajustar y
 * ver el rastro, solo el dueno.
 */

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

/** Las piezas que se cuentan cada noche: en existencia y de precio alto. */
export async function listarAltoValor(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select id, codigo, nombre, precio, stock from productos
     where sin_inventario = 0 and stock >= 1 and precio >= ? order by precio desc, codigo`,
  )
    .bind(umbralConteo(env))
    .all();
  return json(results);
}

/** Compara lo contado con lo que dice el sistema. No cambia nada: solo devuelve los faltantes. */
export async function revisarConteo(request: Request, env: Env): Promise<Response> {
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
      `select codigo, nombre, stock from productos where id = ? and sin_inventario = 0 and precio >= ?`,
    )
      .bind(id, umbralConteo(env))
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
 * Baja las existencias por un faltante y lo anota. El audit y el UPDATE van en un
 * solo batch: si el stock no alcanza, el trigger stock_no_negativo (migracion-006)
 * aborta todo y no queda rastro de un ajuste que no ocurrio.
 */
export async function ajustarExistencia(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.producto_id ?? '');
  const cantidad = Number(cuerpo.cantidad);
  const motivo = String(cuerpo.motivo ?? '');
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 9999) return json({ error: 'Cantidad invalida.' }, 400);
  if (!(MOTIVOS as readonly string[]).includes(motivo)) {
    return json({ error: 'Escoge un motivo: robo, merma o error de captura.' }, 400);
  }

  const pieza = await env.DB.prepare('select stock, sin_inventario from productos where id = ?')
    .bind(id)
    .first<{ stock: number; sin_inventario: number }>();
  if (!pieza) return json({ error: 'La pieza no existe.' }, 404);
  if (pieza.sin_inventario) return json({ error: 'Esa pieza no lleva inventario.' }, 400);
  if (pieza.stock < cantidad) return json({ error: 'No hay tantas piezas en existencia.' }, 409);

  const ahora = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `insert into conteo_ajustes (id, producto_id, codigo, nombre, motivo, cantidad, antes, despues, ajustado_por, ajustado_en)
         select ?, id, codigo, nombre, ?, ?, stock, stock - ?, ?, ? from productos where id = ?`,
      ).bind(crypto.randomUUID(), motivo, cantidad, cantidad, correo, ahora, id),
      env.DB.prepare('update productos set stock = stock - ?, actualizado_en = ? where id = ?').bind(cantidad, ahora, id),
    ]);
  } catch (error) {
    if (String(error).includes('stock insuficiente')) return json({ error: 'No hay tantas piezas en existencia.' }, 409);
    throw error;
  }
  return json({ producto_id: id, antes: pieza.stock, despues: pieza.stock - cantidad }, 201);
}

/** El rastro de los ultimos 30 dias, para el dueno. */
export async function listarAjustes(env: Env): Promise<Response> {
  const desde = new Date(Date.now() - 30 * DIA_MS).toISOString();
  const { results } = await env.DB.prepare(
    `select producto_id, codigo, nombre, motivo, cantidad, antes, despues, ajustado_por, ajustado_en
     from conteo_ajustes where ajustado_en >= ? order by ajustado_en desc`,
  )
    .bind(desde)
    .all();
  return json(results);
}
