/**
 * Lector de codigos de barras con la camara, para la caja. Complementa al
 * lector USB: mismo resultado (un texto que va a agregarCodigo), otro origen.
 *
 * La libreria (html5-qrcode 2.3.8) va en public/vendor/ y no por CDN, igual que
 * code128.js: el cobro no puede depender de la red de la tienda. Usa
 * BarcodeDetector nativo si el navegador lo trae (Chrome/Android) y ZXing si no.
 */

const LIBRERIA = '/vendor/html5-qrcode.min.js';

/**
 * La camara ve la misma etiqueta en decenas de cuadros por segundo: sin esto,
 * una sola pieza se cobraba varias veces. Las bandas si se cobran en cantidad,
 * asi que pasada la ventana el mismo codigo vuelve a contar. `ultima` es
 * { codigo, en } de la lectura aceptada anterior (o null).
 */
export function lecturaNueva(ultima, codigo, ahora, ventanaMs = 2500) {
  return !ultima || ultima.codigo !== codigo || ahora - ultima.en >= ventanaMs;
}

let cargando = null;
function cargarLibreria() {
  if (window.Html5Qrcode) return Promise.resolve();
  cargando ??= new Promise((ok, falla) => {
    const s = document.createElement('script');
    s.src = LIBRERIA;
    s.onload = ok;
    s.onerror = () => { cargando = null; falla(new Error('No se pudo cargar el lector.')); };
    document.head.append(s);
  });
  return cargando;
}

/**
 * Abre la camara trasera dentro del elemento `idElemento` y llama a
 * `alLeer(codigo)` por cada lectura nueva. Devuelve una funcion que la apaga.
 * Falla (promesa rechazada) con un mensaje listo para mostrar.
 */
export async function abrirCamara(idElemento, alLeer) {
  await cargarLibreria();
  const { Html5Qrcode, Html5QrcodeSupportedFormats } = window;
  const lector = new Html5Qrcode(idElemento, {
    formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128],
    useBarCodeDetectorIfSupported: true,
    verbose: false,
  });
  let ultima = null;
  try {
    await lector.start(
      { facingMode: 'environment' },
      // Caja ancha y baja: un Code128 es una tira, no un cuadrado.
      { fps: 10, qrbox: (ancho, alto) => ({ width: Math.floor(ancho * 0.9), height: Math.floor(alto * 0.45) }) },
      (texto) => {
        const codigo = texto.trim();
        const ahora = Date.now();
        if (!codigo || !lecturaNueva(ultima, codigo, ahora)) return;
        ultima = { codigo, en: ahora };
        alLeer(codigo);
      },
      () => {}, // cuadro sin codigo: lo normal, no es un error
    );
  } catch (e) {
    const negada = /permission|denied|notallowed/i.test(String(e));
    throw new Error(negada
      ? 'El navegador no dejó usar la cámara. Permítela en el candado de la barra de direcciones.'
      : 'No se pudo abrir la cámara.');
  }
  return async () => {
    try { await lector.stop(); lector.clear(); } catch { /* ya estaba apagada */ }
  };
}
