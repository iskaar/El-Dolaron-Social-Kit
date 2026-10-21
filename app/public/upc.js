// El código leído se conserva; solo la clave de búsqueda ignora ceros iniciales.
export const codigoLeido = (valor) => typeof valor === 'string' && /^\d{6,14}$/.test(valor.trim()) ? valor.trim() : '';
// Lo escaneado se corrige este rato; /etiquetas lo imprime solo hasta que se cierra (#369).
// Pieza dada de alta en el escáner solo con foto, sin código del fabricante (#379): `productos.upc`
// vacío (no nulo). Así sigue las reglas de lo escaneado: 5 min de corrección e impresión automática.
export const SIN_CODIGO = '';
export const CORRECCION_ESCANER_MS = 5 * 60_000;
export const normalizarUpc = (valor) => typeof valor === 'string' && /^\d{1,14}$/.test(valor.trim()) ? valor.trim().replace(/^0+/, '') : '';
