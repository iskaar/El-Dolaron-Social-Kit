/**
 * Calculo del precio. Funcion pura, sin I/O.
 * Todo en centavos MXN, enteros: nada de flotantes en dinero.
 * Los porcentajes y limites viven en la tabla `config`, nunca aqui.
 */

export type Categoria = 'ropa' | 'hogar' | 'electronica' | 'juguetes' | 'otros';
export type EstadoFisico = 'nuevo' | 'danado';
export type Familia = 'r' | 'g';

/** Siete precios, compartidos por las dos familias (ropa/general). Ver PLAN-ETIQUETAS-POR-BANDA.md. */
export const MONTOS_BANDA = [19, 29, 49, 79, 99, 149, 199] as const;
const FAMILIAS: Familia[] = ['r', 'g'];

export type Destino =
  | 'etiqueta'
  | `banda_${Familia}${(typeof MONTOS_BANDA)[number]}`;

/** Las 14 filas de catalogo (7 precios x 2 familias), para poblar DESTINOS y sembrar la migracion. */
export const DESTINOS_BANDA: Destino[] = FAMILIAS.flatMap(
  (f) => MONTOS_BANDA.map((p) => `banda_${f}${p}` as Destino),
);

/** Ropa tiene su propia familia; todo lo demas cae en "general". */
export function familiaDe(categoria: string): Familia {
  return categoria === 'ropa' ? 'r' : 'g';
}

/** El codigo de barras impreso (p.ej. "G79") a partir del destino de banda. */
export function codigoDeDestino(destino: Destino): string | null {
  const m = /^banda_([rg])(\d+)$/.exec(destino);
  return m ? `${m[1].toUpperCase()}${m[2]}` : null;
}

const REDONDEO = 500; // $5 MXN

/** Redondeo hacia arriba al multiplo de $5, el mismo que usa el calculo automatico. */
export function redondear5(centavos: number): number {
  return Math.ceil(Math.max(0, centavos) / REDONDEO) * REDONDEO;
}

/**
 * Ajusta un precio escrito a mano por el admin.
 * Una pieza en una banda se vende al precio de la banda: si el destino es
 * `banda_g49`, el precio sale de la configuracion `banda_49` (compartida entre
 * `r` y `g`), aunque en el campo se haya tecleado otra cosa. Una banda con un
 * precio que no es el suyo es una discrepancia que aparece en la caja.
 */
export function ajustarManual({ precio, destino, config }: {
  precio: number;
  destino: Destino;
  config: Record<string, string>;
}): number {
  if (destino === 'etiqueta') {
    return redondear5(precio);
  }
  const m = /^banda_[rg](\d+)$/.exec(destino);
  const pesosPorDefecto = m ? Number.parseInt(m[1], 10) : 0;
  return entero(config, `banda_${pesosPorDefecto}`, pesosPorDefecto * 100);
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
 * Si cae en el limite de banda o por debajo, la pieza va a la banda mas chica
 * que la cubra y no lleva etiqueta individual: se etiqueta con el codigo
 * compartido de esa banda (ver PLAN-ETIQUETAS-POR-BANDA.md).
 */
export function calcularPrecio({ precioLista, categoria, estadoFisico, config }: EntradaPrecio): {
  precio: number;
  destino: Destino;
} {
  // Sin precio de lista no hay precio: la pieza espera al admin en lugar de
  // caer a la banda mas barata. Un articulo de $300 mal leido vendido en $20
  // es el error que cuesta dinero.
  if (precioLista <= 0) {
    return { precio: 0, destino: 'etiqueta' };
  }

  const pctCategoria = entero(config, `pct_${categoria}`, entero(config, 'pct_otros', 50));
  const pctDanado = estadoFisico === 'danado' ? entero(config, 'pct_danado', 60) : 100;

  const bruto = (Math.max(0, precioLista) * pctCategoria * pctDanado) / 10000;
  const precio = Math.ceil(bruto / REDONDEO) * REDONDEO;

  return conBanda(precio, precioLista, categoria, config);
}

/** Lo barato va a la banda mas chica que lo cubra; lo demas lleva etiqueta. */
function conBanda(precio: number, precioLista: number, categoria: string, config: Record<string, string>): {
  precio: number;
  destino: Destino;
} {
  const limite = entero(config, 'limite_banda', 20000);
  if (precio <= limite) {
    const familia = familiaDe(categoria);
    const bandas: Array<[Destino, number]> = MONTOS_BANDA.map((pesosPorDefecto) => [
      `banda_${familia}${pesosPorDefecto}` as Destino,
      entero(config, `banda_${pesosPorDefecto}`, pesosPorDefecto * 100),
    ]);
    bandas.sort((a, b) => a[1] - b[1]);
    const banda = bandas.find(([, monto]) => precio <= monto) ?? bandas[bandas.length - 1];
    return { precio: banda[1], destino: banda[0] };
  }

  // Nunca por encima del precio de lista.
  return { precio: Math.min(precio, redondear5(precioLista)), destino: 'etiqueta' };
}

/**
 * Precio a partir de lo que propuso el modelo mirando como cobra Isaac.
 * Pasa por las mismas guardas que el calculo por porcentaje: redondeo a $5,
 * nunca por encima del precio de lista, y banda si cae en el limite o debajo.
 */
export function precioDesdeSugerencia({ precioLista, sugerido, categoria, config }: {
  precioLista: number;
  sugerido: number;
  categoria: string;
  config: Record<string, string>;
}): { precio: number; destino: Destino } {
  if (sugerido <= 0) {
    return { precio: 0, destino: 'etiqueta' };
  }
  return conBanda(redondear5(sugerido), precioLista, categoria, config);
}
