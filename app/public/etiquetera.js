/**
 * Etiquetas TSPL por Bluetooth, para la AIYIN AE240 BT. Sin driver ni dialogo
 * de impresion: el controlador de Windows de esta unidad no respeta el tamano
 * de pagina y saca la etiqueta corrida y recortada, se ajuste lo que se ajuste.
 *
 * Confirmado con /sonda-impresora el 2026-09-22, con la impresora enfrente: de
 * las cinco caracteristicas escribibles que expone la AE240 por BLE, la unica
 * que imprimio fue fff2 del servicio fff0, y el unico idioma que entendio fue
 * TSPL (ESC/POS y CPCL no sacaron nada). No adivinar otra combinacion: esta se
 * probo en hardware real.
 *
 * Misma filosofia que impresora.js, que le habla a la Epson de tickets por
 * WebUSB: nada por CDN, protocolo escrito a mano.
 */

import { sinAcentos } from './impresora.js';

const SERVICIO = '0000fff0-0000-1000-8000-00805f9b34fb';
const CARACTERISTICA = '0000fff2-0000-1000-8000-00805f9b34fb';

// 203 dpi = 8 puntos por mm, asi que la etiqueta de 2 x 1 in son 406 x 203
// puntos. Las fuentes internas de TSPL miden: "1" 8x12, "2" 12x20, "3" 16x24,
// todo multiplicado por el factor de ampliacion. De ahi salen las coordenadas.
const ANCHO = 406;
const MARGEN = 16;
const ANCHO_NOMBRE = 12;   // fuente "2" sin ampliar
const ANCHO_PIE = 8;       // fuente "1" sin ampliar
const ANCHO_PRECIO = 32;   // fuente "3" ampliada x2

// ponytail: 2 puntos (0.25 mm) de modulo angosto es el estandar de Code 128 a
// 203 dpi. Si el lector de la caja no engancha las barras, este es el numero
// que hay que subir (a 3) — no el tamano de la etiqueta. /prueba-codigo sirve
// para calibrarlo sin gastar la cola de etiquetas reales.
const MODULO = 2;

/** Lo que cabe en un renglon de nombre, en caracteres. */
export const NOMBRE_MAX = Math.floor((ANCHO - MARGEN * 2) / ANCHO_NOMBRE);

/**
 * TEXT de TSPL va entre comillas dobles y no tiene escape confiable entre
 * firmwares: la comilla y la diagonal invertida se quitan en vez de arriesgar
 * una etiqueta partida a la mitad.
 */
const limpiar = (texto) => sinAcentos(texto).replace(/["\\]/g, ' ');

/**
 * Parte el nombre en los dos renglones que caben. TEXT no acomoda el texto
 * solo: si no se parte aqui, el nombre largo se sale de la etiqueta en vez de
 * bajar de renglon. Lo que no cabe se corta con "..".
 */
export function partirNombre(nombre) {
  const palabras = limpiar(nombre).split(/\s+/).filter(Boolean);
  const renglones = [];
  for (const palabra of palabras) {
    const ultimo = renglones[renglones.length - 1];
    if (ultimo !== undefined && `${ultimo} ${palabra}`.length <= NOMBRE_MAX) {
      renglones[renglones.length - 1] = `${ultimo} ${palabra}`;
    } else {
      renglones.push(palabra);
    }
  }
  const cabe = renglones.slice(0, 2).map((r) => r.slice(0, NOMBRE_MAX));
  if (renglones.length > 2) cabe[1] = `${cabe[1].slice(0, NOMBRE_MAX - 2)}..`;
  return cabe.length > 0 ? cabe : ['El Dolaron'];
}

/** Centra un texto de fuente fija en el ancho de la etiqueta. */
const centrar = (texto, anchoLetra) =>
  Math.max(MARGEN, Math.round((ANCHO - texto.length * anchoLetra) / 2));

/**
 * TSPL no dice cuanto va a medir el codigo de barras, asi que se estima: cada
 * caracter son 11 modulos, mas arranque, verificacion y paro. Descuadrarse unos
 * milimetros no afecta la lectura; que se salga de la etiqueta si.
 */
const centrarBarras = (contenido) =>
  Math.max(MARGEN, Math.round((ANCHO - (11 * (contenido.length + 2) + 13) * MODULO) / 2));

/**
 * El trabajo TSPL de una pieza. Exportada para probarla sin impresora enfrente.
 *
 * @param pieza {{ nombre: string, precio: number, precio_lista: number, codigo: string, semana_ingreso: string }}
 * @param copias cuantas etiquetas iguales — una por pieza en existencia
 */
export function tsplEtiqueta(pieza, copias = 1) {
  const pesos = (centavos) => `$${Math.round(centavos / 100)}`;
  const [primero, segundo] = partirNombre(pieza.nombre || 'El Dolaron');
  const precio = pesos(pieza.precio);
  // La barra codifica solo el numero, sin "ED-" ni ceros: el codigo completo no
  // cabe legible en 50.8 mm. buscarPieza() en caja.html lo reconstruye.
  const numero = String(Number(pieza.codigo.slice(3)));
  const pie = limpiar(`${pieza.codigo} - ${pieza.semana_ingreso}`);

  const ordenes = [
    'SIZE 50.8 mm,25.4 mm',
    'GAP 2 mm,0 mm',
    'DIRECTION 1',
    'CLS',
    `TEXT ${MARGEN},8,"2",0,1,1,"${primero}"`,
  ];
  if (segundo) ordenes.push(`TEXT ${MARGEN},30,"2",0,1,1,"${segundo}"`);

  // El precio es lo que se lee de lejos: se lleva la fuente mas grande que cabe.
  ordenes.push(`TEXT ${MARGEN},54,"3",0,2,2,"${precio}"`);

  if (pieza.precio_lista > pieza.precio) {
    const antes = pesos(pieza.precio_lista);
    const x = MARGEN + precio.length * ANCHO_PRECIO + 12;
    ordenes.push(`TEXT ${x},86,"1",0,1,1,"${antes}"`);
    // TSPL no sabe tachar texto: la linea encima se dibuja a mano.
    ordenes.push(`BAR ${x},92,${antes.length * ANCHO_PIE},2`);
  }

  // El codigo de barras lo dibuja la impresora, no code128.js: asi las barras
  // caen en puntos enteros del cabezal y no las deforma ningun escalado.
  ordenes.push(`BARCODE ${centrarBarras(numero)},112,"128",48,0,0,${MODULO},${MODULO * 2},"${numero}"`);
  ordenes.push(`TEXT ${centrar(pie, ANCHO_PIE)},166,"1",0,1,1,"${pie}"`);
  ordenes.push(`PRINT ${copias},1`);

  return `${ordenes.join('\r\n')}\r\n`;
}

/* ---------- Transporte ---------- */

let caracteristica = null;

export function etiqueteraLista() {
  return caracteristica !== null;
}

/**
 * Pide el permiso de Web Bluetooth. Solo funciona disparado por un clic real
 * del usuario, y hay que llamarla antes de cualquier otra espera del mismo
 * clic: el permiso para abrir la ventana se vence en cuanto el navegador ve
 * que el clic ya se fue en otra cosa.
 *
 * ponytail: sin reconexion automatica. getDevices() existe a medias entre
 * versiones de Chrome y se cuelga con la impresora apagada; un clic al
 * principio del turno es mas barato que esa complicacion. Si estorba,
 * ese es el camino.
 */
export async function conectarEtiquetera() {
  const aparato = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICIO] }],
  });
  const servidor = await aparato.gatt.connect();
  const servicio = await servidor.getPrimaryService(SERVICIO);
  caracteristica = await servicio.getCharacteristic(CARACTERISTICA);
  aparato.addEventListener('gattserverdisconnected', () => { caracteristica = null; });
}

/**
 * El MTU de BLE son 20 bytes: el trabajo completo de un golpe se pierde. Esta
 * cadencia es la que saco la etiqueta de prueba en la sonda — no cambiarla sin
 * volver a probar con la impresora enfrente.
 */
async function enviar(texto) {
  const datos = new TextEncoder().encode(texto);
  const sinRespuesta = caracteristica.properties.writeWithoutResponse;
  for (let i = 0; i < datos.length; i += 20) {
    const trozo = datos.slice(i, i + 20);
    if (sinRespuesta) await caracteristica.writeValueWithoutResponse(trozo);
    else await caracteristica.writeValue(trozo);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Imprime las etiquetas de una pieza. Devuelve false si se cayo el enlace. */
export async function imprimirEtiquetas(pieza, copias = 1) {
  if (!caracteristica) return false;
  try {
    await enviar(tsplEtiqueta(pieza, copias));
    return true;
  } catch (error) {
    console.error('Etiquetera: fallo el envio', error);
    caracteristica = null;   // probablemente se apago; el siguiente clic reconecta
    return false;
  }
}
