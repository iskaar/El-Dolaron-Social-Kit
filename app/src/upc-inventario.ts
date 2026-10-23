import { normalizarUpc } from '../public/upc.js';

// Coincide con el índice parcial 053: también cubre pendientes, FEP y piezas sin foto.
export const UPC_VISIBLE = "sin_inventario = 0 and estado_analisis <> 'descartado' and upc is not null and upc <> ''";
export const MISMO_UPC = `${UPC_VISIBLE} and propietario = ? and ltrim(upc, '0') = ? and estado_fisico = ?`;
export interface PiezaUpc {
  id: string; codigo: string | null; upc: string | null; nombre: string; precio: number; stock: number;
  estado_analisis: string; estado_fisico: string; propietario: string; capturado_por: string;
  creado_en: string; tiene_foto: number;
}
export const PIEZA_UPC = `id, codigo, upc, nombre, precio, stock, estado_analisis, estado_fisico, propietario,
  capturado_por, creado_en, foto_key <> '' as tiene_foto`;

export async function repetidaUpc(env: Env, upc: string, grado: string, propietario: string, excluir = '') {
  return env.DB.prepare(`select ${PIEZA_UPC} from productos where ${MISMO_UPC} and id <> ?
    order by (coalesce(codigo, '') <> '') desc, rowid limit 1`)
    .bind(propietario, normalizarUpc(upc), grado, excluir).first<PiezaUpc>();
}

export async function capturaSumada(env: Env, id: string, correo: string) {
  return env.DB.prepare(`select ${PIEZA_UPC}, (select cantidad from conteo_ajustes where id = ?) as sumadas
    from productos where id = (select producto_id from conteo_ajustes where id = ? and motivo = 'entrada'
      and ajustado_por = ?)`).bind(id, id, correo).first<PiezaUpc & { sumadas: number }>();
}

/** Misma guarda y changes() de cambiarExistencia: cero filas nunca deja rastro ni repone stock. */
export async function sumarCaptura(env: Env, id: string, upc: string, grado: string, cantidad: number, correo: string, propietario = 'dolaron') {
  const previa = await capturaSumada(env, id, correo);
  if (previa) return previa;
  const pieza = await repetidaUpc(env, upc, grado, propietario, id);
  if (!pieza) return null;
  const ahora = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`update productos set stock = stock + ?, actualizado_en = ? where id = ? and ${MISMO_UPC}
      and stock + ? <= 999 and not exists (select 1 from conteo_ajustes where id = ?)
      and not exists (select 1 from productos where id = ?)`)
      .bind(cantidad, ahora, pieza.id, propietario, normalizarUpc(upc), grado, cantidad, id, id),
    env.DB.prepare(`insert into conteo_ajustes
      (id, producto_id, codigo, nombre, motivo, cantidad, antes, despues, ajustado_por, ajustado_en)
      select ?, id, coalesce(codigo, ''), nombre, 'entrada', ?, stock - ?, stock, ?, ? from productos
      where id = ? and actualizado_en = ? and changes() = 1`)
      .bind(id, cantidad, cantidad, correo, ahora, pieza.id, ahora),
  ]);
  const guardada = await capturaSumada(env, id, correo);
  if (guardada) return guardada;
  throw new Error('La captura cambió o la suma supera 999 piezas. Revisa y vuelve a intentar.');
}
