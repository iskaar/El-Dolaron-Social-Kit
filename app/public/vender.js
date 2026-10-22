/** Compartir desde caja (#431). Los precios siempre llegan en centavos enteros. */
export const pesos = (centavos) => `$${(centavos / 100).toLocaleString('es-MX', {
  minimumFractionDigits: centavos % 100 ? 2 : 0, maximumFractionDigits: 2,
})}`;

/** Vacío es opcional; null es inválido. Acepta formato mexicano con +52. */
export function telefonoInteresado(valor) {
  if (typeof valor !== 'string' || valor.length > 24 || !/^[\d\s()+.\-]*$/.test(valor)) return null;
  let digitos = valor.replace(/\D/g, '');
  if (!valor.trim()) return '';
  if (digitos.length === 12 && digitos.startsWith('52')) digitos = digitos.slice(2);
  return /^\d{10}$/.test(digitos) ? digitos : null;
}

/** Permite pegar «quiero la ED-000123» o leer los números de la etiqueta. */
export function codigoDeRespuesta(texto) {
  // Los clientes escriben «ED-2335» sin ceros; la etiqueta dice ED-002335 (mismo relleno que caja y pedidos).
  const digitos = /\bED-(\d{1,10})\b/i.exec(texto)?.[1] ?? /^\s*(\d{1,10})\s*$/.exec(texto)?.[1];
  return digitos ? `ED-${digitos.padStart(6, '0')}` : null;
}

const CIERRE = 'Apártala con $100 por 7 días: responde con el código.\n'
  + '📍 Jardín Hidalgo 129, Soledad · todos los días de 11 a 8';
const unaLinea = (texto) => String(texto ?? '').replace(/\s+/g, ' ').trim();

/** Función pura: el cierre va una sola vez, también al compartir varias piezas. */
export function textoWhatsApp(piezas) {
  if (!piezas.length || piezas.length > 10) throw new Error('Selecciona de 1 a 10 piezas.');
  if (piezas.length > 1) return piezas.map((p) => `${p.codigo} · ${unaLinea(p.nombre)} · ${pesos(p.precio)}`).join('\n') + `\n${CIERRE}`;
  const p = piezas[0];
  return `🛍️ ${unaLinea(p.nombre)}${p.talla ? ` · Talla ${unaLinea(p.talla)}` : ''}\n`
    + `💵 ${pesos(p.precio)}${p.precio_lista > p.precio ? ` (antes ${pesos(p.precio_lista)})` : ''}\n`
    + `🔖 ${p.codigo}\n${CIERRE}`;
}

export const enlaceApartar = (i) => '/pedidos?' + new URLSearchParams({
  codigo: i.codigo, cliente: i.cliente, telefono: i.telefono,
});

/** No promete disponibilidad si la pieza ya quedó apartada o vendida. */
export const textoSeguimiento = (i) => `Hola ${i.cliente}, la ${i.nombre} ${i.codigo} `
  + (i.disponibilidad === 'Disponible' ? 'sigue disponible. Apártala con $100 por 7 días en El Dolarón.'
    : i.disponibilidad === 'Apartada' ? 'está apartada. Te avisamos si vuelve a estar disponible.' : 'ya se vendió. Podemos ayudarte a buscar otra pieza.');

function cargarImagen(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo cargar la foto o el logo. Actualiza e intenta otra vez.'));
    img.src = src;
  });
}

/** Se prepara antes del toque final: iPhone necesita el gesto para navigator.share. */
export async function crearTarjeta(pieza) {
  const [foto, logo] = await Promise.all([cargarImagen(pieza.foto), cargarImagen('/el-dolaron-logo.png')]);
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 1080, 1350);
  const escala = Math.min(1000 / foto.naturalWidth, 938 / foto.naturalHeight);
  const ancho = foto.naturalWidth * escala, alto = foto.naturalHeight * escala;
  ctx.drawImage(foto, (1080 - ancho) / 2, 28 + (938 - alto) / 2, ancho, alto);
  ctx.fillStyle = '#16366B';
  ctx.fillRect(0, 1000, 1080, 350);
  ctx.fillStyle = '#FFD447';
  ctx.font = '800 112px system-ui, sans-serif';
  ctx.fillText(pesos(pieza.precio), 40, 1120, 630);
  if (pieza.precio_lista > pieza.precio) {
    ctx.fillStyle = '#fff';
    ctx.font = '36px system-ui, sans-serif';
    const antes = pesos(pieza.precio_lista);
    ctx.fillText(antes, 720, 1100, 320);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(720, 1088);
    ctx.lineTo(720 + Math.min(ctx.measureText(antes).width, 320), 1088);
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.font = '700 58px system-ui, sans-serif';
  ctx.fillText(pieza.codigo, 40, 1210, 990);
  ctx.font = '40px system-ui, sans-serif';
  if (pieza.talla) ctx.fillText(`Talla ${pieza.talla}`, 40, 1300, 530);
  // El logo oficial se conserva completo sobre blanco para que su azul sea legible.
  ctx.fillRect(620, 1230, 420, 92);
  const escalaLogo = Math.min(390 / logo.naturalWidth, 76 / logo.naturalHeight);
  ctx.drawImage(logo, 635, 1238, logo.naturalWidth * escalaLogo, logo.naturalHeight * escalaLogo);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('No se pudo preparar la tarjeta. Intenta otra vez.');
  return new File([blob], `${pieza.codigo}.jpg`, { type: 'image/jpeg' });
}

/** Copia ANTES del envío: WhatsApp en iPhone a veces omite el texto junto a archivos. */
export async function compartirTarjetas(files, texto) {
  if (!files.length || files.length > 10) throw new Error('Comparte de 1 a 10 tarjetas.');
  let copiado = false;
  try { await navigator.clipboard.writeText(texto); copiado = true; } catch { /* el texto queda visible para copiar a mano */ }
  if (navigator.canShare?.({ files }) && navigator.share) {
    try {
      await navigator.share({ files, text: texto });
      return { compartida: true, copiado };
    } catch (error) {
      if (error.name === 'AbortError') return { compartida: false, copiado };
      throw new Error('No se pudo compartir. Intenta de nuevo o usa «Descargar y abrir WhatsApp».');
    }
  }
  descargarTarjetas(files, texto);
  return { compartida: true, copiado, descarga: true };
}

export function descargarTarjetas(files, texto) {
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
}
