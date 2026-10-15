// Respuestas fijas del FAQ aprobado por Isaac (Issue #285). Solo datos confirmados:
// horario, telefonos y venta solo en sucursal. Ubicacion, precios y promociones no
// estan confirmados, asi que caen en el mensaje de respaldo.
const normalizar = (texto) => texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ');

const RESPUESTAS = [
  { palabras: ['horario', 'abren', 'abierto', 'cierran', 'hora'],
    texto: 'Estamos abiertos todos los días de 11:00 a 20:00.' },
  { palabras: ['telefono', 'numero', 'llamar', 'marcar', 'whatsapp'],
    texto: 'Puedes escribirnos por este WhatsApp o llamar al 444 543 7754. El teléfono fijo es 444 854 5980 (no es WhatsApp).' },
  { palabras: ['envio', 'envios', 'enviar', 'envian', 'domicilio', 'entregan', 'mandan'],
    texto: 'Por ahora vendemos solo en sucursal: no hacemos entregas a domicilio ni envíos.' },
];
const SALUDO = { palabras: ['hola', 'buenas', 'buenos', 'buen'],
  texto: 'Hola, gracias por escribir a El Dolarón. Puedo darte el horario, el teléfono o informarte si hacemos envíos.' };
const RESPALDO = 'Gracias por escribirnos. Por ahora no tengo esa información. Comunícate al 444 543 7754 en horario de 11:00 a 20:00.';

const contiene = (palabras, texto) => palabras.some((p) => new RegExp(`\\b${p}\\b`).test(texto));

/** Respuesta para un mensaje de texto del cliente. Nunca usa datos de clientes ni de inventario. */
export function respuestaPara(texto) {
  const limpio = normalizar(String(texto ?? ''));
  const hallada = RESPUESTAS.find(({ palabras }) => contiene(palabras, limpio));
  if (hallada) return hallada.texto;
  if (contiene(SALUDO.palabras, limpio)) return SALUDO.texto;
  return RESPALDO;
}
