/**
 * Manifiesto del proveedor (Issue #365): el UPC de fabrica dice que es la pieza
 * y cuanto cuesta en Target. Lo carga tools/importar_manifiesto.py; aqui solo se
 * busca y, la primera vez que se escanea un UPC, se traduce su nombre.
 */
import { conClaude } from './analisis.ts';
import { CATEGORIAS, CLAVES_CATEGORIA } from '../public/categorias.js';

export interface FichaManifiesto {
  upc: string;
  descripcion: string;
  departamento: string;
  precio_usd: number;
  tcin: string;
  nombre: string;
  marca: string;
  categoria: string;
}

/**
 * Solo digitos y sin ceros a la izquierda: la hoja guarda el UPC como numero
 * (pierde el 0 inicial) y un lector puede mandar el mismo producto como UPC-A
 * de 12 digitos o EAN-13 con un 0 delante. Igual que el importador.
 */
export const normalizarUpc = (crudo: string): string => crudo.replace(/\D/g, '').replace(/^0+/, '');

/** Centavos USD x centavos MXN por dolar -> centavos MXN. */
export const precioListaMxn = (precioUsd: number, tipoCambio: number): number => Math.round((precioUsd * tipoCambio) / 100);

const INSTRUCCION = [
  'Recibes la descripcion de un articulo de Target (en ingles, abreviada) y su departamento.',
  'Devuelve el nombre para la etiqueta de una tienda en San Luis Potosi, Mexico:',
  'articulo + marca + detalle que lo distinga (capacidad, medida, modelo), en ese orden;',
  'en espanol, maximo seis palabras, singular, sin articulos ni adjetivos de venta, sin color ni talla.',
  'Medidas en el sistema metrico cuando se pueda ("7OZ" -> "198 g").',
  'Ejemplos: "GG GUMMY FOOD TRUCK 7OZ" -> "Gomitas Good & Gather Food Truck 198 g";',
  '"Heyday iPad10/11GenCase Green" -> "Funda iPad Heyday 10/11 gen".',
  'MARCA: la del fabricante sin abreviar ("Good & Gather", "Hanes"); vacia si no se reconoce.',
  'CATEGORIA, la que usaria una tienda en linea:',
  ...CATEGORIAS.map(([clave, nombre]) => `${clave} (${nombre})`),
].join('\n');

const ESQUEMA = {
  type: 'object',
  properties: {
    nombre: { type: 'string' },
    marca: { type: 'string' },
    categoria: { type: 'string', enum: [...CLAVES_CATEGORIA] },
  },
  required: ['nombre', 'marca', 'categoria'],
  additionalProperties: false,
} as const;

type Traductor = (foto: string[], env: Env, instruccion: string, esquema: unknown, texto: string) => Promise<unknown>;

/**
 * La ficha del UPC, o null si no esta en el manifiesto. Un UPC sin nombre se
 * traduce aqui y se guarda: cada UPC se traduce una sola vez. Si la traduccion
 * falla, la ficha sale con el nombre vacio y la pantalla usa la descripcion de
 * Target; el siguiente escaneo lo vuelve a intentar.
 */
export async function fichaDeManifiesto(upc: string, env: Env, traducir: Traductor = conClaude): Promise<FichaManifiesto | null> {
  const ficha = await env.DB.prepare(
    'select upc, descripcion, departamento, precio_usd, tcin, nombre, marca, categoria from manifiesto where upc = ?',
  ).bind(upc).first<FichaManifiesto>();
  if (!ficha || ficha.nombre) return ficha;
  try {
    const crudo = (await traducir([], env, INSTRUCCION, ESQUEMA,
      `${ficha.descripcion}\nDepartamento: ${ficha.departamento || 'sin dato'}`)) as Partial<FichaManifiesto>;
    const nombre = String(crudo.nombre ?? '').trim().slice(0, 120);
    if (!nombre) return ficha;
    const marca = String(crudo.marca ?? '').trim().slice(0, 60);
    const categoria = CLAVES_CATEGORIA.includes(String(crudo.categoria)) ? String(crudo.categoria) : 'otros';
    await env.DB.prepare('update manifiesto set nombre = ?, marca = ?, categoria = ? where upc = ?')
      .bind(nombre, marca, categoria, upc).run();
    return { ...ficha, nombre, marca, categoria };
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'traduccion de manifiesto fallida', upc, error: String(error) }));
    return ficha;
  }
}
