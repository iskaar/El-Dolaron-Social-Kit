import { CAJAS } from './cuentas.ts';
import { cajaDe } from './corte.ts';
import { CATEGORIAS_GASTO } from '../public/categorias.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIAS = new Set(CATEGORIAS_GASTO.map(([clave]) => clave));
const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const texto = (valor: unknown, max: number) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const fechaValida = (valor: unknown): valor is string => {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const fecha = new Date(`${valor}T12:00:00Z`);
  return !Number.isNaN(fecha.valueOf()) && fecha.toISOString().slice(0, 10) === valor;
};

/**
 * Los gastos de un mes: los capturados mas los retiros de caja tipo gasto que no tienen su fila en `gastos`
 * (un gasto de caja existe en las dos tablas y cuenta una sola vez). Binds: desde, hasta (YYYY-MM-DD, hasta
 * excluido), `${desde}T00:00:00`, `${hasta}T00:00:00`. Lo reusa /api/tablero (#610).
 */
export const GASTOS_DEL_MES = `select id, fecha, categoria, importe, nota, origen, retiro_id, null as caja, creado_por, creado_en
           from gastos where fecha >= ? and fecha < ?
         union all
         select r.id, date(r.creado_en, '-6 hours'), coalesce(nullif(r.categoria, ''), 'sin_categoria'), r.importe,
                r.motivo, 'caja', null, r.caja, r.cajero, r.creado_en from retiros r
          where r.tipo = 'gasto' and datetime(r.creado_en) >= datetime(?, '+6 hours')
            and datetime(r.creado_en) < datetime(?, '+6 hours')
            and not exists (select 1 from gastos g where g.retiro_id = r.id)`;

/** Comprobante de un gasto (#770): solo estos tipos; la extension sale del tipo, nunca del nombre del archivo. */
const TIPOS_COMPROBANTE: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'application/xml': 'xml', 'text/xml': 'xml',
};
const TIPO_POR_EXT: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', xml: 'application/xml' };
const MAX_COMPROBANTE = 10 * 1024 * 1024;

async function borrarObjeto(env: Env, key: string | null | undefined) {
  if (!key) return;
  try { await env.FOTOS.delete(key); } catch (error) {
    console.error(JSON.stringify({ mensaje: 'no se pudo borrar el comprobante de R2', key, error: String(error).slice(0, 200) }));
  }
}

/** PUT/GET /api/gastos/:id/comprobante. Mismo permiso que /api/gastos (cuentas.ts); trae facturas con RFC, nunca en cache. */
async function rutaComprobante(request: Request, env: Env, id: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Gasto invalido.' }, 400);
  const gasto = await env.DB.prepare('select comprobante_key from gastos where id = ?').bind(id).first<{ comprobante_key: string | null }>();
  if (!gasto) return json({ error: 'Gasto no encontrado.' }, 404);

  if (request.method === 'GET') {
    const objeto = gasto.comprobante_key ? await env.FOTOS.get(gasto.comprobante_key) : null;
    if (!gasto.comprobante_key || !objeto) return json({ error: 'Este gasto no tiene comprobante.' }, 404);
    const tipo = TIPO_POR_EXT[gasto.comprobante_key.split('.').pop() ?? ''] ?? 'application/octet-stream';
    // Chrome no abre su visor de PDF bajo `sandbox`; el PDF ya viene de la lista blanca y va con nosniff.
    return new Response(objeto.body, { headers: {
      'content-type': tipo, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      ...(tipo === 'application/pdf' ? {} : { 'content-security-policy': 'sandbox' }),
      'content-disposition': tipo === 'application/xml' ? 'attachment' : 'inline',
    } });
  }

  if (request.method === 'PUT') {
    const tipo = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const ext = TIPOS_COMPROBANTE[tipo];
    if (!ext) return json({ error: 'El comprobante debe ser JPEG, PNG, WebP, PDF o XML.' }, 415);
    if (Number(request.headers.get('content-length')) > MAX_COMPROBANTE) return json({ error: 'El comprobante pesa mas de 10 MB.' }, 413);
    const datos = await request.arrayBuffer();
    if (datos.byteLength === 0 || datos.byteLength > MAX_COMPROBANTE) return json({ error: 'El comprobante esta vacio o pesa mas de 10 MB.' }, 413);
    const key = `gastos/${id}/${crypto.randomUUID()}.${ext}`;
    await env.FOTOS.put(key, datos, { httpMetadata: { contentType: TIPO_POR_EXT[ext] } });
    const resultado = await env.DB.prepare('update gastos set comprobante_key = ? where id = ?').bind(key, id).run();
    if (!resultado.meta.changes) { await borrarObjeto(env, key); return json({ error: 'Gasto no encontrado.' }, 404); }
    await borrarObjeto(env, gasto.comprobante_key);   // despues de apuntar al nuevo: si falla, queda huerfano, no roto
    return json({ id, con_comprobante: true });
  }
  return json({ error: 'Metodo no permitido.' }, 405);
}

export async function rutaGastos(request: Request, env: Env, url: URL, correo: string): Promise<Response> {
  const idComprobante = /^\/api\/gastos\/([^/]+)\/comprobante$/.exec(url.pathname)?.[1];
  if (idComprobante) return rutaComprobante(request, env, idComprobante);

  if (request.method === 'GET') {
    const mes = url.searchParams.get('mes') ?? '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return json({ error: 'Mes invalido.' }, 400);
    const desde = `${mes}-01`;
    const hasta = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)), 1)).toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      `select u.id, u.fecha, u.categoria, u.importe, u.nota, u.origen, u.retiro_id, u.caja, u.creado_por, u.creado_en,
              coalesce((select comprobante_key is not null from gastos g where g.id = u.id), 0) as con_comprobante
         from (${GASTOS_DEL_MES}) u order by u.fecha desc, u.creado_en desc`,
    ).bind(desde, hasta, `${desde}T00:00:00`, `${hasta}T00:00:00`).all<{
      id: string; fecha: string; categoria: string; importe: number; nota: string; origen: string;
      retiro_id: string | null; caja: string | null; creado_por: string; creado_en: string; con_comprobante: number;
    }>();
    const por_categoria = new Map<string, number>();
    for (const gasto of results) por_categoria.set(gasto.categoria, (por_categoria.get(gasto.categoria) ?? 0) + gasto.importe);
    const total = results.reduce((suma, gasto) => suma + gasto.importe, 0);
    return json({ gastos: results.map((g) => ({ ...g, con_comprobante: g.con_comprobante === 1 })), por_categoria: [...por_categoria].map(([categoria, importe]) => ({ categoria, importe })), total });
  }

  if (request.method === 'POST' && url.pathname === '/api/gastos') {
    const cuerpo = await request.json().catch(() => ({})) as Record<string, unknown>;
    // El id lo pone la pantalla: un reintento con el mismo id no duplica el gasto ni su retiro.
    const id = typeof cuerpo.id === 'string' && UUID.test(cuerpo.id) ? cuerpo.id : crypto.randomUUID();
    const origen = cuerpo.origen;
    const categoria = String(cuerpo.categoria ?? '');
    const importe = Number(cuerpo.importe);
    const nota = texto(cuerpo.nota, 200);
    const fecha = cuerpo.fecha;
    if (!fechaValida(fecha)) return json({ error: 'Fecha invalida.' }, 400);
    if (!CATEGORIAS.has(categoria)) return json({ error: 'Categoría invalida.' }, 400);
    if (!Number.isInteger(importe) || importe <= 0 || importe > 10_000_000) return json({ error: 'Importe invalido.' }, 400);
    if (origen !== 'caja' && origen !== 'fuera') return json({ error: 'Origen invalido.' }, 400);
    const creadoEn = new Date().toISOString();
    const sentencias = [];
    let retiroId: string | null = null;
    if (origen === 'caja') {
      if (!cuerpo.caja) return json({ error: 'Falta la caja.' }, 400);
      const caja = await cajaDe(env, correo, cuerpo.caja);
      if (!CAJAS.includes(caja)) return json({ error: 'Caja invalida.' }, 400);
      retiroId = id;   // tablas distintas: el mismo UUID amarra el gasto con su retiro
      sentencias.push(env.DB.prepare(
        `insert into retiros (id, tipo, caja, cajero, importe, motivo, corte_id, creado_en, categoria)
         values (?, 'gasto', ?, ?, ?, ?, null, ?, ?) on conflict (id) do nothing`,
      ).bind(retiroId, caja, correo, importe, nota || CATEGORIAS_GASTO.find(([clave]) => clave === categoria)?.[1], creadoEn, categoria));
    }
    sentencias.push(env.DB.prepare(
      `insert into gastos (id, fecha, categoria, importe, nota, origen, retiro_id, creado_por, creado_en)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (id) do nothing`,
    ).bind(id, fecha, categoria, importe, nota, origen, retiroId, correo, creadoEn));
    await env.DB.batch(sentencias);
    return json({ id, fecha, categoria, importe, nota, origen, retiro_id: retiroId }, 201);
  }

  const id = /^\/api\/gastos\/([^/]+)$/.exec(url.pathname)?.[1];
  if (request.method === 'DELETE' && id && UUID.test(id)) {
    const previo = await env.DB.prepare("select comprobante_key from gastos where id = ? and origen = 'fuera'").bind(id).first<{ comprobante_key: string | null }>();
    const resultado = await env.DB.prepare("delete from gastos where id = ? and origen = 'fuera'").bind(id).run();
    if (!resultado.meta.changes) return json({ error: 'Solo se pueden borrar gastos pagados fuera.' }, 400);
    await borrarObjeto(env, previo?.comprobante_key);
    return json({ id });
  }
  return json({ error: 'Metodo no permitido.' }, 405);
}
