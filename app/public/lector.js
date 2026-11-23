/** Un receptor de teclado para las pantallas de inventario. Enter de lectura no pulsa botones. */
/** Hueco máximo (ms) entre teclas de una ráfaga de lector; más lento es una persona. */
export const HUECO_LECTOR = 50;
/**
 * `libre` (solo la caja): función que dice si el lector puede actuar. Con ella, una ráfaga que termina en Enter entra aunque el foco esté en
 * un botón, un select o cualquier campo (el campo vuelve a su valor de antes de la ráfaga); un campo con `data-lector-propio` y las ventanas
 * abiertas (`libre()` falso) no se tocan. Sin `libre`, nada cambia.
 */
export function crearLector({ emitir, caja = null, libre = null, ahora = () => performance.now(), esperar = setTimeout, cancelar = clearTimeout }) {
  let texto = '', ultima = -Infinity, rapido = true, timer, consumida = false, previo = null;
  const limpiar = () => { texto = ''; rapido = true; previo = null; cancelar(timer); };
  // El campo donde cayó la ráfaga queda como estaba al empezarla; 'input' y 'change' para que la pantalla recalcule (p. ej. el cambio).
  const restaurar = () => {
    if (!previo) return;
    previo.campo.value = previo.valor;
    for (const tipo of ['input', 'change']) previo.campo.dispatchEvent?.(new Event(tipo, { bubbles: true }));
  };
  const enviar = (codigo, origen) => { if (codigo.trim()) return emitir({ codigo: codigo.trim(), origen }); };
  return {
    tecla(e) {
      if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      const editable = e.target?.closest?.('input,textarea,select,[contenteditable="true"]');
      if (libre ? !libre() || e.target?.closest?.('[data-lector-propio]') : editable && editable !== caja) { limpiar(); return; }
      if (e.key === 'Escape') { limpiar(); if (caja) caja.value = ''; return; }
      if (e.key === 'Enter') {
        const enCaja = caja && editable === caja;
        const codigo = enCaja ? caja.value : texto;
        if (!codigo && !consumida) return;
        // Con `libre`, solo una ráfaga (rápida, 4 caracteres o más) es lectura; una persona que teclea y da Enter conserva su Enter.
        if (libre && codigo && !(rapido && codigo.length >= 4)) { limpiar(); return; }
        e.preventDefault(); e.stopImmediatePropagation?.();
        restaurar();   // antes de emitir: el destino del código puede escribir en ese mismo campo (p. ej. #socio)
        if (codigo) enviar(codigo, enCaja && !rapido ? 'caja' : 'usb');
        if (caja) caja.value = '';
        consumida = false; limpiar(); return;
      }
      if (libre && e.key === 'Shift') return;   // un lector que manda mayúsculas con Shift no parte la ráfaga
      if (!(libre ? /^\S$/ : /^[\da-z-]$/i).test(e.key)) { limpiar(); return; }   // con `libre` también entran los signos de la URL del QR de un vale
      const t = ahora(), hueco = t - ultima;
      if (hueco > 250) limpiar();
      if (!texto && libre && editable && typeof editable.value === 'string' && !['checkbox', 'radio', 'file'].includes(editable.type)) previo = { campo: editable, valor: editable.value };
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

export function escucharLector(alLeer, { caja = null, libre = null, destino = document } = {}) {
  const lector = crearLector({ emitir(detalle) {
    if (typeof CustomEvent !== 'undefined') destino.dispatchEvent?.(new CustomEvent('lectura', { detail:detalle }));
    return alLeer(detalle);
  }, caja, libre });
  const tecla = (e) => lector.tecla(e);
  destino.addEventListener('keydown', tecla, true);
  return { ...lector, cerrar() { lector.limpiar(); destino.removeEventListener('keydown', tecla, true); } };
}
