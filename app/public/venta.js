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
 * Promo de gran inauguracion (Isaac, 23/10, Issue #487; mecanica de #250): $100 de
 * descuento si el subtotal es de $300 o mas, una vez por ticket. Las fechas vienen del servidor
 * (PROMO_DESDE/PROMO_HASTA): sin ellas no hay promo. Se suma a un descuento
 * aprobado y se siguen ganando y usando Dolarones y vales. La usan la caja (para
 * mostrar) y el servidor (para cobrar), con la hora de la venta.
 * @param {{ desde: string, hasta: string } | null} promo
 */
export const PROMO_DESCUENTO = 10000;
export const PROMO_MINIMO = 30000;

export function promoInauguracion(subtotal, momento, promo) {
  if (!promo) return 0;
  const desde = Date.parse(promo.desde), hasta = Date.parse(promo.hasta);
  return momento >= desde && momento < hasta && subtotal >= PROMO_MINIMO ? PROMO_DESCUENTO : 0;
}

/** Letrero de la caja (Isaac, 24/10): cuántas promos quedan mientras la ventana está abierta; '' fuera de ella. */
export function letreroPromo(promo, momento) {
  if (!promoInauguracion(PROMO_MINIMO, momento, promo)) return '';
  const monto = `$${PROMO_DESCUENTO / 100}`;
  if (promo.restantes == null) return `Promo ${monto} activa`;
  return promo.restantes > 0 ? `Promos de ${monto}: quedan ${promo.restantes}` : `Promo de ${monto} agotada`;
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
 * que vale el ticket despues de restarlo. `anticipo` es la parte pagada con el
 * saldo de un pedido (Issue #269): tambien sale de lo que se cobra ahora.
 */
export function totales(lineas, efectivo = 0, dolarones = 0, descuento = 0, anticipo = 0) {
  const piezas = lineas.reduce((suma, l) => suma + l.cantidad, 0);
  const subtotal = lineas.reduce((suma, l) => suma + l.precio * l.cantidad, 0);
  const total = subtotal - descuento;
  const aPagar = total - dolarones - anticipo;
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
 * Cuanto del saldo de un pedido se aplica a este ticket (Issue #269): todo el saldo
 * o lo que falte tras los Dolarones, lo que sea menos. El servidor exige lo mismo
 * (anticipo <= total - dolarones).
 */
export function anticipoDePedido(saldo, total, dolarones = 0) {
  return Math.max(0, Math.min(saldo, total - dolarones));
}

/** Apartados (#662): $100 fijos, se recoja o se envíe; si las piezas cuestan menos, se paga el total. */
export const ANTICIPO = 100_00;
export const ANTICIPO_ENVIO = ANTICIPO;   // alias para importadores existentes
export const anticipoMinimoDe = (subtotal) => Math.min(subtotal, ANTICIPO);   // la entrega ya no cambia el mínimo
export const ENVIO_COSTO = 99_00;
export const ENVIO_GRATIS_DESDE = 1000_00;
export const envioDe = (subtotal) => (subtotal > 0 && subtotal < ENVIO_GRATIS_DESDE ? ENVIO_COSTO : 0);

/**
 * Clave de rastreo SPEI (#593, paso 1). El cajero la copia del comprobante del cliente. En caja se pide
 * desde $300 de transferencia; en apartados, envios y pagos de revendedora, siempre.
 * Banxico acepta hasta 30 caracteres alfanumericos; el minimo de 6 solo frena capturas como «ok» o «123».
 */
export const CLAVE_DESDE = 300_00;
export const CLAVE_RASTREO = /^[A-Z0-9]{6,30}$/;
/** Mayusculas y sin espacios (los comprobantes la parten en renglones). */
export const claveRastreoDe = (texto) => String(texto ?? '').replace(/\s+/g, '').toUpperCase();
const dinero = (centavos) => `$${(centavos / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Valida lo que el cajero capturo de una transferencia (centavos enteros) contra lo que se cobra por
 * ese medio. Menos que lo debido se rechaza; mas se acepta y el excedente se resuelve a mano.
 * La usan la pantalla y el servidor: ninguno acepta lo que el otro rechazaria.
 * @param {{ clave: unknown, transferido: number, debido: number }} datos
 * @returns {{ ok: false, campo: 'clave' | 'monto', error: string }
 *   | { ok: true, clave: string, transferido: number, aplicado: number, excedente: number }}
 */
export function transferenciaDe({ clave, transferido, debido }) {
  const normalizada = claveRastreoDe(clave);
  if (!normalizada) return { ok: false, campo: 'clave', error: 'Escribe la clave de rastreo que viene en el comprobante del cliente.' };
  if (!CLAVE_RASTREO.test(normalizada))
    return { ok: false, campo: 'clave', error: 'La clave de rastreo lleva de 6 a 30 letras y números, sin acentos, guiones ni símbolos.' };
  if (!Number.isSafeInteger(transferido) || transferido <= 0)
    return { ok: false, campo: 'monto', error: 'Escribe el monto que dice el comprobante del cliente.' };
  if (transferido < debido)
    return { ok: false, campo: 'monto', error: `El comprobante dice ${dinero(transferido)} y se cobran ${dinero(debido)}. Pídele al cliente que transfiera lo que falta (${dinero(debido - transferido)}).` };
  return { ok: true, clave: normalizada, transferido, aplicado: debido, excedente: transferido - debido };
}

/**
 * Banco de donde sale la transferencia (#603): el CEP de Banxico lo pide. Codigo SPEI de 5 digitos = 40 (banco) o 90
 * (fintech) + el codigo de 3 digitos de la CLABE. La PC de la caja revisa cada codigo contra el catalogo de Banxico
 * (tools/cep_verificar.py --catalogo); uno que Banxico no conozca nunca se consulta. «otro» = no se verifica sola.
 */
export const BANCOS = [
  ['40012', 'BBVA México'], ['40014', 'Santander'], ['40072', 'Banorte'], ['40002', 'Citibanamex'], ['40021', 'HSBC'],
  ['40044', 'Scotiabank'], ['40036', 'Inbursa'], ['40058', 'Banregio'], ['40062', 'Afirme'], ['40030', 'BanBajío'],
  ['40127', 'Azteca'], ['40137', 'BanCoppel'], ['40167', 'Hey Banco'], ['40042', 'Mifel'],
  ['90638', 'Nu México'], ['90722', 'Mercado Pago'], ['90646', 'STP'], ['90661', 'Klar'], ['90728', 'Spin by OXXO'],
];
/** Codigo del banco de lo capturado: '' u «otro» = null (no se verifica sola); un codigo que no esta en la lista = undefined. */
export const bancoDe = (valor) => {
  const texto = String(valor ?? '').trim();
  if (texto === '' || texto === 'otro') return null;
  return BANCOS.some(([codigo]) => codigo === texto) ? texto : undefined;
};

/** Viernes en fecha de tienda (YYYY-MM-DD); el jueves a las 20:00 ya pasó el corte. UTC-6 fijo. */
export function viernesDeEnvio(instante) {
  const local = new Date(new Date(instante).getTime() - 6 * 3_600_000);
  const dia = local.getUTCDay();
  let dias = (5 - dia + 7) % 7;
  if (dia === 5 || (dia === 4 && local.getUTCHours() >= 20)) dias += 7;
  local.setUTCDate(local.getUTCDate() + dias);
  return local.toISOString().slice(0, 10);
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
export function agregar(lineas, pieza, cantidad = 1) {
  const existente = lineas.find((l) => l.codigo === pieza.codigo && l.precio === pieza.precio);
  if (existente) {
    return lineas.map((l) => (l === existente ? { ...l, cantidad: l.cantidad + cantidad } : l));
  }
  return [...lineas, { ...pieza, cantidad }];
}

/**
 * «3*» antes de escanear agrega 3 piezas (Issue #358): "3*ED-000123", "3*123".
 * Sin prefijo la cantidad es 1. null = prefijo que no es 1 a 99.
 */
export function leerMultiplicador(texto) {
  const m = /^\s*(\d+)\s*\*\s*(.*)$/.exec(texto);
  if (!m) return { cantidad: 1, codigo: texto };
  const cantidad = Number(m[1]);
  return cantidad >= 1 && cantidad <= 99 ? { cantidad, codigo: m[2] } : null;
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
