/**
 * Calculo del precio. Funcion pura, sin I/O.
 * Todo en centavos MXN, enteros: nada de flotantes en dinero.
 * Los porcentajes y limites viven en la tabla `config`, nunca aqui.
 */

export type Categoria = 'ropa' | 'hogar' | 'electronica' | 'juguetes' | 'otros';
export type EstadoFisico = 'nuevo' | 'danado';
export type Destino = 'etiqueta' | 'bin_20' | 'bin_40' | 'bin_60';

const REDONDEO = 500; // $5 MXN

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
  return { precio: Math.min(precio, Math.ceil(precioLista / REDONDEO) * REDONDEO), destino: 'etiqueta' };
}
