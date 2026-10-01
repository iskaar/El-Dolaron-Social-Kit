/**
 * Aritmetica de la caja, en centavos enteros.
 * Es la unica parte del sistema donde un error se paga en efectivo, delante del
 * cliente y sin poder corregirlo despues. Vive en public/ porque la caja la usa
 * en el navegador; las pruebas la importan desde aqui.
 */

/** Tope de un descuento, en % del ticket (decision de Isaac del 28/09, Issue #119). */
export const TOPE_DESCUENTO = 50;

/**
 * Cuanto se descuenta, en centavos, para un descuento pedido ({ tipo, valor }:
 * 'porcentaje' con valor en % entero, o 'monto' con valor en centavos) sobre un
 * ticket de `subtotal` centavos. La usan la caja (para mostrar) y el servidor
 * (para cobrar): ninguno acepta lo que el otro rechazaria.
 */
export function descuentoDe({ tipo, valor }, subtotal) {
  if (!Number.isInteger(subtotal) || subtotal <= 0) return { error: 'El ticket esta vacio.' };
  if (tipo !== 'porcentaje' && tipo !== 'monto') return { error: 'Tipo de descuento invalido.' };
  if (!Number.isInteger(valor) || valor < 1) {
    return { error: tipo === 'porcentaje' ? 'El porcentaje debe ser un entero.' : 'El monto debe ser mayor a cero.' };
  }
  const monto = tipo === 'porcentaje' ? Math.floor((subtotal * valor) / 100) : valor;
  if (monto < 1) return { error: 'El descuento es menor a un centavo.' };
  if (monto * 100 > subtotal * TOPE_DESCUENTO) return { error: `El descuento no puede pasar de ${TOPE_DESCUENTO}% del ticket.` };
  return { monto };
}

/**
 * `dolarones` es la parte del total pagada con Dolarones: el efectivo se compara
 * contra el resto. `descuento` ya viene aprobado y en centavos: `total` es lo
 * que vale el ticket despues de restarlo.
 */
export function totales(lineas, efectivo = 0, dolarones = 0, descuento = 0) {
  const piezas = lineas.reduce((suma, l) => suma + l.cantidad, 0);
  const subtotal = lineas.reduce((suma, l) => suma + l.precio * l.cantidad, 0);
  const total = subtotal - descuento;
  const aPagar = total - dolarones;
  const diferencia = efectivo - aPagar;
  return {
    piezas,
    subtotal,
    descuento,
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
export function dolaronesGanados(pagado) {
  return Math.floor(Math.max(0, pagado) / 10000) * 1000;
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
