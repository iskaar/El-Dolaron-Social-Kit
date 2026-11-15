// Vista «Equipo» de /reportes (Issue #802): de /api/reportes/equipo al HTML y las graficas.
// Funciones puras (sin DOM): las usa el servidor (src/equipo.ts, `armarEquipo`) y la pagina, y se prueban en
// src/reportes-equipo.test.ts; solo `montarEquipo` toca document. Todo el dinero va en centavos enteros; los dias son
// dias de la tienda (UTC-6).
//
// A QUIEN SE ATRIBUYE UNA VENTA. A la persona que la caja marca como «quien atendio» (`ventas.vendedora`, una cuenta de cajero o
// capturista; migracion 069). Esa columna existe desde noviembre: antes, y siempre que la caja no la manda, la venta queda
// «Sin atribuir». No es `ventas.cajero` (quien cobro con su PIN, que usa Control). La pantalla dice desde que dia hay datos, calculado
// de la primera venta con vendedora, y cuanto de las ventas netas esta atribuido. Las cancelaciones de cada persona son los tickets
// completos que ELLA atendio y luego se cancelaron (en el periodo de la venta, como en Control); no las que ella hizo.
import { escapar, pesos, pesosEje, tabla, columnas, leyendaSeries, diaCorto } from './graficas.js';
import { armarCubetas, cambioKpi, vsCorto, tarjetasHtml, etiquetaCubeta, tituloCubeta } from './reportes-resumen.js';
import { MAX_COLUMNAS } from './reportes-ventas.js';

const n0 = (n) => Number(n ?? 0).toLocaleString('es-MX');
const n1 = (n) => Number(n).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const n2 = (n) => Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cuenta = (n, uno, varios) => `${n0(n)} ${n === 1 ? uno : varios}`;
const pct = (parte, todo) => (todo > 0 ? `${n1((parte * 100) / todo)} %` : '—');
const razon = (a, b) => (b > 0 ? a / b : null);

/** Menos dias con venta que estos y la cifra de una persona no se compara con la de quien trabajo mas. */
export const POCOS_DIAS = 5;

/* ---------- el servidor: de las filas de D1 a la respuesta ---------- */

export const MEDIDAS_EQUIPO = ['ventas_total', 'tickets_total', 'ventas', 'tickets', 'piezas', 'socios', 'socios_compraron', 'capturadas', 'vendidas_14', 'dias_trab', 'cancel_n'];
const ceros = () => Object.fromEntries(MEDIDAS_EQUIPO.map((m) => [m, 0]));

/**
 * Arma la parte nueva de la respuesta de /api/reportes/equipo y las filas por persona (con los campos de siempre). Filas de entrada, todas por dia de la tienda:
 *  - `ventas`: { dia, correo, tickets, ventas, piezas } netas por vendedora ('' = sin atribuir);  `cancelaciones`: { dia, correo, n, valor } de tickets completos de esa vendedora;
 *  - `socios`: { dia, correo, socios, socios_compraron } por quien dio el alta;  `apartados`: { dia, correo, apartados };
 *  - `capturas`: { dia, correo, capturadas, vendidas_14 };  `asistencias`: { dia, correo, n } (correo '' = empleado sin cuenta ligada);
 *  - `usuarios`: { correo, nombre };  `vendedoras`: { correo } (cuentas que atienden: salen aunque no hayan hecho nada);
 *  - `atribucionDesde`: el primer dia con una venta atribuida (de todo el historial) o null.
 * `personas` conserva los campos y el filtro de siempre (un renglon por cuenta, mas «Sin atribuir» solo si tiene tickets); `sin_atribuir`
 * trae siempre lo de las cuentas vacias, para que nada se pierda aunque no tenga renglon. `portal` son las altas que la socia hizo sola en el portal:
 * no son de ninguna persona y la tabla las muestra aparte; `capturas_sin_cuenta`, las piezas capturadas con `capturado_por` vacio (no entran a las personas ni a los totales).
 */
export function armarEquipo({ desde, hasta, grano, ventana, ventas, cancelaciones, socios, apartados, capturas, asistencias, usuarios, vendedoras, atribucionDesde }) {
  const enPeriodo = (dia) => dia >= desde && dia <= hasta;
  const porDia = new Map();
  const dia = (d) => { if (!porDia.has(d)) porDia.set(d, ceros()); return porDia.get(d); };
  const nombres = new Map(usuarios.map((u) => [u.correo, u.nombre]));
  const personas = new Map();
  const fila = (correo) => {
    const c = correo ?? '';
    if (!personas.has(c)) {
      personas.set(c, { correo: c, nombre: c ? nombres.get(c) || c : 'Sin atribuir', ventas: 0, tickets: 0, piezas: 0, socios: 0, socios_compraron: 0, apartados: 0,
        capturadas: 0, vendidas_14: 0, dias_trabajados: 0, cancelaciones: 0, cancelaciones_valor: 0, dias_con_venta: 0, _dias: new Set() });
    }
    return personas.get(c);
  };
  for (const v of vendedoras) fila(v.correo);

  const serie = new Map();    // correo -> ventas por dia, solo del periodo: de ahi salen las columnas apiladas
  for (const f of ventas) {
    const x = dia(f.dia);
    x.ventas_total += f.ventas; x.tickets_total += f.tickets;
    if (f.correo) { x.ventas += f.ventas; x.tickets += f.tickets; x.piezas += f.piezas; }
    if (!enPeriodo(f.dia)) continue;
    const p = fila(f.correo);
    p.ventas += f.ventas; p.tickets += f.tickets; p.piezas += f.piezas;
    if (f.tickets > 0) p._dias.add(f.dia);
    serie.set(f.correo ?? '', [...(serie.get(f.correo ?? '') ?? []), [f.dia, f.ventas]]);
  }
  for (const f of cancelaciones) {
    dia(f.dia).cancel_n += f.n;
    if (enPeriodo(f.dia)) { const p = fila(f.correo); p.cancelaciones += f.n; p.cancelaciones_valor += f.valor; }
  }
  // Quien dio el alta solo es una persona si es el correo de una cuenta: 'portal' (se registro sola) va en su renglon aparte y cualquier otro
  // valor que no sea un correo (el servidor ya deja fuera 'retos', que no son clientes) cae en «Sin atribuir».
  const portal = { socios: 0, socios_compraron: 0 };
  for (const f of socios) {
    const x = dia(f.dia); x.socios += f.socios; x.socios_compraron += f.socios_compraron;
    if (!enPeriodo(f.dia)) continue;
    const destino = f.correo === 'portal' ? portal : fila(String(f.correo ?? '').includes('@') ? f.correo : '');
    destino.socios += f.socios; destino.socios_compraron += f.socios_compraron;
  }
  for (const f of apartados) if (enPeriodo(f.dia)) fila(f.correo).apartados += f.apartados;
  // Una captura sin cuenta (`capturado_por` vacio) no es de ninguna persona: no entra a la tabla ni a los totales de Equipo, pero se cuenta aparte
  // para que Equipo + sin cuenta sea lo que dice Capturas.
  const sinCuenta = { capturadas: 0, vendidas_14: 0 };
  for (const f of capturas) {
    if (!f.correo) { if (enPeriodo(f.dia)) { sinCuenta.capturadas += f.capturadas; sinCuenta.vendidas_14 += f.vendidas_14; } continue; }
    const x = dia(f.dia); x.capturadas += f.capturadas; x.vendidas_14 += f.vendidas_14;
    if (enPeriodo(f.dia)) { const p = fila(f.correo); p.capturadas += f.capturadas; p.vendidas_14 += f.vendidas_14; }
  }
  for (const f of asistencias) {
    dia(f.dia).dias_trab += f.n;
    if (f.correo && enPeriodo(f.dia)) fila(f.correo).dias_trabajados += f.n;
  }

  const { cubetas, totales, anterior } = armarCubetas({ desde, hasta, grano, ventana, porDia, medidas: MEDIDAS_EQUIPO });

  // Ventas por persona en cada cubeta (las del periodo, alineadas con `cubetas`).
  const indice = new Map();
  cubetas.forEach((c, i) => { for (let k = 0; k < c.dias; k++) indice.set(sumarUnDia(c.desde, k), i); });
  const valores = (filas) => { const v = new Array(cubetas.length).fill(0); for (const [d, importe] of filas) v[indice.get(d)] += importe; return v; };
  const seriePersonas = [...serie].filter(([correo]) => correo !== '').map(([correo, filas]) => ({ correo, nombre: personas.get(correo).nombre, valores: valores(filas) }))
    .sort((a, b) => b.valores.reduce((s, x) => s + x, 0) - a.valores.reduce((s, x) => s + x, 0) || a.nombre.localeCompare(b.nombre));

  const limpias = [...personas.values()].map(({ _dias, ...p }) => ({ ...p, dias_con_venta: _dias.size }));
  const vacia = { ventas: 0, tickets: 0, piezas: 0, socios: 0, socios_compraron: 0, apartados: 0, capturadas: 0, vendidas_14: 0, dias_trabajados: 0, cancelaciones: 0, cancelaciones_valor: 0, dias_con_venta: 0 };
  const sin = limpias.find((p) => p.correo === '') ?? { ...vacia, correo: '', nombre: 'Sin atribuir' };

  // El porcentaje atribuido desde que la caja manda a quien atendio (lo anterior no tiene con que atribuirse).
  const desdeAtrib = atribucionDesde && atribucionDesde > desde ? atribucionDesde : desde;
  const vistos = { ventas: 0, ventas_total: 0 };
  if (atribucionDesde && atribucionDesde <= hasta) {
    for (const [d, x] of porDia) if (enPeriodo(d) && d >= desdeAtrib) { vistos.ventas += x.ventas; vistos.ventas_total += x.ventas_total; }
  }

  return {
    cubetas, totales, anterior,
    serie_personas: seriePersonas,
    serie_sin_atribuir: valores(serie.get('') ?? []),
    sin_atribuir: sin,
    portal,
    capturas_sin_cuenta: sinCuenta,
    atribucion: { desde: atribucionDesde ?? null, dentro_del_periodo: !!atribucionDesde && atribucionDesde > desde, desde_ventas: vistos.ventas, desde_total: vistos.ventas_total },
    personas: limpias.filter((p) => p.correo || p.tickets).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre))),
  };
}

const sumarUnDia = (dia, n) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/* ---------- las tarjetas ---------- */

/** Las 8 tarjetas de la vista, con el mismo marcado que Resumen (`tarjetasHtml`). */
export function tarjetasEquipo(d) {
  const t = d.totales, a = d.anterior, sc = d.cubetas;
  const hayComp = !!(a && a.tickets_total > 0);
  const comunes = { vs: vsCorto(d), hayComp, comparando: !!d.comparacion };
  const cambio = (actual, previo, opciones = {}) => (hayComp ? cambioKpi(actual, previo, opciones) : null);
  const serie = (f) => { const s = sc.map(f); return s.some((v) => v) ? s : []; };   // una serie sin un solo dato no dibuja una linea plana
  const ticket = (x) => (x.tickets ? Math.round(x.ventas / x.tickets) : null);
  const ppt = (x) => razon(x.piezas, x.tickets);
  const parte = (x) => (x.ventas_total > 0 ? (x.ventas * 100) / x.ventas_total : null);
  const at = d.atribucion;
  const hayAsist = !!d.asistencias.desde;
  const sinAtribuir = t.tickets_total - t.tickets;
  const tarjetaAtrib = at.desde === null ? 'Ninguna venta tiene quién atendió: la caja aún no lo registra'
    : at.dentro_del_periodo ? `Desde el ${diaCorto(at.desde)}: ${pct(at.desde_ventas, at.desde_total)} · antes no se registraba` : `Desde el ${diaCorto(at.desde)}`;
  return [
    { ...comunes, clave: 'ventas', etiqueta: 'Ventas atribuidas', valor: pesos(t.ventas), cambio: cambio(t.ventas, a?.ventas), serie: serie((c) => c.ventas), clase: 's1',
      pie: t.ventas_total > 0 ? `${pct(t.ventas, t.ventas_total)} de las ventas netas (${pesos(t.ventas_total)})` : 'Sin ventas en el periodo' },
    { ...comunes, clave: 'parte', etiqueta: 'Ventas con persona atribuida', valor: parte(t) == null ? '—' : `${n1(parte(t))} %`,
      cambio: parte(t) == null || !a ? null : cambio(parte(t), parte(a), { tipo: 'pp' }), serie: serie(parte), clase: 's1', pie: tarjetaAtrib },
    { ...comunes, clave: 'tickets', etiqueta: 'Tickets atribuidos', valor: n0(t.tickets), cambio: cambio(t.tickets, a?.tickets), serie: serie((c) => c.tickets), clase: 's1',
      pie: t.tickets_total === 0 ? 'Sin tickets en el periodo' : sinAtribuir > 0 ? `y ${cuenta(sinAtribuir, 'ticket', 'tickets')} sin atribuir` : 'Todos los tickets tienen persona' },
    { ...comunes, clave: 'ticket', etiqueta: 'Ticket promedio', valor: ticket(t) == null ? '—' : pesos(ticket(t)), cambio: a ? cambio(ticket(t), ticket(a)) : null,
      serie: serie(ticket), clase: 's1', pie: ppt(t) == null ? 'Sin tickets atribuidos' : `${n2(ppt(t))} piezas por ticket` },
    { ...comunes, clave: 'socios', etiqueta: 'Socios dados de alta', valor: n0(t.socios), cambio: cambio(t.socios, a?.socios), serie: serie((c) => c.socios), clase: 's3',
      pie: `${n0(t.socios_compraron)} compraron ese mismo día${d.tienda ? ' · negocio completo' : ''}` },
    { ...comunes, clave: 'capturadas', etiqueta: 'Piezas capturadas', valor: n0(t.capturadas), cambio: cambio(t.capturadas, a?.capturadas), serie: serie((c) => c.capturadas), clase: 's3',
      pie: `${n0(t.vendidas_14)} vendidas en sus primeros 14 días${(d.capturas_sin_cuenta?.capturadas ?? 0) > 0 ? ` · ${cuenta(d.capturas_sin_cuenta.capturadas, 'captura sin cuenta no está', 'capturas sin cuenta no están')} aquí` : ''} · detalle en Capturas${d.tienda ? ' · negocio completo' : ''}` },
    { ...comunes, clave: 'dias', etiqueta: 'Días trabajados', valor: hayAsist ? n0(t.dias_trab) : '—', cambio: hayAsist ? cambio(t.dias_trab, a?.dias_trab, { bueno: 'neutro' }) : null,
      serie: hayAsist ? serie((c) => c.dias_trab) : [], clase: 's2',
      pie: hayAsist ? `Suma de días de asistencia · registros desde el ${diaCorto(d.asistencias.desde)}${d.tienda ? ' · negocio completo' : ''}` : 'Nómina aún no tiene asistencias registradas' },
    { ...comunes, clave: 'personas', etiqueta: 'Personas con ventas', valor: n0(d.personas.filter((p) => p.correo && p.tickets > 0).length), cambio: null, serie: [], clase: 's1',
      pie: 'Con al menos un ticket atribuido en el periodo' },
  ];
}

/* ---------- ventas por persona en el tiempo ---------- */

const COLORES = ['var(--serie-1)', 'var(--serie-2)', 'var(--serie-3)', 'var(--serie-4)'];
export const COLOR_SIN_ATRIBUIR = 'var(--apagado)';

/** Las series de la grafica: cada persona con su color; con mas de cuatro, las tres que mas vendieron y «Resto». «Sin atribuir» va aparte y en gris. */
export function seriesVentas(d) {
  const con = d.serie_personas.filter((p) => p.valores.some((v) => v > 0));
  const suma = (lista) => d.cubetas.map((_, i) => lista.reduce((s, p) => s + p.valores[i], 0));
  const grupos = con.length <= COLORES.length ? con.map((p) => ({ nombre: p.nombre, valores: p.valores }))
    : [...con.slice(0, COLORES.length - 1).map((p) => ({ nombre: p.nombre, valores: p.valores })),
      { nombre: `Resto (${con.length - (COLORES.length - 1)} personas)`, valores: suma(con.slice(COLORES.length - 1)) }];
  const salida = grupos.map((g, i) => ({ ...g, color: COLORES[i] }));
  if (d.serie_sin_atribuir.some((v) => v > 0)) salida.push({ nombre: 'Sin atribuir', color: COLOR_SIN_ATRIBUIR, valores: d.serie_sin_atribuir });
  return salida;
}

export function tablaSerie(d) {
  const series = seriesVentas(d);
  const total = (i) => series.reduce((s, x) => s + x.valores[i], 0);
  return tabla(['Periodo', ...series.map((s) => s.nombre), 'Total'],
    d.cubetas.map((c, i) => [tituloCubeta(c, d.grano), ...series.map((s) => pesos(s.valores[i])), pesos(total(i))]), series.map((_, i) => i + 1).concat(series.length + 1));
}

/* ---------- por persona ---------- */

const metricas = (p) => ({
  ventas: p.ventas, tickets: p.tickets, ticket: razon(p.ventas, p.tickets), piezas_ticket: razon(p.piezas, p.tickets), dias_con_venta: p.dias_con_venta,
  por_dia: razon(p.ventas, p.dias_con_venta), cancelaciones: p.cancelaciones, socios: p.socios, socios_compraron: p.socios_compraron, apartados: p.apartados,
  capturadas: p.capturadas, vendidas_14: p.vendidas_14, dias_trabajados: p.dias_trabajados,
});

/** Las columnas de la tabla: [clave, encabezado, como se escribe]. */
export const COLUMNAS = [
  ['ventas', 'Ventas netas', (m) => pesos(m.ventas)], ['tickets', 'Tickets', (m) => n0(m.tickets)],
  ['ticket', 'Ticket promedio', (m) => (m.ticket == null ? '—' : pesos(Math.round(m.ticket)))], ['piezas_ticket', 'Piezas por ticket', (m) => (m.piezas_ticket == null ? '—' : n2(m.piezas_ticket))],
  ['dias_con_venta', 'Días con venta', (m) => n0(m.dias_con_venta)], ['por_dia', 'Ventas por día con venta', (m) => (m.por_dia == null ? '—' : pesos(Math.round(m.por_dia)))],
  ['cancelaciones', 'Tickets cancelados', (m) => n0(m.cancelaciones)], ['socios', 'Socios dados de alta', (m) => n0(m.socios)],
  ['socios_compraron', 'Compraron ese día', (m) => n0(m.socios_compraron)], ['apartados', 'Apartados cerrados', (m) => n0(m.apartados)],
  ['capturadas', 'Piezas capturadas', null], ['vendidas_14', 'Vendidas a 14 días', (m) => n0(m.vendidas_14)], ['dias_trabajados', 'Días trabajados', null],
];

/** Las personas ordenadas por una columna (mayor primero; sin dato al final) o por nombre. */
export function ordenarPersonas(personas, clave = 'nombre', descendente = true) {
  const valor = (p) => (clave === 'nombre' ? p.nombre : metricas(p)[clave]);
  return [...personas].sort((a, b) => {
    const [x, y] = [valor(a), valor(b)];
    if (clave === 'nombre') return descendente ? String(x).localeCompare(String(y)) : String(y).localeCompare(String(x));
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return (descendente ? y - x : x - y) || String(a.nombre).localeCompare(String(b.nombre));
  });
}

/**
 * La tabla por persona con el total y, aparte, «Sin atribuir». `orden` = { clave, descendente }. Cada encabezado es un boton que ordena.
 * Una persona con menos de POCOS_DIAS dias con venta lleva la marca «pocos días»: su total no se compara con el de quien trabajo mas.
 */
export function tablaPersonas(d, orden = { clave: 'ventas', descendente: true }) {
  const hayAsist = !!d.asistencias.desde;
  const t = d.totales, sa = d.sin_atribuir;
  const celda = (clave, texto, p) => {
    if (clave === 'capturadas') return `<td class="num">${p.capturadas ? `<a href="#capturas" title="Ver el tiempo y la productividad de las capturas">${escapar(n0(p.capturadas))}</a>` : '0'}</td>`;
    if (clave === 'dias_trabajados') return `<td class="num">${escapar(hayAsist ? n0(p.dias_trabajados) : '—')}</td>`;
    return `<td class="num">${escapar(texto)}</td>`;
  };
  const filaDe = (p, clase = '') => {
    const m = metricas(p);
    const pocos = p.correo !== '' && p.tickets > 0 && p.dias_con_venta < POCOS_DIAS;
    return `<tr${clase}><td>${escapar(p.nombre)}${pocos ? ` <span class="pocos" title="Menos de ${POCOS_DIAS} días con venta: no se compara con quien trabajó más">pocos días</span>` : ''}</td>${COLUMNAS.map(([clave, , f]) => celda(clave, f ? f(m) : '', p)).join('')}</tr>`;
  };
  const gente = ordenarPersonas(d.personas.filter((p) => p.correo), orden.clave, orden.descendente);
  const sinFila = sa.tickets || sa.socios || sa.cancelaciones || sa.capturadas || sa.apartados;
  const filaSin = sinFila ? filaDe(sa, ' class="sec"') : '';
  const pt = d.portal ?? { socios: 0, socios_compraron: 0 };
  const filaPortal = pt.socios ? `<tr class="sec"><td>Por el portal (sin persona)</td>${COLUMNAS.map(([clave]) => `<td class="num">${clave === 'socios' ? n0(pt.socios) : clave === 'socios_compraron' ? n0(pt.socios_compraron) : '—'}</td>`).join('')}</tr>` : '';
  const fila = (clave) => {
    if (clave === 'ventas') return pesos(t.ventas_total);
    if (clave === 'tickets') return n0(t.tickets_total);
    if (clave === 'ticket') return t.tickets_total ? pesos(Math.round(t.ventas_total / t.tickets_total)) : '—';
    if (clave === 'cancelaciones') return n0(t.cancel_n);
    if (clave === 'socios') return n0(t.socios);
    if (clave === 'socios_compraron') return n0(t.socios_compraron);
    if (clave === 'apartados') return n0(d.personas.reduce((s, p) => s + p.apartados, 0));
    if (clave === 'capturadas') return n0(t.capturadas);
    if (clave === 'vendidas_14') return n0(t.vendidas_14);
    if (clave === 'dias_trabajados') return hayAsist ? n0(t.dias_trab) : '—';
    return '—';
  };
  const total = `<tr><td><b>Total</b></td>${COLUMNAS.map(([clave]) => `<td class="num"><b>${escapar(fila(clave))}</b></td>`).join('')}</tr>`;
  const cabeza = COLUMNAS.map(([clave, texto]) => {
    const activa = orden.clave === clave;
    return `<th class="num"${activa ? ` aria-sort="${orden.descendente ? 'descending' : 'ascending'}"` : ''}><button type="button" class="ordena" data-orden="${clave}">${escapar(texto)}${activa ? (orden.descendente ? ' ▼' : ' ▲') : ''}</button></th>`;
  }).join('');
  const cuerpo = d.personas.some((p) => p.correo) || filaSin || filaPortal ? `${gente.map((p) => filaDe(p)).join('')}${filaSin}${filaPortal}${total}` : `<tr><td colspan="${COLUMNAS.length + 1}" class="vacio">Sin personas con actividad en este periodo.</td></tr>`;
  return `<table class="tabla"><thead><tr><th><button type="button" class="ordena" data-orden="nombre">Persona${orden.clave === 'nombre' ? (orden.descendente ? ' ▲' : ' ▼') : ''}</button></th>${cabeza}</tr></thead><tbody>${cuerpo}</tbody></table>`;
}

/* ---------- la vista ---------- */

const vacio = (texto) => `<div class="vacio">${escapar(texto)}</div>`;
const GRANO = { dia: 'por día', semana: 'por semana (lunes a domingo)', mes: 'por mes' };

function panel(id, titulo, sub, grafica, tablaHtml, nota = '') {
  return `<article class="panel" id="${id}"><header><h4>${titulo}${sub ? ` <span class="subtitulo">${sub}</span>` : ''}</h4>${tablaHtml ? '<button type="button" class="alterna">Ver tabla</button>' : ''}</header>
    <div class="${tablaHtml ? 'vista-grafica' : ''}">${grafica}</div>${tablaHtml ? `<div class="vista-tabla">${tablaHtml}</div>` : ''}${nota ? `<p class="nota">${nota}</p>` : ''}</article>`;
}

/** Con una tienda elegida: lo que se filtra y lo que no (socios, capturas y asistencias no se registran por tienda; el bono tampoco se filtra). */
export const avisoTienda = 'Con una tienda elegida, las ventas, los tickets, los tickets cancelados y los apartados son de esa tienda. Los socios dados de alta, las piezas capturadas y los días trabajados no se registran por tienda: siguen siendo del negocio completo, igual que el bono semanal de abajo.';

/** El texto de la atribucion: desde que dia hay datos y cuanto de las ventas esta atribuido (siempre dicho, nunca solo en el color). */
export function notaAtribucion(d) {
  const at = d.atribucion, t = d.totales;
  if (at.desde === null) return 'Ninguna venta tiene todavía a quien la atendió (la caja la manda desde noviembre): todo está en «Sin atribuir» y las cifras por persona de ventas quedan en cero.';
  const antes = at.dentro_del_periodo ? ` El periodo empieza antes: lo anterior al ${diaCorto(at.desde)} no tiene a quién atribuirse y baja el porcentaje del periodo (${pct(t.ventas, t.ventas_total)}).` : '';
  return `Una venta se atribuye a quien la caja marcó como «quien atendió» (cuenta de cajero o capturista); hay datos desde el ${diaCorto(at.desde)}. Desde ese día, ${pct(at.desde_ventas, at.desde_total)} de las ventas netas tiene persona.${antes}`;
}

/** Todo el HTML de la vista; la grafica va en un hueco `data-grafica` que `montarEquipo` llena al conocer el ancho. */
export function htmlVista(d, orden) {
  const series = seriesVentas(d);
  const hayVentas = series.length > 0;
  const hayAsist = !!d.asistencias.desde;
  return `
    <div class="principal"><div class="tarjetas" id="eq-kpis">${tarjetasHtml(tarjetasEquipo(d))}</div></div>
    ${d.tienda ? `<p class="nota" style="margin:0">${escapar(avisoTienda)}</p>` : ''}
    ${panel('eq-tiempo', 'Ventas por persona en el tiempo', `${GRANO[d.grano]} · ventas netas`,
      `${hayVentas ? leyendaSeries(series) : ''}<div data-grafica="ventas">${hayVentas ? '' : vacio('Sin ventas en este periodo.')}</div>`, hayVentas ? tablaSerie(d) : '',
      `${escapar(notaAtribucion(d))}`)}
    <article class="panel" id="eq-personas"><header><h4>Por persona <span class="subtitulo">periodo elegido · toca un encabezado para ordenar</span></h4></header>
      <div id="eq-tabla" style="overflow-x:auto">${tablaPersonas(d, orden)}</div>
      <p class="nota"><b>Cómo comparar.</b> Los totales de quien trabajó más días siempre serán mayores: para comparar usa ticket promedio, piezas por ticket o ventas por día con venta.
        «pocos días» marca a quien tiene menos de ${POCOS_DIAS} días con venta en el periodo: su promedio todavía no dice mucho.
        «Tickets cancelados» son los tickets completos que la persona atendió y luego se cancelaron (cuentan en su bruto, no en sus ventas netas); lo que cada quien cancela está en Control.
        Socios: altas que registró y cuántos compraron ese mismo día; las que la socia hizo sola en el portal van en su propio renglón. Apartados: cerrados en caja. «Vendidas a 14 días»: de las piezas que capturó en el periodo, cuántas se vendieron
        en sus primeras dos semanas; las de los últimos 14 días aún pueden venderse, así que no es una tasa. El tiempo y la calidad de las capturas están en Capturas.
        ${(d.capturas_sin_cuenta?.capturadas ?? 0) > 0 ? `Piezas capturadas: solo las de una cuenta; ${cuenta(d.capturas_sin_cuenta.capturadas, 'captura del periodo no tiene cuenta', 'capturas del periodo no tienen cuenta')} y por eso falta${d.capturas_sin_cuenta.capturadas === 1 ? '' : 'n'} aquí (Capturas sí ${d.capturas_sin_cuenta.capturadas === 1 ? 'la' : 'las'} cuenta). ` : ''}Días trabajados: asistencias de su empleado en Nómina (hay que ligar su cuenta allá)${hayAsist ? '' : '; Nómina todavía no tiene asistencias, por eso aparece «—»'}.</p>
    </article>`;
}

export function graficaDe(clave, d, ancho) {
  const series = seriesVentas(d);
  if (!series.length) return '';
  if (d.cubetas.length > MAX_COLUMNAS) return `<div class="vacio">Con ${n0(d.cubetas.length)} columnas la gráfica no se lee: elige «Semana» o «Mes» arriba. La tabla tiene todo.</div>`;
  return columnas({ categorias: d.cubetas.map((c) => ({ etiqueta: etiquetaCubeta(c, d.grano, d.cubetas.length), titulo: tituloCubeta(c, d.grano) })), series, ancho, modo: 'apiladas', fmtEje: pesosEje, fmtValor: pesos });
}

/** Pone la vista en `raiz`, dibuja la grafica al ancho de su hueco y deja ordenar la tabla por la columna que se toque. */
export function montarEquipo(raiz, d) {
  const orden = { clave: 'ventas', descendente: true };
  raiz.innerHTML = htmlVista(d, orden);
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
  raiz.onclick = (e) => {
    const clave = e.target.closest?.('.ordena')?.dataset.orden;
    if (!clave) return;
    // Un toque ordena de mayor a menor; otro toque a la misma columna, al reves. El nombre arranca de la A a la Z.
    orden.descendente = orden.clave === clave ? !orden.descendente : clave !== 'nombre';
    orden.clave = clave;
    raiz.querySelector('#eq-tabla').innerHTML = tablaPersonas(d, orden);
    raiz.querySelector(`#eq-tabla [data-orden="${clave}"]`)?.focus();
  };
}

