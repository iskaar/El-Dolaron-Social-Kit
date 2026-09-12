/**
 * Code128-B en SVG, sin dependencias.
 * La etiqueta se imprime en papel y la lee el lector de la caja: la codificacion
 * tiene que ser exacta, y bajar una libreria por CDN pondria la impresion de
 * etiquetas a depender de la red de la tienda.
 *
 * Cada patron son anchos de modulo que alternan barra/espacio empezando en barra.
 * El ultimo (106) es la parada, con 7 elementos en lugar de 6.
 */
const PATRONES = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
];

const INICIO_B = 104;
const PARADA = 106;

/** Texto -> secuencia de anchos de modulo, con el digito de control incluido. */
export function anchos(texto) {
  const valores = [...texto].map((caracter) => {
    const codigo = caracter.charCodeAt(0);
    if (codigo < 32 || codigo > 126) {
      throw new Error(`Caracter fuera de Code128-B: ${caracter}`);
    }
    return codigo - 32;
  });

  let suma = INICIO_B;
  valores.forEach((valor, indice) => { suma += valor * (indice + 1); });
  const control = suma % 103;

  return [INICIO_B, ...valores, control, PARADA].map((valor) => PATRONES[valor]).join('');
}

/** SVG listo para imprimir. `modulo` en milimetros: 0.33 mm lee bien en etiqueta chica. */
export function svgCode128(texto, { modulo = 0.33, alto = 12 } = {}) {
  const secuencia = anchos(texto);
  const barras = [];
  let x = 0;
  let esBarra = true;

  for (const ancho of secuencia) {
    const grosor = Number(ancho) * modulo;
    if (esBarra) {
      barras.push(`<rect x="${x.toFixed(3)}" y="0" width="${grosor.toFixed(3)}" height="${alto}"/>`);
    }
    x += grosor;
    esBarra = !esBarra;
  }

  // Zona muda: sin ella el lector no engancha el codigo.
  const muda = 10 * modulo;
  const total = x + muda * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total.toFixed(2)}mm" height="${alto}mm" viewBox="0 0 ${total.toFixed(3)} ${alto}" preserveAspectRatio="none" shape-rendering="crispEdges">
    <rect x="0" y="0" width="${total.toFixed(3)}" height="${alto}" fill="#fff"/>
    <g fill="#000" transform="translate(${muda.toFixed(3)} 0)">${barras.join('')}</g>
  </svg>`;
}
