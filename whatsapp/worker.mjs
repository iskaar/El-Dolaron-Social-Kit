import { esSimple, respuestaFija, respuestaPara } from './respuestas.mjs';
import { enRafaga, MAX_TARJETAS, recortar, reservarModelo, SIN_CUOTA } from './limites.mjs';
import { atenderAlta } from './alta.mjs';
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
    // Issue #507: página de alta de coexistencia; responde 404 mientras ALTA_CONFIG_ID no exista.
    if (url.hostname === 'whatsapp.eldolaron.com' && url.pathname === '/alta') return atenderAlta(request, env);
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
 * si hay clave y el modelo contesta, y si no, al FAQ fijo. Si el asistente escala o el equipo
 * contesta desde la app (eco de coexistencia, #507), la conversacion queda pausada.
 */
async function responderMensajes(event, env) {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return;
  // Issue #507: el 442 y el 444 (coexistencia) comparten Worker; se contesta desde el número que
  // recibió el mensaje, solo si está en la lista. El primero es el de siempre (eventos sin metadata).
  const numeros = String(env.WHATSAPP_PHONE_NUMBER_ID).split(',').map((n) => n.trim()).filter(Boolean);
  for (const entrada of event.entry) {
    for (const cambio of entrada.changes ?? []) {
      // Issue #507 (coexistencia): el equipo contestó desde la app WhatsApp Business; el bot se calla
      // en ese chat la misma pausa que al escalar, para no contestar encima de una persona.
      if (cambio.field === 'smb_message_echoes') {
        for (const eco of cambio.value?.message_echoes ?? []) if (eco?.to) await pausar(env.EVENTS, eco.to);
        continue;
      }
      if (cambio.field !== 'messages') continue;
      const desde = cambio.value?.metadata?.phone_number_id ?? numeros[0];
      if (!numeros.includes(desde)) continue;
      for (const mensaje of cambio.value?.messages ?? []) {
        if ((mensaje.type !== 'text' && mensaje.type !== 'image') || !mensaje.id || !mensaje.from) continue;
        // Meta reintenta los eventos; la marca evita contestar dos veces el mismo mensaje.
        const marca = `respondido:${mensaje.id}`;
        if (await env.EVENTS.get(marca)) continue;
        await env.EVENTS.put(marca, '1', { expirationTtl: 7 * 86400 });
        const de = mensaje.from;
        if (await estaPausado(env.EVENTS, de)) continue;
        // Issue #503: un número que manda demasiado por minuto no recibe nada (ni FAQ): corta bucles y floods.
        if (await enRafaga(env.EVENTS, de)) { console.log(JSON.stringify({ event: 'whatsapp_limite', motivo: 'rafaga' })); continue; }

        if (mensaje.type === 'image') {
          await enviarYGuardar(env, desde, de, IMAGEN);
          continue;
        }
        const texto = String(mensaje.text?.body ?? '');
        const historial = await leerHistorial(env.EVENTS, de);
        if (esFinDeConversacion(texto, historial.length > 0)) continue;

        let respuesta;
        let tarjetas = [];
        const fija = esSimple(texto) ? respuestaFija(texto) : null;
        if (fija) {
          respuesta = { texto: fija, puntaje: 0, escalar: false };
        } else {
          // Issue #503: cuota del modelo por número y por día para toda la tienda; el FAQ fijo no la gasta.
          const limite = env.ANTHROPIC_API_KEY ? await reservarModelo(env.EVENTS, de) : null;
          if (limite) console.log(JSON.stringify({ event: 'whatsapp_limite', motivo: limite }));
          try {
            if (!env.ANTHROPIC_API_KEY) throw new Error('sin clave');
            if (limite === 'global') throw new Error('cuota global');
            if (limite === 'numero') respuesta = { texto: SIN_CUOTA, puntaje: 0, escalar: false };
            else {
              // Issue #499 (B.4): las piezas con foto pública de la última búsqueda van como tarjetas.
              const consultar = env.TIENDA && env.ASISTENTE_TOKEN ? async (nombre, entrada) => {
                const resultado = await consultarTienda(env, nombre, entrada);
                if (nombre === 'buscar_productos') tarjetas = (resultado.productos ?? []).filter((p) => p.foto && p.codigo).slice(0, MAX_TARJETAS);
                return resultado;
              } : null;
              respuesta = interpretar(await generarRespuesta(historial, recortar(texto), env.ANTHROPIC_API_KEY, consultar));
            }
          } catch (error) {
            // Issue #499: sin esto el fallo del modelo era invisible y el cliente solo veía el respaldo.
            // Solo el motivo corto (p. ej. «modelo 401»), nunca la clave ni el texto del cliente.
            console.error(JSON.stringify({ event: 'whatsapp_modelo_fallo', motivo: String(error?.message ?? error).slice(0, 120) }));
            respuesta = { texto: respuestaPara(texto), puntaje: 0, escalar: false };
            tarjetas = [];
          }
        }
        if (!respuesta.texto) continue;
        if (!await enviarYGuardar(env, desde, de, respuesta.texto)) continue;
        await guardarTurno(env.EVENTS, de, texto, respuesta.texto);
        for (const p of tarjetas) await enviarYGuardar(env, desde, de, `${p.nombre} · ${p.precio} · ${p.codigo}\n${p.url}`, p.foto);
        if (respuesta.escalar) await pausar(env.EVENTS, de);
      }
    }
  }
}

const IMAGEN = 'Recibimos tu imagen. Escríbenos tu pregunta por texto y te ayudamos.';

// Herramientas que atiende la tienda (Issue #296, #499): nombre → ruta de solo lectura y sus parámetros.
const RUTAS = {
  buscar_productos: ['productos', { q: 'q', categoria: 'categoria', talla: 'talla', precio_min: 'min', precio_max: 'max' }],
  cupos_promocion: ['promocion', {}],
};

/** Consulta de solo lectura en la app principal. Otra herramienta, error; el token nunca sale a logs. */
async function consultarTienda(env, nombre, entrada) {
  const ruta = Object.hasOwn(RUTAS, nombre) ? RUTAS[nombre] : null;
  if (!ruta) throw new Error('herramienta desconocida');
  const params = new URLSearchParams();
  for (const [de, a] of Object.entries(ruta[1])) {
    const valor = entrada?.[de];
    if (valor !== undefined && valor !== null && valor !== '') params.set(a, String(valor));
  }
  const consulta = String(params) ? `?${params}` : '';
  const respuesta = await env.TIENDA.fetch(new Request(`https://tienda.interno/api/asistente/${ruta[0]}${consulta}`, {
    headers: { 'x-asistente-token': env.ASISTENTE_TOKEN },
  }));
  if (!respuesta.ok) throw new Error(`tienda ${respuesta.status}`);
  return respuesta.json();
}

/**
 * Envia el texto por Meta y lo registra para la vista de mensajes. Nunca registra el texto en logs.
 * Con `foto` manda una imagen por enlace y el texto como pie (tarjeta de producto, #499).
 */
async function enviarYGuardar(env, desde, para, texto, foto = null) {
  const envio = await fetch(`https://graph.facebook.com/v26.0/${desde}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para,
      ...(foto ? { type: 'image', image: { link: foto, caption: texto } } : { type: 'text', text: { body: texto } }) }),
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
