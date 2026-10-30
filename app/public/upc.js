// El código leído se conserva; solo la clave de búsqueda ignora ceros iniciales.
export const codigoLeido = (valor) => typeof valor === 'string' && /^\d{6,14}$/.test(valor.trim()) ? valor.trim() : '';
// Pieza dada de alta en el escáner solo con foto, sin código del fabricante (#379): `productos.upc`
// vacío (no nulo). Así sigue las reglas de lo escaneado: impresión automática y cancelar en 0.
export const SIN_CODIGO = '';
export const normalizarUpc = (valor) => typeof valor === 'string' && /^\d{1,14}$/.test(valor.trim()) ? valor.trim().replace(/^0+/, '') : '';
