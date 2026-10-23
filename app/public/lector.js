/** Un receptor de teclado para las pantallas de inventario. Enter de lectura no pulsa botones. */
/** Hueco máximo (ms) entre teclas de una ráfaga de lector; más lento es una persona. */
export const HUECO_LECTOR = 50;
export function crearLector({ emitir, caja = null, ahora = () => performance.now(), esperar = setTimeout, cancelar = clearTimeout }) {
  let texto = '', ultima = -Infinity, rapido = true, timer, consumida = false;
  const limpiar = () => { texto = ''; rapido = true; cancelar(timer); };
  const enviar = (codigo, origen) => { if (codigo.trim()) return emitir({ codigo: codigo.trim(), origen }); };
  return {
    tecla(e) {
      if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      const editable = e.target?.closest?.('input,textarea,select,[contenteditable="true"]');
      if (editable && editable !== caja) { limpiar(); return; }
      if (e.key === 'Escape') { limpiar(); if (caja) caja.value = ''; return; }
      if (e.key === 'Enter') {
        const enCaja = caja && editable === caja;
        const codigo = enCaja ? caja.value : texto;
        if (!codigo && !consumida) return;
        e.preventDefault(); e.stopImmediatePropagation?.();
        if (codigo) enviar(codigo, enCaja && !rapido ? 'caja' : 'usb');
        if (caja) caja.value = '';
        consumida = false; limpiar(); return;
      }
      if (!/^[\da-z-]$/i.test(e.key)) { limpiar(); return; }
      const t = ahora(), hueco = t - ultima;
      if (hueco > 250) limpiar();
      if (texto && hueco > HUECO_LECTOR) rapido = false;
      texto += e.key; ultima = t; consumida = false;
      cancelar(timer);
      // Sin sufijo Enter: solo ráfagas de lector fuera de un campo de edición.
      if (rapido && texto.length >= 4 && !editable) timer = esperar(() => {
        enviar(texto, 'usb'); limpiar(); consumida = true;
      }, 80);
    },
    recibir: enviar,
    limpiar,
  };
}

export function escucharLector(alLeer, { caja = null, destino = document } = {}) {
  const lector = crearLector({ emitir(detalle) {
    if (typeof CustomEvent !== 'undefined') destino.dispatchEvent?.(new CustomEvent('lectura', { detail:detalle }));
    return alLeer(detalle);
  }, caja });
  const tecla = (e) => lector.tecla(e);
  destino.addEventListener('keydown', tecla, true);
  return { ...lector, cerrar() { lector.limpiar(); destino.removeEventListener('keydown', tecla, true); } };
}
