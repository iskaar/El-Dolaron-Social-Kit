/** Consulta de inventario (#441), sin escrituras ni filtro de existencia. */
import { propietarioDe, type Usuario } from './cuentas.ts';

const PAGINA = 25;
const TRAMO = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// Copiados de agent/codex/431-vender; main aún no tiene estos helpers.
interface Cursor { fecha: string; fila: number }
function leerCursor(valor: string | null): Cursor | null {
  if (valor === null) return null;
  const m = /^([^~]{0,40})~([1-9]\d{0,15})$/.exec(valor);
  if (!m || (m[1] && !Number.isFinite(Date.parse(m[1]))) || !Number.isSafeInteger(Number(m[2]))) return null;
  return { fecha: m[1], fila: Number(m[2]) };
}
const cursorDe = (p: { creado_en: string; fila: number }) => `${p.creado_en}~${p.fila}`;

interface Pieza {
  id: string; codigo: string | null; nombre: string; marca: string; talla: string | null;
  categoria: string; precio: number; precio_lista: number; stock: number; destino: string;
  estado_fisico: string; estado_analisis: string; upc: string | null; tiene_foto: number;
  creado_en: string; actualizado_en: string;
}
type Candidata = Pieza & { fila: number; elegible: number };
const COLUMNAS = `p.id, p.codigo, p.nombre, p.marca, p.talla, p.categoria, p.precio, p.precio_lista,
  p.stock, p.destino, p.estado_fisico, p.estado_analisis, p.upc, p.foto_key <> '' as tiene_foto,
  p.creado_en, p.actualizado_en`;
const VISIBLE = "p.sin_inventario = 0 and p.estado_analisis <> 'descartado'";
const publica = ({ fila, elegible, ...p }: Candidata) => p;

async function buscarPiezas(env: Env, url: URL, propietario: string): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  const ed = /^ed-?(\d{1,10})$/i.exec(q);
  const digitos = /^\d{1,14}$/.test(q);
  const codigo = ed ? `ED-${ed[1].padStart(6, '0')}` : digitos && q.length <= 6 ? `ED-${q.padStart(6, '0')}` : null;
  const upc = digitos && q.length >= 6 ? q.replace(/^0+/, '') || '0' : null;
  const crudo = url.searchParams.get('cursor');
  let cursor = leerCursor(crudo);
  // UPC recorre (upc, rowid), texto recorre (creado_en, rowid); ambos sin offset.
  if (upc && crudo !== null) {
    const m = /^(\d{1,14})~([1-9]\d{0,15})$/.exec(crudo);
    cursor = m && Number.isSafeInteger(Number(m[2])) ? { fecha: m[1], fila: Number(m[2]) } : null;
  }
  if (!q || q.length > 80 || (!codigo && !upc && q.length < 3) || (crudo !== null && !cursor))
    return json({ error: 'Escribe un código o al menos 3 caracteres (máximo 80); revisa el cursor.' }, 400);

  if (codigo && !cursor) {
    const p = await env.DB.prepare(`select ${COLUMNAS} from productos p
      where p.codigo = ? and p.propietario = ? and ${VISIBLE}`).bind(codigo, propietario).first<Pieza>();
    if (p || !upc) return json({ piezas: p ? [p] : [], siguiente: null });
  }
  if (codigo && !upc) return json({ piezas: [], siguiente: null });

  // El índice de expresión productos_upc_foto excluye FEP y piezas sin foto.
  // Todas las variantes usan productos_upc, sin perder esas piezas ni sus ceros.
  const variantes = upc ? Array.from({ length: 15 - upc.length }, (_, i) => upc.padStart(upc.length + i, '0')) : [];
  if (upc && cursor && !variantes.includes(cursor.fecha)) return json({ error: 'Cursor inválido.' }, 400);
  const palabras = upc ? [] : q.split(/\s+/).filter(Boolean);
  // shortcut: lower() de SQLite no pliega acentos; normalizar en una migración si hace falta.
  const coincide = palabras.map(() => "(instr(lower(p.nombre), lower(?)) > 0 or instr(lower(p.marca), lower(?)) > 0)");
  const piezas: Pieza[] = [];
  let siguiente: string | null = null;
  let restantes = codigo ? 999 : 1000;
  let empate = !!cursor;
  // El filtro va en SELECT: LIMIT acota candidatas leídas, incluso si ninguna coincide.
  while (restantes > 0 && piezas.length < PAGINA) {
    const limite = Math.min(TRAMO, restantes);
    const { results } = await env.DB.prepare(`select p.rowid as fila, ${COLUMNAS},
        (${VISIBLE} ${upc ? 'and p.propietario = ?' : ''} ${coincide.length ? 'and ' + coincide.join(' and ') : ''}) as elegible
      from productos p indexed by ${upc ? 'productos_upc' : 'productos_propietario_creado'}
      where ${upc ? `p.upc in (${variantes.map(() => '?').join(',')})` : 'p.propietario = ?'}
        ${cursor ? empate
          ? `and p.${upc ? 'upc' : 'creado_en'} = ? and p.rowid < ?`
          : `and p.${upc ? 'upc' : 'creado_en'} < ?` : ''}
      order by p.${upc ? 'upc' : 'creado_en'} desc, p.rowid desc limit ?`)
      .bind(...(upc ? [propietario] : []), ...palabras.flatMap((p) => [p, p]), ...(upc ? variantes : [propietario]),
        ...(cursor ? [cursor.fecha, ...(empate ? [cursor.fila] : [])] : []), limite).all<Candidata>();
    restantes -= results.length;
    siguiente = null;
    for (let i = 0; i < results.length; i++) {
      const p = results[i];
      cursor = { fecha: upc ? p.upc! : p.creado_en, fila: p.fila };
      if (p.elegible) piezas.push(publica(p));
      if (piezas.length === PAGINA || i === results.length - 1) {
        if (piezas.length === PAGINA || results.length === limite || i < results.length - 1)
          siguiente = cursorDe({ creado_en: cursor.fecha, fila: cursor.fila });
        if (piezas.length === PAGINA) break;
      }
    }
    if (piezas.length === PAGINA) break;
    if (results.length < limite) {
      if (empate) { empate = false; continue; }
      break;
    }
    empate = true;
  }
  return json({ piezas, siguiente });
}

async function fichaPieza(env: Env, id: string, propietario: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador inválido.' }, 400);
  const pieza = await env.DB.prepare(`select ${COLUMNAS} from productos p
    where p.id = ? and p.propietario = ? and ${VISIBLE}`).bind(id, propietario).first<Pieza>();
  if (!pieza) return json({ error: 'Pieza no encontrada.' }, 404);
  // shortcut: índice por fecha existente; añadir (producto_id, ajustado_en) si el historial supera 10 mil filas.
  const { results: historial } = await env.DB.prepare(`select id, motivo, cantidad, antes, despues, ajustado_por, ajustado_en
    from conteo_ajustes where producto_id = ? order by ajustado_en desc, rowid desc limit 10`).bind(id).all();
  return json({ pieza, historial });
}

/** Worker valida host y cuenta; cada consulta aplica además propietarioDe. */
export async function rutaPiezas(request: Request, env: Env, url: URL, usuario: Usuario | null): Promise<Response | null> {
  const detalle = /^\/api\/piezas\/([^/]+)$/.exec(url.pathname);
  if (url.pathname !== '/api/piezas' && !detalle) return null;
  if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405);
  return detalle ? fichaPieza(env, detalle[1], propietarioDe(usuario)) : buscarPiezas(env, url, propietarioDe(usuario));
}
