/**
 * Aritmetica de la caja, en centavos enteros.
 * Es la unica parte del sistema donde un error se paga en efectivo, delante del
 * cliente y sin poder corregirlo despues. Vive en public/ porque la caja la usa
 * en el navegador; las pruebas la importan desde aqui.
 */

export function totales(lineas, efectivo = 0) {
  const piezas = lineas.reduce((suma, l) => suma + l.cantidad, 0);
  const total = lineas.reduce((suma, l) => suma + l.precio * l.cantidad, 0);
  const diferencia = efectivo - total;
  return {
    piezas,
    total,
    cambio: Math.max(0, diferencia),
    falta: Math.max(0, -diferencia),
  };
}

/** Agrega una pieza al ticket, juntando lineas repetidas del mismo codigo. */
export function agregar(lineas, pieza) {
  const existente = lineas.find((l) => l.codigo === pieza.codigo && l.precio === pieza.precio);
  if (existente) {
    return lineas.map((l) => (l === existente ? { ...l, cantidad: l.cantidad + 1 } : l));
  }
  return [...lineas, { ...pieza, cantidad: 1 }];
}
