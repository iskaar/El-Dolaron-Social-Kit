/**
 * Reduccion de la foto, compartida por la captura y por el retome del admin.
 * Un solo lugar con estas medidas: si la captura encoge a 1024 y el retome
 * subiera el original del telefono, la misma pieza tendria dos calidades y el
 * retome chocaria con el limite de peso del Worker.
 */
export const LADO_MAX = 1024;
export const CALIDAD = 0.8;

/** Dibuja cualquier fuente (video, imagen, bitmap) en JPEG reducido. */
export function aJpeg(fuente, ancho, alto) {
  const escala = Math.min(1, LADO_MAX / Math.max(ancho, alto));
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.round(ancho * escala);
  lienzo.height = Math.round(alto * escala);
  lienzo.getContext('2d').drawImage(fuente, 0, 0, lienzo.width, lienzo.height);
  return new Promise((resolve) => lienzo.toBlob(resolve, 'image/jpeg', CALIDAD));
}

/** Un archivo del selector o de la camara del telefono. */
export async function reducirArchivo(archivo) {
  const bitmap = await createImageBitmap(archivo);
  try {
    return await aJpeg(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
