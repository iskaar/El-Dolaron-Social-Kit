/**
 * Ticket ESC/POS por WebUSB, para la Epson TM-T20 II. Sin driver ni dialogo de
 * impresion del sistema: la venta ya se cobro y se guardo, el ticket es un
 * extra que nunca debe bloquear ni retrasar el cobro. Una falla no detiene la
 * venta: queda en errorImpresora() para que la caja la muestre.
 *
 * Misma filosofia que code128.js: nada por CDN, protocolo escrito a mano.
 */

import { codigoEnDigitos } from './code128.js';

const VENDOR_ID_EPSON = 0x04b8;

// ponytail: 48 columnas es lo documentado para la TM-T20 II en Fuente A sobre
// papel de 80mm. Si el primer ticket real sale con el texto cortado o con
// mucho espacio de sobra, este es el numero que hay que ajustar.
export const COLUMNAS = 48;

const ESC = 0x1b;
const GS = 0x1d;

let dispositivo = null;
let numeroInterfaz = null;
let numeroEndpointSalida = null;
let ultimoError = '';

/** Por que fallo el ultimo envio, o '' si salio bien. */
export const errorImpresora = () => ultimoError;

/**
 * Sin acentos: un ESC/POS mal emparejado con la tabla de codigos del firmware
 * imprime simbolos en vez de "ñ"/"á". Evitar el problema entero es mas
 * confiable que adivinar la tabla de codigos sin poder probarla en hardware
 * real. ponytail: si hace falta imprimir acentos, hay que confirmar primero
 * con Isaac que tabla de codigos entiende esta unidad (ESC t) y mapear bytes.
 */
export function sinAcentos(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x00-\x7F]/g, '?');
}

function codificar(texto) {
  return new TextEncoder().encode(sinAcentos(texto));
}

function concatenar(partes) {
  const total = partes.reduce((suma, p) => suma + p.length, 0);
  const salida = new Uint8Array(total);
  let offset = 0;
  for (const parte of partes) { salida.set(parte, offset); offset += parte.length; }
  return salida;
}

const linea = (texto = '') => concatenar([codificar(texto), new Uint8Array([0x0a])]);

/** Centra el texto en el ancho del papel. Exportada para probarla sin USB. */
export function centrarTexto(texto) {
  const relleno = Math.max(0, Math.floor((COLUMNAS - texto.length) / 2));
  return ' '.repeat(relleno) + texto;
}

/** Etiqueta a la izquierda, monto a la derecha, en el ancho del papel. */
export function renglonMontoTexto(etiqueta, monto) {
  const espacio = Math.max(1, COLUMNAS - etiqueta.length - monto.length);
  return etiqueta + ' '.repeat(espacio) + monto;
}

const centrado = (texto) => linea(centrarTexto(texto));
const separador = () => linea('-'.repeat(COLUMNAS));
const renglonMonto = (etiqueta, monto) => linea(renglonMontoTexto(etiqueta, monto));

async function encontrarEndpointSalida(dev) {
  for (const config of dev.configurations) {
    for (const iface of config.interfaces) {
      for (const alterno of iface.alternates) {
        const salida = alterno.endpoints.find((e) => e.direction === 'out');
        if (salida) return { interfaz: iface.interfaceNumber, endpoint: salida.endpointNumber };
      }
    }
  }
  return null;
}

async function abrir(dev) {
  if (!dev.opened) await dev.open();
  if (dev.configuration === null) await dev.selectConfiguration(1);
  const hallado = await encontrarEndpointSalida(dev);
  if (!hallado) throw new Error('La impresora no tiene un endpoint de salida USB.');
  await dev.claimInterface(hallado.interfaz);
  dispositivo = dev;
  numeroInterfaz = hallado.interfaz;
  numeroEndpointSalida = hallado.endpoint;
}

/** Reconecta sin pedir permiso, a lo que ya se autorizo antes. Llamar al cargar la pagina. */
export async function reconectarImpresora() {
  if (!('usb' in navigator)) return false;
  try {
    const [previo] = await navigator.usb.getDevices();
    if (!previo) return false;
    await abrir(previo);
    return true;
  } catch {
    return false;
  }
}

/** Pide el permiso de WebUSB. Solo funciona disparado por un clic real del usuario. */
export async function conectarImpresora() {
  const dev = await navigator.usb.requestDevice({ filters: [{ vendorId: VENDOR_ID_EPSON }] });
  await abrir(dev);
}

/**
 * Por que no abrio, en palabras de la caja. El navegador ya dio el permiso (la
 * impresora salio en la lista); lo que falla despues es abrir el puerto USB.
 */
export function explicarErrorUsb(error) {
  const texto = `${error?.name}: ${error?.message}`;
  if (error?.name === 'SecurityError' || /access denied/i.test(error?.message ?? '')) {
    return `${texto}. Probablemente Windows tiene su propio controlador en la impresora y el navegador no puede abrirla: hay que cambiarlo a WinUSB.`;
  }
  if (error?.name === 'NetworkError') {
    return `${texto}. Otra pestaña o programa la tiene abierta: ciérralos y apaga y prende la impresora.`;
  }
  return texto;
}

export function impresoraLista() {
  return dispositivo !== null;
}

// Issue #97: el ticket entero (~6 KB con el logo) en un solo transferOut
// imprimio medio logo y fallo; la TM-T20 II recibe en un bufer de 4 KB. Se
// manda en pedazos, uno a la vez. Bajado de 512 a 64 (un paquete USB) porque
// la caja vieja se detenia tras el codigo de barras del vale (bug-log #9).
export const PEDAZO = 64;

// ponytail: 2 s alcanza para que salga y se corte un ticket normal; si el vale
// vuelve a salir incompleto despues de un ticket largo, subirlo.
export const PAUSA_VALE_MS = 2000;

// En fila: el cajon y el ticket nunca se mezclan en el mismo puerto.
let cola = Promise.resolve();

function enviar(bytes) {
  const envio = cola.then(() => enviarAhora(bytes));
  cola = envio.catch(() => {});
  return envio;
}

async function enviarAhora(bytes) {
  // Tras una falla el puerto queda cerrado: se reabre aqui, sin pedir permiso.
  // Antes se quedaba en null y ni el cajon volvia a abrir hasta recargar.
  if (!dispositivo && !(await reconectarImpresora())) {
    ultimoError = ultimoError || 'no conectada';
    return false;
  }
  let enviados = 0;
  try {
    while (enviados < bytes.length) {
      const pedazo = bytes.subarray(enviados, enviados + PEDAZO);
      const resultado = await dispositivo.transferOut(numeroEndpointSalida, pedazo);
      if (resultado.status === 'stall') {
        await dispositivo.clearHalt('out', numeroEndpointSalida);
        throw new Error('la impresora detuvo la transferencia (stall)');
      }
      if (resultado.status !== 'ok') throw new Error(`transferencia ${resultado.status}`);
      enviados += pedazo.length;
    }
    ultimoError = '';
    return true;
  } catch (error) {
    ultimoError = `${error?.name ?? 'Error'}: ${error?.message ?? error} (a los ${enviados} de ${bytes.length} bytes)`;
    console.error('Impresora: fallo el envio', ultimoError, error);
    try { await dispositivo?.close(); } catch { /* ya estaba cerrada */ }
    dispositivo = null;
    return false;
  }
}

/** Un pulso al cajon de dinero. Pin 2, el mas comun en cajones de un solo puerto. */
export async function abrirCajon() {
  return enviar(new Uint8Array([ESC, 0x70, 0x00, 25, 250]));
}

// Epson GS k, función B, Code 128 (73), conjunto B. Nada de imagen raster:
// https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/gs_lk.html
// ponytail: módulo 2 puntos para papel de 80 mm; calibrar con el lector real.
export const MODULO_VALE = 2;
// Conjunto C (pares de dígitos): sólo dígitos, que el lector escribe igual con
// cualquier distribución de teclado (ver codigoEnDigitos), y más angosto.
export function codigoBarrasVale(codigo) {
  if (!/^DP-[A-Za-z0-9_-]{16}$/.test(codigo)) throw new Error('Código de vale inválido.');
  const digitos = codigoEnDigitos(codigo);
  const datos = Uint8Array.from([0x7b, 0x43, ...digitos.match(/../g).map(Number)]);   // {C + pares
  return concatenar([
    new Uint8Array([ESC, 0x61, 1, GS, 0x48, 0, GS, 0x77, MODULO_VALE, GS, 0x68, 72, GS, 0x6b, 73, datos.length]),
    datos, new Uint8Array([0x0a, ESC, 0x61, 0]),
  ]);
}

// QR nativo Epson (GS ( k, modelo 2, función 165-181). Nada de imagen raster.
// Issue #258: el QR es una URL al portal con los mismos 30 dígitos después de '#'
// (nunca llegan al servidor): la cámara del celular abre el registro y el vale pasa
// a la cuenta. La caja lo sigue leyendo (code128.js quita la URL).
// ponytail: módulo 6 puntos, corrección M; calibrar con el lector. Host fijo de prod,
// también en el sandbox.
export const MODULO_QR_VALE = 6;
export const URL_VALE = 'https://dolarones.eldolaron.com/v#';
export function codigoQrVale(codigo) {
  if (!/^DP-[A-Za-z0-9_-]{16}$/.test(codigo)) throw new Error('Código de vale inválido.');
  const datos = new TextEncoder().encode(URL_VALE + codigoEnDigitos(codigo));
  const k = datos.length + 3;
  return concatenar([
    new Uint8Array([ESC, 0x61, 1,
      GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0,                 // modelo 2
      GS, 0x28, 0x6b, 3, 0, 49, 67, MODULO_QR_VALE,        // tamaño de módulo
      GS, 0x28, 0x6b, 3, 0, 49, 69, 49,                    // corrección M
      GS, 0x28, 0x6b, k & 255, k >> 8, 49, 80, 48]),       // guardar datos
    datos,
    new Uint8Array([GS, 0x28, 0x6b, 3, 0, 49, 81, 48, 0x0a, ESC, 0x61, 0]),   // imprimir
  ]);
}

function partesVale(vale, titulo = 'VALE DOLARONES - SIN REGISTRO', conCodigo = false) {
  return [
    separador(), centrado(titulo),
    renglonMonto('Saldo del vale', `${(vale.restante / 100).toFixed(2)} D`),
    linea(Date.parse(vale.disponible_desde) <= Date.parse(vale.creado_en)
      ? 'Usalo en tu siguiente compra' : `Disponible: ${fechaHora(vale.disponible_desde)}`),
    linea(`Vence: ${fechaHora(vale.vence_en)}`),
    ...(conCodigo && vale.restante > 0 ? [codigoQrVale(vale.codigo), codigoBarrasVale(vale.codigo)] : []), centrado(vale.codigo),
    ...(conCodigo && vale.restante > 0 && vale.restante === vale.importe
      ? [centrado('Escanea el QR con tu celular:'), centrado('registrate y recibe el doble en tu cuenta.')] : []),
    linea('Conserva el papel. Copias comparten el saldo.'),
    linea('Solo en El Dolaron. No canjeable por efectivo.'),
  ];
}

/** Reimprimir conserva código, saldo actual y vencimiento del servidor. */
export function imprimirVale(vale) {
  return enviar(concatenar([
    ...encabezado('VALE DOLARONES'), ...partesVale(vale, undefined, true),
    new Uint8Array([0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x00]),
  ]));
}

/**
 * @param venta {{ total: number, forma_pago: 'efectivo'|'tarjeta'|'transferencia', efectivo: number, cambio: number, creado_en: string,
 *   dolarones?: number, socio?: { numero: number, ganados: number, saldo: number } | null }}
 * @param lineas {{ nombre: string, precio: number, cantidad: number }[]}
 */
export async function imprimirTicket(venta, lineas) {
  const pesos = (centavos) => `$${(centavos / 100).toFixed(2)}`;
  const fecha = new Date(venta.creado_en).toLocaleString('es-MX', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  // Sin logo (Issue #97): en la caja vieja cualquier imagen, aun chica y en
  // franjas, dejaba la impresora trabada a media imagen. El nombre va en texto
  // al doble de tamano (ESC ! 0x30), centrado por la propia impresora (ESC a 1).
  const partes = [
    new Uint8Array([ESC, 0x40]),   // inicializa: limpia cualquier estado de un ticket anterior
    new Uint8Array([ESC, 0x61, 1, ESC, 0x21, 0x30]),
    linea('EL DOLARON'),
    new Uint8Array([ESC, 0x21, 0x00, ESC, 0x61, 0]),
    centrado('Productos Americanos'),
    separador(),
    linea(fecha),
    ...(venta.id ? [linea('Venta: ' + venta.id)] : []),
    separador(),
  ];
  for (const l of lineas) {
    partes.push(linea(sinAcentos(l.nombre).slice(0, COLUMNAS)));
    partes.push(renglonMonto(`  ${l.cantidad} x ${pesos(l.precio)}`, pesos(l.precio * l.cantidad)));
  }
  partes.push(separador());
  if (venta.descuento > 0) {
    partes.push(renglonMonto('Subtotal', pesos(venta.total + venta.descuento)));
    partes.push(renglonMonto('Descuento', `-${pesos(venta.descuento)}`));
  }
  partes.push(renglonMonto('TOTAL', pesos(venta.total)));
  if (venta.dolarones > 0) {
    partes.push(renglonMonto('Dolarones', `-${pesos(venta.dolarones)}`));
    partes.push(renglonMonto('A pagar', pesos(venta.total - venta.dolarones)));
  }
  if (venta.forma_pago === 'efectivo') {
    partes.push(renglonMonto('Efectivo', pesos(venta.efectivo)));
    partes.push(renglonMonto('Cambio', pesos(venta.cambio)));
  } else {
    partes.push(linea(venta.forma_pago === 'transferencia' ? 'TRANSFERENCIA' : 'TARJETA'));
  }
  partes.push(separador());
  if (venta.socio) {
    const d = (centavos) => `${centavos / 100} D`;
    partes.push(linea(`Socio #${venta.socio.numero}`));
    if (venta.socio.ganados) partes.push(renglonMonto('Ganaste (usables desde manana)', d(venta.socio.ganados)));
    partes.push(renglonMonto('Saldo disponible', d(venta.socio.saldo)));
    partes.push(separador());
  }
  if (venta.vale_usado) partes.push(...partesVale(venta.vale_usado, 'SALDO DEL VALE ANTERIOR'));
  if (venta.vale_emitido) partes.push(...partesVale(venta.vale_emitido));
  if (venta.vale_pendiente) partes.push(linea('Elegibilidad de vale sin confirmar.'),
    linea('Consulta en caja con este ticket tras sincronizar.'));
  if (venta.recompensa_pendiente) partes.push(linea('Dolarones de compra sin confirmar.'),
    linea('Consulta el saldo tras sincronizar.'));
  partes.push(centrado('Gracias por su compra'));
  partes.push(new Uint8Array([0x0a, 0x0a, 0x0a]));
  partes.push(new Uint8Array([GS, 0x56, 0x42, 0x00]));   // corte con avance de papel

  const impreso = await enviar(concatenar(partes));
  // El codigo de barras dentro de un ticket largo trababa la impresora de la caja
  // (no imprimia lo que seguia ni cortaba; bug-log #9). El vale sale en su papel,
  // como la reimpresion, que si funciona, cuando la impresora ya vacio el ticket.
  if (!venta.vale_emitido || venta.vale_emitido.restante <= 0) return impreso;
  await new Promise((listo) => setTimeout(listo, PAUSA_VALE_MS));
  return (await imprimirVale(venta.vale_emitido)) && impreso;
}

/* ---------- Corte de caja y retiros (Issue #100): hojas para firmar ---------- */

const importe = (centavos) => `$${(centavos / 100).toFixed(2)}`;
const fechaHora = (iso) => new Date(iso).toLocaleString('es-MX', {
  timeZone: 'America/Mexico_City',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const negritas = (encendidas) => new Uint8Array([ESC, 0x45, encendidas ? 1 : 0]);

function encabezado(titulo) {
  return [
    new Uint8Array([ESC, 0x40]),
    new Uint8Array([ESC, 0x61, 1, ESC, 0x21, 0x30]),
    linea('EL DOLARON'),
    new Uint8Array([ESC, 0x21, 0x00, ESC, 0x61, 0]),
    centrado(titulo),
    separador(),
  ];
}

// Espacio para dos firmas y el corte del papel.
function firmas(quienEntrega) {
  return [
    linea(), linea(), linea(),
    linea('Entrega: ______________________________'),
    linea(`         ${sinAcentos(quienEntrega).slice(0, COLUMNAS - 9)}`),
    linea(), linea(), linea(),
    linea('Recibe:  ______________________________'),
    new Uint8Array([0x0a, 0x0a, 0x0a]),
    new Uint8Array([GS, 0x56, 0x42, 0x00]),
  ];
}

// Texto libre partido al ancho del papel.
const parrafo = (texto) => (sinAcentos(texto).match(new RegExp(`.{1,${COLUMNAS}}`, 'g')) ?? []).map((l) => linea(l));

/**
 * El corte impreso, para que el cajero lo firme y lo entregue con el efectivo.
 * @param corte la fila de `cortes` que regresa /api/cortes
 */
export function imprimirCorte(corte) {
  const conteo = JSON.parse(corte.conteo || '{}');
  const diferencia = corte.diferencia;
  const etiquetaDiferencia = diferencia === 0 ? 'Diferencia' : diferencia > 0 ? 'SOBRANTE' : 'FALTANTE';
  const partes = [
    ...encabezado('CORTE DE CAJA'),
    linea(`Caja: ${sinAcentos(corte.caja)}`),
    linea(`Cajero: ${sinAcentos(corte.cajero)}`.slice(0, COLUMNAS)),
    linea(`Desde: ${corte.desde ? fechaHora(corte.desde) : 'primer corte de esta caja'}`),
    linea(`Hasta: ${fechaHora(corte.hasta)}`),
    linea(`Ventas cobradas: ${corte.tickets}`),
    separador(),
    centrado('EFECTIVO'),
    renglonMonto('Fondo inicial', importe(corte.fondo_inicial)),
    renglonMonto('+ Ventas en efectivo', importe(corte.efectivo_ventas)),
    renglonMonto('- Devoluciones', importe(corte.efectivo_devoluciones)),
    renglonMonto('- Retiros', importe(corte.retiros)),
    renglonMonto('- Gastos', importe(corte.gastos ?? 0)),
    renglonMonto('= Esperado', importe(corte.efectivo_esperado)),
    renglonMonto('Contado', importe(corte.efectivo_contado)),
    negritas(diferencia !== 0),
    renglonMonto(etiquetaDiferencia, importe(Math.abs(diferencia))),
    negritas(false),
    separador(),
    ...(Object.keys(conteo).length ? [
      centrado('CONTEO'),
      ...Object.entries(conteo)
        .filter(([, piezas]) => piezas > 0)
        .sort(([a], [b]) => Number(b) - Number(a))
        .map(([denominacion, piezas]) => renglonMonto(`  ${piezas} x ${importe(Number(denominacion))}`, importe(piezas * Number(denominacion)))),
      separador(),
    ] : []),
    renglonMonto('Tarjeta (sistema)', importe(corte.tarjeta_sistema)),
    renglonMonto('Tarjeta (terminal)', importe(corte.tarjeta_terminal)),
    renglonMonto('Diferencia tarjeta', importe(corte.tarjeta_terminal - corte.tarjeta_sistema)),
    renglonMonto('Transferencias', importe(corte.transferencias)),
    renglonMonto('Dolarones usados', `${corte.dolarones / 100} D`),
    separador(),
    negritas(true),
    renglonMonto('SE ENTREGA', importe(corte.entregado)),
    negritas(false),
    renglonMonto('Se queda en caja (fondo)', importe(corte.fondo_siguiente)),
    ...(corte.notas ? [separador(), linea('Notas:'), ...parrafo(corte.notas)] : []),
    ...firmas(corte.cajero),
  ];
  return enviar(concatenar(partes));
}

/** El comprobante de un retiro o un gasto, firmado por quien saca el dinero y quien lo recibe. */
export function imprimirRetiro(retiro) {
  const gasto = retiro.tipo === 'gasto';
  const partes = [
    ...encabezado(gasto ? 'GASTO DE CAJA' : 'RETIRO DE EFECTIVO'),
    linea(`Caja: ${sinAcentos(retiro.caja)}`),
    linea(`Cajero: ${sinAcentos(retiro.cajero)}`.slice(0, COLUMNAS)),
    linea(`Fecha: ${fechaHora(retiro.creado_en)}`),
    separador(),
    negritas(true),
    renglonMonto('IMPORTE', importe(retiro.importe)),
    negritas(false),
    linea(gasto ? 'Concepto:' : 'Motivo:'),
    ...parrafo(retiro.motivo),
    ...firmas(retiro.cajero),
  ];
  return enviar(concatenar(partes));
}

/**
 * El comprobante de una devolucion (Issue #138): piezas canceladas sueltas o el
 * resto del ticket. Lo firma el cajero que entrega el dinero y el cliente que
 * lo recibe; se guarda con el corte.
 * @param d {{ titulo: string, caja: string, cajero: string, creado_en: string, ticket_creado_en: string,
 *   forma_pago: string, piezas: { nombre: string, cantidad: number, importe: number }[],
 *   dinero: number, dolarones: number, motivo: string }}
 */
export function imprimirDevolucion(d) {
  const salida = d.forma_pago === 'efectivo' ? 'EFECTIVO' : d.forma_pago === 'transferencia' ? 'TRANSFERENCIA' : 'TARJETA';
  const partes = [
    ...encabezado(d.titulo),
    linea(`Caja: ${sinAcentos(d.caja || 'sin caja')}`),
    linea(`Cajero: ${sinAcentos(d.cajero)}`.slice(0, COLUMNAS)),
    linea(`Fecha: ${fechaHora(d.creado_en)}`),
    linea(`Ticket original: ${fechaHora(d.ticket_creado_en)}`),
    separador(),
    ...d.piezas.flatMap((p) => [
      linea(sinAcentos(p.nombre).slice(0, COLUMNAS)),
      renglonMonto(`  ${p.cantidad} pieza${p.cantidad > 1 ? 's' : ''}`, importe(p.importe)),
    ]),
    separador(),
    negritas(true),
    renglonMonto(`DEVUELTO EN ${salida}`, importe(d.dinero)),
    negritas(false),
    ...(d.dolarones ? [renglonMonto('Regresado al saldo (Dolarones)', `${d.dolarones / 100} D`)] : []),
    linea('Motivo:'),
    ...parrafo(d.motivo),
    ...firmas(d.cajero),
  ];
  return enviar(concatenar(partes));
}
