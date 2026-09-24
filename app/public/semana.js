/**
 * Semana ISO de una fecha, como 'S37'. Va impresa en la etiqueta y no se
 * corrige despues: habilita rebajas por antiguedad sin reetiquetar nada.
 * Compartida entre el servidor (worker.ts) y el navegador (p.ej. /bandas, que
 * necesita "la semana de hoy" para el lote que va a imprimir).
 */
export function semanaIngreso(fecha) {
  const d = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()));
  // Jueves de esa semana: define el año ISO al que pertenece.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const primeroDeEnero = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((d.getTime() - primeroDeEnero.getTime()) / 86400000 + 1) / 7);
  return `S${String(semana).padStart(2, '0')}`;
}
