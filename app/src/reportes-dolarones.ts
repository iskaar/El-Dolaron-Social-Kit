/**
 * Vista «Dolarones» de /reportes (Issue #802): todo el programa en un solo lugar, al centavo.
 * GET /api/reportes/dolarones?desde=&hasta= (o dias=) &tienda=
 *
 * Hay DOS libros, y cada uno cierra con su propia identidad (centavos enteros, 1 D = 100):
 *
 *  Socio (dolarones_lotes + dolarones_movimientos). Un lote nace con `importe` y `restante` baja o sube solo
 *  con movimientos dentro del mismo batch que la venta:
 *     restante = importe + canje + reverso_canje + reverso_compra + reverso_promo + reverso_referido + reemplazo
 *  (canje y reversos de compra son negativos; reverso_canje es positivo). Los movimientos de alta (compra, promo,
 *  regalo, reto, referido, referido_nuevo, alta_referido) repiten `importe`: no se suman otra vez, se comparan.
 *
 *  Vale de papel y cupon (vales_dolarones + vales_movimientos):
 *     restante = importe + canje + reverso_canje + retiro - (importe si reclamado_por: paso a cuenta de socio)
 *  El vale reclamado queda en 0 SIN movimiento propio: se lee de reclamado_por/reclamado_en. Su lote nace en el libro
 *  de socio con el importe a tarifa de socio: del lote se cuenta como emision solo lo que excede al vale (lote - vale)
 *  y el vale como «traspaso» (+ en el lote, - en el vale), asi no se emite dos veces.
 *
 *  El VENCIMIENTO no deja movimiento: un lote o vale con vence_en <= ahora deja de contar como saldo vivo y lo que le
 *  quedaba es «vencido». Un reverso_canje que regresa a un lote ya vencido se pierde en el acto (decision de #135).
 *
 *  Para los dos libros:   emitido + traspaso - canjeado(neto) - retirado = vivo + vencido
 *  y el cuadre compara vivo + vencido (de los movimientos) contra la suma de `restante` guardada.
 */
import { lineasNetas } from './netas.ts';
import { rangoDe, hoyTienda } from './reportes.ts';
import { esTienda, TIENDAS } from './cuentas.ts';
import { sumarDias, lunesDe } from './equipo.ts';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

export const ORIGENES = [
  { clave: 'vale', nombre: 'Vale de papel', libro: 'vale' },
  { clave: 'socio', nombre: 'Compra de socio', libro: 'socio' },
  { clave: 'promo', nombre: 'Bono de la promoción', libro: 'socio' },
  { clave: 'regalo', nombre: 'Regalo de apertura', libro: 'socio' },
  { clave: 'referido', nombre: 'Referidos', libro: 'socio' },
  { clave: 'equipo', nombre: 'Equipo (retos)', libro: 'socio' },
  { clave: 'cupon', nombre: 'Cupón (devolución o manual)', libro: 'vale' },
  { clave: 'otro', nombre: 'Otro origen', libro: 'socio' },
] as const;
type Libro = 'socio' | 'vale';

/** Tipos de dolarones_movimientos que repiten el alta del lote (no mueven saldo: se comparan con `importe`). */
const TIPOS_ALTA = ['compra', 'promo', 'regalo', 'reto', 'referido', 'referido_nuevo', 'alta_referido'];
/** Los que retiran saldo de un lote (cancelar la compra que lo gano, cambiar el regalo de apertura). */
const TIPOS_RETIRO = ['reverso_compra', 'reverso_promo', 'reverso_referido', 'reemplazo'];
/** Los que dan origen a un lote desde una venta: de ahi sale la tienda del lote. */
const TIPOS_NACIMIENTO = ['compra', 'promo', 'referido', 'referido_nuevo'];

const dia = (c: string) => `substr(datetime(${c}, '-6 hours'), 1, 10)`;
// El ultimo segundo antes de vencer: un lote que vence a las 00:00 vence «el dia anterior».
const diaVence = (c: string) => `substr(datetime(${c}, '-6 hours', '-1 seconds'), 1, 10)`;
const lista = (v: string[]) => v.map((t) => `'${t}'`).join(', ');

interface Fila {
  libro: Libro; origen: string; cat: string; vigente: number; dia: string; dia_vence: string; tardio: number;
  por_liberar: number; t_evt: string; t_lote: string; importe: number; n: number;
}

/**
 * Todos los hechos de UN libro, ya agrupados por dia (D1 no admite mas de 5 terminos en un compound SELECT: cada libro
 * va en su consulta, de cuatro): la cantidad de filas que vuelve
 * depende de los dias y los origenes, no de cuantos vales haya. Categorias: emision, traspaso, canje, reverso_canje,
 * retiro, otro (suman al saldo), asiento (el movimiento de alta, solo para comparar) y guardado (la columna restante).
 * Con `tienda` cada hecho trae la de su venta (ventas.tienda) y la de la venta que dio origen a su lote o vale.
 */
export function consultaLibro(conTienda: boolean, libro: Libro) {
  // La venta que dio origen a cada lote (para su tienda), calculada una sola vez.
  const cte = conTienda
    ? `with lv as materialized (select l2.id as lote, coalesce(l2.venta_id, mm.venta_id) as venta from dolarones_lotes l2
         left join (select lote_id, min(venta_id) as venta_id from dolarones_movimientos
           where tipo in (${lista(TIPOS_NACIMIENTO)}) and venta_id is not null group by lote_id) mm on mm.lote_id = l2.id) `
    : '';
  const lv = conTienda ? 'left join lv on lv.lote = l.id' : '';
  const ventaLote = conTienda ? 'lv.venta' : 'null';
  const origenLote = `case l.origen when 'compra' then 'socio' when 'promo' then 'promo' when 'regalo' then 'regalo'
    when 'referido' then 'referido' when 'reto' then 'equipo' else 'otro' end`;
  const origenVale = `case v.origen when 'compra' then 'vale' else 'cupon' end`;
  const ventaVale = 'coalesce(v.venta_id, v.venta_origen)';
  const tipoLote = `case m.tipo when 'canje' then 'canje' when 'reverso_canje' then 'reverso_canje'
    when ${TIPOS_RETIRO.map((t) => `'${t}'`).join(' then \'retiro\' when ')} then 'retiro'
    when ${TIPOS_ALTA.map((t) => `'${t}'`).join(' then \'asiento\' when ')} then 'asiento' else 'otro' end`;
  const pasoACuenta = `join vales_dolarones k on k.venta_id = l.venta_id and k.reclamado_por = l.cliente_id`;
  const tiendaDe = (venta: string) => conTienda ? `coalesce((select tienda from ventas where id = ${venta}), '')` : `''`;

  return `${cte}select libro, origen, cat, (vence > ?1) as vigente,
      case when cat = 'guardado' then '' else ${dia('fecha')} end as dia, ${diaVence('vence')} as dia_vence,
      (cat <> 'guardado' and fecha > vence) as tardio, por_liberar,
      ${tiendaDe('venta_evt')} as t_evt, ${tiendaDe('venta_lote')} as t_lote, sum(importe) as importe, count(*) as n
    from (
${libro === 'socio' ? `
      select 'socio' as libro, ${origenLote} as origen, 'emision' as cat, l.creado_en as fecha, l.importe - coalesce(k.importe, 0) as importe,
        l.vence_en as vence, ${ventaLote} as venta_evt, ${ventaLote} as venta_lote, 0 as por_liberar
      from dolarones_lotes l left join vales_dolarones k on k.venta_id = l.venta_id and k.reclamado_por = l.cliente_id ${lv}
      union all
      select 'socio', ${origenLote}, 'traspaso', l.creado_en, k.importe, l.vence_en, ${ventaLote}, ${ventaLote}, 0
      from dolarones_lotes l ${pasoACuenta} ${lv}
      union all
      select 'socio', ${origenLote}, ${tipoLote}, m.creado_en, m.importe, l.vence_en, m.venta_id, ${ventaLote}, 0
      from dolarones_movimientos m join dolarones_lotes l on l.id = m.lote_id ${lv}
      union all
      select 'socio', ${origenLote}, 'guardado', '', l.restante, l.vence_en, null, ${ventaLote}, l.disponible_desde > ?1
      from dolarones_lotes l ${lv}
`
      : `
      select 'vale' as libro, ${origenVale} as origen, 'emision' as cat, v.creado_en as fecha, v.importe as importe, v.vence_en as vence,
        ${ventaVale} as venta_evt, ${ventaVale} as venta_lote, 0 as por_liberar
      from vales_dolarones v
      union all
      select 'vale', ${origenVale}, 'traspaso', v.reclamado_en, -v.importe, v.vence_en, ${ventaVale}, ${ventaVale}, 0
      from vales_dolarones v where v.reclamado_por is not null
      union all
      select 'vale', ${origenVale}, case m.tipo when 'emision' then 'asiento' when 'canje' then 'canje'
        when 'reverso_canje' then 'reverso_canje' when 'retiro' then 'retiro' else 'otro' end,
        m.creado_en, m.importe, v.vence_en, m.venta_id, ${ventaVale}, 0
      from vales_movimientos m join vales_dolarones v on v.id = m.vale_id
      union all
      select 'vale', ${origenVale}, 'guardado', '', v.restante, v.vence_en, null, ${ventaVale}, 0
      from vales_dolarones v
`}
    )
    group by libro, origen, cat, vigente, dia, dia_vence, tardio, por_liberar, t_evt, t_lote`;
}

/* ---------- calculo sobre las filas (puro: se prueba sin D1) ---------- */

const MOVIMIENTOS = new Set(['emision', 'traspaso', 'canje', 'reverso_canje', 'retiro', 'otro']);
const libroDe = (origen: string): Libro => (ORIGENES.find((o) => o.clave === origen)?.libro ?? 'socio');

function ceros() {
  return { emitido: 0, traspaso: 0, canje: 0, reverso_canje: 0, retirado: 0, otros: 0, vencido: 0, vivo: 0,
    guardado_vivo: 0, guardado_vencido: 0, por_liberar: 0, asiento: 0 };
}
type Cuenta = ReturnType<typeof ceros>;

/** Todo lo de siempre, por origen, sin periodo ni tienda: es lo que cuadra contra `restante`. */
export function totalesPorOrigen(filas: Fila[]) {
  const por = new Map<string, Cuenta>();
  for (const f of filas) {
    const c = por.get(f.origen) ?? por.set(f.origen, ceros()).get(f.origen)!;
    if (f.cat === 'guardado') {
      if (f.vigente) { c.guardado_vivo += f.importe; if (f.por_liberar) c.por_liberar += f.importe; } else c.guardado_vencido += f.importe;
    } else if (f.cat === 'asiento') c.asiento += f.importe;
    else {
      if (f.cat === 'emision') c.emitido += f.importe;
      else if (f.cat === 'traspaso') c.traspaso += f.importe;
      else if (f.cat === 'canje') c.canje += f.importe;
      else if (f.cat === 'reverso_canje') c.reverso_canje += f.importe;
      else if (f.cat === 'retiro') c.retirado -= f.importe;
      else c.otros += f.importe;
      if (f.vigente) c.vivo += f.importe; else c.vencido += f.importe;
    }
  }
  return por;
}

function sumaCuentas(cuentas: Cuenta[]): Cuenta {
  const total = ceros();
  for (const c of cuentas) for (const k of Object.keys(total) as (keyof Cuenta)[]) total[k] += c[k];
  return total;
}

/** Una cuenta lista para la pantalla: lo canjeado en neto y la diferencia contra lo guardado. */
function cuadreDe(c: Cuenta, asientoEsperado: number) {
  const diferenciaVivo = c.vivo - c.guardado_vivo;
  const diferenciaVencido = c.vencido - c.guardado_vencido;
  return {
    emitido: c.emitido, traspaso: c.traspaso,
    canjeado: -(c.canje + c.reverso_canje), canjeado_bruto: -c.canje, reversos_canje: c.reverso_canje,
    retirado: c.retirado, otros: c.otros, vencido: c.vencido, vivo: c.vivo,
    guardado_vivo: c.guardado_vivo, guardado_vencido: c.guardado_vencido,
    diferencia_vivo: diferenciaVivo, diferencia_vencido: diferenciaVencido, diferencia: diferenciaVivo + diferenciaVencido,
    asientos: { esperado: asientoEsperado, registrado: c.asiento, diferencia: c.asiento - asientoEsperado },
  };
}

const coincide = (clave: string, tienda: string) => !tienda || clave === tienda;

/** Lo que paso dentro de [ini, fin] (dias de la tienda, ambos incluidos), por origen. */
export function flujoEntre(filas: Fila[], tienda: string, ini: string, fin: string) {
  const por = new Map<string, { emitido: number; traspaso: number; canjeado: number; retirado: number; vencido: number }>();
  const celda = (o: string) => por.get(o) ?? por.set(o, { emitido: 0, traspaso: 0, canjeado: 0, retirado: 0, vencido: 0 }).get(o)!;
  for (const f of filas) {
    if (!MOVIMIENTOS.has(f.cat)) continue;
    if (f.dia >= ini && f.dia <= fin && coincide(f.t_evt, tienda)) {
      const c = celda(f.origen);
      if (f.cat === 'emision') c.emitido += f.importe;
      else if (f.cat === 'traspaso') c.traspaso += f.importe;
      else if (f.cat === 'canje' || f.cat === 'reverso_canje') c.canjeado -= f.importe;
      else c.retirado -= f.importe;
    }
    // Vencido: lo que le quedaba al lote o vale al pasar su ultimo segundo; lo que regresa despues se pierde el dia que regresa.
    if (!f.vigente && coincide(f.t_lote, tienda) && (f.tardio ? f.dia >= ini && f.dia <= fin : f.dia_vence >= ini && f.dia_vence <= fin)) celda(f.origen).vencido += f.importe;
  }
  return por;
}

const sumaFlujo = (por: ReturnType<typeof flujoEntre>, donde: (o: string) => boolean = () => true) => {
  const t = { emitido: 0, traspaso: 0, canjeado: 0, retirado: 0, vencido: 0 };
  for (const [o, c] of por) if (donde(o)) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += c[k];
  return t;
};

/** Saldo vivo al cierre de `d` (dia de la tienda), reconstruido de los movimientos y las fechas de vencimiento. */
export const vivoAlCierre = (filas: Fila[], d: string) =>
  filas.reduce((s, f) => (MOVIMIENTOS.has(f.cat) && f.dia <= d && f.dia_vence > d ? s + f.importe : s), 0);

/** Lo que cerro su vigencia en [ini, fin]: cuanto de lo emitido llego a usarse. Sin base: tasa null. */
export function cohorteCerrada(filas: Fila[], tienda: string, ini: string, fin: string) {
  const por = { socio: { base: 0, canjeado: 0, vencido: 0 }, vale: { base: 0, canjeado: 0, vencido: 0 } };
  for (const f of filas) {
    if (!MOVIMIENTOS.has(f.cat) || f.vigente || f.dia_vence < ini || f.dia_vence > fin || !coincide(f.t_lote, tienda)) continue;
    const c = por[f.libro];
    c.vencido += f.importe;   // el saldo final de esos lotes: lo que se emitio menos lo que se uso o retiro
    if (f.cat === 'emision' || f.cat === 'traspaso') c.base += f.importe;
    else if (f.cat === 'retiro') c.base += f.importe;           // importe negativo: lo retirado ya no pudo usarse
    else if (f.cat === 'canje' || f.cat === 'reverso_canje') c.canjeado -= f.importe;
    else c.base += f.importe;
  }
  const una = (c: { base: number; canjeado: number; vencido: number }) => ({ ...c, tasa: c.base > 0 ? c.canjeado / c.base : null });
  const total = { base: por.socio.base + por.vale.base, canjeado: por.socio.canjeado + por.vale.canjeado, vencido: por.socio.vencido + por.vale.vencido };
  return { total: una(total), socio: una(por.socio), vale: una(por.vale) };
}

/** Las cubetas de la grafica: por dia hasta 35 dias; despues, por semana de lunes a domingo recortada al periodo. */
export function cubetas(diaDesde: string, diaHasta: string, dias: number) {
  const salida: { desde: string; hasta: string; parcial: boolean }[] = [];
  if (dias <= 35) {
    for (let d = diaDesde; d <= diaHasta; d = sumarDias(d, 1)) salida.push({ desde: d, hasta: d, parcial: false });
    return { grano: 'dia' as const, cubetas: salida };
  }
  for (let lunes = lunesDe(diaDesde); lunes <= diaHasta; lunes = sumarDias(lunes, 7)) {
    const domingo = sumarDias(lunes, 6);
    const desde = lunes < diaDesde ? diaDesde : lunes, hasta = domingo > diaHasta ? diaHasta : domingo;
    salida.push({ desde, hasta, parcial: desde !== lunes || hasta !== domingo });
  }
  return { grano: 'semana' as const, cubetas: salida };
}

const HISTOGRAMA = [['0', 'Mismo día', 0, 0], ['1-3', '1–3 días', 1, 3], ['4-7', '4–7 días', 4, 7], ['8-14', '8–14 días', 8, 14],
  ['15-21', '15–21 días', 15, 21], ['22+', '22 días o más', 22, 9999]] as const;

/* ---------- el endpoint ---------- */

export async function reporteDolarones(url: URL, env: Env, ahora = Date.now()): Promise<Response> {
  const rango = rangoDe(url, ahora);
  const pedida = url.searchParams.get('tienda') ?? '';
  if (pedida && !esTienda(pedida)) return json({ error: 'Tienda invalida.' }, 400);
  const tienda = pedida;
  const hoy = hoyTienda(ahora);
  const ahoraIso = new Date(ahora).toISOString();
  const { dia_desde: ini, dia_hasta: fin, dias, desde, hasta } = rango;
  const antes = { ini: sumarDias(ini, -dias), fin: sumarDias(ini, -1), desde: rango.anterior_desde };
  const deTienda = tienda ? ` and v.tienda = '${tienda}'` : '';

  // Ventas netas y tickets con/sin Dolarones, con la misma definicion de /api/reportes (lineasNetas, solo piezas de la tienda).
  const efecto = async (d: string, h: string) => {
    const { results } = await env.DB.prepare(
      `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
       select con, count(*) as tickets, coalesce(sum(neto), 0) as neto, coalesce(sum(d), 0) as dolarones from (
         select venta, sum(neta) as neto, sum(neta - cobrado - anticipo_linea) as d, (sum(neta - cobrado - anticipo_linea) <> 0) as con
         from cobros where propietario = 'dolaron' group by venta) group by con`,
    ).bind(d, h).all<{ con: number; tickets: number; neto: number; dolarones: number }>();
    const fila = (con: number) => results.find((f) => f.con === con) ?? { tickets: 0, neto: 0, dolarones: 0 };
    const con = fila(1), sin = fila(0);
    return { con: { tickets: con.tickets, neto: con.neto, dolarones: con.dolarones, dinero: con.neto - con.dolarones },
      sin: { tickets: sin.tickets, neto: sin.neto }, ventas_netas: con.neto + sin.neto, tickets: con.tickets + sin.tickets };
  };

  const diasVale = `cast(julianday(${dia('m.creado_en')}) - julianday(${dia('v.creado_en')}) as integer)`;
  const deTiendaVale = tienda ? ` and (select tienda from ventas where id = coalesce(v.venta_id, v.venta_origen)) = '${tienda}'` : '';
  const enPeriodoVentas = `s.cancelada = 0 and s.creado_en >= ?1 and s.creado_en < ?2${tienda ? ` and s.tienda = '${tienda}'` : ''}`;

  const [libroSocio, libroVale, actual, previo, tickets, resultados, tardanza, saldos] = await Promise.all([
    env.DB.prepare(consultaLibro(!!tienda, 'socio')).bind(ahoraIso).all<Fila>(),
    env.DB.prepare(consultaLibro(!!tienda, 'vale')).bind(ahoraIso).all<Fila>(),
    efecto(desde, hasta),
    efecto(antes.desde, desde),
    // Los Dolarones que dicen los tickets contra lo que dicen los movimientos de esos mismos tickets: cancelados fuera de los dos.
    env.DB.prepare(
      `select (select coalesce(sum(dolarones - dolarones_devueltos), 0) from ventas s where ${enPeriodoVentas}) as en_tickets,
         (select coalesce(sum(-m.importe), 0) from ventas s cross join dolarones_movimientos m on m.venta_id = s.id
            where m.tipo in ('canje', 'reverso_canje') and ${enPeriodoVentas}) as socio,
         (select coalesce(sum(-m.importe), 0) from vales_movimientos m cross join ventas s on s.id = m.venta_id
            where m.tipo in ('canje', 'reverso_canje') and ${enPeriodoVentas}) as vale`,
    ).bind(desde, hasta).first<{ en_tickets: number; socio: number; vale: number }>(),
    // Que paso con los vales de papel emitidos en el periodo (una fila por vale, un solo resultado cada uno).
    env.DB.prepare(
      `select case
           when reclamado_por is not null then 'cuenta'
           when importe - retiro <= 0 then 'retirado'
           when restante = 0 and canje > 0 then 'completo'
           when restante > 0 and vence_en <= ?3 and canje > 0 then 'parcial'
           when restante > 0 and vence_en <= ?3 then 'vencido'
           else 'vivo' end as resultado,
         count(*) as n, coalesce(sum(importe), 0) as importe, coalesce(sum(canje), 0) as canjeado
       from (select v.id, v.importe, v.restante, v.vence_en, v.reclamado_por,
           coalesce(sum(case when m.tipo in ('canje', 'reverso_canje') then -m.importe end), 0) as canje,
           coalesce(sum(case when m.tipo = 'retiro' then -m.importe end), 0) as retiro
         from vales_dolarones v left join vales_movimientos m on m.vale_id = v.id
         where v.origen = 'compra' and v.creado_en >= ?1 and v.creado_en < ?2${deTiendaVale}
         group by v.id) group by resultado`,
    ).bind(desde, hasta, ahoraIso).all<{ resultado: string; n: number; importe: number; canjeado: number }>(),
    // Dias entre la emision de un vale de papel y cada vez que se uso, por canje del periodo.
    env.DB.prepare(
      `select ${diasVale} as dias, count(*) as n, coalesce(sum(-m.importe), 0) as importe
       from vales_movimientos m join vales_dolarones v on v.id = m.vale_id
       where m.tipo = 'canje' and v.origen = 'compra' and m.creado_en >= ?1 and m.creado_en < ?2${deTiendaVale}
       group by dias`,
    ).bind(desde, hasta).all<{ dias: number; n: number; importe: number }>(),
    // Los saldos mas grandes por NUMERO de socio: ni nombre ni telefono salen de aqui.
    env.DB.prepare(
      `select t.numero, t.saldo, t.disponible, t.por_liberar, ${diaVence('t.vence_primero')} as vence_primero,
         (select max(${dia('creado_en')}) from ventas where cliente_id = t.id and cancelada = 0) as ultima_compra
       from (select c.id, c.numero, sum(l.restante) as saldo,
           sum(case when l.disponible_desde <= ?1 then l.restante else 0 end) as disponible,
           sum(case when l.disponible_desde > ?1 then l.restante else 0 end) as por_liberar, min(l.vence_en) as vence_primero
         from dolarones_lotes l join clientes c on c.id = l.cliente_id where l.restante > 0 and l.vence_en > ?1
         group by c.id order by saldo desc, c.numero limit 10) t order by t.saldo desc, t.numero`,
    ).bind(ahoraIso).all<{ numero: number; saldo: number; disponible: number; por_liberar: number; vence_primero: string; ultima_compra: string | null }>(),
  ]);

  const filas = [...libroSocio.results, ...libroVale.results].map((f) => ({ ...f, importe: Number(f.importe) })) as Fila[];
  const porOrigen = totalesPorOrigen(filas);
  const hayOtro = porOrigen.has('otro');
  const origenes = ORIGENES.filter((o) => o.clave !== 'otro' || hayOtro);
  const cuentaDe = (origen: string) => porOrigen.get(origen) ?? ceros();

  // Cuadre de siempre, del negocio completo: cada libro por su cuenta y el total.
  const de = (l: Libro) => origenes.filter((o) => o.libro === l).map((o) => cuentaDe(o.clave));
  const asientoEsperado = (l: Libro) => origenes.filter((o) => o.libro === l && o.clave !== 'cupon')
    .reduce((s, o) => s + cuentaDe(o.clave).emitido + (l === 'socio' ? cuentaDe(o.clave).traspaso : 0), 0);
  const cuadreSocio = cuadreDe(sumaCuentas(de('socio')), asientoEsperado('socio'));
  const cuadreVale = cuadreDe(sumaCuentas(de('vale')), asientoEsperado('vale'));
  const cuadreTotal = cuadreDe(sumaCuentas([...de('socio'), ...de('vale')]), asientoEsperado('socio') + asientoEsperado('vale'));
  const cuadre = { socio: cuadreSocio, vale: cuadreVale, total: cuadreTotal, ok: cuadreTotal.diferencia === 0 && cuadreSocio.diferencia === 0 && cuadreVale.diferencia === 0 };

  const tablaOrigen = origenes.map((o) => {
    const c = cuentaDe(o.clave);
    return { origen: o.clave, nombre: o.nombre, libro: o.libro, emitido: c.emitido, traspaso: c.traspaso, canjeado: -(c.canje + c.reverso_canje),
      vencido: c.vencido, retirado: c.retirado + (-c.otros), vivo: c.vivo, guardado_vivo: c.guardado_vivo };
  });

  // Periodo, periodo anterior y cada cubeta de las graficas.
  const flujo = flujoEntre(filas, tienda, ini, fin);
  const flujoAntes = flujoEntre(filas, tienda, antes.ini, antes.fin);
  const total = sumaFlujo(flujo), totalAntes = sumaFlujo(flujoAntes);
  const sinCupon = (o: string) => o !== 'cupon';
  const { grano, cubetas: tramos } = cubetas(ini, fin, dias);
  const serie = tramos.map((t) => {
    const f = flujoEntre(filas, tienda, t.desde, t.hasta);
    const s = sumaFlujo(f);
    return { ...t, emitidos: s.emitido + s.traspaso, canjeados: s.canjeado, vencidos: s.vencido, retirados: s.retirado,
      vivo: t.hasta >= hoy ? cuadreTotal.vivo : vivoAlCierre(filas, t.hasta),
      por_origen: Object.fromEntries(origenes.map((o) => [o.clave, (f.get(o.clave)?.emitido ?? 0) + (f.get(o.clave)?.traspaso ?? 0)])) };
  });
  const porOrigenPeriodo = origenes.map((o) => {
    const c = flujo.get(o.clave) ?? { emitido: 0, traspaso: 0, canjeado: 0, retirado: 0, vencido: 0 };
    return { origen: o.clave, nombre: o.nombre, ...c };
  });

  // Lo que se debe hoy y cuando vence, con la columna `restante` (lo que de verdad se puede canjear).
  const vivas = filas.filter((f) => f.cat === 'guardado' && f.vigente);
  const enDias = (d: string) => Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${hoy}T12:00:00Z`)) / 86_400_000);
  const semanas = Array.from({ length: 8 }, (_, i) => ({ desde: sumarDias(hoy, 7 * i), hasta: sumarDias(hoy, 7 * i + 6), total: 0,
    por_origen: Object.fromEntries(origenes.map((o) => [o.clave, 0])) as Record<string, number> }));
  let despues = 0, por30 = 0;
  for (const f of vivas) {
    const k = Math.floor(enDias(f.dia_vence) / 7);
    if (k < 8) { semanas[Math.max(0, k)].total += f.importe; semanas[Math.max(0, k)].por_origen[f.origen] += f.importe; } else despues += f.importe;
    if (enDias(f.dia_vence) <= 30) por30 += f.importe;
  }
  const guardadoVivo = cuadreTotal.guardado_vivo;
  const porLiberar = vivas.filter((f) => f.por_liberar).reduce((s, f) => s + f.importe, 0);

  const cerradoAhora = cohorteCerrada(filas, tienda, ini, fin);
  const cerradoAntes = cohorteCerrada(filas, tienda, antes.ini, antes.fin);
  const proximoCierre = filas.filter((f) => MOVIMIENTOS.has(f.cat) && f.vigente).map((f) => f.dia_vence).sort()[0] ?? null;
  const inicioPrograma = filas.filter((f) => f.cat === 'emision' && f.dia).map((f) => f.dia).sort()[0] ?? null;

  const costoActual = sumaFlujo(flujo, sinCupon).canjeado, costoAntes = sumaFlujo(flujoAntes, sinCupon).canjeado;
  const dias_ = new Map(tardanza.results.map((f) => [f.dias, f]));
  const histograma = HISTOGRAMA.map(([clave, nombre, min, max]) => {
    let n = 0, importe = 0;
    for (const [d, f] of dias_) if (d >= min && d <= max) { n += f.n; importe += f.importe; }
    return { clave, nombre, n, importe };
  });
  const usos = [...dias_].sort((a, b) => a[0] - b[0]);
  const totalUsos = usos.reduce((s, [, f]) => s + f.n, 0);
  let acumulado = 0, mediana: number | null = null;
  for (const [d, f] of usos) { acumulado += f.n; if (mediana === null && acumulado * 2 >= totalUsos) mediana = d; }

  const RESULTADOS: [string, string][] = [['completo', 'Regresó completo'], ['parcial', 'Regresó en parte, el resto venció'],
    ['vencido', 'Venció sin usarse'], ['vivo', 'Sigue vivo'], ['cuenta', 'Pasó a una cuenta de socio'], ['retirado', 'Retirado por cancelación o devolución']];
  const nVales = resultados.results.reduce((s, f) => s + f.n, 0);

  return json({
    desde, hasta, dia_desde: ini, dia_hasta: fin, dias, hoy, generado: ahoraIso, tienda,
    tienda_nombre: tienda ? TIENDAS[tienda as keyof typeof TIENDAS].nombre : '',
    inicio_programa: inicioPrograma, proximo_cierre: proximoCierre,
    origenes: origenes.map(({ clave, nombre, libro }) => ({ clave, nombre, libro })),
    cuadre,
    tickets: { en_tickets: tickets?.en_tickets ?? 0, socio: tickets?.socio ?? 0, vale: tickets?.vale ?? 0,
      diferencia: (tickets?.en_tickets ?? 0) - (tickets?.socio ?? 0) - (tickets?.vale ?? 0) },
    por_origen: tablaOrigen,
    periodo: {
      emitidos: total.emitido + total.traspaso, emitidos_antes: totalAntes.emitido + totalAntes.traspaso,
      canjeados: total.canjeado, canjeados_antes: totalAntes.canjeado,
      vencidos: total.vencido, vencidos_antes: totalAntes.vencido, retirados: total.retirado,
      por_origen: porOrigenPeriodo,
      ventas_netas: actual.ventas_netas, ventas_netas_antes: previo.ventas_netas,
      costo: costoActual, costo_antes: costoAntes,
      tasa: cerradoAhora, tasa_antes: cerradoAntes,
    },
    saldo: { vivo: guardadoVivo, disponible: guardadoVivo - porLiberar, por_liberar: porLiberar,
      calculado: cuadreTotal.vivo, vivo_inicio: vivoAlCierre(filas, sumarDias(ini, -1)), por_vencer_30: por30 },
    grano, serie,
    vencimientos: { semanas, despues },
    vales: { emitidos: nVales, importe: resultados.results.reduce((s, f) => s + f.importe, 0),
      resultados: RESULTADOS.map(([clave, nombre]) => {
        const f = resultados.results.find((x) => x.resultado === clave);
        return { clave, nombre, n: f?.n ?? 0, importe: f?.importe ?? 0, canjeado: f?.canjeado ?? 0 };
      }),
      dias: { histograma, usos: totalUsos, mediana } },
    efecto: { con: actual.con, sin: actual.sin, tickets: actual.tickets, tickets_antes: previo.con.tickets, tickets_total_antes: previo.tickets },
    saldos: saldos.results.map((f) => ({ socio: f.numero, saldo: f.saldo, disponible: f.disponible, por_liberar: f.por_liberar,
      vence_primero: f.vence_primero, ultima_compra: f.ultima_compra })),
  });
}
