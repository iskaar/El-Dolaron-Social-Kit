/**
 * Imprimir la etiqueta de una pieza desde el celular, en /escanear (Issue #440). Usa la misma
 * etiquetera.js que /etiquetas (BLE fff0/fff2 + TSPL, calibracion de la base): aqui solo vive la
 * cola de trabajos y la regla para no imprimir doble con la computadora.
 *
 * Cada trabajo es una pieza. Antes de mandar nada se reclama la etiqueta en la base
 * (reclamarEtiquetas): si la computadora u otro celular ya la saco, se omite. Si se corta a media
 * tanda la marca se QUEDA: puede haber salido papel, y la computadora no debe repetirlo. Se
 * recupera desde aqui con «Imprimir las que faltan» o «Reimprimir» (reclaman a la fuerza).
 *
 * `e` es etiquetera.js y `pedir` es fetch; se pasan para probar el flujo sin Bluetooth.
 */
import * as etiquetera from './etiquetera.js';

const horaDe = (iso) => new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

/** Lo que dijo la etiquetera, en palabras para quien esta parado junto a la impresora. */
export function motivoDeCorte(texto) {
  if (/detenido a mano/.test(texto)) return 'Se detuvo a mano.';
  if (/no esta conectada/.test(texto)) return 'La impresora no está conectada.';
  if (/enlace|disconnected|GATT|NetworkError/i.test(texto)) return 'Se perdió la conexión con la impresora (apagada o lejos).';
  return texto ? `La impresora respondió: ${texto}.` : 'No se pudo enviar.';
}

export function crearImpresion({ alCambiar, e = etiquetera, pedir = (...argumentos) => globalThis.fetch(...argumentos) }) {
  const trabajos = new Map();
  let cola = Promise.resolve();   // una pieza a la vez: la impresora es una sola
  const cambiar = (t, campos) => { Object.assign(t, campos); alCambiar({ ...t }); };

  async function correr(t) {
    // Si ya se reclamo (salio, se corto u otro la tenia) un toque nuevo es deliberado: reclamar a la fuerza.
    // Tras una tanda cortada se cuentan las que ya salieron; tras una completa se empieza de cero.
    const forzar = t.forzar;
    const base = ['enviada', 'omitida'].includes(t.estado) ? 0 : t.hechas;
    cambiar(t, { estado: 'imprimiendo', hechas: base, mensaje: 'Preparando la etiqueta…' });
    try {
      if (!e.etiqueteraLista() && !await e.reconectarEtiquetera()) {
        return cambiar(t, { estado: 'sin-impresora', hechas: base, mensaje: 'La impresora no está conectada. Préndela y toca «Conectar impresora»; la etiqueta sale sola.' });
      }
      if (e.envioDetenido()) e.detenerEnvio(false);   // un Detener anterior no debe cortar esta pieza
      const respuesta = await pedir('/api/etiquetas', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [t.id] }),
        signal: AbortSignal.timeout(15000),
      });
      const cuerpo = await respuesta.json().catch(() => null);
      if (!respuesta.ok) throw new Error(cuerpo?.error ?? `Error ${respuesta.status}`);
      const pieza = cuerpo.find((p) => p.id === t.id);
      // Mismas condiciones que la automatica de la computadora (etiquetas.html).
      if (!pieza?.codigo || !pieza.nombre?.trim() || !(pieza.precio > 0) || !(pieza.stock > 0) || pieza.destino !== 'etiqueta') {
        return cambiar(t, { estado: 'error', hechas: base, mensaje: 'La pieza cambió o se canceló y ya no lleva etiqueta. Revísala en la cola de revisión.' });
      }
      const reclamo = await e.reclamarEtiquetas([t.id], { reimprimir: forzar });
      if (!reclamo.reclamadas.includes(t.id)) {
        const marca = reclamo.marcas[t.id];
        t.forzar = true;
        return cambiar(t, { estado: 'omitida', hechas: base, mensaje: marca
          ? `Ya salió desde ${marca.etiqueta_origen === 'pc' ? 'la computadora' : 'un celular'} a las ${horaDe(marca.etiqueta_en)}. Si hace falta otra, toca «Reimprimir».`
          : 'La pieza ya no lleva etiqueta.' });
      }
      t.forzar = true;   // desde aqui la marca es de este envio, salga o no
      const copias = Math.max(1, pieza.stock - base);
      let nuevas = 0;
      const salio = await e.imprimirEtiquetas(
        pieza, copias,
        (hechas) => { nuevas = hechas; cambiar(t, { hechas: base + hechas, mensaje: `Imprimiendo ${base + hechas} de ${pieza.stock}…` }); },
        (segundos) => cambiar(t, { mensaje: `Pausa de ${segundos} s para que la impresora vacíe lo que tiene…` }),
      );
      if (salio) {
        return cambiar(t, { estado: 'enviada', hechas: pieza.stock,
          mensaje: `Enviada: ${pieza.stock} ${pieza.stock === 1 ? 'etiqueta' : 'etiquetas'}. Si no salió el papel, revisa la impresora y toca «Reimprimir».` });
      }
      cambiar(t, { estado: 'cortada', hechas: base + nuevas,
        mensaje: `Se cortó: salieron ${base + nuevas} de ${pieza.stock}. ${motivoDeCorte(e.errorEnvio())} Revisa la impresora y toca «Imprimir las que faltan». La computadora no la repetirá.` });
    } catch (error) {
      const sinRed = error instanceof TypeError || error.name === 'TimeoutError';
      cambiar(t, { estado: 'error', hechas: base, mensaje: sinRed
        ? 'Sin conexión con la tienda. La pieza sigue guardada: toca «Imprimir etiqueta» cuando regrese la red.'
        : `${error.message} La pieza sigue guardada: toca «Imprimir etiqueta» para reintentar.` });
    } finally {
      cambiar(t, { ocupado: false });
    }
  }

  return {
    /** Anota una pieza lista para etiquetar. true si es nueva (si ya estaba, no se vuelve a ofrecer). */
    ofrecer(id, nombre, copias) {
      if (trabajos.has(id)) return false;
      const t = { id, nombre, copias, estado: 'lista', hechas: 0, forzar: false, ocupado: false, mensaje: 'Lista para imprimir.' };
      trabajos.set(id, t);
      alCambiar({ ...t });
      return true;
    },
    /** Pone la pieza en la cola. Si ya salio (o se corto) reclama a la fuerza: es un toque deliberado. */
    imprimir(id) {
      const t = trabajos.get(id);
      if (!t || t.ocupado) return;   // un doble toque no manda dos veces
      cambiar(t, { ocupado: true, mensaje: 'Esperando su turno…' });
      cola = cola.then(() => correr(t));
    },
    /** Al conectar la impresora salen las que esperaban. */
    reanudar() {
      for (const t of trabajos.values()) if (t.estado === 'sin-impresora') this.imprimir(t.id);
    },
    activos: () => [...trabajos.values()].filter((t) => t.ocupado).length,
    detener: () => e.detenerEnvio(),
  };
}
