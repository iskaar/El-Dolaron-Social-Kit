/** Modo enfocado de Capturar en el celular (#461): el CSS (`body.enfocado`) oculta lo accesorio;
 *  los problemas críticos que quedarían callados suben a una sola línea con role=alert. */
const CLAVE = 'inventario-enfocado';
export const SIN_AVANCE_MS = 60_000;

/** Pura: textos de los problemas críticos activos; vacío = no hay línea de alerta. */
export function alertasCriticas({ enLinea = true, sinSubir = 0, sinAvanceMs = 0, colaError = false, sesion = false, impresoraFalta = false, errorGuardado = '' } = {}) {
  const a = [];
  if (errorGuardado) a.push(errorGuardado);
  if (sesion) a.push('■ Tu sesión venció · vuelve a entrar');
  else if (colaError) a.push(`■ ${sinSubir} sin subir · error de envío`);
  else if (!enLinea && sinSubir) a.push(`▲ Sin red · ${sinSubir} sin subir`);
  else if (sinSubir && sinAvanceMs >= SIN_AVANCE_MS) a.push(`▲ ${sinSubir} sin subir · la cola no avanza`);
  if (impresoraFalta) a.push('▲ Impresora sin conectar · falta etiqueta');
  return [...new Set(a)];
}

/** `aplica()`: solo celular y modo Capturar. `alCambiar(encendido)`: oculta la navegación y arranca la cámara. */
export function crearEnfocado({ $, problemas, aplica, alCambiar }) {
  let activo = false;
  try { activo = sessionStorage.getItem(CLAVE) === 'true'; } catch {}
  const linea = $('alerta-enfocado'), error = $('error'), encendido = () => activo && aplica();
  function pintar() {
    const lista = encendido() ? alertasCriticas({
      enLinea: navigator.onLine, ...problemas.cola?.(), impresoraFalta: problemas.impresora?.() === true,
      errorGuardado: error.hidden ? '' : error.textContent.trim(),
    }) : [];
    linea.hidden = !lista.length;
    const texto = lista.join(' · '); if (linea.textContent !== texto) linea.textContent = texto;
  }
  function aplicar() {
    const on = encendido();
    document.body.classList.toggle('enfocado', on); $('salir-enfocado').hidden = !on;
    alCambiar(on); pintar();
  }
  function poner(valor) {
    if (valor && !aplica()) return;
    activo = valor; try { sessionStorage.setItem(CLAVE, String(valor)); } catch {}
    aplicar();
    if (!valor) $('menu').focus({ preventScroll: true });
  }
  $('salir-enfocado').onclick = () => poner(false);
  new MutationObserver(pintar).observe(error, { attributes: true, childList: true, characterData: true, subtree: true });
  addEventListener('online', pintar); addEventListener('offline', pintar);
  setInterval(pintar, 2000);
  return { activo: () => activo, encendido, poner, alternar: () => poner(!activo), aplicar, pintar };
}
