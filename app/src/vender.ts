/** Vender por WhatsApp (#431): lecturas acotadas e interesados sin reservar existencias. */
import { VENDIBLE } from './catalogo.ts';
import { CLAVES_CATEGORIA } from '../public/categorias.js';
import { telefonoInteresado } from '../public/vender.js';

const PAGINA = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const desdeInteresados = () => new Date(Date.now() - 7 * 86_400_000).toISOString();
const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

interface Cursor { fecha: string; fila: number }
function leerCursor(valor: string | null): Cursor | null {
  if (valor === null) return null;
  const m = /^([^~]{0,40})~([1-9]\d{0,15})$/.exec(valor);
  if (!m || (m[1] && !Number.isFinite(Date.parse(m[1]))) || !Number.isSafeInteger(Number(m[2]))) return null;
  return { fecha: m[1], fila: Number(m[2]) };
}
const cursorDe = (p: { creado_en: string; fila: number }) => `${p.creado_en}~${p.fila}`;

interface Pieza {
  fila: number; id: string; codigo: string; nombre: string; marca: string; talla: string | null;
  categoria: string; precio: number; precio_lista: number; estado_fisico: string; creado_en: string;
  recorte_estado: string | null; recorte_revision: string | null; elegible: number;
}
interface Interesado {
  id: string; producto_id: string; cliente: string; telefono: string; nota: string;
  vendedora: string; estado: string; creado_en: string; actualizado_en: string;
}

async function listarPiezas(env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  const categoria = url.searchParams.get('categoria');
  const hoy = url.searchParams.get('hoy');
  let cursor = leerCursor(url.searchParams.get('cursor'));
  if (q.length > 80 || (categoria !== null && !CLAVES_CATEGORIA.includes(categoria))
      || (hoy !== null && hoy !== '1') || (url.searchParams.has('cursor') && !cursor)) {
    return json({ error: 'Filtros o cursor inválidos.' }, 400);
  }
  const dia = new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 10);
  const apertura = `${dia}T06:00:00.000Z`;
  const cierre = new Date(Date.parse(apertura) + 86_400_000).toISOString();
  const codigo = /^ED-\d{1,10}$/i.test(q) ? q.toUpperCase() : null;
  const piezas: Pieza[] = [];
  let hayMas = false;
  // Un nombre inexistente tampoco recorre toda productos: máximo 240 candidatas por petición.
  // El cursor avanza aun en un tramo sin coincidencias; la pantalla permite seguir buscando.
  for (let tramo = 0; tramo < 10 && piezas.length < PAGINA; tramo++) {
    const { results } = await env.DB.prepare(`select p.rowid as fila, p.id, p.codigo, p.nombre, p.marca,
        p.talla, p.categoria, p.precio, p.precio_lista, p.estado_fisico, p.creado_en,
        p.recorte_estado, p.recorte_revision,
        (${VENDIBLE} ${categoria ? 'and p.categoria = ?' : ''}
          ${q && !codigo ? "and instr(lower(p.nombre), lower(?)) > 0" : ''}) as elegible
      from productos p ${codigo ? '' : 'indexed by productos_propietario_creado'}
      where p.propietario = 'dolaron' ${codigo ? 'and p.codigo = ?' : ''}
        ${hoy ? 'and p.creado_en >= ? and p.creado_en < ?' : ''}
        ${cursor ? 'and (p.creado_en, p.rowid) < (?, ?)' : ''}
      order by p.creado_en desc, p.rowid desc limit ?`)
      .bind(...(categoria ? [categoria] : []), ...(q && !codigo ? [q] : []), ...(codigo ? [codigo] : []),
        ...(hoy ? [apertura, cierre] : []), ...(cursor ? [cursor.fecha, cursor.fila] : []), PAGINA)
      .all<Pieza>();
    hayMas = results.length === PAGINA;
    for (let i = 0; i < results.length; i++) {
      const p = results[i];
      cursor = { fecha: p.creado_en, fila: p.fila };
      if (p.elegible) piezas.push(p);
      if (piezas.length === PAGINA) { hayMas ||= i < results.length - 1; break; }
    }
    if (!hayMas) break;
  }
  // Una consulta para las 24 piezas; el índice empieza por producto y estado.
  const interesados = piezas.length ? (await env.DB.prepare(`select i.producto_id, i.cliente, i.vendedora,
      coalesce(nullif(u.nombre, ''), i.vendedora) as vendedora_nombre, i.creado_en
    from interesados i indexed by interesados_producto_estado left join usuarios u on u.correo = i.vendedora
    where i.producto_id in (${piezas.map(() => '?').join(',')}) and i.estado = 'abierto' and i.creado_en >= ?
    order by i.creado_en, i.rowid`).bind(...piezas.map((p) => p.id), desdeInteresados())
    .all<{ producto_id: string; cliente: string; vendedora: string; vendedora_nombre: string; creado_en: string }>()).results : [];
  return json({ piezas: piezas.map(({ fila, elegible, recorte_estado, recorte_revision, ...p }) => {
    const cola = interesados.filter((i) => i.producto_id === p.id).map(({ producto_id, ...i }) => i);
    return { ...p, foto: recorte_estado === 'listo' && recorte_revision === 'ok'
      ? `/api/recortes/${p.id}/imagen` : `/api/foto/${p.id}`, interesados: cola.length, cola };
  }), siguiente: hayMas && cursor ? `${cursor.fecha}~${cursor.fila}` : null });
}

async function listarInteresados(env: Env, url: URL, correo: string): Promise<Response> {
  const mios = url.searchParams.get('mios');
  const cursor = leerCursor(url.searchParams.get('cursor'));
  if ((mios !== null && mios !== '1') || (url.searchParams.has('cursor') && !cursor))
    return json({ error: 'Filtros o cursor inválidos.' }, 400);
  const { results } = await env.DB.prepare(`select i.rowid as fila, i.*,
      coalesce(nullif(u.nombre, ''), i.vendedora) as vendedora_nombre,
      p.codigo, p.nombre, p.precio,
      case when p.stock > 0 then 'Disponible'
        when exists (select 1 from pedido_lineas l join pedidos d on d.id = l.pedido_id
          where l.producto_id = p.id and d.estado = 'apartado') then 'Apartada'
        else 'Vendida' end as disponibilidad
    from interesados i indexed by ${mios ? 'interesados_vendedora' : 'interesados_estado'}
    join productos p on p.id = i.producto_id left join usuarios u on u.correo = i.vendedora
    where i.estado = 'abierto' and i.creado_en >= ? and p.propietario = 'dolaron'
      ${mios ? 'and i.vendedora = ?' : ''} ${cursor ? 'and (i.creado_en, i.rowid) > (?, ?)' : ''}
    order by i.creado_en, i.rowid limit ?`)
    .bind(desdeInteresados(), ...(mios ? [correo] : []), ...(cursor ? [cursor.fecha, cursor.fila] : []), PAGINA + 1)
    .all<Interesado & { fila: number }>();
  return json({ interesados: results.slice(0, PAGINA).map(({ fila, ...i }) => i),
    siguiente: results.length > PAGINA ? cursorDe(results[PAGINA - 1]) : null });
}

const textoValido = (valor: unknown, max: number): valor is string =>
  typeof valor === 'string' && valor.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(valor);

async function crearInteresado(request: Request, env: Env, correo: string): Promise<Response> {
  const c = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.id !== 'string' || !UUID.test(c.id)
      || typeof c.producto_id !== 'string' || !UUID.test(c.producto_id)
      || !textoValido(c.cliente, 80) || !c.cliente.trim() || !textoValido(c.nota ?? '', 500))
    return json({ error: 'Escribe cliente (hasta 80 caracteres), pieza e identificador válidos; nota hasta 500.' }, 400);
  const telefono = telefonoInteresado(c.telefono ?? '');
  if (telefono === null) return json({ error: 'El teléfono es opcional; si lo escribes debe tener 10 dígitos.' }, 400);
  const cliente = c.cliente.trim().replace(/\s+/g, ' ');
  const nota = String(c.nota ?? '').trim();
  const leer = () => env.DB.prepare('select * from interesados where id = ?').bind(c.id).first<Interesado>();
  const responder = (i: Interesado, status = 200) =>
    i.vendedora === correo && i.producto_id === c.producto_id && i.cliente === cliente && i.telefono === telefono && i.nota === nota
      ? json({ interesado: i }, status) : json({ error: 'El identificador ya corresponde a otro registro.' }, 409);
  const previo = await leer();
  if (previo) return responder(previo);
  const pieza = await env.DB.prepare("select id from productos where id = ? and propietario = 'dolaron'")
    .bind(c.producto_id).first();
  if (!pieza) return json({ error: 'Pieza no encontrada.' }, 404);
  const ahora = new Date().toISOString();
  const r = await env.DB.prepare(`insert into interesados
      (id, producto_id, cliente, telefono, nota, vendedora, creado_en, actualizado_en)
    select ?, p.id, ?, ?, ?, ?, ?, ? from productos p where p.id = ? and ${VENDIBLE}
    on conflict (id) do nothing`).bind(c.id, cliente, telefono, nota, correo, ahora, ahora, c.producto_id).run();
  const guardado = await leer();
  return guardado ? responder(guardado, r.meta.changes ? 201 : 200)
    : json({ error: 'La pieza ya no está disponible para ofrecer. Actualiza la lista.' }, 409);
}

async function descartarInteresado(request: Request, env: Env, id: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador inválido.' }, 400);
  const cuerpo = await request.json().catch(() => null) as { estado?: unknown } | null;
  if (!cuerpo || cuerpo.estado !== 'descartado' || Object.keys(cuerpo).some((k) => k !== 'estado'))
    return json({ error: 'Solo se puede descartar el interesado.' }, 400);
  // Toda la caja ve y puede cerrar la cola compartida. Nunca reabre ni altera el cliente.
  await env.DB.prepare(`update interesados set estado = 'descartado', actualizado_en = ?
    where id = ? and estado = 'abierto'
      and exists (select 1 from productos p where p.id = interesados.producto_id and p.propietario = 'dolaron')`)
    .bind(new Date().toISOString(), id).run();
  const i = await env.DB.prepare(`select i.* from interesados i join productos p on p.id = i.producto_id
    where i.id = ? and p.propietario = 'dolaron'`).bind(id).first<Interesado>();
  return i ? json({ interesado: i }) : json({ error: 'Interesado no encontrado.' }, 404);
}

/** La identidad y el permiso de caja se resuelven antes, en worker.ts/cuentas.ts. */
export async function rutaVender(request: Request, env: Env, url: URL, correo: string): Promise<Response | null> {
  const { pathname } = url;
  const detalle = /^\/api\/interesados\/([^/]+)$/.exec(pathname);
  if (pathname === '/api/vender' && request.method === 'GET') return listarPiezas(env, url);
  if (pathname === '/api/interesados') {
    if (request.method === 'GET') return listarInteresados(env, url, correo);
    if (request.method === 'POST') return crearInteresado(request, env, correo);
  }
  if (detalle && request.method === 'PATCH') return descartarInteresado(request, env, detalle[1]);
  return pathname === '/api/vender' || pathname === '/api/interesados' || detalle
    ? json({ error: 'Método no permitido.' }, 405) : null;
}
