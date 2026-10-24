/**
 * La PC pide una foto y el celular la toma (Issue #444). Reutilizable por
 * /admin hoy y por las pantallas de inventario después: pedirFoto() dibuja su
 * propio panel, sigue la solicitud y devuelve el resultado. La foto sube desde
 * el celular por POST /api/borradores; aquí solo viaja la señal.
 */
import { SONDEO_PC_MS, SIN_RESPUESTA_MS, desfase, estadoDe, segundosRestantes, reloj } from '/camara-remota.js';

const RUTA = '/api/camara/solicitud';
const JSON_HEADERS = { 'content-type': 'application/json' };
const TEXTOS = {
  pendiente: 'Esperando al celular…',
  tomada: 'El celular está tomando la foto…',
  vencida: 'La solicitud venció.',
  cancelada: 'Se canceló.',
};
const SIN_RESPUESTA = 'El celular no responde: abre «Cámara para la PC» y deja la pantalla encendida.';

/**
 * @param {{tipo: 'foto_pieza'|'pieza_nueva', pieza_id: string, params?: object, titulo?: string, contenedor: Element}} datos
 * @returns {Promise<{estado: 'lista'|'cancelada'|'vencida'|'error', motivo: string}>}
 *   «lista» = la foto ya está en la pieza; el llamador solo la vuelve a pedir al servidor.
 */
export function pedirFoto({ tipo, pieza_id, params = {}, titulo, contenedor }) {
  const id = crypto.randomUUID();
  const panel = document.createElement('div');
  const texto = document.createElement('span');
  const cancelar = document.createElement('button');
  panel.className = 'panel-celular';
  panel.setAttribute('aria-live', 'polite');
  cancelar.type = 'button'; cancelar.className = 'claro'; cancelar.textContent = 'Cancelar';
  panel.append(texto, ' ', cancelar);
  contenedor.replaceChildren(panel);

  return new Promise((resolver) => {
    let temporizador;
    let fin = false;
    let desfaseMs = 0;
    let desde = Date.now();
    const terminar = (estado, motivo = '') => {
      if (fin) return;
      fin = true; clearTimeout(temporizador);
      texto.textContent = estado === 'lista' ? 'Foto recibida.' : motivo || TEXTOS[estado] || 'No se pudo.';
      cancelar.remove();
      resolver({ estado, motivo });
    };
    cancelar.addEventListener('click', async () => {
      cancelar.disabled = true;
      // El celular pudo subir la foto justo ahora: lo que diga el servidor manda.
      await fetch(`${RUTA}/${id}/cancelar`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ motivo: 'La PC la canceló.' }) })
        .then((r) => r.json()).then((d) => terminar(d.solicitud?.estado === 'lista' ? 'lista' : 'cancelada', 'Se canceló.'))
        .catch(() => { cancelar.disabled = false; });
    });

    const pintar = (s, ahora) => {
      if (fin) return;
      if (!s || s.id !== id) return terminar('cancelada', 'Otra solicitud reemplazó a esta.');
      desfaseMs = desfase(ahora, Date.now());
      const estado = estadoDe(s, desfaseMs, Date.now());
      if (estado === 'lista') return terminar('lista');
      if (estado === 'cancelada') return terminar('cancelada', s.motivo || TEXTOS.cancelada);
      if (estado === 'vencida') return terminar('vencida');
      const falta = reloj(segundosRestantes(s, desfaseMs, Date.now()));
      texto.textContent = estado === 'pendiente' && Date.now() - desde > SIN_RESPUESTA_MS
        ? `${SIN_RESPUESTA} (${falta})` : `${TEXTOS[estado]} ${falta}`;
    };

    const sondear = async () => {
      try {
        const r = await fetch(RUTA, { cache: 'no-store' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        pintar(d.solicitud, d.ahora);
      } catch {
        texto.textContent = 'Sin conexión con el servidor; reintentando…';
      }
      if (!fin) temporizador = setTimeout(sondear, SONDEO_PC_MS);
    };

    // El PUT repite con el mismo id si la red falla: no duplica ni cambia el resultado.
    (async () => {
      texto.textContent = 'Pidiendo la foto al celular…';
      for (let intento = 0; intento < 3 && !fin; intento++) {
        try {
          const r = await fetch(RUTA, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ id, tipo, pieza_id, params, titulo }) });
          const d = await r.json();
          if (!r.ok) return terminar('error', d.error ?? 'No se pudo pedir la foto.');
          desde = Date.now();
          pintar(d.solicitud, d.ahora);
          return sondear();
        } catch {
          await new Promise((ok) => setTimeout(ok, 1000 * (intento + 1)));
        }
      }
      terminar('error', 'Sin conexión: no se pudo pedir la foto.');
    })();
  });
}
