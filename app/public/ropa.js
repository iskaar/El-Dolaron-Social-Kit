/** Categoría del servidor o precio de la captura local todavía sin subir. */
export const esRopa = (pieza) => pieza.categoria === 'ropa' || pieza.precio_ropa != null;

/** Catalogo comun de prendas y precios sugeridos, en centavos MXN. */
export const PRENDAS_ROPA = ['Playera', 'Blusa', 'Camisa', 'Sudadera', 'Suéter', 'Chamarra', 'Vestido', 'Falda', 'Short', 'Jeans', 'Pantalón', 'Leggings', 'Pants', 'Pijama', 'Traje de baño', 'Conjunto',
  'Chaleco', 'Ropa interior', 'Calcetines', 'Brasier', 'Gorra', 'Sombrero', 'Gorro', 'Guantes', 'Bufanda',
  'Tenis', 'Zapatos', 'Botas', 'Sandalias', 'Pantuflas'];
export const MARCAS_ROPA = ['All in Motion', 'Cat & Jack', 'Universal Thread', 'Wild Fable', 'Goodfellow & Co', 'A New Day', 'Art Class', 'Auden', 'Original Use', 'Shade & Shore', 'Xhilaration', 'Stars Above'];
export const PRECIO_PRENDA = Object.fromEntries([
  [5000, ['Ropa interior', 'Calcetines']],
  [8000, ['Gorro', 'Guantes']],
  [10000, ['Playera', 'Blusa', 'Brasier', 'Gorra', 'Bufanda']],
  [12000, ['Pantuflas']],
  [15000, ['Camisa', 'Vestido', 'Falda', 'Short', 'Traje de baño', 'Chaleco', 'Sombrero', 'Sandalias']],
  [20000, ['Sudadera', 'Suéter', 'Jeans', 'Pantalón', 'Pants', 'Leggings', 'Pijama', 'Conjunto', 'Zapatos']],
  [30000, ['Chamarra', 'Tenis', 'Botas']],
].flatMap(([precio, prendas]) => prendas.map((prenda) => [prenda, precio])));
// Captura y servidor conservan los importes existentes; la tabla solo sugiere.
export const PRECIOS_ROPA = [30000, 20000, 15000, 12000, 10000, 8000, 5000];

/**
 * Paquete ×N (#714): varias piezas iguales que se venden juntas como UNA pieza con UNA etiqueta (el stock no se multiplica).
 * Se guarda solo en el nombre: «Paquete de 3 Playeras Hanes». Plural: +s (o igual si ya termina en s); las excepciones, aquí.
 * Una prenda sin elegir se llama «Prendas». Es ida y vuelta: partesDeNombre recupera prenda, paquete y marca.
 */
export const PAQUETES = [2, 3, 4, 5, 6];
export const PAQUETE_MAX = 24;
export const paqueteValido = (n) => Number.isInteger(n) && n >= 2 && n <= PAQUETE_MAX;
const PLURAL_ESPECIAL = { Short: 'Shorts', Suéter: 'Suéteres', Pantalón: 'Pantalones', Brasier: 'Brasieres', 'Traje de baño': 'Trajes de baño', 'Ropa interior': 'Ropa interior' };
export const pluralPrenda = (prenda) => !prenda ? 'Prendas' : PLURAL_ESPECIAL[prenda] ?? (prenda.endsWith('s') ? prenda : `${prenda}s`);
const PRENDA_DE_PLURAL = new Map(PRENDAS_ROPA.map((prenda) => [pluralPrenda(prenda), prenda]));

/** Nombre de la ropa capturada por foto: «Playera Hanes», «Ropa» sin prenda ni marca, «Paquete de 3 Playeras Hanes». */
export const nombreRopa = (prenda, marca, paquete = 0) =>
  (paqueteValido(paquete) ? [`Paquete de ${paquete} ${pluralPrenda(prenda)}`, marca] : [prenda || 'Ropa', marca]).filter(Boolean).join(' ');

/** Lo contrario de nombreRopa. Un nombre que no es de paquete se devuelve entero como prenda (ropa con código trae su nombre). */
export function partesDeNombre(nombre, marca) {
  const base = marca && nombre.endsWith(` ${marca}`) ? nombre.slice(0, -(marca.length + 1)) : nombre;
  const paquete = /^Paquete de (\d{1,2}) (.+)$/.exec(base);
  if (paquete && paqueteValido(Number(paquete[1]))) return { prenda: PRENDA_DE_PLURAL.get(paquete[2]) ?? '', paquete: Number(paquete[1]) };
  return { prenda: base === 'Ropa' ? '' : base, paquete: 0 };
}
