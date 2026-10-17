import { VENDIBLE } from './catalogo.ts';

const ahora = () => new Date().toISOString();
const resp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export async function procesarRecortes(env: Env): Promise<void> {
  const activa = await env.DB.prepare("select valor from config where clave='recortes_activo'").first<{ valor: string }>();
  if (activa?.valor !== '1') return;
  const { results } = await env.DB.prepare(`select id, foto_key from productos indexed by productos_recortes_pendientes
    where recorte_estado is null and ${VENDIBLE} order by creado_en limit 20`).all<{ id: string; foto_key: string }>();
  for (const fila of results) {
    try {
      const foto = await env.FOTOS.get(fila.foto_key);
      if (!foto) throw new Error('Foto no encontrada en R2.');
      const salida = await (env.IMAGES as any).input(foto.body).transform({ segment: 'foreground' }).output({ format: 'image/webp', quality: 82 });
      const bytes = salida instanceof Response ? salida.body : salida.response().body;
      await env.FOTOS.put(`recortes/${fila.id}.webp`, bytes, { httpMetadata: { contentType: 'image/webp' } });
      await env.DB.prepare("update productos set recorte_estado='listo', recorte_fecha=? where id=? and recorte_estado is null").bind(ahora(), fila.id).run();
    } catch (error) {
      if (/9422/.test(String(error))) return;
      await env.DB.prepare("update productos set recorte_estado='error', recorte_fecha=? where id=? and recorte_estado is null").bind(ahora(), fila.id).run();
    }
  }
}

export async function rutaRecortesAdmin(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname === '/api/recortes' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`select id,codigo,nombre,recorte_estado,recorte_fecha from productos where propietario='dolaron' and recorte_estado in ('listo','error') order by recorte_fecha desc limit 60`).all();
    return resp(results);
  }
  const m = pathname.match(/^\/api\/recortes\/([0-9a-f-]{36})\/(original|reintentar)$/);
  if (!m || request.method !== 'POST') return null;
  const [, id, accion] = m;
  const estado = accion === 'original' ? 'original' : null;
  const r = await env.DB.prepare("update productos set recorte_estado=?, recorte_fecha=? where id=? and propietario='dolaron' and recorte_estado in ('listo','error')")
    .bind(estado, ahora(), id).run();
  if (!r.meta.changes) return resp({ error: 'Recorte no encontrado.' }, 404);
  if (accion === 'original') await env.FOTOS.delete(`recortes/${id}.webp`);
  return resp({ ok: true });
}

export async function reiniciarRecorte(env: Env, id: string): Promise<void> {
  await env.FOTOS.delete(`recortes/${id}.webp`);
  await env.DB.prepare("update productos set recorte_estado=case when recorte_estado='original' then 'original' else null end, recorte_fecha=null where id=?").bind(id).run();
}
