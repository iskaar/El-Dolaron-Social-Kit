import { esSimple, respuestaFija, respuestaPara } from './respuestas.mjs';
import { esFinDeConversacion, estaPausado, generarRespuesta, guardarTurno, interpretar, leerHistorial, pausar, RETENCION_SEGUNDOS } from './asistente.mjs';

const encoder = new TextEncoder();
const maxBytes = 1024 * 1024;
const reply = (text, status = 200) => new Response(text, {
  status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname !== 'whatsapp.eldolaron.com' || url.pathname !== '/webhook') {
      return reply('Not found', 404);
    }
    if (request.method === 'GET') {
      if (!env.WHATSAPP_VERIFY_TOKEN) return reply('Not configured', 503);
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (url.searchParams.get('hub.mode') !== 'subscribe' || !token || !challenge) {
        return reply('Invalid verification request', 400);
      }
      // HMAC verification avoids timing-dependent secret string comparisons.
      const key = await crypto.subtle.importKey('raw', encoder.encode(env.WHATSAPP_VERIFY_TOKEN),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
      const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(env.WHATSAPP_VERIFY_TOKEN));
      if (!await crypto.subtle.verify('HMAC', key, signature, encoder.encode(token))) {
        return reply('Forbidden', 403);
      }
      return reply(challenge);
    }
    if (request.method !== 'POST') {
      const response = reply('Method not allowed', 405);
      response.headers.set('Allow', 'GET, POST');
      return response;
    }
    // Do not acknowledge events until authenticating and persisting them.
    if (!env.META_APP_SECRET || !env.EVENTS) return reply('Not configured', 503);
    const signature = request.headers.get('x-hub-signature-256');
    if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return reply('Forbidden', 403);
    if (Number(request.headers.get('content-length')) > maxBytes) return reply('Payload too large', 413);
    const reader = request.body?.getReader();
    if (!reader) return reply('Missing payload', 400);
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          return reply('Payload too large', 413);
        }
        chunks.push(value);
      }
    } catch {
      return reply('Incomplete payload', 400);
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.META_APP_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const bytes = Uint8Array.from(signature.slice(7).match(/../g), hex => parseInt(hex, 16));
    if (!await crypto.subtle.verify('HMAC', key, bytes, body)) return reply('Forbidden', 403);
    let event;
    try {
      event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      return reply('Invalid JSON', 400);
    }
    if (event?.object !== 'whatsapp_business_account' || !Array.isArray(event.entry)) {
      return reply('Invalid WhatsApp event', 400);
    }
    try {
      // shortcut: seven-day private inbox only; add processing before automated replies.
      await env.EVENTS.put(`event:${crypto.randomUUID()}`, body, { expirationTtl: 7 * 86400 });
    } catch {
      console.error(JSON.stringify({ event: 'whatsapp_storage_failed' }));
      return reply('Storage unavailable', 503);
    }
    console.log(JSON.stringify({ event: 'whatsapp_event_saved' }));
    // Issue #285: la respuesta va despues de guardar; un fallo de envio no cambia el acuse a Meta.
    const respuestas = responderMensajes(event, env).catch(() => console.error(JSON.stringify({ event: 'whatsapp_reply_error' })));
    if (ctx) ctx.waitUntil(respuestas);
    else await respuestas;
    return reply('EVENT_RECEIVED');
  },
};

/**
 * Responde a cada mensaje del cliente una sola vez. Un mensaje corto que cae en el FAQ (saludo,
 * horario, ubicación, promo) se contesta fijo, sin modelo (Issue #499); el resto va al asistente
 * si hay clave y el modelo contesta, y si no, al FAQ fijo. Si el asistente escala, la
 * conversacion queda pausada.
 */
async function responderMensajes(event, env) {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return;
  for (const entrada of event.entry) {
    for (const cambio of entrada.changes ?? []) {
      if (cambio.field !== 'messages') continue;
      for (const mensaje of cambio.value?.messages ?? []) {
        if ((mensaje.type !== 'text' && mensaje.type !== 'image') || !mensaje.id || !mensaje.from) continue;
        // Meta reintenta los eventos; la marca evita contestar dos veces el mismo mensaje.
        const marca = `respondido:${mensaje.id}`;
        if (await env.EVENTS.get(marca)) continue;
        await env.EVENTS.put(marca, '1', { expirationTtl: 7 * 86400 });
        const de = mensaje.from;
        if (await estaPausado(env.EVENTS, de)) continue;

        if (mensaje.type === 'image') {
          await enviarYGuardar(env, de, IMAGEN);
          continue;
        }
        const texto = String(mensaje.text?.body ?? '');
        const historial = await leerHistorial(env.EVENTS, de);
        if (esFinDeConversacion(texto, historial.length > 0)) continue;

        let respuesta;
        const fija = esSimple(texto) ? respuestaFija(texto) : null;
        if (fija) {
          respuesta = { texto: fija, puntaje: 0, escalar: false };
        } else {
          try {
            if (!env.ANTHROPIC_API_KEY) throw new Error('sin clave');
            const consultar = env.TIENDA && env.ASISTENTE_TOKEN ? (q) => consultarTienda(env, q) : null;
            respuesta = interpretar(await generarRespuesta(historial, texto, env.ANTHROPIC_API_KEY, consultar));
          } catch (error) {
            // Issue #499: sin esto el fallo del modelo era invisible y el cliente solo veía el respaldo.
            // Solo el motivo corto (p. ej. «modelo 401»), nunca la clave ni el texto del cliente.
            console.error(JSON.stringify({ event: 'whatsapp_modelo_fallo', motivo: String(error?.message ?? error).slice(0, 120) }));
            respuesta = { texto: respuestaPara(texto), puntaje: 0, escalar: false };
          }
        }
        if (!respuesta.texto) continue;
        if (!await enviarYGuardar(env, de, respuesta.texto)) continue;
        await guardarTurno(env.EVENTS, de, texto, respuesta.texto);
        if (respuesta.escalar) await pausar(env.EVENTS, de);
      }
    }
  }
}

const IMAGEN = 'Recibimos tu imagen. Escríbenos tu pregunta por texto y te ayudamos.';

/** Consulta de productos en la app principal (Issue #296). Solo nombre y precio; el token nunca sale a logs. */
async function consultarTienda(env, q) {
  const respuesta = await env.TIENDA.fetch(new Request(`https://tienda.interno/api/asistente/productos?q=${encodeURIComponent(q)}`, {
    headers: { 'x-asistente-token': env.ASISTENTE_TOKEN },
  }));
  if (!respuesta.ok) throw new Error(`tienda ${respuesta.status}`);
  return respuesta.json();
}

/** Envia el texto por Meta y lo registra para la vista de mensajes. Nunca registra el texto en logs. */
async function enviarYGuardar(env, para, texto) {
  const envio = await fetch(`https://graph.facebook.com/v26.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto } }),
  });
  if (!envio.ok) {
    console.error(JSON.stringify({ event: 'whatsapp_reply_failed', status: envio.status }));
    return false;
  }
  const id = String((await envio.json().catch(() => ({})))?.messages?.[0]?.id ?? crypto.randomUUID());
  await env.EVENTS.put(`saliente:${id}`, JSON.stringify({ id, para, texto, enviado_por: 'asistente automático',
    creado: new Date().toISOString() }), { expirationTtl: RETENCION_SEGUNDOS });
  return true;
}
