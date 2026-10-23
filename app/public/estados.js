// Condición de la pieza con los grados de LiquiMart (Issue #371). El grado se imprime en la etiqueta (letra A/B/C
// en un recuadro, Issue #453, por instrucción de Isaac; antes no se imprimía).
// A = nuevo y B = dañado de siempre; C es liquidación total y solo se vende en la tienda.
export const ESTADOS = [
  ['nuevo', 'A · Nuevo'],
  ['danado', 'B · Dañado'],
  ['liquidacion', 'C · Liquidación'],
];
export const nombreEstado = (estado) => (ESTADOS.find(([e]) => e === estado) ?? ESTADOS[0])[1];
export const siguienteEstado = (estado) => ESTADOS[(ESTADOS.findIndex(([e]) => e === estado) + 1) % ESTADOS.length][0];
