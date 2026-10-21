// El código leído se conserva; solo la clave de búsqueda ignora ceros iniciales.
export const codigoLeido = (valor) => typeof valor === 'string' && /^\d{6,14}$/.test(valor.trim()) ? valor.trim() : '';
// Lo escaneado se corrige este rato; /etiquetas lo imprime solo hasta que se cierra (#369).
export const CORRECCION_ESCANER_MS = 5 * 60_000;
export const normalizarUpc = (valor) => typeof valor === 'string' && /^\d{1,14}$/.test(valor.trim()) ? valor.trim().replace(/^0+/, '') : '';
