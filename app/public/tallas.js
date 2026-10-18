/**
 * Tallas de ropa (Issue #218): una sola lista para la captura, el admin y el servidor.
 * Se guarda como texto: "M" de adulto, o "Niño 6 años / S" (la talla de niño es opcional).
 * El separador y los meses van en ASCII: la etiqueta TSPL no imprime acentos ni puntos medios.
 */
export const TALLAS_ADULTO = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
export const EDADES_NINO = ['0-3 meses', '3-6 meses', '6-9 meses', '9-12 meses', '12-18 meses', '18-24 meses',
  '2 años', '3 años', '4 años', '5 años', '6 años', '7 años', '8 años', '10 años', '12 años', '14 años', '16 años'];
export const TALLAS_NINO = ['XS', 'S', 'M', 'L', 'XL'];

/** Todo lo que se puede guardar en `productos.talla`. */
export const TALLAS = [
  ...TALLAS_ADULTO,
  ...EDADES_NINO.flatMap((edad) => [`Niño ${edad}`, ...TALLAS_NINO.map((talla) => `Niño ${edad} / ${talla}`)]),
];

export const tallaValida = (talla) => TALLAS.includes(talla);
