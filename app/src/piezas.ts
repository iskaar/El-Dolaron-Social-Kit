/** Consulta y ajuste de inventario con rastro (#441). */
import { propietarioDe, puedeEditarInventario, type Usuario } from './cuentas.ts';
import { MOTIVOS } from './conteo.ts';
import { conciliarSeguro } from './mercadolibre.ts';
import { pendienteDe } from './solicitudes-precio.ts';
import { UPC_VISIBLE, repetidaUpc } from './upc-inventario.ts';
import { normalizarUpc } from '../public/upc.js';

const PAGINA = 25;
const TRAMO = 200;
const HISTORIAL = 50;   // renglones de la ficha: ajustes de existencia (máx. 10) y cambios de campo
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// Copiados de agent/codex/431-vender; main aún no tiene estos helpers.
interface Cursor { fecha: string; fila: number }
function leerCursor(valor: string | null): Cursor | null {
  if (valor === null) return null;
  const m = /^([^~]{0,40})~([1-9]\d{0,15})$/.exec(valor);
  if (!m || (m[1] && !Number.isFinite(Date.parse(m[1]))) || !Number.isSafeInteger(Number(m[2]))) return null;
  return { fecha: m[1], fila: Number(m[2]) };
}
const cursorDe = (p: { creado_en: string; fila: number }) => `${p.creado_en}~${p.fila}`;

interface Pieza {
  id: string; codigo: string | null; nombre: string; marca: string; talla: string | null;
  categoria: string; precio: number; precio_lista: number; stock: number; destino: string;
  estado_fisico: string; estado_analisis: string; upc: string | null; tiene_foto: number;
  creado_en: string; actualizado_en: string;
}
type Candidata = Pieza & { fila: number; elegible: number };
const COLUMNAS = `p.id, p.codigo, p.nombre, p.marca, p.talla, p.categoria, p.precio, p.precio_lista,
  p.stock, p.destino, p.estado_fisico, p.estado_analisis, p.upc, p.foto_key <> '' as tiene_foto,
  p.creado_en, p.actualizado_en`;
const VISIBLE = "p.sin_inventario = 0 and p.estado_analisis <> 'descartado'";
const publica = ({ fila, elegible, ...p }: Candidata) => p;

/**
 * ¿Puede esta persona fijar el precio de esta pieza directamente? (#479, decisión de Isaac en #478.) El dueño siempre.
 * Las demás solo mientras la pieza no tiene etiqueta (`codigo`): el precio de una captura sin etiquetar es parte de la
 * captura. `preciadaPorSistema` (alta por UPC: el precio sale del manifiesto) lo deja solo al dueño aunque aún no tenga código.
 * Quien no pueda, pide el cambio con una solicitud de precio (solicitudes-precio.ts). Un rol «supervisor» se suma en la línea del dueño.
 */
export const autorizarPrecio = (usuario: Usuario | null, pieza: { codigo: string | null; preciadaPorSistema?: boolean }): boolean =>
  (!!usuario?.activo && usuario.roles.includes('dueno')) || (!pieza.codigo && !pieza.preciadaPorSistema);

/** Se inspeccionan 80 candidatas por página, también cuando no hay ninguna repetida. */
async function piezasRepetidas(env: Env, url: URL, usuario: Usuario | null): Promise<Response> {
  if (!puedeEditarInventario(usuario)) return json({ error:'Tu cuenta no tiene permiso para editar inventario.' }, 403);
  let cursor: [string,string,string,number] | null = null;
  const crudo = url.searchParams.get('cursor');
  if (crudo !== null) {
    try { cursor = JSON.parse(crudo); } catch { /* se valida abajo */ }
    if (!Array.isArray(cursor) || cursor.length !== 4 || typeof cursor[0] !== 'string' || cursor[0].length > 80
        || !['nuevo','danado','liquidacion'].includes(cursor[1]) || typeof cursor[2] !== 'string' || cursor[2].length > 80
        || !Number.isSafeInteger(cursor[3]) || cursor[3] < 1)
      return json({ error:'Cursor inválido.' }, 400);
  }
  const propietario = propietarioDe(usuario);
  const { results } = await env.DB.prepare(`select ${COLUMNAS}, p.rowid as fila, ltrim(p.upc, '0') as clave, coalesce(p.codigo, '') as etiqueta,
      exists (select 1 from productos r indexed by productos_upc_grado where r.sin_inventario = 0
        and r.estado_analisis <> 'descartado' and r.upc is not null and r.upc <> ''
        and r.propietario = p.propietario and ltrim(r.upc, '0') = ltrim(p.upc, '0')
        and r.estado_fisico = p.estado_fisico and r.id <> p.id) as repetida
    from productos p indexed by productos_upc_grado where p.propietario = ? and ${UPC_VISIBLE}
      ${cursor ? "and ltrim(p.upc, '0') >= ? and (ltrim(p.upc, '0'), p.estado_fisico, coalesce(p.codigo, ''), p.rowid) > (?, ?, ?, ?)" : ''}
    order by ltrim(p.upc, '0'), p.estado_fisico, coalesce(p.codigo, ''), p.rowid limit 81`)
    .bind(propietario, ...(cursor ? [cursor[0],...cursor] : [])).all<Pieza & { fila:number; clave:string; etiqueta:string; repetida:number }>();
  const lote = results.slice(0,80), grupos = new Map<string,{upc:string;estado_fisico:string;piezas:Partial<Pieza>[];destino_id:string}>();
  for (const { fila: _fila, etiqueta: _etiqueta, clave, repetida, ...p } of lote) {
    if (!repetida || !normalizarUpc(clave)) continue;
    const key = `${clave}~${p.estado_fisico}`;
    if (!grupos.has(key)) grupos.set(key,{upc:clave,estado_fisico:p.estado_fisico,piezas:[],destino_id:''});
    grupos.get(key)!.piezas.push(p);
  }
  // Claves contiguas: a lo sumo 41 grupos y una consulta indexada por destino.
  for (const g of grupos.values()) {
    const destino = await repetidaUpc(env,g.upc,g.estado_fisico,propietario);
    if (destino) {
      g.destino_id = destino.id;
      if (!g.piezas.some(p => p.id === destino.id)) g.piezas.unshift(destino);
    }
  }
  const ultima = lote.at(-1);
  return json({ grupos:[...grupos.values()], siguiente:results.length > 80 && ultima
    ? JSON.stringify([ultima.clave,ultima.estado_fisico,ultima.etiqueta,ultima.fila]) : null });
}

async function buscarPiezas(env: Env, url: URL, propietario: string): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  const ed = /^ed-?(\d{1,10})$/i.exec(q);
  const digitos = /^\d{1,14}$/.test(q);
  const codigo = ed ? `ED-${ed[1].padStart(6, '0')}` : digitos && q.length <= 6 ? `ED-${q.padStart(6, '0')}` : null;
  const upc = digitos && q.length >= 6 ? q.replace(/^0+/, '') || '0' : null;
  const crudo = url.searchParams.get('cursor');
  let cursor = leerCursor(crudo);
  // UPC recorre (upc, rowid), texto recorre (creado_en, rowid); ambos sin offset.
  if (upc && crudo !== null) {
    const m = /^(\d{1,14})~([1-9]\d{0,15})$/.exec(crudo);
    cursor = m && Number.isSafeInteger(Number(m[2])) ? { fecha: m[1], fila: Number(m[2]) } : null;
  }
  if (q.length > 80 || (q && !codigo && !upc && q.length < 3) || (crudo !== null && !cursor))
    return json({ error: 'Escribe un código o al menos 3 caracteres (máximo 80); revisa el cursor.' }, 400);

  if (codigo && !cursor) {
    const p = await env.DB.prepare(`select ${COLUMNAS} from productos p
      where p.codigo = ? and p.propietario = ? and ${VISIBLE}`).bind(codigo, propietario).first<Pieza>();
    if (p || !upc) return json({ piezas: p ? [p] : [], siguiente: null });
  }
  if (codigo && !upc) return json({ piezas: [], siguiente: null });

  // El índice de expresión productos_upc_foto excluye FEP y piezas sin foto.
  // Todas las variantes usan productos_upc, sin perder esas piezas ni sus ceros.
  const variantes = upc ? Array.from({ length: 15 - upc.length }, (_, i) => upc.padStart(upc.length + i, '0')) : [];
  if (upc && cursor && !variantes.includes(cursor.fecha)) return json({ error: 'Cursor inválido.' }, 400);
  const palabras = upc ? [] : q.split(/\s+/).filter(Boolean);
  // shortcut: lower() de SQLite no pliega acentos; normalizar en una migración si hace falta.
  const coincide = palabras.map(() => "(instr(lower(p.nombre), lower(?)) > 0 or instr(lower(p.marca), lower(?)) > 0)");
  const piezas: Pieza[] = [];
  let siguiente: string | null = null;
  let restantes = codigo ? 999 : 1000;
  let empate = !!cursor;
  // El filtro va en SELECT: LIMIT acota candidatas leídas, incluso si ninguna coincide.
  while (restantes > 0 && piezas.length < PAGINA) {
    // Sin filtro casi toda candidata es elegible: leer una página, no un tramo de 200 (cuota de D1).
    const limite = Math.min(upc || palabras.length ? TRAMO : PAGINA, restantes);
    const { results } = await env.DB.prepare(`select p.rowid as fila, ${COLUMNAS},
        (${VISIBLE} ${upc ? 'and p.propietario = ?' : ''} ${coincide.length ? 'and ' + coincide.join(' and ') : ''}) as elegible
      from productos p indexed by ${upc ? 'productos_upc' : 'productos_propietario_creado'}
      where ${upc ? `p.upc in (${variantes.map(() => '?').join(',')})` : 'p.propietario = ?'}
        ${cursor ? empate
          ? `and p.${upc ? 'upc' : 'creado_en'} = ? and p.rowid < ?`
          : `and p.${upc ? 'upc' : 'creado_en'} < ?` : ''}
      order by p.${upc ? 'upc' : 'creado_en'} desc, p.rowid desc limit ?`)
      .bind(...(upc ? [propietario] : []), ...palabras.flatMap((p) => [p, p]), ...(upc ? variantes : [propietario]),
        ...(cursor ? [cursor.fecha, ...(empate ? [cursor.fila] : [])] : []), limite).all<Candidata>();
    restantes -= results.length;
    siguiente = null;
    for (let i = 0; i < results.length; i++) {
      const p = results[i];
      cursor = { fecha: upc ? p.upc! : p.creado_en, fila: p.fila };
      if (p.elegible) piezas.push(publica(p));
      if (piezas.length === PAGINA || i === results.length - 1) {
        if (piezas.length === PAGINA || results.length === limite || i < results.length - 1)
          siguiente = cursorDe({ creado_en: cursor.fecha, fila: cursor.fila });
        if (piezas.length === PAGINA) break;
      }
    }
    if (piezas.length === PAGINA) break;
    if (results.length < limite) {
      if (empate) { empate = false; continue; }
      break;
    }
    empate = true;
  }
  return json({ piezas, siguiente });
}

async function fichaPieza(env: Env, id: string, usuario: Usuario | null): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador inválido.' }, 400);
  const pieza = await env.DB.prepare(`select ${COLUMNAS} from productos p
    where p.id = ? and p.propietario = ? and ${VISIBLE}`).bind(id, propietarioDe(usuario)).first<Pieza>();
  if (!pieza) return json({ error: 'Pieza no encontrada.' }, 404);
  // shortcut: índice por fecha existente; añadir (producto_id, ajustado_en) si el historial supera 10 mil filas.
  const { results: ajustes } = await env.DB.prepare(`select id, motivo, cantidad, antes, despues, ajustado_por, ajustado_en
    from conteo_ajustes where producto_id = ? order by ajustado_en desc, rowid desc limit 10`).bind(id).all<Record<string, unknown> & { ajustado_en: string }>();
  // Bitácora (#485): los cambios de campo (trigger de la migración 054) se mezclan con los ajustes de existencia, lo más nuevo primero.
  // `campo` los distingue; `antes`/`despues` son texto (centavos en los precios). Los ajustes conservan su forma de siempre.
  const { results: cambios } = await env.DB.prepare(`select id, campo, antes, despues, por, en
    from productos_cambios where producto_id = ? order by en desc, id desc limit ${HISTORIAL}`).bind(id).all<Record<string, unknown> & { en: string }>();
  const historial = [...ajustes.map((a) => ({ a, fecha: a.ajustado_en })), ...cambios.map((a) => ({ a, fecha: a.en }))]
    .sort((x, y) => (x.fecha < y.fecha ? 1 : x.fecha > y.fecha ? -1 : 0)).slice(0, HISTORIAL).map(({ a }) => a);
  return json({ pieza, historial, puede_editar: puedeEditarInventario(usuario), puede_precio: !!usuario?.activo && usuario.roles.includes('dueno'),
    solicitud_precio: await pendienteDe(env, id) });
}

export interface Ajuste {
  id: string; producto_id: string; motivo: string; cantidad: number; antes: number; despues: number;
  ajustado_por: string; ajustado_en: string;
}

export const ajusteGuardado = (env: Env, folio: string) => env.DB.prepare(`select id, producto_id, motivo, cantidad, antes, despues, ajustado_por, ajustado_en
  from conteo_ajustes where id = ?`).bind(folio).first<Ajuste>();

/**
 * Único lugar que escribe existencia con renglón de auditoría (ajuste de #441 y corrección de captura de #468): quien llama ya
 * autorizó. `esperado` hace la escritura condicional (`stock = esperado`); `donde`/`args` acotan más la fila. Devuelve el
 * renglón si se aplicó, o null si la pieza cambió, quedó fuera de 0–999 o el folio ya existía; no asume que un lote protege lecturas previas.
 */
export async function escribirExistencia(env: Env, ctx: ExecutionContext, a: {
  id: string; propietario: string; folio: string; delta: number; motivo: string; correo: string;
  esperado?: number; donde?: string; args?: unknown[];
}): Promise<Ajuste | null> {
  const ahora = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`update productos set stock = stock + ?, actualizado_en = ?
      where id = ? and propietario = ? and sin_inventario = 0 and estado_analisis <> 'descartado'
        and stock + ? between 0 and 999 ${a.esperado !== undefined ? 'and stock = ?' : ''} ${a.donde ?? ''}
        and not exists (select 1 from conteo_ajustes where id = ?)`)
      .bind(a.delta, ahora, a.id, a.propietario, a.delta, ...(a.esperado !== undefined ? [a.esperado] : []), ...(a.args ?? []), a.folio),
    // changes() evita rastro falso si otro intento dejó la misma marca en este milisegundo.
    env.DB.prepare(`insert into conteo_ajustes
      (id, producto_id, codigo, nombre, motivo, cantidad, antes, despues, ajustado_por, ajustado_en)
      select ?, id, coalesce(codigo, ''), nombre, ?, ?, stock - ?, stock, ?, ? from productos
      where id = ? and propietario = ? and actualizado_en = ? and changes() = 1`)
      .bind(a.folio, a.motivo, Math.abs(a.delta), a.delta, a.correo, ahora, a.id, a.propietario, ahora),
  ]);
  const ajuste = await ajusteGuardado(env, a.folio);
  if (ajuste) ctx.waitUntil(conciliarSeguro(env, { productoIds: [a.id] }));
  return ajuste;
}

async function cambiarExistencia(request: Request, env: Env, id: string, usuario: Usuario | null, ctx: ExecutionContext): Promise<Response> {
  if (!puedeEditarInventario(usuario)) return json({ error: 'Tu cuenta no tiene permiso para editar inventario.' }, 403);
  const cuerpo = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!UUID.test(id) || !cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)
      || typeof cuerpo.id !== 'string' || !UUID.test(cuerpo.id)) return json({ error: 'Identificador inválido.' }, 400);
  const fijar = cuerpo.fijar_a !== undefined;
  const entero = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 999;
  if (fijar ? !entero(cuerpo.fijar_a) || !entero(cuerpo.esperado) || cuerpo.delta !== undefined
    : typeof cuerpo.delta !== 'number' || !Number.isInteger(cuerpo.delta) || Math.abs(cuerpo.delta) > 999 || cuerpo.esperado !== undefined)
    return json({ error: 'Ajuste inválido. Usa delta o fijar_a con esperado (0 a 999).' }, 400);
  const delta = fijar ? (cuerpo.fijar_a as number) - (cuerpo.esperado as number) : cuerpo.delta as number;
  const motivo = cuerpo.motivo;
  if (!delta || typeof motivo !== 'string' || ![...MOTIVOS, 'entrada', 'correccion'].includes(motivo)
      || (delta > 0 && (motivo === 'robo' || motivo === 'merma')) || (delta < 0 && motivo === 'entrada'))
    return json({ error: 'Escoge un motivo válido para subir o bajar existencia.' }, 400);
  const propietario = propietarioDe(usuario);
  const actual = () => env.DB.prepare(`select p.stock from productos p
    where p.id = ? and p.propietario = ? and ${VISIBLE}`).bind(id, propietario).first<{ stock: number }>();
  if (!await actual()) return json({ error: 'Pieza no encontrada.' }, 404);
  const guardado = () => ajusteGuardado(env, cuerpo.id as string);
  const responder = (a: Ajuste) => a.producto_id === id && a.ajustado_por === usuario!.correo && a.motivo === motivo
      && a.despues - a.antes === delta && (!fijar || (a.antes === cuerpo.esperado && a.despues === cuerpo.fijar_a))
    ? json(a) : json({ error: 'El folio ya pertenece a otro ajuste.' }, 409);
  const previo = await guardado();
  if (previo) return responder(previo);

  const ajuste = await escribirExistencia(env, ctx, { id, propietario, folio: cuerpo.id, delta, motivo, correo: usuario!.correo,
    esperado: fijar ? cuerpo.esperado as number : undefined });
  if (ajuste) return responder(ajuste);
  const pieza = await actual();
  return pieza ? json({ error: 'La existencia cambió o queda fuera de 0 a 999. Revisa y vuelve a intentar.', stock: pieza.stock }, 409)
    : json({ error: 'Pieza no encontrada.' }, 404);
}

/** Conserva ambos códigos: la etiqueta vieja sigue resolviendo en caja, con existencia cero. */
async function juntarPiezas(request: Request, env: Env, id: string, usuario: Usuario | null, ctx: ExecutionContext): Promise<Response> {
  if (!puedeEditarInventario(usuario)) return json({ error:'Tu cuenta no tiene permiso para editar inventario.' }, 403);
  const cuerpo = await request.json().catch(() => null) as { id?: unknown; destino_id?: unknown } | null;
  if (!UUID.test(id) || typeof cuerpo?.id !== 'string' || !UUID.test(cuerpo.id)
      || typeof cuerpo.destino_id !== 'string' || !UUID.test(cuerpo.destino_id) || id === cuerpo.destino_id)
    return json({ error:'Identificador inválido.' }, 400);
  const propietario = propietarioDe(usuario), destinoId = cuerpo.destino_id;
  const { results: piezas } = await env.DB.prepare(`select id, codigo, stock, upc, estado_fisico, estado_analisis
    from productos where id in (?, ?) and propietario = ? and sin_inventario = 0`)
    .bind(id, destinoId, propietario).all<{ id:string; codigo:string | null; stock:number; upc:string | null; estado_fisico:string; estado_analisis:string }>();
  if (piezas.length !== 2) return json({ error:'Pieza no encontrada.' }, 404);
  const previo = () => env.DB.prepare(`select producto_id, cantidad, antes, despues, ajustado_por from conteo_ajustes where id = ?`)
    .bind(cuerpo.id).first<{ producto_id:string; cantidad:number; antes:number; despues:number; ajustado_por:string }>();
  const responder = async () => {
    const a = await previo();
    if (!a) return null;
    const b = await env.DB.prepare('select producto_id, despues from conteo_ajustes where id = ?').bind(`${cuerpo.id}:destino`)
      .first<{ producto_id:string; despues:number }>();
    return a.producto_id === id && b?.producto_id === destinoId && a.ajustado_por === usuario!.correo
      ? json({ id, destino_id:destinoId, movidas:a.cantidad, stock:b.despues })
      : json({ error:'El folio ya pertenece a otro ajuste.' }, 409);
  };
  const repetido = await responder();
  if (repetido) return repetido;
  const origen = piezas.find(p => p.id === id)!, destino = piezas.find(p => p.id === destinoId)!;
  if (!origen.codigo || !destino.codigo) return json({ error:'Sin dos etiquetas, usa la fusión de borradores.' }, 409);
  if (origen.estado_fisico !== destino.estado_fisico) return json({ error:'Sólo puedes juntar piezas del mismo grado.' }, 409);
  if (origen.stock + destino.stock > 999) return json({ error:'La suma supera 999 piezas.' }, 409);
  const ahora = new Date().toISOString();
  const efectos = await env.DB.batch([
    env.DB.prepare(`update productos set stock = 0, upc = null, modificado_por = ?, actualizado_en = ? where id = ?
      and propietario = ? and sin_inventario = 0 and estado_analisis <> 'descartado'
      and stock = ? and upc is ? and codigo = ? and estado_fisico = ?
      and exists (select 1 from productos where id = ? and propietario = ? and sin_inventario = 0
        and estado_analisis <> 'descartado' and codigo = ? and estado_fisico = ? and upc is ? and stock + ? <= 999)
      and not exists (select 1 from conteo_ajustes where id in (?, ?))`)
      .bind(usuario!.correo, ahora, id, propietario, origen.stock, origen.upc, origen.codigo, origen.estado_fisico,
        destinoId, propietario, destino.codigo, origen.estado_fisico, destino.upc, origen.stock, cuerpo.id, `${cuerpo.id}:destino`),
    env.DB.prepare(`insert into conteo_ajustes
      (id, producto_id, codigo, nombre, motivo, cantidad, antes, despues, ajustado_por, ajustado_en)
      select ?, id, codigo, nombre, 'correccion', ?, ?, 0, ?, ? from productos where id = ? and changes() = 1`)
      .bind(cuerpo.id, origen.stock, origen.stock, usuario!.correo, ahora, id),
    env.DB.prepare(`update productos set stock = stock + ?, actualizado_en = ? where id = ? and changes() = 1`)
      .bind(origen.stock, ahora, destinoId),
    env.DB.prepare(`insert into conteo_ajustes
      (id, producto_id, codigo, nombre, motivo, cantidad, antes, despues, ajustado_por, ajustado_en)
      select ?, id, codigo, nombre, 'correccion', ?, stock - ?, stock, ?, ? from productos where id = ? and changes() = 1`)
      .bind(`${cuerpo.id}:destino`, origen.stock, origen.stock, usuario!.correo, ahora, destinoId),
  ]);
  if (efectos.every(e => e.meta.changes === 1)) ctx.waitUntil(conciliarSeguro(env, { productoIds:[id,destinoId] }));
  return await responder() ?? json({ error:'La pieza origen cambió o la suma supera 999. Revisa y vuelve a intentar.' }, 409);
}

/** Worker valida host y cuenta; cada operación aplica además propietarioDe. */
export async function rutaPiezas(request: Request, env: Env, url: URL, usuario: Usuario | null, ctx: ExecutionContext): Promise<Response | null> {
  if (url.pathname === '/api/piezas/repetidas') return request.method === 'GET' ? piezasRepetidas(env,url,usuario)
    : json({ error:'Método no permitido.' }, 405);
  const juntar = /^\/api\/piezas\/([^/]+)\/juntar$/.exec(url.pathname);
  if (juntar) return request.method === 'POST' ? juntarPiezas(request, env, juntar[1], usuario, ctx)
    : json({ error:'Método no permitido.' }, 405);
  const existencia = /^\/api\/piezas\/([^/]+)\/existencia$/.exec(url.pathname);
  if (existencia) return request.method === 'POST' ? cambiarExistencia(request, env, existencia[1], usuario, ctx)
    : json({ error: 'Método no permitido.' }, 405);
  const detalle = /^\/api\/piezas\/([^/]+)$/.exec(url.pathname);
  if (url.pathname !== '/api/piezas' && !detalle) return null;
  if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405);
  return detalle ? fichaPieza(env, detalle[1], usuario) : buscarPiezas(env, url, propietarioDe(usuario));
}
