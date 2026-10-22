import { normalizarUpc } from '../public/upc.js';

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
      const respuesta = await fetch(r.url, {
        redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { 'user-agent': 'ElDolaron-escaner/1.0 (+https://viste.com.mx)', accept: 'image/*' },
      });
      const tipo = respuesta.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
      if (respuesta.status !== 200 || !/^image\/[a-z0-9.+-]+$/.test(tipo)
          || Number(respuesta.headers.get('content-length')) > FOTO_MAX_BYTES) {
        await respuesta.body?.cancel();
        throw new Error('Respuesta de imagen inválida.');
      }
      const cuerpo = await leerCuerpo(respuesta.body, FOTO_MAX_BYTES);
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
      await env.DB.prepare(`update productos set foto_key = ?, actualizado_en = ?,
          recorte_estado = case when recorte_estado = 'original' then 'original' else null end, recorte_fecha = null, recorte_revision = null,
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
const entidades = (texto: string) => texto.replace(/&(amp|quot|#39|#x27|lt|gt);/g,
  (_, e: string) => ({ amp: '&', quot: '"', '#39': "'", '#x27': "'", lt: '<', gt: '>' })[e]!);

/** La foto propia tiene prioridad, incluso si se agotó el stock. Nunca busca en piezas de FEP. */
export async function imagenGuardada(upc: string, env: Env) {
  const propia = await env.DB.prepare(`select id, nombre from productos
    where ltrim(upc, '0') = ? and propietario = 'dolaron' and foto_key <> '' and estado_analisis <> 'descartado'
    order by actualizado_en desc limit 1`).bind(upc).first<{ id: string; nombre: string }>();
  if (propia) return { url: `/api/manifiesto/${upc}/imagen/catalogo`, nombre: propia.nombre, origen: 'catalogo', confirmada: true };
  const r = await env.DB.prepare(`select i.* from imagenes_upc i join manifiesto m on m.upc = i.upc and m.tcin = i.tcin
    where i.upc = ?`).bind(upc).first<Referencia>();
  return r ? referencia(r) : null;
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
    await env.DB.prepare(`insert into imagenes_upc (upc, tcin, url, nombre, upc_fuente)
      select ?, ?, ?, ?, ? where exists (select 1 from manifiesto where upc = ? and tcin = ?)
      on conflict (upc) do update set tcin = excluded.tcin, url = excluded.url, nombre = excluded.nombre,
        upc_fuente = excluded.upc_fuente, confirmado_por = '', confirmado_en = ''
      where imagenes_upc.tcin <> excluded.tcin or imagenes_upc.confirmado_en = ''`)
      .bind(upc, fuente.tcin, datos.image_url, datos.title.trim().slice(0, 200), datos.barcode, upc, fuente.tcin).run();
    const imagen = await imagenGuardada(upc, env);
    return imagen ? json({ imagen }) : json({ error: 'El enlace cambió. Vuelve a escanear.' }, 409);
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'búsqueda de imagen fallida', error: error instanceof Error ? error.message.slice(0, 200) : 'error desconocido' }));
    return json({ error: 'La búsqueda no respondió. Toma o sube una foto.' }, 502);
  }
}
