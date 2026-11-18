// Fondo de caja por caja o centralizado (Issue #863).
// `fondo_caja` es el centralizado; `fondo_caja_<caja>` (p. ej. fondo_caja_salk_1) es el propio de una caja y manda sobre el
// centralizado. Lo usan el corte (servidor) y /reportes (donde el dueño lo edita).

/** La clave de `config` con el fondo propio de una caja: «Salk 1» → fondo_caja_salk_1. */
export const claveFondo = (caja) =>
  `fondo_caja_${String(caja ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;

/** Es la clave del fondo propio de una caja (no el centralizado). */
export const esClaveFondoCaja = (clave) => /^fondo_caja_[a-z0-9_]+$/.test(String(clave ?? ''));
