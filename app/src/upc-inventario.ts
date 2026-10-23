import { normalizarUpc } from '../public/upc.js';

// Coincide con el índice parcial 053: también cubre pendientes, FEP y piezas sin foto.
export const UPC_VISIBLE = "sin_inventario = 0 and estado_analisis <> 'descartado' and upc is not null and upc <> ''";
export const MISMO_UPC = `${UPC_VISIBLE} and propietario = ? and ltrim(upc, '0') = ? and estado_fisico = ?`;
export interface PiezaUpc {
  id: string; codigo: string | null; upc: string | null; nombre: string; precio: number; stock: number;
  estado_analisis: string; estado_fisico: string; propietario: string; capturado_por: string;
  creado_en: string; actualizado_en: string; tiene_foto: number; marca:string; talla:string | null;
  categoria:string; precio_lista:number; destino:string;
}
export const PIEZA_UPC = `id, codigo, upc, nombre, precio, stock, estado_analisis, estado_fisico, propietario,
  capturado_por, creado_en, actualizado_en, marca, talla, categoria, precio_lista, destino, foto_key <> '' as tiene_foto`;

export async function repetidaUpc(env: Env, upc: string, grado: string, propietario: string, excluir = '') {
  return env.DB.prepare(`select ${PIEZA_UPC} from productos where id = coalesce(
    (select id from productos where ${MISMO_UPC} and id <> ? and coalesce(codigo, '') > ''
      order by coalesce(codigo, ''), rowid limit 1),
    (select id from productos where ${MISMO_UPC} and id <> ? order by coalesce(codigo, ''), rowid limit 1))`)
    .bind(propietario, normalizarUpc(upc), grado, excluir, propietario, normalizarUpc(upc), grado, excluir).first<PiezaUpc>();
}

export const upcValido = (valor: unknown): valor is string => typeof valor === 'string'
  && (valor.trim() === '' || !!normalizarUpc(valor));

export async function conflictoUpc(env: Env, upc: string, grado: string, propietario: string, excluir: string) {
  const pieza = upc ? await repetidaUpc(env, upc, grado, propietario, excluir) : null;
  return pieza ? new Response(JSON.stringify({ error:'Ese UPC ya existe con este grado.', existente:{
    id:pieza.id, codigo:pieza.codigo, nombre:pieza.nombre, stock:pieza.stock, tiene_etiqueta:!!pieza.codigo,
    estado_fisico:pieza.estado_fisico, upc:pieza.upc,
  } }), { status:409, headers:{'content-type':'application/json; charset=utf-8'} }) : null;
}

/** UPC solo: no recalcula precio, no cierra un análisis ni transporta existencia. */
export async function corregirUpc(env: Env, id: string, valor: unknown, propietario: string): Promise<Response> {
  const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
    status, headers:{'content-type':'application/json; charset=utf-8'},
  });
  if (!upcValido(valor)) return json({ error:'Código de barras inválido.' }, 400);
  const pieza = await env.DB.prepare(`select ${PIEZA_UPC} from productos where id = ? and propietario = ?
    and sin_inventario = 0 and estado_analisis <> 'descartado'`).bind(id, propietario).first<PiezaUpc>();
  if (!pieza) return json({ error:'Pieza no encontrada.' }, 404);
  const upc = valor.trim();
  const conflicto = await conflictoUpc(env, upc, pieza.estado_fisico, propietario, id);
  if (conflicto) return conflicto;
  const { meta } = await env.DB.prepare(`update productos set upc = ?, actualizado_en = ? where id = ?
    and propietario = ? and sin_inventario = 0 and estado_analisis <> 'descartado' and estado_fisico = ?
    and (? = '' or not exists (select 1 from productos where ${MISMO_UPC} and id <> ?))`)
    .bind(upc, new Date().toISOString(), id, propietario, pieza.estado_fisico,
      upc, propietario, normalizarUpc(upc), pieza.estado_fisico, id).run();
  return meta.changes ? json({ id, upc }) : await conflictoUpc(env, upc, pieza.estado_fisico, propietario, id)
    ?? json({ error:'La pieza cambió. Revisa y vuelve a intentar.' }, 409);
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
