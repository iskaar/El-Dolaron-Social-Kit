/**
 * Funciones puras del Centro de Mando (/cm): conversiones de unidades, fechas en hora
 * de la tienda (UTC-6), armado de payload por diferencias y filtro de búsqueda.
 */

const MX_MS = 6 * 3_600_000;

/** Centavos enteros -> cadena en pesos ("18.50" o "500"). Vacío si null/undefined/"". */
export function pesosDeCentavos(centavos) {
  if (centavos === null || centavos === undefined || centavos === '') return '';
  const n = Number(centavos);
  if (!Number.isFinite(n)) return '';
  if (n % 100 === 0) return String(n / 100);
  return (n / 100).toFixed(2);
}

/** Cadena en pesos -> centavos enteros; null si vacío; NaN si inválido o negativo. */
export function centavosDePesos(texto) {
  const t = String(texto ?? '').trim();
  if (t === '') return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(t)) return Number.NaN;
  const [ent, dec = ''] = t.split('.');
  return Number(ent) * 100 + Number(dec.padEnd(2, '0'));
}

/** Puntos base (100 = 1 %) -> cadena en %. */
export function pctDeBp(bp) {
  if (bp === null || bp === undefined || bp === '') return '';
  const n = Number(bp);
  if (!Number.isFinite(n)) return '';
  if (n % 100 === 0) return String(n / 100);
  return (n / 100).toFixed(2).replace(/0$/, '');
}

/** Porcentaje ("1.5", "20") -> puntos base enteros; null si vacío; NaN si inválido. */
export function bpDePct(texto) {
  const t = String(texto ?? '').trim().replace(',', '.');
  if (t === '') return null;
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(t)) return Number.NaN;
  const [ent, dec = ''] = t.split('.');
  return Number(ent) * 100 + Number(dec.padEnd(2, '0'));
}

/** ISO UTC -> "YYYY-MM-DDTHH:mm" en hora fija de tienda (UTC-6) para <input type="datetime-local">. */
export function isoAMxLocal(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Date(ms - MX_MS).toISOString().slice(0, 16);
}

/** "YYYY-MM-DDTHH:mm" (hora de tienda UTC-6) -> ISO UTC ("...Z"). "" si vacío; null si inválido. */
export function mxLocalAIso(local) {
  const t = String(local ?? '').trim();
  if (!t) return '';
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3] ?? '00'}.000Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + MX_MS).toISOString();
}

/** ISO UTC -> "YYYY-MM-DD" en hora de tienda (UTC-6). */
export function isoADiaMx(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Date(ms - MX_MS).toISOString().slice(0, 10);
}

/** 20261102 -> "2026-11-02"; 0 o vacío -> "". */
export function bonoDesdeAFecha(n) {
  const s = String(n ?? '');
  if (!/^\d{8}$/.test(s) || s === '00000000') return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** "2026-11-02" -> 20261102; "" -> 0; null si inválido. */
export function fechaABonoDesde(str) {
  const t = String(str ?? '').trim();
  if (!t) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return Number(t.replace(/-/g, ''));
}

const igual = (a, b) => (a ?? null) === (b ?? null);

/**
 * Arma { config?, nomina?, env? } únicamente con los campos que cambiaron respecto a `inicial`.
 * Cada sección es un objeto plano clave -> valor.
 */
export function armarPayloadCambios(inicial, actual) {
  const payload = {};
  for (const seccion of ['config', 'nomina', 'env']) {
    const base = inicial?.[seccion] ?? {};
    const nuevo = actual?.[seccion] ?? {};
    const diff = {};
    const claves = new Set([...Object.keys(base), ...Object.keys(nuevo)]);
    for (const k of claves) {
      if (!igual(base[k], nuevo[k])) diff[k] = nuevo[k];
    }
    if (Object.keys(diff).length > 0) payload[seccion] = diff;
  }
  return payload;
}

export function contarCambios(payload) {
  let total = 0;
  for (const seccion of ['config', 'nomina', 'env']) {
    if (payload?.[seccion]) total += Object.keys(payload[seccion]).length;
  }
  return total;
}

const normalizar = (texto) => String(texto ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

/** Búsqueda insensible a acentos y mayúsculas. */
export function coincideBusqueda(itemTexto, consulta) {
  const q = normalizar(consulta);
  if (!q) return true;
  return normalizar(itemTexto).includes(q);
}
