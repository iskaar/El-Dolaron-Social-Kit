/**
 * Categorias del inventario: una sola lista para el servidor, la IA y el admin.
 * La clave es ASCII y no cambia (sirve de URL en una tienda en linea); el
 * nombre es lo que se muestra. «otros» es el ultimo recurso, no un cajon.
 * El porcentaje de precio de cada una es pct_<clave> en la configuracion; si
 * no existe, se usa pct_otros.
 */
export const CATEGORIAS = [
  ['ropa', 'Ropa y calzado'],
  ['accesorios', 'Bolsas y accesorios'],
  ['belleza', 'Belleza y cuidado personal'],
  ['hogar', 'Hogar y cocina'],
  ['jardin', 'Jardín y exteriores'],
  ['electronica', 'Electrónica'],
  ['juguetes', 'Juguetes'],
  ['mascotas', 'Mascotas'],
  ['papeleria', 'Papelería y libros'],
  ['despensa', 'Despensa'],
  ['deportes', 'Deportes'],
  ['otros', 'Otros'],
];

export const CLAVES_CATEGORIA = CATEGORIAS.map(([clave]) => clave);
