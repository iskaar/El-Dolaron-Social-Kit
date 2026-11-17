/**
 * «La tengo en la mano» (Issue #832, parte de #821): el cliente trae una pieza que el sistema da por vendida (existencia 0) y la caja puede
 * cobrarla. El servidor lo hace en UN solo paso con la venta: dentro del mismo batch, antes de la baja normal, un ajuste auditado de
 * «+faltante» que solo aplica si la existencia de la tienda sigue siendo la que vio la caja. La baja normal (`sentenciasMover`) y los
 * disparadores de existencia no negativa no cambian: si la condición no se cumple no se ajusta nada y la venta se comporta como siempre
 * (vende con la existencia que ya hay, o aborta nombrando la pieza). La existencia nunca se sube fuera de ese batch.
 * El rastro es un renglón de `conteo_ajustes` (motivo `hallada_en_caja`, migración 081) con folio `<venta>:<pieza>`: un reintento no ajusta dos veces.
 */
import { enviarAviso } from './avisos.ts';
import { TIENDA_CENTRAL, TIENDAS, esTienda } from './cuentas.ts';
import { unidadesEn, enCaminoSql, folioEnCaminoSql } from './existencias.ts';
import { MOTIVOS_EN_MANO } from '../public/venta.js';

export const MOTIVO_AJUSTE = 'hallada_en_caja';
const DIAS_LISTA = 7;

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export interface MarcaEnMano {
  producto_id: string; codigo: string; nombre: string; cantidad: number; esperado: number; faltante: number; motivo: string;
  /** Lo que otras tiendas tienen registrado de esta pieza (solo aviso: el cliente trae la pieza de verdad). '' si nada. */
  otras: string;
}

/**
 * Lo que impide ajustar, la MISMA condición en la lectura previa (para el mensaje) y dentro del batch (la que protege): el folio de la venta aún
 * no ajustó esta pieza, ningún apartado vigente la tiene, ninguna orden de Mercado Libre por atender, ninguna unidad va en un bulto sin recibir
 * (`enCaminoSql`, existencias.ts) y ninguna cancelación (o devolución de dinero de esa pieza) pendiente de una venta que la incluye. Binds: folio, pieza, pieza, pieza, pieza.
 */
export const LIBRE_SQL = `not exists (select 1 from conteo_ajustes where id = ?)
  and not exists (select 1 from pedido_lineas pl join pedidos pe on pe.id = pl.pedido_id where pl.producto_id = ? and pe.estado = 'apartado')
  and not exists (select 1 from ml_ventas where producto_id = ? and estado in ('recibida', 'descontada') and atendida_en = '')
  and ${enCaminoSql('?')} = 0
  and not exists (select 1 from solicitudes s join venta_lineas l on l.venta_id = json_extract(s.datos, '$.venta_id')
    where s.estado = 'pendiente' and l.producto_id = ?
      and (s.tipo = 'cancelacion' or (s.tipo = 'devolucion' and l.id = json_extract(s.datos, '$.linea_id'))))`;
const libreArgs = (folio: string, pieza: string) => [folio, pieza, pieza, pieza, pieza];

interface PiezaMarcada {
  codigo: string | null; nombre: string; precio: number; sin_inventario: number; estado_fisico: string | null; estado_analisis: string;
}

/**
 * Antes del batch, solo lectura: rechaza lo que no puede venderse así y dice qué hacer. La condición que protege es la del batch; esto da el
 * mensaje claro. `lineas` son las del cliente y `preparadas` las que armó el servidor, en el mismo orden.
 */
export async function validarEnMano(
  env: Env, tienda: string, lineas: { producto_id?: unknown; en_mano?: unknown }[], preparadas: { producto_id: string; cantidad: number; sinInventario: boolean }[],
): Promise<{ ok: true; marcas: MarcaEnMano[] } | { ok: false; error: string; status: number }> {
  const marcas: MarcaEnMano[] = [];
  for (const [i, l] of lineas.entries()) {
    if (l.en_mano === undefined) continue;
    const marca = l.en_mano as { motivo?: unknown; esperado?: unknown } | null;
    const motivo = String(marca?.motivo ?? '');
    const esperado = marca?.esperado;
    if (!marca || typeof marca !== 'object' || Array.isArray(marca) || !Object.hasOwn(MOTIVOS_EN_MANO, motivo)
      || typeof esperado !== 'number' || !Number.isInteger(esperado) || esperado < 0 || esperado > 999)
      return { ok: false, status: 400, error: 'La marca «La tengo en la mano» es inválida: escoge uno de los tres motivos.' };
    const p = preparadas[i];
    // Una pieza a la vez y con la existencia en 0 que vio la caja: es lo único que ofrece la pantalla.
    if (esperado !== 0 || p.cantidad !== 1)
      return { ok: false, status: 400, error: 'La pieza «en la mano» se vende de una en una y solo cuando la caja la ve con existencia 0.' };
    if (preparadas.filter((x) => x.producto_id === p.producto_id).length > 1)
      return { ok: false, status: 400, error: 'Una pieza marcada «La tengo en la mano» solo puede ir en un renglón.' };
    const pieza = await env.DB.prepare('select codigo, nombre, precio, sin_inventario, estado_fisico, estado_analisis from productos where id = ?')
      .bind(p.producto_id).first<PiezaMarcada>();
    const nombre = pieza?.nombre || pieza?.codigo || 'La pieza';
    const rechazo = (error: string) => ({ ok: false as const, status: 409, error });
    if (!pieza) return { ok: false, status: 400, error: 'Producto inexistente.' };
    if (pieza.sin_inventario || p.sinInventario)
      return rechazo(`${nombre} no lleva existencia (banda o pieza sin inventario): cóbrala normal, no hace falta «La tengo en la mano».`);
    if (pieza.estado_fisico === 'caducado') return rechazo(`${nombre} está caducada (grado D): no se vende. Apártala y avisa al encargado.`);
    if (pieza.estado_analisis === 'descartado') return rechazo(`${nombre} está descartada: no se vende. Apártala y avisa al encargado.`);
    if (!pieza.codigo || !(pieza.precio > 0)) return rechazo(`${nombre} no tiene etiqueta o precio en el sistema: no se puede vender así. Avisa al encargado.`);
    const apartada = await env.DB.prepare(`select pe.folio from pedido_lineas pl join pedidos pe on pe.id = pl.pedido_id
      where pl.producto_id = ? and pe.estado = 'apartado' order by pe.folio limit 1`).bind(p.producto_id).first<{ folio: number }>();
    if (apartada) return rechazo(`${nombre}: Apartada en P-${apartada.folio}. Cóbrala con ese folio (escribe P-${apartada.folio}) o avisa al encargado.`);
    if (await env.DB.prepare(`select 1 as x from ml_ventas where producto_id = ? and estado in ('recibida', 'descontada') and atendida_en = '' limit 1`)
      .bind(p.producto_id).first())
      return rechazo(`${nombre} tiene una venta de Mercado Libre por atender: no la cobres aquí. Avisa al encargado (Avisos).`);
    const bulto = await env.DB.prepare(`select ${folioEnCaminoSql('?1')} as folio`).bind(p.producto_id).first<{ folio: string | null }>();
    if (bulto?.folio) return rechazo(`${nombre}: Va en el bulto ${bulto.folio}: recíbelo primero en «Bultos».`);
    const pendiente = await env.DB.prepare(`select s.tipo from solicitudes s join venta_lineas l on l.venta_id = json_extract(s.datos, '$.venta_id')
      where s.estado = 'pendiente' and l.producto_id = ?
        and (s.tipo = 'cancelacion' or (s.tipo = 'devolucion' and l.id = json_extract(s.datos, '$.linea_id'))) limit 1`).bind(p.producto_id).first<{ tipo: string }>();
    if (pendiente) return rechazo(`${nombre}: Hay una ${pendiente.tipo === 'devolucion' ? 'devolución de dinero' : 'cancelación'} pendiente de una venta de esta pieza: espera la respuesta de gerencia.`);
    marcas.push({ producto_id: p.producto_id, codigo: pieza.codigo, nombre: pieza.nombre, cantidad: p.cantidad, esperado, faltante: p.cantidad - esperado, motivo,
      otras: await registradaEnOtras(env, tienda, p.producto_id) });
  }
  return { ok: true, marcas };
}

/** Lo que las demás tiendas tienen registrado de la pieza: no impide vender (el cliente la trae), solo se avisa al dueño. */
async function registradaEnOtras(env: Env, tienda: string, productoId: string): Promise<string> {
  const { results } = await env.DB.prepare(`select 'soledad' as tienda, stock as n from productos where id = ?1
    union all select tienda, unidades from existencia_tienda where producto_id = ?1 order by 1`).bind(productoId).all<{ tienda: string; n: number }>();
  return results.filter((r) => r.n > 0 && r.tienda !== tienda).map((r) =>
    `${esTienda(r.tienda) ? TIENDAS[r.tienda].nombre : r.tienda} tiene ${r.n} registrada${r.n === 1 ? '' : 's'} de esta pieza: revisa si es la misma.`).join(' ');
}

/**
 * Las sentencias del batch de la venta, ANTES de la baja normal de esas piezas. Por pieza: (1) sube la existencia de la tienda de la terminal
 * en el faltante SOLO si sigue siendo `esperado`, el folio no existe y la pieza no está apartada ni tiene una orden de Mercado Libre por
 * atender (la misma regla de `validarEnMano`, ahora atómica); (2) deja el renglón del rastro SOLO si (1) cambió una fila (`changes() = 1`).
 * Sin (1) no hay (2), y la baja normal de la venta decide con la existencia que de verdad hay.
 */
export function sentenciasEnMano(
  env: Env, a: { tienda: string; ventaId: string; correo: string; caja: string; ahora: string; marcas: MarcaEnMano[] },
): D1PreparedStatement[] {
  const sentencias: D1PreparedStatement[] = [];
  for (const m of a.marcas) {
    const folio = `${a.ventaId}:${m.producto_id}`;
    const libre = LIBRE_SQL;
    const args = libreArgs(folio, m.producto_id);
    if (a.tienda === TIENDA_CENTRAL) {
      sentencias.push(env.DB.prepare(`update productos set stock = stock + ?, actualizado_en = ? where id = ? and stock = ? and ${libre}`)
        .bind(m.faltante, a.ahora, m.producto_id, m.esperado, ...args));
    } else {
      sentencias.push(
        // La fila de la sucursal se asegura primero (como sentenciasMover): una pieza que nunca llegó ahí está en 0.
        env.DB.prepare(`insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, ?, 0, ?)
          on conflict (producto_id, tienda) do nothing`).bind(m.producto_id, a.tienda, a.ahora),
        env.DB.prepare(`update existencia_tienda set unidades = unidades + ?, actualizado_en = ?
          where producto_id = ? and tienda = ? and unidades = ? and ${libre}`)
          .bind(m.faltante, a.ahora, m.producto_id, a.tienda, m.esperado, ...args),
      );
    }
    sentencias.push(env.DB.prepare(`insert into conteo_ajustes
      (id, producto_id, codigo, nombre, motivo, cantidad, antes, despues, ajustado_por, ajustado_en, tienda, venta_id, caja, razon, otras)
      select ?, id, coalesce(codigo, ''), nombre, '${MOTIVO_AJUSTE}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ? from productos where id = ? and changes() = 1`)
      .bind(folio, m.faltante, m.esperado, m.esperado + m.faltante, a.correo, a.ahora, a.tienda, a.ventaId, a.caja, m.motivo, m.otras, m.producto_id));
  }
  return sentencias;
}

/**
 * Para el 409 por existencia (#819): después de un aborto, las piezas marcadas cuya existencia sigue siendo la que vio la caja no son la que faltó
 * (el ajuste las cubría); se dejan fuera de la lista que nombra qué quitar. Solo lectura, no decide nada.
 */
export async function cubiertasPorAjuste(env: Env, tienda: string, ventaId: string, marcas: MarcaEnMano[]): Promise<Set<string>> {
  const cubiertas = new Set<string>();
  // Cubierta = la existencia sigue siendo la que vio la caja Y la condición del batch (`LIBRE_SQL`) también se cumple: si un apartado, una orden,
  // un bulto o una cancelación pendiente bloqueó el ajuste, esa pieza sí es la que falta.
  for (const m of marcas) {
    if (await unidadesEn(env, tienda, m.producto_id) !== m.esperado) continue;
    if (await env.DB.prepare(`select 1 as x where ${LIBRE_SQL}`).bind(...libreArgs(`${ventaId}:${m.producto_id}`, m.producto_id)).first()) cubiertas.add(m.producto_id);
  }
  return cubiertas;
}

const dondeDe = (tienda: string, caja: string) => [caja, esTienda(tienda) ? TIENDAS[tienda].nombre : ''].filter(Boolean).join(', ');

/** Después de responder: si algún ajuste sí se aplicó, aviso al dueño (celular o correo). Una venta sin ajuste (la existencia ya había cambiado) no avisa. */
export async function avisarEnMano(env: Env, request: Request, ventaId: string): Promise<void> {
  const { results } = await env.DB.prepare(`select codigo, nombre, antes, razon, caja, tienda, otras from conteo_ajustes
    where venta_id = ? and motivo = '${MOTIVO_AJUSTE}' order by id`).bind(ventaId).all<{ codigo: string; nombre: string; antes: number; razon: string; caja: string; tienda: string; otras: string }>();
  if (!results.length) return;
  const piezas = results.map((r) => `${r.codigo} ${r.nombre} (motivo: ${MOTIVOS_EN_MANO[r.razon as keyof typeof MOTIVOS_EN_MANO] ?? r.razon})${r.otras ? ` ${r.otras}` : ''}`).join('; ');
  const donde = dondeDe(results[0].tienda, results[0].caja);
  await enviarAviso(env, request, 'Pieza vendida sin existencia',
    `Se vendió${results.length > 1 ? 'eron' : ''} con la existencia en 0 porque el cliente la traía en la mano${donde ? ` (${donde})` : ''}: ${piezas}. Revisa de dónde salió.`,
    { frase: 'Revísala en', ruta: '/avisos' });
}

/** GET /api/ventas-sin-existencia — lo vendido así en los últimos días, para /avisos (solo el dueño por la regla de `permiso()`). Solo lectura. */
export async function listarEnMano(env: Env): Promise<Response> {
  const desde = new Date(Date.now() - DIAS_LISTA * 86_400_000).toISOString();
  const { results } = await env.DB.prepare(
    `select a.id, a.venta_id, a.producto_id, a.codigo, a.nombre, a.cantidad as faltante, a.antes, a.despues, a.razon, a.caja, a.tienda,
       a.ajustado_por as cajero, a.ajustado_en, a.otras, coalesce(v.cancelada, 0) as cancelada
     from conteo_ajustes a left join ventas v on v.id = a.venta_id
     where a.motivo = '${MOTIVO_AJUSTE}' and a.ajustado_en >= ? order by a.ajustado_en desc limit 200`,
  ).bind(desde).all<Record<string, unknown> & { tienda: string; razon: string; cancelada: number }>();
  return json(results.map((f) => ({ ...f, cancelada: f.cancelada === 1,
    tienda_nombre: esTienda(f.tienda) ? TIENDAS[f.tienda].nombre : f.tienda, razon_texto: MOTIVOS_EN_MANO[f.razon as keyof typeof MOTIVOS_EN_MANO] ?? f.razon })));
}

/**
 * Después de una cancelación o devolución que regresa una unidad: si esa pieza se vendió DESPUÉS con «La tengo en la mano» (el ajuste es más nuevo que
 * la venta que se revierte), la unidad que regresa puede ser una fantasma. Aviso al dueño; no cambia ningún movimiento de existencia.
 * `lineaId`: solo esa línea (devolución de una pieza); sin él, todas las de la venta.
 */
export async function avisarReverso(env: Env, request: Request, ventaId: string, que: string, lineaId?: number): Promise<void> {
  const { results } = await env.DB.prepare(`select distinct a.codigo, a.nombre from venta_lineas l
    join ventas v on v.id = l.venta_id join conteo_ajustes a on a.producto_id = l.producto_id
    where l.venta_id = ?1 and (?2 is null or l.id = ?2) and a.motivo = '${MOTIVO_AJUSTE}' and a.ajustado_en > v.registrado_en and a.venta_id <> ?1`)
    .bind(ventaId, lineaId ?? null).all<{ codigo: string; nombre: string }>();
  if (!results.length) return;
  await enviarAviso(env, request, `Revisa la existencia: ${que}`,
    `${que} de una venta que regresa una unidad de ${results.map((r) => `${r.codigo} ${r.nombre}`).join(', ')}. Esta pieza se vendió después con «La tengo en la mano»: revisa la existencia.`,
    { frase: 'Revísala en', ruta: '/avisos' });
}
