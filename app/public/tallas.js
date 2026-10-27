/**
 * Tallas de ropa (Issue #218): una sola lista para la captura, el admin y el servidor.
 * Se guarda como texto: "M" de adulto, o "Niño 6 años / S" (la talla de niño es opcional); calzado "25.5" o "Niño 15".
 * El separador y los meses van en ASCII: la etiqueta TSPL no imprime acentos ni puntos medios.
 */
export const TALLAS_ADULTO = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
export const EDADES_NINO = ['0-3 meses', '3-6 meses', '6-9 meses', '9-12 meses', '12-18 meses', '18-24 meses',
  '2 años', '3 años', '4 años', '5 años', '6 años', '7 años', '8 años', '10 años', '12 años', '14 años', '16 años'];
export const TALLAS_NINO = ['XS', 'S', 'M', 'L', 'XL'];

/**
 * Calzado (Issues #543, #546): se captura en talla US (lo que dice la caja) y se guarda la MX en
 * centimetros: adulto "26", nino "Niño 19" (mismo prefijo que la ropa de nino). Las listas son los cm validos.
 */
const medios = (desde, hasta) => Array.from({ length: (hasta - desde) * 2 + 1 }, (_, i) => String(desde + i / 2));
export const TALLAS_CALZADO_ADULTO = medios(22, 32);
export const TALLAS_CALZADO_NINO = medios(10, 25);

/**
 * Conversion US -> MX (cm) como pares explicitos [us, cm]: es una calibracion, no una formula.
 * Si una equivalencia resulta mala se corrige aqui y no hay datos que migrar: lo guardado son los cm.
 * Hombre cm = US + 18; mujer cm = US + 17; nino aproximado (C = toddler/little kid, Y = youth).
 */
export const CALZADO_US_HOMBRE = [
  ['6', '24'], ['6.5', '24.5'], ['7', '25'], ['7.5', '25.5'], ['8', '26'], ['8.5', '26.5'], ['9', '27'], ['9.5', '27.5'],
  ['10', '28'], ['10.5', '28.5'], ['11', '29'], ['11.5', '29.5'], ['12', '30'], ['12.5', '30.5'], ['13', '31'], ['14', '32'],
];
export const CALZADO_US_MUJER = [
  ['5', '22'], ['5.5', '22.5'], ['6', '23'], ['6.5', '23.5'], ['7', '24'], ['7.5', '24.5'], ['8', '25'], ['8.5', '25.5'],
  ['9', '26'], ['9.5', '26.5'], ['10', '27'], ['10.5', '27.5'], ['11', '28'], ['12', '29'],
];
export const CALZADO_US_NINO = [
  ['4C', '10'], ['4.5C', '10.5'], ['5C', '11'], ['5.5C', '11.5'], ['6C', '12'], ['6.5C', '12.5'], ['7C', '13'], ['7.5C', '13.5'],
  ['8C', '14'], ['8.5C', '14.5'], ['9C', '15'], ['9.5C', '15.5'], ['10C', '16'], ['10.5C', '16.5'], ['11C', '17'], ['11.5C', '17.5'],
  ['12C', '18'], ['12.5C', '18.5'], ['13C', '19'], ['13.5C', '19.5'], ['1Y', '20'], ['1.5Y', '20.5'], ['2Y', '21'], ['2.5Y', '21.5'],
  ['3Y', '22'], ['3.5Y', '22.5'], ['4Y', '23'], ['4.5Y', '23.5'], ['5Y', '24'], ['5.5Y', '24.5'], ['6Y', '24.5'], ['7Y', '25'],
];

/** Chips de calzado del capturador y del celular, con su tabla y su posicion inicial (talla US). */
export const TABLAS_CALZADO = { 'Calzado H': CALZADO_US_HOMBRE, 'Calzado M': CALZADO_US_MUJER, 'Calzado niño': CALZADO_US_NINO };
export const CALZADO_INICIAL = { 'Calzado H': '9', 'Calzado M': '7', 'Calzado niño': '13C' };
export const calzadoRenglon = ([us, cm]) => `US ${us} · ${cm}`;
/** Lo que se guarda al elegir el renglon `indice` del chip `tipo`. */
export const calzadoValor = (tipo, indice) => {
  const cm = TABLAS_CALZADO[tipo][indice][1];
  return tipo === 'Calzado niño' ? `Niño ${cm}` : cm;
};
/**
 * Talla ya guardada (cm) -> { tipo, indice } del renglon, o null si no es calzado. Un cm de adulto existe en
 * hombre y en mujer: gana el chip `activo` si lo tiene, luego hombre, luego mujer.
 */
export function calzadoGuardado(talla, activo) {
  const nino = talla.startsWith('Niño ');
  const cm = nino ? talla.slice(5) : talla;
  for (const tipo of nino ? ['Calzado niño'] : [activo, 'Calzado H', 'Calzado M']) {
    const indice = TABLAS_CALZADO[tipo]?.findIndex((par) => par[1] === cm) ?? -1;
    if (indice >= 0) return { tipo, indice };
  }
  return null;
}

/**
 * Lo que dice la caja para un cm guardado: "US 8 H · US 9 M", "US 13C", o '' si no es calzado.
 * Es el rotulo de los desplegables de la ficha, Revisar y /admin, donde se elige el cm viendo la US.
 */
export const tallaUs = (talla) => {
  const nino = talla.startsWith('Niño ');
  const cm = nino ? talla.slice(5) : talla;
  const us = Object.entries(TABLAS_CALZADO)
    .filter(([tipo]) => (tipo === 'Calzado niño') === nino)
    .flatMap(([tipo, tabla]) => tabla.filter((par) => par[1] === cm).map(([u]) => nino ? `US ${u}` : `US ${u} ${tipo.slice(-1)}`));
  return [...new Set(us)].join(' · ');
};

/** Todo lo que se puede guardar en `productos.talla`. */
export const TALLAS = [
  ...TALLAS_ADULTO,
  ...TALLAS_CALZADO_ADULTO,
  ...TALLAS_CALZADO_NINO.map((talla) => `Niño ${talla}`),
  ...EDADES_NINO.flatMap((edad) => [`Niño ${edad}`, ...TALLAS_NINO.map((talla) => `Niño ${edad} / ${talla}`)]),
];

export const tallaValida = (talla) => TALLAS.includes(talla);
