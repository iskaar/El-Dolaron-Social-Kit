/**
 * Existencia por tienda (Issue #795, reglas R3 de #793).
 *
 * `productos.stock` es lo que hay físicamente en Soledad; lo que está en una sucursal vive en `existencia_tienda`
 * (migración 077); lo que va en un bulto abierto o cerrado no es de ninguna tienda hasta recibirse. D1 es el único maestro:
 * no hay copia derivada. Todo se escribe dentro del batch de quien llama.
 */
import { TIENDA_CENTRAL } from './cuentas.ts';

/**
 * Unidades que `delta` mueve de una pieza en una tienda, como sentencias para el batch de quien llama. Un delta negativo que
 * deje la existencia por debajo de cero ABORTA el batch completo: Soledad por el trigger `stock_no_negativo` (migración 006) y una
 * sucursal por `existencia_tienda_no_negativa` (077). Cero filas modificadas no aborta nada en D1, así que la fila de la sucursal se
 * asegura primero: una pieza que nunca llegó queda en 0 y la resta de una venta la aborta en lugar de pasar sin descontar.
 * `soloContable`: la caja ya excluye bandas y botes; las devoluciones los traen y no regresan existencia.
 */
export function sentenciasMover(
  env: Env, tienda: string, productoId: string, delta: number, ahora: string, soloContable = false,
): D1PreparedStatement[] {
  if (tienda === TIENDA_CENTRAL) {
    return [env.DB.prepare(`update productos set stock = stock + ?, actualizado_en = ? where id = ?${soloContable ? ' and sin_inventario = 0' : ''}`)
      .bind(delta, ahora, productoId)];
  }
  return [
    env.DB.prepare(`insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en)
      select id, ?, 0, ? from productos where id = ?${soloContable ? ' and sin_inventario = 0' : ''}
      on conflict (producto_id, tienda) do nothing`).bind(tienda, ahora, productoId),
    env.DB.prepare('update existencia_tienda set unidades = unidades + ?, actualizado_en = ? where producto_id = ? and tienda = ?')
      .bind(delta, ahora, productoId, tienda),
  ];
}

/** El texto de un aborto por existencia insuficiente, de cualquiera de las dos tiendas. */
export const esExistenciaInsuficiente = (error: unknown) => /stock insuficiente|existencia insuficiente/.test(String(error));

/**
 * Condición SQL: la pieza tiene unidades en una sucursal o en un bulto abierto o cerrado (en camino). `col` es la expresión del id
 * de la pieza. Fusión y descarte la usan para bloquearse (R3): borrar o vaciar una pieza con unidades afuera las perdería.
 */
export const fueraDeSoledad = (col: string) => `(exists (select 1 from existencia_tienda e where e.producto_id = ${col} and e.unidades > 0)
  or exists (select 1 from bulto_lineas bl join bultos bu on bu.id = bl.bulto_id
    where bl.producto_id = ${col} and bl.quitada_en is null and bu.estado in ('abierto', 'cerrado')))`;

export const MENSAJE_FUERA_DE_SOLEDAD = 'Tiene unidades en una sucursal o en camino en un bulto: no se puede fusionar ni descartar.';

/** ¿Tiene la pieza unidades fuera de Soledad? Para dar el mensaje claro antes del batch (la condición del batch es la que protege). */
export async function tieneUnidadesFuera(env: Env, productoId: string): Promise<boolean> {
  const fila = await env.DB.prepare(`select ${fueraDeSoledad('?1')} as fuera`).bind(productoId).first<{ fuera: number }>();
  return fila?.fuera === 1;
}

/** Las unidades de una pieza en una sucursal (0 si nunca llegó). */
export async function unidadesEn(env: Env, tienda: string, productoId: string): Promise<number> {
  if (tienda === TIENDA_CENTRAL) {
    return (await env.DB.prepare('select stock from productos where id = ?').bind(productoId).first<{ stock: number }>())?.stock ?? 0;
  }
  return (await env.DB.prepare('select unidades from existencia_tienda where producto_id = ? and tienda = ?').bind(productoId, tienda)
    .first<{ unidades: number }>())?.unidades ?? 0;
}
