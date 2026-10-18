/**
 * Boton «Compartir» de la cola (Issue #130): deja en el portapapeles, uno tras
 * otro, el precio, el nombre y la foto, en el orden en que se pegan en el
 * formulario de Marketplace. El portapapeles del navegador guarda un solo
 * elemento a la vez: los tres se conservan solo si el historial de Windows
 * esta prendido (Win+V; arriba queda la foto, luego nombre y precio).
 */
const PAUSA_MS = 300;   // que Windows registre cada copia como elemento aparte
const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** El portapapeles solo acepta PNG; la foto de la pieza es JPEG. */
function fotoPng(img) {
  const lienzo = document.createElement('canvas');
  lienzo.width = img.naturalWidth;
  lienzo.height = img.naturalHeight;
  lienzo.getContext('2d').drawImage(img, 0, 0);
  return new Promise((resolve) => lienzo.toBlob(resolve, 'image/png'));
}

/** `precio` en pesos enteros, sin signo: es lo que acepta el campo de Marketplace. */
export async function copiarParaMarketplace({ img, nombre, precio }) {
  // Primero la foto: los permisos del clic duran unos segundos y esto es rapido.
  const png = img?.complete && img.naturalWidth ? await fotoPng(img) : null;
  await navigator.clipboard.writeText(String(precio));
  await espera(PAUSA_MS);
  await navigator.clipboard.writeText(nombre);
  if (png) {
    await espera(PAUSA_MS);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  }
  return { conFoto: Boolean(png) };
}
