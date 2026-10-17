/** Catalogo comun de prendas y precios sugeridos, en centavos MXN. */
export const PRENDAS_ROPA = ['Playera', 'Blusa', 'Camisa', 'Sudadera', 'Suéter', 'Chamarra', 'Vestido', 'Falda', 'Short', 'Jeans', 'Pantalón', 'Leggings', 'Pants', 'Pijama', 'Traje de baño', 'Conjunto'];
export const PRECIO_PRENDA = Object.fromEntries([
  [10000, ['Playera', 'Blusa']],
  [15000, ['Camisa', 'Vestido', 'Falda', 'Short', 'Traje de baño']],
  [20000, ['Sudadera', 'Suéter', 'Jeans', 'Pantalón', 'Pants', 'Leggings', 'Pijama', 'Conjunto']],
  [30000, ['Chamarra']],
].flatMap(([precio, prendas]) => prendas.map((prenda) => [prenda, precio])));
export const PRECIOS_ROPA = [...new Set(Object.values(PRECIO_PRENDA))].sort((a, b) => b - a);
