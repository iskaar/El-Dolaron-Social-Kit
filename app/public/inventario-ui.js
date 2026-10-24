export const $ = (id) => document.getElementById(id);
export function nodo(tag, texto, clase = '') {
  const el = document.createElement(tag); if (texto !== undefined) el.textContent = texto; el.className = clase; return el;
}
export function boton(texto, accion, clase = '') {
  const b = nodo('button', texto, clase); b.type = 'button';
  b.addEventListener('click', async () => {
    if (b.getAttribute('aria-disabled') === 'true') return mensaje(b.dataset.motivo || 'Espera un momento', 'aviso');
    try { await accion(b); } catch (e) { mensaje(e.message, 'error'); }
  }); return b;
}
let limpiarEstado, neutro = 'Escanea o escribe';
export const ponerNeutro = (texto) => { neutro = texto; };
export const restaurarNeutro = () => mensaje(neutro);
export function mensaje(texto, tipo = 'neutro') {
  clearTimeout(limpiarEstado);
  const error = tipo === 'error', el = $(error ? 'error' : 'estado');
  $('estado').hidden = error; $('error').hidden = !error;
  el.dataset.tipo = tipo;
  el.textContent = `${({ ok:'✓', error:'■', aviso:'▲', etiqueta:'✓' })[tipo] || '●'} ${texto}`;
  if (tipo === 'ok' || tipo === 'etiqueta') limpiarEstado = setTimeout(() => mensaje(neutro), 5000);
}
let disparador;
export function hoja(titulo, contenido) {
  disparador = document.activeElement; $('hoja-titulo').textContent = titulo;
  $('hoja-cuerpo').replaceChildren(contenido); if (!$('hoja').open) $('hoja').showModal();
}
export const cerrarHoja = () => $('hoja').close();
export function prepararHoja() {
  $('cerrar-hoja').onclick = cerrarHoja;
  $('hoja').addEventListener('close', () => disparador?.focus({ preventScroll:true }));
  $('hoja').addEventListener('click', (e) => { if (e.target === $('hoja')) {
    const r = $('hoja').getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) cerrarHoja();
  } });
}
export function confirmar(texto) {
  return new Promise((resolve) => {
    const contenido = nodo('div'), p = nodo('p', texto);
    contenido.append(p, boton('Confirmar', () => { resolve(true); cerrarHoja(); }, 'primario'));
    hoja('Confirmar', contenido); $('hoja').addEventListener('close', () => resolve(false), { once:true });
  });
}
export function bloquear(b, motivo) {
  b.setAttribute('aria-disabled', String(!!motivo)); b.dataset.motivo = motivo || '';
}
export function stepper(valor, cambiar, { min = 1, max = 99, nombre = 'Cantidad' } = {}) {
  const raiz = nodo('div', undefined, 'stepper'), salida = nodo('output', String(valor)); salida.setAttribute('aria-live', 'off');
  salida.setAttribute('aria-label', nombre); salida.tabIndex = 0;
  const fijar = (n) => { valor = Math.max(min, Math.min(max, n)); salida.value = String(valor); cambiar(valor); };
  const menos = boton('−', () => fijar(valor - 1)), mas = boton('+', () => fijar(valor + 1));
  menos.setAttribute('aria-label', `Menos: ${nombre}`); mas.setAttribute('aria-label', `Más: ${nombre}`);
  for (const [b, paso] of [[menos, -1], [mas, 1]]) {
    let inicio, repetir;
    const parar = () => { clearTimeout(inicio); clearInterval(repetir); };
    b.addEventListener('pointerdown', () => { inicio = setTimeout(() => { repetir = setInterval(() => fijar(valor + paso), 120); }, 500); });
    for (const e of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(e, parar);
  }
  // Escribir el número va en el lugar del número, no en una hoja: dentro de otra hoja (p. ej. «Pieza sin foto») la reemplazaría.
  const editar = () => {
    const input = nodo('input', undefined, 'stepper-entrada'); input.inputMode = 'numeric'; input.value = String(valor); input.setAttribute('aria-label', nombre);
    let hecho = false;
    const cerrar = (aplicar, volver) => {
      if (hecho) return; hecho = true;
      // Solo dígitos; fuera de rango se acota a min/max (fijar).
      if (aplicar && /^\d+$/.test(input.value.trim())) fijar(Number(input.value.trim()));
      input.remove(); salida.hidden = false; if (volver) salida.focus();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cerrar(true, true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar(false, true); } });
    input.addEventListener('blur', () => cerrar(true, false));
    salida.hidden = true; salida.after(input); input.focus(); input.select();
  };
  salida.onclick = editar; salida.onkeydown = (e) => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); editar(); } };
  raiz.append(menos, salida, mas); raiz.poner = fijar; return raiz;
}
