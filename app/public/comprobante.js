/**
 * Foto del comprobante de una transferencia (#603). Se carga solo cuando el cajero elige una foto (import dinamico):
 * si no hay red o falla, la pantalla sigue con la captura a mano y el cobro nunca se frena. La imagen se reduce a JPEG
 * (1600 px) y el servidor la guarda en privado y la lee; aqui solo se rellenan los campos para que el cajero confirme o corrija.
 */
const LADO_MAX = 1600;

async function aJpeg(archivo) {
  const bitmap = await createImageBitmap(archivo);
  try {
    const escala = Math.min(1, LADO_MAX / Math.max(bitmap.width, bitmap.height));
    const lienzo = document.createElement('canvas');
    lienzo.width = Math.round(bitmap.width * escala);
    lienzo.height = Math.round(bitmap.height * escala);
    lienzo.getContext('2d').drawImage(bitmap, 0, 0, lienzo.width, lienzo.height);
    return await new Promise((resolve) => lienzo.toBlob(resolve, 'image/jpeg', 0.85));
  } finally {
    bitmap.close();
  }
}

/**
 * Sube el archivo del input, rellena los campos que el modelo leyo y deja en input.dataset la foto (key) y la fecha leida:
 * la pagina las manda al guardar. `ids` = { clave, monto, banco, aviso } de la pantalla; `$` = su getElementById.
 */
export async function adjuntar(input, ids, $) {
  const archivo = input.files?.[0];
  input.dataset.key = '';
  input.dataset.fecha = '';
  const aviso = $(ids.aviso);
  if (!archivo) { aviso.textContent = ''; return; }
  aviso.textContent = 'Leyendo el comprobante…';
  try {
    const blob = await aJpeg(archivo);
    const r = await fetch('/api/transferencias/comprobante', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob });
    if (!r.ok) throw new Error(String(r.status));
    const { key, lectura } = await r.json();
    input.dataset.key = key || '';
    input.dataset.fecha = lectura?.fecha || '';
    const leido = [];
    if (lectura?.clave) { $(ids.clave).value = lectura.clave; leido.push('clave de rastreo'); }
    if (lectura?.monto) { $(ids.monto).value = String(lectura.monto / 100); leido.push('monto'); }
    if (lectura?.banco_emisor) { $(ids.banco).value = lectura.banco_emisor; leido.push('banco'); }
    aviso.textContent = leido.length
      ? `Leí del comprobante: ${leido.join(', ')}. Compáralos con el comprobante y corrige lo que haga falta antes de cobrar.`
      : 'No pude leer el comprobante: escribe la clave, el monto y el banco a mano. La foto sí se guardó.';
  } catch {
    input.dataset.key = '';
    aviso.textContent = 'No se pudo subir el comprobante (¿sin red?). Escribe la clave, el monto y el banco a mano.';
  }
}
