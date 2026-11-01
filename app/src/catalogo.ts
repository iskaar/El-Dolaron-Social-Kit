/**
 * Catalogo publico (Issue #204): lo que el sitio eldolaron.com muestra de la tienda.
 * Solo vive en el host publico (HOST_PORTAL); en los hosts del personal estas
 * rutas no existen (caen en el control de Access de siempre). Solo lectura y sin
 * campos internos: ni id, ni costo, ni existencias, ni llave de R2.
 * Sin Cache API: el max-age de 300 s ya protege a D1 y una pieza vendida no debe
 * seguir en el escaparate mas de eso. ponytail: caches.default si el trafico lo pide.
 */

import { CLAVES_CATEGORIA } from '../public/categorias.js';
import { TALLAS } from '../public/tallas.js';
import { PUBLICABLE } from './mercadolibre.ts';

const POR_PAGINA = 24;
const DESTACADOS = 6;
const DIAS_DESTACADOS = 14;
const ORIGEN_SITIO = 'https://eldolaron.com';
const CODIGO = /^ED-\d{1,10}$/;
// Presentable (Issue #220): precio, foto y nombre que se pueda leer. Nombres
// internos = los que parecen codigo de banda ("DAMA 150 12") o llevan precio
// ("Juguetes $49"). Sin campo que lo diga: es un patron de texto.
// Dos formas: todo en mayusculas con numeros, o una palabra seguida solo de numeros/$
// en cualquier caja ("dama 50", "Juguetes $49"; Issue #241: "dama 50" se colaba).
// ponytail: falsos positivos si una pieza real trae mayusculas y numeros ("TV 55 PULGADAS") o es
// marca + modelo ("Xbox 360"); la revision en /admin la deja corregir. Subir a columna `interna` si pasa seguido.
const RESTO_NOMBRE = `ltrim(substr(trim(p.nombre), instr(trim(p.nombre), ' ')))`;
const NOMBRE_INTERNO = `((p.nombre glob '*[0-9]*' and upper(p.nombre) = p.nombre)
  or (instr(trim(p.nombre), ' ') > 0 and ${RESTO_NOMBRE} glob '[0-9$]*' and not ${RESTO_NOMBRE} glob '*[A-Za-zÁÉÍÓÚÑáéíóúñ]*'))`;
const PRESENTABLE = `p.precio > 0 and p.foto_key <> '' and trim(p.nombre) <> '' and not ${NOMBRE_INTERNO}`;
// Lo mismo que se publica en Mercado Libre, mas presentable: el sitio nunca muestra $0, sin foto ni nombre interno.
export const VENDIBLE = `${PUBLICABLE} and ${PRESENTABLE}`;

const CORS = {
  'access-control-allow-origin': ORIGEN_SITIO,
  'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(cuerpo: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': ORIGEN_SITIO, ...extra },
  });
}

function aPieza(p: Record<string, any>, url: URL) {
  return {
    codigo: p.codigo, nombre: p.nombre, marca: p.marca, categoria: p.categoria, talla: p.talla ?? null,
    precio: p.precio, precio_lista: p.precio_lista > p.precio ? p.precio_lista : 0,
    foto: `${url.origin}/api/catalogo/foto/${p.codigo}`,
    recorte: p.recorte_estado === 'listo' && p.recorte_revision === 'ok' ? `${url.origin}/api/catalogo/recorte/${p.codigo}` : null,
    llegado_en: String(p.creado_en).slice(0, 10), // solo el dia (Issue #646): "Llego esta semana", sin hora
  };
}

/**
 * Lo que mas se vendio en 14 dias y sigue a la venta; si faltan, lo mas nuevo.
 * Con ?orden=precio (Issue #339, «Los más buscados» del sitio): lo de mayor precio, con `ultima` si queda una sola
 * pieza. Solo esa marca, nunca la existencia: el sitio no debe enseñar cuánto inventario hay.
 */
async function destacados(env: Env, url: URL): Promise<Response> {
  if (url.searchParams.get('orden') === 'precio') {
    const filas = await env.DB.prepare(`select p.codigo, p.nombre, p.marca, p.categoria, p.talla, p.precio, p.precio_lista, p.stock, p.creado_en, p.recorte_estado, p.recorte_revision from productos p
      where ${VENDIBLE} order by p.precio desc, p.creado_en desc, p.codigo limit ?`).bind(DESTACADOS).all<Record<string, any>>();
    return json({ piezas: filas.results.map((p) => ({ ...aPieza(p, url), ultima: p.stock === 1 })) }, 200, { 'cache-control': 'public, max-age=300' });
  }
  const desde = new Date(Date.now() - DIAS_DESTACADOS * 86_400_000).toISOString();
  const filas = await env.DB.prepare(`select p.codigo, p.nombre, p.marca, p.categoria, p.talla, p.precio, p.precio_lista, p.creado_en, p.recorte_estado, p.recorte_revision from productos p
    left join (select l.codigo, sum(l.cantidad) as n from venta_lineas l join ventas v on v.id = l.venta_id
      where v.cancelada = 0 and v.creado_en >= ? group by l.codigo) s on s.codigo = p.codigo
    where ${VENDIBLE} order by coalesce(s.n, 0) desc, p.creado_en desc, p.codigo limit ?`)
    .bind(desde, DESTACADOS).all<Record<string, any>>();
  return json({ piezas: filas.results.map((p) => aPieza(p, url)) }, 200, { 'cache-control': 'public, max-age=300' });
}

/** Staff (Issue #220): en existencia pero no presentable, con el motivo. Mismo universo que PUBLICABLE, sin el filtro de foto. */
export async function revisionCatalogo(env: Env): Promise<Response> {
  const filas = await env.DB.prepare(`select p.id, p.codigo, p.nombre, p.marca, p.categoria, p.estado_fisico, p.estado_analisis,
      p.precio_lista, p.precio, p.stock, p.destino, p.semana_ingreso, p.creado_en, p.foto_key, p.propietario, p.upc,
      (p.foto_key = '') as sin_foto, (p.precio <= 0) as sin_precio, (trim(p.nombre) = '') as sin_nombre, ${NOMBRE_INTERNO} as nombre_interno
    from productos p
    where p.destino = 'etiqueta' and p.sin_inventario = 0 and p.estado_analisis = 'listo' and p.stock > 0
      and p.estado_fisico = 'nuevo' and p.codigo like 'ED-%'
      and (p.precio <= 0 or p.foto_key = '' or trim(p.nombre) = '' or ${NOMBRE_INTERNO})
    order by p.creado_en desc, p.codigo`).all<Record<string, any>>();
  const piezas = filas.results.map(({ sin_foto, sin_precio, sin_nombre, nombre_interno, ...p }) => ({
    ...p,
    motivos: [
      ...(sin_foto ? ['sin_foto'] : []),
      ...(sin_precio ? ['sin_precio'] : []),
      ...(sin_nombre ? ['sin_nombre'] : []),
      ...(nombre_interno ? ['nombre_interno'] : []),
    ],
  }));
  return new Response(JSON.stringify({ piezas }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// Cursor = fecha de alta + codigo de la ultima pieza entregada (Issue #241): con `pagina`
// (offset), una venta entre paginas recorria las filas y se saltaba una pieza.
// La fecha va tal cual la guarda D1 (siempre como parametro, nunca en el SQL).
const CURSOR = /^([^~]{1,40})~(ED-\d{1,10})$/;
const ACENTOS: readonly [string, string][] = [
  ['á', 'a'], ['é', 'e'], ['í', 'i'], ['ó', 'o'], ['ú', 'u'], ['ü', 'u'], ['ñ', 'n'],
  ['Á', 'a'], ['É', 'e'], ['Í', 'i'], ['Ó', 'o'], ['Ú', 'u'], ['Ü', 'u'], ['Ñ', 'n'],
];
const sinAcentosSql = (expr: string) =>
  ACENTOS.reduce((sql, [de, a]) => `replace(${sql}, '${de}', '${a}')`, `lower(${expr})`);
const CAMPO_BUSQUEDA = sinAcentosSql(`p.nombre || ' ' || p.marca || ' ' || p.codigo || ' ' || coalesce(p.talla, '')`);
const normalizarBusqueda = (q: string) =>
  q.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);

// Talla (Issue #672): igualdad exacta sin acentos ni mayusculas ni espacios de mas (no es LIKE: «M» no debe traer «XM»).
const normalizarTalla = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
const SQL_TALLA = sinAcentosSql(`trim(coalesce(p.talla, ''))`);
const TALLA_MAX = 30; // la talla guardada mas larga mide 21 («Niño 12-18 meses / XL»); el campo admite 30
const DIAS_MAX = 30;
// Parametro entero >= 0: undefined si falta, NaN si no es un entero (de hasta 9 digitos).
const entero = (texto: string | null) => (texto === null ? undefined : /^\d{1,9}$/.test(texto) ? Number(texto) : NaN);
// Orden conocido de tallas (tallas.js); lo que no este en la lista va al final, alfabetico.
const ORDEN_TALLA = new Map<string, number>(TALLAS.map((t: string, i: number) => [t, i]));
const porTalla = (a: string, b: string) => (ORDEN_TALLA.get(a) ?? Infinity) - (ORDEN_TALLA.get(b) ?? Infinity) || a.localeCompare(b, 'es');

async function listar(env: Env, url: URL): Promise<Response> {
  // Issue #671: ?codigo=ED-… = exactamente esa pieza (la vista previa del sitio); q= también coincidiría con ED-0001234.
  const codigo = url.searchParams.get('codigo');
  if (codigo !== null) {
    if (!CODIGO.test(codigo)) return json({ error: 'Código no válido.' }, 400);
    const p = await env.DB.prepare(`select p.codigo, p.nombre, p.marca, p.categoria, p.talla, p.precio, p.precio_lista, p.stock, p.creado_en, p.recorte_estado, p.recorte_revision from productos p
      where ${VENDIBLE} and p.codigo = ?`).bind(codigo).first<Record<string, any>>();
    return json({ piezas: p ? [{ ...aPieza(p, url), ultima: p.stock === 1 }] : [] }, 200, { 'cache-control': 'public, max-age=300' });
  }
  const categoria = url.searchParams.get('categoria');
  if (categoria !== null && !CLAVES_CATEGORIA.includes(categoria)) return json({ error: 'Categoría no válida.' }, 400);
  const qCruda = url.searchParams.get('q');
  const q = qCruda === null ? '' : qCruda.trim().replace(/\s+/g, ' ');
  if (q.length > 80) return json({ error: 'Búsqueda no válida.' }, 400);
  const texto = url.searchParams.get('pagina') ?? '1';
  const pagina = Number(texto);
  if (!/^\d+$/.test(texto) || !Number.isSafeInteger(pagina) || pagina < 1) return json({ error: 'Página no válida.' }, 400);
  const despues = url.searchParams.get('despues');
  const cursor = despues === null ? null : CURSOR.exec(despues);
  if (despues !== null && !cursor) return json({ error: 'Cursor no válido.' }, 400);

  // Issue #672: talla, banda de precio, «Llegó esta semana» y lista de tallas; todo opcional y combinable.
  const tallaCruda = url.searchParams.get('talla');
  const talla = tallaCruda === null ? '' : normalizarTalla(tallaCruda);
  if (talla.length > TALLA_MAX) return json({ error: 'Talla no válida.' }, 400);
  const precioMin = entero(url.searchParams.get('precio_min'));
  const precioMax = entero(url.searchParams.get('precio_max'));
  if (Number.isNaN(precioMin) || Number.isNaN(precioMax)) return json({ error: 'Precio no válido.' }, 400);
  if (precioMin !== undefined && precioMax !== undefined && precioMin > precioMax) return json({ error: 'Rango de precio no válido.' }, 400);
  const dias = entero(url.searchParams.get('dias'));
  if (Number.isNaN(dias) || (dias !== undefined && (dias < 1 || dias > DIAS_MAX))) return json({ error: 'Días no válidos.' }, 400);
  const tallasTexto = url.searchParams.get('tallas');
  if (tallasTexto !== null && tallasTexto !== '1') return json({ error: 'Parámetro tallas no válido.' }, 400);

  // Issue #526: ?recorte=1 = solo piezas con recorte listo y revisado (la misma condicion que arma la URL `recorte`).
  const conRecorte = url.searchParams.get('recorte') === '1' ? ` and p.recorte_estado = 'listo' and p.recorte_revision = 'ok'` : '';
  // `base` es todo menos la talla: la lista de tallas (`tallas=1`) se calcula con ella para que el menu no se reduzca a la talla elegida.
  const base = `${VENDIBLE}${conRecorte}${categoria === null ? '' : ' and p.categoria = ?'}${q ? ` and ${CAMPO_BUSQUEDA} like ? escape '\\'` : ''}`
    + `${precioMin === undefined ? '' : ' and p.precio >= ?'}${precioMax === undefined ? '' : ' and p.precio <= ?'}${dias === undefined ? '' : ' and p.creado_en >= ?'}`;
  const argsBase: unknown[] = [...(categoria === null ? [] : [categoria]), ...(q ? [`%${normalizarBusqueda(q)}%`] : []),
    ...(precioMin === undefined ? [] : [precioMin]), ...(precioMax === undefined ? [] : [precioMax]),
    ...(dias === undefined ? [] : [new Date(Date.now() - dias * 86_400_000).toISOString()])];
  const filtro = `${base}${talla ? ` and ${SQL_TALLA} = ?` : ''}`;
  const args: unknown[] = [...argsBase, ...(talla ? [talla] : [])];
  const desde = cursor ? ' and (p.creado_en < ? or (p.creado_en = ? and p.codigo > ?))' : '';
  const [filas, cuenta, tallas] = await Promise.all([
    env.DB.prepare(`select p.codigo, p.nombre, p.marca, p.categoria, p.talla, p.precio, p.precio_lista, p.stock, p.creado_en, p.recorte_estado, p.recorte_revision from productos p
      where ${filtro}${desde} order by p.creado_en desc, p.codigo limit ? offset ?`)
      .bind(...args, ...(cursor ? [cursor[1], cursor[1], cursor[2]] : []), POR_PAGINA + 1, cursor ? 0 : (pagina - 1) * POR_PAGINA)
      .all<Record<string, any>>(),
    env.DB.prepare(`select count(*) as n from productos p where ${filtro}`).bind(...args).first<{ n: number }>(),
    tallasTexto === null ? null : env.DB.prepare(`select distinct p.talla from productos p where ${base} and trim(coalesce(p.talla, '')) <> ''`)
      .bind(...argsBase).all<{ talla: string }>(),
  ]);
  const hayMas = filas.results.length > POR_PAGINA;
  const ultima = filas.results[POR_PAGINA - 1];
  const piezas = filas.results.slice(0, POR_PAGINA).map((p) => ({ ...aPieza(p, url), ultima: p.stock === 1 })); // solo la marca, nunca stock
  return json({ piezas, pagina, hay_mas: hayMas, siguiente: hayMas ? `${ultima.creado_en}~${ultima.codigo}` : null, total: cuenta?.n ?? 0,
    ...(tallas ? { tallas: tallas.results.map((r) => r.talla).sort(porTalla) } : {}) }, 200,
    { 'cache-control': 'public, max-age=300' });
}

async function foto(env: Env, codigo: string, recorte = false): Promise<Response> {
  const no = () => json({ error: 'Foto no encontrada.' }, 404);
  if (!CODIGO.test(codigo)) return no();
  // Una pieza apartada (stock 0) sigue enseñando su foto: «Mis apartados» del portal (#669) la pide aqui. No se sirve ninguna otra sin existencia.
  const p = await env.DB.prepare(`select p.id, p.foto_key, p.recorte_estado, p.recorte_revision from productos p
    where (${VENDIBLE} or (p.codigo like 'ED-%' and p.propietario = 'dolaron' and exists (select 1 from pedido_lineas l join pedidos d on d.id = l.pedido_id
      where l.producto_id = p.id and d.estado = 'apartado'))) and p.codigo = ?`)
    .bind(codigo).first<{ id: string; foto_key: string; recorte_estado: string | null; recorte_revision: string | null }>();
  const objeto = p && (!recorte || (p.recorte_estado === 'listo' && p.recorte_revision === 'ok')) && await env.FOTOS.get(recorte ? `recortes/${p.id}.webp` : p.foto_key);
  if (!objeto) return no();
  return new Response(objeto.body, {
    headers: {
      'content-type': objeto.httpMetadata?.contentType || (recorte ? 'image/webp' : 'image/jpeg'),
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': ORIGEN_SITIO,
    },
  });
}

// Medicion de la ficha (Issue #651, docs/UX-COMPRA.md §6). Solo evento, pieza y origen: nada de IP, agente ni identificadores.
const EVENTOS = ['ficha_abierta', 'lo_quiero', 'apartar_recoger', 'apartar_envio', 'preguntar', 'whatsapp_abierto', 'compartir', 'apartado_portal',
  'carrito_agregar', 'comprar_ya', 'carrito_apartar'];
const ORIGENES = ['sitio', 'portal'];

async function evento(request: Request, env: Env): Promise<Response> {
  const malo = () => json({ error: 'Evento no válido.' }, 400);
  let c: Record<string, unknown> | null = null;
  try {
    const texto = await request.text();
    if (texto.length <= 300) c = JSON.parse(texto); // sendBeacon manda text/plain: se lee el cuerpo, no el content-type
  } catch { return malo(); }
  if (!c || typeof c !== 'object') return malo();
  const { evento: e, codigo, origen } = c;
  if (typeof e !== 'string' || typeof codigo !== 'string' || typeof origen !== 'string'
    || !EVENTOS.includes(e) || !CODIGO.test(codigo) || !ORIGENES.includes(origen)) return malo();
  try { env.EVENTOS?.writeDataPoint({ blobs: [e, codigo, origen], indexes: [e] }); } catch { /* medir nunca rompe la ficha */ }
  return new Response(null, { status: 204, headers: CORS });
}

/** null = la ruta no es del catalogo. */
export async function catalogoPublico(request: Request, env: Env, url: URL): Promise<Response | null> {
  const { pathname } = url;
  const esFoto = pathname.startsWith('/api/catalogo/foto/');
  const esRecorte = pathname.startsWith('/api/catalogo/recorte/');
  const esDestacados = pathname === '/api/catalogo/destacados';
  const esEvento = pathname === '/api/catalogo/evento';
  if (pathname !== '/api/catalogo' && !esFoto && !esRecorte && !esDestacados && !esEvento) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (esEvento) {
    return request.method === 'POST' ? evento(request, env) : json({ error: 'Método no permitido.' }, 405, { allow: 'POST, OPTIONS' });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Método no permitido.' }, 405, { allow: 'GET, HEAD, OPTIONS' });
  }
  try {
    if (esFoto) return await foto(env, pathname.slice('/api/catalogo/foto/'.length));
    if (esRecorte) return await foto(env, pathname.slice('/api/catalogo/recorte/'.length), true);
    return esDestacados ? await destacados(env, url) : await listar(env, url);
  } catch {
    return json({ error: 'Servicio no disponible.' }, 503);
  }
}
