import { propietarioDe, type Usuario } from './cuentas.ts';

const CAMPOS = `rowid as fila, id, codigo, nombre, marca, talla, categoria, precio, precio_lista,
  stock, destino, estado_fisico, estado_analisis, upc, foto_key <> '' as tiene_foto,
  semana_ingreso, creado_en, actualizado_en, propietario, sin_inventario`;
const VISIBLE = `sin_inventario = 0 and estado_analisis <> 'descartado'`;
export const SQL_CODIGO = `select ${CAMPOS} from productos where codigo = ? and propietario = ? and ${VISIBLE}`;
// Separar el empate evita releer todas las filas con la misma fecha al avanzar el cursor.
export const SQL_TEXTO = `select ${CAMPOS} from productos indexed by productos_propietario_creado
  where propietario = ? and creado_en < ? order by creado_en desc, rowid desc limit ?`;
export const SQL_EMPATE = `select ${CAMPOS} from productos indexed by productos_propietario_creado
  where propietario = ? and creado_en = ? and rowid < ? order by creado_en desc, rowid desc limit ?`;
export const SQL_UPC = `select ${CAMPOS} from productos indexed by productos_upc
  where upc = ? and rowid > ? order by rowid limit ?`;

interface Pieza {
  fila: number; id: string; codigo: string | null; nombre: string; marca: string; talla: string | null;
  categoria: string; precio: number; precio_lista: number; stock: number; destino: string;
  estado_fisico: string; estado_analisis: string; upc: string | null; tiene_foto: number;
  semana_ingreso: string; creado_en: string; actualizado_en: string; propietario: string; sin_inventario: number;
}
const json = (cuerpo: unknown, status = 200) => Response.json(cuerpo, { status });
const publica = ({ fila: _f, propietario: _p, sin_inventario: _s, ...p }: Pieza) => p;
const visible = (p: Pieza, propietario: string) => p.propietario === propietario && !p.sin_inventario && p.estado_analisis !== 'descartado';
const cursorDe = (p: Pieza, upc: boolean) => `${upc ? p.upc : p.creado_en}~${p.fila}`;

export async function buscarPiezas(url: URL, env: Env, usuario: Usuario): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q || q.length > 80) return json({ error: 'Escribe un código o un nombre de 3 a 80 caracteres.' }, 400);
  const propietario = propietarioDe(usuario);
  const codigo = /^(?:ed-?)?(\d{1,6})$/i.exec(q);
  if (codigo) {
    const p = await env.DB.prepare(SQL_CODIGO).bind(`ED-${codigo[1].padStart(6, '0')}`, propietario).first<Pieza>();
    if (p || !/^\d{6}$/.test(q)) return json({ piezas: p ? [publica(p)] : [], siguiente: null });
  }
  const upc = /^\d{6,14}$/.test(q);
  if (!upc && q.length < 3) return json({ error: 'Escribe al menos 3 caracteres.' }, 400);
  const crudo = url.searchParams.get('cursor');
  const cursor = crudo?.match(/^(.*)~([1-9]\d*)$/);
  if (crudo && (!cursor || !Number.isSafeInteger(Number(cursor[2])) || cursor[1].length > 40)) {
    return json({ error: 'Cursor inválido.' }, 400);
  }
  const piezas: ReturnType<typeof publica>[] = [];
  let siguiente: string | null = null;
  let leidas = 0;
  if (upc) {
    // El índice 045 es parcial (solo fotos de Dolarón). Las variantes usan el 044
    // también para FEP y piezas sin foto, sin cambiar ni migrar los UPC guardados.
    const base = q.replace(/^0+/, '') || '0';
    const variantes = Array.from({ length: 15 - base.length }, (_, i) => base.padStart(base.length + i, '0')).sort();
    if (cursor && !variantes.includes(cursor[1])) return json({ error: 'Cursor inválido.' }, 400);
    for (const variante of variantes) {
      if (cursor && variante < cursor[1]) continue;
      let fila = cursor && variante === cursor[1] ? Number(cursor[2]) : 0;
      while (leidas < 1000) {
        const { results } = await env.DB.prepare(SQL_UPC).bind(variante, fila, Math.min(200, 1000 - leidas)).all<Pieza>();
        leidas += results.length;
        for (const p of results) {
          siguiente = cursorDe(p, true);
          if (visible(p, propietario)) piezas.push(publica(p));
          if (piezas.length === 25) return json({ piezas, siguiente });
        }
        if (results.length < 200) break;
        fila = results.at(-1)!.fila;
      }
      if (leidas >= 1000) return json({ piezas, siguiente });
    }
    return json({ piezas, siguiente: null });
  }
  let fecha = cursor?.[1] ?? '9999';
  let fila = cursor ? Number(cursor[2]) : 0;
  // shortcut: SQLite lower() no pliega acentos; normalizar en una columna si hace falta.
  const minusculas = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const palabras = minusculas(q).split(/\s+/);
  while (leidas < 1000) {
    const limite = Math.min(200, 1000 - leidas);
    const sentencia = fila
      ? env.DB.prepare(SQL_EMPATE).bind(propietario, fecha, fila, limite)
      : env.DB.prepare(SQL_TEXTO).bind(propietario, fecha, limite);
    const { results } = await sentencia.all<Pieza>();
    leidas += results.length;
    for (const p of results) {
      siguiente = cursorDe(p, false);
      if (visible(p, propietario) && palabras.every((palabra) => minusculas(`${p.nombre} ${p.marca}`).includes(palabra))) piezas.push(publica(p));
      if (piezas.length === 25) return json({ piezas, siguiente });
    }
    if (!results.length || results.length < limite) {
      if (fila) { fila = 0; continue; }
      return json({ piezas, siguiente: null });
    }
    fecha = results.at(-1)!.creado_en;
    fila = results.at(-1)!.fila;
  }
  return json({ piezas, siguiente });
}

export async function leerPieza(id: string, env: Env, usuario: Usuario): Promise<Response> {
  const pieza = await env.DB.prepare(`select ${CAMPOS} from productos where id = ? and propietario = ? and ${VISIBLE}`)
    .bind(id, propietarioDe(usuario)).first<Pieza>();
  if (!pieza) return json({ error: 'Pieza no encontrada.' }, 404);
  const { results: ajustes } = await env.DB.prepare(`select id, motivo, cantidad, antes, despues, ajustado_por, ajustado_en
    from conteo_ajustes where producto_id = ? order by ajustado_en desc, rowid desc limit 10`).bind(id).all();
  return json({ pieza: publica(pieza), ajustes });
}
