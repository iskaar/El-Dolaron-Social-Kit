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
 * Promo de inauguracion (Isaac, 9/10, Issue #263): 10% directo del subtotal, sin
 * minimo, una vez por ticket, al centavo. Las fechas vienen del servidor
 * (PROMO_DESDE/PROMO_HASTA): sin ellas no hay promo. Se suma a un descuento
 * aprobado y se siguen ganando y usando Dolarones y vales. La usan la caja (para
 * mostrar) y el servidor (para cobrar), con la hora de la venta.
 * @param {{ desde: string, hasta: string } | null} promo
 */
export const PROMO_PORCENTAJE = 10;

export function promoInauguracion(subtotal, momento, promo) {
  if (!promo) return 0;
  const desde = Date.parse(promo.desde), hasta = Date.parse(promo.hasta);
  return momento >= desde && momento < hasta ? Math.round(subtotal * PROMO_PORCENTAJE / 100) : 0;
}

/**
 * Minutos de desfase del reloj de la caja contra el del servidor (cabecera Date):
 * positivo adelantado, negativo atrasado, 0 si dentro de 10 min o ilegible.
 */
export function desfaseReloj(ahora, fechaServidor) {
  const servidor = Date.parse(fechaServidor);
  if (!Number.isFinite(servidor) || Math.abs(ahora - servidor) <= 10 * 60_000) return 0;
  return Math.round((ahora - servidor) / 60_000);
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
