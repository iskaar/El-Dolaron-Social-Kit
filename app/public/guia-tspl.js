/**
 * Guía de Mercado Envíos → TSPL BITMAP para la AE240 (Issue #691).
 *
 * La AE240 solo entiende TSPL (sonda del 2026-09-22 y prueba de la guía en ZPL
 * del 2026-11-02: «enviada» y no salió nada). ML entrega la guía en PDF o ZPL,
 * así que el PDF se dibuja en un canvas con pdf.js (vendor/, sin CDN) y se manda
 * como mapa de bits de 1 bit: 800 × 1200 puntos = 100 × 150 mm a 203 dpi.
 */

export const ANCHO_PUNTOS = 800;   // 100 mm × 8 puntos/mm
export const ALTO_PUNTOS = 1200;   // 150 mm
const MEDIDA_GUIA = ['SIZE 100 mm,150 mm', 'GAP 2 mm,0 mm', 'DIRECTION 1', 'CLS'];
const HUECO_MAX = 16;   // filas en blanco que se toleran dentro de un mismo BITMAP antes de partirlo

/**
 * RGBA (ImageData.data) → trabajo TSPL completo en bytes. En TSPL BITMAP un bit 0 imprime punto
 * negro y un 1 lo deja en blanco. Las franjas totalmente blancas no se mandan: por BLE (20 bytes
 * cada 20 ms) cada fila de 100 bytes cuesta ~0.1 s, y una guía tiene mucho blanco.
 * `umbral` 128 es neutro: barras vectoriales de 0.19 mm salieron nítidas en la prueba headless del 2/11.
 * `invertir` es la perilla por si esta unidad resulta leer la polaridad al revés (sale todo negro).
 * ponytail: una sola copia y sin recortar a lo ancho; si tarda demasiado, recortar cada franja.
 */
export function tsplDeImagen(rgba, ancho, alto, { umbral = 128, invertir = false } = {}) {
  const bytesFila = Math.ceil(ancho / 8);
  const filas = new Array(alto);
  for (let y = 0; y < alto; y++) {
    const fila = new Uint8Array(bytesFila).fill(0xff);
    let tinta = false;
    for (let x = 0; x < ancho; x++) {
      const i = (y * ancho + x) * 4;
      const a = rgba[i + 3];
      const luz = a < 128 ? 255 : (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
      if (luz < umbral) { fila[x >> 3] &= ~(0x80 >> (x & 7)); tinta = true; }
    }
    if (invertir) for (let b = 0; b < bytesFila; b++) fila[b] ^= 0xff;
    filas[y] = tinta ? fila : null;
  }
  const texto = new TextEncoder();
  const partes = [texto.encode(`${MEDIDA_GUIA.join('\r\n')}\r\n`)];
  for (let y = 0; y < alto;) {
    if (!filas[y]) { y++; continue; }
    let fin = y, hueco = 0;
    for (let k = y + 1; k < alto && hueco <= HUECO_MAX; k++) {
      if (filas[k]) { fin = k; hueco = 0; } else hueco++;
    }
    const alto_ = fin - y + 1;
    const datos = new Uint8Array(bytesFila * alto_).fill(0xff);
    for (let k = 0; k < alto_; k++) {
      const fila = filas[y + k] ?? (invertir ? new Uint8Array(bytesFila) : null);
      if (fila) datos.set(fila, k * bytesFila);
    }
    partes.push(texto.encode(`BITMAP 0,${y},${bytesFila},${alto_},0,`), datos, texto.encode('\r\n'));
    y = fin + 1;
  }
  partes.push(texto.encode('PRINT 1,1\r\n'));
  const total = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of partes) { total.set(p, o); o += p.length; }
  return total;
}

/**
 * Primera página del PDF → TSPL. Se escala para caber en 100 × 150 mm; si la página viene
 * acostada se gira 90°. pdf.js se carga hasta el primer uso: /mercadolibre no paga sus 1.7 MB al abrir.
 */
export async function tsplDePdf(bytes, opciones) {
  const pdfjs = await import('/vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    const pagina = await pdf.getPage(1);
    const base = pagina.getViewport({ scale: 1 });
    const girar = base.width > base.height ? 90 : 0;
    const [w, h] = girar ? [base.height, base.width] : [base.width, base.height];
    const escala = Math.min(ANCHO_PUNTOS / w, ALTO_PUNTOS / h);
    const vista = pagina.getViewport({ scale: escala, rotation: (pagina.rotate + girar) % 360 });
    const canvas = document.createElement('canvas');
    canvas.width = ANCHO_PUNTOS; canvas.height = ALTO_PUNTOS;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, ANCHO_PUNTOS, ALTO_PUNTOS);
    await pagina.render({ canvasContext: ctx, viewport: vista }).promise;
    return tsplDeImagen(ctx.getImageData(0, 0, ANCHO_PUNTOS, ALTO_PUNTOS).data, ANCHO_PUNTOS, ALTO_PUNTOS, opciones);
  } finally {
    pdf.destroy();
  }
}
