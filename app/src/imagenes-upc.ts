import { normalizarUpc } from '../public/upc.js';
import { paginasParaImagen } from './analisis.ts';

interface Referencia {
  upc: string; tcin: string; url: string; nombre: string; upc_fuente: string;
  confirmado_por: string; confirmado_en: string;
}

const json = (cuerpo: unknown, status = 200) => Response.json(cuerpo, { status, headers: { 'cache-control': 'no-store' } });
const enlace = (tcin: string) => `https://www.target.com/p/-/A-${tcin}`;
const imagenValida = (valor: unknown): valor is string => {
  if (typeof valor !== 'string' || valor.length > 2000) return false;
  try {
    const u = new URL(valor);
    return u.protocol === 'https:' && u.hostname === 'target.scene7.com' && !u.username && !u.password && !u.port
      && u.pathname.startsWith('/is/image/Target/');
  } catch { return false; }
};
const referencia = (r: Referencia) => ({
  url: r.url, nombre: r.nombre, origen: 'target', enlace: enlace(r.tcin), tcin: r.tcin,
  codigo_verificado: !!r.upc_fuente, confirmada: !!r.confirmado_en,
});

async function leerCuerpo(cuerpo: ReadableStream<Uint8Array> | null, maximo: number) {
  if (!cuerpo) throw new Error('Falta el cuerpo.');
  const lector = cuerpo.getReader(), partes: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await lector.read();
    if (done) break;
    bytes += value.length;
    if (bytes > maximo) { await lector.cancel(); throw new Error('Cuerpo demasiado grande.'); }
    partes.push(value);
  }
  if (!bytes) throw new Error('Cuerpo vacío.');
  return new Blob(partes);
}
const leerTexto = async (cuerpo: ReadableStream<Uint8Array> | null, maximo: number) => (await leerCuerpo(cuerpo, maximo)).text();
const leerJson = async (cuerpo: ReadableStream<Uint8Array> | null, maximo: number) => JSON.parse(await leerTexto(cuerpo, maximo));

const FOTO_MAX_BYTES = 6 * 1024 * 1024;

// #413: valida también la autoridad original: URL borra el puerto explícito :443.
const httpsValida = (valor: unknown): valor is string => {
  if (typeof valor !== 'string' || valor.length > 2000 || /[\\\s]/.test(valor) || !/^https:\/\/[^/?#]+/i.test(valor)) return false;
  try {
    const u = new URL(valor);
    const autoridad = /^https:\/\/([^/?#\\]+)/i.exec(valor)![1];
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password && !u.port && !/[:@]/.test(autoridad);
  } catch { return false; }
};

async function abrirHttps(url: string, accept: string, redirecciones: number) {
  const signal = AbortSignal.timeout(10_000);
  for (let salto = 0; ; salto++) {
    if (!httpsValida(url)) throw new Error('URL HTTPS inválida.');
    const respuesta = await fetch(url, {
      redirect: 'manual', signal,
      headers: { 'user-agent': 'ElDolaron-escaner/1.0 (+https://viste.com.mx)', accept },
    });
    if (![301, 302, 303, 307, 308].includes(respuesta.status)) return { respuesta, url };
    const destino = respuesta.headers.get('location')?.trim();
    await respuesta.body?.cancel();
    if (!destino || destino.includes('\\') || salto >= redirecciones) throw new Error('Redirección de imagen inválida.');
    url = /^[a-z][a-z0-9+.-]*:/i.test(destino) ? destino
      : destino.startsWith('//') ? `https:${destino}` : new URL(destino, url).href;
  }
}

/** #413: comparte los límites de descarga; Target conserva su política sin redirecciones. */
async function descargarImagen(url: string, redirecciones = 0) {
  const { respuesta } = await abrirHttps(url, 'image/*', redirecciones);
  const tipo = respuesta.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (respuesta.status !== 200 || !/^image\/[a-z0-9.+-]+$/.test(tipo)
      || Number(respuesta.headers.get('content-length')) > FOTO_MAX_BYTES) {
    await respuesta.body?.cancel();
    throw new Error('Respuesta de imagen inválida.');
  }
  return { cuerpo: await leerCuerpo(respuesta.body, FOTO_MAX_BYTES), tipo };
}

/** Caché por referencia; la reserva condicional en R2 evita dos descargas simultáneas. */
async function fotoDeReferencia(r: Referencia, env: Env) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(r.url));
  const key = `imagenes-upc/${r.upc}/${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const hasta = Date.now() + 15_000;
  while (Date.now() < hasta) {
    const foto = await env.FOTOS.get(key);
    if (foto && !foto.customMetadata?.pendiente) return { key, foto };
    await foto?.body.cancel();
    if (foto && Number(foto.customMetadata?.pendiente) > Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    // Una reserva abandonada vence; un fallo se libera para el siguiente escaneo o confirmación.
    const reserva = await env.FOTOS.put(key, crypto.randomUUID(), {
      onlyIf: foto ? { etagMatches: foto.etag } : { etagDoesNotMatch: '*' },
      customMetadata: { pendiente: String(Date.now() + 15_000) },
    });
    if (!reserva) continue;
    try {
      const { cuerpo, tipo } = await descargarImagen(r.url);
      await env.FOTOS.put(key, cuerpo, { onlyIf: { etagMatches: reserva.etag }, httpMetadata: { contentType: tipo } });
    } catch (error) {
      await env.FOTOS.put(key, crypto.randomUUID(), { onlyIf: { etagMatches: reserva.etag }, customMetadata: { pendiente: '0' } });
      throw error;
    }
  }
  throw new Error('La imagen sigue descargándose. Reintenta al escanear.');
}

/** Solo añade foto: ni análisis, ni precio, ni stock. La confirmación queda en D1 para reintentar. */
export async function guardarImagenComoFoto(upc: string, env: Env): Promise<void> {
  try {
    const r = await env.DB.prepare(`select i.* from imagenes_upc i join manifiesto m on m.upc = i.upc and m.tcin = i.tcin
      where i.upc = ? and i.confirmado_en <> ''`).bind(normalizarUpc(upc)).first<Referencia>();
    if (!r || !imagenValida(r.url)) return;
    const { key, foto } = await fotoDeReferencia(r, env);
    const bytes = await foto.arrayBuffer();
    // Se llama en cada escaneo: variantes con ceros para usar el índice productos_upc, no ltrim (recorre la tabla).
    const claves = Array.from({ length: 15 - r.upc.length }, (_, i) => r.upc.padStart(r.upc.length + i, '0'));
    const { results } = await env.DB.prepare(`select id from productos where upc in (${claves.map(() => '?').join(', ')})
      and propietario = 'dolaron' and foto_key = '' and estado_analisis <> 'descartado'`).bind(...claves).all<{ id: string }>();
    for (const { id } of results) {
      const fotoKey = `fotos/${id}.jpg`;
      const creada = await env.FOTOS.put(fotoKey, bytes, {
        onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: foto.httpMetadata, customMetadata: { imagen_upc: key },
      });
      // Recupera un put cuyo UPDATE falló o cuya referencia cambió; nunca pisa una foto propia en vuelo.
      if (!creada) {
        const existente = await env.FOTOS.get(fotoKey);
        await existente?.body.cancel();
        if (!existente?.customMetadata?.imagen_upc) continue;
        if (existente.customMetadata.imagen_upc !== key && !await env.FOTOS.put(fotoKey, bytes, {
          onlyIf: { etagMatches: existente.etag }, httpMetadata: foto.httpMetadata, customMetadata: { imagen_upc: key },
        })) continue;
      }
      // «Ropa» con referencia confirmada tampoco debe entrar a la cola que renombra prendas.
      // #423: la imagen oficial ya viene limpia: 'original' (el check de la migración 042 no admite otro valor) la saca de la cola de recortes.
      await env.DB.prepare(`update productos set foto_key = ?, actualizado_en = ?,
          recorte_estado = 'original', recorte_fecha = null, recorte_revision = null,
          ropa_ia_estado = case when categoria = 'ropa' and nombre = 'Ropa' and ropa_ia_estado is null then 'descartado' else ropa_ia_estado end
        where id = ? and ltrim(upc, '0') = ? and propietario = 'dolaron' and foto_key = '' and estado_analisis <> 'descartado'
          and exists (select 1 from imagenes_upc i join manifiesto m on m.upc = i.upc and m.tcin = i.tcin
            where i.upc = ? and i.url = ? and i.tcin = ? and i.confirmado_en <> '')`)
        .bind(fotoKey, new Date().toISOString(), id, r.upc, r.upc, r.url, r.tcin).run();
    }
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'imagen confirmada sin foto', upc, error: error instanceof Error ? error.message.slice(0, 200) : 'error desconocido' }));
  }
}

/** #413: rellena piezas viejas de una en una, sin barrer productos ni atascarse por una imagen fallida. */
export async function procesarRellenoImagenes(env: Env): Promise<void> {
  // #524/#532: toda candidata que nadie confirmó a mano entra al mismo lote.
  await env.DB.prepare(`update imagenes_upc set confirmado_por = 'sistema', confirmado_en = ?
    where confirmado_en = '' and exists (select 1 from manifiesto m where m.upc = imagenes_upc.upc and m.tcin = imagenes_upc.tcin)`)
    .bind(new Date().toISOString()).run();
  const { results } = await env.DB.prepare(`select upc, confirmado_en from imagenes_upc
    where confirmado_en > coalesce((select valor from config where clave = 'imagenes_relleno_hasta'), '')
    order by confirmado_en limit 20`).all<{ upc: string; confirmado_en: string }>();
  for (const fila of results) {
    await guardarImagenComoFoto(fila.upc, env);
    // El helper registra el fallo; el siguiente escaneo o confirmación reintentará esa pieza.
    await env.DB.prepare(`insert into config (clave, valor) values ('imagenes_relleno_hasta', ?)
      on conflict (clave) do update set valor = excluded.valor`).bind(fila.confirmado_en).run();
  }
}

const VERIFICACION = 'Target pidió verificación. Abre «Ver producto original», guarda la imagen y usa «Subir foto», o toma una.';
const PAUSA_MS = 30 * 60_000;
// ponytail: pausa por isolate; si Target bloquea seguido, guardarla en D1 para todos los isolates.
let pausaTargetHasta = 0;
/** Solo para pruebas. */
export const reiniciarPausaTarget = () => { pausaTargetHasta = 0; };
const meta = (html: string, propiedad: string) => {
  for (const [etiqueta] of html.matchAll(/<meta\b[^>]*>/g)) {
    if (etiqueta.includes(`property="${propiedad}"`)) return /content="([^"]*)"/.exec(etiqueta)?.[1] ?? '';
  }
  return '';
};
const entidades = (texto: string) => texto.replace(/&(amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, (original, entidad: string) => {
  const e = entidad.toLowerCase();
  if (!e.startsWith('#')) return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[e] ?? original;
  const codigo = e.startsWith('#x') ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return codigo > 0 && codigo <= 0x10ffff ? String.fromCodePoint(codigo) : original;
});

const atributo = (etiqueta: string, nombre: string) =>
  new RegExp(`\\s${nombre}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(etiqueta)?.slice(1).find((v) => v !== undefined) ?? '';

function metadato(html: string, propiedad: string) {
  for (const [etiqueta] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if ((atributo(etiqueta, 'property') || atributo(etiqueta, 'name')).toLowerCase() === propiedad) return entidades(atributo(etiqueta, 'content'));
  }
  return '';
}

function productoJsonLd(html: string): { imagen: string; nombre: string } | null {
  for (const [, etiqueta, contenido] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (atributo(` ${etiqueta}`, 'type').toLowerCase() !== 'application/ld+json') continue;
    try {
      const pendientes: unknown[] = [JSON.parse(contenido)];
      while (pendientes.length) {
        const dato = pendientes.pop();
        if (!dato || typeof dato !== 'object') continue;
        if (Array.isArray(dato)) { pendientes.push(...dato); continue; }
        const p = dato as Record<string, unknown>;
        if ([p['@type']].flat().some((tipo) => tipo === 'Product' || tipo === 'https://schema.org/Product')) {
          const imagen = [p.image].flat()[0];
          const url = typeof imagen === 'string' ? imagen : (imagen as { url?: unknown; contentUrl?: unknown } | null)?.url
            ?? (imagen as { contentUrl?: unknown } | null)?.contentUrl;
          if (typeof url === 'string') return { imagen: url, nombre: typeof p.name === 'string' ? p.name : '' };
        }
        pendientes.push(...Object.values(p));
      }
    } catch { /* Una página puede tener otro bloque Product válido. */ }
  }
  return null;
}

async function candidataDePagina(pagina: string) {
  const { respuesta, url } = await abrirHttps(pagina, 'text/html', 3);
  if (respuesta.status !== 200) { await respuesta.body?.cancel(); return null; }
  const html = await leerTexto(respuesta.body, 3_000_000);
  const producto = productoJsonLd(html);
  for (const imagen of [metadato(html, 'og:image'), producto?.imagen]) {
    if (!imagen) continue;
    let absoluta: string;
    try { absoluta = new URL(imagen, url).href; } catch { continue; }
    if (!httpsValida(absoluta)) continue;
    const sitio = new URL(url).hostname;
    const titulo = metadato(html, 'og:title') || producto?.nombre || entidades(/<title\b[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '') || sitio;
    return { imagen: absoluta, pagina: url, titulo: titulo.trim().slice(0, 200), sitio };
  }
  return null;
}

/** #413: solo /admin, después de verificar host, rol y propietario en el Worker. */
export async function rutaImagenPieza(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const ruta = /^\/api\/borradores\/([^/]+)\/imagen(\/buscar)?$/.exec(pathname);
  if (!ruta) return null;
  if (request.method !== (ruta[2] ? 'POST' : 'PUT')) return json({ error: 'Método no permitido.' }, 405);
  const id = ruta[1];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return json({ error: 'Identificador inválido.' }, 400);
  const pieza = await env.DB.prepare(`select nombre, marca, upc, foto_key from productos
    where id = ? and propietario = 'dolaron' and estado_analisis <> 'descartado'`)
    .bind(id).first<{ nombre: string; marca: string; upc: string | null; foto_key: string }>();
  if (!pieza) return json({ error: 'Pieza no encontrada.' }, 404);
  if (pieza.foto_key !== '') return json({ error: 'La pieza ya tiene foto.' }, 409);

  if (ruta[2]) {
    if (!env.VERTEX_API_KEY) return json({ error: 'Falta VERTEX_API_KEY para buscar imágenes.' }, 503);
    if (!pieza.nombre.trim()) return json({ error: 'Guarda el nombre de la pieza antes de buscar.' }, 400);
    try {
      const paginas = await paginasParaImagen([pieza.marca, pieza.nombre, pieza.upc].filter(Boolean).join(' '), env);
      const resultados = await Promise.allSettled(paginas.filter(httpsValida).map(candidataDePagina));
      const vistas = new Set<string>();
      const candidatas = resultados.flatMap((r) => {
        if (r.status !== 'fulfilled' || !r.value || vistas.has(r.value.imagen)) return [];
        vistas.add(r.value.imagen);
        return [r.value];
      }).slice(0, 3);
      return json({ candidatas });
    } catch {
      return json({ error: 'La búsqueda no respondió. Reintenta o sube una foto.' }, 502);
    }
  }

  const datos = await leerJson(request.body, 4096).catch(() => null) as { imagen?: unknown } | null;
  if (!httpsValida(datos?.imagen)) return json({ error: 'Usa una URL HTTPS sin credenciales ni puerto.' }, 400);
  const fotoKey = `fotos/${id}.jpg`;
  try {
    const { cuerpo, tipo } = await descargarImagen(datos.imagen, 3);
    const creada = await env.FOTOS.put(fotoKey, cuerpo, {
      onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: tipo }, customMetadata: { imagen_busqueda: datos.imagen },
    });
    if (!creada) {
      const existente = await env.FOTOS.get(fotoKey);
      await existente?.body.cancel();
      // #413: recupera un UPDATE fallido de esta URL; una foto propia nunca se reemplaza.
      if (existente?.customMetadata?.imagen_busqueda !== datos.imagen) return json({ error: 'La pieza ya tiene otra foto. Recarga la ficha.' }, 409);
    }
    const { meta } = await env.DB.prepare(`update productos set foto_key = ?, actualizado_en = ?,
        recorte_estado = 'original', recorte_fecha = null, recorte_revision = null,
        ropa_ia_estado = case when categoria = 'ropa' and nombre = 'Ropa' and ropa_ia_estado is null then 'descartado' else ropa_ia_estado end
      where id = ? and propietario = 'dolaron' and foto_key = '' and estado_analisis <> 'descartado'`)
      .bind(fotoKey, new Date().toISOString(), id).run();
    return meta.changes ? json({ id, foto_key: fotoKey }) : json({ error: 'La pieza cambió o ya tiene foto. Recarga la ficha.' }, 409);
  } catch {
    return json({ error: 'No se pudo guardar la imagen. Reintenta o sube una foto.' }, 502);
  }
}

/** La foto propia tiene prioridad, incluso si se agotó el stock. Nunca busca en piezas de FEP. */
export async function imagenGuardada(upc: string, env: Env) {
  const propia = await env.DB.prepare(`select id, nombre from productos
    where ltrim(upc, '0') = ? and propietario = 'dolaron' and foto_key <> '' and estado_analisis <> 'descartado'
    order by actualizado_en desc limit 1`).bind(upc).first<{ id: string; nombre: string }>();
  if (propia) return { url: `/api/manifiesto/${upc}/imagen/catalogo`, nombre: propia.nombre, origen: 'catalogo', confirmada: true };
  const r = await env.DB.prepare(`select i.* from imagenes_upc i join manifiesto m on m.upc = i.upc and m.tcin = i.tcin
    where i.upc = ?`).bind(upc).first<Referencia>();
  if (!r) return null;
  // #532: la imagen de Target siempre se asigna sola; una candidata vieja sin confirmar se confirma al leerla.
  if (!r.confirmado_en) {
    const ahora = new Date().toISOString();
    const { meta } = await env.DB.prepare(`update imagenes_upc set confirmado_por = 'sistema', confirmado_en = ?
      where upc = ? and confirmado_en = '' and exists (select 1 from manifiesto m where m.upc = imagenes_upc.upc and m.tcin = imagenes_upc.tcin)`)
      .bind(ahora, upc).run();
    if (meta.changes) return referencia({ ...r, confirmado_por: 'sistema', confirmado_en: ahora });
  }
  return referencia(r);
}

/** Se llama después de verificar host, sesión y rol en el Worker. */
export async function rutaImagenUpc(request: Request, env: Env, pathname: string, correo: string, ctx: ExecutionContext): Promise<Response | null> {
  const ruta = /^\/api\/manifiesto\/([^/]+)\/imagen(\/catalogo)?$/.exec(pathname);
  if (!ruta) return null;
  let upc = '';
  try { upc = normalizarUpc(decodeURIComponent(ruta[1])); } catch { /* se rechaza abajo */ }
  if (!upc) return json({ error: 'Código de barras inválido.' }, 400);
  if (ruta[2]) {
    if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405);
    const pieza = await env.DB.prepare(`select foto_key from productos
      where ltrim(upc, '0') = ? and propietario = 'dolaron' and foto_key <> '' and estado_analisis <> 'descartado'
      order by actualizado_en desc limit 1`).bind(upc).first<{ foto_key: string }>();
    const foto = pieza && await env.FOTOS.get(pieza.foto_key);
    return foto ? new Response(foto.body, { headers: { 'content-type': foto.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' } })
      : json({ error: 'Foto no encontrada.' }, 404);
  }
  if (!['GET', 'POST', 'PUT'].includes(request.method)) return json({ error: 'Método no permitido.' }, 405);
  if (request.method === 'GET') return json({ imagen: await imagenGuardada(upc, env) });
  if (request.method === 'POST') {
    const guardada = await imagenGuardada(upc, env);
    if (guardada) return json({ imagen: guardada });
  }
  const fuente = await env.DB.prepare('select tcin from manifiesto where upc = ?').bind(upc).first<{ tcin: string }>();
  if (!fuente || !/^\d{1,12}$/.test(fuente.tcin)) return json({ error: 'No hay enlace del proveedor. Toma o sube una foto.' }, 404);

  if (request.method === 'PUT') {
    const cuerpo = await leerJson(request.body, 4096).catch(() => null) as { url?: unknown; tcin?: unknown } | null;
    if (!cuerpo || typeof cuerpo.url !== 'string') return json({ error: 'Datos de imagen inválidos.' }, 400);
    if (cuerpo.tcin !== fuente.tcin) return json({ error: 'La imagen cambió. Vuelve a buscarla.' }, 409);
    const { meta } = await env.DB.prepare(`update imagenes_upc set confirmado_por = ?, confirmado_en = ?
      where upc = ? and url = ? and tcin = ? and exists (select 1 from manifiesto m where m.upc = imagenes_upc.upc and m.tcin = imagenes_upc.tcin)`)
      .bind(correo, new Date().toISOString(), upc, cuerpo.url, cuerpo.tcin).run();
    if (meta.changes) ctx.waitUntil(guardarImagenComoFoto(upc, env));
    return meta.changes ? json({ imagen: await imagenGuardada(upc, env) }) : json({ error: 'La imagen cambió. Vuelve a buscarla.' }, 409);
  }

  if (Date.now() < pausaTargetHasta) return json({ error: VERIFICACION }, 503);
  try {
    // Una consulta por UPC, solo al escanearlo y luego en caché: volumen de persona, no de crawler.
    const respuesta = await fetch(enlace(fuente.tcin), {
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'ElDolaron-escaner/1.0 (+https://viste.com.mx)', accept: 'text/html' },
    });
    const html = respuesta.status === 200 || respuesta.status === 403 || respuesta.status === 429
      ? await leerTexto(respuesta.body, 3_000_000) : (await respuesta.body?.cancel(), '');
    // Target usa HUMAN («mantén presionado»). No se resuelve: se pausa y lo hace una persona.
    if (respuesta.status === 403 || respuesta.status === 429 || /px-captcha|press\s*&(amp;)?\s*hold/i.test(html)) {
      pausaTargetHasta = Date.now() + PAUSA_MS;
      console.warn(JSON.stringify({ mensaje: 'target pidió verificación', status: respuesta.status }));
      return json({ error: VERIFICACION }, 503);
    }
    if (respuesta.status === 404) return json({ error: 'Target ya no tiene este producto. Toma o sube una foto.' }, 422);
    if (respuesta.status !== 200) return json({ error: 'No se pudo abrir el producto en Target. Toma o sube una foto.' }, 502);
    const codigos = new Set([...html.matchAll(/"primary_barcode":"(\d{6,14})"/g)].map((m) => normalizarUpc(m[1])));
    const datos = {
      image_url: entidades(meta(html, 'og:image')),
      title: entidades(meta(html, 'og:title') || /id="pdp-product-title-id"[^>]*>([^<]+)/.exec(html)?.[1] || ''),
      // Más de un código en la página es ambiguo: queda para revisión manual.
      barcode: codigos.size === 1 ? [...codigos][0] : '',
    };
    if (!imagenValida(datos.image_url) || !datos.title.trim() || (datos.barcode && datos.barcode !== upc)) {
      return json({ error: 'La página no tiene una imagen válida para este código. Toma o sube una foto.' }, 422);
    }
    // Si cambió la hoja o alguien confirmó mientras llegaba HTTP, no se pisa su decisión.
    // #532: la imagen de Target se confirma sola siempre (confirmado_por = 'sistema') y pasa a ser la foto de las piezas sin foto;
    // si la página trae un código distinto al escaneado ya se rechazó arriba.
    const guardada = await env.DB.prepare(`insert into imagenes_upc (upc, tcin, url, nombre, upc_fuente, confirmado_por, confirmado_en)
      select ?, ?, ?, ?, ?, ?, ? where exists (select 1 from manifiesto where upc = ? and tcin = ?)
      on conflict (upc) do update set tcin = excluded.tcin, url = excluded.url, nombre = excluded.nombre,
        upc_fuente = excluded.upc_fuente, confirmado_por = excluded.confirmado_por, confirmado_en = excluded.confirmado_en
      where imagenes_upc.tcin <> excluded.tcin or imagenes_upc.confirmado_en = ''`)
      .bind(upc, fuente.tcin, datos.image_url, datos.title.trim().slice(0, 200), datos.barcode,
        'sistema', new Date().toISOString(), upc, fuente.tcin).run();
    if (guardada.meta.changes) ctx.waitUntil(guardarImagenComoFoto(upc, env));
    const imagen = await imagenGuardada(upc, env);
    return imagen ? json({ imagen }) : json({ error: 'El enlace cambió. Vuelve a escanear.' }, 409);
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'búsqueda de imagen fallida', error: error instanceof Error ? error.message.slice(0, 200) : 'error desconocido' }));
    return json({ error: 'La búsqueda no respondió. Toma o sube una foto.' }, 502);
  }
}
