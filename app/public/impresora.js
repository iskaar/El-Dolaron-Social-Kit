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

/**
 * Imagen a ESC/POS (GS v 0, raster): un bit por punto, 1 = negro, el bit mas
 * alto a la izquierda. Transparente cuenta como blanco. Exportada para
 * probarla sin impresora.
 * @param rgba Uint8ClampedArray de canvas getImageData, ancho*alto*4
 */
export function rasterEscPos(rgba, ancho, alto, umbral = 128) {
  const porRenglon = Math.ceil(ancho / 8);
  const salida = new Uint8Array(8 + porRenglon * alto);
  salida.set([GS, 0x76, 0x30, 0, porRenglon & 0xff, porRenglon >> 8, alto & 0xff, alto >> 8]);
  for (let y = 0; y < alto; y += 1) {
    for (let x = 0; x < ancho; x += 1) {
      const i = (y * ancho + x) * 4;
      const luz = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
      if (rgba[i + 3] >= 128 && luz < umbral) {
        salida[8 + y * porRenglon + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return salida;
}

// logo-ticket.png ya viene en blanco y negro, recortado y a 432 puntos de ancho
// (54 mm de los 72 que imprime la TM-T20II), sacado de
// 01-Logos/el-dolaron-logo-horizontal-fondo-blanco.png. ponytail: si sale
// grande, chico o empastado en papel, se regenera ese PNG con otro ancho.
let logo = null;
function cargarLogo() {
  logo ??= (async () => {
    const imagen = new Image();
    imagen.src = '/logo-ticket.png';
    await imagen.decode();
    const lienzo = document.createElement('canvas');
    lienzo.width = imagen.naturalWidth;
    lienzo.height = imagen.naturalHeight;
    const contexto = lienzo.getContext('2d');
    contexto.drawImage(imagen, 0, 0);
    const { data } = contexto.getImageData(0, 0, lienzo.width, lienzo.height);
    return rasterEscPos(data, lienzo.width, lienzo.height);
  })().catch((error) => {
    console.error('Impresora: no se pudo preparar el logo, el ticket sale sin el', error);
    logo = null;   // el siguiente ticket lo vuelve a intentar
    return null;
  });
  return logo;
}

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
 * @param venta {{ total: number, forma_pago: 'efectivo'|'tarjeta', efectivo: number, cambio: number, creado_en: string,
 *   dolarones?: number, socio?: { numero: number, ganados: number, saldo: number } | null }}
 * @param lineas {{ nombre: string, precio: number, cantidad: number }[]}
 */
export async function imprimirTicket(venta, lineas) {
  const pesos = (centavos) => `$${(centavos / 100).toFixed(2)}`;
  const fecha = new Date(venta.creado_en).toLocaleString('es-MX', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  const imagenLogo = await cargarLogo();
  const partes = [
    new Uint8Array([ESC, 0x40]),   // inicializa: limpia cualquier estado de un ticket anterior
    imagenLogo
      ? concatenar([new Uint8Array([ESC, 0x61, 1]), imagenLogo, new Uint8Array([0x0a, ESC, 0x61, 0])])
      : centrado('EL DOLARON'),
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
  if (venta.dolarones > 0) {
    partes.push(renglonMonto('Dolarones', `-${pesos(venta.dolarones)}`));
    partes.push(renglonMonto('A pagar', pesos(venta.total - venta.dolarones)));
  }
  if (venta.forma_pago === 'efectivo') {
    partes.push(renglonMonto('Efectivo', pesos(venta.efectivo)));
    partes.push(renglonMonto('Cambio', pesos(venta.cambio)));
  } else {
    partes.push(linea('TARJETA'));
  }
  partes.push(separador());
  if (venta.socio) {
    const d = (centavos) => `${centavos / 100} D`;
    partes.push(linea(`Socio #${venta.socio.numero}`));
    if (venta.socio.ganados) partes.push(renglonMonto('Ganaste (usables desde manana)', d(venta.socio.ganados)));
    partes.push(renglonMonto('Saldo disponible', d(venta.socio.saldo)));
    partes.push(separador());
  }
  partes.push(centrado('Gracias por su compra'));
  partes.push(new Uint8Array([0x0a, 0x0a, 0x0a]));
  partes.push(new Uint8Array([GS, 0x56, 0x42, 0x00]));   // corte con avance de papel

  return enviar(concatenar(partes));
}
