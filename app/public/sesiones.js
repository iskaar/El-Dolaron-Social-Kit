/**
 * Sesiones de captura: no se guarda ninguna, se deducen. Una sesion es una
 * racha de fotos de la misma persona sin un hueco de mas de PAUSA_SESION entre
 * una y la siguiente.
 *
 * ponytail: 30 min es un numero a ojo. Si una sesion real se parte en dos (una
 * comida larga a media captura), subirlo; si se juntan dos, bajarlo.
 */
export const PAUSA_SESION = 30 * 60 * 1000;

/**
 * @param piezas [{ id, capturado_por, creado_en }] en cualquier orden
 * @returns { porPieza: Map<id, clave>, sesiones: [{ clave, quien, inicio, fin, piezas }] } lo mas nuevo primero
 */
export function agruparSesiones(piezas) {
  const orden = [...piezas].sort((a, b) => a.creado_en.localeCompare(b.creado_en));
  const abierta = new Map();   // quien -> sesion en curso
  const sesiones = [];
  const porPieza = new Map();
  for (const p of orden) {
    const quien = p.capturado_por || '';
    const hora = Date.parse(p.creado_en);
    let sesion = abierta.get(quien);
    if (!sesion || hora - Date.parse(sesion.fin) > PAUSA_SESION) {
      sesion = { clave: `${quien}|${p.creado_en}`, quien, inicio: p.creado_en, fin: p.creado_en, piezas: 0 };
      abierta.set(quien, sesion);
      sesiones.push(sesion);
    }
    sesion.fin = p.creado_en;
    sesion.piezas += 1;
    porPieza.set(p.id, sesion.clave);
  }
  return { porPieza, sesiones: sesiones.reverse() };
}
