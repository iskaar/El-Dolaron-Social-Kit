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
      headers: { 'user-agent': 'ElDolaron-escaner/1.0 (+https://eldolaron.com)', accept },
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

/** Piezas de El Dolarón con ese UPC y sin foto. Variantes con ceros para usar el índice productos_upc, no ltrim (recorre la tabla). */
async function piezasSinFoto(upc: string, env: Env): Promise<string[]> {
  const claves = Array.from({ length: 15 - upc.length }, (_, i) => upc.padStart(upc.length + i, '0'));
  const { results } = await env.DB.prepare(`select id from productos where upc in (${claves.map(() => '?').join(', ')})
    and propietario = 'dolaron' and foto_key = '' and estado_analisis <> 'descartado'`).bind(...claves).all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Solo añade foto: ni análisis, ni precio, ni stock. La confirmación queda en D1 para reintentar. */
export async function guardarImagenComoFoto(upc: string, env: Env): Promise<void> {
  try {
    const r = await env.DB.prepare(`select i.* from imagenes_upc i join manifiesto m on m.upc = i.upc and m.tcin = i.tcin
      where i.upc = ? and i.confirmado_en <> ''`).bind(normalizarUpc(upc)).first<Referencia>();
    if (!r || !imagenValida(r.url)) return;
    const { key, foto } = await fotoDeReferencia(r, env);
    const bytes = await foto.arrayBuffer();
    const results = (await piezasSinFoto(r.upc, env)).map((id) => ({ id }));
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

/** #413/#718: foto de una sola pieza desde una URL externa. Put condicional en R2 y UPDATE solo si sigue sin foto. */
async function guardarFotoPieza(env: Env, id: string, cuerpo: Blob, tipo: string, url: string): Promise<'ok' | 'ocupada' | 'cambio'> {
  const fotoKey = `fotos/${id}.jpg`;
  const creada = await env.FOTOS.put(fotoKey, cuerpo, {
    onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: tipo }, customMetadata: { imagen_busqueda: url },
  });
  if (!creada) {
    const existente = await env.FOTOS.get(fotoKey);
    await existente?.body.cancel();
    // #413: recupera un UPDATE fallido de esta URL; una foto propia nunca se reemplaza.
    if (existente?.customMetadata?.imagen_busqueda !== url) return 'ocupada';
  }
  const { meta } = await env.DB.prepare(`update productos set foto_key = ?, actualizado_en = ?,
      recorte_estado = 'original', recorte_fecha = null, recorte_revision = null,
      ropa_ia_estado = case when categoria = 'ropa' and nombre = 'Ropa' and ropa_ia_estado is null then 'descartado' else ropa_ia_estado end
    where id = ? and propietario = 'dolaron' and foto_key = '' and estado_analisis <> 'descartado'`)
    .bind(fotoKey, new Date().toISOString(), id).run();
  return meta.changes ? 'ok' : 'cambio';
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
    const resultado = await guardarFotoPieza(env, id, cuerpo, tipo, datos.imagen);
    if (resultado === 'ocupada') return json({ error: 'La pieza ya tiene otra foto. Recarga la ficha.' }, 409);
    return resultado === 'ok' ? json({ id, foto_key: fotoKey }) : json({ error: 'La pieza cambió o ya tiene foto. Recarga la ficha.' }, 409);
  } catch {
    return json({ error: 'No se pudo guardar la imagen. Reintenta o sube una foto.' }, 502);
  }
}

/** Referencia confirmada por «sistema» (#532). No pisa una decisión ya tomada para el mismo TCIN; true si cambió algo. */
async function guardarReferencia(env: Env, upc: string, tcin: string, url: string, nombre: string, upcFuente: string): Promise<boolean> {
  const { meta } = await env.DB.prepare(`insert into imagenes_upc (upc, tcin, url, nombre, upc_fuente, confirmado_por, confirmado_en)
    select ?, ?, ?, ?, ?, ?, ? where exists (select 1 from manifiesto where upc = ? and tcin = ?)
    on conflict (upc) do update set tcin = excluded.tcin, url = excluded.url, nombre = excluded.nombre,
      upc_fuente = excluded.upc_fuente, confirmado_por = excluded.confirmado_por, confirmado_en = excluded.confirmado_en
    where imagenes_upc.tcin <> excluded.tcin or imagenes_upc.confirmado_en = ''`)
    .bind(upc, tcin, url, nombre.trim().slice(0, 200), upcFuente, 'sistema', new Date().toISOString(), upc, tcin).run();
  return meta.changes > 0;
}

// #718: UPCitemdb (plan gratuito, sin llave) devuelve la imagen de Target por UPC sin raspar Target.
// Plan DEV ($99/mes, 20,000/día): llave en /prod/v1/ con la variable UPCITEMDB_KEY (aún no existe ni se usa).
const UPCITEMDB = 'https://api.upcitemdb.com/prod/trial/lookup';
const PRESUPUESTO_UPCITEMDB = 80; // de 100/día: el resto queda para el escaneo y las ráfagas
const POR_CORRIDA_UPCITEMDB = 5;
const REINTENTO_SIN_RESULTADO_DIAS = 30;
let pausaUpcitemdbMs = 10_000; // el plan gratuito da 429 en ráfagas
/** Solo para pruebas. */
export const pausarUpcitemdbPor = (ms: number) => { pausaUpcitemdbMs = ms; };
const claveConsultas = () => `upcitemdb_consultas_${new Date().toISOString().slice(0, 10)}`;

/** Gasta una consulta del día en D1 (atómico); false si el presupuesto se agotó. */
async function gastarConsultaUpcitemdb(env: Env): Promise<boolean> {
  const clave = claveConsultas();
  const { meta } = await env.DB.prepare(`insert into config (clave, valor) values (?, '1')
    on conflict (clave) do update set valor = cast(cast(valor as integer) + 1 as text) where cast(valor as integer) < ?`)
    .bind(clave, PRESUPUESTO_UPCITEMDB).run();
  if (!meta.changes) return false;
  await env.DB.prepare("delete from config where clave like 'upcitemdb_consultas_%' and clave < ?").bind(clave).run();
  return true;
}

/** UPC sin imagen utilizable: no se vuelve a consultar durante 30 días. */
const marcarSinImagen = (env: Env, upc: string) => env.DB.prepare(`insert into config (clave, valor) values (?, ?)
  on conflict (clave) do update set valor = excluded.valor`).bind(`upcitemdb_sin_${upc}`, new Date().toISOString().slice(0, 10)).run();

interface Hallazgo { imagen: string; titulo: string; model: string }

const avisarModelo = (upc: string, tcin: string, h: Hallazgo) => {
  if (h.model && h.model !== tcin) console.warn(JSON.stringify({ mensaje: 'upcitemdb: model distinto al TCIN del manifiesto', upc, tcin, model: h.model }));
};

/** Hallazgo con UPC verificado, null si no hay imagen (queda marcado) o 'alto' si hay que dejar de consultar (límite, error). */
async function consultarUpcitemdb(upc: string, env: Env): Promise<Hallazgo | null | 'alto'> {
  if (!await gastarConsultaUpcitemdb(env)) return 'alto';
  try {
    // Al normalizar, un UPC-A de 12 dígitos con cero inicial queda en 11.
    const respuesta = await fetch(`${UPCITEMDB}?upc=${upc.padStart(12, '0')}`, {
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'ElDolaron-escaner/1.0 (+https://eldolaron.com)', accept: 'application/json' },
    });
    if (respuesta.status !== 200) {
      await respuesta.body?.cancel();
      console.warn(JSON.stringify({ mensaje: 'upcitemdb no respondió', status: respuesta.status }));
      return 'alto';
    }
    const datos = await leerJson(respuesta.body, 500_000) as { code?: string; items?: Array<Record<string, unknown>> };
    if (datos.code === 'EXCEED_LIMIT') return 'alto';
    const item = datos.code === 'OK' ? datos.items?.[0] : undefined;
    const coincide = !!item && [item.upc, item.ean].some((c) => typeof c === 'string' && normalizarUpc(c) === upc);
    const imagenes = Array.isArray(item?.images) ? item.images.filter(httpsValida) : [];
    // Regla automática conservadora (#718): solo entra sola la imagen scene7; otras fuentes quedan para «Buscar imagen» en /admin.
    const imagen = imagenes.find(imagenValida);
    if (!coincide || !imagen) { await marcarSinImagen(env, upc); return null; }
    return { imagen, titulo: typeof item!.title === 'string' ? item!.title : '', model: typeof item!.model === 'string' ? item!.model : '' };
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'upcitemdb fallido', upc, error: error instanceof Error ? error.message.slice(0, 200) : 'error desconocido' }));
    return 'alto';
  }
}

/** Escaneo: Target falló; solo una imagen scene7 con UPC coincidente se acepta, con la misma forma de respuesta. */
async function respaldoUpcitemdb(upc: string, tcin: string, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const h = await consultarUpcitemdb(upc, env);
  if (!h || h === 'alto' || !imagenValida(h.imagen)) return null;
  avisarModelo(upc, tcin, h);
  if (await guardarReferencia(env, upc, tcin, h.imagen, h.titulo || upc, upc)) ctx.waitUntil(guardarImagenComoFoto(upc, env));
  const imagen = await imagenGuardada(upc, env);
  return imagen ? json({ imagen }) : null;
}

/** Cron: da la foto a todas las piezas de El Dolarón sin foto con ese UPC. */
async function guardarHallazgo(upc: string, h: Hallazgo, env: Env): Promise<void> {
  const fuente = await env.DB.prepare('select tcin from manifiesto where upc = ?').bind(upc).first<{ tcin: string }>();
  if (fuente && /^\d{1,12}$/.test(fuente.tcin)) {
    // En el manifiesto: la referencia conserva el TCIN de la hoja y el join de guardarImagenComoFoto sigue valiendo.
    avisarModelo(upc, fuente.tcin, h);
    await guardarReferencia(env, upc, fuente.tcin, h.imagen, h.titulo || upc, upc);
    await guardarImagenComoFoto(upc, env);
    return;
  }
  const { cuerpo, tipo } = await descargarImagen(h.imagen, 3);
  for (const id of await piezasSinFoto(upc, env)) await guardarFotoPieza(env, id, cuerpo, tipo, h.imagen);
}

/**
 * #718: hasta 5 UPC por corrida de piezas listas sin foto (con stock primero), una consulta a la vez y con pausa.
 * Las que ya tienen referencia confirmada las atiende procesarRellenoImagenes.
 */
export async function procesarRellenoUpcitemdb(env: Env): Promise<void> {
  const usadas = await env.DB.prepare('select valor from config where clave = ?').bind(claveConsultas()).first<{ valor: string }>();
  if (Number(usadas?.valor ?? 0) >= PRESUPUESTO_UPCITEMDB) return;
  const desde = new Date(Date.now() - REINTENTO_SIN_RESULTADO_DIAS * 86_400_000).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(`select ltrim(upc, '0') as codigo, max(stock > 0) as con_stock, max(creado_en) as creado
    from productos where propietario = 'dolaron' and estado_analisis = 'listo' and foto_key = '' and upc <> ''
      and not exists (select 1 from config where clave = 'upcitemdb_sin_' || ltrim(productos.upc, '0') and valor > ?)
    group by ltrim(upc, '0') order by con_stock desc, creado desc limit 25`).bind(desde).all<{ codigo: string }>();
  const validos = results.map((r) => r.codigo).filter((c) => /^\d{6,14}$/.test(c));
  for (const c of results.map((r) => r.codigo)) if (!validos.includes(c)) await marcarSinImagen(env, c);
  // ponytail: si 25 referencias confirmadas fallan para siempre, ocupan el lote; entonces subir el límite o marcarlas.
  const conReferencia = validos.length ? new Set((await env.DB.prepare(`select i.upc from imagenes_upc i
    join manifiesto m on m.upc = i.upc and m.tcin = i.tcin
    where i.confirmado_en <> '' and i.upc in (${validos.map(() => '?').join(', ')})`).bind(...validos).all<{ upc: string }>()).results.map((r) => r.upc)) : new Set<string>();
  let consultadas = 0;
  for (const upc of validos.filter((c) => !conReferencia.has(c)).slice(0, POR_CORRIDA_UPCITEMDB)) {
    if (consultadas++) await new Promise((resolve) => setTimeout(resolve, pausaUpcitemdbMs));
    const h = await consultarUpcitemdb(upc, env);
    if (h === 'alto') return;
    if (!h) continue;
    try {
      await guardarHallazgo(upc, h, env);
      if ((await piezasSinFoto(upc, env)).length) await marcarSinImagen(env, upc);
    } catch (error) {
      console.error(JSON.stringify({ mensaje: 'imagen de upcitemdb sin foto', upc, error: error instanceof Error ? error.message.slice(0, 200) : 'error desconocido' }));
      await marcarSinImagen(env, upc);
    }
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

  const deTarget = await consultarTarget(upc, fuente, env, ctx);
  // #718: si Target no da la imagen (reto, 404, sin og:image, pausa), UPCitemdb antes de pedir foto a mano.
  if (![422, 502, 503].includes(deTarget.status)) return deTarget;
  return await respaldoUpcitemdb(upc, fuente.tcin, env, ctx) ?? deTarget;
}

async function consultarTarget(upc: string, fuente: { tcin: string }, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (Date.now() < pausaTargetHasta) return json({ error: VERIFICACION }, 503);
  try {
    // Una consulta por UPC, solo al escanearlo y luego en caché: volumen de persona, no de crawler.
    const respuesta = await fetch(enlace(fuente.tcin), {
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'ElDolaron-escaner/1.0 (+https://eldolaron.com)', accept: 'text/html' },
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
    const guardada = await guardarReferencia(env, upc, fuente.tcin, datos.image_url, datos.title, datos.barcode);
    if (guardada) ctx.waitUntil(guardarImagenComoFoto(upc, env));
    const imagen = await imagenGuardada(upc, env);
    return imagen ? json({ imagen }) : json({ error: 'El enlace cambió. Vuelve a escanear.' }, 409);
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'búsqueda de imagen fallida', error: error instanceof Error ? error.message.slice(0, 200) : 'error desconocido' }));
    return json({ error: 'La búsqueda no respondió. Toma o sube una foto.' }, 502);
  }
}
