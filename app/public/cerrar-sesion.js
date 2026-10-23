// «Cerrar sesión» del personal (Issue #463). La identidad es de Cloudflare Access: el Worker no pone
// cookie propia, así que salir es ir a /cdn-cgi/access/logout (lo atiende Cloudflare, no el Worker).
// Lo único propio que se limpia es el turno del cajero (PIN). Nunca se borra IndexedDB ni la caché:
// lo que esté en cola se queda y lo sube la siguiente cuenta, por eso se avisa antes.
import { pendientes as fotosEnCola } from './cola-fotos.js';

export const SALIDA = '/cdn-cgi/access/logout';

/** Texto de la advertencia, o '' si no hay nada sin subir. */
export function avisoPendientes({ fotos = 0, ventas = 0 }) {
  const partes = [];
  if (fotos) partes.push(`${fotos} ${fotos === 1 ? 'foto' : 'fotos'}`);
  if (ventas) partes.push(`${ventas} ${ventas === 1 ? 'venta' : 'ventas'}`);
  return partes.length
    ? `Hay ${partes.join(' y ')} sin subir. Si cierras sesión, se subirán con la siguiente cuenta que entre. Mejor espera a que suban. ¿Cerrar de todos modos?`
    : '';
}

/** Ventana propia (no confirm() nativo, que congela la pestaña). Esc o «Espera» = false. */
export function confirmarSalida(texto) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog'), f = document.createElement('form'), p = document.createElement('p');
    d.style.cssText = 'border:0;border-radius:14px;padding:18px 20px;width:min(440px,94vw);font:16px system-ui,sans-serif';
    f.method = 'dialog'; p.textContent = texto;
    for (const [valor, etiqueta] of [['espera', 'Espera a que suban'], ['salir', 'Cerrar de todos modos']]) {
      const b = document.createElement('button');
      b.value = valor; b.textContent = etiqueta; b.style.cssText = 'padding:10px 14px;margin:6px 8px 0 0;font:inherit';
      f.append(b);
    }
    d.append(p, f); document.body.append(d);
    d.addEventListener('close', () => { d.remove(); resolve(d.returnValue === 'salir'); });
    d.showModal();
  });
}

/**
 * @param ventas  async () => número de ventas sin enviar (sólo la caja las tiene)
 * @param confirmar  async (texto) => boolean; por omisión la ventana propia
 * @returns true si salió, false si la persona decidió esperar
 */
export async function cerrarSesion({ ventas = async () => 0, confirmar = confirmarSalida, irA = (url) => location.assign(url) } = {}) {
  // Si no se pueden leer las colas no hay nada que avisar: salir no debe quedar bloqueado por eso.
  const fotos = await fotosEnCola().then((r) => r.length, () => 0);
  const aviso = avisoPendientes({ fotos, ventas: await ventas().catch(() => 0) });
  if (aviso && !(await confirmar(aviso))) return false;
  // Turno del cajero (PIN): que no lo herede la siguiente cuenta de esta computadora.
  try {
    const turno = JSON.parse(localStorage.getItem('cajero-en-turno'));
    localStorage.removeItem('cajero-en-turno');
    if (turno?.token) await fetch('/api/cajeros/salir', { method: 'POST', headers: { 'x-cajero': turno.token } }).catch(() => {});
  } catch { /* sin localStorage o turno ilegible: nada que cerrar */ }
  irA(SALIDA);
  return true;
}
