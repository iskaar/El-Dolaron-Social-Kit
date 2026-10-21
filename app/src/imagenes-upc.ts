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

async function leerJson(cuerpo: ReadableStream<Uint8Array> | null, maximo: number) {
  if (!cuerpo) throw new Error('Falta el cuerpo JSON.');
  const lector = cuerpo.getReader(), partes: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await lector.read();
    if (done) break;
    bytes += value.length;
    if (bytes > maximo) { await lector.cancel(); throw new Error('Cuerpo JSON demasiado grande.'); }
    partes.push(value);
  }
  return JSON.parse(await new Blob(partes).text());
}

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
export async function rutaImagenUpc(request: Request, env: Env, pathname: string, correo: string): Promise<Response | null> {
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
    return foto ? new Response(foto.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' } })
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
    return meta.changes ? json({ imagen: await imagenGuardada(upc, env) }) : json({ error: 'La imagen cambió. Vuelve a buscarla.' }, 409);
  }

  if (!env.SCRAPLING_URL || !env.SCRAPLING_TOKEN) return json({ error: 'La búsqueda de imágenes no está configurada. Toma o sube una foto.' }, 503);
  try {
    const servicio = new URL(env.SCRAPLING_URL);
    if (servicio.username || servicio.password || servicio.search || servicio.hash) return json({ error: 'La búsqueda de imágenes no está configurada.' }, 503);
    if (servicio.protocol !== 'https:' && !(String(env.ACCESS_EQUIPO) === 'local' && servicio.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(servicio.hostname))) {
      return json({ error: 'La búsqueda de imágenes no está configurada.' }, 503);
    }
    const respuesta = await fetch(servicio, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(35_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.SCRAPLING_TOKEN}` },
      body: JSON.stringify({ url: enlace(fuente.tcin), barcode: upc }),
    });
    if (!respuesta.ok) {
      await respuesta.body?.cancel();
      return json({ error: 'No se pudo obtener una imagen del proveedor. Toma o sube una foto.' }, respuesta.status === 422 ? 422 : 502);
    }
    const datos = await leerJson(respuesta.body, 16_384) as { image_url?: unknown; title?: unknown; barcode?: unknown };
    if (!imagenValida(datos.image_url) || typeof datos.title !== 'string' || !datos.title.trim()
      || (datos.barcode && normalizarUpc(datos.barcode) !== upc)) {
      return json({ error: 'La página no tiene una imagen válida para este código. Toma o sube una foto.' }, 422);
    }
    // Si cambió la hoja o alguien confirmó mientras llegaba HTTP, no se pisa su decisión.
    await env.DB.prepare(`insert into imagenes_upc (upc, tcin, url, nombre, upc_fuente)
      select ?, ?, ?, ?, ? where exists (select 1 from manifiesto where upc = ? and tcin = ?)
      on conflict (upc) do update set tcin = excluded.tcin, url = excluded.url, nombre = excluded.nombre,
        upc_fuente = excluded.upc_fuente, confirmado_por = '', confirmado_en = ''
      where imagenes_upc.tcin <> excluded.tcin or imagenes_upc.confirmado_en = ''`)
      .bind(upc, fuente.tcin, datos.image_url, datos.title.trim().slice(0, 200), typeof datos.barcode === 'string' ? datos.barcode : '', upc, fuente.tcin).run();
    const imagen = await imagenGuardada(upc, env);
    return imagen ? json({ imagen }) : json({ error: 'El enlace cambió. Vuelve a escanear.' }, 409);
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'búsqueda de imagen fallida', error: error instanceof Error ? error.message.slice(0, 200) : 'error desconocido' }));
    return json({ error: 'La búsqueda no respondió. Toma o sube una foto.' }, 502);
  }
}
