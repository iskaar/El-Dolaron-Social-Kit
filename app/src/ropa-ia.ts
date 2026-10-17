import { analizarFotoRopa, type SugerenciaRopa } from './analisis.ts';
import { MARCAS_ROPA, PRECIO_PRENDA } from '../public/ropa.js';

const ahora = () => new Date().toISOString();
const resp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
type EnvRopa = Env & { DB: D1Database; FOTOS: R2Bucket };

export async function procesarColaRopa(env: EnvRopa, analizar = analizarFotoRopa): Promise<void> {
  const activa = await env.DB.prepare("select valor from config where clave='ropa_ia_activo'").first<{ valor: string }>();
  if (activa?.valor !== '1') return;
  const { results } = await env.DB.prepare(`select id, precio, ropa_ia_sugerencia from productos indexed by productos_ropa_ia_pendiente
    where ropa_ia_estado is null and categoria='ropa' and nombre='Ropa' and foto_key<>'' and stock>0
    order by creado_en limit 10`).all<{ id: string; precio: number; ropa_ia_sugerencia: string | null }>();
  const { results: marcas } = await env.DB.prepare("select distinct marca from productos where categoria='ropa' and marca<>'' limit 200").all<{ marca: string }>();
  const conocidas = new Set([...MARCAS_ROPA, ...marcas.map((m) => m.marca.toLocaleLowerCase())].map((m) => m.toLocaleLowerCase()));
  for (const fila of results) {
    const anterior = fila.ropa_ia_sugerencia ? JSON.parse(fila.ropa_ia_sugerencia) : {};
    const intentos = Number(anterior.intentos || 0);
    try {
      const foto = await env.FOTOS.get(`fotos/${fila.id}.jpg`);
      if (!foto) throw new Error('Foto no encontrada en R2.');
      const s = await analizar(await foto.arrayBuffer(), env);
      const banderas: string[] = [];
      if (!s.prenda) banderas.push('sin_prenda');
      if (s.prenda && fila.precio !== PRECIO_PRENDA[s.prenda] && !(s.prenda === 'Suéter' && fila.precio === 30000)) banderas.push('precio_no_coincide');
      if (s.marca && !conocidas.has(s.marca.toLocaleLowerCase())) banderas.push('marca_desconocida');
      const suggestion = { ...s, banderas, intentos: intentos + 1 };
      const aplicar = !!s.prenda && s.prenda_confianza !== 'baja' && banderas.length === 0;
      // La marca solo entra si se leyó con confianza alta; las banderas siempre requieren revisión.
      const marca = s.marca_confianza === 'alta' && s.marca ? s.marca : '';
      const nombre = [s.prenda, marca].filter(Boolean).join(' ');
      const estado = aplicar && !banderas.length && s.prenda_confianza === 'alta' && (!s.marca || s.marca_confianza === 'alta') ? 'aplicado' : 'revisar';
      await env.DB.prepare(`update productos set ropa_ia_estado=?, ropa_ia_sugerencia=?, ropa_ia_fecha=?
        ${aplicar ? ', nombre=?, marca=?' : ''} where id=? and ropa_ia_estado is null and nombre='Ropa' and categoria='ropa' and stock>0`)
        .bind(estado, JSON.stringify(suggestion), ahora(), ...(aplicar ? [nombre, marca] : []), fila.id).run();
    } catch (error) {
      const nuevoIntento = intentos + 1;
      const sugerencia = JSON.stringify({ ...anterior, banderas: anterior.banderas || [], motivo: String(error).slice(0, 120), intentos: nuevoIntento });
      await env.DB.prepare(`update productos set ropa_ia_estado=?, ropa_ia_sugerencia=?, ropa_ia_fecha=? where id=? and ropa_ia_estado is null`)
        .bind(nuevoIntento >= 3 ? 'error' : null, sugerencia, ahora(), fila.id).run();
    }
  }
}

export async function rutaRopaAdmin(request: Request, env: EnvRopa, pathname: string): Promise<Response | null> {
  if (pathname === '/api/ropa-ia' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`select id,nombre,marca,precio,ropa_ia_estado,ropa_ia_sugerencia,ropa_ia_fecha
      from productos where ropa_ia_estado='revisar' and categoria='ropa' order by ropa_ia_fecha limit 200`).all();
    return resp(results);
  }
  const match = pathname.match(/^\/api\/ropa-ia\/([0-9a-f-]{36})\/(aceptar|corregir|descartar)$/);
  if (!match || request.method !== 'POST') return null;
  const [, id, accion] = match;
  const fila = await env.DB.prepare("select nombre, marca, ropa_ia_sugerencia from productos where id=? and categoria='ropa' and ropa_ia_estado='revisar'").bind(id).first<{ nombre:string; marca:string; ropa_ia_sugerencia:string }>();
  if (!fila) return resp({ error: 'La sugerencia no está pendiente de revisión.' }, 409);
  const s = JSON.parse(fila.ropa_ia_sugerencia) as SugerenciaRopa & { intentos:number };
  if (accion === 'descartar') await env.DB.prepare("update productos set ropa_ia_estado='descartado', ropa_ia_fecha=? where id=? and ropa_ia_estado='revisar'").bind(ahora(), id).run();
  else {
    const cuerpo = accion === 'corregir' ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
    const prenda = accion === 'corregir' ? String(cuerpo.prenda ?? '').trim() : s.prenda;
    const marca = accion === 'corregir' ? String(cuerpo.marca ?? '').trim() : s.marca_confianza === 'alta' ? s.marca : '';
    if (!Object.keys(PRECIO_PRENDA).includes(prenda) || marca.length > 40 || /[\r\n]/.test(marca)) return resp({ error: 'Prenda o marca inválida.' }, 400);
    await env.DB.prepare("update productos set nombre=?, marca=?, ropa_ia_estado='aceptado', ropa_ia_fecha=? where id=? and ropa_ia_estado='revisar'")
      .bind([prenda, marca].filter(Boolean).join(' '), marca, ahora(), id).run();
  }
  return resp({ ok: true });
}
