/** Catalogo comun de prendas y precios sugeridos, en centavos MXN. */
export const PRENDAS_ROPA = ['Playera', 'Blusa', 'Camisa', 'Sudadera', 'Suéter', 'Chamarra', 'Vestido', 'Falda', 'Short', 'Jeans', 'Pantalón', 'Leggings', 'Pants', 'Pijama', 'Traje de baño', 'Conjunto'];
export const MARCAS_ROPA = ['All in Motion', 'Cat & Jack', 'Universal Thread', 'Wild Fable', 'Goodfellow & Co', 'A New Day', 'Art Class', 'Auden', 'Original Use', 'Shade & Shore', 'Xhilaration', 'Stars Above'];
export const PRECIO_PRENDA = Object.fromEntries([
  [10000, ['Playera', 'Blusa']],
  [15000, ['Camisa', 'Vestido', 'Falda', 'Short', 'Traje de baño']],
  [20000, ['Sudadera', 'Suéter', 'Jeans', 'Pantalón', 'Pants', 'Leggings', 'Pijama', 'Conjunto']],
  [30000, ['Chamarra']],
].flatMap(([precio, prendas]) => prendas.map((prenda) => [prenda, precio])));
// Captura y servidor conservan los importes existentes; la tabla solo sugiere.
export const PRECIOS_ROPA = [30000, 20000, 15000, 12000, 10000, 8000, 5000];
