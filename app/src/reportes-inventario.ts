/**
 * Vista «Inventario» de /reportes (Issue #802): lo que entra, lo que sale, que tan rapido se vende lo capturado y si las rebajas mueven la mercancia.
 * GET /api/reportes/inventario?desde=&hasta= (o dias=). La foto de lo que hay en piso, la merma y los dias por categoria siguen en /api/reportes.
 *
 * Es del negocio completo: `tienda` se valida pero no filtra nada (las capturas son de Soledad, las ventas de las tres tiendas y Mercado Libre salen del mismo inventario).
 *
 * Definiciones (todas con el dia de la tienda, UTC-6, y semanas de lunes a domingo):
 *  - Pieza capturada: fila de `productos` con propietario 'dolaron', sin_inventario = 0, no descartada y que no sea de grado D (caducado = merma), por `creado_en`.
 *  - Unidades vendidas de una pieza: cantidad - cancelada_cantidad de sus lineas en tickets NO cancelados (una devolucion parcial resta), mas lo que Mercado Libre
 *    descontó (ml_ventas.estado = 'descontada', `descontado`). Un ticket cancelado no cuenta y su existencia regresa.
 *  - La cantidad inicial de una pieza NO se guarda: unidades capturadas = vendidas + existencia total de ahora (Soledad + sucursales + en camino) + apartadas
 *    (un apartado vivo ya descontó la existencia y todavia no es venta). Lo que salió por robo, merma o error de captura ya no está en la existencia: no entra al
 *    denominador y se cuenta aparte (`sin_venta`) para que se vea cuánto sesga. Una pieza que salió completa y sin venta desaparece de la cohorte.
 *  - Vendido a k semanas: unidades vendidas a menos de 7k dias de la hora de captura / unidades capturadas de la cohorte (semana de captura). Una cohorte solo muestra
 *    un valor si ya pasaron k semanas desde que cerró la semana (la ultima pieza ya tuvo sus k semanas); si no, null (no es 0 %).
 *  - Rebaja: renglón de `productos_cambios` campo 'precio' que BAJA el precio a algo mayor que cero, hecho por una persona o proceso que no sea la IA ('ia', 'cola'),
 *    y al menos 24 h después de la captura (antes es ajustar el precio del alta, no rebajar).
 *
 * Consultas: ventas se lee UNA vez por pregunta, agrupada por pieza (venta_lineas solo tiene indice por venta_id, nunca por pieza), nada correlacionado.
 */
import { rangoDe, hoyTienda } from './reportes.ts';
import { esTienda } from './cuentas.ts';
import { sumarDias, lunesDe } from './equipo.ts';
import { existenciaTotalSql } from './existencias.ts';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

export const SEMANAS_COHORTE = [1, 2, 4, 8] as const;
export const MIN_SEMANAS_COHORTE = 8;
/** Una rebaja se juzga por lo vendido en estos dias. */
export const VENTANA_REBAJA = 14;
/** Edad de referencia (dias) de cada tramo de antiguedad (0-2, 3-4, 5-8 y 9+ semanas): el punto medio de cada uno. */
export const EDAD_TRAMO = [14, 28, 49, 70] as const;
const LIMITE_TRAMO = [21, 35, 63];   // edad al rebajar que separa los tramos (semanas completas 3, 5 y 9)
/** Menos unidades pendientes que estas entre las rebajadas: la comparacion se muestra pero se avisa que es muestra chica. */
export const MUESTRA_MINIMA = 30;
const GRACIA_REBAJA_HORAS = 24;
const TOPE_DIAS_EN_VENTA = 400;

const dia = (c: string) => `substr(datetime(${c}, '-6 hours'), 1, 10)`;
const lunes = (c: string) => `date(${dia(c)}, '-' || ((cast(strftime('%w', ${dia(c)}) as integer) + 6) % 7) || ' days')`;
const apertura = (d: string) => `${d}T06:00:00.000Z`;
/** La pieza es del inventario de la tienda y cuenta como captura. `p` es el alias de productos. */
const CAPTURABLE = `p.propietario = 'dolaron' and p.sin_inventario = 0 and p.estado_analisis <> 'descartado' and p.estado_fisico <> 'caducado'`;
/** Salidas de existencia por venta: lineas de tickets no cancelados y Mercado Libre, ya netas. `?1` es la cota inferior y `cotaSuperior` el nombre del parametro de la superior. */
const salidas = (cotaSuperior?: string) => `sal as materialized (
    select l.producto_id as pid, v.creado_en as fecha, l.cantidad - l.cancelada_cantidad as cant, 0 as ml
    from ventas v join venta_lineas l on l.venta_id = v.id
    where v.cancelada = 0 and v.creado_en >= ?1${cotaSuperior ? ` and v.creado_en < ${cotaSuperior}` : ''} and l.producto_id is not null and l.cantidad > l.cancelada_cantidad
    union all
    select m.producto_id, m.recibido_en, m.descontado, 1 from ml_ventas m
    where m.estado = 'descontada' and m.descontado > 0 and m.recibido_en >= ?1${cotaSuperior ? ` and m.recibido_en < ${cotaSuperior}` : ''})`;
const apartadas = `pa as materialized (select pl.producto_id as pid, sum(pl.cantidad) as apt from pedido_lineas pl join pedidos pe on pe.id = pl.pedido_id where pe.estado = 'apartado' group by pl.producto_id)`;
const semanasEntre = (ini: string, fin: string) => {
  const lista: string[] = [];
  for (let d = lunesDe(ini); d <= fin; d = sumarDias(d, 7)) lista.push(d);
  return lista;
};

/* ---------- calculo puro (se prueba sin D1) ---------- */

export interface FilaDia { dia: string; piezas: number; unidades: number; vendidas: number; existencia: number; apartadas: number; sin_venta: number; v1: number; v2: number; v4: number; v8: number }

/** Mediana de un histograma { dias: unidades }; con numero par de unidades, el promedio de las dos de en medio. null si no hay unidades. */
export function medianaDe(hist: { d: number; n: number }[]): number | null {
  const filas = [...hist].filter((h) => h.n > 0).sort((a, b) => a.d - b.d);
  const total = filas.reduce((s, h) => s + h.n, 0);
  if (!total) return null;
  const en = (posicion: number) => { let acumulado = 0; for (const h of filas) { acumulado += h.n; if (posicion <= acumulado) return h.d; } return filas.at(-1)!.d; };
  return total % 2 ? en((total + 1) / 2) : (en(total / 2) + en(total / 2 + 1)) / 2;
}

/**
 * Las cohortes: una fila por semana de captura (lunes a domingo, completa). `ahora` decide que columnas ya maduraron: la semana k vale solo si
 * el domingo de esa cohorte + 7k dias ya paso. Sin unidades capturadas, o sin madurez, el porcentaje es null.
 */
export function armarCohortes(filas: FilaDia[], semanas: string[], ahora: number) {
  const porSemana = new Map(semanas.map((l) => [l, { lunes: l, domingo: sumarDias(l, 6), piezas: 0, unidades: 0, vendidas: 0, existencia: 0, apartadas: 0, sin_venta: 0, v: { 1: 0, 2: 0, 4: 0, 8: 0 } as Record<number, number> }]));
  for (const f of filas) {
    const c = porSemana.get(lunesDe(f.dia));
    if (!c) continue;
    c.piezas += f.piezas; c.unidades += f.unidades; c.vendidas += f.vendidas; c.existencia += f.existencia; c.apartadas += f.apartadas; c.sin_venta += f.sin_venta;
    c.v[1] += f.v1; c.v[2] += f.v2; c.v[4] += f.v4; c.v[8] += f.v8;
  }
  const resultado = [...porSemana.values()].map((c) => {
    const cierre = Date.parse(apertura(sumarDias(c.lunes, 7)));
    const maduro = (k: number) => cierre + k * 7 * 86_400_000 <= ahora;
    const pct: Record<number, number | null> = {}, vendidas_en: Record<number, number | null> = {};
    for (const k of SEMANAS_COHORTE) {
      const vale = maduro(k) && c.unidades > 0;
      pct[k] = vale ? (c.v[k] * 100) / c.unidades : null;
      vendidas_en[k] = vale ? c.v[k] : null;
    }
    const { v, ...resto } = c;
    return { ...resto, pct, vendidas_en };
  });
  // Vendido a 4 semanas: solo las cohortes que ya tuvieron sus 4 semanas.
  const maduras = resultado.filter((c) => c.pct[4] !== null);
  const unidades = maduras.reduce((s, c) => s + c.unidades, 0), vendidas = maduras.reduce((s, c) => s + (c.vendidas_en[4] ?? 0), 0);
  return { semanas: resultado, vendido_4: { pct: unidades > 0 ? (vendidas * 100) / unidades : null, unidades, vendidas, semanas: maduras.length } };
}

export interface FilaRebaja { grupo: 'rebajada' | 'control'; tramo: number; piezas: number; pendientes: number; vendidas: number }
const tasa = (vendidas: number, pendientes: number) => (pendientes > 0 ? (vendidas * 100) / pendientes : null);

/**
 * Rebajadas contra piezas de la misma edad sin rebaja. Por tramo: lo vendido en 14 dias entre lo que seguia sin venderse al momento de referencia. El total compara
 * las rebajadas con lo que habrian vendido, a la tasa de su tramo, las piezas sin rebaja: asi la diferencia no viene de que unas sean mas viejas que otras.
 * Un tramo sin piezas de control no entra a ninguno de los dos lados.
 */
export function compararRebajas(filas: FilaRebaja[]) {
  const celda = (g: string, t: number) => filas.find((f) => f.grupo === g && f.tramo === t) ?? { piezas: 0, pendientes: 0, vendidas: 0 };
  const tramos = EDAD_TRAMO.map((_, t) => {
    const r = celda('rebajada', t), c = celda('control', t);
    return { tramo: t, rebajadas: { ...r, pct: tasa(r.vendidas, r.pendientes) }, sin_rebaja: { ...c, pct: tasa(c.vendidas, c.pendientes) } };
  });
  const comparables = tramos.filter((t) => t.rebajadas.pendientes > 0 && t.sin_rebaja.pendientes > 0);
  const pend = comparables.reduce((s, t) => s + t.rebajadas.pendientes, 0);
  const vendidas = comparables.reduce((s, t) => s + t.rebajadas.vendidas, 0);
  const esperadas = comparables.reduce((s, t) => s + (t.rebajadas.pendientes * t.sin_rebaja.vendidas) / t.sin_rebaja.pendientes, 0);
  const rebajadas = tasa(vendidas, pend), sinRebaja = tasa(esperadas, pend);
  return {
    tramos,
    rebajadas: { piezas: tramos.reduce((s, t) => s + t.rebajadas.piezas, 0), pendientes: tramos.reduce((s, t) => s + t.rebajadas.pendientes, 0), vendidas: tramos.reduce((s, t) => s + t.rebajadas.vendidas, 0) },
    comparables: { pendientes: pend, vendidas, pct: rebajadas, pct_sin_rebaja: sinRebaja, diferencia_pp: rebajadas !== null && sinRebaja !== null ? rebajadas - sinRebaja : null },
    poca_muestra: pend < MUESTRA_MINIMA,
  };
}

/* ---------- el endpoint ---------- */

export async function reporteInventario(url: URL, env: Env, ahora = Date.now()): Promise<Response> {
  const rango = rangoDe(url, ahora);
  const pedida = url.searchParams.get('tienda') ?? '';
  if (pedida && !esTienda(pedida)) return json({ error: 'Tienda invalida.' }, 400);
  const { dia_desde: ini, dia_hasta: fin, dias, desde, hasta } = rango;
  const ahoraIso = new Date(ahora).toISOString();

  // Semanas del periodo (recortadas al periodo para entradas, salidas y rebajas) y de las cohortes (completas, y al menos ocho hasta la del final del periodo).
  const ultima = lunesDe(fin);
  const semanasPeriodo = semanasEntre(ini, fin).map((l) => ({
    lunes: l, desde: l < ini ? ini : l, hasta: sumarDias(l, 6) > fin ? fin : sumarDias(l, 6), parcial: l < ini || sumarDias(l, 6) > fin,
  }));
  const primeraCohorte = [lunesDe(ini), sumarDias(ultima, -7 * (MIN_SEMANAS_COHORTE - 1))].sort()[0];
  const semanasCohorte = semanasEntre(primeraCohorte, ultima);
  const cohorteDesde = apertura(primeraCohorte), cohorteHasta = apertura(sumarDias(ultima, 7));
  const cotaControl = apertura(sumarDias(ini, -EDAD_TRAMO[3]));
  const regla = `c.campo = 'precio' and cast(c.despues as integer) > 0 and cast(c.despues as integer) < cast(c.antes as integer)
    and c.por not in ('ia', 'cola') and c.en >= strftime('%Y-%m-%dT%H:%M:%fZ', p.creado_en, '+${GRACIA_REBAJA_HORAS} hours') and p.propietario = 'dolaron'`;
  const tramoSql = (l: string) => `case when ${l} < ${LIMITE_TRAMO[0]} then 0 when ${l} < ${LIMITE_TRAMO[1]} then 1 when ${l} < ${LIMITE_TRAMO[2]} then 2 else 3 end`;


  const [captura, vendidasSemana, enVenta, rebajasSemana, bitacora, efecto] = await Promise.all([
    // 1. Capturas por dia de captura con todo lo necesario para las cohortes: UNA pasada de ventas agrupada por pieza.
    env.DB.prepare(
      `with ${salidas()},
        vp as (select s.pid, sum(s.cant) as vend,
            sum(case when julianday(s.fecha) - julianday(p.creado_en) < 7 then s.cant else 0 end) as v1,
            sum(case when julianday(s.fecha) - julianday(p.creado_en) < 14 then s.cant else 0 end) as v2,
            sum(case when julianday(s.fecha) - julianday(p.creado_en) < 28 then s.cant else 0 end) as v4,
            sum(case when julianday(s.fecha) - julianday(p.creado_en) < 56 then s.cant else 0 end) as v8
          from sal s join productos p on p.id = s.pid where p.propietario = 'dolaron' and p.creado_en >= ?1 and p.creado_en < ?2 group by s.pid),
        ${apartadas},
        aj as (select producto_id as pid, sum(case when antes > despues then antes - despues else 0 end) as fuera from conteo_ajustes
          where ajustado_en >= ?1 and motivo in ('robo', 'merma', 'error de captura') group by producto_id)
       select ${dia('p.creado_en')} as dia, count(*) as piezas,
         sum(${existenciaTotalSql('p.stock', 'p.id')}) as existencia, sum(coalesce(pa.apt, 0)) as apartadas, sum(coalesce(vp.vend, 0)) as vendidas,
         sum(coalesce(aj.fuera, 0)) as sin_venta, sum(coalesce(vp.v1, 0)) as v1, sum(coalesce(vp.v2, 0)) as v2, sum(coalesce(vp.v4, 0)) as v4, sum(coalesce(vp.v8, 0)) as v8
       from productos p left join vp on vp.pid = p.id left join pa on pa.pid = p.id left join aj on aj.pid = p.id
       where ${CAPTURABLE} and p.creado_en >= ?1 and p.creado_en < ?2 and julianday(p.creado_en) is not null
       group by 1 order by 1`,
    ).bind(cohorteDesde, cohorteHasta).all<Omit<FilaDia, 'unidades'>>(),
    // 2. Salidas por semana del periodo (tickets y Mercado Libre de piezas del inventario).
    env.DB.prepare(
      `with ${salidas('?2')}
       select ${lunes('s.fecha')} as lunes, sum(s.cant) as vendidas, sum(case when s.ml = 1 then s.cant else 0 end) as ml
       from sal s cross join productos p on p.id = s.pid where p.propietario = 'dolaron' and p.sin_inventario = 0 group by 1`,
    ).bind(desde, hasta).all<{ lunes: string; vendidas: number; ml: number }>(),
    // 3. Dias de la captura a la venta de lo vendido en el periodo y en el anterior, como histograma.
    env.DB.prepare(
      `with ${salidas('?2')}
       select case when s.fecha >= ?3 then 'a' else 'b' end as v,
         min(${TOPE_DIAS_EN_VENTA}, max(0, cast(julianday(${dia('s.fecha')}) - julianday(${dia('p.creado_en')}) as integer))) as d, sum(s.cant) as n
       from sal s cross join productos p on p.id = s.pid
       where p.propietario = 'dolaron' and p.sin_inventario = 0 and julianday(p.creado_en) is not null group by 1, 2`,
    ).bind(rango.anterior_desde, hasta, desde).all<{ v: string; d: number; n: number }>(),
    // 4. Rebajas del periodo por semana: un renglon por cambio de precio (una pieza puede aportar varios).
    env.DB.prepare(
      `with ev as materialized (
         select c.producto_id as pid, c.en, (cast(c.antes as integer) - cast(c.despues as integer)) * 100.0 / cast(c.antes as integer) as pct
         from productos_cambios c join productos p on p.id = c.producto_id where ${regla} and c.en >= ?1 and c.en < ?2)
       select ${lunes('en')} as lunes, count(*) as eventos, count(distinct pid) as piezas, sum(pct) as suma_pct,
         (select count(distinct pid) from ev) as piezas_total from ev group by 1`,
    ).bind(desde, hasta).all<{ lunes: string; eventos: number; piezas: number; suma_pct: number; piezas_total: number }>(),
    // 5. Desde cuando existe el registro: el primer renglon (id autoincremental), sin recorrer la tabla.
    env.DB.prepare('select en from productos_cambios order by id limit 1').first<{ en: string }>(),
    // 6. Rebajadas contra piezas de la misma edad sin rebaja: otra pasada de ventas agrupada por pieza, desde el inicio del periodo.
    env.DB.prepare(
      `with ${salidas()},
        md as materialized (select c.producto_id as pid, min(c.en) as en from productos_cambios c join productos p on p.id = c.producto_id where ${regla} group by c.producto_id),
        pop as (select id as pid from productos where propietario = 'dolaron' and creado_en >= ?2 and creado_en < ?3
                union select pid from md where en >= ?1 and en < ?3),
        ${apartadas},
        bandas(t, l) as (values (0, ${EDAD_TRAMO[0]}), (1, ${EDAD_TRAMO[1]}), (2, ${EDAD_TRAMO[2]}), (3, ${EDAD_TRAMO[3]})),
        ex as materialized (select p.id as pid, p.creado_en as creado, ${existenciaTotalSql('p.stock', 'p.id')} as u from pop cross join productos p on p.id = pop.pid
               where ${CAPTURABLE} and julianday(p.creado_en) is not null),
        vb as (select s.pid, b.t,
            sum(case when julianday(s.fecha) >= julianday(ex.creado) + b.l then s.cant else 0 end) as sale,
            sum(case when julianday(s.fecha) >= julianday(ex.creado) + b.l and julianday(s.fecha) < julianday(ex.creado) + b.l + ${VENTANA_REBAJA} then s.cant else 0 end) as en14
          from sal s join ex on ex.pid = s.pid cross join bandas b group by s.pid, b.t),
        vm as (select s.pid, sum(case when s.fecha >= md.en then s.cant else 0 end) as sale,
            sum(case when s.fecha >= md.en and julianday(s.fecha) < julianday(md.en) + ${VENTANA_REBAJA} then s.cant else 0 end) as en14
          from sal s join md on md.pid = s.pid group by s.pid)
       select 'control' as grupo, b.t as tramo, count(*) as piezas, sum(ex.u + coalesce(pa.apt, 0) + coalesce(vb.sale, 0)) as pendientes, sum(coalesce(vb.en14, 0)) as vendidas
       from ex cross join bandas b left join md on md.pid = ex.pid left join vb on vb.pid = ex.pid and vb.t = b.t left join pa on pa.pid = ex.pid
       where julianday(ex.creado) + b.l >= julianday(?1) and julianday(ex.creado) + b.l < julianday(?3) and julianday(ex.creado) + b.l + ${VENTANA_REBAJA} <= julianday(?4)
         and (md.en is null or julianday(md.en) >= julianday(ex.creado) + b.l + ${VENTANA_REBAJA})
         and ex.u + coalesce(pa.apt, 0) + coalesce(vb.sale, 0) > 0
       group by b.t
       union all
       select 'rebajada', tramo, count(*), sum(pend), sum(en14) from (
         select ${tramoSql('(julianday(md.en) - julianday(ex.creado))')} as tramo, ex.u + coalesce(pa.apt, 0) + coalesce(vm.sale, 0) as pend, coalesce(vm.en14, 0) as en14
         from ex join md on md.pid = ex.pid left join vm on vm.pid = ex.pid left join pa on pa.pid = ex.pid
         where md.en >= ?1 and md.en < ?3 and julianday(md.en) + ${VENTANA_REBAJA} <= julianday(?4))
       where pend > 0 group by tramo`,
    ).bind(desde, cotaControl, hasta, ahoraIso).all<{ grupo: 'rebajada' | 'control'; tramo: number; piezas: number; pendientes: number; vendidas: number }>(),
  ]);

  // Entradas y salidas, una fila por semana del periodo (la primera y la ultima pueden ser parciales).
  const diasCaptura: FilaDia[] = captura.results.map((f) => ({ ...f, unidades: f.existencia + f.apartadas + f.vendidas }));
  const salidasPorSemana = new Map(vendidasSemana.results.map((f) => [f.lunes, f]));
  const rebajasPorSemana = new Map(rebajasSemana.results.map((f) => [f.lunes, f]));
  const semanas = semanasPeriodo.map((w) => {
    const dentro = diasCaptura.filter((f) => f.dia >= w.desde && f.dia <= w.hasta);
    const capturadas = dentro.reduce((s, f) => s + f.unidades, 0);
    const v = salidasPorSemana.get(w.lunes);
    return { ...w, capturadas, piezas: dentro.reduce((s, f) => s + f.piezas, 0), vendidas: v?.vendidas ?? 0, vendidas_ml: v?.ml ?? 0, neto: capturadas - (v?.vendidas ?? 0) };
  });
  const suma = (campo: 'capturadas' | 'piezas' | 'vendidas' | 'vendidas_ml' | 'neto') => semanas.reduce((s, w) => s + w[campo], 0);

  const hist = (v: string) => enVenta.results.filter((f) => f.v === v).map((f) => ({ d: f.d, n: f.n }));
  const tramosDias = [[0, 6, '0–6 días'], [7, 13, '7–13 días'], [14, 27, '14–27 días'], [28, 55, '28–55 días'], [56, Infinity, '56 días o más']] as const;
  const histA = hist('a'), histB = hist('b');

  const eventos = rebajasSemana.results.reduce((s, f) => s + f.eventos, 0);
  const sumaPct = rebajasSemana.results.reduce((s, f) => s + f.suma_pct, 0);
  const comparacion = compararRebajas(efecto.results);

  return json({
    dias, dia_desde: ini, dia_hasta: fin, hoy: hoyTienda(ahora), ahora: ahoraIso, tienda: '',
    flujo: {
      semanas,
      total: { capturadas: suma('capturadas'), piezas: suma('piezas'), vendidas: suma('vendidas'), vendidas_ml: suma('vendidas_ml'), neto: suma('neto') },
    },
    cohortes: { minimo_semanas: MIN_SEMANAS_COHORTE, ...armarCohortes(diasCaptura, semanasCohorte, ahora) },
    dias_en_venta: {
      mediana: medianaDe(histA), mediana_antes: medianaDe(histB),
      unidades: histA.reduce((s, h) => s + h.n, 0), unidades_antes: histB.reduce((s, h) => s + h.n, 0),
      tramos: tramosDias.map(([a, b, nombre]) => ({ nombre, unidades: histA.filter((h) => h.d >= a && h.d <= b).reduce((s, h) => s + h.n, 0) })),
    },
    rebajas: {
      desde_bitacora: bitacora ? new Date(Date.parse(bitacora.en) - 6 * 3_600_000).toISOString().slice(0, 10) : null,
      semanas: semanasPeriodo.map((w) => {
        const f = rebajasPorSemana.get(w.lunes);
        return { ...w, eventos: f?.eventos ?? 0, piezas: f?.piezas ?? 0, pct_promedio: f && f.eventos ? f.suma_pct / f.eventos : null };
      }),
      total: { eventos, piezas: rebajasSemana.results[0]?.piezas_total ?? 0, pct_promedio: eventos ? sumaPct / eventos : null },
      comparacion: { ventana_dias: VENTANA_REBAJA, edades: EDAD_TRAMO, ...comparacion },
    },
  });
}
