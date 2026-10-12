import { respuestaPara } from './respuestas.mjs';

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

/** Responde solo a mensajes de texto que el cliente envio; cada mensaje se contesta una vez. */
async function responderMensajes(event, env) {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return;
  for (const entrada of event.entry) {
    for (const cambio of entrada.changes ?? []) {
      if (cambio.field !== 'messages') continue;
      for (const mensaje of cambio.value?.messages ?? []) {
        if (mensaje.type !== 'text' || !mensaje.id || !mensaje.from) continue;
        // Meta reintenta los eventos; la marca evita contestar dos veces el mismo mensaje.
        const marca = `respondido:${mensaje.id}`;
        if (await env.EVENTS.get(marca)) continue;
        await env.EVENTS.put(marca, '1', { expirationTtl: 7 * 86400 });
        const envio = await fetch(`https://graph.facebook.com/v26.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: mensaje.from, type: 'text',
            text: { body: respuestaPara(mensaje.text?.body) } }),
        });
        if (!envio.ok) console.error(JSON.stringify({ event: 'whatsapp_reply_failed', status: envio.status }));
      }
    }
  }
}
