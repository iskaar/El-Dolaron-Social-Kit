import { VENDIBLE } from './catalogo.ts';
import { conClaude } from './analisis.ts';

const ahora = () => new Date().toISOString();
const resp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export async function procesarRecortes(env: Env): Promise<void> {
  const activa = await env.DB.prepare("select valor from config where clave='recortes_activo'").first<{ valor: string }>();
  if (activa?.valor !== '1') return;
  const { results } = await env.DB.prepare(`select p.id, p.foto_key from productos p indexed by productos_recortes_pendientes
    where p.recorte_estado is null and ${VENDIBLE} order by creado_en limit 20`).all<{ id: string; foto_key: string }>();
  for (const fila of results) {
    try {
      const foto = await env.FOTOS.get(fila.foto_key);
      if (!foto) throw new Error('Foto no encontrada en R2.');
      const salida = await (env.IMAGES as any).input(foto.body).transform({ segment: 'foreground' }).output({ format: 'image/webp', quality: 82 });
      const bytes = salida instanceof Response ? salida.body : salida.response().body;
      if (!bytes) throw new Error('Recorte vacío.');
      await env.FOTOS.put(`recortes/${fila.id}.webp`, bytes, { httpMetadata: { contentType: 'image/webp' } });
      await env.DB.prepare("update productos set recorte_estado='listo', recorte_fecha=? where id=? and recorte_estado is null").bind(ahora(), fila.id).run();
    } catch (error) {
      if (/9422/.test(String(error))) return;
      await env.DB.prepare("update productos set recorte_estado='error', recorte_fecha=? where id=? and recorte_estado is null").bind(ahora(), fila.id).run();
    }
  }
}

const ESQUEMA_REVISION = { type: 'object', properties: {
  ok: { type: 'boolean' }, problemas: { type: 'array', items: { type: 'string' } }, instruccion: { type: 'string' },
}, required: ['ok', 'problemas', 'instruccion'], additionalProperties: false };
const INSTRUCCION_REVISION = 'El magenta representa transparencia. El producto es el artículo principal de la foto. Marca como problema cualquier cosa visible que no sea el producto: gancho, exhibidor, prenda u objeto vecino, etiqueta de precio pegada que no sea del fabricante, mano, mesa o fondo; también partes del producto recortadas. La etiqueta colgante del fabricante es parte del producto. Una punta mínima de gancho que casi no se ve es aceptable. Devuelve ok, problemas con frases cortas en español e instruccion en inglés para un editor de imágenes que solo borre lo que estorba y no cambie el producto; instruccion debe estar vacía si ok.';
// Cada revisión es ~1 llamada a Haiku de hasta 11 s.
const LOTE_REVISION = 5;

export async function revisarRecortes(env: Env, llamarClaude = conClaude): Promise<void> {
  if (!env.ANTHROPIC_API_KEY) return;
  const activa = await env.DB.prepare("select valor from config where clave='recortes_activo'").first<{ valor: string }>();
  if (activa?.valor !== '1') return;
  const { results } = await env.DB.prepare(`select p.id, p.foto_key from productos p indexed by productos_recortes_por_revisar
    where p.recorte_estado='listo' and p.recorte_revision is null and p.propietario='dolaron' order by p.recorte_fecha desc limit ${LOTE_REVISION}`).all<{ id: string; foto_key: string }>();
  for (const fila of results) {
    try {
      const [foto, recorte] = await Promise.all([env.FOTOS.get(fila.foto_key), env.FOTOS.get(`recortes/${fila.id}.webp`)]);
      if (!foto || !recorte) throw new Error('Foto no encontrada en R2.');
      const salida = await (env.IMAGES as any).input(recorte.body).transform({ width: 512, background: '#FF00FF' }).output({ format: 'image/jpeg', quality: 80 });
      const imagen = salida instanceof Response ? salida.body : salida.response().body;
      if (!imagen) throw new Error('Recorte vacío.');
      const [original, aplastada] = await Promise.all([foto.arrayBuffer(), new Response(imagen).arrayBuffer()]);
      const base64 = (bytes: ArrayBuffer) => {
        const datos = new Uint8Array(bytes);
        let binario = '';
        for (let i = 0; i < datos.length; i += 0x8000) binario += String.fromCharCode(...datos.subarray(i, i + 0x8000));
        return btoa(binario);
      };
      const resultado = await llamarClaude([base64(original), base64(aplastada)], env, INSTRUCCION_REVISION, ESQUEMA_REVISION,
        'Primera imagen: foto original. Segunda imagen: recorte sobre fondo magenta. Revisa si el recorte conserva elementos ajenos o corta el producto.');
      const revision = resultado as { ok: boolean; problemas: string[]; instruccion: string };
      const valor = revision.ok ? 'ok' : JSON.stringify({ problemas: revision.problemas, instruccion: revision.instruccion });
      await env.DB.prepare("update productos set recorte_revision=? where id=? and recorte_estado='listo' and recorte_revision is null").bind(valor, fila.id).run();
    } catch (error) {
      if (/9422/.test(String(error))) return;
      // Sin marcar, la misma pieza encabezaría cada lote para siempre: pasa a revisión manual en /admin.
      await env.DB.prepare("update productos set recorte_revision=? where id=? and recorte_estado='listo' and recorte_revision is null")
        .bind(JSON.stringify({ problemas: ['No se pudo revisar automáticamente'], instruccion: '' }), fila.id).run();
    }
  }
}

export async function rutaRecortesAdmin(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname === '/api/recortes' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`select id,codigo,nombre,recorte_estado,recorte_fecha,recorte_revision from productos where propietario='dolaron' and recorte_estado in ('listo','error') order by (recorte_revision is not null and recorte_revision<>'ok') desc, recorte_fecha desc limit 60`).all();
    return resp(results);
  }
  // #419: el recorte sin aprobar no sale en el catálogo público, pero aquí hay que verlo para revisarlo.
  const img = pathname.match(/^\/api\/recortes\/([0-9a-f-]{36})\/imagen$/);
  if (img && request.method === 'GET') {
    const objeto = await env.FOTOS.get(`recortes/${img[1]}.webp`);
    if (!objeto) return resp({ error: 'Recorte no encontrado.' }, 404);
    return new Response(objeto.body, { headers: { 'content-type': 'image/webp', 'cache-control': 'private, no-store' } });
  }
  const m = pathname.match(/^\/api\/recortes\/([0-9a-f-]{36})\/(original|reintentar|aprobar)$/);
  if (!m || request.method !== 'POST') return null;
  const [, id, accion] = m;
  if (accion === 'aprobar') {
    const r = await env.DB.prepare("update productos set recorte_revision='ok' where id=? and propietario='dolaron' and recorte_estado='listo'").bind(id).run();
    return r.meta.changes ? resp({ ok: true }) : resp({ error: 'Recorte no encontrado.' }, 404);
  }
  const estado = accion === 'original' ? 'original' : null;
  const r = await env.DB.prepare("update productos set recorte_estado=?, recorte_fecha=?, recorte_revision=null where id=? and propietario='dolaron' and recorte_estado in ('listo','error')")
    .bind(estado, ahora(), id).run();
  if (!r.meta.changes) return resp({ error: 'Recorte no encontrado.' }, 404);
  if (accion === 'original') await env.FOTOS.delete(`recortes/${id}.webp`);
  return resp({ ok: true });
}

export async function reiniciarRecorte(env: Env, id: string): Promise<void> {
  await env.FOTOS.delete(`recortes/${id}.webp`);
  await env.DB.prepare("update productos set recorte_estado=case when recorte_estado='original' then 'original' else null end, recorte_fecha=null, recorte_revision=null where id=?").bind(id).run();
}
