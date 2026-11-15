// Vista «Finanzas» de /reportes (Issue #802): del JSON de /api/reportes/finanzas al HTML y las graficas.
// Funciones puras (sin DOM): las usa el servidor (src/reportes-finanzas.ts, `armarFinanzas`) y la pagina, y se prueban en
// src/reportes-finanzas.test.ts. Todo el dinero va en centavos enteros; los dias son dias de la tienda (UTC-6).
//
// Definiciones (las mismas de Resumen y del tablero de inversionistas, para que no se contradigan):
//  - Ventas netas: `lineasNetas`, igual que /api/reportes y Resumen.
//  - Gastos de operacion: GASTOS_DEL_MES (gastos capturados + retiros de caja tipo `gasto` sin fila en `gastos`, una vez cada uno) SIN la
//    categoria `inversionistas`, mas la nomina pagada (pagos y adelantos de `nomina_movimientos`), que aqui es la fila «Nomina».
//  - Pagos a inversionistas: la categoria `inversionistas`; es reparto, no gasto, y NUNCA entra al total de gastos ni al resultado.
//  - Retiros de caja sin clasificar: `retiros` tipo `retiro` sin fila en `gastos`; no se sabe que son (nomina, reparto, otra cosa), asi que
//    NUNCA se restan: se muestran aparte para que alguien los clasifique.
//  - Resultado operativo = ventas netas - gastos de operacion, ANTES del costo de la mercancia (el sistema no lo registra).
import { escapar, pesos, pesosEje, tabla, columnas, leyendaSeries, escalaNumero, sumarDias, diaCorto, diaLargo } from './graficas.js';
import { cubetas as listaCubetas, cambioKpi, etiquetaCubeta, tituloCubeta } from './reportes-resumen.js';
import { FORMAS, MAX_COLUMNAS } from './reportes-ventas.js';
import { CATEGORIAS_GASTO } from './categorias.js';

const num = (n) => Number(n).toLocaleString('es-MX');
const un = (v) => v.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).replace('-', '−');   // el menos de verdad, como el de pesos()
const cuenta = (n, uno, varios) => `${num(n)} ${n === 1 ? uno : varios}`;
const mayuscula = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const suma = (xs) => xs.reduce((s, x) => s + x, 0);

export const INVERSIONISTAS = 'inversionistas';
export const NOMINA = 'nomina';
export const SIN_CATEGORIA = 'sin_categoria';
/** Categorias de gasto que se dibujan por separado en el tiempo; el resto va junto. */
export const MAX_CATEGORIAS = 6;
/** Clave de `config` de la comision de la terminal: puntos base enteros (100 = 1 %). */
export const CLAVE_COMISION = 'comision_terminal_pct';
export const LIMITE_COMISION_BP = 2000;   // 20 %
const COLORES = ['var(--serie-1)', 'var(--serie-2)', 'var(--serie-3)', 'var(--serie-4)', 'var(--d-5)', 'var(--d-6)'];
const COLOR_OTRAS = 'var(--d-gris)';
const FORMAS_DE_DINERO = ['efectivo', 'tarjeta', 'transferencia'];

/* ---------- categorias ---------- */

const NOMBRES = new Map([...CATEGORIAS_GASTO, [NOMINA, 'Nómina'], [SIN_CATEGORIA, 'Sin categoría']]);
/** El nombre de una categoria de gasto: el de categorias.js; «nomina» y «sin categoria» no estan en esa lista. Una clave desconocida se escribe tal cual. */
export const nombreGasto = (c) => NOMBRES.get(c) ?? mayuscula(String(c).replace(/_/g, ' '));

/** Nomina primero, luego el orden de categorias.js (donde «Otros» va al final), luego las claves que no conocemos y por ultimo «Sin categoria». */
export function ordenGastos(claves) {
  const conocidas = CATEGORIAS_GASTO.map(([c]) => c).filter((c) => c !== INVERSIONISTAS);
  const lugar = (c) => (c === NOMINA ? -1 : c === SIN_CATEGORIA ? 1e6 : conocidas.includes(c) ? conocidas.indexOf(c) : 1000);
  return [...claves].sort((a, b) => lugar(a) - lugar(b) || a.localeCompare(b));
}

/* ---------- comision de la terminal ---------- */

/** Lo que la terminal se queda, estimado: ventas con tarjeta x porcentaje (puntos base). Sin porcentaje, null. */
export const comisionDe = (tarjeta, bp) => (Number.isInteger(bp) && bp > 0 ? Math.round((tarjeta * bp) / 10_000) : null);

/** El valor de `config` ya guardado -> puntos base validos, o null (sin definir o apagada con 0). */
export const bpDeConfig = (valor) => {
  const n = Number(valor);
  return valor != null && valor !== '' && Number.isInteger(n) && n > 0 && n <= LIMITE_COMISION_BP ? n : null;
};

/** «3.5», «3,50», «0» -> { bp } o { error }: de 0 a 20 % con hasta dos decimales. Sin pasar por decimales binarios. */
export function validarComisionPct(texto) {
  const t = String(texto ?? '').trim().replace(',', '.');
  if (t === '') return { error: 'Escribe un porcentaje de 0 a 20.' };
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return { error: 'Usa un porcentaje de 0 a 20 con hasta dos decimales.' };
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (bp > LIMITE_COMISION_BP) return { error: 'El porcentaje no puede pasar de 20.' };
  return { bp };
}

/** PUT /api/config: la comision solo acepta puntos base enteros de 0 a 2000 (los demas valores de config solo exigen un entero >= 0, como siempre). */
export function configInvalida(clave, valor) {
  if (clave !== CLAVE_COMISION) return false;
  const n = Number(valor);
  return valor === null || valor === '' || typeof valor === 'boolean' || !Number.isInteger(n) || n < 0 || n > LIMITE_COMISION_BP;
}

export const textoPct =(bp) => `${(bp / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;

/* ---------- el servidor: de las filas de D1 a la respuesta ---------- */

const MEDIDAS = ['ventas', 'gastos', 'inversionistas', 'sin_clasificar', 'sin_clasificar_n'];
const ceros = () => Object.fromEntries(MEDIDAS.map((m) => [m, 0]));
const sumarEn = (destino, fuente) => { if (fuente) for (const m of MEDIDAS) destino[m] += fuente[m] ?? 0; };

/**
 * Arma la respuesta de /api/reportes/finanzas. Filas de entrada (todo por dia de la tienda):
 *  - `filasVentas`: { dia, ventas };  `filasGasto`: { fecha, categoria, importe } (gastos de operacion, nomina e inversionistas juntos: aqui se separan);
 *  - `filasSinClasificar`: { dia, n, importe };  `filasPago`: { dia, forma_pago, total };  `filasCortes`: { dia, caja, hasta, diferencia };
 *  - `comisionBp`: puntos base de la comision de la terminal, o null.
 * Leen el periodo y, para comparar, la ventana de comparacion. Con `soloVentas` (una tienda elegida) no se calculan gastos, nomina,
 * retiros ni pagos a inversionistas: son del negocio completo, como en Resumen; van en null.
 */
export function armarFinanzas({ desde, hasta, grano, ventana, soloVentas = false, filasVentas, filasGasto, filasSinClasificar, filasPago, filasCortes, comisionBp }) {
  const enPeriodo = (d) => d >= desde && d <= hasta;
  const cubetas = listaCubetas(desde, hasta, grano);
  const meses = listaCubetas(desde, hasta, 'mes');
  const lugarEn = (lista) => {
    const m = new Map();
    lista.forEach((c, i) => { for (let k = 0; k < c.dias; k++) m.set(sumarDias(c.desde, k), i); });
    return m;
  };
  const enCubeta = lugarEn(cubetas), enMes = lugarEn(meses);

  const porDia = new Map();
  const dia = (d) => porDia.get(d) ?? porDia.set(d, ceros()).get(d);
  for (const f of filasVentas) dia(f.dia).ventas += f.ventas;
  const porCategoria = new Map();   // categoria -> { total, cubetas: [..], meses: [..] } (solo gastos de operacion, solo el periodo)
  if (!soloVentas) {
    for (const f of filasGasto) {
      const categoria = f.categoria || SIN_CATEGORIA;
      if (categoria === INVERSIONISTAS) { dia(f.fecha).inversionistas += f.importe; continue; }
      dia(f.fecha).gastos += f.importe;
      if (!enPeriodo(f.fecha)) continue;
      if (!porCategoria.has(categoria)) porCategoria.set(categoria, { categoria, total: 0, valores: cubetas.map(() => 0), meses: meses.map(() => 0) });
      const c = porCategoria.get(categoria);
      c.total += f.importe; c.valores[enCubeta.get(f.fecha)] += f.importe; c.meses[enMes.get(f.fecha)] += f.importe;
    }
    for (const f of filasSinClasificar) { dia(f.dia).sin_clasificar += f.importe; dia(f.dia).sin_clasificar_n += f.n; }
  }

  // Las cubetas del grano global (las de Resumen: misma funcion y mismo periodo), los totales y lo comparado.
  const totales = ceros(), anterior = ventana ? ceros() : null;
  const lista = cubetas.map((c) => {
    const fila = { ...c, ...ceros() };
    for (let k = 0; k < c.dias; k++) sumarEn(fila, porDia.get(sumarDias(c.desde, k)));
    sumarEn(totales, fila);
    return fila;
  });
  if (ventana) for (let k = 0; k < ventana.dias; k++) sumarEn(anterior, porDia.get(sumarDias(ventana.desde, k)));
  if (soloVentas) for (const x of [...lista, totales, anterior]) if (x) { x.gastos = x.inversionistas = x.sin_clasificar = x.sin_clasificar_n = null; }

  // El estado de resultados: una columna por mes calendario tocado por el periodo.
  const porMes = meses.map(() => ceros());
  for (const [d, m] of porDia) if (enPeriodo(d)) sumarEn(porMes[enMes.get(d)], m);
  const col = (f) => porMes.map(f);
  const estado = {
    ventas: col((m) => m.ventas),
    ...(soloVentas ? {} : {
      gastos: ordenGastos([...porCategoria.keys()]).map((c) => porCategoria.get(c))
        .filter((c) => c.meses.some((v) => v !== 0)).map((c) => ({ categoria: c.categoria, valores: c.meses, total: c.total })),
      total_gastos: col((m) => m.gastos), inversionistas: col((m) => m.inversionistas),
      sin_clasificar: col((m) => m.sin_clasificar), sin_clasificar_n: col((m) => m.sin_clasificar_n),
    }),
  };

  // Los gastos en el tiempo: las categorias mayores y, juntas, el resto (cada columna suma los gastos de su cubeta).
  const ordenadas = [...porCategoria.values()].sort((a, b) => b.total - a.total || a.categoria.localeCompare(b.categoria));
  const top = ordenadas.slice(0, MAX_CATEGORIAS).map(({ categoria, total, valores }) => ({ categoria, total, valores }));
  const resto = ordenadas.slice(MAX_CATEGORIAS);
  if (resto.length) {
    top.push({ categoria: 'otras', otras: resto.length, total: suma(resto.map((c) => c.total)), valores: cubetas.map((_, i) => suma(resto.map((c) => c.valores[i]))) });
  }

  // Lo cobrado por forma de pago en dinero, por cubeta (los Dolarones y otras formas estan en Ventas).
  const pagos = new Map(FORMAS_DE_DINERO.map((k) => [k, cubetas.map(() => 0)]));
  for (const f of filasPago) {
    const i = enCubeta.get(f.dia);
    if (i !== undefined && pagos.has(f.forma_pago)) pagos.get(f.forma_pago)[i] += f.total;
  }
  const pago = [...pagos].map(([clave, valores]) => ({ clave, total: suma(valores), valores }));

  // Los cortes: uno por corte, con la diferencia (contado - esperado); sobrante > 0, faltante < 0.
  const cortes = filasCortes.map((c) => ({ dia: c.dia, hasta: c.hasta, caja: c.caja, diferencia: c.diferencia }));
  const sobran = cortes.filter((c) => c.diferencia > 0), faltan = cortes.filter((c) => c.diferencia < 0);
  const efectivo = {
    cortes,
    resumen: {
      n: cortes.length, exactos: cortes.length - sobran.length - faltan.length,
      n_sobrante: sobran.length, sobrante: suma(sobran.map((c) => c.diferencia)),
      n_faltante: faltan.length, faltante: suma(faltan.map((c) => c.diferencia)),
      neto: suma(cortes.map((c) => c.diferencia)),
    },
  };

  const tarjeta = pago.find((p) => p.clave === 'tarjeta').total;
  return {
    cubetas: lista, totales, anterior,
    retiros_sin_clasificar: soloVentas ? null : { n: totales.sin_clasificar_n, importe: totales.sin_clasificar },
    meses, estado,
    gastos_tiempo: top, pago, efectivo,
    terminal: { tarjeta, comision_bp: bpDeConfig(comisionBp), comision: comisionDe(tarjeta, bpDeConfig(comisionBp)) },
  };
}

/* ---------- las tarjetas ---------- */

/** Las 6 tarjetas, con el mismo marcado y las mismas reglas de color que las de Resumen (se pintan con `tarjetasHtml` de reportes-resumen.js). */
export function tarjetasFinanzas(d) {
  const t = d.totales, a = d.anterior, sc = d.cubetas;
  const vs = d.comparar === 'mes' ? 'vs mes pasado' : 'vs anterior';
  const comparando = !!d.comparacion;
  const comunes = { vs, comparando, hayComp: true };
  const dias = d.periodo.dias;
  const solo = t.gastos == null;
  const resultado = (x) => x.ventas - x.gastos;
  const pctDe = (x) => (x.ventas > 0 ? (resultado(x) * 100) / x.ventas : null);
  const hayVentas = !!(a && a.ventas > 0);
  const delNegocio = 'Es del negocio completo: elige «Todas las tiendas»';
  const sinTienda = (clave, etiqueta) => ({ ...comunes, clave, etiqueta, valor: '—', cambio: null, serie: [], clase: 's1', pie: delNegocio });
  const ventas = { ...comunes, hayComp: hayVentas, clave: 'ventas', etiqueta: 'Ventas netas', valor: pesos(t.ventas), cambio: hayVentas ? cambioKpi(t.ventas, a.ventas) : null,
    serie: sc.map((c) => c.ventas), clase: 's1', pie: `${pesos(Math.round(t.ventas / dias))} por día` };
  if (solo) {
    return [ventas, sinTienda('gastos', 'Gastos de operación'), sinTienda('resultado', 'Resultado operativo'), sinTienda('resultado_pct', 'Resultado sobre ventas'),
      sinTienda('sin_clasificar', 'Retiros sin clasificar'), sinTienda('inversionistas', 'Pagos a inversionistas')];
  }
  const sinClasificar = t.sin_clasificar_n > 0;
  return [
    ventas,
    { ...comunes, clave: 'gastos', etiqueta: 'Gastos de operación', valor: pesos(t.gastos), cambio: a ? cambioKpi(t.gastos, a.gastos, { bueno: 'baja' }) : null,
      serie: sc.map((c) => c.gastos), clase: 's2', pie: t.ventas > 0 ? `${un((t.gastos * 100) / t.ventas)} % de las ventas netas` : 'Sin ventas en el periodo' },
    { ...comunes, clave: 'resultado', etiqueta: 'Resultado operativo', valor: pesos(resultado(t)), cambio: a ? cambioKpi(resultado(t), resultado(a), { tipo: 'abs' }) : null,
      serie: sc.map(resultado), clase: 's3', pie: `Ventas netas − gastos, antes del costo de la mercancía${sinClasificar ? ' y de los retiros sin clasificar' : ''}` },
    { ...comunes, hayComp: hayVentas, clave: 'resultado_pct', etiqueta: 'Resultado sobre ventas', valor: pctDe(t) == null ? '—' : `${un(pctDe(t))} %`,
      cambio: hayVentas && pctDe(t) != null && pctDe(a) != null ? cambioKpi(pctDe(t), pctDe(a), { tipo: 'pp' }) : null,
      serie: sc.map(pctDe), clase: 's3', pie: 'Resultado operativo ÷ ventas netas' },
    { ...comunes, clave: 'sin_clasificar', etiqueta: 'Retiros sin clasificar', valor: pesos(t.sin_clasificar), cambio: a ? cambioKpi(t.sin_clasificar, a.sin_clasificar, { bueno: 'baja' }) : null,
      serie: sc.map((c) => c.sin_clasificar), clase: 's2', pie: `${cuenta(t.sin_clasificar_n, 'retiro', 'retiros')} de caja · no se restan del resultado`,
      nota: sinClasificar ? 'Hay que clasificarlos: nómina, reparto u otra cosa' : null },
    { ...comunes, clave: 'inversionistas', etiqueta: 'Pagos a inversionistas', valor: pesos(t.inversionistas),
      cambio: a ? cambioKpi(t.inversionistas, a.inversionistas, { bueno: 'neutro' }) : null,
      serie: sc.map((c) => c.inversionistas), clase: 's1', pie: 'Reparto: no es gasto de operación' },
  ];
}

/* ---------- el estado de resultados ---------- */

const nombreMes = (dia) => new Date(`${dia.slice(0, 7)}-15T12:00:00`).toLocaleDateString('es-MX', { month: 'short' }).replace('.', '');
/** La cabecera de una columna: «oct 2026»; un mes cortado por el periodo dice sus dias: «nov 1–15». */
export function etiquetaMes(m) {
  const n = nombreMes(m.desde);
  if (!m.parcial) return `${n} ${m.desde.slice(0, 4)}`;
  const d1 = Number(m.desde.slice(8)), d2 = Number(m.hasta.slice(8));
  return m.dias === 1 ? `${n} ${d1}` : `${n} ${d1}–${d2}`;
}
export const tituloMes = (m) => `${mayuscula(new Date(`${m.desde.slice(0, 7)}-15T12:00:00`).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }))}${m.parcial ? ` (parcial: ${cuenta(m.dias, 'día', 'días')}, del ${diaCorto(m.desde)} al ${diaCorto(m.hasta)})` : ''}`;

const pctTexto = (resultado, ventas) => (ventas > 0 ? `${un((resultado * 100) / ventas)} %` : '—');

/** La nota al pie del estado: lo que el resultado NO incluye. */
export function notaEstado(d) {
  if (d.estado.total_gastos == null) return '';
  const partes = ['El resultado es antes del costo de la mercancía, que el sistema no registra, y antes de los retiros de caja sin clasificar.'];
  if (d.retiros_sin_clasificar?.n > 0) partes.push('Los retiros sin clasificar no se restan porque no se sabe qué son (nómina, reparto u otra cosa): quien los hizo debe categorizarlos en Gastos.');
  partes.push('«Otros» y «Sin categoría» son gastos que aún no tienen una categoría precisa; se muestran tal cual para que se revisen. Los pagos a inversionistas son reparto, no gasto, y van aparte.');
  return partes.join(' ');
}

/** La tabla del estado de resultados: una columna por mes calendario y «Acumulado». */
export function estadoHtml(d, nombre = nombreGasto) {
  const e = d.estado, meses = d.meses;
  const cabecera = `<tr><th>Concepto</th>${meses.map((m) => `<th class="num" title="${escapar(tituloMes(m))}">${escapar(etiquetaMes(m))}</th>`).join('')}<th class="num">Acumulado</th></tr>`;
  const fila = (clase, titulo, valores, total, fmt = pesos) => `<tr class="${clase}"><td>${titulo}</td>${valores.map((v) => `<td class="num${v < 0 ? ' neg' : ''}">${escapar(fmt(v))}</td>`).join('')}<td class="num acumulado${total < 0 ? ' neg' : ''}">${escapar(fmt(total))}</td></tr>`;
  const t = d.totales;
  const ventasFila = fila('total', 'Ventas netas', e.ventas, t.ventas);
  if (e.total_gastos == null) {
    return `<table class="tabla est-res"><thead>${cabecera}</thead><tbody>${ventasFila}
      <tr class="aparte"><td colspan="${meses.length + 2}">Los gastos, la nómina, los retiros sin clasificar y los pagos a inversionistas son de todo el negocio y no se calculan por tienda.</td></tr></tbody></table>`;
  }
  const resultado = e.ventas.map((v, i) => v - e.total_gastos[i]);
  const gastos = e.gastos.length === 0 ? `<tr class="sangria"><td colspan="${meses.length + 2}">Sin gastos en el periodo.</td></tr>`
    : e.gastos.map((g) => fila('sangria', escapar(nombre(g.categoria)), g.valores, g.total)).join('');
  return `<table class="tabla est-res"><thead>${cabecera}</thead><tbody>
    ${ventasFila}
    <tr class="grupo"><td colspan="${meses.length + 2}">Gastos de operación</td></tr>
    ${gastos}
    ${fila('total', 'Total de gastos', e.total_gastos, t.gastos)}
    ${fila('total', 'Resultado operativo', resultado, t.ventas - t.gastos)}
    <tr class="porcentaje"><td>Resultado sobre ventas</td>${resultado.map((r, i) => `<td class="num${r < 0 ? ' neg' : ''}">${escapar(pctTexto(r, e.ventas[i]))}</td>`).join('')}<td class="num acumulado${t.ventas - t.gastos < 0 ? ' neg' : ''}">${escapar(pctTexto(t.ventas - t.gastos, t.ventas))}</td></tr>
    <tr class="grupo aparte"><td colspan="${meses.length + 2}">Aparte: no se restan del resultado</td></tr>
    ${fila('aparte', `Retiros de caja sin clasificar <span class="sec">· ${escapar(cuenta(t.sin_clasificar_n, 'retiro', 'retiros'))}</span>`, e.sin_clasificar, t.sin_clasificar)}
    ${fila('aparte', 'Pagos a inversionistas', e.inversionistas, t.inversionistas)}
  </tbody></table>`;
}

/* ---------- gastos en el tiempo, formas de pago y cortes: ejes, tablas y graficas ---------- */

const ejesDe = (d) => d.cubetas.map((c) => ({ etiqueta: etiquetaCubeta(c, d.grano, d.cubetas.length), titulo: tituloCubeta(c, d.grano) }));

export const datosGastos = (d, nombre = nombreGasto) => d.gastos_tiempo.map((c, i) => ({
  nombre: c.otras ? `Otras categorías (${c.otras})` : nombre(c.categoria),
  color: c.otras ? COLOR_OTRAS : COLORES[i % COLORES.length], valores: c.valores, total: c.total,
})).filter((s) => s.total !== 0);

export const datosPago = (d) => d.pago.map((p) => {
  const [, nombre, color] = FORMAS.find(([k]) => k === p.clave);
  return { ...p, nombre, color };
});

function tablaApilada(ejes, series) {
  const enc = ['Periodo', ...series.map((s) => s.nombre), 'Total'];
  const filas = ejes.map((e, i) => [e.titulo, ...series.map((s) => pesos(s.valores[i])), pesos(series.reduce((x, s) => x + s.valores[i], 0))]);
  return tabla(enc, filas, enc.map((_, i) => i).slice(1));
}
export const tablaGastos = (d, nombre) => tablaApilada(ejesDe(d), datosGastos(d, nombre));
export const tablaPago = (d) => tablaApilada(ejesDe(d), datosPago(d));

/** Sobrante, faltante o exacto, escrito: el color y la forma de la marca nunca son lo unico que lo dice. */
export const textoDiferencia = (centavos) => (centavos === 0 ? 'Exacto' : `${centavos > 0 ? 'Sobrante' : 'Faltante'} ${pesos(Math.abs(centavos))}`);

export function tablaCortes(d) {
  let corrida = 0;
  return tabla(['Día', 'Caja', 'Diferencia', 'Suma acumulada'], d.efectivo.cortes.map((c) => {
    corrida += c.diferencia;
    return [diaCorto(c.dia), c.caja, textoDiferencia(c.diferencia), pesos(corrida)];
  }), [2, 3]);
}

export function resumenCortesHtml(d) {
  const r = d.efectivo.resumen;
  if (r.n === 0) return '';
  return `<dl class="pares"><dt>Cortes del periodo</dt><dd class="num">${num(r.n)}</dd>
    <dt>▲ Sobrante: ${cuenta(r.n_sobrante, 'corte', 'cortes')}</dt><dd class="num">${pesos(r.sobrante)}</dd>
    <dt>▼ Faltante: ${cuenta(r.n_faltante, 'corte', 'cortes')}</dt><dd class="num">${pesos(Math.abs(r.faltante))}</dd>
    <dt>● Exactos: ${cuenta(r.exactos, 'corte', 'cortes')}</dt><dd class="num">$0.00</dd>
    <dt><b>Suma de las diferencias</b></dt><dd class="num"><b>${r.neto === 0 ? '$0.00' : textoDiferencia(r.neto)}</b></dd></dl>`;
}

const leyendaCortes = () => `<div class="leyenda-series"><span>▲ Sobrante</span><span>▼ Faltante</span><span>● Exacto</span><span><i class="llave" style="background:var(--serie-1)"></i>Suma acumulada</span></div>`;
const pesosEjeConSigno = (v) => (v < 0 ? `−${pesosEje(-v)}` : pesosEje(v));

/** Una marca por corte (▲ sobrante, ▼ faltante, ● exacto) sobre el cero, y la suma acumulada de las diferencias como linea. */
export function graficaCortes(e, { ancho, alto = 250 }) {
  const cortes = e.cortes, n = cortes.length;
  if (n === 0) return '';
  const ml = 58, mr = 12, mt = 16, mb = 28;
  let corrida = 0;
  const acumulada = cortes.map((c) => (corrida += c.diferencia));
  const { tope, marcas } = escalaNumero(Math.max(1, ...cortes.map((c) => Math.abs(c.diferencia)), ...acumulada.map(Math.abs)), { objetivo: 2 });
  const pw = Math.max(40, ancho - ml - mr), ph = alto - mt - mb;
  const y = (v) => mt + ph / 2 - (v / tope) * (ph / 2);
  const slot = pw / n, x = (i) => ml + i * slot + slot / 2;
  const rejilla = [...marcas.slice(1).map((m) => -m).reverse(), ...marcas].map((m) => `
    <line class="${m === 0 ? 'eje' : 'rejilla'}" x1="${ml}" x2="${ancho - mr}" y1="${y(m)}" y2="${y(m)}"/>
    <text class="marca" x="${ml - 8}" y="${y(m) + 4}" text-anchor="end">${escapar(pesosEjeConSigno(m))}</text>`).join('');
  const marcasCorte = cortes.map((c, i) => {
    const cx = x(i), cy = y(c.diferencia), r = 4.5;
    if (c.diferencia === 0) return `<circle class="c-exacto" cx="${cx}" cy="${cy}" r="3.5"/>`;
    const sube = c.diferencia > 0, punta = sube ? cy - r : cy + r, base = sube ? cy + r - 1 : cy - r + 1;
    return `<line class="tallo ${sube ? 'c-sobra' : 'c-falta'}" x1="${cx}" x2="${cx}" y1="${y(0)}" y2="${cy}"/>
      <path class="${sube ? 'c-sobra' : 'c-falta'}" d="M${cx},${punta} L${cx - r},${base} L${cx + r},${base} Z"/>`;
  }).join('');
  const linea = `M${acumulada.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' L')}`;
  const paso = Math.max(1, Math.ceil(64 / Math.max(slot, 1)));
  const etiquetas = cortes.map((c, i) => ((n - 1 - i) % paso === 0 ? `<text class="marca" x="${x(i)}" y="${alto - 8}" text-anchor="middle">${escapar(diaCorto(c.dia))}</text>` : '')).join('');
  const zonas = cortes.map((c, i) => {
    const lineas = [`${diaLargo(c.dia)} · ${c.caja}`, textoDiferencia(c.diferencia), `Suma acumulada: ${acumulada[i] === 0 ? '$0.00' : textoDiferencia(acumulada[i])}`];
    return `<rect class="hit pasiva" x="${(ml + i * slot).toFixed(1)}" y="${mt}" width="${slot.toFixed(1)}" height="${ph}" data-tip="${escapar(lineas.join('\n'))}"
      ${n <= MAX_COLUMNAS ? 'tabindex="0"' : ''} role="img" aria-label="${escapar(lineas.join(', '))}"/>`;
  }).join('');
  return `${leyendaCortes()}<svg class="svg-grafica" width="${ancho}" height="${alto}" viewBox="0 0 ${ancho} ${alto}" role="group"
    aria-label="Diferencias de ${n} cortes, de ${escapar(diaCorto(cortes[0].dia))} a ${escapar(diaCorto(cortes[n - 1].dia))}">${rejilla}${marcasCorte}<path class="suma-corte" d="${linea}"/>${etiquetas}${zonas}</svg>`;
}

/* ---------- las graficas: { id: html } para el ancho que tenga cada hueco ---------- */

const vacio = (texto) => `<div class="vacio">${escapar(texto)}</div>`;
const demasiadas = (n) => `<div class="vacio">Con ${num(n)} columnas la gráfica no se lee: elige «Semana» o «Mes» arriba. La tabla tiene todo.</div>`;

export function graficas(d, anchoDe, nombre = nombreGasto) {
  const ancho = (id) => Math.max(220, Math.floor(anchoDe(id)));
  const ejes = ejesDe(d), n = ejes.length;
  const apilar = (id, series, sinDatos) => {
    if (series.length === 0 || series.every((s) => s.valores.every((x) => x === 0))) return vacio(sinDatos);
    if (n > MAX_COLUMNAS) return demasiadas(n);
    return `${leyendaSeries(series)}${columnas({ categorias: ejes, series, ancho: ancho(id), modo: 'apiladas', fmtEje: pesosEje, fmtValor: pesos })}`;
  };
  return {
    gastos: d.totales.gastos == null ? vacio('Los gastos son del negocio completo: elige «Todas las tiendas».') : apilar('gastos', datosGastos(d, nombre), 'Sin gastos en este periodo.'),
    pago: apilar('pago', datosPago(d).filter((p) => p.total !== 0), 'Sin cobros en este periodo.'),
    cortes: d.efectivo.cortes.length === 0 ? vacio('Sin cortes en este periodo.') : graficaCortes(d.efectivo, { ancho: ancho('cortes') }),
  };
}

/* ---------- textos ---------- */

export function notaGastos(d) {
  if (d.totales.gastos == null) return '';
  const otras = d.gastos_tiempo.find((c) => c.otras);
  return `Las ${MAX_CATEGORIAS} categorías con más gasto en el periodo${otras ? `; las otras ${num(otras.otras)} van juntas` : ''}. Sin pagos a inversionistas, que no son gasto de operación.`;
}

/** La comision estimada de la terminal, o (sin porcentaje) una sola linea que dice que se puede definir. */
export function comisionHtml(d) {
  const t = d.terminal;
  if (t.comision == null) return '<p class="nota">Opcional: abajo puedes capturar el porcentaje que cobra la terminal para ver una comisión estimada.</p>';
  return `<dl class="pares"><dt>Cobrado con tarjeta en el periodo</dt><dd class="num">${pesos(t.tarjeta)}</dd>
    <dt>Comisión estimada de la terminal (${textoPct(t.comision_bp)})</dt><dd class="num"><b>${pesos(t.comision)}</b></dd></dl>
    <p class="nota">Es una estimación (lo cobrado con tarjeta × el porcentaje), no un dato de la terminal. No se suma a los gastos ni al resultado: si ya registras la comisión como gasto, contarla aquí la duplicaría.</p>`;
}
