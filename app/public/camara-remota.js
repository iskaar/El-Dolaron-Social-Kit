/**
 * Reglas puras de la cámara remota (Issue #444), compartidas por el celular
 * (/camara-remota) y la PC (camara-pc.js). Sin DOM ni red: se prueban en
 * src/camara-remota-js.test.ts. El servidor manda en estados y vigencia.
 */
export const SONDEO_CELULAR_MS = 2000;
export const SONDEO_PC_MS = 1500;
export const INACTIVO_MS = 60 * 60 * 1000;
export const SIN_RESPUESTA_MS = 8000;
export const ESPERAS_SUBIDA_MS = [0, 1000, 3000];
export const FALLOS_SIN_SESION = 3;

/** Cuánto adelanta (+) o atrasa (−) el servidor respecto al reloj de este aparato. */
export const desfase = (ahoraServidor, ahoraLocal) => Date.parse(ahoraServidor) - ahoraLocal;

export const abierta = (s) => !!s && (s.estado === 'pendiente' || s.estado === 'tomada');

/** Segundos que le quedan, con la hora del servidor y no con la del celular. */
export function segundosRestantes(s, desfaseMs, ahoraLocal) {
  return Math.max(0, Math.ceil((Date.parse(s.vence_en) - (ahoraLocal + desfaseMs)) / 1000));
}

/** Entre sondeos la vigencia corre sola: pendiente/tomada sin tiempo es «vencida». */
export function estadoDe(s, desfaseMs, ahoraLocal) {
  if (!s) return null;
  return abierta(s) && segundosRestantes(s, desfaseMs, ahoraLocal) === 0 ? 'vencida' : s.estado;
}

/** «1:48» para la cuenta regresiva. */
export const reloj = (segundos) => `${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, '0')}`;

/** El celular se apaga solo tras una hora sin solicitudes (costo de D1 y batería). */
export const inactivo = (ultimaActividad, ahoraLocal) => ahoraLocal - ultimaActividad >= INACTIVO_MS;

/**
 * El mismo FormData que ya entiende POST /api/borradores; no hay endpoint de subida nuevo.
 * foto_pieza -> solo_foto sobre la pieza existente; pieza_nueva -> alta con los params.
 */
export function formularioFoto(s, foto) {
  const f = new FormData();
  f.set('id', s.pieza_id);
  if (s.tipo === 'foto_pieza') {
    f.set('estado_fisico', 'nuevo');
    f.set('solo_foto', '1');
  } else {
    f.set('estado_fisico', s.params.estado_fisico ?? 'nuevo');
    for (const k of ['cantidad', 'upc', 'talla', 'prenda', 'marca', 'precio_ropa']) {
      if (s.params[k] !== undefined) f.set(k, String(s.params[k]));
    }
  }
  f.set('foto', foto, `${s.pieza_id}.jpg`);
  return f;
}
