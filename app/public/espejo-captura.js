/**
 * Espejo de captura (Issue #775): la PC y el celular de la misma cuenta ven y trabajan la misma tarjeta de Capturar.
 * Solo viaja un puntero a la tarjeta (`PUT /api/captura/espejo`); Guardar, foto, existencia y precio siguen por sus rutas,
 * que el servidor autoriza. Las reglas puras (serializar, cuándo aplicar) se prueban en src/espejo-captura-js.test.ts.
 */
const RUTA = '/api/captura/espejo';
const CLAVE_ID = 'espejo-captura-dispositivo', CLAVE_ENCENDIDO = 'espejo-captura-encendido';
export const SONDEO_MS = 2000;
export const RETARDO_MS = 400;
export const RECIENTE_MS = 10 * 60 * 1000;
// Campos de una tarjeta que aún no es pieza registrada (`nueva`, `sin-registro`). Sin nodos ni funciones.
const TARJETA = ['tipo', 'id', 'upc', 'ficha', 'enCamino', 'cantidad', 'estado', 'estadoInicial', 'nombre', 'precio', 'talla', 'tallaClave', 'tallaRotulo', 'textoNumero', 'otraTalla', 'revision'];

let respaldoId, forzado = null;
/** Identidad de este aparato para ignorar el eco de sus propias escrituras. */
export function dispositivoId() {
  try { let v = localStorage.getItem(CLAVE_ID); if (!v) { v = crypto.randomUUID(); localStorage.setItem(CLAVE_ID, v); } return v; }
  catch { return respaldoId ??= crypto.randomUUID(); }
}
export function espejoEncendido() {
  if (forzado !== null) return forzado;
  try { return localStorage.getItem(CLAVE_ENCENDIDO) !== 'false'; } catch { return true; }
}
export function fijarEspejo(encendido) { forzado = !!encendido; try { localStorage.setItem(CLAVE_ENCENDIDO, String(forzado)); } catch { /* vale para esta pestaña */ } }
export const textoChip = () => `Espejo · ${espejoEncendido() ? 'Encendido' : 'Apagado'}`;

/**
 * La tarjeta actual como JSON. Una pieza registrada viaja solo por su id (el otro aparato la recarga de D1 y no ve datos viejos);
 * una pieza por guardar lleva lo que se ve y se edita. Vacío `{}` = sin tarjeta.
 */
export function serializar(a) {
  if (!a) return {};
  if (a.tipo === 'nueva' || a.tipo === 'sin-registro') {
    const e = {};
    for (const k of TARJETA) if (a[k] !== undefined) e[k] = a[k];
    if (a.revision && a.imagen) e.imagen = a.imagen;   // la foto de una pieza por revisar no se puede volver a buscar
    return e;
  }
  if (a.pieza?.id && (a.tipo === 'existente' || a.tipo === 'guardada')) {
    const e = { tipo: a.tipo, pieza_id: a.pieza.id };
    for (const k of ['cantidad', 'impresas', 'faltaEtiqueta', 'refresco']) if (a[k] !== undefined) e[k] = a[k];
    return e;
  }
  return {};
}

/** Una lectura vieja (otro día, otra sesión) no debe aparecer sola al abrir Capturar. */
export const esReciente = (actualizadoEn, ahora) => Date.parse(ahora) - Date.parse(actualizadoEn) < RECIENTE_MS;

/**
 * ¿Hay que aplicar lo que dice el servidor? Solo si es más nuevo que lo que sé, de OTRO aparato (nunca mi eco) y, en la
 * primera lectura tras abrir o encender, si es reciente.
 */
export function debeAplicar(vigente, { version, dispositivo }) {
  if (version === null) return vigente.version > 0 && vigente.dispositivo !== dispositivo && esReciente(vigente.actualizado_en, vigente.ahora);
  return vigente.version > version && vigente.dispositivo !== dispositivo;
}

/**
 * @param {{api: Function, flujo: {actual: Function, retomar: Function, limpiar: Function}, cargarPieza: (id: string) => Promise<object>,
 *   activo: () => boolean, dispositivo?: string, encendido?: () => boolean}} o
 */
export function crearEspejo({ api, flujo, cargarPieza, activo, dispositivo = dispositivoId(), encendido = espejoEncendido }) {
  let version = null, ultimo = null, temporizador = null, enCurso = false, aplicando = false, cola = Promise.resolve();
  async function aplicar(v) {
    const e = v.estado ?? {};
    if (!Object.keys(e).length) { version = v.version; ultimo = JSON.stringify(e); aplicando = true; try { flujo.limpiar(); } finally { aplicando = false; } return; }
    let pieza = null;
    if (e.pieza_id) {
      try { pieza = (await cargarPieza(e.pieza_id)).pieza; }
      catch (error) { if (error.status !== 404 && error.status !== 403) return; /* sin red: se reintenta */ }
      if (!pieza) { version = v.version; ultimo = JSON.stringify(e); return; }   // ya no existe: se adopta la versión sin mostrarla
    }
    version = v.version; ultimo = JSON.stringify(e);   // antes de pintar: lo que se pinta no se vuelve a publicar
    const { pieza_id, ...resto } = e;
    aplicando = true;
    try { flujo.retomar(pieza ? { ...resto, pieza } : { ...resto, ...(e.revision || e.imagen ? { imagenBuscada: true } : {}) }, true); } finally { aplicando = false; }
  }
  async function publicar(estado) {
    if (version === null || !encendido()) return;
    const e = estado ?? serializar(flujo.actual()), js = JSON.stringify(e);
    if (js === ultimo) return;
    try { const r = await api(RUTA, { version_esperada: version, estado: e, dispositivo }, 'PUT'); version = r.version; ultimo = js; }
    catch (error) {
      const v = error.status === 409 && error.datos?.vigente;
      if (!v) return;   // sin red o tarjeta rechazada: el siguiente cambio lo intenta de nuevo
      if (v.dispositivo === dispositivo) { version = v.version; ultimo = JSON.stringify(v.estado); } else await aplicar(v);   // gana lo último que quedó
    }
  }
  const encolar = (estado) => { cola = cola.then(() => publicar(estado)).catch(() => {}); return cola; };
  return {
    /** La tarjeta cambió (pintar, o nombre/precio al terminar de editar): se junta con los cambios seguidos y se publica. */
    cambio() { if (aplicando || version === null || !encendido()) return; clearTimeout(temporizador); temporizador = setTimeout(() => { temporizador = null; void encolar(); }, RETARDO_MS); },
    /** Una foto subida desde este aparato: el otro ve la pieza ya registrada, con foto. */
    pieza(id) { clearTimeout(temporizador); temporizador = null; return encolar({ tipo: 'existente', pieza_id: id, refresco: Date.now() }); },   // `refresco`: aunque ya se mostraba esa pieza, el otro aparato la recarga con su foto nueva
    async sondear() {
      if (!encendido()) { version = null; return; }
      if (enCurso || temporizador || !activo()) return;
      enCurso = true;
      try {
        await cola;
        const v = await api(RUTA);
        if (debeAplicar(v, { version, dispositivo })) await aplicar(v);
        else if (version === null || v.version > version) { version = v.version; ultimo = JSON.stringify(v.estado); }
      } catch { /* sin red: se vuelve a preguntar */ }
      finally { enCurso = false; }
    },
    publicar: encolar,
    version: () => version,
  };
}
