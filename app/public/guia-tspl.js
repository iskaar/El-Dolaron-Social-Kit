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
 * Recuadro de lo que tiene tinta en una imagen RGBA: { x, y, ancho, alto } en píxeles, o null si
 * está en blanco. El PDF de ML no es una hoja de 10 × 15: viene acostado y la guía ocupa solo una
 * parte (prueba física del 2/11: salió chica, girada y en una esquina). Se recorta a esto antes de escalar.
 */
export function cajaDeTinta(rgba, ancho, alto, umbral = 200) {
  let x0 = ancho, y0 = alto, x1 = -1, y1 = -1;
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const i = (y * ancho + x) * 4;
      if (rgba[i + 3] < 128 || (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000 >= umbral) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, ancho: x1 - x0 + 1, alto: y1 - y0 + 1 };
}

function lienzo(ancho, alto) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(ancho); canvas.height = Math.ceil(alto);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

/**
 * Primera página del PDF → TSPL. Dos pasadas: una baja (2 px por punto) para hallar el recuadro de
 * la guía dentro de la hoja, y otra a la escala justa para que ese recuadro llene 100 × 150 mm; se
 * copia 1:1 (sin volver a escalar, para no emborronar las barras) y se gira 90° si viene acostado.
 * pdf.js se carga hasta el primer uso: /mercadolibre no paga sus 1.7 MB al abrir.
 */
export async function tsplDePdf(bytes, opciones) {
  const pdfjs = await import('/vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    const pagina = await pdf.getPage(1);
    const BAJA = 2, MARGEN = 2;   // px por punto PDF en la pasada baja; puntos PDF de aire alrededor de la tinta
    const vBaja = pagina.getViewport({ scale: BAJA });
    const baja = lienzo(vBaja.width, vBaja.height);
    await pagina.render({ canvasContext: baja.ctx, viewport: vBaja }).promise;
    const caja = cajaDeTinta(baja.ctx.getImageData(0, 0, baja.canvas.width, baja.canvas.height).data, baja.canvas.width, baja.canvas.height);
    if (!caja) throw new Error('el PDF de la guía vino en blanco');
    // Recuadro en puntos PDF, con margen y sin salirse de la hoja.
    const px = Math.max(0, caja.x / BAJA - MARGEN), py = Math.max(0, caja.y / BAJA - MARGEN);
    const pw = Math.min(vBaja.width / BAJA, (caja.x + caja.ancho) / BAJA + MARGEN) - px;
    const ph = Math.min(vBaja.height / BAJA, (caja.y + caja.alto) / BAJA + MARGEN) - py;
    const girar = pw > ph;
    const escala = girar ? Math.min(ANCHO_PUNTOS / ph, ALTO_PUNTOS / pw) : Math.min(ANCHO_PUNTOS / pw, ALTO_PUNTOS / ph);
    const vAlta = pagina.getViewport({ scale: escala });
    const alta = lienzo(vAlta.width, vAlta.height);
    await pagina.render({ canvasContext: alta.ctx, viewport: vAlta }).promise;
    const [sx, sy] = [Math.floor(px * escala), Math.floor(py * escala)];
    const [sw, sh] = [Math.min(Math.ceil(pw * escala), alta.canvas.width - sx), Math.min(Math.ceil(ph * escala), alta.canvas.height - sy)];
    const final = lienzo(ANCHO_PUNTOS, ALTO_PUNTOS);
    if (girar) {
      // 90° a la derecha: el ancho de la guía corre a lo largo de la etiqueta. Centrada.
      final.ctx.translate(ANCHO_PUNTOS - Math.floor((ANCHO_PUNTOS - sh) / 2), Math.floor((ALTO_PUNTOS - sw) / 2));
      final.ctx.rotate(Math.PI / 2);
    } else final.ctx.translate(Math.floor((ANCHO_PUNTOS - sw) / 2), Math.floor((ALTO_PUNTOS - sh) / 2));
    final.ctx.drawImage(alta.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return tsplDeImagen(final.ctx.getImageData(0, 0, ANCHO_PUNTOS, ALTO_PUNTOS).data, ANCHO_PUNTOS, ALTO_PUNTOS, opciones);
  } finally {
    pdf.destroy();
  }
}
