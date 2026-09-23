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
const PRIMER_RENGLON = 8;  // lo mas alto del diseno, y el tope del corrimiento

// Ancho de la barra angosta, en puntos (8 = 1 mm a 203 dpi).
//
// Isaac probo A (2 pts), B (3) y C (4) por BLE con /prueba-codigo el
// 2026-09-22 y las tres sonaron con el lector de la caja. Se deja en C, no en
// la mas angosta que paso: da mas margen contra variaciones de darkness o
// velocidad de un lote a otro sin gastar mas ancho del que hace falta.
//
// Se puede pisar desde /calibrar-etiqueta si otra unidad necesita otro ancho.
const MODULO_POR_OMISION = 4;
const CLAVE_MODULO = 'etiqueta-modulo';

export function modulo() {
  const guardado = Number(globalThis.localStorage?.getItem(CLAVE_MODULO));
  return Number.isFinite(guardado) && guardado > 0 ? guardado : MODULO_POR_OMISION;
}

export function guardarModulo(puntos) {
  globalThis.localStorage?.setItem(CLAVE_MODULO, String(Math.round(puntos)));
}

/** Lo que cabe en un renglon de nombre, en caracteres. */
export const NOMBRE_MAX = Math.floor((ANCHO - MARGEN * 2) / ANCHO_NOMBRE);

const CLAVE_CORRIMIENTO = 'etiqueta-corrimiento';

/**
 * La AE240 no empieza a imprimir donde empieza la etiqueta: sin corregir, el
 * primer renglon cae en la etiqueta anterior. Es el mismo descuadre que daba el
 * controlador de Windows por su lado, asi que viene de la impresora y no del
 * camino que le manda el trabajo.
 *
 * Se mide con /calibrar-etiqueta y se guarda por navegador. El valor por omision
 * es 0 a proposito: mientras nadie lo mida con la impresora enfrente, no hay un
 * numero honesto que poner aqui.
 */
export function corrimiento() {
  const guardado = Number(globalThis.localStorage?.getItem(CLAVE_CORRIMIENTO));
  return Number.isFinite(guardado) ? guardado : 0;
}

export function guardarCorrimiento(puntos) {
  globalThis.localStorage?.setItem(CLAVE_CORRIMIENTO, String(Math.round(puntos)));
}

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
const centrarBarras = (contenido, ancho) =>
  Math.max(MARGEN, Math.round((ANCHO - (11 * (contenido.length + 2) + 13) * ancho) / 2));

/**
 * El trabajo TSPL de una pieza. Exportada para probarla sin impresora enfrente.
 *
 * @param pieza {{ nombre: string, precio: number, precio_lista: number, codigo: string, semana_ingreso: string }}
 * @param copias cuantas etiquetas iguales — una por pieza en existencia
 * @param y0 corrimiento vertical en puntos, de la calibracion
 */
export function tsplEtiqueta(pieza, copias = 1, y0 = corrimiento(), barra = modulo()) {
  // Topar cada coordenada por separado aplastaria el diseno contra el borde de
  // arriba: los renglones se encimarian en vez de subir juntos. Se topa el
  // corrimiento entero, una sola vez, contra el elemento mas alto.
  const desplazamiento = Math.max(y0, -PRIMER_RENGLON);
  const y = (base) => base + desplazamiento;
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
    `TEXT ${MARGEN},${y(PRIMER_RENGLON)},"2",0,1,1,"${primero}"`,
  ];
  if (segundo) ordenes.push(`TEXT ${MARGEN},${y(30)},"2",0,1,1,"${segundo}"`);

  // El precio es lo que se lee de lejos: se lleva la fuente mas grande que cabe.
  ordenes.push(`TEXT ${MARGEN},${y(54)},"3",0,2,2,"${precio}"`);

  if (pieza.precio_lista > pieza.precio) {
    const antes = pesos(pieza.precio_lista);
    const x = MARGEN + precio.length * ANCHO_PRECIO + 12;
    ordenes.push(`TEXT ${x},${y(86)},"1",0,1,1,"${antes}"`);
    // TSPL no sabe tachar texto: la linea encima se dibuja a mano.
    ordenes.push(`BAR ${x},${y(92)},${antes.length * ANCHO_PIE},2`);
  }

  // El codigo de barras lo dibuja la impresora, no code128.js: asi las barras
  // caen en puntos enteros del cabezal y no las deforma ningun escalado.
  // Alto 56 puntos (7 mm): el espacio estaba libre abajo y darle mas altura a
  // las barras le da mas margen al lector para engancharlas de lado.
  ordenes.push(`BARCODE ${centrarBarras(numero, barra)},${y(108)},"128",56,0,0,${barra},${barra * 2},"${numero}"`);
  ordenes.push(`TEXT ${centrar(pie, ANCHO_PIE)},${y(170)},"1",0,1,1,"${pie}"`);
  ordenes.push(`PRINT ${copias},1`);

  return `${ordenes.join('\r\n')}\r\n`;
}

const MEDIDA = ['SIZE 50.8 mm,25.4 mm', 'GAP 2 mm,0 mm', 'DIRECTION 1'];

/**
 * Le pide a la impresora que mida el rollo ella misma. GAPDETECT avanza un par
 * de etiquetas leyendo el sensor y se queda con la altura y la separacion
 * reales, en vez de creerle al SIZE que le mandamos. Es la version por software
 * de apagarla y prenderla con el boton de avance apretado.
 */
export const TSPL_CALIBRAR = `${[...MEDIDA, 'GAPDETECT'].join('\r\n')}\r\n`;

/**
 * Un marco del tamano declarado de la etiqueta, con un OFFSET dado.
 *
 * El sensor de separacion esta bien: el boton de avance para clavado en cada
 * etiqueta. Lo que esta mal es donde ARRANCA el trabajo — la impresora deja el
 * papel en la posicion de corte al terminar y empieza el siguiente sin
 * regresarlo. OFFSET es justamente el comando que corre esa parada.
 *
 * El marco es el instrumento: si sus cuatro lados caen sobre el borde del
 * papel, ese OFFSET es el bueno y no hay nada mas que medir. Imprime dos
 * etiquetas a proposito — la primera todavia sale con la parada anterior, asi
 * que la que cuenta es la SEGUNDA.
 */
export function tsplMarco(offsetMm) {
  return `${[
    'SIZE 50.8 mm,25.4 mm', 'GAP 2 mm,0 mm',
    `OFFSET ${offsetMm} mm`,
    'DIRECTION 1', 'CLS',
    `BOX 0,0,${ANCHO - 1},202,3`,
    `TEXT ${MARGEN},24,"2",0,1,1,"OFFSET ${offsetMm} mm"`,
    `TEXT ${MARGEN},150,"2",0,1,1,"abajo"`,
    'PRINT 2,1', '',
  ].join('\r\n')}`;
}

/**
 * Cuatro etiquetas, cada una con un ancho de barra distinto y el codigo mas
 * largo que le cabe a ese ancho en 50.8 mm: a mas ancho, menos digitos, la
 * misma decision que la etiqueta real tiene que tomar con un codigo largo.
 * Usado tanto por /prueba-codigo como por el paso 4 de /calibrar-etiqueta,
 * asi que solo vive una vez.
 *
 * /prueba-codigo ya dijo que la variante C (0.5 mm) es la que suena, pero eso
 * salio por el dialogo de impresion del navegador — el mismo que deformaba
 * todo. Esto lo vuelve a preguntar por el camino que de verdad se usa.
 */
const VARIANTES_CODIGO = [
  ['A', 2, 'ED-000019'],
  ['B', 3, '000019'],
  ['C', 4, '019'],
  ['D', 5, '9'],
];

export const tsplPruebaCodigo = () => `${VARIANTES_CODIGO.map(([letra, barra, numero]) => [
  ...MEDIDA, 'CLS',
  `TEXT ${MARGEN},8,"2",0,1,1,"${letra}: ${barra} pts = ${barra / 8} mm"`,
  `BARCODE ${centrarBarras(numero, barra)},40,"128",96,0,0,${barra},${barra * 2},"${numero}"`,
  `TEXT ${MARGEN},${8 + 156},"1",0,1,1,"codigo ${numero}"`,
  'PRINT 1,1',
].join('\r\n')).join('\r\n')}\r\n`;

/**
 * Una regla impresa, para medir el descuadre en vez de adivinarlo: el marco es
 * donde la impresora CREE que esta la etiqueta y las rayas van cada 2 mm desde
 * ese borde. Comparando el marco contra el borde real del papel se lee cuanto
 * hay que correr el contenido, y de paso si la altura declarada es la de verdad.
 */
export const TSPL_REGLA = `${[
  ...MEDIDA, 'CLS',
  `BOX 0,0,${ANCHO - 1},202,2`,
  ...Array.from({ length: 13 }, (_, i) => {
    const y = i * 16;   // cada 16 puntos son 2 mm
    return [`BAR 0,${y},120,2`, `TEXT 128,${Math.min(y, 190)},"1",0,1,1,"${i * 2} mm"`];
  }).flat(),
  'PRINT 1,1', '',
].join('\r\n')}`;

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
 * El filtro va por NOMBRE, no por servicio. La AE240 no anuncia fff0 en su
 * publicidad BLE -- ese servicio solo aparece despues de conectarse -- asi que
 * filtrar por servicio deja la ventana del navegador vacia aunque la impresora
 * este prendida y a un palmo. El nombre si viene en la publicidad: la sonda lo
 * leyo como "AE240-bt_1DDE-LE". Con `cualquiera` se cae a la lista completa,
 * que es exactamente lo que uso la sonda y funciono: es la salida si algun dia
 * la unidad se llama de otro modo.
 *
 * ponytail: sin reconexion automatica. getDevices() existe a medias entre
 * versiones de Chrome y se cuelga con la impresora apagada; un clic al
 * principio del turno es mas barato que esa complicacion. Si estorba,
 * ese es el camino.
 */
export async function conectarEtiquetera({ cualquiera = false } = {}) {
  const aparato = await navigator.bluetooth.requestDevice(cualquiera
    ? { acceptAllDevices: true, optionalServices: [SERVICIO] }
    : { filters: [{ namePrefix: 'AE240' }], optionalServices: [SERVICIO] });
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

/** Manda un trabajo TSPL ya armado. Devuelve false si se cayo el enlace. */
export async function mandarTspl(tspl) {
  if (!caracteristica) return false;
  try {
    await enviar(tspl);
    return true;
  } catch (error) {
    console.error('Etiquetera: fallo el envio', error);
    caracteristica = null;   // probablemente se apago; el siguiente clic reconecta
    return false;
  }
}

/** Imprime las etiquetas de una pieza. Devuelve false si se cayo el enlace. */
export const imprimirEtiquetas = (pieza, copias = 1) =>
  mandarTspl(tsplEtiqueta(pieza, copias));
