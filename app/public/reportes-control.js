// Vista «Control» de /reportes (Issue #802): de /api/reportes/control al HTML y las graficas.
// Funciones puras (sin DOM): las usa el servidor (src/reportes-control.ts, `armarControl`) y la pagina, y se prueban en
// src/reportes-control.test.ts; solo `montarControl` toca document. Todo el dinero va en centavos enteros; los dias son
// dias de la tienda (UTC-6).
//
// A QUE PERIODO PERTENECE UNA CANCELACION. Al de la VENTA (`ventas.creado_en`), igual que el bloque `cancelaciones` de
// /api/reportes y el cuadre («bruto - devoluciones - cancelados = vendido»): un ticket del lunes cancelado el martes cuenta
// el lunes. Asi el porcentaje sobre ventas brutas tiene numerador y denominador del mismo conjunto de tickets, y un ticket
// cancelado esta en el bruto pero no en el neto. Los patrones de hora (`por_hora`) usan en cambio la hora de la ACCION
// (cuando se cancelo o devolvio), de los movimientos de ese conjunto. Una venta de antes cancelada despues del periodo
// aparece en el periodo de su venta, no en el de su cancelacion.
import {
  escapar, pesos, pesosEje, pesosConSigno, tabla, columnas, leyendaSeries, barrasHorizontales, mapaCalor, mapaCalorHtml, tablaCalor,
  FORMATO_CALOR_DINERO,
} from './graficas.js';
import { armarCubetas, cambioKpi, tarjetasHtml, etiquetaCubeta, tituloCubeta } from './reportes-resumen.js';
import { MAX_COLUMNAS } from './reportes-ventas.js';

const n0 = (n) => Number(n ?? 0).toLocaleString('es-MX');
const n1 = (n) => Number(n).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const cuenta = (n, uno, varios) => `${n0(n)} ${n === 1 ? uno : varios}`;
const pct = (parte, todo) => (todo > 0 ? `${n1((parte * 100) / todo)} %` : '—');

/* ---------- tiempo de la tienda ---------- */

/** El dia, la hora y el dia de la semana (0 = domingo) de la tienda (UTC-6 fijo) de un instante ISO; null si no es una fecha. */
export function momentoTienda(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms - 6 * 3_600_000);
  return { dia: d.toISOString().slice(0, 10), hora: d.getUTCHours(), dia_semana: d.getUTCDay() };
}

/* ---------- motivos: texto libre, agrupado por el texto normalizado ---------- */

/**
 * La llave con la que se agrupan dos motivos: sin mayusculas, sin acentos, con un solo espacio entre palabras y sin espacios ni
 * signos de puntuacion al principio o al final. «No encendió. » y «no encendio» son el mismo motivo. Nada mas se une: no hay categorias.
 */
export const claveMotivo = (texto) => String(texto ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/\s+/g, ' ').trim().replace(/^[\s.,;:!¡?¿-]+|[\s.,;:!¡?¿-]+$/g, '');

export const MAX_MOTIVOS = 8;

/**
 * Los motivos de `eventos` ({ motivo, tipo, dinero, dolarones }) agrupados: los `max` mas usados y «otros». El texto que se muestra es
 * la escritura mas frecuente del grupo (a igualdad, la primera por orden alfabetico). Sin motivo va en su propio grupo.
 * Devuelve { lista: [{ clave, texto, n, valor, tickets, piezas }], otros: { distintos, n, valor, tickets, piezas } | null, distintos }.
 */
export function agruparMotivos(eventos, max = MAX_MOTIVOS) {
  const grupos = new Map();
  for (const e of eventos) {
    const clave = claveMotivo(e.motivo);
    const g = grupos.get(clave) ?? { clave, n: 0, valor: 0, tickets: 0, piezas: 0, escrituras: new Map() };
    g.n += 1; g.valor += e.dinero + e.dolarones;
    if (e.tipo === 'ticket') g.tickets += 1; else g.piezas += 1;
    const escrito = String(e.motivo ?? '').replace(/\s+/g, ' ').trim();
    g.escrituras.set(escrito, (g.escrituras.get(escrito) ?? 0) + 1);
    grupos.set(clave, g);
  }
  const todos = [...grupos.values()].map(({ escrituras, ...g }) => ({
    ...g,
    texto: g.clave === '' ? 'Sin motivo' : [...escrituras].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
  })).sort((a, b) => b.n - a.n || b.valor - a.valor || a.clave.localeCompare(b.clave));
  const lista = todos.slice(0, max), resto = todos.slice(max);
  const suma = (campo) => resto.reduce((s, g) => s + g[campo], 0);
  return { lista, distintos: todos.length,
    otros: resto.length ? { distintos: resto.length, n: suma('n'), valor: suma('valor'), tickets: suma('tickets'), piezas: suma('piezas') } : null };
}

/* ---------- del cobro a la cancelacion ---------- */

/** Los tramos del tiempo entre la venta y el movimiento. El primero es lo que el cajero puede cancelar solo (cancelaciones.ts, 5 min). */
export const TRAMOS_DEMORA = ['Hasta 5 min', '5 min a 1 h', 'Más de 1 h, el mismo día', 'Otro día'];
/** La etiqueta corta de cada tramo, para el eje de la grafica (el titulo largo va en el globo). */
export const ETIQUETAS_DEMORA = ['≤ 5 min', '5–60 min', 'Mismo día', 'Otro día'];
export const VENTANA_CAJERO_MS = 5 * 60_000;

/** El tramo (0 a 3) de un movimiento: el reloj de la caja puede ir adelantado, asi que una demora negativa cuenta como cero. */
export function tramoDemora(ventaIso, enIso) {
  const antes = Date.parse(ventaIso), despues = Date.parse(enIso);
  if (Number.isNaN(antes) || Number.isNaN(despues)) return null;
  const ms = Math.max(0, despues - antes);
  if (ms <= VENTANA_CAJERO_MS) return 0;
  if (ms <= 3_600_000) return 1;
  return momentoTienda(ventaIso).dia === momentoTienda(enIso).dia ? 2 : 3;
}

/* ---------- el servidor: de las filas de D1 a la respuesta ---------- */

export const MEDIDAS_CONTROL = ['bruto', 'tickets', 'canc_n', 'canc_valor', 'tk_n', 'tk_valor', 'pz_n', 'pz_valor', 'cajon_n', 'desc_n', 'desc_monto',
  'cortes_n', 'cortes_corto', 'cortes_sobra', 'cortes_exacto', 'dif', 'falta', 'sobra'];
const ceros = () => Object.fromEntries(MEDIDAS_CONTROL.map((m) => [m, 0]));

/**
 * Arma la respuesta de /api/reportes/control. Filas de entrada (todas con `dia` = dia de la tienda de la VENTA, salvo las que dicen otra cosa):
 *  - `ventas`: { dia, cajero, tickets, bruto } por dia y cajero (todos los tickets, cancelados incluidos: es el bruto del cuadre);
 *  - `eventos`: { tipo: 'ticket' | 'pieza', dia, venta_en, en, por, motivo, dinero, dolarones } (un ticket cancelado completo o una pieza devuelta);
 *  - `aperturas`: { abierto_en, abierto_por }; `cortes`: { hasta, diferencia };
 *  - `descuentos`: { dia, monto, pidio, aprobo, con_solicitud } de los tickets no cancelados con descuento aprobado (fuera de la promocion);
 *  - `usuarios`: { correo, nombre, roles } para escribir a cada persona.
 * Valor de un movimiento = dinero + Dolarones, la misma unidad del bruto (un cancelado completo vale lo que el ticket aun valia).
 * Las filas fuera del periodo y de la comparacion se ignoran; las personas, los motivos y los patrones son solo del periodo.
 */
export function armarControl({ desde, hasta, grano, ventana, ventas, eventos, aperturas, cortes, descuentos, usuarios }) {
  const enPeriodo = (dia) => dia >= desde && dia <= hasta;
  const porDia = new Map();
  const dia = (d) => { if (!porDia.has(d)) porDia.set(d, ceros()); return porDia.get(d); };
  const nombres = new Map(usuarios.map((u) => [u.correo, u]));
  const personas = new Map();
  const persona = (correo) => {
    const c = correo ?? '';
    if (!personas.has(c)) {
      const u = nombres.get(c);
      personas.set(c, { correo: c, nombre: c === '' ? 'Sin registrar' : u?.nombre || c, computadora: !!u && String(u.roles).split(',').includes('computadora'),
        tickets: 0, tk_n: 0, tk_valor: 0, pz_n: 0, pz_valor: 0, cajon_n: 0, desc_pidio_n: 0, desc_pidio_monto: 0, desc_aprobo_n: 0, desc_auto_n: 0 });
    }
    return personas.get(c);
  };

  for (const f of ventas) {
    const x = dia(f.dia); x.tickets += f.tickets; x.bruto += f.bruto;
    if (enPeriodo(f.dia)) persona(f.cajero).tickets += f.tickets;
  }
  const delPeriodo = [];
  for (const e of eventos) {
    const x = dia(e.dia), valor = e.dinero + e.dolarones;
    x.canc_n += 1; x.canc_valor += valor;
    if (e.tipo === 'ticket') { x.tk_n += 1; x.tk_valor += valor; } else { x.pz_n += 1; x.pz_valor += valor; }
    if (!enPeriodo(e.dia)) continue;
    delPeriodo.push(e);
    const p = persona(e.por);
    if (e.tipo === 'ticket') { p.tk_n += 1; p.tk_valor += valor; } else { p.pz_n += 1; p.pz_valor += valor; }
  }
  const horasCajon = [];
  for (const a of aperturas) {
    const m = momentoTienda(a.abierto_en);
    if (!m) continue;
    dia(m.dia).cajon_n += 1;
    if (enPeriodo(m.dia)) { persona(a.abierto_por).cajon_n += 1; horasCajon.push(m); }
  }
  for (const c of cortes) {
    const m = momentoTienda(c.hasta);
    if (!m) continue;
    const x = dia(m.dia);
    x.cortes_n += 1; x.dif += c.diferencia;
    if (c.diferencia < 0) { x.cortes_corto += 1; x.falta -= c.diferencia; } else if (c.diferencia > 0) { x.cortes_sobra += 1; x.sobra += c.diferencia; } else x.cortes_exacto += 1;
  }
  let sinSolicitud = 0, autoaprobados = 0;
  for (const d of descuentos) {
    const x = dia(d.dia); x.desc_n += 1; x.desc_monto += d.monto;
    if (!enPeriodo(d.dia)) continue;
    const pidio = persona(d.pidio), aprobo = persona(d.aprobo);
    pidio.desc_pidio_n += 1; pidio.desc_pidio_monto += d.monto; aprobo.desc_aprobo_n += 1;
    if (!d.con_solicitud) sinSolicitud += 1;
    else if (d.pidio !== '' && d.pidio === d.aprobo) { autoaprobados += 1; pidio.desc_auto_n += 1; }
  }

  const { cubetas, totales, anterior } = armarCubetas({ desde, hasta, grano, ventana, porDia, medidas: MEDIDAS_CONTROL });

  const demora = TRAMOS_DEMORA.map((nombre) => ({ nombre, ticket: 0, pieza: 0 }));
  const horasMov = [];
  for (const e of delPeriodo) {
    const t = tramoDemora(e.venta_en, e.en);
    if (t !== null) demora[t][e.tipo === 'ticket' ? 'ticket' : 'pieza'] += 1;
    const m = momentoTienda(e.en);
    if (m) horasMov.push(m);
  }
  const contarHoras = (lista) => {
    const celdas = new Map();
    for (const m of lista) celdas.set(`${m.dia_semana}-${m.hora}`, (celdas.get(`${m.dia_semana}-${m.hora}`) ?? 0) + 1);
    return [...celdas].map(([k, n]) => { const [dia_semana, hora] = k.split('-').map(Number); return { dia_semana, hora, n }; });
  };

  return {
    cubetas, totales, anterior,
    motivos: agruparMotivos(delPeriodo),
    demora,
    por_hora: { movimientos: contarHoras(horasMov), cajon: contarHoras(horasCajon) },
    descuentos: { sin_solicitud: sinSolicitud, autoaprobados },
    personas: [...personas.values()].sort((a, b) => (b.tk_valor + b.pz_valor) - (a.tk_valor + a.pz_valor) || b.tickets - a.tickets || a.nombre.localeCompare(b.nombre)),
  };
}

/* ---------- las tarjetas ---------- */

/** Las 8 tarjetas de la vista: el mismo marcado que Resumen (`tarjetasHtml`); subir es malo en casi todas, y la flecha y el signo van escritos. */
export function tarjetasControl(d) {
  const t = d.totales, a = d.anterior, sc = d.cubetas;
  const hayComp = !!(a && a.tickets > 0);
  const comunes = { vs: d.comparar === 'mes' ? 'vs mes pasado' : 'vs anterior', hayComp, comparando: !!d.comparacion };
  const tasa = (x) => (x.bruto > 0 ? (x.canc_valor * 100) / x.bruto : null);
  const cambio = (actual, previo, opciones = { bueno: 'baja' }) => (hayComp ? cambioKpi(actual, previo, opciones) : null);
  const hayCortes = t.cortes_n > 0;
  const serie = (f) => { const s = sc.map(f); return s.some((v) => v) ? s : []; };   // una serie sin un solo dato no dibuja una linea plana
  return [
    { ...comunes, clave: 'canc', etiqueta: 'Cancelaciones y devoluciones', valor: n0(t.canc_n), cambio: cambio(t.canc_n, a?.canc_n),
      serie: serie((c) => c.canc_n), clase: 's2', pie: `${pesos(t.canc_valor)} devueltos o cancelados` },
    { ...comunes, clave: 'valor', etiqueta: 'Importe devuelto', valor: pesos(t.canc_valor), cambio: cambio(t.canc_valor, a?.canc_valor),
      serie: serie((c) => c.canc_valor), clase: 's2', pie: `${pesos(t.tk_valor)} en tickets completos y ${pesos(t.pz_valor)} por pieza` },
    { ...comunes, clave: 'tasa', etiqueta: 'Devuelto sobre ventas brutas', valor: tasa(t) == null ? '—' : `${n1(tasa(t))} %`,
      cambio: tasa(t) == null || !a ? null : cambio(tasa(t), tasa(a), { tipo: 'pp', bueno: 'baja' }), serie: serie(tasa), clase: 's2',
      pie: t.bruto > 0 ? `de ${pesos(t.bruto)} cobrados en tickets, con los cancelados` : 'Sin ventas en el periodo' },
    { ...comunes, clave: 'tk', etiqueta: 'Tickets cancelados completos', valor: n0(t.tk_n), cambio: cambio(t.tk_n, a?.tk_n),
      serie: serie((c) => c.tk_n), clase: 's2', pie: t.tickets > 0 ? `${pct(t.tk_n, t.tickets)} de ${cuenta(t.tickets, 'ticket', 'tickets')}` : 'Sin tickets en el periodo' },
    { ...comunes, clave: 'pz', etiqueta: 'Devoluciones por pieza', valor: n0(t.pz_n), cambio: cambio(t.pz_n, a?.pz_n),
      serie: serie((c) => c.pz_n), clase: 's2', pie: `${pesos(t.pz_valor)} devueltos` },
    { ...comunes, clave: 'cajon', etiqueta: 'Cajón abierto sin venta', valor: n0(t.cajon_n), cambio: cambio(t.cajon_n, a?.cajon_n),
      serie: serie((c) => c.cajon_n), clase: 's2', pie: t.tickets > 0 ? `${n1((t.cajon_n * 100) / t.tickets)} por cada 100 tickets` : 'Sin tickets en el periodo' },
    { ...comunes, clave: 'dif', etiqueta: 'Diferencia de cortes', valor: hayCortes ? pesosConSigno(t.dif) : '—',
      cambio: hayCortes && a && a.cortes_n > 0 ? cambio(t.dif, a.dif, { tipo: 'abs', bueno: 'neutro' }) : null, serie: serie((c) => c.dif), clase: 's3',
      pie: hayCortes ? `${cuenta(t.cortes_n, 'corte', 'cortes')}: ${n0(t.cortes_corto)} con faltante · ${n0(t.cortes_sobra)} con sobrante · ${n0(t.cortes_exacto)} exactos` : 'Sin cortes en el periodo' },
    { ...comunes, clave: 'desc', etiqueta: 'Descuentos aprobados', valor: n0(t.desc_n), cambio: cambio(t.desc_n, a?.desc_n, { bueno: 'neutro' }),
      serie: serie((c) => c.desc_n), clase: 's1', pie: `${pesos(t.desc_monto)} fuera de la promoción` },
  ];
}

/* ---------- datos de las graficas y sus tablas ---------- */

const ejes = (d) => d.cubetas.map((c) => ({ etiqueta: etiquetaCubeta(c, d.grano, d.cubetas.length), titulo: tituloCubeta(c, d.grano) }));
const vacio = (texto) => `<div class="vacio">${escapar(texto)}</div>`;
const demasiadas = (n) => `<div class="vacio">Con ${n0(n)} columnas la gráfica no se lee: elige «Semana» o «Mes» arriba. La tabla tiene todo.</div>`;

export const datosTiempo = (d) => [
  { nombre: 'Ticket completo', color: 'var(--serie-1)', valores: d.cubetas.map((c) => c.tk_valor) },
  { nombre: 'Pieza devuelta', color: 'var(--serie-2)', valores: d.cubetas.map((c) => c.pz_valor) },
];
export const datosCortes = (d) => [
  { nombre: 'Faltante', color: 'var(--serie-2)', valores: d.cubetas.map((c) => c.falta) },
  { nombre: 'Sobrante', color: 'var(--serie-1)', valores: d.cubetas.map((c) => c.sobra) },
];

export function tablaTiempo(d) {
  const e = ejes(d);
  return tabla(['Periodo', 'Tickets cancelados', 'Importe', 'Piezas devueltas', 'Importe', 'Total'],
    d.cubetas.map((c, i) => [e[i].titulo, n0(c.tk_n), pesos(c.tk_valor), n0(c.pz_n), pesos(c.pz_valor), pesos(c.canc_valor)]), [1, 2, 3, 4, 5]);
}
export function tablaCajonTiempo(d) {
  const e = ejes(d);
  return tabla(['Periodo', 'Cajón abierto sin venta', 'Tickets', 'Por cada 100 tickets'],
    d.cubetas.map((c, i) => [e[i].titulo, n0(c.cajon_n), n0(c.tickets), c.tickets > 0 ? n1((c.cajon_n * 100) / c.tickets) : '—']), [1, 2, 3]);
}
export function tablaCortesTiempo(d) {
  const e = ejes(d);
  return tabla(['Periodo', 'Cortes', 'Con faltante', 'Faltante', 'Con sobrante', 'Sobrante', 'Diferencia'],
    d.cubetas.map((c, i) => [e[i].titulo, n0(c.cortes_n), n0(c.cortes_corto), pesos(c.falta), n0(c.cortes_sobra), pesos(c.sobra), c.cortes_n ? pesosConSigno(c.dif) : '—']), [1, 2, 3, 4, 5, 6]);
}

export const textoMotivos = (d) => {
  const m = d.motivos;
  if (!m.lista.length) return '';
  return `Motivos escritos por quien cancela, agrupados sin distinguir mayúsculas, acentos ni espacios de más; nada se reclasifica. ${m.otros
    ? `Los ${n0(m.lista.length)} más usados; los otros ${n0(m.otros.distintos)} motivos distintos (${cuenta(m.otros.n, 'movimiento', 'movimientos')}) van juntos en «Otros».`
    : `${cuenta(m.distintos, 'motivo distinto', 'motivos distintos')}.`}`;
};

export function tablaMotivos(d) {
  const m = d.motivos;
  const filas = m.lista.map((g) => [g.texto, n0(g.n), n0(g.tickets), n0(g.piezas), pesos(g.valor)]);
  if (m.otros) filas.push([`Otros (${n0(m.otros.distintos)} motivos)`, n0(m.otros.n), n0(m.otros.tickets), n0(m.otros.piezas), pesos(m.otros.valor)]);
  return tabla(['Motivo', 'Movimientos', 'Tickets completos', 'Piezas', 'Importe'], filas, [1, 2, 3, 4]);
}

export function motivosHtml(d) {
  const m = d.motivos;
  if (!m.lista.length) return vacio('Sin cancelaciones ni devoluciones en este periodo.');
  const items = m.lista.map((g) => ({ nombre: g.texto, valor: g.n, texto: `${n0(g.n)} · ${pesos(g.valor)}`,
    tip: [g.texto, cuenta(g.n, 'movimiento', 'movimientos'), `${n0(g.tickets)} tickets completos y ${n0(g.piezas)} piezas`, pesos(g.valor)].join('\n') }));
  if (m.otros) items.push({ nombre: `Otros (${n0(m.otros.distintos)})`, valor: m.otros.n, texto: `${n0(m.otros.n)} · ${pesos(m.otros.valor)}`,
    tip: [`Otros ${n0(m.otros.distintos)} motivos`, cuenta(m.otros.n, 'movimiento', 'movimientos'), pesos(m.otros.valor)].join('\n') });
  return barrasHorizontales(items);
}

export function tablaDemora(d) {
  const total = d.demora.reduce((s, t) => s + t.ticket + t.pieza, 0);
  return tabla(['Tiempo desde la venta', 'Tickets completos', 'Piezas devueltas', 'Parte'],
    d.demora.map((t) => [t.nombre, n0(t.ticket), n0(t.pieza), pct(t.ticket + t.pieza, total)]), [1, 2, 3]);
}

const formatoCalor = (uno, varios, titulo) => ({ ...FORMATO_CALOR_DINERO, entero: true, valor: (n) => cuenta(n, uno, varios), eje: n0, vacio: `Sin ${varios}`, titulo, escala: `Escala: el tono más fuerte es más ${varios}` });
const mapaDe = (filas, uno, varios) => mapaCalor(filas.map((f) => ({ dia_semana: f.dia_semana, hora: f.hora, tickets: f.n, total: f.n })), (n) => (n ? cuenta(n, uno, varios) : `Sin ${varios}`));

/* ---------- por persona ---------- */

/** Cuentas de computadora: el nombre dice que no es una persona. */
const etiquetaPersona = (p) => `${p.nombre}${p.computadora ? ' (computadora de caja)' : ''}`;

export function tablaPersonas(d) {
  const t = d.totales;
  const num = (v) => `<td class="num">${escapar(v)}</td>`;
  const fila = (p) => `<tr><td>${escapar(etiquetaPersona(p))}</td>${[
    n0(p.tickets), n0(p.tk_n), pct(p.tk_n, p.tickets), n0(p.pz_n), pesos(p.tk_valor + p.pz_valor), n0(p.cajon_n),
    n0(p.desc_pidio_n), pesos(p.desc_pidio_monto), n0(p.desc_aprobo_n), n0(p.desc_auto_n),
  ].map(num).join('')}</tr>`;
  const total = `<tr><td><b>Total</b></td>${[
    n0(t.tickets), n0(t.tk_n), pct(t.tk_n, t.tickets), n0(t.pz_n), pesos(t.canc_valor), n0(t.cajon_n),
    n0(t.desc_n), pesos(t.desc_monto), n0(t.desc_n), n0(d.descuentos.autoaprobados),
  ].map((v) => `<td class="num"><b>${escapar(v)}</b></td>`).join('')}</tr>`;
  const cabeza = ['Persona', 'Tickets cobrados', 'Tickets cancelados', '% de sus tickets', 'Piezas devueltas', 'Importe devuelto', 'Cajón sin venta',
    'Descuentos pedidos', 'Importe pedido', 'Descuentos aprobados', 'Autoaprobados'];
  return `<table class="tabla"><thead><tr>${cabeza.map((h, i) => `<th${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead>
    <tbody>${d.personas.map(fila).join('')}${total}</tbody></table>`;
}

/* ---------- la vista ---------- */

function panel(id, titulo, sub, grafica, tablaHtml, nota = '') {
  return `<article class="panel" id="${id}"><header><h4>${titulo}${sub ? ` <span class="subtitulo">${sub}</span>` : ''}</h4>${tablaHtml ? '<button type="button" class="alterna">Ver tabla</button>' : ''}</header>
    <div class="${tablaHtml ? 'vista-grafica' : ''}">${grafica}</div>${tablaHtml ? `<div class="vista-tabla">${tablaHtml}</div>` : ''}${nota ? `<p class="nota">${nota}</p>` : ''}</article>`;
}

const GRANO = { dia: 'por día', semana: 'por semana (lunes a domingo)', mes: 'por mes' };

/** Todo el HTML de la vista; las graficas SVG van en huecos `data-grafica` que `montarControl` llena al conocer el ancho. */
export function htmlVista(d) {
  const grano = GRANO[d.grano], t = d.totales;
  const mov = mapaDe(d.por_hora.movimientos, 'movimiento', 'movimientos'), caj = mapaDe(d.por_hora.cajon, 'apertura', 'aperturas');
  const sinDatos = (n, texto) => (n ? '' : vacio(texto));
  const quien = `<b>Quién:</b> la cuenta con la que se cobró, canceló, devolvió o abrió el cajón. En una computadora de caja es la persona que entró con su PIN;
    sin PIN (o antes de que existiera) queda la cuenta de la computadora, que aquí se marca. «Sin registrar» son tickets o movimientos sin cuenta guardada.
    Este reporte usa <b>quién cobró</b> (<code>ventas.cajero</code>), no «quién atendió» (<code>ventas.vendedora</code>, que usa Equipo y existe solo desde que la caja la manda).`;
  return `
    <div class="principal"><div class="tarjetas" id="ctl-kpis">${tarjetasHtml(tarjetasControl(d))}</div></div>
    ${d.tienda ? '<p class="nota" style="margin:0">Filtrado por la tienda elegida: tickets, cancelaciones y descuentos de sus ventas; cajón y cortes de sus cajas.</p>' : ''}
    ${panel('ctl-tiempo', 'Cancelaciones y devoluciones en el tiempo', `${grano}, por el día de la venta · importe`,
      `${leyendaSeries(datosTiempo(d))}<div data-grafica="tiempo"></div>`, tablaTiempo(d),
      'Cada movimiento cuenta en el periodo de su venta, igual que el cuadre: un ticket de ayer cancelado hoy aparece ayer. El importe es dinero más Dolarones, lo mismo que el bruto.')}
    <div class="malla iguales">
      ${panel('ctl-motivos', 'Por motivo', 'movimientos · importe', motivosHtml(d), d.motivos.lista.length ? tablaMotivos(d) : '', textoMotivos(d))}
      ${panel('ctl-demora', 'Tiempo entre la venta y el movimiento', 'tickets completos y piezas',
        `${leyendaSeries([{ nombre: 'Ticket completo', color: 'var(--serie-1)' }, { nombre: 'Pieza devuelta', color: 'var(--serie-2)' }])}<div data-grafica="demora"></div>`, tablaDemora(d),
        'Hasta 5 minutos es lo que el cajero puede cancelar sin aprobación del dueño. Lo que llega otro día suele ser una devolución legítima, pero es lo que más conviene mirar.')}
    </div>
    ${panel('ctl-persona', 'Por persona', 'periodo elegido', `<div style="overflow-x:auto">${tablaPersonas(d)}</div>`, '',
      `«% de sus tickets» es lo que la persona canceló entre los tickets que ella cobró; pueden ser tickets de otra persona. Los descuentos son los aprobados fuera de la promoción:
       «pedidos» por quien los pidió en la caja y «aprobados» por quien los autorizó; «autoaprobados» los pidió y aprobó la misma cuenta (el dueño que descuenta por su cuenta).
       ${d.descuentos.sin_solicitud ? `${cuenta(d.descuentos.sin_solicitud, 'ticket tiene', 'tickets tienen')} descuento sin solicitud ligada. ` : ''}${quien}`)}
    <div class="malla iguales">
      ${panel('ctl-calor-mov', 'Cuándo se cancela', 'movimientos por hora de la tienda', mov.mejor ? mapaCalorHtml(mov, formatoCalor('movimiento', 'movimientos', 'Cancelaciones y devoluciones por día de la semana y hora')) : vacio('Sin cancelaciones ni devoluciones en este periodo.'),
        mov.mejor ? tablaCalor(mov, n0) : '', mov.mejor ? `Hora de la acción, no de la venta. La celda más fuerte: ${escapar(mov.mejor.titulo)} · ${escapar(mov.mejor.detalle)}. Cada celda suma todo el periodo.` : '')}
      ${panel('ctl-calor-cajon', 'Cuándo se abre el cajón sin venta', 'aperturas por hora de la tienda', caj.mejor ? mapaCalorHtml(caj, formatoCalor('apertura', 'aperturas', 'Cajón abierto sin venta por día de la semana y hora')) : vacio('Nadie abrió el cajón sin venta en este periodo.'),
        caj.mejor ? tablaCalor(caj, n0) : '', caj.mejor ? `La celda más fuerte: ${escapar(caj.mejor.titulo)} · ${escapar(caj.mejor.detalle)}. Una venta en efectivo abre el cajón sola y no aparece aquí.` : '')}
    </div>
    <div class="malla iguales">
      ${panel('ctl-cajon', 'Cajón abierto sin venta en el tiempo', grano, `<div data-grafica="cajon"></div>`, tablaCajonTiempo(d),
        'Cada vez que alguien usa «Abrir cajón» en la caja. Por periodo y contra los tickets que se cobraron en él.')}
      ${panel('ctl-cortes', 'Faltantes y sobrantes de los cortes', `${grano} · contado menos esperado`,
        `${t.cortes_n ? leyendaSeries(datosCortes(d)) : ''}${sinDatos(t.cortes_n, 'Sin cortes en este periodo.')}<div data-grafica="cortes"></div>`, t.cortes_n ? tablaCortesTiempo(d) : '',
        'Faltante y sobrante van aparte para que no se anulen entre sí; la tarjeta «Diferencia de cortes» es la suma de los dos. Cada corte cuenta en el día en que se cerró.')}
    </div>`;
}

/** Las graficas SVG del ancho que hay. */
export function graficaDe(clave, d, ancho) {
  const e = ejes(d), n = e.length;
  const apiladas = (series, sinDatos, extra = {}) => {
    if (series.every((s) => s.valores.every((v) => v === 0))) return vacio(sinDatos);
    if (n > MAX_COLUMNAS) return demasiadas(n);
    return columnas({ categorias: e, series, ancho, modo: 'apiladas', ...extra });
  };
  if (clave === 'tiempo') return apiladas(datosTiempo(d), 'Sin cancelaciones ni devoluciones en este periodo.', { fmtEje: pesosEje, fmtValor: pesos });
  if (clave === 'cortes') return apiladas(datosCortes(d), 'Sin diferencias en los cortes de este periodo.', { fmtEje: pesosEje, fmtValor: pesos, alto: 210 });
  if (clave === 'cajon') return apiladas([{ nombre: 'Cajón abierto sin venta', color: 'var(--serie-1)', valores: d.cubetas.map((c) => c.cajon_n) }],
    'Nadie abrió el cajón sin venta en este periodo.', { entero: true, fmtValor: n0, alto: 210 });
  const total = d.demora.reduce((s, t) => s + t.ticket + t.pieza, 0);
  if (!total) return vacio('Sin cancelaciones ni devoluciones en este periodo.');
  return columnas({ categorias: d.demora.map((t, i) => ({ etiqueta: ETIQUETAS_DEMORA[i], titulo: t.nombre })), modo: 'apiladas', ancho, alto: 210, entero: true, fmtValor: n0,
    series: [{ nombre: 'Ticket completo', color: 'var(--serie-1)', valores: d.demora.map((t) => t.ticket) }, { nombre: 'Pieza devuelta', color: 'var(--serie-2)', valores: d.demora.map((t) => t.pieza) }] });
}

/** Pone la vista en `raiz` y dibuja las graficas al ancho de su hueco; se redibujan solas si el hueco cambia (ventana, «Ver tabla»). */
export function montarControl(raiz, d) {
  raiz.innerHTML = htmlVista(d);
  raiz._observadores?.forEach((o) => o.disconnect());
  raiz._observadores = [...raiz.querySelectorAll('[data-grafica]')].map((el) => {
    const pintar = () => {
      const ancho = Math.floor(el.clientWidth);
      if (ancho) el.innerHTML = graficaDe(el.dataset.grafica, d, ancho);
    };
    pintar();
    const o = new ResizeObserver(pintar);
    o.observe(el);
    return o;
  });
}

