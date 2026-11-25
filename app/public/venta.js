/**
 * Aritmetica de la caja, en centavos enteros.
 * Es la unica parte del sistema donde un error se paga en efectivo, delante del
 * cliente y sin poder corregirlo despues. Vive en public/ porque la caja la usa
 * en el navegador; las pruebas la importan desde aqui.
 */

/** Tope de un descuento, en % del ticket (decision de Isaac del 28/09, Issue #119). */
export const TOPE_DESCUENTO = 50;
/** Lo que puede pedir un cajero (Issue #845, decision de Isaac del 16/11); mas, hasta el tope, solo el dueño. */
export const TOPE_DESCUENTO_CAJERO = 10;
/** Un descuento aprobado, o uno pendiente, vale 30 minutos (Issue #845). */
export const VIGENCIA_DESCUENTO_MS = 30 * 60_000;
/** Cuanto vive un ticket en curso en la caja; tambien lo mas atras que el servidor acepta la hora de una venta con descuento (Issue #845). */
export const TICKET_VIGENTE_MS = 4 * 3600_000;

/**
 * Cuanto se descuenta, en centavos, para un descuento pedido ({ tipo, valor }:
 * 'porcentaje' con valor en % entero, o 'monto' con valor en centavos) sobre un
 * ticket de `subtotal` centavos. La usan la caja (para mostrar) y el servidor
 * (para cobrar): ninguno acepta lo que el otro rechazaria. `tope` es el % maximo que aplica a quien pide.
 */
export function descuentoDe({ tipo, valor }, subtotal, tope = TOPE_DESCUENTO) {
  if (!Number.isInteger(subtotal) || subtotal <= 0) return { error: 'El ticket esta vacio.' };
  if (tipo !== 'porcentaje' && tipo !== 'monto') return { error: 'Tipo de descuento invalido.' };
  if (!Number.isInteger(valor) || valor < 1) {
    return { error: tipo === 'porcentaje' ? 'El porcentaje debe ser un entero.' : 'El monto debe ser mayor a cero.' };
  }
  const monto = tipo === 'porcentaje' ? Math.floor((subtotal * valor) / 100) : valor;
  if (monto < 1) return { error: 'El descuento es menor a un centavo.' };
  if (monto * 100 > subtotal * tope) return { error: `El descuento no puede pasar de ${tope}% del ticket.` };
  return { monto };
}

/**
 * La huella de un ticket (Issue #845): piezas y cantidades mas el subtotal. Un descuento se pide para una
 * huella y solo vale para esa; la calculan la caja (al pedirlo) y el servidor (al pedirlo y al cobrar).
 */
export function huellaTicket(lineas, subtotal) {
  const piezas = new Map();
  for (const l of lineas) piezas.set(String(l.producto_id), (piezas.get(String(l.producto_id)) ?? 0) + Number(l.cantidad));
  return `${[...piezas].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, n]) => `${id}:${n}`).join(',')}|${subtotal}`;
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

/**
 * Buen Fin (Isaac, 13/11, Issue #772): del 14 al 17/11 la mercancia general va a 30 % y la ropa a 20 %. Se aplica al
 * PRECIO de cada pieza (no al ticket), asi una devolucion regresa lo que se pago por esa pieza. La ventana
 * viene del servidor (BUENFIN_DESDE/BUENFIN_HASTA): sin ella no hay descuento. El precio baja a peso entero
 * (nunca se da menos del % anunciado); un precio de 0 se queda en 0 y nunca baja de $1. La usan la caja
 * (para mostrar) y el servidor (para cobrar), con la hora de la venta.
 * @param {{ desde: string, hasta: string } | null} ventana
 */
export const BUENFIN_PORCENTAJE = 30;
export const BUENFIN_PORCENTAJE_ROPA = 20;
// Producto del envio: nunca lleva descuento.
export const ENVIO_ID = '00000000-0000-4000-8000-000000000099';

/**
 * «Sin etiqueta» (Issue #880): producto fijo (migracion 086) para cobrar una pieza que no tiene etiqueta ni banda. Es la UNICA
 * linea cuyo precio y descripcion escribe la caja y el servidor acepta (prepararLineas): de $1 a $20,000, centavos enteros.
 */
export const LIBRE_ID = '00000000-0000-4000-8000-000000000098';
export const LIBRE_PRECIO_MIN = 100;
export const LIBRE_PRECIO_MAX = 2_000_000;
export const LIBRE_DESCRIPCION_MAX = 40;
/** Lo que es la pieza, en una linea de 1 a 40 letras sin saltos ni comillas raras; null si no sirve. La usan la caja y el servidor. */
export function descripcionLibre(texto) {
  if (typeof texto !== 'string') return null;
  const t = texto.replace(/[\u0000-\u001f\u007f<>"`]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length >= 1 && t.length <= LIBRE_DESCRIPCION_MAX ? t : null;
}

export function precioBuenFin(precio, categoria, momento, ventana) {
  if (!ventana || !Number.isInteger(precio) || precio <= 0) return precio;
  if (!(momento >= Date.parse(ventana.desde) && momento < Date.parse(ventana.hasta))) return precio;
  const pagado = 100 - (categoria === 'ropa' ? BUENFIN_PORCENTAJE_ROPA : BUENFIN_PORCENTAJE);
  return Math.min(precio, Math.max(100, Math.floor((precio * pagado) / 10000) * 100));
}

/** Letrero de la caja mientras corre el Buen Fin; '' fuera de la ventana. */
export const letreroBuenFin = (ventana, momento) =>
  precioBuenFin(10000, '', momento, ventana) < 10000
    ? `Descuento: ${BUENFIN_PORCENTAJE} % · ropa ${BUENFIN_PORCENTAJE_ROPA} %` : '';

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
 * Con transferencia el comprobante es la unica fuente del importe (#875): se recibe lo que dice, hasta `maximo` (el total del
 * apartado o lo que falta del pedido) y nunca menos que `minimo`; si el comprobante dice menos que el minimo, `transferenciaDe`
 * lo rechaza con su aviso de siempre. En envio `maximo` es el minimo: el paquete abre con el minimo. Centavos enteros.
 */
export const importeDeComprobante = (transferido, maximo = Infinity, minimo = 0) =>
  Math.max(minimo, Math.min(maximo, Number.isSafeInteger(transferido) && transferido > 0 ? transferido : 0));

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

/**
 * ¿Preguntar por el socio antes de cobrar? (#730) Sí si la venta no tiene socio real (ninguno, o solo vale de papel)
 * y hay red: sin red no se pueden buscar socios.
 */
export const debePreguntarSocio = (socio, enLinea) => !!enLinea && (!socio || !!socio.vale);

/**
 * Mensaje que `/socios?incrustado=1` manda a la caja (#820). Solo viaja el número de socio: ningún dato personal.
 * Devuelve `{ tipo: 'alta', numero }`, `{ tipo: 'cerrar' }` o null si no es de la forma esperada.
 */
export function leerMensajeAlta(datos) {
  if (datos?.tipo === 'alta-socio' && Number.isSafeInteger(datos.numero) && datos.numero > 0) return { tipo: 'alta', numero: datos.numero };
  if (datos?.tipo === 'alta-llegada') return { tipo: 'llegada' };
  if (datos?.tipo === 'alta-cerrar') return { tipo: 'cerrar' };
  return null;
}

/**
 * Guía para la cajera cuando hay vale(s) en el ticket y el cliente quiere ser socio (#758). Los vales no se
 * juntan con una membresía; solo uno de compra, completo, sin usar y vigente (`completo`, lo dice el servidor)
 * puede pasar a una cuenta (bases, punto 6 ter). '' si no hay vales.
 */
export function guiaVale(vales, ahora = Date.now()) {
  if (!vales?.length) return '';
  const pasa = (v) => !!v.completo && Date.parse(v.expira_en) > ahora;
  const plural = vales.length > 1;
  if (vales.every(pasa))
    return `${plural ? 'Son vales' : 'Es un vale'} de compra completo${plural ? 's' : ''} y sin usar: el cliente puede escanear su QR con su celular,`
      + ' entrar o registrarse, y el vale pasa a su cuenta al doble (10 D por cada $100 en vez de 5; hasta 2 vales por semana).'
      + ' Después se le busca como socio con su código y paga con los Dolarones de su cuenta.';
  if (!vales.some(pasa))
    return `${plural ? 'Son cupones o vales usados' : 'Es un cupón o un vale usado'} en parte: no se pueden pasar a una cuenta.`
      + ' El cliente puede usarlo hoy sin ser socio (esta compra no acumula Dolarones) o registrarse y guardarlo para otra compra antes de que venza.';
  return 'Un vale de compra completo y sin usar puede pasarse a la cuenta del cliente desde su celular (QR); un cupón o un vale usado en parte, no.'
    + ' Esos se usan hoy sin socio o se guardan para otra compra antes de que venzan.';
}

/** Agrega una pieza al ticket, juntando lineas repetidas del mismo codigo. */
export function agregar(lineas, pieza, cantidad = 1) {
  // «Sin etiqueta» (#880): cada una es su propio renglon aunque coincidan codigo y precio (la descripcion distingue la pieza).
  const existente = pieza.libre ? undefined : lineas.find((l) => l.codigo === pieza.codigo && l.precio === pieza.precio);
  if (existente) {
    return lineas.map((l) => (l === existente ? { ...l, cantidad: l.cantidad + cantidad } : l));
  }
  return [...lineas, { ...pieza, cantidad }];
}

/**
 * #931: agrega como `agregar` y sella el renglón tocado con `tocada` (ms; siempre mayor que la de los demás) para mostrarlo primero en pantalla.
 * Es solo un dato de pantalla: lo que se manda al servidor y se imprime se arma campo por campo en la caja y no lo lleva.
 */
export function agregarYMarcar(lineas, pieza, cantidad = 1, ahora = Date.now()) {
  const nuevas = agregar(lineas, pieza, cantidad);
  const tocado = nuevas.findIndex((l, i) => l !== lineas[i]);   // `agregar` conserva los renglones que no toca: el distinto es el nuevo o el que sumó
  const sello = Math.max(ahora, ...lineas.map((l) => (l.tocada ?? 0) + 1));
  return nuevas.map((l, i) => (i === tocado ? { ...l, tocada: sello } : l));
}

/**
 * #931: qué muestra «Avisos» y qué cuenta su número rojo. Lo que pide atención (`rojos`, más una falla de impresión del ticket y las ventas
 * rechazadas, que se dibujan aparte) suma; las promos (`informativos`) se listan pero no suman. `s` es el estado de las señales de la
 * caja y `t` lo que dice la pantalla (textos de promo, impresora, ventas por subir y reloj).
 */
export function resumenAvisos(s, t) {
  const rojos = [
    ...(s.servidor ?? []).map((texto) => ({ texto, enlace: '/avisos' })),
    ...(s.impresora === 'rojo' ? [{ texto: t.impresora }] : []),
    ...(s.subir === 'rojo' ? [{ texto: t.subir }] : []),
    ...(s.reloj ? [{ texto: t.reloj }] : []),
  ];
  const informativos = [
    ...(t.promo ? [{ texto: t.promo, dorado: true }] : []),
    ...(t.buenfin ? [{ texto: t.buenfin }] : []),
  ];
  const total = rojos.length + (t.fallaImpresion ? 1 : 0) + (s.rechazadas ?? 0);
  return { rojos, informativos, total };
}

/**
 * #931: en qué orden se DIBUJA el ticket en pantalla: lo último escaneado arriba. Devuelve índices de `lineas`, que no se reordena:
 * el orden de lo que se envía y se imprime es el de siempre (el de captura).
 */
export function ordenEnPantalla(lineas) {
  return lineas.map((_, i) => i).sort((a, b) => ((lineas[b].tocada ?? 0) - (lineas[a].tocada ?? 0)) || b - a);
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

/** Billetes de MXN en centavos: $20, $50, $100, $200, $500 y $1,000. */
export const BILLETES = [2000, 5000, 10000, 20000, 50000, 100000];

/**
 * Botones rápidos del «Efectivo recibido» (#830): «Exacto» (lo que se debe) y hasta 3 billetes mayores, en centavos.
 * Caben en una sola fila del panel de la caja.
 * Solo llenan el campo; quien cobra es el botón de cobro. Sin nada que pagar no hay botones.
 * @returns {{ centavos: number, exacto: boolean }[]}
 */
export function montosRapidos(aPagar) {
  if (!Number.isInteger(aPagar) || aPagar <= 0) return [];
  return [{ centavos: aPagar, exacto: true },
    ...BILLETES.filter((b) => b > aPagar).slice(0, 3).map((centavos) => ({ centavos, exacto: false }))];
}

/** Lo que un comprobante puede pasar de lo que se debe antes de que la caja pida revisarlo (#830): $5,000. Solo la pantalla; el servidor acepta el excedente. */
export const EXCEDENTE_MAXIMO = 5000_00;
export const montoTransferidoRazonable = (transferido, debido) => transferido <= debido + EXCEDENTE_MAXIMO;

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

/* ---------- Avisos y teclado de la caja (#817): lógica pura, para probarla sin pantalla ---------- */

/**
 * ¿Lo escrito en el campo de escaneo es texto para buscar por nombre («bufanda», «juguetes 50») y no algo que pueda ser un código?
 * Un código es solo dígitos (etiqueta, lector), ED-…, P-17, DC-/DP-… , BU-…, una banda (una o dos letras y el monto: JU50, R20)
 * o el QR de un vale (una URL); un «3*» antes no cambia lo que es.
 */
export function esBusquedaPorTexto(texto) {
  const t = (leerMultiplicador(texto)?.codigo ?? texto).trim();
  return /\p{L}/u.test(t) && !/^(ED-|P-?\d+$|D[CP]-|BU-|[a-z]{1,2}\d+$|https?:\/\/)/i.test(t);
}

/**
 * Por qué no entra la pieza al ticket; '' si sí entra. `stock` es la existencia de esta tienda, `enTicket` lo que ya
 * hay de ella en el ticket y `cantidad` lo que se quiere agregar.
 */
export function avisoExistencia(nombre, stock, enTicket, cantidad) {
  if (stock - enTicket >= cantidad) return '';
  if (enTicket > 0 && stock <= 1) return `${nombre} ya está en este ticket.`;
  if (enTicket > 0 || (cantidad > 1 && stock > 0)) return `${nombre}: solo hay ${stock} en existencia.`;
  return `${nombre} ya se vendió, está apartada o no está en esta tienda. Si es de un pedido, escanea su folio (P-…).`;
}

/**
 * #884: el aviso de «sin existencia aquí» con lo que contesta el servidor (GET /api/existencia): `{ tiendas, bulto, apartada }`, solo nombres de
 * tienda. El primero que aplique; sin nada, ya no hay en ninguna. Reemplaza el aviso inmediato de `avisoExistencia` cuando llega la respuesta.
 * Una pieza con varias unidades puede estar apartada o en un bulto y además tener otras en una tienda: se dice también.
 */
export function avisoDondeHay(nombre, { tiendas = [], bulto = null, apartada = null } = {}) {
  const hay = tiendas.join(' y ');
  const tambien = hay ? ` También hay en ${hay}.` : '';
  if (apartada) return `${nombre} está apartada en ${apartada}. Si el cliente viene por ella, escanea ese folio.${tambien}`;
  if (bulto?.aqui) return `${nombre} viene en el bulto ${bulto.folio}. Recíbelo en «Bultos» y escanéala otra vez.${tambien}`;
  if (bulto) return `${nombre} va en el bulto ${bulto.folio} a ${bulto.destino}. No está en esta tienda.${tambien}`;
  if (hay) return `${nombre} no está en esta tienda. Hay en ${hay}. Si el cliente la quiere, apártala en «Apartados».`;
  return `${nombre}: ya no hay en ninguna tienda.`;
}

/**
 * «La tengo en la mano» (#832): la pieza que el cliente trae y la caja da por vendida. Los tres motivos de un toque (el servidor los
 * guarda tal cual en el rastro) y la regla de cuándo se ofrece: pieza con etiqueta y precio, de inventario, no caducada, sin existencia
 * en esta tienda y que aún no está en el ticket. Es la misma situación del último mensaje de `avisoExistencia`.
 */
export const MOTIVOS_EN_MANO = {
  otra_etiqueta: 'Tiene otra etiqueta igual',
  devuelta_o_apartada: 'Estaba devuelta o apartada',
  no_se: 'No sé',
};
export const SIN_RED_EN_MANO = 'Sin red: no se puede vender una pieza sin existencia.';
export const puedeVenderEnMano = (pieza, enTicket) =>
  !pieza.sin_inventario && pieza.estado_fisico !== 'caducado' && !!pieza.codigo && pieza.precio > 0 && pieza.stock <= 0 && enTicket === 0;

/** Sugerencia resaltada tras una flecha (-1 = ninguna). Arriba desde la primera vuelve a «ninguna»: Enter entonces es el del lector. */
export const moverSugerencia = (actual, total, tecla) =>
  total <= 0 ? -1 : tecla === 'ArrowDown' ? Math.min(actual + 1, total - 1) : Math.max(actual - 1, -1);

/** «Cancelar venta» (y doble Esc) pide un segundo toque si se perdería trabajo: descuento aprobado, pedido cargado o 3 piezas o más. */
export const cancelarPideConfirmar = ({ piezas, descuentoAprobado, pedido }) =>
  piezas > 0 && (!!descuentoAprobado || !!pedido || piezas >= 3);

/** «1 venta» / «2 ventas». */
export const nVentas = (n) => `${n} ${n === 1 ? 'venta' : 'ventas'}`;

/** Por qué el corte no puede seguir si algo no llegó al servidor; '' si puede. Sin red y sin cola no hay «0 ventas»: es la red. */
export function avisoCorteSinEnviar(pendientes, enLinea) {
  if (pendientes) return `Hay ${nVentas(pendientes)} sin sincronizar. Espera a tener red antes del corte.`;
  return enLinea ? '' : 'Sin red: el corte necesita conexión.';
}

/** Gasto que un cajero puede pagar del cajón sin el dueño, en centavos: el mismo tope del servidor (corte.ts). */
export const GASTO_MAXIMO_CAJERO = 10000;
/** Aviso previo en pantalla; el servidor es quien decide. */
export const gastoRequiereDueno = (tipo, importe) => tipo === 'gasto' && importe > GASTO_MAXIMO_CAJERO;

/** Dinero con sus dos decimales: «$1,234.50». */
export const pesosExactos = (centavos) => dinero(centavos);

/** Total de efectivo escrito en pesos con centavos → centavos enteros; null si está vacío, no es número o pasa de $1,000,000 (tope del servidor). */
export function centavosDeTexto(texto) {
  const t = String(texto ?? '').trim();
  if (!/^(\d+(\.\d{1,2})?|\.\d{1,2})$/.test(t)) return null;
  const centavos = Math.round(Number(t) * 100);
  return centavos <= 100_000_000 ? centavos : null;
}

/** Piezas de una sola denominación a partir de las cuales se pide confirmar al contar (no bloquea). */
export const PIEZAS_IMPROBABLES = 200;
/** «¿Seguro? 250 × $5.00 = $1,250.00» para una cantidad improbable de una denominación; '' si es normal. */
export function alertaConteo(denominacion, piezas) {
  return Number.isInteger(piezas) && piezas > PIEZAS_IMPROBABLES
    ? `¿Seguro? ${piezas} × ${dinero(denominacion)} = ${dinero(piezas * denominacion)}` : '';
}
