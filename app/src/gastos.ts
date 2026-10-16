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

export async function rutaGastos(request: Request, env: Env, url: URL, correo: string): Promise<Response> {
  if (request.method === 'GET') {
    const mes = url.searchParams.get('mes') ?? '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return json({ error: 'Mes invalido.' }, 400);
    const desde = `${mes}-01`;
    const hasta = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)), 1)).toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      `select id, fecha, categoria, importe, nota, origen, retiro_id, caja, creado_por, creado_en from (
         select id, fecha, categoria, importe, nota, origen, retiro_id, null as caja, creado_por, creado_en
           from gastos where fecha >= ? and fecha < ?
         union all
         select r.id, date(r.creado_en, '-6 hours'), coalesce(nullif(r.categoria, ''), 'sin_categoria'), r.importe,
                r.motivo, 'caja', null, r.caja, r.cajero, r.creado_en from retiros r
          where r.tipo = 'gasto' and datetime(r.creado_en) >= datetime(?, '+6 hours')
            and datetime(r.creado_en) < datetime(?, '+6 hours')
            and not exists (select 1 from gastos g where g.retiro_id = r.id)
       ) order by fecha desc, creado_en desc`,
    ).bind(desde, hasta, `${desde}T00:00:00`, `${hasta}T00:00:00`).all<{
      id: string; fecha: string; categoria: string; importe: number; nota: string; origen: string;
      retiro_id: string | null; caja: string | null; creado_por: string; creado_en: string;
    }>();
    const por_categoria = new Map<string, number>();
    for (const gasto of results) por_categoria.set(gasto.categoria, (por_categoria.get(gasto.categoria) ?? 0) + gasto.importe);
    const total = results.reduce((suma, gasto) => suma + gasto.importe, 0);
    return json({ gastos: results, por_categoria: [...por_categoria].map(([categoria, importe]) => ({ categoria, importe })), total });
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
    const resultado = await env.DB.prepare("delete from gastos where id = ? and origen = 'fuera'").bind(id).run();
    return resultado.meta.changes ? json({ id }) : json({ error: 'Solo se pueden borrar gastos pagados fuera.' }, 400);
  }
  return json({ error: 'Metodo no permitido.' }, 405);
}
