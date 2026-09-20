/**
 * Ticket ESC/POS por WebUSB, para la Epson TM-T20 II. Sin driver ni dialogo de
 * impresion del sistema: la venta ya se cobro y se guardo, el ticket es un
 * extra que nunca debe bloquear ni retrasar el cobro. Cualquier falla aqui se
 * traga en silencio — revisa la consola, no la caja.
 *
 * Misma filosofia que code128.js: nada por CDN, protocolo escrito a mano.
 */

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
  await dev.open();
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

export function impresoraLista() {
  return dispositivo !== null;
}

async function enviar(bytes) {
  if (!dispositivo) return false;
  try {
    await dispositivo.transferOut(numeroEndpointSalida, bytes);
    return true;
  } catch (error) {
    console.error('Impresora: fallo el envio', error);
    dispositivo = null;   // probablemente se desconecto; el siguiente intento reconecta
    return false;
  }
}

/** Un pulso al cajon de dinero. Pin 2, el mas comun en cajones de un solo puerto. */
export async function abrirCajon() {
  return enviar(new Uint8Array([ESC, 0x70, 0x00, 25, 250]));
}

/**
 * @param venta {{ total: number, forma_pago: 'efectivo'|'tarjeta', efectivo: number, cambio: number, creado_en: string }}
 * @param lineas {{ nombre: string, precio: number, cantidad: number }[]}
 */
export async function imprimirTicket(venta, lineas) {
  const pesos = (centavos) => `$${(centavos / 100).toFixed(2)}`;
  const fecha = new Date(venta.creado_en).toLocaleString('es-MX', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  const partes = [
    new Uint8Array([ESC, 0x40]),   // inicializa: limpia cualquier estado de un ticket anterior
    centrado('EL DOLARON'),
    centrado('Productos Americanos'),
    separador(),
    linea(fecha),
    separador(),
  ];
  for (const l of lineas) {
    partes.push(linea(sinAcentos(l.nombre).slice(0, COLUMNAS)));
    partes.push(renglonMonto(`  ${l.cantidad} x ${pesos(l.precio)}`, pesos(l.precio * l.cantidad)));
  }
  partes.push(separador());
  partes.push(renglonMonto('TOTAL', pesos(venta.total)));
  if (venta.forma_pago === 'efectivo') {
    partes.push(renglonMonto('Efectivo', pesos(venta.efectivo)));
    partes.push(renglonMonto('Cambio', pesos(venta.cambio)));
  } else {
    partes.push(linea('TARJETA'));
  }
  partes.push(separador());
  partes.push(centrado('Gracias por su compra'));
  partes.push(new Uint8Array([0x0a, 0x0a, 0x0a]));
  partes.push(new Uint8Array([GS, 0x56, 0x42, 0x00]));   // corte con avance de papel

  return enviar(concatenar(partes));
}
