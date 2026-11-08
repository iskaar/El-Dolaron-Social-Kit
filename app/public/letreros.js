/**
 * Letrero del plano del local (Issue #737): el numero (1-36) del mueble al que va cada pieza, para que las
 * auxiliares la acomoden sin decidir nada. Se imprime en la etiqueta y se calcula solo, sin columna ni migracion.
 * Si el plano cambia, se edita esta tabla y nada mas.
 *
 * Cada regla es [letrero, palabras]: gana la primera cuyas palabras estan en el nombre (sin acentos ni mayusculas),
 * asi que lo mas especifico va antes ("toalla de playa" antes que "toalla"). Una pieza mal clasificada solo queda en un
 * mueble vecino. ropa.js (esRopa) y tallas.js (esCalzado) deciden lo que ya decidian.
 */
import { sinAcentos } from './impresora.js';
import { esRopa } from './ropa.js';
import { esCalzado } from './tallas.js';

const LETRERO_OMISION = 25;   // deportes, otros y lo que no tenga categoria (hay poco)

// Palabra completa, con plural: "bra" no se confunde con "brazalete" y "calcetin" cubre "calcetines".
const palabras = (lista) => new RegExp(`(?<![a-z0-9])(?:${lista})(?:e?s)?(?![a-z0-9])`);
const tabla = (reglas) => reglas.map(([letrero, lista]) => [letrero, palabras(lista)]);

// categoria -> [letrero de omision, reglas por palabra clave en el nombre]
const POR_CATEGORIA = {
  accesorios: [14, tabla([[7, 'joyeria|arete|collar|pulsera|anillo']])],
  // Maquillaje y uñas van antes que cabello: «cepillo de maquillaje» o «base» no se van al 22.
  belleza: [10, tabla([
    [5, 'maquillaje|labial|sombra|rimel|rubor|delineador|base'], [8, 'esmalte|unas'],
    [22, 'cabello|pelo|shampoo|champu|acondicionador|tinte|cepillo|peine|plancha|secadora|secador|rizador|tenaza'],
  ])],
  hogar: [11, tabla([
    [35, 'toalla de playa'], [33, 'toalla|cobija'], [34, 'almohada|funda'], [19, 'sabana|edredon|colcha|cortina'],
    [12, 'cuadro|vela|florero|adorno|marco|decoracion'], [20, 'organizador|contenedor|cesto|canasta'],
    [28, 'asador|parrilla'], [31, 'silla|mesa|buro|librero|mueble'], [32, 'colchon'],
  ])],
  jardin: [30, []],
  electronica: [13, tabla([[36, 'neon'], [29, 'herramienta|taladro|desarmador|auto|carro']])],
  juguetes: [24, tabla([[7, 'peluche'], [16, 'manualidades|burbujas|pistola de agua'], [18, 'fiesta|globo|pinata']])],
  mascotas: [29, []],
  papeleria: [17, tabla([[36, 'pizarron']])],
  despensa: [26, tabla([[20, 'detergente|limpiador|cloro|desinfectante|jabon para'], [27, 'desechable|servilleta|bolsa de basura|aluminio|popote']])],
};

// Ropa: calzado, interior, ninos, caballero y dama (lo demas). Caballero va siempre al rack 4; en dama, colgada va al
// rack y doblada a la pared. El 22 es solo cabello (Issue #762).
const INTERIOR = palabras('brasier|bra|calzon|panty|boxer|trusa|calcetin|calceta');
const NINOS = palabras('nino|nina|bebe|toddler|kid|boy|girl|infant');
const MARCA_NINOS = /cat ?(?:&|and) ?jack|art class/;
const CABALLERO = palabras('caballero|hombre|men');
const MARCA_CABALLERO = /goodfellow|original use/;
const COLGADA = palabras('blusa|camisa|vestido|falda|chamarra|saco|abrigo');

const letreroRopa = (pieza, nombre, marca) => {
  if (esCalzado(pieza)) return 21;
  if (INTERIOR.test(nombre)) return 8;
  if (NINOS.test(nombre) || MARCA_NINOS.test(`${nombre} ${marca}`) || sinAcentos(pieza.talla ?? '').toLowerCase().startsWith('nino')) return 23;
  if (CABALLERO.test(nombre) || MARCA_CABALLERO.test(`${nombre} ${marca}`)) return 4;
  return COLGADA.test(nombre) ? 3 : 15;
};

/** El letrero (entero 1-36) de una pieza `{ categoria, nombre, marca, talla }`. Siempre devuelve uno. */
export function letrero(pieza) {
  if (!pieza) return LETRERO_OMISION;
  const normal = (texto) => sinAcentos(String(texto ?? '')).toLowerCase().replace(/\s+/g, ' ').trim();
  const nombre = normal(pieza.nombre);
  if (esRopa(pieza)) return letreroRopa(pieza, nombre, normal(pieza.marca));
  const [omision, reglas] = POR_CATEGORIA[normal(pieza.categoria)] ?? [LETRERO_OMISION, []];
  return reglas.find(([, regla]) => regla.test(nombre))?.[0] ?? omision;
}
