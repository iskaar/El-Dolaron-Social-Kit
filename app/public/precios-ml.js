/**
 * Enlace al listado web de Mercado Libre para comparar precios a ojo (#182, #189).
 * ML no deja buscar por API a esta app (403 incluso con token), asi que se abre
 * su pagina de busqueda. Agrega la marca si no viene ya en el nombre. Sin
 * nombre devuelve '' para que la pantalla avise.
 */
const plano = (texto) => (texto ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f']/g, '');

export function enlacePreciosML(nombre, marca = '') {
  const n = (nombre ?? '').trim();
  if (!n) return '';
  const m = (marca ?? '').trim();
  const texto = plano(n).includes(plano(m)) ? n : `${m} ${n}`;
  const slug = plano(texto).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `https://listado.mercadolibre.com.mx/${slug}` : '';
}
