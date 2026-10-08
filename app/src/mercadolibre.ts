/**
 * Mercado Libre Mexico (MLM), Issue #170: publicar piezas con foto y mantener
 * las existencias de acuerdo con D1. Referencia de la API: docs/MERCADOLIBRE-API.md.
 *
 * Reglas que mandan en este archivo:
 * - D1 es el unico maestro de existencias. Una venta en ML descuenta en D1
 *   (ml_ventas, idempotente); una venta en tienda pausa el articulo en ML.
 * - Una venta de ML NO entra a `ventas` ni a los cortes: no hay cajon de por
 *   medio, y meterla descuadraria el efectivo. Vive solo en `ml_ventas`.
 * - Del cuerpo de una notificacion no se cree nada: se vuelve a pedir el recurso
 *   a ML con nuestro token.
 * - Los tokens viven cifrados (AES-GCM) en D1; el refresh token es de un solo
 *   uso y se gasta bajo un candado en la misma fila.
 * - Dinero en centavos MXN; a ML se manda en pesos.
 */

import { quebrarDecena } from './precio.ts';

const API = 'https://api.mercadolibre.com';
const AUTORIZACION = 'https://auth.mercadolibre.com.mx/authorization';
const PRECIO_MINIMO = 3500;               // ML no acepta publicaciones de menos de $35
const MARGEN_TOKEN_MS = 5 * 60_000;       // se renueva con 5 min de sobra
const CANDADO_MS = 30_000;                // lo que dura el candado de refresh
const OAUTH_VIGENCIA_MS = 15 * 60_000;
const TIPOS_PUBLICACION = ['gold_special', 'gold_pro', 'free'];
// Marcas de publicacion restringida en Mexico (docs/MERCADOLIBRE-API.md, riesgo 3).
// ponytail: lista corta de las documentadas; ML puede restringir mas, y ahi manda su error.
const MARCAS_RESTRINGIDAS = ['nike', 'adidas', 'reebok'];
const ID_PIEZA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FALTANTES = ['ML_CLIENT_ID', 'ML_CLIENT_SECRET', 'ML_LLAVE_TOKENS', 'ML_RUTA_NOTIFICACIONES', 'ML_REDIRECT_URI'] as const;

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const dormir = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

/* ---------- errores de ML ---------- */

/** `mensaje` es el de ML; `texto` ya viene en espanol (para mostrarlo al dueno). */
interface Causa { codigo: string; mensaje: string; texto: string }

/** Un fallo de ML (o de nuestra configuracion) con texto que el dueno entiende. */
export class ErrorML extends Error {
  status: number;
  codigo: string;
  detalle: string;
  causas: Causa[];
  /** true = lo decidimos nosotros (sin conexion, sin foto...), no vino de ML. */
  local: boolean;
  constructor(status: number, codigo: string, detalle: string, causas: Causa[] = [], local = false) {
    super(detalle);
    this.status = status;
    this.codigo = codigo;
    this.detalle = detalle;
    this.causas = causas;
    this.local = local;
  }
}

const errorLocal = (status: number, codigo: string, detalle: string) => new ErrorML(status, codigo, detalle, [], true);

const TRADUCCIONES: [RegExp, string][] = [
  [/moderations\.seller\.not_authorized|not authorized for this brand/i, 'Tu cuenta no está autorizada para vender esta marca en esta categoría.'],
  [/fashion_grid|size_grid/i, 'Falta la guía de tallas, o la talla no coincide con la fila elegida.'],
  [/me2_adoption_mandatory/i, 'Tu cuenta debe activar Mercado Envíos antes de publicar.'],
  [/seller\.unable_to_list/i, 'Tu cuenta aún no puede publicar: haz una primera publicación a mano desde la web de Mercado Libre.'],
  [/description\.type\.invalid/i, 'La descripción trae caracteres que Mercado Libre no permite.'],
  [/package\.dimensions|SELLER_PACKAGE/i, 'Las medidas del paquete deben ser números sin unidades.'],
  [/value_is_not_in_the_list/i, 'Un atributo debe escogerse de la lista de Mercado Libre.'],
  [/minimum_size|below the minimum allowed size|picture.*size/i, 'La foto es muy chica: Mercado Libre pide mínimo 500 x 500 píxeles.'],
  [/title/i, 'El título no es válido para Mercado Libre.'],
  [/missing.*attribute|attribute.*missing|required/i, 'Falta un dato obligatorio de la categoría.'],
  [/invalid_grant/i, 'La autorización de Mercado Libre venció o ya se usó; vuelve a conectarla.'],
];

function traducir(c: { codigo: string; mensaje: string }): string {
  const hallada = TRADUCCIONES.find(([patron]) => patron.test(`${c.codigo} ${c.mensaje}`));
  const original = c.mensaje || c.codigo;
  return hallada ? (original ? `${hallada[1]} (${original})` : hallada[1]) : original;
}

function errorDe(status: number, cuerpo: any, texto: string): ErrorML {
  const causas: Causa[] = (Array.isArray(cuerpo?.cause) ? cuerpo.cause : [])
    .filter((c: any) => c && c.type !== 'warning')
    .map((c: any) => {
      const causa = { codigo: String(c.code ?? c.cause_id ?? ''), mensaje: String(c.message ?? '') };
      return { ...causa, texto: traducir(causa) };
    });
  const codigo = String(cuerpo?.error ?? '');
  const base = String(cuerpo?.message ?? cuerpo?.error_description ?? texto.slice(0, 200));
  const partes = causas.length ? causas.map((c) => c.texto) : [traducir({ codigo, mensaje: base })];
  return new ErrorML(status, codigo, [...new Set(partes)].join(' '), causas);
}

/** La respuesta HTTP para un ErrorML (o cualquier otro fallo) dentro de una ruta. */
function respuestaError(error: unknown, titulo: string): Response {
  if (error instanceof ErrorML) {
    if (error.local) return json({ error: error.detalle, codigo: error.codigo }, error.status);
    if (error.status >= 400 && error.status < 500 && error.status !== 429) {
      return json({ error: titulo, detalle: error.detalle, causas: error.causas }, 422);
    }
    return json({ error: 'Mercado Libre no respondió bien. Intenta de nuevo en un rato.', detalle: error.detalle }, 502);
  }
  console.error(JSON.stringify({ mensaje: 'fallo con Mercado Libre', error: String(error) }));
  return json({ error: 'No se pudo hablar con Mercado Libre. Intenta de nuevo.', detalle: String(error) }, 502);
}

/* ---------- tokens cifrados ---------- */

const aBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const deBase64 = (texto: string) => Uint8Array.from(atob(texto), (c) => c.charCodeAt(0));
const aBase64Url = (bytes: Uint8Array) => aBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function llaveTokens(env: Env): Promise<CryptoKey> {
  let crudo = new Uint8Array(0);
  try { crudo = deBase64(env.ML_LLAVE_TOKENS ?? ''); } catch { /* queda vacia: abajo se rechaza */ }
  if (crudo.length !== 32) {
    throw errorLocal(409, 'falta_configuracion', 'Falta ML_LLAVE_TOKENS (base64 de 32 bytes) en los secretos del Worker.');
  }
  return crypto.subtle.importKey('raw', crudo, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function cifrar(env: Env, texto: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await llaveTokens(env), new TextEncoder().encode(texto)));
  return aBase64(new Uint8Array([...iv, ...cifrado]));
}

async function descifrar(env: Env, dato: string): Promise<string> {
  const bytes = deBase64(dato);
  const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await llaveTokens(env), bytes.slice(12));
  return new TextDecoder().decode(claro);
}

/** Comparacion en tiempo constante (via SHA-256: ambos del mismo largo). */
async function iguales(a: string, b: string): Promise<boolean> {
  const huella = async (t: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
  const [x, y] = [await huella(a), await huella(b)];
  let diferencia = 0;
  for (let i = 0; i < x.length; i++) diferencia |= x[i] ^ y[i];
  return diferencia === 0;
}

/* ---------- cuenta y OAuth ---------- */

interface FilaCuenta {
  ml_user_id: string; nickname: string; tags: string;
  access_token_cifrado: string; refresh_token_cifrado: string;
  expira_en: string; actualizado_en: string; refrescando_hasta: string;
}

const leerCuenta = (env: Env) => env.DB.prepare('select * from ml_cuenta where id = 1').first<FilaCuenta>();
const conectada = (c: FilaCuenta | null): c is FilaCuenta => !!c?.refresh_token_cifrado;
const faltantes = (env: Env) => FALTANTES.filter((nombre) => !env[nombre]);

async function config(env: Env): Promise<{ ml_pct: number; ml_tipo_publicacion: string }> {
  const { results } = await env.DB.prepare(`select clave, valor from config where clave in ('ml_pct', 'ml_tipo_publicacion')`)
    .all<{ clave: string; valor: string }>();
  const mapa = Object.fromEntries(results.map((f) => [f.clave, f.valor]));
  const pct = Number.parseInt(mapa.ml_pct ?? '', 10);
  return {
    ml_pct: Number.isFinite(pct) && pct >= 0 ? pct : 20,
    ml_tipo_publicacion: TIPOS_PUBLICACION.includes(mapa.ml_tipo_publicacion) ? mapa.ml_tipo_publicacion : 'gold_special',
  };
}

interface TokenML { access_token: string; refresh_token: string; expires_in: number; user_id?: number | string }

/** Guarda tokens (cifrados) y suelta el candado de refresh, en una sola sentencia. */
export async function guardarTokens(env: Env, t: TokenML): Promise<void> {
  const ahora = new Date();
  const expira = new Date(ahora.getTime() + (Number(t.expires_in) || 10800) * 1000).toISOString();
  await env.DB.prepare(
    `insert into ml_cuenta (id, ml_user_id, access_token_cifrado, refresh_token_cifrado, expira_en, actualizado_en, refrescando_hasta)
     values (1, ?, ?, ?, ?, ?, '')
     on conflict (id) do update set
       ml_user_id = case when excluded.ml_user_id <> '' then excluded.ml_user_id else ml_cuenta.ml_user_id end,
       access_token_cifrado = excluded.access_token_cifrado, refresh_token_cifrado = excluded.refresh_token_cifrado,
       expira_en = excluded.expira_en, actualizado_en = excluded.actualizado_en, refrescando_hasta = ''`,
  )
    .bind(String(t.user_id ?? ''), await cifrar(env, t.access_token), await cifrar(env, t.refresh_token), expira, ahora.toISOString())
    .run();
}

const desconectar = (env: Env) => env.DB.prepare(
  `update ml_cuenta set access_token_cifrado = '', refresh_token_cifrado = '', expira_en = '', refrescando_hasta = '' where id = 1`,
).run();

async function pedirToken(env: Env, parametros: Record<string, string>): Promise<TokenML> {
  if (!env.ML_CLIENT_ID || !env.ML_CLIENT_SECRET) {
    throw errorLocal(409, 'falta_configuracion', 'Faltan ML_CLIENT_ID y ML_CLIENT_SECRET en los secretos del Worker.');
  }
  const respuesta = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...parametros, client_id: env.ML_CLIENT_ID, client_secret: env.ML_CLIENT_SECRET }),
  });
  const texto = await respuesta.text();
  let cuerpo: any = null;
  try { cuerpo = JSON.parse(texto); } catch { /* el error se arma con el texto */ }
  if (!respuesta.ok || !cuerpo?.access_token || !cuerpo?.refresh_token) throw errorDe(respuesta.status || 502, cuerpo, texto);
  return cuerpo as TokenML;
}

/**
 * Un access token vigente. El refresh token se gasta una sola vez: quien gana el
 * candado (`refrescando_hasta`) refresca; los demas esperan a que el suyo
 * aparezca. `descartar` es el token (cifrado) que ML acaba de rechazar con 401.
 */
async function tokenValido(env: Env, descartar?: string): Promise<{ token: string; cifrado: string }> {
  for (let intento = 0; intento < 20; intento++) {
    const cuenta = await leerCuenta(env);
    if (!conectada(cuenta)) throw errorLocal(409, 'no_conectado', 'Mercado Libre no está conectado. Conéctalo desde la pantalla de Mercado Libre.');
    const ahora = Date.now();
    if (cuenta.expira_en && Date.parse(cuenta.expira_en) - ahora > MARGEN_TOKEN_MS && cuenta.access_token_cifrado !== descartar) {
      return { token: await descifrar(env, cuenta.access_token_cifrado), cifrado: cuenta.access_token_cifrado };
    }
    const { meta } = await env.DB.prepare(
      `update ml_cuenta set refrescando_hasta = ?
       where id = 1 and refresh_token_cifrado = ? and (refrescando_hasta = '' or refrescando_hasta < ?)`,
    )
      .bind(new Date(ahora + CANDADO_MS).toISOString(), cuenta.refresh_token_cifrado, new Date(ahora).toISOString())
      .run();
    if (meta.changes) {
      try {
        const nuevo = await pedirToken(env, { grant_type: 'refresh_token', refresh_token: await descifrar(env, cuenta.refresh_token_cifrado) });
        await guardarTokens(env, nuevo);
        return { token: nuevo.access_token, cifrado: (await leerCuenta(env))!.access_token_cifrado };
      } catch (error) {
        if (error instanceof ErrorML && error.codigo === 'invalid_grant') {
          await desconectar(env);
          throw errorLocal(409, 'no_conectado', 'La sesión de Mercado Libre venció. Vuelve a conectarla.');
        }
        await env.DB.prepare(`update ml_cuenta set refrescando_hasta = '' where id = 1`).run();
        throw error;
      }
    }
    await dormir(250);   // otra peticion esta refrescando: se espera su token
  }
  throw errorLocal(503, 'refresco_ocupado', 'Mercado Libre está renovando la sesión. Intenta de nuevo.');
}

/**
 * Llama a la API de ML con el token de la cuenta conectada (lo renueva si esta
 * por vencer, y una vez mas si ML lo rechaza). Devuelve el JSON, o lanza ErrorML.
 */
export async function mlFetch(env: Env, ruta: string, init: RequestInit & { json?: unknown } = {}): Promise<any> {
  let descartar: string | undefined;
  for (let vez = 0; vez < 2; vez++) {
    const { token, cifrado } = await tokenValido(env, descartar);
    const cabeceras = new Headers(init.headers);
    cabeceras.set('authorization', `Bearer ${token}`);
    cabeceras.set('accept', 'application/json');
    let cuerpoPedido = init.body;
    if (init.json !== undefined) {
      cuerpoPedido = JSON.stringify(init.json);
      cabeceras.set('content-type', 'application/json');
    }
    const { json: _json, ...resto } = init;
    const respuesta = await fetch(`${API}${ruta}`, { ...resto, body: cuerpoPedido, headers: cabeceras });
    const texto = await respuesta.text();
    let cuerpo: any = null;
    try { cuerpo = texto ? JSON.parse(texto) : null; } catch { /* no era JSON */ }
    if (respuesta.status === 401 && vez === 0) {
      descartar = cifrado;
      continue;
    }
    if (!respuesta.ok) throw errorDe(respuesta.status, cuerpo, texto);
    return cuerpo;
  }
  throw errorLocal(401, 'no_autorizado', 'Mercado Libre rechazó la sesión.');
}

/**
 * Para consultas que ML tambien atiende sin sesion (categorias y sus atributos).
 * Con el token de esta app algunas responden 403 aunque sin token si contesten
 * (#186): en ese caso se reintenta sin token. Cualquier otro error se lanza.
 */
async function mlPublico(env: Env, ruta: string): Promise<any> {
  try {
    return await mlFetch(env, ruta);
  } catch (error) {
    if (!(error instanceof ErrorML) || error.local || error.status !== 403) throw error;
    const respuesta = await fetch(`${API}${ruta}`, { headers: { accept: 'application/json' } });
    const texto = await respuesta.text();
    let cuerpo: any = null;
    try { cuerpo = texto ? JSON.parse(texto) : null; } catch { /* no era JSON */ }
    if (!respuesta.ok) throw errorDe(respuesta.status, cuerpo, texto);
    return cuerpo;
  }
}

/** Quien es el vendedor y si publica con el modelo de User Products (family_name). */
async function perfilML(env: Env): Promise<{ id: string; nickname: string; usaFamilyName: boolean }> {
  const yo = await mlFetch(env, '/users/me');
  const tags: string[] = Array.isArray(yo?.tags) ? yo.tags.map(String) : [];
  const id = String(yo?.id ?? '');
  await env.DB.prepare(
    `update ml_cuenta set nickname = ?, tags = ?, ml_user_id = case when ? <> '' then ? else ml_user_id end where id = 1`,
  ).bind(String(yo?.nickname ?? ''), JSON.stringify(tags), id, id).run();
  return { id, nickname: String(yo?.nickname ?? ''), usaFamilyName: tags.includes('user_product_seller') };
}

/* ---------- piezas ---------- */

interface Pieza {
  id: string; codigo: string | null; nombre: string; categoria: string; marca: string; precio: number;
  estado_fisico: string; stock: number; destino: string; sin_inventario: number; estado_analisis: string; foto_key: string;
  talla: string | null;
}

const productoDe = (p: Pieza) => ({
  id: p.id, codigo: p.codigo, nombre: p.nombre, categoria: p.categoria, marca: p.marca,
  precio: p.precio, estado_fisico: p.estado_fisico, stock: p.stock, talla: p.talla?.trim() || null,
});

// Lo que se puede publicar: pieza individual, revisada, con foto y existencias; nunca bandas ni danadas.
export const PUBLICABLE = `p.destino = 'etiqueta' and p.sin_inventario = 0 and p.estado_analisis = 'listo' and p.stock > 0
  and p.foto_key <> '' and p.codigo like 'ED-%' and p.estado_fisico <> 'danado'`;

async function piezaPublicable(env: Env, id: string): Promise<{ ok: true; pieza: Pieza } | { ok: false; status: number; error: string }> {
  if (!ID_PIEZA.test(id)) return { ok: false, status: 404, error: 'La pieza no existe.' };
  const p = await env.DB.prepare(
    `select id, codigo, nombre, categoria, marca, precio, estado_fisico, stock, destino, sin_inventario, estado_analisis, foto_key, talla
     from productos where id = ?`,
  ).bind(id).first<Pieza>();
  if (!p) return { ok: false, status: 404, error: 'La pieza no existe.' };
  const no = (error: string) => ({ ok: false as const, status: 409, error });
  if (p.sin_inventario || p.destino !== 'etiqueta' || !/^ED-/.test(p.codigo ?? '')) {
    return no('Solo se publican piezas individuales con etiqueta ED-; las bandas no.');
  }
  if (p.estado_fisico === 'danado') return no('Mercado Libre no tiene la condición «dañado»: esta pieza no se puede publicar.');
  if (p.estado_analisis !== 'listo') return no('Primero revisa la pieza en el admin.');
  if (!p.foto_key) return no('La pieza no tiene foto.');
  if (p.stock <= 0) return no('La pieza no tiene existencias.');
  return { ok: true, pieza: p };
}

/** precio de tienda + ml_pct %, quebrado a X9 como el de la tienda, nunca menos de $35. */
export function precioML(precio: number, pct: number): number {
  return Math.max(PRECIO_MINIMO, quebrarDecena(Math.round((precio * (100 + pct)) / 100)));
}

/** Titulo para ML: sin signos de puntuacion, con la marca, de 60 caracteres como mucho. */
export function tituloML(nombre: string, marca: string): string {
  const base = marca && !nombre.toLowerCase().includes(marca.toLowerCase()) ? `${marca} ${nombre}` : nombre;
  const limpio = base.replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  if (limpio.length <= 60) return limpio;
  const corte = limpio.slice(0, 60);
  return (corte.includes(' ') && limpio[60] !== ' ' ? corte.slice(0, corte.lastIndexOf(' ')) : corte).trim();
}

/** Ancho y alto de un JPEG, o null si no se alcanza a leer. */
export function dimensionesJpeg(b: Uint8Array): { ancho: number; alto: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marca = b[i + 1];
    if (marca === 0xff) { i++; continue; }
    if (marca >= 0xc0 && marca <= 0xcf && marca !== 0xc4 && marca !== 0xc8 && marca !== 0xcc) {
      return { alto: (b[i + 5] << 8) | b[i + 6], ancho: (b[i + 7] << 8) | b[i + 8] };
    }
    i += marca === 0x01 || (marca >= 0xd0 && marca <= 0xd9) ? 2 : 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

interface FilaPublicacion {
  producto_id: string; ml_item_id: string | null; estado: string; precio_ml: number; categoria_id: string;
  permalink: string; ultimo_error: string; publicado_en: string; actualizado_en: string;
}

const leerPublicacion = (env: Env, productoId: string) => env.DB.prepare(
  `select producto_id, ml_item_id, estado, precio_ml, categoria_id, permalink, ultimo_error, publicado_en, actualizado_en
   from ml_publicaciones where producto_id = ?`,
).bind(productoId).first<FilaPublicacion>();

/* ---------- estado, config y conexion ---------- */

async function estado(env: Env): Promise<Response> {
  const cuenta = await leerCuenta(env);
  const tags: string[] = (() => { try { return JSON.parse(cuenta?.tags ?? '[]'); } catch { return []; } })();
  const sesion = conectada(cuenta);
  return json({
    conectado: sesion,
    usuario: sesion ? { id: cuenta.ml_user_id, nickname: cuenta.nickname } : null,
    user_product_seller: tags.includes('user_product_seller'),
    config: await config(env),
    faltan: faltantes(env),
    // Para avisar al dueno: que empacar y que cancelar en ML.
    ventas_sin_despachar: (await env.DB.prepare(
      `select count(*) as n from ml_ventas where estado = 'descontada' and recibido_en >= ?`,
    ).bind(new Date(Date.now() - 7 * 86_400_000).toISOString()).first<{ n: number }>())?.n ?? 0,
    conflictos: await contarConflictos(env),
  });
}

const contarConflictos = async (env: Env) => (await env.DB.prepare(
  `select count(*) as n from ml_ventas where conflicto = 1 and estado <> 'cancelada'`,
).first<{ n: number }>())?.n ?? 0;

/** Las ventas hechas en ML, las mas nuevas primero. `conflicto` = se vendio algo que en tienda ya no habia. */
async function listarVentas(env: Env, url: URL): Promise<Response> {
  const pagina = Math.max(1, Math.floor(Number(url.searchParams.get('pagina') ?? 1)) || 1);
  const { results } = await env.DB.prepare(
    `select v.order_id, v.ml_item_id, v.cantidad, v.descontado, v.estado, v.conflicto, v.recibido_en,
            v.producto_id, p.codigo, p.nombre, p.marca, p.precio, m.permalink
     from ml_ventas v left join productos p on p.id = v.producto_id left join ml_publicaciones m on m.producto_id = v.producto_id
     order by v.recibido_en desc, v.order_id desc, v.ml_item_id
     limit 51 offset ?`,
  ).bind((pagina - 1) * 50).all<Record<string, any>>();
  return json({
    ventas: results.slice(0, 50).map((f) => ({
      order_id: f.order_id, ml_item_id: f.ml_item_id,
      producto: { id: f.producto_id, codigo: f.codigo ?? null, nombre: f.nombre ?? '', marca: f.marca ?? '', precio: f.precio ?? 0 },
      cantidad: f.cantidad, descontado: f.descontado, estado: f.estado, conflicto: f.conflicto,
      recibido_en: f.recibido_en, permalink: f.permalink ?? '',
    })),
    pendientes_conflicto: await contarConflictos(env),
    hay_mas: results.length > 50,
  });
}

async function guardarConfig(request: Request, env: Env): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as { ml_pct?: unknown; ml_tipo_publicacion?: unknown };
  const cambios: [string, string][] = [];
  if (cuerpo.ml_pct !== undefined) {
    const pct = Number(cuerpo.ml_pct);
    if (!Number.isInteger(pct) || pct < 0 || pct > 300) return json({ error: 'El porcentaje debe ser un entero entre 0 y 300.' }, 400);
    cambios.push(['ml_pct', String(pct)]);
  }
  if (cuerpo.ml_tipo_publicacion !== undefined) {
    if (!TIPOS_PUBLICACION.includes(String(cuerpo.ml_tipo_publicacion))) {
      return json({ error: `Tipo de publicación inválido (${TIPOS_PUBLICACION.join(', ')}).` }, 400);
    }
    cambios.push(['ml_tipo_publicacion', String(cuerpo.ml_tipo_publicacion)]);
  }
  if (cambios.length === 0) return json({ error: 'Nada que guardar.' }, 400);
  await env.DB.batch(cambios.map(([clave, valor]) => env.DB.prepare(
    `insert into config (clave, valor) values (?, ?) on conflict (clave) do update set valor = excluded.valor`,
  ).bind(clave, valor)));
  return json(await config(env));
}

/** Manda al dueno a autorizar la app en Mercado Libre. State de un solo uso + PKCE (ML_PKCE=no lo apaga). */
async function conectar(env: Env, url: URL): Promise<Response> {
  const volver = (motivo: string) => Response.redirect(`${url.origin}/mercadolibre?error=${motivo}`, 302);
  if (faltantes(env).length) return volver('falta_configuracion');
  const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const usaPkce = env.ML_PKCE !== 'no';
  const verificador = usaPkce ? aBase64Url(crypto.getRandomValues(new Uint8Array(32))) : '';
  await env.DB.batch([
    env.DB.prepare('delete from ml_oauth_estados where creado_en < ?').bind(new Date(Date.now() - OAUTH_VIGENCIA_MS).toISOString()),
    env.DB.prepare('insert into ml_oauth_estados (state, verificador, creado_en) values (?, ?, ?)').bind(state, verificador, new Date().toISOString()),
  ]);
  const destino = new URL(AUTORIZACION);
  destino.searchParams.set('response_type', 'code');
  destino.searchParams.set('client_id', env.ML_CLIENT_ID!);
  destino.searchParams.set('redirect_uri', env.ML_REDIRECT_URI!);
  destino.searchParams.set('state', state);
  if (usaPkce) {
    const reto = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verificador)));
    destino.searchParams.set('code_challenge', aBase64Url(reto));
    destino.searchParams.set('code_challenge_method', 'S256');
  }
  return Response.redirect(destino.toString(), 302);
}

/** ML devuelve al dueno aqui con ?code&state. Siempre termina en /mercadolibre?conectado=1 o ?error=... */
async function retorno(env: Env, url: URL): Promise<Response> {
  const volver = (consulta: string) => Response.redirect(`${url.origin}/mercadolibre?${consulta}`, 302);
  const rechazo = url.searchParams.get('error');
  if (rechazo) return volver(`error=${encodeURIComponent(rechazo)}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return volver('error=sin_codigo');
  const fila = await env.DB.prepare('delete from ml_oauth_estados where state = ? and creado_en > ? returning verificador')
    .bind(state, new Date(Date.now() - OAUTH_VIGENCIA_MS).toISOString())
    .first<{ verificador: string }>();
  if (!fila) return volver('error=estado_invalido');
  try {
    const token = await pedirToken(env, {
      grant_type: 'authorization_code', code, redirect_uri: env.ML_REDIRECT_URI ?? '',
      ...(fila.verificador ? { code_verifier: fila.verificador } : {}),
    });
    await guardarTokens(env, token);
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'intercambio de codigo con ML', error: String(error) }));
    return volver(`error=${encodeURIComponent(error instanceof ErrorML && error.codigo ? error.codigo : 'intercambio_fallido')}`);
  }
  await perfilML(env).catch(() => undefined);   // apodo y tags: si falla, se piden en la siguiente publicacion
  return volver('conectado=1');
}

/* ---------- lista de piezas ---------- */

async function listarPiezas(env: Env, url: URL): Promise<Response> {
  const filtro = url.searchParams.get('filtro') ?? 'pendientes';
  const pagina = Math.max(1, Math.floor(Number(url.searchParams.get('pagina') ?? 1)) || 1);
  const donde = filtro === 'publicadas'
    ? 'm.ml_item_id is not null'
    : filtro === 'todas'
      ? `(${PUBLICABLE} or m.producto_id is not null)`
      // Pendientes: publicables sin publicacion (o con una que fallo/cerro, para reintentar).
      : `${PUBLICABLE} and (m.producto_id is null or (m.estado = 'error' and m.ml_item_id is null) or m.estado = 'cerrada')`;
  const { results } = await env.DB.prepare(
    `select p.id, p.codigo, p.nombre, p.categoria, p.marca, p.precio, p.estado_fisico, p.stock,
            m.producto_id as m_id, m.ml_item_id, m.estado, m.precio_ml, m.permalink, m.ultimo_error, m.actualizado_en
     from productos p left join ml_publicaciones m on m.producto_id = p.id
     where ${donde}
     order by coalesce(m.actualizado_en, p.creado_en) desc, p.id
     limit 51 offset ?`,
  ).bind((pagina - 1) * 50).all<Record<string, any>>();
  return json({
    piezas: results.slice(0, 50).map((f) => ({
      producto: {
        id: f.id, codigo: f.codigo, nombre: f.nombre, categoria: f.categoria, marca: f.marca,
        precio: f.precio, estado_fisico: f.estado_fisico, stock: f.stock,
      },
      publicacion: f.m_id === null ? null : {
        ml_item_id: f.ml_item_id, estado: f.estado, precio_ml: f.precio_ml, permalink: f.permalink,
        ultimo_error: f.ultimo_error, actualizado_en: f.actualizado_en,
      },
    })),
    hay_mas: results.length > 50,
  });
}

/* ---------- preparar la publicacion ---------- */

interface Sugerencia { categoria_id: string; categoria_nombre: string; dominio: string }

// Los pone el sistema (o la guia de tallas), no el dueno.
const ATRIBUTOS_PROPIOS = new Set(['ITEM_CONDITION', 'SIZE_GRID_ID', 'SIZE_GRID_ROW_ID']);

function atributosPedidos(attrs: any[], marca: string, talla: string) {
  const ids = new Set(attrs.map((a) => a.id));
  const clave = (a: any) => a.tags?.required || a.tags?.catalog_required || a.tags?.conditional_required;
  return attrs
    .filter((a) => !ATRIBUTOS_PROPIOS.has(a.id) && !a.tags?.read_only && !a.tags?.hidden && !a.tags?.fixed && clave(a))
    .map((a) => {
      const valores = (Array.isArray(a.values) ? a.values : []).map((v: any) => ({ id: String(v.id), nombre: String(v.name) }));
      let sugerido: { id: string | null; nombre: string } | null = null;
      if (a.id === 'BRAND' && marca) {
        const igual = valores.find((v: { nombre: string }) => v.nombre.toLowerCase() === marca.toLowerCase());
        sugerido = { id: igual?.id ?? null, nombre: igual?.nombre ?? marca };
      } else if (a.id === 'EMPTY_GTIN_REASON') {
        const sinCodigo = valores.find((v: { id: string }) => v.id === '17055160');
        if (sinCodigo) sugerido = sinCodigo;   // «El producto no tiene código registrado»
      } else if (a.id === 'SIZE' && talla) {
        // Talla de niño «Niño 6 años / S» -> «6 años»; la de adulto va tal cual.
        const valor = talla.replace(/^Niño /, '').split(' / ')[0];
        const igual = valores.find((v: { nombre: string }) => v.nombre.toLowerCase() === valor.toLowerCase());
        sugerido = { id: igual?.id ?? null, nombre: igual?.nombre ?? valor };
      }
      return {
        id: String(a.id), nombre: String(a.name ?? a.id), tipo: String(a.value_type ?? 'string'),
        // Con razon de GTIN vacio, el GTIN deja de ser obligatorio.
        requerido: !(a.id === 'GTIN' && ids.has('EMPTY_GTIN_REASON')),
        valores, valor_sugerido: sugerido,
      };
    })
    .sort((a, b) => Number(b.requerido) - Number(a.requerido));
}

// ponytail: el endpoint de busqueda de guias del vendedor NO esta confirmado en la doc
// (docs/MERCADOLIBRE-API.md, seccion 3); si falla, se avisa y el dueno la elige en ML.
async function guiasDelVendedor(env: Env, vendedor: string, dominio: string): Promise<{ guias: any[]; aviso?: string }> {
  try {
    const r = await mlFetch(env, '/catalog/charts/search', {
      method: 'POST',
      json: { site_id: 'MLM', seller_id: Number(vendedor), ...(dominio ? { domain_id: dominio } : {}) },
    });
    const lista: any[] = Array.isArray(r) ? r : r?.charts ?? r?.results ?? [];
    const talla = (fila: any) => String(
      fila.attributes?.find((a: any) => a.id === 'SIZE')?.values?.[0]?.name ?? fila.attributes?.[0]?.values?.[0]?.name ?? '',
    );
    return {
      guias: lista.map((g) => ({
        id: String(g.id), nombre: String(g.names?.MLM ?? g.name ?? g.id),
        filas: (Array.isArray(g.rows) ? g.rows : []).map((f: any) => ({ id: String(f.id), talla: talla(f) })),
      })),
    };
  } catch (error) {
    return { guias: [], aviso: `No se pudieron leer tus guías de tallas (${error instanceof ErrorML ? error.detalle : String(error)}). Créalas en Mercado Libre.` };
  }
}

/* ---------- catalogo (Issue #192) ---------- */

interface CandidatoCatalogo { id: string; nombre: string; foto: string; marca: string; catalogo_obligatorio: boolean }

/**
 * Productos del catalogo de ML que se parecen a la pieza: traen fotos y datos
 * oficiales. Solo lectura. Si ML lo niega, el motivo va en `error`.
 */
const candidatoDe = (x: any): CandidatoCatalogo => ({
  id: String(x.id), nombre: String(x.name ?? x.id),
  foto: String(x.pictures?.[0]?.secure_url ?? x.pictures?.[0]?.url ?? ''),
  marca: String((Array.isArray(x.attributes) ? x.attributes : []).find((a: any) => a.id === 'BRAND')?.value_name ?? ''),
  catalogo_obligatorio: x.settings?.listing_strategy === 'catalog_required',
});

/** Id de producto de catalogo en un texto: `MLM123` solo, o un enlace con `/p/MLM123`. */
export function idProductoML(texto: string): string {
  const t = texto.trim();
  const id = /^MLM\d+$/i.test(t) ? t : /\/p\/(MLM\d+)(?:[/?#]|$)/i.exec(t)?.[1] ?? '';
  return id.toUpperCase();
}

/**
 * Productos del catalogo de ML para la pieza: por texto, o uno solo si el texto
 * es su id o el enlace de su pagina (/p/MLM...). Solo lectura. Si ML lo niega,
 * el motivo va en `error`.
 */
async function candidatosCatalogo(env: Env, texto: string): Promise<{ candidatos: CandidatoCatalogo[]; consulta: string; error?: string }> {
  const id = idProductoML(texto);
  try {
    if (id) {
      const producto = await mlPublico(env, `/products/${id}`);
      if (producto?.status !== 'active') return { candidatos: [], consulta: texto, error: `El producto ${id} no está activo en el catálogo de Mercado Libre.` };
      return { candidatos: [candidatoDe(producto)], consulta: texto };
    }
    if (/mercadolibre\.com\.mx\/MLM-?\d+/i.test(texto)) {
      return { candidatos: [], consulta: texto, error: 'Ese enlace es de una publicación, no de un producto del catálogo: abre el producto y copia el enlace que tiene /p/MLM…' };
    }
    const r = await mlPublico(env, `/products/search?status=active&site_id=MLM&q=${encodeURIComponent(texto)}&limit=5`);
    const lista: any[] = Array.isArray(r?.results) ? r.results : [];
    return { candidatos: lista.slice(0, 5).map(candidatoDe), consulta: texto };
  } catch (error) {
    return { candidatos: [], consulta: texto, error: `Mercado Libre no dejó buscar en su catálogo (${error instanceof ErrorML ? `${error.status} ${error.detalle}` : String(error)}).` };
  }
}

/** Si la categoria pertenece al dominio de catalogo del producto (GET /categories/:id es publico). */
async function categoriaEnDominio(env: Env, categoriaId: string, dominio: string): Promise<boolean> {
  const c = await mlPublico(env, `/categories/${categoriaId}`).catch(() => null);
  const enCategoria = String(c?.settings?.catalog_domain ?? '');
  return !!enCategoria && enCategoria === dominio;
}

/**
 * Si ML todavia puede vender la pieza: tiene articulo (activa, pausada, vendida o con
 * error, que se reactivan solas) o se esta publicando ahora. `cerrada` y el error sin
 * articulo no cuentan. Borrar o fusionar la pieza antes la dejaria huerfana: la
 * conciliacion une con `productos` y ya no la veria.
 */
export async function publicacionViva(env: Env, productoId: string): Promise<boolean> {
  const fila = await env.DB.prepare(
    `select 1 as x from ml_publicaciones where producto_id = ? and estado <> 'cerrada'
       and (ml_item_id is not null or (estado = 'publicando' and actualizado_en >= ?))`,
  ).bind(productoId, new Date(Date.now() - 120_000).toISOString()).first();
  return !!fila;
}

async function yaPublicada(env: Env, id: string): Promise<boolean> {
  const previa = await leerPublicacion(env, id);
  return !!previa && !(previa.estado === 'cerrada' || (previa.estado === 'error' && !previa.ml_item_id));
}

async function preparar(env: Env, id: string, request: Request): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as { categoria_id?: unknown; consulta?: unknown; consulta_catalogo?: unknown } | null;
  const elegida = cuerpo?.categoria_id === undefined || cuerpo.categoria_id === '' ? '' : String(cuerpo.categoria_id);
  // Texto para pedir categorias; sin el, el nombre de la pieza.
  const buscada = typeof cuerpo?.consulta === 'string' ? cuerpo.consulta.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
  // Texto (o enlace/id del producto) para el catalogo; sin el, el mismo de categorias.
  const enCatalogo = typeof cuerpo?.consulta_catalogo === 'string' ? cuerpo.consulta_catalogo.trim().replace(/\s+/g, ' ').slice(0, 300) : '';
  if (elegida && !/^MLM\d+$/.test(elegida)) return json({ error: 'Categoría inválida.' }, 400);

  const hallada = await piezaPublicable(env, id);
  if (!hallada.ok) return json({ error: hallada.error }, hallada.status);
  const p = hallada.pieza;
  if (await yaPublicada(env, id)) return json({ error: 'Esta pieza ya está publicada en Mercado Libre.' }, 409);

  try {
    const perfil = await perfilML(env);
    const { ml_pct, ml_tipo_publicacion } = await config(env);
    const avisos: string[] = [];

    const consulta = buscada || tituloML(p.nombre, p.marca) || p.nombre;
    let encontradas: any[] = [];
    try {
      encontradas = await mlPublico(env, `/sites/MLM/domain_discovery/search?q=${encodeURIComponent(consulta)}&limit=4`);
    } catch (error) {
      avisos.push(`No se pudieron pedir categorías a Mercado Libre (${error instanceof ErrorML ? error.detalle : String(error)}).`);
    }
    const sugerencias: Sugerencia[] = (Array.isArray(encontradas) ? encontradas : []).map((s) => ({
      categoria_id: String(s.category_id), categoria_nombre: String(s.category_name ?? ''), dominio: String(s.domain_id ?? ''),
    }));
    const categoria = elegida
      ? sugerencias.find((s) => s.categoria_id === elegida) ?? { categoria_id: elegida, categoria_nombre: '', dominio: '' }
      : sugerencias[0];
    if (!categoria) avisos.push('Mercado Libre no sugirió ninguna categoría; búscala con otras palabras en «Buscar categoría».');

    const attrs: any[] = categoria ? await mlPublico(env, `/categories/${categoria.categoria_id}/attributes`) : [];
    const exigeGuia = attrs.some((a) => (a.id === 'SIZE_GRID_ID' && a.tags?.required) || a.tags?.grid_template_required);
    let guia: { requerida: boolean; guias: any[] } | null = null;
    if (exigeGuia) {
      const { guias, aviso } = await guiasDelVendedor(env, perfil.id, categoria!.dominio.replace(/^MLM-/, ''));
      guia = { requerida: true, guias };
      if (aviso) avisos.push(aviso);
      else if (guias.length === 0) avisos.push('Esta categoría exige guía de tallas y no tienes ninguna: créala en Mercado Libre antes de publicar.');
    }

    // Lo que no es ropa puede ir al catalogo con fotos oficiales; la ropa, con fotos propias.
    const catalogo = p.categoria !== 'ropa' ? await candidatosCatalogo(env, enCatalogo || consulta) : null;

    const precio = precioML(p.precio, ml_pct);
    if (p.precio > 0 && Math.round((p.precio * (100 + ml_pct)) / 100) < PRECIO_MINIMO) {
      avisos.push('El precio queda por debajo del mínimo de Mercado Libre ($35); se subió a $35.');
    }
    if (!p.marca.trim()) avisos.push('La pieza no tiene marca: casi todas las categorías de ropa la piden.');
    else if (MARCAS_RESTRINGIDAS.includes(p.marca.trim().toLowerCase())) {
      avisos.push(`${p.marca} es una marca restringida en México: solo la venden tiendas oficiales o vendedores acreditados; Mercado Libre puede rechazar o dar de baja la publicación.`);
    }
    const foto = await env.FOTOS.get(p.foto_key);
    const medidas = foto ? dimensionesJpeg(new Uint8Array(await foto.arrayBuffer())) : null;
    if (medidas && (medidas.ancho < 500 || medidas.alto < 500)) {
      avisos.push(`La foto mide ${medidas.ancho} x ${medidas.alto} px; Mercado Libre pide mínimo 500 x 500.`);
    }

    return json({
      producto: productoDe(p),
      propuesta: {
        titulo: tituloML(p.nombre, p.marca),
        usa_family_name: perfil.usaFamilyName,
        categoria_id: categoria?.categoria_id ?? null,
        categoria_nombre: categoria?.categoria_nombre ?? null,
        dominio: categoria?.dominio ?? null,
        sugerencias,
        consulta,
        catalogo,
        precio_ml: precio,
        tipo_publicacion: ml_tipo_publicacion,
        atributos: atributosPedidos(attrs, p.marca.trim(), p.talla?.trim() ?? ''),
        guia_tallas: guia,
        avisos,
      },
    });
  } catch (error) {
    return respuestaError(error, 'No se pudo preparar la publicación.');
  }
}

/* ---------- publicar, pausar, reactivar ---------- */

const sinEmojis = (texto: string) => texto.replace(/[<>]/g, '').replace(/[\p{Extended_Pictographic}️]/gu, '');

async function publicar(env: Env, id: string, request: Request): Promise<Response> {
  const cuerpo = (await request.json().catch(() => null)) as Record<string, any> | null;
  const titulo = String(cuerpo?.titulo ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const categoriaId = String(cuerpo?.categoria_id ?? '');
  const precio = Number(cuerpo?.precio_ml);
  if (!titulo) return json({ error: 'Falta el título.' }, 400);
  if (!/^MLM\d+$/.test(categoriaId)) return json({ error: 'Categoría inválida.' }, 400);
  if (!Number.isInteger(precio) || precio < PRECIO_MINIMO || precio > 10_000_000) {
    return json({ error: 'El precio debe ser de al menos $35 (en centavos, entero).' }, 400);
  }
  const pedidos: any[] = Array.isArray(cuerpo?.atributos) ? cuerpo!.atributos : [];
  const atributos = pedidos
    .filter((a) => a && /^[A-Z0-9_]{2,40}$/.test(String(a.id)) && !ATRIBUTOS_PROPIOS.has(String(a.id)))
    .map((a) => ({
      id: String(a.id),
      ...(a.value_id ? { value_id: String(a.value_id) } : {}),
      ...(a.value_name !== undefined && a.value_name !== null ? { value_name: String(a.value_name).slice(0, 255) } : {}),
    }))
    .filter((a) => a.value_id || a.value_name)
    .slice(0, 60);
  const fila = cuerpo?.guia_fila_id === undefined || cuerpo.guia_fila_id === null ? '' : String(cuerpo.guia_fila_id);
  if (fila && !/^[\w-]+:[\w-]+$/.test(fila)) return json({ error: 'Fila de la guía de tallas inválida.' }, 400);
  // #192: con producto de catalogo, ML pone fotos y ficha tecnica oficiales.
  const catalogoId = cuerpo?.catalogo_id ? String(cuerpo.catalogo_id) : '';
  if (catalogoId && !/^MLM\d+$/.test(catalogoId)) return json({ error: 'Producto de catálogo inválido.' }, 400);

  const hallada = await piezaPublicable(env, id);
  if (!hallada.ok) return json({ error: hallada.error }, hallada.status);
  const p = hallada.pieza;

  // Reclamar la pieza: dos clics no publican dos veces. Un intento que se quedo a
  // medias (publicando hace mas de 2 min) y uno sin articulo en ML pueden repetirse.
  const ahora = new Date().toISOString();
  const { meta } = await env.DB.prepare(
    `insert into ml_publicaciones (producto_id, estado, actualizado_en) values (?, 'publicando', ?)
     on conflict (producto_id) do update set estado = 'publicando', ml_item_id = null, ultimo_error = '', actualizado_en = excluded.actualizado_en
     where (ml_publicaciones.estado = 'error' and ml_publicaciones.ml_item_id is null)
        or ml_publicaciones.estado = 'cerrada'
        or (ml_publicaciones.estado = 'publicando' and ml_publicaciones.actualizado_en < ?)`,
  ).bind(id, ahora, new Date(Date.now() - 120_000).toISOString()).run();
  if (!meta.changes) return json({ error: 'Esta pieza ya está publicada (o se está publicando).' }, 409);

  let itemId = '';
  try {
    const perfil = await perfilML(env);
    const { ml_tipo_publicacion } = await config(env);
    let categoria = categoriaId;
    let pictures: { id: string }[] = [];
    if (catalogoId) {
      // La busqueda ya lo mostro; aqui se confirma que sigue activo y se toma una
      // categoria de su dominio (ML rechaza con 417 si no coinciden).
      const producto = await mlPublico(env, `/products/${catalogoId}`);
      if (producto?.status !== 'active') throw errorLocal(409, 'catalogo_inactivo', 'Ese producto del catálogo ya no está activo en Mercado Libre.');
      const dominio = String(producto?.domain_id ?? '');
      if (dominio && !(await categoriaEnDominio(env, categoria, dominio))) {
        const halladas: any[] = await mlPublico(env, `/sites/MLM/domain_discovery/search?q=${encodeURIComponent(String(producto?.name ?? titulo))}&limit=8`).catch(() => []);
        const delDominio = (Array.isArray(halladas) ? halladas : []).find((s) => s.domain_id === dominio);
        if (delDominio) categoria = String(delDominio.category_id);
      }
    } else {
      const foto = await env.FOTOS.get(p.foto_key);
      if (!foto) throw errorLocal(409, 'sin_foto', 'La foto de la pieza no está en el almacén.');
      const formulario = new FormData();
      formulario.append('file', new Blob([await foto.arrayBuffer()], { type: 'image/jpeg' }), 'pieza.jpg');
      const subida = await mlFetch(env, '/pictures/items/upload', { method: 'POST', body: formulario });
      pictures = [{ id: String(subida?.id) }];
    }

    const attrsCategoria: any[] = await mlPublico(env, `/categories/${categoria}/attributes`).catch(() => []);
    const propios = [
      // `condition` esta por desaparecer a favor de este atributo; se mandan los dos.
      ...(attrsCategoria.some((a) => a.id === 'ITEM_CONDITION') ? [{ id: 'ITEM_CONDITION', value_id: '2230284' }] : []),
      ...(fila ? [{ id: 'SIZE_GRID_ID', value_name: fila.split(':')[0] }, { id: 'SIZE_GRID_ROW_ID', value_name: fila }] : []),
    ];
    const creado = await mlFetch(env, '/items', {
      method: 'POST',
      json: {
        ...(perfil.usaFamilyName ? { family_name: titulo } : { title: titulo }),
        category_id: categoria,
        price: precio / 100,
        currency_id: 'MXN',
        available_quantity: p.stock,
        buying_mode: 'buy_it_now',
        condition: 'new',
        listing_type_id: ml_tipo_publicacion,
        pictures,
        // En catalogo la ficha tecnica es la del producto: solo va la condicion.
        attributes: catalogoId ? propios : [...atributos, ...propios],
        shipping: { mode: 'me2', local_pick_up: false, free_shipping: false },
        ...(catalogoId ? { catalog_product_id: catalogoId, catalog_listing: true } : {}),
      },
    });
    itemId = String(creado?.id ?? '');
    if (!itemId) throw errorLocal(502, 'sin_id', 'Mercado Libre no devolvió el identificador del artículo.');

    // La descripcion va despues de crear el articulo; si falla, el articulo ya existe y se avisa.
    // En catalogo la pone ML.
    let ultimoError = '';
    if (!catalogoId) {
      const descripcion = sinEmojis(String(cuerpo?.descripcion ?? '')).trim()
        || [p.nombre, p.marca ? `Marca: ${p.marca}` : '', 'Condición: nuevo.'].filter(Boolean).join('\n');
      try {
        await mlFetch(env, `/items/${itemId}/description`, { method: 'POST', json: { plain_text: descripcion.slice(0, 50_000) } });
      } catch (error) {
        ultimoError = `Descripción: ${error instanceof ErrorML ? error.detalle : String(error)}`;
      }
    }

    const estadoML = String(creado?.status ?? 'active');
    const estado = estadoML === 'active' ? 'activa' : estadoML === 'paused' ? 'pausada' : estadoML === 'closed' ? 'cerrada' : 'error';
    if (estado === 'error') ultimoError = `Mercado Libre dejó el artículo en «${estadoML}» (${creado?.sub_status ?? ''}). Revísalo en su sitio.`;
    try {
      await env.DB.prepare(
        `update ml_publicaciones set ml_item_id = ?, estado = ?, precio_ml = ?, categoria_id = ?, permalink = ?,
                ultimo_error = ?, publicado_en = ?, actualizado_en = ? where producto_id = ?`,
      ).bind(itemId, estado, precio, categoria, String(creado?.permalink ?? ''), ultimoError, ahora, new Date().toISOString(), id).run();
    } catch (error) {
      // Sin su fila el articulo quedaria vivo y sin dueno: se cierra antes de fallar.
      await mlFetch(env, `/items/${itemId}`, { method: 'PUT', json: { status: 'closed' } }).catch(() => undefined);
      itemId = '';
      throw error;
    }
    // Si la tienda vendio la pieza mientras ML la creaba, la venta no la vio (aun no tenia
    // articulo que pausar): se concilia aqui para no dejarla activa con existencias de mas.
    await conciliarSeguro(env, { productoIds: [id] });
    return json({ publicacion: await leerPublicacion(env, id) }, 201);
  } catch (error) {
    if (!itemId) {
      const texto = error instanceof ErrorML ? error.detalle : String(error);
      await env.DB.prepare(`update ml_publicaciones set estado = 'error', ml_item_id = null, ultimo_error = ?, actualizado_en = ? where producto_id = ?`)
        .bind(texto.slice(0, 500), new Date().toISOString(), id).run();
    }
    return respuestaError(error, 'Mercado Libre rechazó la publicación.');
  }
}

async function cambiarEstado(env: Env, id: string, accion: 'pausar' | 'reactivar'): Promise<Response> {
  if (!ID_PIEZA.test(id)) return json({ error: 'La pieza no existe.' }, 404);
  const pub = await leerPublicacion(env, id);
  if (!pub?.ml_item_id) return json({ error: 'Esta pieza no está publicada en Mercado Libre.' }, 404);
  const pieza = await env.DB.prepare('select stock from productos where id = ?').bind(id).first<{ stock: number }>();
  const validos = accion === 'pausar' ? ['activa'] : ['pausada', 'pausada_por_venta', 'vendida'];
  if (!validos.includes(pub.estado)) return json({ error: `No se puede ${accion} una publicación en estado «${pub.estado}».` }, 409);
  if (accion === 'reactivar' && !((pieza?.stock ?? 0) > 0)) return json({ error: 'La pieza no tiene existencias.' }, 409);
  try {
    await mlFetch(env, `/items/${pub.ml_item_id}`, {
      method: 'PUT',
      json: accion === 'pausar' ? { status: 'paused' } : { status: 'active', available_quantity: pieza!.stock },
    });
  } catch (error) {
    return respuestaError(error, `Mercado Libre no dejó ${accion} la publicación.`);
  }
  await env.DB.prepare(`update ml_publicaciones set estado = ?, ultimo_error = '', actualizado_en = ? where producto_id = ?`)
    .bind(accion === 'pausar' ? 'pausada' : 'activa', new Date().toISOString(), id).run();
  return json({ publicacion: await leerPublicacion(env, id) });
}

/* ---------- existencias: D1 manda ---------- */

interface Filtro { productoIds?: string[]; itemIds?: string[] }

/**
 * Deja cada articulo de ML como D1 dice (D1 es el maestro): sin existencias se
 * pausa, con existencias se reactiva, y la cantidad se iguala. Tambien copia
 * hacia aqui lo que el dueno hizo a mano en ML (pausar, reactivar) y lo que ML
 * decidio (cerrar). Una pausa manual NO se reactiva sola.
 */
export async function conciliarPublicaciones(env: Env, filtro: Filtro = {}): Promise<void> {
  const unidos = (ids: string[]) => ids.map(() => '?').join(',');
  const condiciones = [`m.ml_item_id is not null`, `m.estado in ('activa', 'pausada', 'pausada_por_venta', 'vendida', 'error')`];
  const valores: string[] = [];
  if (filtro.productoIds) { condiciones.push(`m.producto_id in (${unidos(filtro.productoIds)})`); valores.push(...filtro.productoIds); }
  if (filtro.itemIds) { condiciones.push(`m.ml_item_id in (${unidos(filtro.itemIds)})`); valores.push(...filtro.itemIds); }
  if ((filtro.productoIds && !filtro.productoIds.length) || (filtro.itemIds && !filtro.itemIds.length)) return;
  const { results: filas } = await env.DB.prepare(
    `select m.producto_id, m.ml_item_id, m.estado, p.stock
     from ml_publicaciones m join productos p on p.id = m.producto_id where ${condiciones.join(' and ')}`,
  ).bind(...valores).all<{ producto_id: string; ml_item_id: string; estado: string; stock: number }>();
  if (filas.length === 0) return;   // nada publicado: ni siquiera se pide token

  const poner = (productoId: string, estado: string, error = '') => env.DB.prepare(
    `update ml_publicaciones set estado = ?, ultimo_error = ?, actualizado_en = ? where producto_id = ?`,
  ).bind(estado, error, new Date().toISOString(), productoId).run();

  for (let desde = 0; desde < filas.length; desde += 20) {
    const lote = filas.slice(desde, desde + 20);
    const respuesta = await mlFetch(env, `/items?ids=${lote.map((f) => f.ml_item_id).join(',')}&attributes=id,status,available_quantity`);
    const enML = new Map<string, { status: string; available_quantity: number }>();
    for (const r of Array.isArray(respuesta) ? respuesta : []) {
      const cuerpo = r?.body ?? r;
      if ((r?.code ?? 200) === 200 && cuerpo?.id) enML.set(String(cuerpo.id), cuerpo);
    }
    for (const f of lote) {
      const ml = enML.get(f.ml_item_id);
      if (!ml) continue;
      const poner_ml = (cambios: Record<string, unknown>) => mlFetch(env, `/items/${f.ml_item_id}`, { method: 'PUT', json: cambios });
      try {
        if (ml.status === 'closed') {
          if (f.estado !== 'vendida') await poner(f.producto_id, 'cerrada');
        } else if (f.stock <= 0) {
          if (f.estado === 'activa' || f.estado === 'error') {
            if (ml.status === 'active') await poner_ml({ status: 'paused' });
            await poner(f.producto_id, 'pausada_por_venta');
          }
        } else if (f.estado === 'pausada_por_venta' || f.estado === 'vendida') {
          await poner_ml({ status: 'active', available_quantity: f.stock });
          await poner(f.producto_id, 'activa');
        } else if (f.estado === 'activa') {
          if (ml.status === 'paused') await poner(f.producto_id, 'pausada');   // la pauso el dueno en ML
          // Solo baja: ML descuenta al crear la orden y D1 hasta que se paga, subirla ofreceria otra vez la pieza vendida.
          // Subir la cantidad tras un resurtido de varias piezas se hace a mano en ML.
          else if (ml.available_quantity > f.stock) await poner_ml({ available_quantity: f.stock });
        } else if ((f.estado === 'pausada' || f.estado === 'error') && ml.status === 'active') {
          await poner(f.producto_id, 'activa');                                // la reactivo el dueno en ML
        }
      } catch (error) {
        await env.DB.prepare('update ml_publicaciones set ultimo_error = ? where producto_id = ?')
          .bind((error instanceof ErrorML ? error.detalle : String(error)).slice(0, 500), f.producto_id).run();
      }
    }
  }
}

/** Para colgarla de ctx.waitUntil: nunca lanza. */
export async function conciliarSeguro(env: Env, filtro: Filtro = {}): Promise<void> {
  try { await conciliarPublicaciones(env, filtro); }
  catch (error) { console.error(JSON.stringify({ mensaje: 'conciliacion con ML', error: String(error) })); }
}

/**
 * Una orden de ML. `paid` descuenta en D1 (una sola vez por orden y articulo);
 * `cancelled` devuelve lo que se habia descontado. Lo demas no mueve existencias.
 * Devuelve los productos tocados.
 */
export async function procesarOrden(env: Env, orden: any): Promise<string[]> {
  const cuenta = await leerCuenta(env);
  if (!conectada(cuenta)) return [];
  const vendedor = String(orden?.seller?.id ?? '');
  if (vendedor && vendedor !== cuenta.ml_user_id) return [];
  const pagada = orden?.status === 'paid';
  if (!pagada && orden?.status !== 'cancelled') return [];
  const ordenId = String(orden?.id ?? '');
  if (!ordenId) return [];

  const tocados: string[] = [];
  for (const linea of Array.isArray(orden.order_items) ? orden.order_items : []) {
    const itemId = String(linea?.item?.id ?? '');
    const cantidad = Math.max(1, Math.floor(Number(linea?.quantity)) || 1);
    const pub = await env.DB.prepare('select producto_id from ml_publicaciones where ml_item_id = ?').bind(itemId).first<{ producto_id: string }>();
    if (!pub) continue;
    tocados.push(pub.producto_id);
    const ahora = new Date().toISOString();
    const llave = [ordenId, itemId];
    if (pagada) {
      await env.DB.prepare(
        `insert or ignore into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, recibido_en) values (?, ?, ?, ?, 'recibida', ?)`,
      ).bind(ordenId, itemId, pub.producto_id, cantidad, ahora).run();
      // Todo en un batch y con la guarda `estado = 'recibida'`: reprocesar la misma
      // orden (notificacion repetida, conciliacion) no descuenta dos veces, y un
      // proceso que murio a medias se termina solo al volver a verla.
      await env.DB.batch([
        env.DB.prepare(
          `update ml_ventas set
             conflicto = (select stock < ml_ventas.cantidad from productos where id = ml_ventas.producto_id),
             descontado = (select max(0, min(stock, ml_ventas.cantidad)) from productos where id = ml_ventas.producto_id)
           where order_id = ? and ml_item_id = ? and estado = 'recibida'`,
        ).bind(...llave),
        env.DB.prepare(
          `update productos set stock = stock - (select descontado from ml_ventas where order_id = ? and ml_item_id = ?),
                  actualizado_en = ?
           where id = ? and exists (select 1 from ml_ventas where order_id = ? and ml_item_id = ? and estado = 'recibida')`,
        ).bind(...llave, ahora, pub.producto_id, ...llave),
        env.DB.prepare(`update ml_ventas set estado = 'descontada' where order_id = ? and ml_item_id = ? and estado = 'recibida'`).bind(...llave),
        env.DB.prepare(
          `update ml_publicaciones set estado = 'vendida', actualizado_en = ?
           where producto_id = ? and estado in ('activa', 'pausada', 'pausada_por_venta')
             and (select stock from productos where id = ml_publicaciones.producto_id) <= 0`,
        ).bind(ahora, pub.producto_id),
      ]);
    } else {
      await env.DB.batch([
        env.DB.prepare(
          `update productos set stock = stock + (select descontado from ml_ventas where order_id = ? and ml_item_id = ? and estado = 'descontada'),
                  actualizado_en = ?
           where id = ? and exists (select 1 from ml_ventas where order_id = ? and ml_item_id = ? and estado = 'descontada')`,
        ).bind(...llave, ahora, pub.producto_id, ...llave),
        env.DB.prepare(`update ml_ventas set estado = 'cancelada' where order_id = ? and ml_item_id = ? and estado = 'descontada'`).bind(...llave),
      ]);
    }
  }
  return tocados;
}

/** Respaldo de las notificaciones perdidas: las ordenes del vendedor de las ultimas 24 h. */
async function traerOrdenesRecientes(env: Env, vendedor: string): Promise<string[]> {
  const desde = new Date(Date.now() - 24 * 3_600_000).toISOString().replace('Z', '-00:00');
  // ponytail: una sola pagina (50 ordenes); sobra para una tienda de piezas unicas.
  const r = await mlFetch(env, `/orders/search?seller=${vendedor}&order.date_created.from=${encodeURIComponent(desde)}&sort=date_desc`);
  const tocados: string[] = [];
  for (const orden of Array.isArray(r?.results) ? r.results : []) tocados.push(...await procesarOrden(env, orden));
  return tocados;
}

/** El cron (cada 15 min): ordenes perdidas y luego conciliacion. No hace nada sin cuenta conectada. */
export async function sincronizar(env: Env): Promise<void> {
  const cuenta = await leerCuenta(env);
  if (!conectada(cuenta)) return;
  try { await traerOrdenesRecientes(env, cuenta.ml_user_id); }
  catch (error) { console.error(JSON.stringify({ mensaje: 'ordenes recientes de ML', error: String(error) })); }
  await conciliarSeguro(env);
}

/* ---------- notificaciones (publicas) ---------- */

async function procesarNotificacion(env: Env, id: number): Promise<void> {
  const aviso = await env.DB.prepare('select topic, resource from ml_notificaciones where id = ?').bind(id).first<{ topic: string; resource: string }>();
  if (!aviso) return;
  let error = '';
  try {
    if (aviso.topic.startsWith('orders')) {
      const m = /^\/orders\/(\d+)/.exec(aviso.resource);
      if (m) {
        const orden = await mlFetch(env, `/orders/${m[1]}`);   // nunca se cree el cuerpo del aviso
        await conciliarSeguro(env, { productoIds: await procesarOrden(env, orden) });
      }
    } else if (aviso.topic === 'items') {
      const m = /^\/items\/(MLM\d+)/.exec(aviso.resource);
      if (m) await conciliarPublicaciones(env, { itemIds: [m[1]] });
    }
  } catch (e) {
    error = (e instanceof ErrorML ? e.detalle : String(e)).slice(0, 300);
  }
  await env.DB.prepare('update ml_notificaciones set procesado_en = ?, error = ? where id = ?').bind(new Date().toISOString(), error, id).run();
}

/**
 * POST /api/ml/notificaciones/:ruta. Sin sesion: lo llama ML. La defensa es la
 * ruta secreta, que el vendedor sea el nuestro y que nada del cuerpo se acepte
 * sin volver a pedirlo a ML. Se responde 200 enseguida (ML da 500 ms).
 */
export async function recibirNotificacion(ruta: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const esperada = env.ML_RUTA_NOTIFICACIONES;
  if (!esperada || !(await iguales(ruta, esperada))) return json({ error: 'Ruta no encontrada.' }, 404);
  const cuerpo = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!cuerpo || typeof cuerpo !== 'object') return json({ error: 'Cuerpo inválido.' }, 400);
  const cuenta = await leerCuenta(env);
  // Aviso de otra cuenta o sin cuenta conectada: 200 para que ML no lo reintente ni apague el topico.
  if (!conectada(cuenta) || String(cuerpo.user_id ?? '') !== cuenta.ml_user_id) return json({ ok: true, ignorada: true });
  const fila = await env.DB.prepare(
    'insert into ml_notificaciones (topic, resource, recibido_en) values (?, ?, ?) returning id',
  ).bind(String(cuerpo.topic ?? '').slice(0, 40), String(cuerpo.resource ?? '').slice(0, 200), new Date().toISOString()).first<{ id: number }>();
  if (fila) ctx.waitUntil(procesarNotificacion(env, fila.id));
  return json({ ok: true });
}

/* ---------- enrutador ---------- */

/**
 * Las rutas del dueno: /api/ml/* y el retorno de OAuth. El permiso ya lo cobro
 * worker.ts (todo lo que no esta en cuentas.ts es solo del dueno). Null = no es de aqui.
 */
export async function rutaML(request: Request, env: Env, url: URL): Promise<Response | null> {
  const { pathname } = url;
  const metodo = request.method;
  if (pathname === '/ml/callback' && metodo === 'GET') return retorno(env, url);
  if (!pathname.startsWith('/api/ml/')) return null;

  if (pathname === '/api/ml/estado' && metodo === 'GET') return estado(env);
  if (pathname === '/api/ml/config' && metodo === 'PUT') return guardarConfig(request, env);
  if (pathname === '/api/ml/conectar' && metodo === 'GET') return conectar(env, url);
  if (pathname === '/api/ml/piezas' && metodo === 'GET') return listarPiezas(env, url);
  if (pathname === '/api/ml/ventas' && metodo === 'GET') return listarVentas(env, url);
  const accion = /^\/api\/ml\/(preparar|publicar|pausar|reactivar)\/([^/]+)$/.exec(pathname);
  if (accion && metodo === 'POST') {
    if (accion[1] === 'preparar') return preparar(env, accion[2], request);
    if (accion[1] === 'publicar') return publicar(env, accion[2], request);
    return cambiarEstado(env, accion[2], accion[1] as 'pausar' | 'reactivar');
  }
  return null;
}
