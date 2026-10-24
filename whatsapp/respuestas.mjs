// Respuestas fijas del FAQ aprobado por Isaac (Issues #285 y #497). Solo datos confirmados:
// horario, telefonos, ubicacion, apartado en tienda y la gran inauguracion del 24 y 25 de
// octubre de 2026. Precios y envios no estan confirmados, asi que caen en el respaldo.
const normalizar = (texto) => texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ');

const RESPUESTAS = [
  // Issue #497: la promo va primero para que «¿a qué hora es la inauguración?» no caiga en horario.
  { palabras: ['inauguracion', 'inaguracion', 'promocion', 'promo', 'descuento', 'cupon', 'cien pesos', '100 pesos', 'oferta', 'primeras'],
    texto: 'Gran inauguración: sábado 24 y domingo 25 de octubre, de 11 a. m. a 8 p. m. A las primeras 100 compras de $300 o más en tienda les descontamos $100 en caja (un descuento por compra; la caja lo aplica sola, no se aparta por WhatsApp). Jardín Hidalgo 129, Centro de Soledad.' },
  { palabras: ['ubicacion', 'direccion', 'donde', 'llegar', 'ubicados', 'calle', 'soledad', 'mapa'],
    texto: 'Estamos en Jardín Hidalgo 129, Centro, Soledad de Graciano Sánchez. Abrimos todos los días de 11 a. m. a 8 p. m.' },
  { palabras: ['apartar', 'aparto', 'apartado', 'apartan', 'separar', 'separan', 'reservar'],
    texto: 'Sí apartamos en tienda: dejas el 15 % del valor y te lo guardamos 7 días. Escríbenos qué te interesa y el equipo te confirma.' },
  { palabras: ['horario', 'abren', 'abierto', 'cierran', 'hora'],
    texto: 'Estamos abiertos todos los días de 11 a. m. a 8 p. m.' },
  { palabras: ['telefono', 'numero', 'llamar', 'marcar', 'whatsapp'],
    texto: 'Puedes escribirnos por este WhatsApp o llamar al 444 543 7754. El teléfono fijo es 444 854 5980 (no es WhatsApp).' },
  { palabras: ['envio', 'envios', 'enviar', 'envian', 'domicilio', 'entregan', 'mandan'],
    texto: 'Sobre envíos y entregas, el equipo te confirma por aquí mismo. Mientras, te esperamos en tienda de 11 a. m. a 8 p. m.' },
];
const SALUDO = { palabras: ['hola', 'buenas', 'buenos', 'buen'],
  texto: 'Hola, gracias por escribir a El Dolarón. Este sábado 24 y domingo 25 es la gran inauguración: $100 de descuento en caja a las primeras 100 compras de $300 o más. Puedo darte el horario, la ubicación o cómo apartar.' };
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
