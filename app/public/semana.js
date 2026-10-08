/**
 * Semana ISO de una fecha, como 'S37'. Va impresa en la etiqueta y no se
 * corrige despues: habilita rebajas por antiguedad sin reetiquetar nada.
 * Compartida entre el servidor (worker.ts) y el navegador (p.ej. /bandas, que
 * necesita "la semana de hoy" para el lote que va a imprimir).
 */
// La tienda es UTC-6 fijo (America/Mexico_City desde 2022): el dia se cuenta en su hora, no en UTC.
const MX = -6 * 3_600_000;

export function semanaIngreso(fecha) {
  const local = new Date(fecha.getTime() + MX);
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  // Jueves de esa semana: define el año ISO al que pertenece.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const primeroDeEnero = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((d.getTime() - primeroDeEnero.getTime()) / 86400000 + 1) / 7);
  return `S${String(semana).padStart(2, '0')}`;
}
