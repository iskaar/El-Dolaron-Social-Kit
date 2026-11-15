// Vista «Clientes» de /reportes (Issue #802): del JSON de /api/reportes/clientes al HTML y las graficas.
// Funciones puras (sin DOM): las usa el servidor (src/reportes-clientes.ts, `armarClientes`) y la pagina, y se prueban en
// src/reportes-clientes.test.ts. Dinero en centavos enteros; los dias son dias de la tienda (UTC-6).
// «Socio» es una fila de `clientes`; las cuentas del equipo (registrado_por = 'retos') no son clientes y no cuentan como socios.
import { escapar, pesos, pesosEje, sumarDias, diaCorto, tabla, columnas, lineaSerie, leyendaSeries } from './graficas.js';
import { cubetas as listaCubetas, cambioKpi, vsCorto, cortadaPorElPeriodo, diasEntre, etiquetaCubeta, tituloCubeta, unidadGrano } from './reportes-resumen.js';

const num = (n) => Number(n).toLocaleString('es-MX');
const un = (v) => v.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (parte, todo) => (todo > 0 ? (parte * 100) / todo : null);
const pct1 = (v) => (v == null ? '—' : `${un(v)} %`);
const cuenta = (n, uno, varios) => `${num(n)} ${n === 1 ? uno : varios}`;
const entre = (dia, desde, hasta) => dia >= desde && dia <= hasta;
/** Dias que pasan de `a` a `b` (b despues de a). */
const dias = (a, b) => diasEntre(a, b) - 1;
export const mediana = (xs) => {
  if (xs.length === 0) return null;
  const o = [...xs].sort((a, b) => a - b), m = o.length >> 1;
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
};

/* ---------- constantes de lo que se mide ---------- */

/** Una tasa que descansa en menos socios (o recompras) que esto se marca «muestra chica». */
export const MUESTRA_MIN = 20;
/** Ventanas de recompra: de la primera compra a N dias despues. */
export const VENTANAS_RECOMPRA = [14, 30];
/** Compras por socio: 1, 2, 3 y 4 o mas dias de compra. */
export const MAX_COMPRAS = 4;
/** Recencia: dias desde la ultima compra (limite superior inclusivo; el ultimo tramo es «o mas»). */
export const TRAMOS_RECENCIA = [[7, '0–7 días'], [14, '8–14 días'], [30, '15–30 días'], [Infinity, '31 días o más']];
export const TOP = 15;
export const CANALES_ALTA = [['tienda', 'En la tienda', 'var(--serie-1)'], ['portal', 'Por el portal', 'var(--serie-2)'], ['otro', 'Otro', 'var(--tinta-2)']];

/* ---------- el servidor: de las filas de D1 a la respuesta ---------- */

/**
 * Arma la respuesta de /api/reportes/clientes. Entradas (todas de D1, ver src/reportes-clientes.ts):
 *  - `filasTickets`: { dia, grupo (0 sin socio, 1 socio, 2 cuenta del equipo), tickets, ventas } del periodo y la comparacion;
 *  - `filasHistoria`: { socio, dia, tienda, tickets } un renglon por socio, dia y tienda de compra, de siempre hasta `hasta`;
 *  - `filasAltas`: { socio, dia, canal } altas del periodo y la comparacion;  `programa`: { primero, antes, equipo, pendientes, liberados, ... };
 *  - `filasTop`: { socio, tickets, ventas }.
 * Las compras de un socio son sus DIAS de compra (dos tickets el mismo dia son una compra). Todo lo de recompra se mide a la fecha
 * final del periodo: una compra posterior no se conoce. Con `tienda`, las compras son solo las de esa tienda; las altas no tienen tienda.
 * ponytail: se recorren las listas completas por cada cubeta (socios x dias de compra); con decenas de miles de compras conviene indexar por dia.
 */
export function armarClientes({ desde, hasta, grano, ventana, tienda, filasTickets, filasHistoria, filasAltas, programa, filasTop }) {
  // Los dias de compra de cada socio, de la tienda elegida o de todas.
  const diasDe = (filtrar) => {
    const por = new Map();
    for (const f of filasHistoria) if (filtrar(f)) (por.get(f.socio) ?? por.set(f.socio, new Set()).get(f.socio)).add(f.dia);
    return new Map([...por].map(([socio, s]) => [socio, [...s].sort()]));
  };
  const compras = diasDe((f) => !tienda || f.tienda === tienda);
  const todas = tienda ? diasDe(() => true) : compras;
  // Un evento por dia de compra: si fue la primera y que dia fue la anterior.
  const eventos = [];
  for (const [socio, ds] of compras) ds.forEach((dia, i) => eventos.push({ socio, dia, primera: i === 0, previa: i ? ds[i - 1] : null }));

  const medidas = (a, b) => {
    const t = { 0: { tickets: 0, ventas: 0 }, 1: { tickets: 0, ventas: 0 }, 2: { tickets: 0, ventas: 0 } };
    for (const f of filasTickets) if (entre(f.dia, a, b)) { t[f.grupo].tickets += f.tickets; t[f.grupo].ventas += f.ventas; }
    const nuevos = { tienda: 0, portal: 0, otro: 0 };
    let altasHasta = 0;
    for (const f of filasAltas) {
      if (entre(f.dia, a, b)) nuevos[f.canal in nuevos ? f.canal : 'otro'] += 1;
      if (f.dia <= b) altasHasta += 1;
    }
    const delPeriodo = eventos.filter((e) => entre(e.dia, a, b));
    const repeticiones = delPeriodo.filter((e) => !e.primera);
    const brechas = repeticiones.map((e) => dias(e.previa, e.dia));
    return {
      nuevos: nuevos.tienda + nuevos.portal + nuevos.otro, nuevos_canal: nuevos,
      socios: programa.antes + altasHasta,
      tickets_socio: t[1].tickets, ventas_socio: t[1].ventas,
      tickets_sin: t[0].tickets + t[2].tickets, ventas_sin: t[0].ventas + t[2].ventas, tickets_equipo: t[2].tickets,
      compraron: new Set(delPeriodo.map((e) => e.socio)).size,
      regresaron: new Set(repeticiones.map((e) => e.socio)).size,
      brechas: { n: brechas.length, mediana: mediana(brechas) },
    };
  };

  const lista = listaCubetas(desde, hasta, grano).map((c) => ({ ...c, ...medidas(c.desde, c.hasta) }));
  const totales = medidas(desde, hasta);
  const anterior = ventana ? medidas(ventana.desde, ventana.hasta) : null;

  // Recompra: de los socios cuya primera compra ya tiene N dias completos a la fecha final, cuantos volvieron dentro de esos N dias.
  const socios = [...compras].map(([socio, ds]) => ({ socio, ds }));
  const recompra = VENTANAS_RECOMPRA.map((n) => {
    const elegibles = socios.filter((s) => sumarDias(s.ds[0], n) <= hasta);
    const volvieron = elegibles.filter((s) => s.ds.some((d) => d > s.ds[0] && d <= sumarDias(s.ds[0], n))).length;
    return { dias: n, socios: elegibles.length, volvieron, tasa: pct(volvieron, elegibles.length), muestra_chica: elegibles.length < MUESTRA_MIN };
  });
  const porSocio = Array.from({ length: MAX_COMPRAS }, (_, i) => ({ compras: i + 1, socios: socios.filter((s) => Math.min(s.ds.length, MAX_COMPRAS) === i + 1).length }));
  const recencia = TRAMOS_RECENCIA.map(([tope], i) => ({
    socios: socios.filter((s) => { const d = dias(s.ds.at(-1), hasta); return d <= tope && d > (i ? TRAMOS_RECENCIA[i - 1][0] : -1); }).length,
  }));

  // Alta -> primera compra, de los socios que se registraron en el periodo (con las compras de cualquier tienda).
  const nuevosDelPeriodo = filasAltas.filter((f) => entre(f.dia, desde, hasta));
  const primera = nuevosDelPeriodo.map((f) => ({ alta: f.dia, compra: todas.get(f.socio)?.[0] ?? null }));
  const esperas = primera.filter((p) => p.compra).map((p) => dias(p.alta, p.compra));
  const altaCompra = {
    socios: primera.length,
    mismo_dia: primera.filter((p) => p.compra && p.compra <= p.alta).length,
    despues: primera.filter((p) => p.compra && p.compra > p.alta).length,
    sin_compra: primera.filter((p) => !p.compra).length,
    mediana_dias: mediana(esperas.map((d) => Math.max(0, d))),
    muestra_chica: primera.length < MUESTRA_MIN,
  };

  const top = filasTop.map((f) => {
    const ds = compras.get(f.socio) ?? [];
    return { socio: f.socio, tickets: f.tickets, ventas: f.ventas, compras: ds.filter((d) => entre(d, desde, hasta)).length, ultima: ds.at(-1) ?? null };
  });

  return {
    programa: { primero: programa.primero ?? null, socios: totales.socios, equipo: programa.equipo },
    cubetas: lista, totales, anterior,
    recompra, compras_por_socio: porSocio,
    recencia: recencia.map((r, i) => ({ ...r, tramo: TRAMOS_RECENCIA[i][1] })),
    con_historia: socios.length,
    alta_compra: altaCompra,
    top,
    referidos: { pendientes: programa.pendientes, liberados: programa.liberados, nuevos_periodo: programa.nuevos_periodo, liberados_periodo: programa.liberados_periodo },
  };
}

/* ---------- las tarjetas ---------- */

const ticketMedio = (ventas, tickets) => (tickets > 0 ? Math.round(ventas / tickets) : null);
const part = (x) => pct(x.tickets_socio, x.tickets_socio + x.tickets_sin);
const ventasPct = (x) => pct(x.ventas_socio, x.ventas_socio + x.ventas_sin);
const chica = (n) => (n < MUESTRA_MIN ? ` · muestra chica (${num(n)})` : '');

/** Las 8 tarjetas, con el mismo marcado que las de Resumen (tarjetasHtml). `d` es /api/reportes/clientes. */
export function tarjetasClientes(d) {
  const t = d.totales, a = d.anterior, sc = d.cubetas;
  const comparando = !!d.comparacion;
  const vs = vsCorto(d);
  const hayComp = !!a && (a.tickets_socio + a.tickets_sin > 0 || a.socios > 0 || a.nuevos > 0);   // el periodo comparado tuvo algo
  const k = (clave, etiqueta, valor, cambio, serie, pie) => ({ clave, etiqueta, valor, cambio: comparando ? cambio : null, serie, clase: 's1', pie, vs, hayComp, comparando });
  const nuevosCanal = CANALES_ALTA.map(([c, nombre]) => [nombre, t.nuevos_canal[c]]).filter(([, n]) => n > 0).map(([nombre, n]) => `${nombre.toLowerCase()} ${num(n)}`).join(' · ');
  const totalTickets = t.tickets_socio + t.tickets_sin, totalVentas = t.ventas_socio + t.ventas_sin;
  const ticketCon = ticketMedio(t.ventas_socio, t.tickets_socio), ticketSin = ticketMedio(t.ventas_sin, t.tickets_sin);
  const pCon = part(t), pAnt = a ? part(a) : null;
  const porMedio = (x) => ticketMedio(x.ventas_socio, x.tickets_socio);
  return [
    k('nuevos', 'Socios nuevos', num(t.nuevos), a ? cambioKpi(t.nuevos, a.nuevos) : null, sc.map((c) => c.nuevos),
      t.nuevos ? nuevosCanal : 'Sin altas en el periodo'),
    k('socios', 'Socios', num(t.socios), a ? cambioKpi(t.socios, a.socios) : null, sc.map((c) => c.socios),
      `Al cierre del periodo${d.programa.equipo ? `, sin ${cuenta(d.programa.equipo, 'cuenta', 'cuentas')} del equipo` : ''}`),
    k('con_socio', 'Tickets con socio', pct1(pCon), a ? cambioKpi(pCon, pAnt, { tipo: 'pp' }) : null, sc.map(part),
      totalTickets ? `${num(t.tickets_socio)} de ${cuenta(totalTickets, 'ticket', 'tickets')}` : 'Sin tickets en el periodo'),
    k('ventas_socio', 'Ventas de socios', pesos(t.ventas_socio), a ? cambioKpi(t.ventas_socio, a.ventas_socio) : null, sc.map((c) => c.ventas_socio),
      totalVentas > 0 ? `${pct1(ventasPct(t))} de las ventas netas` : 'Sin ventas en el periodo'),
    k('ticket_socio', 'Ticket con socio', ticketCon == null ? '—' : pesos(ticketCon), a ? cambioKpi(ticketCon, porMedio(a)) : null, sc.map(porMedio),
      `Sin socio: ${ticketSin == null ? '—' : pesos(ticketSin)}${ticketCon == null ? '' : chica(t.tickets_socio)}`),
    k('compraron', 'Socios que compraron', num(t.compraron), a ? cambioKpi(t.compraron, a.compraron) : null, sc.map((c) => c.compraron),
      t.socios > 0 ? `${pct1(pct(t.compraron, t.socios))} de los socios` : null),
    k('regresaron', 'Socios que regresaron', num(t.regresaron), a ? cambioKpi(t.regresaron, a.regresaron) : null, sc.map((c) => c.regresaron),
      t.compraron > 0 ? `${num(t.regresaron)} de ${num(t.compraron)} que compraron: compraron otro día antes` : 'Compraron al menos dos días distintos'),
    k('brecha', 'Días entre compras', t.brechas.mediana == null ? '—' : `${num(t.brechas.mediana)} ${t.brechas.mediana === 1 ? 'día' : 'días'}`,
      a && a.brechas.mediana != null && t.brechas.mediana != null ? cambioKpi(t.brechas.mediana, a.brechas.mediana, { bueno: 'neutro' }) : null,
      sc.map((c) => c.brechas.mediana),
      t.brechas.n ? `Mediana de ${cuenta(t.brechas.n, 'regreso', 'regresos')}${chica(t.brechas.n)}` : 'Aún nadie vuelve a comprar en el periodo'),
  ];
}

/* ---------- series: datos de las graficas y sus tablas ---------- */

const ejes = (d) => d.cubetas.map((c) => ({ etiqueta: etiquetaCubeta(c, d.grano, d.cubetas.length), titulo: tituloCubeta(c, d.grano) }));

export function datosAltas(d) {
  return CANALES_ALTA.map(([clave, nombre, color]) => ({ clave, nombre, color, valores: d.cubetas.map((c) => c.nuevos_canal[clave]) }))
    .filter((s) => s.valores.some((v) => v > 0));
}
/** % de tickets con socio por cubeta; null donde no hay tickets o el programa aun no existia (no es un 0 %). */
export function datosParticipacion(d) {
  const inicio = d.programa.primero;
  return d.cubetas.map((c) => (inicio && c.hasta >= inicio ? part(c) : null));
}
export const datosVentas = (d) => [
  { nombre: 'Socios', color: 'var(--serie-1)', valores: d.cubetas.map((c) => c.ventas_socio) },
  { nombre: 'Sin socio', color: 'var(--serie-2)', valores: d.cubetas.map((c) => c.ventas_sin) },
];

export function tablaAltas(d) {
  const series = datosAltas(d), e = ejes(d);
  return tabla(['Periodo', ...series.map((s) => s.nombre), 'Total', 'Socios al cierre'],
    d.cubetas.map((c, i) => [e[i].titulo, ...series.map((s) => num(s.valores[i])), num(c.nuevos), num(c.socios)]), series.map((_, i) => i + 1).concat([series.length + 1, series.length + 2]));
}
export function tablaParticipacion(d) {
  const p = datosParticipacion(d), e = ejes(d);
  return tabla(['Periodo', 'Tickets con socio', 'Tickets sin socio', '% con socio'],
    d.cubetas.map((c, i) => [e[i].titulo, num(c.tickets_socio), num(c.tickets_sin), p[i] == null ? '—' : pct1(p[i])]), [1, 2, 3]);
}
export function tablaVentas(d) {
  const e = ejes(d);
  return tabla(['Periodo', 'Ventas de socios', 'Ventas sin socio', '% de socios'],
    d.cubetas.map((c, i) => [e[i].titulo, pesos(c.ventas_socio), pesos(c.ventas_sin), c.ventas_socio + c.ventas_sin ? pct1(ventasPct(c)) : '—']), [1, 2, 3]);
}

/* ---------- tablas y textos de lo demas ---------- */

const barra = (nombre, valor, texto, tip, sub = '') => `<div class="hbarra" data-tip="${escapar(tip)}" tabindex="0">
  <span class="hn">${escapar(nombre)}</span><span class="hpista"><i style="width:${Math.min(100, Math.max(valor > 0 ? 0.5 : 0, valor ?? 0))}%"></i></span><span class="hv">${escapar(texto)}${sub ? `<small class="hs">${escapar(sub)}</small>` : ''}</span></div>`;
const etiquetaChica = (chica) => (chica ? ' · muestra chica' : '');

export function recompraHtml(d) {
  if (d.con_historia === 0) return '<div class="vacio">Ningún socio ha comprado todavía: no hay recompra que medir.</div>';
  return `<div class="hbarras">${d.recompra.map((r) => r.socios === 0
    ? barra(`En ${r.dias} días`, 0, 'Sin socios con tiempo', `Ningún socio tiene ya ${r.dias} días desde su primera compra`)
    : barra(`En ${r.dias} días`, r.tasa, pct1(r.tasa), `Recompra a ${r.dias} días\n${pct1(r.tasa)}\n${num(r.volvieron)} de ${cuenta(r.socios, 'socio', 'socios')}`,
      `${num(r.volvieron)} de ${num(r.socios)}${etiquetaChica(r.muestra_chica)}`)).join('')}</div>`;
}
export function tablaRecompra(d) {
  return tabla(['Ventana', 'Socios con tiempo', 'Volvieron a comprar', 'Tasa', 'Muestra'],
    d.recompra.map((r) => [`${r.dias} días`, num(r.socios), num(r.volvieron), r.tasa == null ? '—' : pct1(r.tasa), r.muestra_chica ? 'Chica (menos de 20 socios)' : 'Suficiente']), [1, 2, 3]);
}
export const notaRecompra = (d) => `Entre los socios cuya primera compra ya tiene 14 o 30 días completos al ${diaCorto(d.periodo.hasta)}, los que volvieron a comprar otro día dentro de ese plazo. `
  + 'Cuenta todos los socios, no solo los del periodo: depende de la fecha final, no del largo.';

export const nombresCompras = () => Array.from({ length: MAX_COMPRAS }, (_, i) => (i + 1 === MAX_COMPRAS ? `${MAX_COMPRAS} o más` : i === 0 ? '1 día' : `${i + 1} días`));
export function tablaCompras(d) {
  const total = d.compras_por_socio.reduce((s, x) => s + x.socios, 0);
  return tabla(['Días de compra', 'Socios', '% de los que compraron'], d.compras_por_socio.map((x, i) => [nombresCompras()[i], num(x.socios), total ? pct1(pct(x.socios, total)) : '—']), [1, 2]);
}
export function tablaRecencia(d) {
  const total = d.recencia.reduce((s, x) => s + x.socios, 0);
  return tabla(['Desde su última compra', 'Socios', '% de los que compraron'], d.recencia.map((x) => [x.tramo, num(x.socios), total ? pct1(pct(x.socios, total)) : '—']), [1, 2]);
}
export const notaMuestra = (d) => (d.con_historia > 0 && d.con_historia < MUESTRA_MIN
  ? `Muestra chica: solo ${cuenta(d.con_historia, 'socio ha comprado', 'socios han comprado')}; los porcentajes cambian mucho con una persona más.` : '');

export function altaCompraHtml(d) {
  const a = d.alta_compra;
  if (a.socios === 0) return '<div class="vacio">Nadie se registró en este periodo.</div>';
  const fila = (nombre, n) => barra(nombre, pct(n, a.socios), `${pct1(pct(n, a.socios))} · ${num(n)}`, `${nombre}\n${num(n)} de ${cuenta(a.socios, 'socio', 'socios')}`);
  const m = a.mediana_dias;
  return `<div class="hbarras">${fila('Compró el día de su alta', a.mismo_dia)}${fila('Compró después', a.despues)}${fila('Aún sin compra', a.sin_compra)}</div>
    <p class="nota">${a.muestra_chica ? `Muestra chica: ${cuenta(a.socios, 'socio', 'socios')} se registró en el periodo. ` : `${cuenta(a.socios, 'socio', 'socios')} se registró en el periodo. `}${
      m == null ? 'Ninguno ha comprado todavía.' : `La mitad de los que compraron lo hizo ${m === 0 ? 'el mismo día de su alta' : `a los ${num(m)} ${m === 1 ? 'día' : 'días'} de su alta o antes`} (mediana).`
    } «Aún sin compra» es a la fecha final: quien se registró esos días puede comprar después. No se filtra por tienda: las altas no tienen tienda.</p>`;
}

export function tablaTop(d) {
  if (d.top.length === 0) return '<div class="vacio">Ningún socio compró en este periodo.</div>';
  return tabla(['Socio', 'Compras netas', 'Tickets', 'Días de compra', 'Última compra'],
    d.top.map((s) => [`Socio #${s.socio}`, pesos(s.ventas), num(s.tickets), num(s.compras), s.ultima ? diaCorto(s.ultima) : '—']), [1, 2, 3]);
}

export function referidosHtml(d) {
  const r = d.referidos;
  if (r.pendientes + r.liberados === 0) {
    return '<div class="vacio">Todavía no hay referidos. Cada socio tiene su código; cuando un amigo se registra con él aparece aquí como pendiente, y pasa a liberado cuando hace su primera compra válida.</div>';
  }
  const par = (a, b) => `<dt>${escapar(a)}</dt><dd class="num">${escapar(b)}</dd>`;
  return `<dl class="pares">${par('Pendientes (aún sin su compra)', num(r.pendientes))}${par('Liberados (ya compraron)', num(r.liberados))}
    ${par('Nuevos en el periodo', num(r.nuevos_periodo))}${par('Liberados en el periodo', num(r.liberados_periodo))}</dl>`;
}

/* ---------- la vista completa ---------- */

const panel = (id, titulo, sub, graficaId, tablaHtml, nota = '', leyenda = '') => `<article class="panel" id="${id}">
  <header><h4>${escapar(titulo)} <span class="subtitulo">${escapar(sub)}</span></h4><button type="button" class="alterna">Ver tabla</button></header>
  <div class="vista-grafica">${leyenda}<div class="graf-c" data-grafica="${graficaId}"></div>${nota ? `<p class="nota">${escapar(nota)}</p>` : ''}</div>
  <div class="vista-tabla">${tablaHtml}</div></article>`;
const panelHtml = (id, titulo, sub, cuerpo, tablaHtml, nota = '') => `<article class="panel" id="${id}">
  <header><h4>${escapar(titulo)} <span class="subtitulo">${escapar(sub)}</span></h4><button type="button" class="alterna">Ver tabla</button></header>
  <div class="vista-grafica">${cuerpo}${nota ? `<p class="nota">${escapar(nota)}</p>` : ''}</div>
  <div class="vista-tabla">${tablaHtml}</div></article>`;

export const GRANO_TEXTO = { dia: 'por día', semana: 'por semana (lunes a domingo)', mes: 'por mes' };

/** Lo que dice la pantalla sobre lo que NO se puede ver: antes de que existiera el programa, el equipo y la tienda. */
export function avisosClientes(d) {
  const lineas = [];
  const inicio = d.programa.primero;
  if (!inicio) lineas.push('Todavía no se ha registrado ningún socio: no hay nada que medir.');
  else if (inicio > d.periodo.desde) lineas.push(`Los socios empezaron a registrarse el ${diaCorto(inicio)}: antes de esa fecha no había programa, y los tickets de esos días son «sin socio» por eso.`);
  const eq = d.totales.tickets_equipo;
  lineas.push(`Las cuentas que se crean para el equipo (retos) no son clientes: no cuentan como socios${eq ? `, y ${cuenta(eq, 'ticket', 'tickets')} del periodo con una de ellas ${eq === 1 ? 'cuenta' : 'cuentan'} como «sin socio»` : ''}.`);
  if (d.tienda) {
    lineas.push('Con una tienda elegida, los tickets, las ventas y las compras (recompra, recencia, socios que compraron) son solo de esa tienda; los socios nuevos, el total de socios, las altas y los referidos son de todo el negocio, porque un alta no tiene tienda.');
  }
  return lineas;
}

export function vistaClientes(d) {
  const grano = GRANO_TEXTO[d.grano];
  const n = d.cubetas.length;
  const parciales = d.cubetas.some((c) => c.parcial);
  const aviso = avisosClientes(d);
  const subGrano = `${grano} · ${num(n)} ${unidadGrano(d.grano, n)}`;
  const notaParcial = parciales ? `${cortadaPorElPeriodo(d.grano)}: tiene menos días.` : '';
  const sinNada = d.totales.tickets_socio + d.totales.tickets_sin === 0 && d.totales.nuevos === 0 && d.con_historia === 0;
  return `${aviso.map((t) => `<p class="nota aviso-tienda">${escapar(t)}</p>`).join('')}
    ${sinNada ? '<p class="vacio">Sin socios ni ventas en este periodo.</p>' : ''}
    <div class="tarjetas" id="c-kpis"></div>
    <div class="malla iguales">
      ${panel('c-altas', 'Altas en el tiempo', subGrano, 'altas', tablaAltas(d),
        'Cuántos socios se registran. «En la tienda» son los que da de alta la caja; «Por el portal» los que se registran solos desde su celular.', leyendaSeries(datosAltas(d)))}
      ${panel('c-part', 'Tickets con socio', `${subGrano} · % de los tickets`, 'participacion', tablaParticipacion(d),
        `${notaParcial} Antes de que empezara el programa no hay línea: no es un 0 %.`.trim())}
    </div>
    ${panel('c-ventas', 'Ventas de socios y sin socio', subGrano, 'ventas', tablaVentas(d), 'Ventas netas (con descuentos y devoluciones), la misma definición de Ventas y Resumen.', leyendaSeries(datosVentas(d)))}
    <section aria-labelledby="t-recompra">
      <h3 class="titulo-bloque" id="t-recompra">Recompra</h3>
      <div class="malla iguales">
        ${panelHtml('c-recompra', 'Volvieron a comprar', `al ${diaCorto(d.periodo.hasta)}`, recompraHtml(d), tablaRecompra(d), notaRecompra(d))}
        ${panelHtml('c-alta-compra', 'Del alta a la primera compra', 'socios registrados en el periodo', altaCompraHtml(d), tabla(['Grupo', 'Socios'], [
          ['Compró el día de su alta', num(d.alta_compra.mismo_dia)], ['Compró después', num(d.alta_compra.despues)], ['Aún sin compra', num(d.alta_compra.sin_compra)],
        ], [1]))}
      </div>
      <div class="malla iguales" style="margin-top:16px">
        ${panel('c-compras', 'Compras por socio', 'días distintos de compra, de siempre', 'compras', tablaCompras(d), notaMuestra(d))}
        ${panel('c-recencia', 'Desde su última compra', `a la fecha final, ${diaCorto(d.periodo.hasta)}`, 'recencia', tablaRecencia(d), notaMuestra(d))}
      </div>
    </section>
    <article class="panel" id="c-top"><header><h4>Socios más activos <span class="subtitulo">por compras netas del periodo</span></h4></header>
      ${tablaTop(d)}<p class="nota">Solo el número de socio; el nombre y el teléfono no salen en los reportes. Los ${TOP} que más compraron: no es una muestra, es la lista completa de ese tope.</p></article>
    <article class="panel" id="c-referidos"><header><h4>Referidos <span class="subtitulo">todo el programa</span></h4></header>
      ${referidosHtml(d)}<p class="nota">Los socios que invitan a un amigo con su código. El saldo, la emisión y el canje de Dolarones están en <a class="enlace" href="#dolarones">Ver Dolarones</a>.</p></article>`;
}

/** Las graficas de cada hueco `.graf-c`, para el ancho que tenga: { grafica: html }. */
export function graficas(d, anchoDe) {
  const ancho = (id) => Math.max(220, Math.floor(anchoDe(id)));
  const e = ejes(d);
  const vacio = (texto) => `<div class="vacio">${escapar(texto)}</div>`;
  const altas = datosAltas(d), ventas = datosVentas(d), p = datosParticipacion(d);
  const compras = d.compras_por_socio, recencia = d.recencia;
  const histograma = (id, nombres, valores, texto) => (valores.every((v) => v === 0) ? vacio(texto)
    : columnas({ categorias: nombres.map((x) => ({ etiqueta: x, titulo: x })), series: [{ nombre: 'Socios', color: 'var(--serie-1)', valores }], ancho: ancho(id), alto: 210, entero: true, fmtValor: num }));
  return {
    altas: altas.length === 0 ? vacio('Sin altas en este periodo.') : columnas({ categorias: e, series: altas, ancho: ancho('altas'), modo: 'apiladas', entero: true, fmtValor: num }),
    participacion: p.every((v) => v == null) ? vacio('Sin tickets desde que empezó el programa en este periodo.')
      : lineaSerie({ categorias: d.cubetas.map((c, i) => ({ etiqueta: e[i].etiqueta, titulo: e[i].titulo, detalle: [`${num(c.tickets_socio)} de ${cuenta(c.tickets_socio + c.tickets_sin, 'ticket', 'tickets')}`] })),
        valores: p.map((v) => (v == null ? null : Math.round(v * 10) / 10)), nombre: 'Tickets con socio', ancho: ancho('participacion'), area: false, entero: true,
        fmtEje: (v) => `${un(v)} %`, fmtValor: (v) => `${un(v)} %`, descripcion: 'Porcentaje de tickets con socio' }),
    ventas: ventas.every((s) => s.valores.every((v) => v === 0)) ? vacio('Sin ventas en este periodo.')
      : columnas({ categorias: e, series: ventas, ancho: ancho('ventas'), modo: 'apiladas', fmtEje: pesosEje, fmtValor: pesos }),
    compras: histograma('compras', nombresCompras(), compras.map((x) => x.socios), 'Ningún socio ha comprado todavía.'),
    recencia: histograma('recencia', recencia.map((x) => x.tramo.replace(' días', '').replace(' o más', '+')), recencia.map((x) => x.socios), 'Ningún socio ha comprado todavía.'),
  };
}
