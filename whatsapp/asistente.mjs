// Asistente de WhatsApp adaptado de Maki (MarKit/maki-worker, Issue #292): respuestas con modelo,
// historial corto por cliente con vencimiento, puntaje de interés y pausa cuando hay que
// escalar al personal. Solo usa los datos aprobados del PROMPT; lo demás se escala.
const MODELO = 'claude-haiku-5-5';
export const HANDOFF_SCORE = 7;
export const HISTORIAL_MAX = 10;
export const PAUSA_SEGUNDOS = 86400;
const RETENCION = 7 * 86400;
const FIN = new Set(['ok', 'okok', 'k', 'va', 'sale', 'gracias', 'no gracias', 'ya no', 'no me interesa', 'adios', 'adiós']);

export const PROMPT = `Eres el asistente automático de El Dolarón por WhatsApp. Respondes en español de México, breve y amable (máximo 3 líneas).
Solo puedes afirmar esta información:
- Horario: todos los días de 11:00 a 20:00.
- WhatsApp: 444 543 7754. Teléfono fijo: 444 854 5980 (no es WhatsApp).
- Las ventas son solo en sucursal. No hay entregas a domicilio ni envíos.
Para cualquier otra cosa (ubicación, precios, promociones, existencias, apartados, pagos, Dolarones, cuentas de socio, pedidos): no inventes nada. Di que lo confirmas con el equipo y agrega ESCALAR.
Si preguntan si eres un bot o una persona, di que eres el asistente automático de El Dolarón.
Nunca compartas datos de otros clientes ni información que no esté en esta lista.
Al final agrega SCORE:X en una línea aparte: 1-3 curiosidad, 4-6 interés, 7-10 intención de compra (por ejemplo, quieren ir hoy o preguntan cómo apartar). Con intención alta agrega ESCALAR.`;

export const esFinDeConversacion = (texto, tieneHistorial) => {
  const limpio = String(texto ?? '').toLowerCase().trim();
  return tieneHistorial && (FIN.has(limpio) || (limpio.length < 4 && !limpio.includes('?')));
};

/** Separa el texto para el cliente de las marcas SCORE y ESCALAR. */
export function interpretar(crudo) {
  const score = Number(String(crudo).match(/SCORE:\s*(\d+)/i)?.[1] ?? 3);
  const puntaje = Number.isFinite(score) ? score : 3;
  return {
    texto: String(crudo).replace(/SCORE:\s*\d+/gi, '').replace(/ESCALAR/gi, '').trim(),
    puntaje,
    escalar: /ESCALAR/i.test(crudo) || puntaje >= HANDOFF_SCORE,
  };
}

/** Respuesta del modelo. Lanza error si falla; el Worker vuelve al FAQ fijo. */
export async function generarRespuesta(historial, texto, apiKey) {
  const respuesta = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODELO, max_tokens: 400, system: PROMPT,
      messages: [...historial, { role: 'user', content: texto }] }),
  });
  if (!respuesta.ok) throw new Error(`modelo ${respuesta.status}`);
  const cuerpo = await respuesta.json();
  const salida = (cuerpo.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!salida) throw new Error('respuesta vacía');
  return salida;
}

// Historial y pausa viven en el mismo KV que los eventos, con prefijos propios y vencimiento.
export async function leerHistorial(kv, de) {
  return (await kv.get(`historial:${de}`, 'json')) ?? [];
}
export async function guardarTurno(kv, de, pregunta, respuesta) {
  const historial = [...await leerHistorial(kv, de), { role: 'user', content: pregunta }, { role: 'assistant', content: respuesta }];
  await kv.put(`historial:${de}`, JSON.stringify(historial.slice(-HISTORIAL_MAX)), { expirationTtl: RETENCION });
}
export const estaPausado = async (kv, de) => (await kv.get(`pausado:${de}`)) !== null;
export const pausar = (kv, de) => kv.put(`pausado:${de}`, '1', { expirationTtl: PAUSA_SEGUNDOS });
export const RETENCION_SEGUNDOS = RETENCION;
