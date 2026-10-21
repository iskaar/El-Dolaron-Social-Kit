// El código leído se conserva; solo la clave de búsqueda ignora ceros iniciales.
export const codigoLeido = (valor) => typeof valor === 'string' && /^\d{6,14}$/.test(valor.trim()) ? valor.trim() : '';
export const normalizarUpc = (valor) => typeof valor === 'string' && /^\d{1,14}$/.test(valor.trim()) ? valor.trim().replace(/^0+/, '') : '';
