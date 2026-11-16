// Las secciones de GET /api/reportes?partes=a,b (#802, A6) y las claves de la respuesta que trae cada una. Lo comparten el servidor
// (src/reportes.ts), la pagina (reportes.html: cada vista pide solo las partes que pinta) y las pruebas. El orden es el de las
// claves de la respuesta completa, que sin `partes` sigue igual que siempre.
export const CLAVES_DE_PARTE = {
  primera_venta: ['primera_venta'],
  resumen: ['resumen'],
  anterior: ['anterior'],
  cuadre: ['cuadre'],
  forma_pago: ['por_forma_pago'],
  por_dia: ['por_dia'],
  por_hora: ['por_hora'],
  categorias: ['por_categoria', 'por_categoria_anterior'],
  inventario: ['inventario'],
  merma: ['merma_caducidad'],
  top_productos: ['top_productos'],
  precio_sugerido: ['precio_sugerido'],
  dias_en_venta: ['dias_en_venta_por_categoria'],
  cancelaciones: ['cancelaciones'],
  aperturas: ['aperturas_cajon'],
  cortes: ['cortes'],
  retiros: ['retiros'],
  revendedoras: ['revendedoras'],
  descuentos: ['descuentos'],
};
export const PARTES_REPORTE = Object.keys(CLAVES_DE_PARTE);

/**
 * Lo que NO cambia con el periodo ni con la tienda: fotos de ahora de todo el negocio (la pagina las pide una vez y las repite
 * cada 5 minutos como mucho). `merma` cambia con el periodo pero no con la tienda; `primera_venta` no cambia con nada.
 */
export const PARTES_FOTO = ['primera_venta', 'inventario', 'precio_sugerido', 'dias_en_venta'];
export const PARTES_SIN_TIENDA = [...PARTES_FOTO, 'merma'];
