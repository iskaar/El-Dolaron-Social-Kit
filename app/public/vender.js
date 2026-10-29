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

// Reglas de Isaac (22/10, #434): apartado en tienda = 15 % por 7 días; envíos los viernes.
const APARTAR = 'Apártala con el 15 % por 7 días: responde con el código.';
// Revendedora (#575): aparta ella misma y sin anticipo; la tienda cobra después.
const APARTAR_REVENDEDORA = 'Apártala: responde con el código.';
const cierre = (revendedora) => `${revendedora ? APARTAR_REVENDEDORA : APARTAR}\n`
  + '🚚 Envíos todos los viernes.\n'
  + '📍 Jardín Hidalgo 129, Soledad · todos los días de 11 a 8';
const unaLinea = (texto) => String(texto ?? '').replace(/\s+/g, ' ').trim();

/** Función pura: el cierre va una sola vez, también al compartir varias piezas. */
export function textoWhatsApp(piezas, revendedora = false) {
  const CIERRE = cierre(revendedora);
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
export const textoSeguimiento = (i, revendedora = false) => `Hola ${i.cliente}, la ${i.nombre} ${i.codigo} `
  + (i.disponibilidad === 'Disponible' ? `sigue disponible. ${revendedora ? 'Dime y te la aparto, o' : 'Apártala con el 15 % por 7 días o'} te la enviamos el viernes.`
    : i.disponibilidad === 'Apartada' ? 'está apartada. Te avisamos si vuelve a estar disponible.' : 'ya se vendió. Podemos ayudarte a buscar otra pieza.');

/* ---------- Revendedoras (#579): textos y estados que no dependen del DOM ---------- */

const ZONA = 'America/Mexico_City';
const partes = (valor, opciones) => Object.fromEntries(new Intl.DateTimeFormat('es-MX', { timeZone: ZONA, hourCycle: 'h23', ...opciones })
  .formatToParts(new Date(valor)).map((p) => [p.type, p.value]));

/** «2:35 p. m.» en la hora de la tienda; a mano porque cada motor escribe distinto «p.m.». */
export function horaLegible(valor) {
  const { hour, minute } = partes(valor, { hour: 'numeric', minute: '2-digit' });
  const h = Number(hour) % 24;
  return `${h % 12 || 12}:${minute} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** «jueves 30 oct, 2:00 p. m.» */
export function fechaLegible(valor) {
  const { weekday, day, month } = partes(valor, { weekday: 'long', day: 'numeric', month: 'short' });
  return `${weekday} ${day} ${month.replace('.', '')}, ${horaLegible(valor)}`;
}

export const enlaceCliente = (telefono, texto) => `https://wa.me/52${telefono}?text=${encodeURIComponent(texto)}`;

/** Mensaje prellenado para el cliente al que se le apartó una pieza. `pieza`: { nombre, codigo, precio, talla? } en centavos. */
export const textoAvisoCliente = (pieza, cliente, venceEn) => `Hola ${unaLinea(cliente)}, ya te aparté ${unaLinea(pieza.nombre)}`
  + `${pieza.talla ? ` talla ${unaLinea(pieza.talla)}` : ''} (${pieza.codigo}) por ${pesos(pieza.precio)}. `
  + `La tengo apartada hasta el ${fechaLegible(venceEn)} Para pagar, escríbeme y te paso los datos de la tienda.`;

const HORA = 3_600_000;
/** Chip de «Mis ventas»: { clase, texto }. Umbrales: más de 6 h ámbar, 6 h o menos rojo, menos de 1 h «menos de 1 h». */
export function estadoMia(pedido, ahoraMs) {
  if (pedido.estado === 'vendido') return { clase: 'ok', texto: '✓ Cobrada: la tienda ya cobró' };
  if (pedido.estado === 'vencido') return { clase: 'cerrada', texto: '✕ Se venció · la pieza volvió a la venta' };
  if (pedido.estado === 'cancelado') return { clase: 'cerrada', texto: '✕ Cancelada' };
  if (pedido.estado !== 'apartado') return { clase: 'cerrada', texto: String(pedido.estado) };
  if (pedido.saldo > 0) return { clase: 'ok', texto: `✓ La tienda ya registró su pago · Recoger antes del ${fechaLegible(pedido.vence_en)}` };
  const resta = Date.parse(pedido.vence_en) - ahoraMs;
  if (!(resta > 0)) return { clase: 'alerta', texto: '⚠ Ya venció. En unos minutos la pieza vuelve a la venta.' };
  const horas = Math.floor(resta / HORA);
  if (horas < 1) return { clase: 'alerta', texto: '⚠ Se vence pronto · te queda menos de 1 h' };
  return resta <= 6 * HORA ? { clase: 'alerta', texto: `⚠ Se vence pronto · te quedan ${horas} h` }
    : { clase: 'aviso', texto: `⏳ Esperando pago · te quedan ${horas} h` };
}

/** Esperando pago (lo más urgente arriba), Ya pagadas y Anteriores (folio descendente). */
export function agruparMias(pedidos) {
  const porVence = (a, b) => Date.parse(a.vence_en) - Date.parse(b.vence_en);
  const porFolio = (a, b) => b.folio - a.folio;
  const apartados = pedidos.filter((p) => p.estado === 'apartado');
  return {
    esperando: apartados.filter((p) => !(p.saldo > 0)).sort(porVence),
    pagadas: [...apartados.filter((p) => p.saldo > 0).sort(porVence), ...pedidos.filter((p) => p.estado === 'vendido').sort(porFolio)],
    anteriores: pedidos.filter((p) => p.estado !== 'apartado' && p.estado !== 'vendido').sort(porFolio),
  };
}

/** Lo vendido que la tienda ya cobró (centavos). No es comisión. */
export const cobradoMias = (pedidos) => pedidos.filter((p) => p.estado === 'vendido').reduce((suma, p) => suma + p.subtotal, 0);

/** Parte el nombre en hasta `lineasMax` líneas que caben en `anchoMax`; recorta con «…». `ctx`: cualquier objeto con measureText. */
export function partirNombre(ctx, texto, anchoMax, lineasMax) {
  const cabe = (t) => ctx.measureText(t).width <= anchoMax;
  const recortar = (t) => {
    if (cabe(t)) return t;
    let corto = t;
    while (corto && !cabe(`${corto}…`)) corto = corto.slice(0, -1);
    return `${corto.trimEnd()}…`;
  };
  let resto = unaLinea(texto);
  const lineas = [];
  while (resto && lineas.length < lineasMax) {
    if (lineas.length === lineasMax - 1 || cabe(resto)) { lineas.push(recortar(resto)); break; }
    let corte = resto.length;
    while (corte > 1 && !cabe(resto.slice(0, corte))) corte--;
    const espacio = resto.lastIndexOf(' ', corte);
    const fin = espacio > 0 ? espacio : corte;
    lineas.push(resto.slice(0, fin).trimEnd());
    resto = resto.slice(fin).trimStart();
  }
  return lineas;
}

function cargarImagen(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No cargó una foto. Toca «Actualizar» y vuelve a intentar.'));
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
  // Franja azul (y 1000–1350): nombre arriba (1–2 líneas), precio, código + talla abajo y logo a la derecha.
  ctx.fillStyle = '#fff';
  ctx.font = '800 52px system-ui, sans-serif';
  const lineas = partirNombre(ctx, pieza.nombre, 1000, 2);
  lineas.forEach((linea, i) => ctx.fillText(linea, 40, 1060 + i * 56, 1000));
  ctx.fillStyle = '#FFD447';
  ctx.font = '800 100px system-ui, sans-serif';
  ctx.fillText(pesos(pieza.precio), 40, 1222, 560);
  if (pieza.precio_lista > pieza.precio) {
    ctx.fillStyle = '#fff';
    ctx.font = '36px system-ui, sans-serif';
    const antes = pesos(pieza.precio_lista);
    ctx.fillText(antes, 640, 1197, 400);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(640, 1185);
    ctx.lineTo(640 + Math.min(ctx.measureText(antes).width, 400), 1185);
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.font = '700 44px system-ui, sans-serif';
  ctx.fillText(pieza.codigo, 40, 1300, 330);
  if (pieza.talla) {
    const xTalla = 40 + Math.min(ctx.measureText(pieza.codigo).width, 330) + 28;
    ctx.font = '40px system-ui, sans-serif';
    ctx.fillText(`Talla ${pieza.talla}`, xTalla, 1300, 640 - xTalla - 16);
  }
  // El logo ya trae su contorno blanco: va directo sobre el azul, sin cuadro, alineado a la derecha.
  const escalaLogo = 380 / logo.naturalWidth;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(logo, 660, 1228, logo.naturalWidth * escalaLogo, logo.naturalHeight * escalaLogo);
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
      throw new Error('No se pudo abrir WhatsApp. Abre “¿No se abrió WhatsApp?” abajo.');
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
