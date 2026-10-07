/**
 * Catalogo publico (Issue #204): lo que el sitio eldolaron.com muestra de la tienda.
 * Solo vive en el host publico (HOST_PORTAL); en los hosts del personal estas
 * rutas no existen (caen en el control de Access de siempre). Solo lectura y sin
 * campos internos: ni id, ni costo, ni existencias, ni llave de R2.
 * Sin Cache API: el max-age de 300 s ya protege a D1 y una pieza vendida no debe
 * seguir en el escaparate mas de eso. ponytail: caches.default si el trafico lo pide.
 */

import { CLAVES_CATEGORIA } from '../public/categorias.js';
import { PUBLICABLE } from './mercadolibre.ts';

const POR_PAGINA = 24;
const DESTACADOS = 6;
const DIAS_DESTACADOS = 14;
const ORIGEN_SITIO = 'https://eldolaron.com';
const CODIGO = /^ED-\d{1,10}$/;
// Lo mismo que se publica en Mercado Libre, mas precio: el sitio nunca muestra $0.
const VENDIBLE = `${PUBLICABLE} and p.precio > 0`;

const CORS = {
  'access-control-allow-origin': ORIGEN_SITIO,
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
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
    codigo: p.codigo, nombre: p.nombre, marca: p.marca, categoria: p.categoria,
    precio: p.precio, precio_lista: p.precio_lista > p.precio ? p.precio_lista : 0,
    foto: `${url.origin}/api/catalogo/foto/${p.codigo}`,
  };
}

/** Portada del sitio: lo que mas se vendio en 14 dias y sigue a la venta; si faltan, lo mas nuevo. */
async function destacados(env: Env, url: URL): Promise<Response> {
  const desde = new Date(Date.now() - DIAS_DESTACADOS * 86_400_000).toISOString();
  const filas = await env.DB.prepare(`select p.codigo, p.nombre, p.marca, p.categoria, p.precio, p.precio_lista from productos p
    left join (select l.codigo, sum(l.cantidad) as n from venta_lineas l join ventas v on v.id = l.venta_id
      where v.cancelada = 0 and v.creado_en >= ? group by l.codigo) s on s.codigo = p.codigo
    where ${VENDIBLE} order by coalesce(s.n, 0) desc, p.creado_en desc, p.codigo limit ?`)
    .bind(desde, DESTACADOS).all<Record<string, any>>();
  return json({ piezas: filas.results.map((p) => aPieza(p, url)) }, 200, { 'cache-control': 'public, max-age=300' });
}

async function listar(env: Env, url: URL): Promise<Response> {
  const categoria = url.searchParams.get('categoria');
  if (categoria !== null && !CLAVES_CATEGORIA.includes(categoria)) return json({ error: 'Categoría no válida.' }, 400);
  const texto = url.searchParams.get('pagina') ?? '1';
  const pagina = Number(texto);
  if (!/^\d+$/.test(texto) || !Number.isSafeInteger(pagina) || pagina < 1) return json({ error: 'Página no válida.' }, 400);

  const filtro = `${VENDIBLE}${categoria === null ? '' : ' and p.categoria = ?'}`;
  const args = categoria === null ? [] : [categoria];
  const [filas, cuenta] = await Promise.all([
    env.DB.prepare(`select p.codigo, p.nombre, p.marca, p.categoria, p.precio, p.precio_lista from productos p
      where ${filtro} order by p.creado_en desc, p.codigo limit ? offset ?`)
      .bind(...args, POR_PAGINA + 1, (pagina - 1) * POR_PAGINA).all<Record<string, any>>(),
    env.DB.prepare(`select count(*) as n from productos p where ${filtro}`).bind(...args).first<{ n: number }>(),
  ]);
  const piezas = filas.results.slice(0, POR_PAGINA).map((p) => aPieza(p, url));
  return json({ piezas, pagina, hay_mas: filas.results.length > POR_PAGINA, total: cuenta?.n ?? 0 }, 200,
    { 'cache-control': 'public, max-age=300' });
}

async function foto(env: Env, codigo: string): Promise<Response> {
  const no = () => json({ error: 'Foto no encontrada.' }, 404);
  if (!CODIGO.test(codigo)) return no();
  const p = await env.DB.prepare(`select p.foto_key from productos p where ${VENDIBLE} and p.codigo = ?`)
    .bind(codigo).first<{ foto_key: string }>();
  const objeto = p && await env.FOTOS.get(p.foto_key);
  if (!objeto) return no();
  return new Response(objeto.body, {
    headers: {
      'content-type': objeto.httpMetadata?.contentType || 'image/jpeg',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': ORIGEN_SITIO,
    },
  });
}

/** null = la ruta no es del catalogo. */
export async function catalogoPublico(request: Request, env: Env, url: URL): Promise<Response | null> {
  const { pathname } = url;
  const esFoto = pathname.startsWith('/api/catalogo/foto/');
  const esDestacados = pathname === '/api/catalogo/destacados';
  if (pathname !== '/api/catalogo' && !esFoto && !esDestacados) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Método no permitido.' }, 405, { allow: 'GET, HEAD, OPTIONS' });
  }
  try {
    if (esFoto) return await foto(env, pathname.slice('/api/catalogo/foto/'.length));
    return esDestacados ? await destacados(env, url) : await listar(env, url);
  } catch {
    return json({ error: 'Servicio no disponible.' }, 503);
  }
}
