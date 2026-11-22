/** Vender por WhatsApp (#431): lecturas acotadas e interesados sin reservar existencias. */
import { VENDIBLE, A_LA_VENTA, COLUMNAS_UBICACION, tiendasDe } from './catalogo.ts';
import { CATEGORIAS, CLAVES_CATEGORIA } from '../public/categorias.js';
import { TIENDA_CENTRAL, esTienda, type Tienda } from './cuentas.ts';
import { telefonoInteresado } from '../public/vender.js';
import { apartarRevendedora, pedidosDeRevendedora, cancelarDeRevendedora } from './pedidos.ts';
import { reportarPagoDeRevendedora, subirFotoDeRevendedora } from './pagos-reportados.ts';

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
  recorte_estado: string | null; recorte_revision: string | null; elegible: number; llegada?: string;
  en_soledad: number; sucursales: string | null; a_la_venta: number;
}
interface Interesado {
  id: string; producto_id: string; cliente: string; telefono: string; nota: string;
  vendedora: string; estado: string; creado_en: string; actualizado_en: string;
}

/** Lo que se pide a la lista: `tienda` nula = todas las tiendas, como antes de #882. */
interface Filtros { q: string; codigo: string | null; categoria: string | null; hoy: boolean; cursor: Cursor | null; tienda: Tienda | null }

/**
 * Recorre candidatas en tramos de 24, hasta 240 por petición, y devuelve las elegibles con el cursor para seguir.
 * - Sin tienda: `productos` por `creado_en` (índice productos_propietario_creado).
 * - Soledad: lo mismo con `p.stock > 0`; su llegada es el alta (todo se captura ahí).
 * - Sucursal: `existencia_tienda` por `actualizado_en` (índice existencia_tienda_cambios); `tienda` siempre va ligada.
 * ponytail: la llegada a una sucursal es `actualizado_en`, que también sube cuando se vende o se ajusta una pieza con varias unidades.
 * Si estorba, columna `llegada_en` (migración) y este mismo orden sobre ella.
 */
async function recorrer(env: Env, f: Filtros): Promise<{ piezas: Pieza[]; siguiente: string | null }> {
  const { q, codigo, categoria, hoy } = f;
  let cursor = f.cursor;
  const sucursal = f.tienda !== null && f.tienda !== TIENDA_CENTRAL;
  const fecha = sucursal ? 'e.actualizado_en' : 'p.creado_en';
  const dia = new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 10);
  const apertura = `${dia}T06:00:00.000Z`;
  const cierre = new Date(Date.parse(apertura) + 86_400_000).toISOString();
  const piezas: Pieza[] = [];
  let hayMas = false;
  // #869: las bandas (sin_inventario, destino banda_*) nunca son elegibles; filtrarlas aqui evita que ~400 de ellas gasten las 240 candidatas.
  // Un nombre inexistente tampoco recorre toda productos: máximo 240 candidatas por petición.
  // El cursor avanza aun en un tramo sin coincidencias; la pantalla permite seguir buscando.
  for (let tramo = 0; tramo < 10 && piezas.length < PAGINA; tramo++) {
    const { results } = await env.DB.prepare(`select p.rowid as fila, p.id, p.codigo, p.nombre, p.marca,
        p.talla, p.categoria, p.precio, p.precio_lista, p.estado_fisico, p.creado_en,
        p.recorte_estado, p.recorte_revision, ${COLUMNAS_UBICACION}, ${sucursal ? 'e.actualizado_en as llegada,' : ''}
        (${VENDIBLE} ${categoria ? 'and p.categoria = ?' : ''}
          ${q && !codigo ? "and instr(lower(p.nombre), lower(?)) > 0" : ''}) as elegible
      ${sucursal ? `from existencia_tienda e indexed by existencia_tienda_cambios join productos p on p.id = e.producto_id
      where e.tienda = ? and e.unidades > 0 and p.propietario = 'dolaron' and p.sin_inventario = 0 and p.destino = 'etiqueta'`
      : `from productos p ${codigo ? '' : 'indexed by productos_propietario_creado'}
      where p.propietario = 'dolaron' and p.sin_inventario = 0 and p.destino = 'etiqueta' ${codigo ? 'and p.codigo = ?' : ''}
        ${f.tienda ? 'and p.stock > 0' : ''}`}
        ${hoy ? `and ${fecha} >= ? and ${fecha} < ?` : ''}
        ${cursor ? `${sucursal ? 'and e.actualizado_en <= ?' : ''} and (${fecha}, p.rowid) < (?, ?)` : ''}
      order by ${fecha} desc, p.rowid desc limit ?`)
      .bind(...(categoria ? [categoria] : []), ...(q && !codigo ? [q] : []), ...(sucursal ? [f.tienda] : codigo ? [codigo] : []),
        ...(hoy ? [apertura, cierre] : []), ...(cursor ? [...(sucursal ? [cursor.fecha] : []), cursor.fecha, cursor.fila] : []), PAGINA)
      .all<Pieza>();
    hayMas = results.length === PAGINA;
    for (let i = 0; i < results.length; i++) {
      const p = results[i];
      cursor = { fecha: p.llegada ?? p.creado_en, fila: p.fila };
      if (p.elegible) piezas.push(p);
      if (piezas.length === PAGINA) { hayMas ||= i < results.length - 1; break; }
    }
    if (!hayMas) break;
  }
  return { piezas, siguiente: hayMas && cursor ? `${cursor.fecha}~${cursor.fila}` : null };
}

/** Una consulta con las colas de las piezas de la página (el índice empieza por producto y estado) y la forma que ve el navegador. */
async function aTarjetas(env: Env, piezas: Pieza[], correo: string, revendedora: boolean, motivos?: Map<string, string>) {
  const interesados = piezas.length ? (await env.DB.prepare(`select i.producto_id, i.cliente, i.vendedora,
      coalesce(nullif(u.nombre, ''), i.vendedora) as vendedora_nombre, i.creado_en
    from interesados i indexed by interesados_producto_estado left join usuarios u on u.correo = i.vendedora
    where i.producto_id in (${piezas.map(() => '?').join(',')}) and i.estado = 'abierto' and i.creado_en >= ?
    order by i.creado_en, i.rowid`).bind(...piezas.map((p) => p.id), desdeInteresados())
    .all<{ producto_id: string; cliente: string; vendedora: string; vendedora_nombre: string; creado_en: string }>()).results : [];
  return piezas.map(({ fila, elegible, recorte_estado, recorte_revision, en_soledad, sucursales, a_la_venta, llegada, ...p }) => {
    // #575: una revendedora ve la posicion en la cola, no los clientes ni las vendedoras ajenas.
    const cola = interesados.filter((i) => i.producto_id === p.id).map(({ producto_id, ...i }) =>
      revendedora && i.vendedora !== correo ? { ...i, cliente: '', vendedora: '', vendedora_nombre: 'Otra vendedora' } : i);
    return { ...p, tiendas: tiendasDe({ en_soledad, sucursales }), foto: recorte_estado === 'listo' && recorte_revision === 'ok'
      ? `/api/recortes/${p.id}/imagen` : `/api/foto/${p.id}`, interesados: cola.length, cola, ...(motivos ? { motivo: motivos.get(p.id) } : {}) };
  });
}

/* ---------- Recomendados (#882) ---------- */

const DIAS_RECOMENDADOS = 30;
const MINIMO_UNIDADES = 10;      // menos que esto vendidas en la tienda: se mira lo de todas
const CODIGOS_POR_CONSULTA = 80; // D1 acepta 100 parámetros por sentencia
const CONSULTAS_MAX = 5;
interface VentaDe { tienda: string; codigo: string; categoria: string; n: number }
// Lo vendido por tienda y pieza en 30 días: una sola lectura para las tres tiendas, guardada hasta 1 hora en la memoria del Worker porque la cuota
// de filas de D1 no aguanta recalcularla en cada carga. La disponibilidad no se guarda: se consulta cada vez. Se guarda la promesa para que dos
// cargas simultáneas no lean dos veces.
// ponytail: memoria por instancia (cada una calcula la suya); si hace falta compartirla, una tabla de resumen o la Cache API.
let ventasGuardadas: { hasta: number; filas: Promise<VentaDe[]> } | null = null;
/** Para las pruebas: olvida lo guardado. */
export const olvidarVentasRecomendadas = () => { ventasGuardadas = null; };
function ventasRecientes(env: Env): Promise<VentaDe[]> {
  if (!ventasGuardadas || ventasGuardadas.hasta <= Date.now()) {
    const desde = new Date(Date.now() - DIAS_RECOMENDADOS * 86_400_000).toISOString();
    const filas = env.DB.prepare(`select v.tienda, p.codigo, p.categoria, sum(l.cantidad) as n
      from ventas v indexed by ventas_creado join venta_lineas l on l.venta_id = v.id join productos p on p.id = l.producto_id
      where v.creado_en >= ? and v.cancelada = 0 and p.codigo like 'ED-%' and p.propietario = 'dolaron' and p.sin_inventario = 0 and p.destino = 'etiqueta'
      group by v.tienda, p.id`).bind(desde).all<VentaDe>().then((r) => r.results);
    ventasGuardadas = { hasta: Date.now() + 3_600_000, filas };
    filas.catch(() => { if (ventasGuardadas?.filas === filas) ventasGuardadas = null; });
  }
  return ventasGuardadas.filas;
}
const nombreCategoria = (clave: string) => CATEGORIAS.find(([c]) => c === clave)?.[1] ?? clave;

/** Lo que conviene ofrecer en `tienda`: lo que ya se vendió ahí y sigue en existencia, luego lo de las categorías que más se venden. */
async function recomendar(env: Env, tienda: Tienda, categoria: string | null, correo: string, revendedora: boolean): Promise<Response> {
  const todas = await ventasRecientes(env);
  const propias = todas.filter((v) => v.tienda === tienda);
  const base = propias.reduce((suma, v) => suma + v.n, 0) >= MINIMO_UNIDADES ? 'tienda' : 'todas';
  // Con base «todas» se suma por pieza lo de las tres tiendas.
  const porCodigo = new Map<string, VentaDe>();
  for (const v of base === 'tienda' ? propias : todas) {
    const previa = porCodigo.get(v.codigo);
    porCodigo.set(v.codigo, previa ? { ...previa, n: previa.n + v.n } : { ...v });
  }
  const vendidas = [...porCodigo.values()].filter((v) => !categoria || v.categoria === categoria)
    .sort((a, b) => b.n - a.n || (a.codigo < b.codigo ? -1 : 1));
  const aqui = base === 'tienda' ? 'Aquí ' : '';
  const motivos = new Map<string, string>();
  const elegidas: Pieza[] = [];
  const hay = tienda === TIENDA_CENTRAL ? 'p.stock > 0'
    : 'exists (select 1 from existencia_tienda e where e.producto_id = p.id and e.tienda = ? and e.unidades > 0)';
  // 1. Piezas que hoy hay en la tienda y ya se vendieron (en la tienda o, sin base propia, en todas), de más a menos unidades.
  // ponytail: se revisan hasta 400 códigos vendidos por petición; la mayoría de lo vendido ya no tiene existencia. Si se queda corto, un índice por venta.
  for (let desde = 0; desde < vendidas.length && desde < CODIGOS_POR_CONSULTA * CONSULTAS_MAX && elegidas.length < PAGINA; desde += CODIGOS_POR_CONSULTA) {
    const lote = vendidas.slice(desde, desde + CODIGOS_POR_CONSULTA);
    const { results } = await env.DB.prepare(`select p.rowid as fila, p.id, p.codigo, p.nombre, p.marca, p.talla, p.categoria, p.precio, p.precio_lista,
        p.estado_fisico, p.creado_en, p.recorte_estado, p.recorte_revision, ${COLUMNAS_UBICACION}, 1 as elegible
      from productos p where p.codigo in (${lote.map(() => '?').join(',')}) and ${VENDIBLE} and ${hay}`)
      .bind(...lote.map((v) => v.codigo), ...(tienda === TIENDA_CENTRAL ? [] : [tienda])).all<Pieza>();
    for (const v of lote) {
      const p = results.find((r) => r.codigo === v.codigo);
      if (!p || elegidas.length >= PAGINA) continue;
      elegidas.push(p);
      motivos.set(p.id, `${aqui}${v.n === 1 ? 'se vendió 1' : `se vendieron ${v.n}`} en ${DIAS_RECOMENDADOS} días`.replace(/^./, (c) => c.toUpperCase()));
    }
  }
  // 2. Piezas de las 3 categorías que más unidades vendieron, alternando categorías (la más vendida primero) y la más reciente de cada una.
  const porCategoria = new Map<string, number>();
  for (const v of porCodigo.values()) porCategoria.set(v.categoria, (porCategoria.get(v.categoria) ?? 0) + v.n);
  const mejores = [...porCategoria].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([c]) => c)
    .filter((c) => !categoria || c === categoria);
  if (elegidas.length < PAGINA && mejores.length) {
    const usadas = new Set(elegidas.map((p) => p.id));
    const listas = await Promise.all(mejores.map(async (c) =>
      (await recorrer(env, { q: '', codigo: null, categoria: c, hoy: false, cursor: null, tienda })).piezas.filter((p) => !usadas.has(p.id))));
    for (let ronda = 0; elegidas.length < PAGINA && listas.some((l) => ronda < l.length); ronda++) {
      listas.forEach((l, i) => {
        if (ronda >= l.length || elegidas.length >= PAGINA) return;
        elegidas.push(l[ronda]);
        motivos.set(l[ronda].id, `${nombreCategoria(mejores[i])} se vende bien${base === 'tienda' ? ' aquí' : ''}`);
      });
    }
  }
  return json({ piezas: await aTarjetas(env, elegidas, correo, revendedora, motivos), siguiente: null, base });
}

async function listarPiezas(env: Env, url: URL, correo: string, revendedora: boolean): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  const categoria = url.searchParams.get('categoria');
  const hoy = url.searchParams.get('hoy');
  const claveTienda = url.searchParams.get('tienda');
  const orden = url.searchParams.get('orden');
  const cursor = leerCursor(url.searchParams.get('cursor'));
  // Recomendados es de la tienda y de quien la atiende: la revendedora no lo ve (403 antes que cualquier otra validación).
  if (orden !== null && revendedora) return json({ error: 'Recomendados es solo para la tienda.' }, 403);
  const tienda = claveTienda === null ? null : esTienda(claveTienda) ? claveTienda : false;
  if (q.length > 80 || (categoria !== null && !CLAVES_CATEGORIA.includes(categoria)) || tienda === false
      || (hoy !== null && hoy !== '1') || (url.searchParams.has('cursor') && !cursor)
      || (orden !== null && (orden !== 'recomendado' || tienda === null || q || hoy !== null || cursor))) {
    return json({ error: 'Filtros o cursor inválidos.' }, 400);
  }
  if (orden !== null && tienda) return recomendar(env, tienda, categoria, correo, revendedora);
  const codigo = /^ED-\d{1,10}$/i.test(q) ? q.toUpperCase() : null;
  // Un código exacto ignora la tienda: la tarjeta dice dónde está, y prepararEnvio y «Me escribieron con un código» dependen de encontrarla.
  const { piezas, siguiente } = await recorrer(env, { q, codigo, categoria, hoy: hoy !== null, cursor, tienda: codigo ? null : tienda });
  return json({ piezas: await aTarjetas(env, piezas, correo, revendedora), siguiente });
}

async function listarInteresados(env: Env, url: URL, correo: string, revendedora: boolean): Promise<Response> {
  // Las revendedoras compiten entre si: para ellas la lista siempre es la suya.
  const mios = revendedora ? '1' : url.searchParams.get('mios');
  const cursor = leerCursor(url.searchParams.get('cursor'));
  if ((url.searchParams.get('mios') !== null && url.searchParams.get('mios') !== '1') || (url.searchParams.has('cursor') && !cursor))
    return json({ error: 'Filtros o cursor inválidos.' }, 400);
  const { results } = await env.DB.prepare(`select i.rowid as fila, i.*,
      coalesce(nullif(u.nombre, ''), i.vendedora) as vendedora_nombre,
      p.codigo, p.nombre, p.precio,
      case when ${A_LA_VENTA} > 0 then 'Disponible'
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

async function descartarInteresado(request: Request, env: Env, id: string, propio: string | null): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador inválido.' }, 400);
  const cuerpo = await request.json().catch(() => null) as { estado?: unknown } | null;
  if (!cuerpo || cuerpo.estado !== 'descartado' || Object.keys(cuerpo).some((k) => k !== 'estado'))
    return json({ error: 'Solo se puede descartar el interesado.' }, 400);
  // Toda la caja ve y puede cerrar la cola compartida; una revendedora (`propio`) solo lo suyo. Nunca reabre ni altera el cliente.
  await env.DB.prepare(`update interesados set estado = 'descartado', actualizado_en = ?
    where id = ? and estado = 'abierto' ${propio ? 'and vendedora = ?' : ''}
      and exists (select 1 from productos p where p.id = interesados.producto_id and p.propietario = 'dolaron')`)
    .bind(new Date().toISOString(), id, ...(propio ? [propio] : [])).run();
  const i = await env.DB.prepare(`select i.* from interesados i join productos p on p.id = i.producto_id
    where i.id = ? and p.propietario = 'dolaron' ${propio ? 'and i.vendedora = ?' : ''}`).bind(id, ...(propio ? [propio] : [])).first<Interesado>();
  return i ? json({ interesado: i }) : json({ error: 'Interesado no encontrado.' }, 404);
}

/**
 * La identidad y el permiso de caja se resuelven antes, en worker.ts/cuentas.ts. `revendedora` (esRevendedora)
 * acota lo que ve y habilita el apartado sin anticipo (#575): ninguna cuenta de la tienda lo usa.
 */
export async function rutaVender(request: Request, env: Env, url: URL, correo: string, ctx: ExecutionContext, revendedora = false): Promise<Response | null> {
  const { pathname } = url;
  const detalle = /^\/api\/interesados\/([^/]+)$/.exec(pathname);
  const cancelar = /^\/api\/vender\/apartados\/(\d{1,9})\/cancelar$/.exec(pathname);
  // #609: el pago de su cliente: la foto del comprobante (se lee) y el reporte con la clave.
  const pago = /^\/api\/vender\/apartados\/(\d{1,9})\/(pago|comprobante)$/.exec(pathname);
  if (pathname === '/api/vender' && request.method === 'GET') return listarPiezas(env, url, correo, revendedora);
  if (pathname === '/api/interesados') {
    if (request.method === 'GET') return listarInteresados(env, url, correo, revendedora);
    if (request.method === 'POST') return crearInteresado(request, env, correo);
  }
  if (detalle && request.method === 'PATCH') return descartarInteresado(request, env, detalle[1], revendedora ? correo : null);
  if (pathname === '/api/vender/apartar' || pathname === '/api/vender/mios' || cancelar || pago) {
    const metodo = pathname === '/api/vender/mios' ? 'GET' : 'POST';
    if (request.method !== metodo) return json({ error: 'Método no permitido.' }, 405);
    if (!revendedora) return json({ error: 'Solo las revendedoras apartan sin anticipo. En la tienda, aparta desde Pedidos.' }, 403);
    if (cancelar) return cancelarDeRevendedora(Number(cancelar[1]), env, ctx, correo);
    if (pago) return pago[2] === 'pago' ? reportarPagoDeRevendedora(Number(pago[1]), request, env, ctx, correo) : subirFotoDeRevendedora(Number(pago[1]), request, env, correo);
    return metodo === 'GET' ? pedidosDeRevendedora(env, correo) : apartarRevendedora(request, env, ctx, correo);
  }
  return pathname === '/api/vender' || pathname === '/api/interesados' || detalle
    ? json({ error: 'Método no permitido.' }, 405) : null;
}
