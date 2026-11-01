// Respuestas fijas del FAQ aprobado por Isaac (Issues #285, #497 y #583). Solo datos confirmados:
// horario, telefonos, ubicacion con mapa, apartado en tienda y los dos grupos de WhatsApp. No hay
// promocion vigente (la inauguracion termino, #583). Precios y envios no estan confirmados, asi que
// caen en el respaldo.
const normalizar = (texto) => texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ');

const RESPUESTAS = [
  // Issue #583: sin promo vigente. Sigue primero para que «¿a qué hora es la inauguración?» no caiga en horario.
  { palabras: ['inauguracion', 'inaguracion', 'promocion', 'promociones', 'promo', 'promos', 'descuento', 'descuentos', 'ofertas', 'cupon', 'cien pesos', '100 pesos', 'oferta', 'primeras'],
    texto: 'Por ahora no tenemos ninguna promoción vigente.\nEn nuestros grupos de WhatsApp te enteras primero de lo que llega: Ropa https://eldolaron.com/ropa y Mercancía General https://eldolaron.com/general\nY te esperamos en Jardín Hidalgo 129, Centro de Soledad: https://maps.app.goo.gl/RgWXq1AUvyXsV9ts6' },
  { palabras: ['grupo', 'grupos', 'unirme', 'unirse', 'unirnos'],
    texto: 'Tenemos dos grupos de WhatsApp. Ropa (novedades de ropa americana): https://eldolaron.com/ropa\nMercancía General (hogar, belleza, juguetes y más): https://eldolaron.com/general' },
  { palabras: ['ubicacion', 'direccion', 'donde', 'llegar', 'ubicados', 'calle', 'soledad', 'mapa'],
    texto: 'Estamos en Jardín Hidalgo 129, Centro, Soledad de Graciano Sánchez. Abrimos todos los días de 11 a. m. a 8 p. m. Mapa: https://maps.app.goo.gl/RgWXq1AUvyXsV9ts6' },
  { palabras: ['apartar', 'aparto', 'apartado', 'apartan', 'separar', 'separan', 'reservar'],
    texto: 'Sí apartamos en tienda: dejas $100 (o el total si cuesta menos) y te lo guardamos 7 días. Escríbenos qué te interesa y el equipo te confirma.' },
  { palabras: ['horario', 'abren', 'abierto', 'cierran', 'hora'],
    texto: 'Estamos abiertos todos los días de 11 a. m. a 8 p. m.' },
  { palabras: ['telefono', 'numero', 'llamar', 'marcar', 'whatsapp'],
    texto: 'Puedes escribirnos por este WhatsApp o llamar al 444 543 7754. El teléfono fijo es 444 854 5980 (no es WhatsApp).' },
  { palabras: ['envio', 'envios', 'enviar', 'envian', 'domicilio', 'entregan', 'mandan'],
    texto: 'Sobre envíos y entregas, el equipo te confirma por aquí mismo. Mientras, te esperamos en tienda de 11 a. m. a 8 p. m.' },
];
const SALUDO = { palabras: ['hola', 'buenas', 'buenos', 'buen'],
  texto: 'Hola, gracias por escribir a El Dolarón. Únete a nuestros grupos de WhatsApp para ver lo que llega antes que nadie: Ropa https://eldolaron.com/ropa y Mercancía General https://eldolaron.com/general\nTe esperamos en Jardín Hidalgo 129, Centro de Soledad, de 11 a. m. a 8 p. m.: https://maps.app.goo.gl/RgWXq1AUvyXsV9ts6' };
const RESPALDO = 'Gracias por escribirnos. Eso lo confirma el equipo y te responde por este mismo chat, en horario de 11 a. m. a 8 p. m.';

const contiene = (palabras, texto) => palabras.some((p) => new RegExp(`\\b${p}\\b`).test(texto));

/** Respuesta fija si el mensaje cae en el FAQ o es un saludo; null si hace falta el modelo (Issue #499). */
export function respuestaFija(texto) {
  const limpio = normalizar(String(texto ?? ''));
  const hallada = RESPUESTAS.find(({ palabras }) => contiene(palabras, limpio));
  if (hallada) return hallada.texto;
  if (contiene(SALUDO.palabras, limpio)) return SALUDO.texto;
  return null;
}

/**
 * Issue #499: un mensaje corto que cae en el FAQ se contesta fijo, sin modelo (gratis, al instante
 * y siempre igual). Uno largo o que no cae va al modelo, aunque traiga una palabra del FAQ:
 * «¿dónde consigo talla M?» no es una pregunta de ubicación.
 */
export const PALABRAS_SIMPLE = 8;
export const esSimple = (texto) => String(texto ?? '').trim().split(/\s+/).filter(Boolean).length <= PALABRAS_SIMPLE;

/** Respuesta para un mensaje de texto del cliente. Nunca usa datos de clientes ni de inventario. */
export function respuestaPara(texto) {
  return respuestaFija(texto) ?? RESPALDO;
}
