/**
 * Aritmetica de la caja, en centavos enteros.
 * Es la unica parte del sistema donde un error se paga en efectivo, delante del
 * cliente y sin poder corregirlo despues. Vive en public/ porque la caja la usa
 * en el navegador; las pruebas la importan desde aqui.
 */

/** `dolarones` es la parte del total pagada con Dolarones: el efectivo se compara contra el resto. */
export function totales(lineas, efectivo = 0, dolarones = 0) {
  const piezas = lineas.reduce((suma, l) => suma + l.cantidad, 0);
  const total = lineas.reduce((suma, l) => suma + l.precio * l.cantidad, 0);
  const aPagar = total - dolarones;
  const diferencia = efectivo - aPagar;
  return {
    piezas,
    total,
    aPagar,
    cambio: Math.max(0, diferencia),
    falta: Math.max(0, -diferencia),
  };
}

/**
 * 10 D por cada bloque completo de $100 pagado en dinero (decision de Isaac del
 * 26/09): $99 no gana, $250 gana 20. Lo pagado con Dolarones no cuenta. En
 * centavos, igual que todo: 1 D = 100.
 */
export function dolaronesGanados(pagado, tasa = 10) {
  return Math.floor(Math.max(0, pagado) / 10000) * tasa * 100;
}

/** Ticket minimo ANTES de descontar Dolarones para usar regalos de apertura. */
export const MINIMO_REGALO = 1000_00;

/** El saldo ganado por compras no tiene este minimo. Todo en centavos. */
export function saldoCanjeable(socio, total) {
  if (!socio) return 0;
  return total >= MINIMO_REGALO ? socio.disponible : Math.max(0, socio.disponible - socio.regalo_disponible);
}

/** «Usar máximo»: respeta ticket, saldo elegible, autorización y vencimiento. */
export function maximoCanje(socio, total, ahora = Date.now()) {
  if (!socio || !Number.isSafeInteger(socio.maximo) || !(Date.parse(socio.expira_en) > ahora)) return 0;
  return Math.max(0, Math.min(total, saldoCanjeable(socio, total), socio.maximo));
}

/** Agrega una pieza al ticket, juntando lineas repetidas del mismo codigo. */
export function agregar(lineas, pieza) {
  const existente = lineas.find((l) => l.codigo === pieza.codigo && l.precio === pieza.precio);
  if (existente) {
    return lineas.map((l) => (l === existente ? { ...l, cantidad: l.cantidad + 1 } : l));
  }
  return [...lineas, { ...pieza, cantidad: 1 }];
}

/**
 * Efectivo vacio (sin escribir nada) llega como 0, igual que efectivo puesto a
 * proposito en cero: sin esta funcion la caja los trataba distinto y dejaba
 * cobrar en efectivo sin dinero de por medio. La usan la caja y el servidor,
 * para que ninguno acepte lo que el otro rechazaria.
 */
export function efectivoAlcanza({ formaPago, total, efectivo }) {
  return formaPago !== 'efectivo' || efectivo >= total;
}

/**
 * Billetes y monedas del corte (Issue #100), en centavos. El de $20 cuenta
 * igual si es billete o moneda.
 */
export const DENOMINACIONES = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50];

/**
 * Lo contado en el corte a partir de cuantas piezas hay de cada denominacion.
 * null si algo no es valido: la caja no deja enviarlo y el servidor lo rechaza.
 * @param {Record<string, number>} conteo piezas por denominacion, con la denominacion en centavos como llave
 */
export function contadoDe(conteo) {
  let suma = 0;
  for (const [denominacion, piezas] of Object.entries(conteo ?? {})) {
    if (!DENOMINACIONES.includes(Number(denominacion))) return null;
    if (!Number.isInteger(piezas) || piezas < 0 || piezas > 10000) return null;
    suma += Number(denominacion) * piezas;
  }
  return suma;
}
