// Resumen de /reportes (Issue #802): fechas, cubetas, ventana de comparacion, meta, hallazgos y el HTML del Resumen.
// Funciones puras (sin DOM): las usan el servidor (src/reportes-resumen.ts) y la pagina, y se prueban en
// src/reportes-resumen.test.ts. Todo el dinero va en centavos enteros; los dias son dias de la tienda (UTC-6).
import {
  escapar, pesos, pesosConSigno, cambio, flechaCambio, sumarDias, diaCorto, diaLargo, diaSemana, minigrafica, escala, pesosEje,
  barrasHorizontales, apilada, tabla,
} from './graficas.js';

/* ---------- fechas ---------- */

const dos = (n) => String(n).padStart(2, '0');
const MS_DIA = 86_400_000;
/** Dias entre dos dias de la tienda, ambos inclusive. */
export const diasEntre = (desde, hasta) => Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / MS_DIA) + 1;
export const lunesDe = (dia) => sumarDias(dia, -((new Date(`${dia}T00:00:00Z`).getUTCDay() + 6) % 7));
/** Dias que tiene el mes del dia dado. */
export const diasDelMes = (dia) => new Date(Date.UTC(+dia.slice(0, 4), +dia.slice(5, 7), 0)).getUTCDate();
export const primeroDelMes = (dia) => `${dia.slice(0, 8)}01`;
export const ultimoDelMes = (dia) => `${dia.slice(0, 8)}${dos(diasDelMes(dia))}`;

/** El mismo dia del mes anterior; si ese mes no lo tiene (29 a 31), el ultimo del mes y `recortado: true`. */
export function mesAtras(dia) {
  let anio = +dia.slice(0, 4), mes = +dia.slice(5, 7) - 1;
  if (mes === 0) { anio -= 1; mes = 12; }
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const d = Math.min(+dia.slice(8, 10), ultimo);
  return { dia: `${anio}-${dos(mes)}-${dos(d)}`, recortado: d < +dia.slice(8, 10) };
}

/* ---------- comparacion ---------- */

export const COMPARACIONES = ['anterior', 'mes', 'ninguna'];
export const NOMBRES_COMPARACION = { anterior: 'Periodo anterior', mes: 'Mismo periodo del mes pasado', ninguna: 'Sin comparar' };

/**
 * La ventana contra la que se compara el periodo [desde, hasta] (dias de la tienda, inclusivos), o null sin comparar.
 *  - anterior: los mismos dias justo antes del periodo.
 *  - mes: el mismo rango un mes atras. Mismo largo que el periodo, y NUNCA invade el periodo ni se sale del mes pasado:
 *    · si el dia inicial existe el mes pasado, se abre ahi y, si el rango se pasara del largo (el mes pasado fue mas corto
 *      que el actual a mitad del rango), se corta en `desde + largo - 1`; si el dia final no existe (31 -> 30), se recorta
 *      al ultimo dia del mes pasado, asi que el mes entero contra el mes pasado entero es 31 dias contra 30;
 *    · si el dia inicial NO existe el mes pasado (29 a 31 en un mes que lo tiene y el pasado no), la ventana conserva el
 *      largo y termina donde termina el rango desplazado: 29-31 mar contra 26-28 feb, no contra un solo dia.
 * La cubeta i del periodo se compara con el dia i de la ventana, asi cada cubeta contra otra de igual largo.
 */
export function ventanaComparacion(desde, hasta, modo) {
  const dias = diasEntre(desde, hasta);
  if (modo === 'mes') {
    const a = mesAtras(desde), b = mesAtras(hasta);
    let inicio = a.dia, fin = b.dia;
    if (a.recortado) {
      inicio = sumarDias(fin, -(dias - 1));
      if (inicio < primeroDelMes(a.dia)) inicio = primeroDelMes(a.dia);
    } else if (diasEntre(inicio, fin) > dias) fin = sumarDias(inicio, dias - 1);
    return { desde: inicio, hasta: fin, dias: diasEntre(inicio, fin) };
  }
  if (modo === 'ninguna') return null;
  return { desde: sumarDias(desde, -dias), hasta: sumarDias(desde, -1), dias };
}

/* ---------- grano y cubetas ---------- */

export const GRANOS = ['dia', 'semana', 'mes'];

/**
 * Las cubetas de [desde, hasta]: un dia, una semana de lunes a domingo o un mes calendario. La primera y la ultima pueden
 * quedar cortadas por el periodo: llevan `parcial: true` (una semana a medias vende menos, y la grafica lo dice).
 */
export function cubetas(desde, hasta, grano) {
  const lista = [];
  for (let inicio = desde; inicio <= hasta;) {
    const unidad = grano === 'semana' ? [lunesDe(inicio), sumarDias(lunesDe(inicio), 6)]
      : grano === 'mes' ? [primeroDelMes(inicio), ultimoDelMes(inicio)] : [inicio, inicio];
    const fin = unidad[1] > hasta ? hasta : unidad[1];
    lista.push({ desde: inicio, hasta: fin, dias: diasEntre(inicio, fin), parcial: inicio !== unidad[0] || fin !== unidad[1] });
    inicio = sumarDias(fin, 1);
  }
  return lista;
}

/** Semana y mes solo se ofrecen si el periodo da al menos dos cubetas: un grano mas grueso que el periodo no dibuja una tendencia. */
export function granosPermitidos(desde, hasta) {
  return { dia: true, semana: cubetas(desde, hasta, 'semana').length >= 2, mes: cubetas(desde, hasta, 'mes').length >= 2 };
}

/** El grano que se usa: el pedido si el periodo lo permite; si no, por dia hasta 35 dias y por semana despues. */
export function granoEfectivo(pedido, desde, hasta) {
  const ok = granosPermitidos(desde, hasta);
  if (GRANOS.includes(pedido) && ok[pedido]) return pedido;
  return diasEntre(desde, hasta) <= 35 || !ok.semana ? 'dia' : 'semana';
}

const MEDIDAS = ['ventas', 'tickets', 'piezas', 'descuento', 'gastos'];
const sumarEn = (destino, fuente) => { if (fuente) for (const m of MEDIDAS) destino[m] += fuente[m] ?? 0; };
const ceros = () => ({ ventas: 0, tickets: 0, piezas: 0, descuento: 0, gastos: 0 });

/**
 * De lo de cada dia a las cubetas del periodo, sus totales y los de la comparacion. `porDia`: Map dia -> {ventas, tickets,
 * piezas, descuento, gastos} (los dias que faltan valen cero). `ventana`: de ventanaComparacion o null. Los totales son la suma
 * de las cubetas: lo que dibuja la grafica y lo que dicen las tarjetas es lo mismo. La cubeta lleva `anterior` (null si la
 * ventana ya se acabo) con los dias que le tocaron; con `sinGastos` los gastos van en null (no se llevan por tienda).
 */
export function armarCubetas({ desde, hasta, grano, ventana, porDia, sinGastos = false }) {
  const totales = ceros();
  const anterior = ventana ? ceros() : null;
  let indice = 0;
  const lista = cubetas(desde, hasta, grano).map((c) => {
    const fila = { ...c, ...ceros(), anterior: null };
    const previa = ventana ? { ...ceros(), dias: 0 } : null;
    for (let k = 0; k < c.dias; k++, indice++) {
      sumarEn(fila, porDia.get(sumarDias(c.desde, k)));
      if (ventana && indice < ventana.dias) { sumarEn(previa, porDia.get(sumarDias(ventana.desde, indice))); previa.dias += 1; }
    }
    if (previa && previa.dias > 0) fila.anterior = previa;
    sumarEn(totales, fila);
    if (fila.anterior) sumarEn(anterior, fila.anterior);
    if (sinGastos) { fila.gastos = null; if (fila.anterior) fila.anterior.gastos = null; }
    return fila;
  });
  if (sinGastos) { totales.gastos = null; if (anterior) anterior.gastos = null; }
  return { cubetas: lista, totales, anterior };
}

/** Promedio movil de `n` valores: null hasta que hay `n` (no se promedia con menos, seria otra cosa). */
export function promedioMovil(valores, n = 7) {
  return valores.map((_, i) => (i < n - 1 ? null : Math.round(valores.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n)));
}

/* ---------- meta del mes ---------- */

/**
 * La meta del mes de la tienda contra lo vendido a la fecha. `acumuladoPorDia[i]` = ventas netas acumuladas al dia i+1 del mes; su
 * largo son los dias transcurridos (el ultimo dia del periodo, no hoy). Proyeccion lineal: lo acumulado entre los dias transcurridos
 * por los dias del mes; un mes ya cerrado proyecta lo que se vendio. `confiable` pide al menos 7 dias de historia.
 * Sin meta (monto null) devuelve lo acumulado y nada que comparar.
 */
export function calcularMeta({ monto, acumuladoPorDia, diasMes }) {
  const transcurridos = acumuladoPorDia.length;
  const acumulado = transcurridos ? acumuladoPorDia[transcurridos - 1] : 0;
  const cerrado = transcurridos >= diasMes;
  const proyeccion = transcurridos === 0 ? 0 : cerrado ? acumulado : Math.round((acumulado * diasMes) / transcurridos);
  const base = { dias_mes: diasMes, transcurridos, cerrado, acumulado, acumulado_por_dia: acumuladoPorDia, proyeccion, confiable: cerrado || transcurridos >= 7 };
  if (!(monto > 0)) return { ...base, monto: null, avance_pct: null, proyeccion_pct: null, brecha: null, brecha_pct: null };
  const un = (v) => Math.round(v * 10) / 10;
  return {
    ...base, monto,
    avance_pct: un((acumulado * 100) / monto), proyeccion_pct: un((proyeccion * 100) / monto),
    brecha: proyeccion - monto, brecha_pct: un(((proyeccion - monto) * 100) / monto),
  };
}

/** El ritmo de la meta por cubeta: monto / dias del mes por los dias de la cubeta. Solo si la cubeta cae entera en el mes de la meta (una semana a caballo entre dos meses no tiene un ritmo honesto). */
export function ritmoPorCubeta(lista, meta, mes) {
  if (!meta?.monto) return lista.map(() => null);
  const primero = `${mes}-01`, ultimo = ultimoDelMes(primero);
  return lista.map((c) => (c.desde < primero || c.hasta > ultimo ? null : Math.round((meta.monto * c.dias) / meta.dias_mes)));
}

/* ---------- que cambio: reglas fijas, sin texto generado ---------- */

// Umbrales: por debajo de ellos la regla calla (un hallazgo flojo es ruido). Montos en centavos.
export const UMBRALES = {
  categoriaMonto: 100_000,       // una categoria se reporta si cambio al menos $1,000 ...
  categoriaPorVentas: 0.02,      // ... y al menos 2 % de las ventas netas del periodo ...
  categoriaPct: 15,              // ... y al menos 15 % contra su propio periodo comparado
  mejorDiaMinDias: 7,            // el mejor dia solo dice algo con 7 dias o mas ...
  mejorDiaMinConVentas: 5,       // ... 5 con ventas ...
  mejorDiaVeces: 1.5,            // ... y si supera 1.5 veces el promedio diario
  mejorDiaMinTickets: 3,
  descuentoPp: 2,                // el descuento sobre bruto subio 2 puntos o mas ...
  descuentoMonto: 50_000,        // ... y suma al menos $500
  gastosPct: 20,                 // los gastos subieron 20 % o mas ...
  gastosMonto: 100_000,          // ... y al menos $1,000
  pisoViejoPct: 15,              // 9 semanas o mas en piso: al menos 15 % del valor ...
  pisoViejoMonto: 500_000,       // ... y al menos $5,000
};
export const MAX_HALLAZGOS = 4;
const un = (v) => v.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const entero = (v) => Math.round(v).toLocaleString('es-MX');

/**
 * Hasta MAX_HALLAZGOS hallazgos, los problemas primero. Cada uno: { clave, tono: 'bien'|'mal'|'neu', partes: [[texto, negrita?]..] }.
 * `d` es la respuesta de /api/reportes/resumen mas `inventario` (de /api/reportes). Sin comparacion, las reglas que comparan
 * callan. Si el periodo comparado tuvo otro largo (mes contra mes de distinto numero de dias), lo comparado se escala al
 * largo del periodo. Devuelve [] antes que un hallazgo debil.
 */
export function hallazgos(d, { nombreCategoria = (c) => c } = {}) {
  const U = UMBRALES;
  const t = d.totales;
  const hechos = {};
  const comp = d.comparacion && d.anterior && d.anterior.tickets > 0 ? d.comparacion : null;
  const factor = comp ? d.periodo.dias / comp.dias : 1;

  if (comp) {
    const cambios = d.categorias.map((c) => {
      const previo = c.anterior * factor, delta = c.total - previo;
      return { ...c, previo, delta, pct: previo > 0 ? (delta * 100) / previo : null };
    }).filter((c) => c.pct !== null && Math.abs(c.delta) >= Math.max(U.categoriaMonto, U.categoriaPorVentas * t.ventas) && Math.abs(c.pct) >= U.categoriaPct);
    const sube = cambios.filter((c) => c.delta > 0).sort((a, b) => b.delta - a.delta)[0];
    const baja = cambios.filter((c) => c.delta < 0).sort((a, b) => a.delta - b.delta)[0];
    if (sube) hechos.categoria_crece = { tono: 'bien', partes: [[nombreCategoria(sube.categoria), true], [` es la categoría que más creció: ${pesosConSigno(Math.round(sube.delta))} (+${un(sube.pct)} %) contra el periodo comparado.`]] };
    if (baja) hechos.categoria_cae = { tono: 'mal', partes: [[nombreCategoria(baja.categoria), true], [` es la categoría que más cayó: ${pesosConSigno(Math.round(baja.delta))} (−${un(Math.abs(baja.pct))} %) contra el periodo comparado.`]] };

    const pctAntes = d.anterior.ventas + d.anterior.descuento > 0 ? (d.anterior.descuento * 100) / (d.anterior.ventas + d.anterior.descuento) : null;
    const pctAhora = t.ventas + t.descuento > 0 ? (t.descuento * 100) / (t.ventas + t.descuento) : null;
    if (pctAntes !== null && pctAhora !== null && pctAhora - pctAntes >= U.descuentoPp && t.descuento >= U.descuentoMonto) {
      hechos.descuento_sube = { tono: 'mal', partes: [['El descuento sobre el bruto subió', true], [` de ${un(pctAntes)} % a ${un(pctAhora)} % (+${un(pctAhora - pctAntes)} pp): ${pesos(t.descuento)} dejados de cobrar.`]] };
    }
    if (t.gastos != null && d.anterior.gastos > 0) {
      const previo = d.anterior.gastos * factor, delta = t.gastos - previo;
      if ((delta * 100) / previo >= U.gastosPct && delta >= U.gastosMonto) {
        hechos.gastos_suben = { tono: 'mal', partes: [['Los gastos subieron', true], [` ${pesosConSigno(Math.round(delta))} (+${un((delta * 100) / previo)} %) contra el periodo comparado: ${pesos(t.gastos)}.`]] };
      }
    }
  }

  const mejor = d.mejor_dia;
  if (mejor && d.periodo.dias >= U.mejorDiaMinDias && d.dias_con_ventas >= U.mejorDiaMinConVentas && mejor.tickets >= U.mejorDiaMinTickets
      && t.ventas > 0 && mejor.ventas >= U.mejorDiaVeces * (t.ventas / d.periodo.dias)) {
    hechos.mejor_dia = { tono: 'bien', partes: [['El mejor día fue el ' + diaLargo(mejor.dia).replace(/ de \d{4}$/, ''), true],
      [`, con ${pesos(mejor.ventas)} en ${entero(mejor.tickets)} ${mejor.tickets === 1 ? 'ticket' : 'tickets'}: ${un(mejor.ventas / (t.ventas / d.periodo.dias))} veces el promedio diario.`]] };
  }

  const viejo = d.inventario?.por_antiguedad?.find((x) => x.tramo === '9+');
  if (viejo && d.inventario.valor > 0 && viejo.valor >= U.pisoViejoMonto && (viejo.valor * 100) / d.inventario.valor >= U.pisoViejoPct) {
    hechos.piso_viejo = { tono: 'neu', partes: [[`${entero(viejo.unidades)} piezas`, true], [` llevan 9 semanas o más en piso (${pesos(viejo.valor)}, ${un((viejo.valor * 100) / d.inventario.valor)} % del valor en piso). Son candidatas a rebaja.`]] };
  }

  return ['descuento_sube', 'gastos_suben', 'categoria_cae', 'categoria_crece', 'mejor_dia', 'piso_viejo']
    .filter((clave) => hechos[clave]).slice(0, MAX_HALLAZGOS).map((clave) => ({ clave, ...hechos[clave] }));
}

/* ---------- KPI: cambio por significado, no por direccion ---------- */

/**
 * Cambio de una tarjeta contra la comparacion: { flecha, texto, tono } o null si no hay con que comparar.
 * `tipo`: 'pct' (porcentaje; sin base si lo previo es 0), 'pp' (puntos porcentuales entre dos porcentajes) o 'abs' (cifras con signo, como el
 * resultado: con base positiva, porcentaje; si no, la diferencia en pesos). `bueno`: 'sube', 'baja' o 'neutro': el color sale de lo que
 * significa (gastos y descuento que suben son malos), la flecha de la direccion, y las dos van escritas.
 */
export function cambioKpi(actual, previo, { tipo = 'pct', bueno = 'sube' } = {}) {
  if (actual == null || previo == null) return null;
  let direccion, texto;
  if (tipo === 'pp') {
    const diferencia = Math.round((actual - previo) * 10) / 10;
    direccion = diferencia > 0 ? 'sube' : diferencia < 0 ? 'baja' : 'igual';
    texto = `${un(Math.abs(diferencia))} pp`;
    texto = direccion === 'sube' ? `+${texto}` : direccion === 'baja' ? `−${texto}` : texto;
  } else if (tipo === 'abs' && !(previo > 0)) {
    direccion = actual > previo ? 'sube' : actual < previo ? 'baja' : 'igual';
    texto = pesosConSigno(actual - previo);
  } else {
    const c = cambio(actual, previo);
    if (!c) return null;
    direccion = c.direccion; texto = c.texto;
  }
  const tono = direccion === 'igual' || bueno === 'neutro' ? 'neu' : direccion === bueno ? 'bien' : 'mal';
  return { flecha: direccion === 'sube' ? '▲' : direccion === 'baja' ? '▼' : '=', texto, tono, direccion };
}

/* ---------- texto ---------- */

const mayuscula = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const pct1 = (v) => `${un(v)} %`;
const cuenta = (n, uno, varios) => `${entero(n)} ${n === 1 ? uno : varios}`;
const nombreMes = (mes) => mayuscula(new Date(`${mes}-15T12:00:00`).toLocaleDateString('es-MX', { month: 'long' }));
const mesCorto = (dia) => new Date(`${dia.slice(0, 7)}-15T12:00:00`).toLocaleDateString('es-MX', { month: 'short', year: '2-digit' }).replace('.', '');
const rangoTexto = (desde, hasta) => (desde === hasta ? diaCorto(desde) : `${diaCorto(desde)} – ${diaCorto(hasta)}`);

/** «Comparado con 21 sep – 18 oct» (y el aviso cuando los dos periodos no tienen el mismo largo). */
export function textoComparacion(d) {
  if (!d.comparacion) return 'Sin comparar';
  const c = d.comparacion;
  const base = d.comparar === 'mes' ? `Comparado con el mismo periodo del mes pasado: ${rangoTexto(c.desde, c.hasta)}` : `Comparado con ${rangoTexto(c.desde, c.hasta)}`;
  return c.dias === d.periodo.dias ? base : `${base} (${cuenta(c.dias, 'día', 'días')} contra ${d.periodo.dias})`;
}
const vsCorto = (d) => (d.comparar === 'mes' ? 'vs mes pasado' : 'vs anterior');

/* ---------- tarjetas ---------- */

const razon = (a, b) => (b > 0 ? a / b : null);

/** Las 8 tarjetas: valor, cambio, serie para la minigrafica y pie. `inv` es el inventario en piso (de /api/reportes) o null. */
export function tarjetasKpi(d, inv) {
  const t = d.totales, a = d.anterior, sc = d.cubetas;
  const hayComp = !!(a && a.tickets > 0);
  const vs = vsCorto(d);
  const ticket = (x) => (x.tickets ? Math.round(x.ventas / x.tickets) : null);
  const ppt = (x) => razon(x.piezas, x.tickets);
  const descPct = (x) => (x.ventas + x.descuento > 0 ? (x.descuento * 100) / (x.ventas + x.descuento) : null);
  const serie = (f) => sc.map(f);
  const cierre = d.meta && d.meta.monto ? d.meta : null;
  const sinGastos = t.gastos == null;
  const resultado = (x) => (x.gastos == null ? null : x.ventas - x.gastos);
  const dias = d.periodo.dias;

  const tarjetas = [
    { clave: 'ventas', etiqueta: 'Ventas netas', valor: pesos(t.ventas), cambio: hayComp ? cambioKpi(t.ventas, a.ventas) : null,
      serie: serie((c) => c.ventas), clase: 's1', pie: cierre ? null : `${pesos(Math.round(t.ventas / dias))} por día`,
      avance: cierre ? { pct: cierre.avance_pct, texto: `Meta de ${nombreMes(d.meta_mes).toLowerCase()}: ${pct1(cierre.avance_pct)} · día ${cierre.transcurridos} de ${cierre.dias_mes}` } : null },
    { clave: 'tickets', etiqueta: 'Tickets', valor: entero(t.tickets), cambio: hayComp ? cambioKpi(t.tickets, a.tickets) : null,
      serie: serie((c) => c.tickets), clase: 's1', pie: `${un(t.tickets / dias)} por día` },
    { clave: 'ticket', etiqueta: 'Ticket promedio', valor: ticket(t) == null ? '—' : pesos(ticket(t)), cambio: hayComp ? cambioKpi(ticket(t), ticket(a)) : null,
      serie: serie(ticket), clase: 's1', pie: null },
    { clave: 'piezas', etiqueta: 'Piezas por ticket', valor: ppt(t) == null ? '—' : ppt(t).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      cambio: hayComp ? cambioKpi(ppt(t), ppt(a)) : null, serie: serie(ppt), clase: 's1', pie: `${cuenta(t.piezas, 'pieza', 'piezas')} en el periodo` },
    { clave: 'descuento', etiqueta: 'Descuento sobre bruto', valor: descPct(t) == null ? '—' : pct1(descPct(t)),
      cambio: hayComp ? cambioKpi(descPct(t), descPct(a), { tipo: 'pp', bueno: 'baja' }) : null, serie: serie(descPct), clase: 's2',
      pie: `${pesos(t.descuento)} en descuentos y promociones` },
    { clave: 'gastos', etiqueta: 'Gastos', valor: sinGastos ? '—' : pesos(t.gastos),
      cambio: !sinGastos && a && a.gastos > 0 ? cambioKpi(t.gastos, a.gastos, { bueno: 'baja' }) : null,
      serie: sinGastos ? [] : serie((c) => c.gastos), clase: 's2',
      pie: sinGastos ? 'Los gastos no se registran por tienda: elige «Todas las tiendas»' : t.ventas > 0 ? `${pct1((t.gastos * 100) / t.ventas)} de las ventas netas` : 'Sin ventas en el periodo' },
    { clave: 'resultado', etiqueta: 'Resultado operativo', valor: sinGastos ? '—' : pesos(resultado(t)),
      cambio: !sinGastos && a ? cambioKpi(resultado(t), resultado(a), { tipo: 'abs' }) : null,
      serie: sinGastos ? [] : serie(resultado), clase: 's3', pie: sinGastos ? 'Necesita los gastos, que no son por tienda' : 'Ventas netas − gastos, antes del costo de la mercancía' },
  ];

  // Valor en piso: una foto de AHORA (no hay historial de inventario): sin minigrafica ni cambio.
  const edad = inv ? edadPromedio(inv) : null;
  tarjetas.push({ clave: 'piso', etiqueta: 'Valor en piso', valor: inv ? pesos(inv.valor) : '—', cambio: null, serie: [], clase: 's1', foto: true,
    pie: inv ? `${cuenta(inv.unidades, 'pieza', 'piezas')}${edad == null ? '' : ` · ${entero(edad)} días de antigüedad promedio`} · foto de hoy, todo el negocio` : 'Cargando el inventario…' });
  return tarjetas.map((k) => ({ ...k, vs, hayComp, comparando: !!d.comparacion }));
}

/** Antiguedad promedio en dias, ponderada por piezas de cada categoria (las sin fecha no entran a su promedio). */
export function edadPromedio(inv) {
  const filas = (inv.por_categoria ?? []).filter((c) => c.dias_promedio != null && c.piezas > 0);
  const piezas = filas.reduce((s, c) => s + c.piezas, 0);
  return piezas ? filas.reduce((s, c) => s + c.dias_promedio * c.piezas, 0) / piezas : null;
}

export function tarjetasHtml(tarjetas) {
  return tarjetas.map((k) => {
    let delta;
    if (k.foto) delta = '<div class="delta">Sin historial de inventario para comparar</div>';
    else if (!k.comparando) delta = '<div class="delta">Sin comparar</div>';
    else if (k.cambio) delta = `<div class="delta"><span class="chip ${k.cambio.tono}">${escapar(`${k.cambio.flecha} ${k.cambio.texto}`)}</span>${escapar(k.vs)}</div>`;
    else delta = `<div class="delta">${k.hayComp ? 'Sin base de comparación' : 'Sin ventas en el periodo comparado'}</div>`;
    const mini = k.serie.length >= 2 ? `<div class="mini-caja">${minigrafica(k.serie, { clase: k.clase, etiqueta: `Tendencia de ${k.etiqueta}` })}</div>` : '';
    const avance = k.avance
      ? `<div class="avance" role="img" aria-label="${escapar(k.avance.texto)}"><i style="width:${Math.min(100, Math.max(0, k.avance.pct))}%"></i></div><div class="pie">${escapar(k.avance.texto)}</div>` : '';
    return `<div class="tarjeta kpi"><div class="etq">${escapar(k.etiqueta)}</div><div class="valor">${escapar(k.valor)}</div>${delta}${mini}${avance}${k.pie ? `<div class="pie">${escapar(k.pie)}</div>` : ''}</div>`;
  }).join('');
}

/* ---------- la serie principal ---------- */

const etiquetaCubeta = (c, grano, n) => (grano === 'dia' ? (n <= 10 ? `${diaSemana(c.desde)} ${c.desde.slice(8).replace(/^0/, '')}` : diaCorto(c.desde))
  : grano === 'semana' ? diaCorto(c.desde) : mesCorto(c.desde));
const tituloCubeta = (c, grano) => (grano === 'dia' ? mayuscula(diaLargo(c.desde))
  : `${grano === 'semana' ? `Semana del ${rangoTexto(c.desde, c.hasta)}` : mayuscula(new Date(`${c.desde.slice(0, 7)}-15T12:00:00`).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }))}${c.parcial ? ` (parcial: ${c.dias} ${c.dias === 1 ? 'día' : 'días'})` : ''}`);

/** Lo que pide graficaTiempo: una fila por cubeta con su comparacion alineada, el promedio movil (solo por dia) y el ritmo de la meta. */
export function datosTendencia(d) {
  const media = d.grano === 'dia' ? promedioMovil(d.cubetas.map((c) => c.ventas), 7) : d.cubetas.map(() => null);
  const ritmo = ritmoPorCubeta(d.cubetas, d.meta && d.meta.monto ? d.meta : null, d.meta_mes);
  const hayComp = !!(d.anterior && d.anterior.tickets > 0);
  return d.cubetas.map((c, i) => {
    const detalle = [`${cuenta(c.tickets, 'ticket', 'tickets')} · ${cuenta(c.piezas, 'pieza', 'piezas')}`];
    if (c.parcial) detalle.push('Cubeta parcial: el periodo la corta');
    if (c.anterior && hayComp) {
      const camb = cambio(c.ventas, c.anterior.ventas);
      detalle.push(`Comparado: ${pesos(c.anterior.ventas)}${camb ? ` · ${flechaCambio(camb)}` : ''}${c.anterior.dias < c.dias ? ` (solo ${c.anterior.dias} de ${c.dias} días)` : ''}`);
    }
    if (media[i] != null) detalle.push(`Promedio de 7 días: ${pesos(media[i])}`);
    if (ritmo[i] != null) detalle.push(`Ritmo de la meta: ${pesos(ritmo[i])}`);
    return {
      clave: c.desde, etiqueta: etiquetaCubeta(c, d.grano, d.cubetas.length), titulo: tituloCubeta(c, d.grano), valor: c.ventas, detalle,
      media: media[i], comparacion: hayComp && c.anterior ? c.anterior.ventas : null, ritmo: ritmo[i],
    };
  });
}

/** La leyenda de la tendencia: solo lo que de verdad se dibuja. */
export function leyendaTendencia(d) {
  const hayComp = !!(d.anterior && d.anterior.tickets > 0);
  const items = [['barra', `Ventas netas por ${d.grano === 'dia' ? 'día' : d.grano}`]];
  if (d.grano === 'dia' && d.cubetas.length >= 7) items.push(['media', 'Promedio móvil de 7 días']);
  if (hayComp) items.push(['comp', d.comparar === 'mes' ? 'Mismo periodo del mes pasado' : 'Periodo anterior']);
  if (d.meta && d.meta.monto) items.push(['ritmo', 'Ritmo de la meta']);
  return `<div class="leyenda-linea">${items.map(([clase, texto]) => `<span><i class="llave-${clase}"></i>${escapar(texto)}</span>`).join('')}</div>${
    d.comparacion && !hayComp ? '<p class="nota">No hubo ventas en el periodo comparado: no hay línea de comparación.</p>' : ''}`;
}

export function tablaTendencia(d) {
  const hayComp = !!(d.anterior && d.anterior.tickets > 0);
  const filas = d.cubetas.map((c) => [
    tituloCubeta(c, d.grano), pesos(c.ventas), c.tickets, c.piezas, hayComp ? (c.anterior ? pesos(c.anterior.ventas) : '—') : '—',
  ]);
  return tabla([d.grano === 'dia' ? 'Día' : d.grano === 'semana' ? 'Semana' : 'Mes', 'Ventas netas', 'Tickets', 'Piezas', 'Comparado'], filas, [1, 2, 3, 4]);
}

/* ---------- meta ---------- */

export function metaHtml(d) {
  const m = d.meta, mes = nombreMes(d.meta_mes);
  if (m.solo_negocio) {
    return `<p class="vacio">La meta es de todo el negocio. Elige «Todas las tiendas» para ver cómo va contra la meta de ${escapar(mes.toLowerCase())}.</p>`;
  }
  if (!m.monto) {
    return `<div class="meta-num">${escapar(pesos(m.acumulado))} <small>vendido en ${escapar(mes.toLowerCase())} al día ${m.transcurridos}</small></div>
      <p class="vacio">No hay una meta de ventas para ${escapar(mes.toLowerCase())}. Se fija en <a href="/admin">Cola de revisión</a> → Configuración → «Meta de ventas del mes $ (tablero)»; con 0 se apaga.</p>`;
  }
  const brecha = cambioKpi(m.proyeccion, m.monto);
  const final = m.cerrado;
  return `<div class="meta-num">${escapar(pct1(m.avance_pct))} <small>de ${escapar(pesos(m.monto))}</small></div>
    <dl class="pares"><dt>Acumulado al día ${m.transcurridos} de ${m.dias_mes}</dt><dd class="num">${escapar(pesos(m.acumulado))}</dd>
      <dt>${final ? 'Cierre del mes' : 'Proyección de cierre del mes'}</dt><dd class="num"><b>${escapar(pesos(m.proyeccion))}</b></dd>
      <dt>${final ? 'Contra la meta' : 'Proyección contra la meta'}</dt><dd class="num">${brecha ? `<span class="chip ${brecha.tono}">${escapar(`${brecha.flecha} ${brecha.texto}`)}</span> ${escapar(pesosConSigno(m.brecha))}` : '—'}</dd></dl>
    <p class="nota">${final ? 'Mes cerrado: la proyección es lo vendido.' : `Proyección lineal: lo acumulado ÷ ${m.transcurridos} ${m.transcurridos === 1 ? 'día' : 'días'} de la tienda × ${m.dias_mes} días del mes.${m.confiable ? '' : ' Con menos de 7 días la proyección es poco confiable.'}`}
      La meta es del mes de la fecha final del periodo, sin importar cuántos días se vean.</p>`;
}

/** Acumulado contra el ritmo de la meta y la proyeccion, por dia del mes. */
export function graficaMeta(d, { ancho, alto = 190 }) {
  const m = d.meta;
  if (!m || m.solo_negocio || !m.monto || !m.transcurridos) return '';
  const ml = 58, mr = 12, mt = 12, mb = 24;
  const pw = Math.max(40, ancho - ml - mr), ph = alto - mt - mb;
  const maximo = Math.max(m.monto, m.proyeccion, m.acumulado);
  const { tope, marcas } = escala(maximo, 3);
  const x = (dia) => ml + ((dia - 1) / Math.max(1, m.dias_mes - 1)) * pw;
  const y = (v) => mt + ph - (v / tope) * ph;
  const rejilla = marcas.map((v) => `<line class="${v === 0 ? 'eje' : 'rejilla'}" x1="${ml}" x2="${ancho - mr}" y1="${y(v)}" y2="${y(v)}"/><text class="marca" x="${ml - 8}" y="${y(v) + 4}" text-anchor="end">${pesosEje(v)}</text>`).join('');
  const dias = Array.from({ length: m.dias_mes }, (_, i) => i + 1);
  const ejeX = dias.filter((n) => n === 1 || n % 5 === 0 || n === m.dias_mes).map((n) => `<text class="marca" x="${x(n)}" y="${alto - 6}" text-anchor="middle">${n}</text>`).join('');
  const ritmo = (n) => (m.monto * n) / m.dias_mes;
  const real = m.acumulado_por_dia.map((v, i) => `${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`);
  const trazoReal = real.length > 1 ? `<path class="trazo" d="M${real.join(' L')}"/>` : '';
  const zonas = m.acumulado_por_dia.map((v, i) => `<rect class="hit pasiva" x="${(x(i + 1) - pw / m.dias_mes / 2).toFixed(1)}" y="${mt}" width="${(pw / m.dias_mes).toFixed(1)}" height="${ph}"
    data-tip="${escapar([`Día ${i + 1}`, pesos(v), `Ritmo de la meta: ${pesos(Math.round(ritmo(i + 1)))}`].join('\n'))}"/>`).join('');
  return `<svg class="svg-grafica" width="${ancho}" height="${alto}" viewBox="0 0 ${ancho} ${alto}" role="img"
    aria-label="Acumulado del mes contra la meta: ${escapar(pesos(m.acumulado))} al día ${m.transcurridos}, proyección ${escapar(pesos(m.proyeccion))}">
    ${rejilla}${ejeX}
    <path class="ritmo" d="M${x(1)},${y(ritmo(1))} L${x(m.dias_mes)},${y(m.monto)}"/>
    ${m.cerrado ? '' : `<path class="comp" d="M${x(m.transcurridos)},${y(m.acumulado)} L${x(m.dias_mes)},${y(m.proyeccion)}"/>`}
    ${trazoReal}<circle class="punto-fin" cx="${x(m.transcurridos)}" cy="${y(m.acumulado)}" r="4"/>${zonas}</svg>
    <div class="leyenda-linea"><span><i class="llave-ritmo"></i>Meta</span>${m.cerrado ? '' : '<span><i class="llave-comp"></i>Proyección</span>'}<span><i class="llave-barra"></i>Acumulado real</span></div>`;
}

export function tablaMeta(d) {
  const m = d.meta;
  if (!m || m.solo_negocio || !m.monto) return '';
  return tabla(['Día del mes', 'Acumulado', 'Ritmo de la meta'], m.acumulado_por_dia.map((v, i) => [String(i + 1), pesos(v), pesos(Math.round((m.monto * (i + 1)) / m.dias_mes))]), [1, 2]);
}

/* ---------- que cambio, canales, categorias ---------- */

export function hallazgosHtml(lista) {
  if (lista.length < 2) {
    return '<p class="vacio">Sin cambios relevantes en este periodo: ninguna regla pasó su umbral.</p>';
  }
  const glifo = { bien: '▲', mal: '▼', neu: '●' };
  return `<ul class="hallazgos">${lista.map((h) => `<li><span class="g d ${h.tono}" aria-hidden="true">${glifo[h.tono]}</span>
    <span>${h.partes.map(([texto, negrita]) => (negrita ? `<b>${escapar(texto)}</b>` : escapar(texto))).join('')}</span></li>`).join('')}</ul>`;
}

const CANALES = [['tienda', 'Tienda', 'var(--serie-1)'], ['whatsapp', 'WhatsApp', 'var(--serie-2)'], ['revendedoras', 'Revendedoras', 'var(--serie-3)']];

export function canalesHtml(d) {
  const hayComp = !!(d.anterior && d.anterior.tickets > 0);
  const items = CANALES.map(([clave, nombre, color]) => {
    const c = d.canales[clave], camb = hayComp ? cambioKpi(c.ventas, c.anterior) : null;
    return { nombre, valor: c.ventas, color, texto: pesos(c.ventas), extra: camb ? `${camb.flecha} ${camb.texto}` : hayComp ? '—' : '' };
  });
  const ml = d.canales.mercado_libre;
  const aparte = ml
    ? `<p class="nota"><b>Mercado Libre, aparte:</b> ${escapar(pesos(ml.total))} · ${escapar(cuenta(ml.piezas, 'pieza', 'piezas'))}${hayComp && ml.anterior > 0 ? ` · ${escapar(`${cambioKpi(ml.total, ml.anterior).flecha} ${cambioKpi(ml.total, ml.anterior).texto}`)}` : ''}.
       No suma a las ventas netas${ml.estimado ? `; es un estimado: ${escapar(cuenta(ml.piezas - ml.piezas_reales, 'pieza', 'piezas'))} con el precio publicado, no el real de la orden` : ''}.</p>`
    : '<p class="nota">Mercado Libre y los gastos no se registran por tienda.</p>';
  return `${apilada(items)}${aparte}`;
}

export function tablaCanales(d) {
  const hayComp = !!(d.anterior && d.anterior.tickets > 0);
  const filas = CANALES.map(([clave, nombre]) => {
    const c = d.canales[clave], camb = hayComp ? cambioKpi(c.ventas, c.anterior) : null;
    return [nombre, pesos(c.ventas), c.tickets, hayComp ? pesos(c.anterior) : '—', camb ? `${camb.flecha} ${camb.texto}` : '—'];
  });
  return tabla(['Canal', 'Ventas netas', 'Tickets', 'Comparado', 'Cambio'], filas, [1, 2, 3, 4]);
}

/** Categorias contra la comparacion: las 8 mayores y «Otras». Mismas reglas que la barra de categorias de Ventas. */
export function categoriasHtml(d, nombreCategoria = (c) => c) {
  const hayComp = !!(d.anterior && d.anterior.tickets > 0);
  const cats = d.categorias;
  if (!cats.some((c) => c.total > 0)) return '<div class="vacio">Sin ventas en este periodo.</div>';
  const principales = cats.slice(0, cats.length > 9 ? 8 : 9);
  const resto = cats.slice(principales.length);
  const filas = resto.length ? [...principales, { categoria: `Otras (${resto.length})`, total: resto.reduce((s, c) => s + c.total, 0), piezas: resto.reduce((s, c) => s + c.piezas, 0),
    anterior: resto.reduce((s, c) => s + c.anterior, 0), literal: true }] : principales;
  return barrasHorizontales(filas.map((c) => {
    const nombre = c.literal ? c.categoria : nombreCategoria(c.categoria), camb = hayComp ? cambioKpi(c.total, c.anterior) : null;
    const nueva = hayComp && !camb && c.total > 0;
    return { nombre, valor: c.total, texto: pesos(c.total), sub: camb ? `${camb.flecha} ${camb.texto}` : nueva ? 'nueva' : '', direccion: camb ? camb.direccion : 'igual',
      tip: `${nombre}\n${pesos(c.total)}\n${cuenta(c.piezas, 'pieza', 'piezas')} · ${un(d.totales.ventas > 0 ? (c.total * 100) / d.totales.ventas : 0)} % del total${hayComp ? `\nComparado: ${c.anterior > 0 ? pesos(c.anterior) : 'sin ventas'}` : ''}` };
  }));
}

export function tablaCategorias(d, nombreCategoria = (c) => c) {
  const hayComp = !!(d.anterior && d.anterior.tickets > 0);
  return tabla(['Categoría', 'Ventas netas', 'Piezas', '% del total', 'Comparado', 'Cambio'], d.categorias.map((c) => {
    const camb = hayComp ? cambioKpi(c.total, c.anterior) : null;
    return [nombreCategoria(c.categoria), pesos(c.total), c.piezas, `${un(d.totales.ventas > 0 ? (c.total * 100) / d.totales.ventas : 0)} %`, hayComp ? pesos(c.anterior) : '—', camb ? `${camb.flecha} ${camb.texto}` : '—'];
  }), [1, 2, 3, 4, 5]);
}
