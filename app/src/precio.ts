/**
 * Calculo del precio. Funcion pura, sin I/O.
 * Todo en centavos MXN, enteros: nada de flotantes en dinero.
 * Los porcentajes y limites viven en la tabla `config`, nunca aqui.
 */

export type Categoria = 'ropa' | 'hogar' | 'electronica' | 'juguetes' | 'otros';
export type EstadoFisico = 'nuevo' | 'danado';
export type Destino = 'etiqueta' | 'bin_20' | 'bin_40' | 'bin_60';

const REDONDEO = 500; // $5 MXN

/** Redondeo hacia arriba al multiplo de $5, el mismo que usa el calculo automatico. */
export function redondear5(centavos: number): number {
  return Math.ceil(Math.max(0, centavos) / REDONDEO) * REDONDEO;
}

/**
 * Ajusta un precio escrito a mano por el admin.
 * Una pieza en un bin se vende al precio del bin: si el destino es `bin_40`, el
 * precio es $40, aunque en el campo se haya tecleado otra cosa. Un bin con un
 * precio que no es el del bote es una discrepancia que aparece en la caja.
 */
export function ajustarManual({ precio, destino, config }: {
  precio: number;
  destino: Destino;
  config: Record<string, string>;
}): number {
  if (destino === 'etiqueta') {
    return redondear5(precio);
  }
  return entero(config, destino, Number.parseInt(destino.replace('bin_', ''), 10) * 100);
}

export interface EntradaPrecio {
  precioLista: number;
  categoria: string;
  estadoFisico: string;
  config: Record<string, string>;
}

function entero(config: Record<string, string>, clave: string, porDefecto: number): number {
  const valor = Number.parseInt(config[clave] ?? '', 10);
  return Number.isFinite(valor) ? valor : porDefecto;
}

/**
 * precio = precio_lista x %categoria x %danado, redondeado hacia arriba a $5.
 * Si cae en el limite de bin o por debajo, la pieza va al bin mas chico que la cubra
 * y no lleva etiqueta.
 */
export function calcularPrecio({ precioLista, categoria, estadoFisico, config }: EntradaPrecio): {
  precio: number;
  destino: Destino;
} {
  // Sin precio de lista no hay precio: la pieza espera al admin en lugar de
  // caer al bin mas barato. Un articulo de $300 mal leido vendido en $20 es
  // el error que cuesta dinero.
  if (precioLista <= 0) {
    return { precio: 0, destino: 'etiqueta' };
  }

  const pctCategoria = entero(config, `pct_${categoria}`, entero(config, 'pct_otros', 50));
  const pctDanado = estadoFisico === 'danado' ? entero(config, 'pct_danado', 60) : 100;

  const bruto = (Math.max(0, precioLista) * pctCategoria * pctDanado) / 10000;
  const precio = Math.ceil(bruto / REDONDEO) * REDONDEO;

  return conBin(precio, precioLista, config);
}

/** Lo barato va al bote mas chico que lo cubra; lo demas lleva etiqueta. */
function conBin(precio: number, precioLista: number, config: Record<string, string>): {
  precio: number;
  destino: Destino;
} {
  const limite = entero(config, 'limite_bin', 6000);
  if (precio <= limite) {
    const bins: Array<[Destino, number]> = [
      ['bin_20', entero(config, 'bin_20', 2000)],
      ['bin_40', entero(config, 'bin_40', 4000)],
      ['bin_60', entero(config, 'bin_60', 6000)],
    ];
    bins.sort((a, b) => a[1] - b[1]);
    const bin = bins.find(([, monto]) => precio <= monto) ?? bins[bins.length - 1];
    return { precio: bin[1], destino: bin[0] };
  }

  // Nunca por encima del precio de lista.
  return { precio: Math.min(precio, redondear5(precioLista)), destino: 'etiqueta' };
}

/**
 * Precio a partir de lo que propuso el modelo mirando como cobra Isaac.
 * Pasa por las mismas guardas que el calculo por porcentaje: redondeo a $5,
 * nunca por encima del precio de lista, y bin si cae en el limite o debajo.
 */
export function precioDesdeSugerencia({ precioLista, sugerido, config }: {
  precioLista: number;
  sugerido: number;
  config: Record<string, string>;
}): { precio: number; destino: Destino } {
  if (sugerido <= 0) {
    return { precio: 0, destino: 'etiqueta' };
  }
  return conBin(redondear5(sugerido), precioLista, config);
}
