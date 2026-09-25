/**
 * Calculo del precio. Funcion pura, sin I/O.
 * Todo en centavos MXN, enteros: nada de flotantes en dinero.
 * Los porcentajes viven en la tabla `config`, nunca aqui.
 */

export type Categoria = 'ropa' | 'hogar' | 'electronica' | 'juguetes' | 'otros';
export type EstadoFisico = 'nuevo' | 'danado';
/** Prefijo de una familia de banda: una o dos letras minusculas ('r', 'ju'). Vive en la tabla `familias`. */
export type Familia = string;

/** Siete precios, compartidos por todas las familias. Ver PLAN-ETIQUETAS-POR-BANDA.md. */
export const MONTOS_BANDA = [19, 29, 49, 79, 99, 149, 199] as const;

export type Destino = 'etiqueta' | `banda_${string}`;

const BANDA = /^banda_([a-z]{1,2})(\d+)$/;

/** Un destino de banda bien formado (p.ej. `banda_ju49`). Que la familia exista lo dice la tabla `familias`. */
export function esDestinoBanda(destino: string): boolean {
  const m = BANDA.exec(destino);
  return m !== null && (MONTOS_BANDA as readonly number[]).includes(Number(m[2]));
}

/** El codigo de barras impreso (p.ej. "JU79") a partir del destino de banda. */
export function codigoDeDestino(destino: Destino): string | null {
  const m = BANDA.exec(destino);
  return m ? `${m[1].toUpperCase()}${m[2]}` : null;
}

/**
 * Prefijo de dos letras para una familia nueva, a partir de su nombre: las dos
 * primeras letras, o la primera y la siguiente distinta que no este ocupada. "ED" queda
 * fuera porque es el de las piezas individuales (ED-000123). Con dos letras el
 * codigo mas largo es "JU199", 5 caracteres, que aun cabe en la etiqueta a
 * modulo 4 (360 de 406 puntos). Null si el nombre no tiene letras suficientes.
 */
export function prefijoParaFamilia(nombre: string, ocupados: Set<string>): string | null {
  const letras = nombre.normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase();
  const libre = (p: string) => !ocupados.has(p) && p !== 'ed';
  for (let i = 0; i < letras.length; i++) {
    for (let j = i + 1; j < letras.length; j++) {
      const candidato = letras[i] + letras[j];
      if (letras[i] !== letras[j] && libre(candidato)) return candidato;
    }
  }
  return null;
}

const REDONDEO = 500; // $5 MXN

/**
 * Quiebra la decena: redondea al multiplo de $10 mas cercano (de $5 en adelante
 * sube, menos de $5 baja) y resta $1, asi que el precio de una etiqueta siempre
 * termina en 9 ($233 -> $229, $235 -> $239, $250 -> $249), con minimo $9 para
 * que una pieza barata no quede en $0. Idempotente: un precio que ya termina en
 * 9 se queda igual. Se aplica al precio SIN redondear antes a $5, para no
 * redondear dos veces.
 */
export function quebrarDecena(centavos: number): number {
  return centavos <= 0 ? 0 : Math.max(900, Math.floor((centavos + 500) / 1000) * 1000 - 100);
}

/** Redondeo hacia arriba al multiplo de $5. */
export function redondear5(centavos: number): number {
  return Math.ceil(Math.max(0, centavos) / REDONDEO) * REDONDEO;
}

/**
 * Ajusta un precio escrito a mano por el admin.
 * Una pieza en una banda se vende al precio de la banda: si el destino es
 * `banda_g49`, el precio sale de la configuracion `banda_49` (compartida entre
 * todas las familias), aunque en el campo se haya tecleado otra cosa. Una banda con un
 * precio que no es el suyo es una discrepancia que aparece en la caja.
 */
export function ajustarManual({ precio, destino, config }: {
  precio: number;
  destino: Destino;
  config: Record<string, string>;
}): number {
  if (destino === 'etiqueta') {
    return quebrarDecena(precio);
  }
  const m = BANDA.exec(destino);
  const pesosPorDefecto = m ? Number.parseInt(m[2], 10) : 0;
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
 * precio = precio_lista x %categoria x %danado, quebrado a X9 (ver quebrarDecena).
 * Toda pieza fotografiada lleva su propia etiqueta, sea cual sea su precio: las
 * bandas se imprimen y se pegan aparte, sin foto ni analisis, y ya no son el
 * destino automatico de nada (ver PLAN-ETIQUETAS-POR-BANDA.md).
 */
export function calcularPrecio({ precioLista, categoria, estadoFisico, config }: EntradaPrecio): {
  precio: number;
  destino: Destino;
} {
  // Sin precio de lista no hay precio: la pieza espera al admin en lugar de
  // quedar en el minimo. Un articulo de $300 mal leido vendido en $9 es el
  // error que cuesta dinero.
  if (precioLista <= 0) {
    return { precio: 0, destino: 'etiqueta' };
  }

  const pctCategoria = entero(config, `pct_${categoria}`, entero(config, 'pct_otros', 50));
  const pctDanado = estadoFisico === 'danado' ? entero(config, 'pct_danado', 60) : 100;

  const bruto = (Math.max(0, precioLista) * pctCategoria * pctDanado) / 10000;
  return conEtiqueta(bruto, precioLista);
}

/** El precio de una etiqueta individual: X9 y nunca por encima del precio de lista. */
function conEtiqueta(bruto: number, precioLista: number): { precio: number; destino: Destino } {
  return { precio: Math.min(quebrarDecena(bruto), redondear5(precioLista)), destino: 'etiqueta' };
}

/**
 * Precio a partir de lo que propuso el modelo mirando como cobra Isaac.
 * Pasa por las mismas guardas que el calculo por porcentaje: X9 y nunca por
 * encima del precio de lista.
 */
export function precioDesdeSugerencia({ precioLista, sugerido }: {
  precioLista: number;
  sugerido: number;
}): { precio: number; destino: Destino } {
  if (sugerido <= 0) {
    return { precio: 0, destino: 'etiqueta' };
  }
  return conEtiqueta(sugerido, precioLista);
}
