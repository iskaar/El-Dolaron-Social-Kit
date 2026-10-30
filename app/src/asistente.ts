// Enlace privado del asistente de WhatsApp con la tienda (Issue #296; herramientas de #499). Solo lectura.
// El Worker de WhatsApp llega aqui por service binding con un token secreto; sin token, nada.
// Devuelve nombre, precio y disponibilidad cualitativa de piezas nuevas listas y con existencia, y el
// cupo de la promo vigente. Codigo, foto y enlace solo de piezas que ya muestra el catalogo publico
// (VENDIBLE, #204). Nunca datos de clientes, costos, existencias exactas ni codigos internos.
import { CLAVES_CATEGORIA } from '../public/categorias.js';
import { PROMO_DESCUENTO, PROMO_MINIMO } from '../public/venta.js';
import { VENDIBLE } from './catalogo.ts';
import { promoDe, promoRestantes } from './descuentos.ts';

const encoder = new TextEncoder();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' },
});

/** Compara digests de longitud fija: el tiempo no revela cuántos caracteres coinciden. */
async function tokenValido(recibido: string | null, esperado: string | undefined) {
  if (!recibido || !esperado) return false;
  const [a, b] = await Promise.all([recibido, esperado].map((t) => crypto.subtle.digest('SHA-256', encoder.encode(t))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diferencia = 0;
  for (let i = 0; i < x.length; i++) diferencia |= x[i] ^ y[i];
  return diferencia === 0;
}

const pesos = (centavos: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(centavos / 100);

export type Filtros = { q?: string; categoria?: string; talla?: string; min?: number; max?: number };
const escapar = (texto: string) => texto.replace(/[\\%_]/g, (c) => '\\' + c);
// Sin cifras: el cliente sabe si apurarse, no cuánto inventario hay (igual que «¡Última pieza!» del sitio, #339).
const disponibilidad = (stock: number, sinInventario: number) =>
  sinInventario === 1 || stock > 3 ? 'disponible' : stock === 1 ? 'última pieza' : 'quedan pocas';

/**
 * Piezas que el cliente puede comprar hoy: nuevas, revisadas y con existencia (o bins sin inventario).
 * `min`/`max` en centavos. `foto` usa la ruta pública del catálogo, que solo sirve piezas VENDIBLE.
 */
export async function buscarProductos(db: D1Database, filtros: Filtros, hostFoto?: string) {
  const condiciones: string[] = [], args: unknown[] = [];
  // Los comodines del usuario se escapan: «%» busca el signo, no todo el catálogo.
  if (filtros.q) { condiciones.push(`p.nombre like ? escape '\\'`); args.push(`%${escapar(filtros.q)}%`); }
  if (filtros.categoria) { condiciones.push('p.categoria = ?'); args.push(filtros.categoria); }
  // «M» es la talla de adulto; «Niño 6 años» también encuentra «Niño 6 años / M».
  if (filtros.talla) { condiciones.push(`(upper(p.talla) = upper(?) or upper(p.talla) like upper(?) escape '\\')`); args.push(filtros.talla, `${escapar(filtros.talla)} / %`); }
  if (filtros.min !== undefined) { condiciones.push('p.precio >= ?'); args.push(filtros.min); }
  if (filtros.max !== undefined) { condiciones.push('p.precio <= ?'); args.push(filtros.max); }
  const { results } = await db.prepare(`select p.nombre, p.precio, p.codigo, p.talla, p.stock, p.sin_inventario, (${VENDIBLE}) as vendible
    from productos p
    where p.estado_fisico = 'nuevo' and p.estado_analisis = 'listo' and p.nombre <> ''
      and (p.stock > 0 or p.sin_inventario = 1)${condiciones.map((c) => ` and ${c}`).join('')}
    order by p.actualizado_en desc limit 5`).bind(...args)
    .all<{ nombre: string; precio: number; codigo: string; talla: string | null; stock: number; sin_inventario: number; vendible: number }>();
  return results.map((p) => {
    const publica = p.vendible === 1 && !!hostFoto;
    return {
      nombre: p.nombre, precio: pesos(p.precio), talla: p.talla ?? null, disponibilidad: disponibilidad(p.stock, p.sin_inventario),
      codigo: publica ? p.codigo : null,
      foto: publica ? `https://${hostFoto}/api/catalogo/foto/${p.codigo}` : null,
      // Issue #590: el sitio abre el visor del catálogo sobre esta pieza (catalogo.js lee ?pieza=).
      url: publica ? `https://eldolaron.com/?pieza=${encodeURIComponent(p.codigo)}#catalogo` : null,
    };
  });
}

const fecha = (iso: string) => new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'full', timeStyle: 'short' });

/** Promo de inauguración para el asistente: mismo cupo y ventana que cobra la caja (#487, #250). */
export async function cuposPromocion(env: Env, ahora = Date.now()) {
  const promo = promoDe(env);
  if (!promo) return { estado: 'sin_promo', restantes: 0, mensaje: 'No hay promoción vigente.' };
  const base = { desde: fecha(promo.desde), hasta: fecha(promo.hasta), descuento: pesos(PROMO_DESCUENTO), compra_minima: pesos(PROMO_MINIMO) };
  if (ahora >= Date.parse(promo.hasta)) return { estado: 'terminada', restantes: 0, ...base, mensaje: 'La promoción ya terminó.' };
  const restantes = await promoRestantes(env);
  if (restantes === 0) return { estado: 'agotada', restantes: 0, ...base, mensaje: 'Ya se acabaron los descuentos de la promoción.' };
  const proxima = ahora < Date.parse(promo.desde);
  return { estado: proxima ? 'proxima' : 'vigente', restantes, ...base,
    mensaje: `${proxima ? 'Aún no empieza' : 'Vigente'}; ${restantes === null ? 'sin tope de descuentos' : `quedan ${restantes} descuentos`}.` };
}

/** Número en pesos de la consulta a centavos enteros; null si no es válido, undefined si no vino. */
function centavos(texto: string | null) {
  if (texto === null || texto.trim() === '') return undefined;
  const c = Math.round(Number(texto) * 100);
  return Number.isSafeInteger(c) && c >= 0 ? c : null;
}

export async function rutaAsistente(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ASISTENTE_TOKEN) return json({ error: 'Asistente no configurado.' }, 503);
  if (!await tokenValido(request.headers.get('x-asistente-token'), env.ASISTENTE_TOKEN))
    return json({ error: 'No autorizado.' }, 401);
  if (request.method !== 'GET') return json({ error: 'Ruta no encontrada.' }, 404);
  if (url.pathname === '/api/asistente/productos') {
    const texto = (nombre: string, max: number) => (url.searchParams.get(nombre) ?? '').trim().slice(0, max);
    const categoria = texto('categoria', 20), talla = texto('talla', 30);
    const min = centavos(url.searchParams.get('min')), max = centavos(url.searchParams.get('max'));
    if (categoria && !CLAVES_CATEGORIA.includes(categoria)) return json({ error: 'Categoría no válida.', categorias: CLAVES_CATEGORIA }, 400);
    if (min === null || max === null) return json({ error: 'Precio no válido.' }, 400);
    return json({ productos: await buscarProductos(env.DB, { q: texto('q', 60), categoria, talla, min, max }, env.HOST_PORTAL) });
  }
  if (url.pathname === '/api/asistente/promocion') return json(await cuposPromocion(env));
  return json({ error: 'Ruta no encontrada.' }, 404);
}
