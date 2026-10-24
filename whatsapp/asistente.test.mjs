import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from './worker.mjs';
import { HERRAMIENTAS, PAUSA_SEGUNDOS, PROMPT, UBICACION, esFinDeConversacion, generarRespuesta, interpretar } from './asistente.mjs';
import { MAX_TARJETAS } from './limites.mjs';

const endpoint = 'https://whatsapp.eldolaron.com/webhook';
const secreto = 'test-app-secret';
const firmado = (cuerpo) => new Request(endpoint, {
  method: 'POST', body: cuerpo,
  headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}` },
});
const evento = (mensajes) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: mensajes } }] }] });
const texto = (id, de, cuerpo) => ({ id, from: de, type: 'text', text: { body: cuerpo } });

function kv(datos = {}) {
  const guardados = new Map(Object.entries(datos));
  return {
    guardados,
    get: async (k, tipo) => {
      const v = guardados.get(k);
      if (v === undefined) return null;
      return tipo === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { guardados.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    list: async () => ({ list_complete: true, keys: [] }),
  };
}

/** Simula Claude y Meta. `respuestaModelo` es el texto que devuelve el modelo, o null para fallar. */
function red(respuestaModelo) {
  const llamadas = { modelo: [], meta: [], urls: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opciones) => {
    const cuerpo = JSON.parse(opciones.body);
    if (String(url).includes('anthropic')) {
      llamadas.modelo.push({ url, cuerpo, cabeceras: opciones.headers });
      if (respuestaModelo === null) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: respuestaModelo }] }), { status: 200 });
    }
    llamadas.meta.push(cuerpo);
    llamadas.urls.push(String(url));
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${llamadas.meta.length}` }] }), { status: 200 });
  };
  return { llamadas, restaurar: () => { globalThis.fetch = original; } };
}
const pendientes = [];
const ctx = { waitUntil: (p) => pendientes.push(p) };
const entorno = (datos = {}, extra = {}) => ({
  WHATSAPP_VERIFY_TOKEN: 'v', META_APP_SECRET: secreto, WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'p',
  EVENTS: kv(datos), ...extra,
});
const correr = async (env, mensajes) => {
  await worker.fetch(firmado(evento(mensajes)), env, ctx);
  await Promise.all(pendientes.splice(0));
};

test('interpreta SCORE y ESCALAR sin mostrarlos al cliente', () => {
  const r = interpretar('Abrimos de 11:00 a 20:00.\nSCORE: 2');
  assert.equal(r.texto, 'Abrimos de 11:00 a 20:00.');
  assert.equal(r.puntaje, 2);
  assert.equal(r.escalar, false);
  assert.equal(interpretar('Lo confirmo con el equipo. ESCALAR\nSCORE: 3').escalar, true);
  assert.equal(interpretar('Te esperamos.\nSCORE: 8').escalar, true);
  // Issue #499: negritas de WhatsApp con un asterisco.
  assert.equal(interpretar('Tenemos una **Sudadera** ($200) y una **Playera**.\nSCORE: 4').texto, 'Tenemos una *Sudadera* ($200) y una *Playera*.');
});

test('mensajes de cierre no se contestan con historial', () => {
  assert.equal(esFinDeConversacion('gracias', true), true);
  assert.equal(esFinDeConversacion('gracias', false), false);
  assert.equal(esFinDeConversacion('¿?', true), false);
});

test('el prompt solo afirma los datos aprobados', () => {
  assert.match(PROMPT, /444 543 7754/);
  assert.match(PROMPT, /11:00 a 20:00/);
  assert.match(PROMPT, /ventas son en sucursal/);
  assert.match(PROMPT, /no inventes nada/);
  // Issue #499: conversa en general, pero el dato de la tienda sigue cerrado a la lista.
  assert.match(PROMPT, /Puedes conversar y orientar en general/);
  assert.match(PROMPT, /ningún otro/);
  assert.match(PROMPT, /este mismo chat/);
  assert.match(PROMPT, /un solo asterisco/);
  // Issue #497: la gran inauguración, la ubicación y el apartado son datos aprobados; los envíos se escalan.
  assert.match(PROMPT, /sábado 24 y domingo 25 de octubre de 2026/);
  assert.match(PROMPT, /primeras 100 compras de \$300 o más.*\$100 en caja/);
  assert.match(PROMPT, /Jardín Hidalgo 129/);
  assert.match(PROMPT, /15 % del valor.*7 días/);
  assert.match(PROMPT, /envíos.*no afirmes ni niegues/);
});

test('llama al modelo con el prompt y el historial, y propaga los errores', async () => {
  const r = red('Hola, con gusto.\nSCORE: 1');
  try {
    const texto = await generarRespuesta([{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'hola' }], '¿abren?', 'clave');
    assert.equal(texto, 'Hola, con gusto.\nSCORE: 1');
    const llamada = r.llamadas.modelo[0];
    assert.equal(llamada.cuerpo.model, 'claude-haiku-5-5');
    assert.equal(llamada.cuerpo.system, PROMPT);
    assert.equal(llamada.cuerpo.messages.at(-1).content, '¿abren?');
    assert.equal(llamada.cabeceras['x-api-key'], 'clave');
  } finally { r.restaurar(); }
  const fallo = red(null);
  try {
    await assert.rejects(generarRespuesta([], 'hola', 'clave'));
  } finally { fallo.restaurar(); }
});

test('el asistente responde, guarda el turno y registra la respuesta para el personal', async () => {
  const r = red('Abrimos de 11:00 a 20:00.\nSCORE: 2');
  try {
    const env = entorno({}, { ANTHROPIC_API_KEY: 'clave' });
    await correr(env, [texto('m1', '5214421234567', '¿Qué me recomiendan para un regalo de cumpleaños de mi mamá?')]);
    assert.equal(r.llamadas.meta.length, 1);
    assert.equal(r.llamadas.meta[0].text.body, 'Abrimos de 11:00 a 20:00.');
    const historial = JSON.parse(env.EVENTS.guardados.get('historial:5214421234567'));
    assert.deepEqual(historial.map((t) => t.role), ['user', 'assistant']);
    const salida = [...env.EVENTS.guardados.entries()].find(([k]) => k.startsWith('saliente:'));
    assert.equal(JSON.parse(salida[1]).enviado_por, 'asistente automático');
  } finally { r.restaurar(); }
});

test('si el asistente escala, la conversación queda pausada y no vuelve a contestar', async () => {
  const r = red('Eso lo confirmo con el equipo. ESCALAR');
  try {
    const env = entorno({}, { ANTHROPIC_API_KEY: 'clave' });
    await correr(env, [texto('m2', '5214421234567', '¿Tienen promociones?')]);
    assert.equal(env.EVENTS.guardados.has('pausado:5214421234567'), true);
    await correr(env, [texto('m3', '5214421234567', '¿Y los precios?')]);
    assert.equal(r.llamadas.modelo.length, 1);
    assert.equal(r.llamadas.meta.length, 1);
  } finally { r.restaurar(); }
});

test('si el modelo falla o no hay clave, responde con el FAQ fijo', async () => {
  const r = red(null);
  try {
    const env = entorno({}, { ANTHROPIC_API_KEY: 'clave' });
    await correr(env, [texto('m4', '5214421234567', 'horario')]);
    assert.match(r.llamadas.meta[0].text.body, /11 a\. m\. a 8 p\. m\./);
  } finally { r.restaurar(); }
  const sinClave = red('no debe usarse');
  try {
    await correr(entorno(), [texto('m5', '5214429999999', 'telefono')]);
    assert.match(sinClave.llamadas.meta[0].text.body, /444 543 7754/);
    assert.equal(sinClave.llamadas.modelo.length, 0);
  } finally { sinClave.restaurar(); }
});

test('un mensaje corto del FAQ se contesta fijo sin llamar al modelo; uno largo sí va al modelo (#499)', async () => {
  const r = red('Claro, te cuento.\nSCORE: 3');
  try {
    const env = entorno({}, { ANTHROPIC_API_KEY: 'clave' });
    await correr(env, [texto('f1', '5214421234567', 'hola buenas')]);
    assert.match(r.llamadas.meta[0].text.body, /inauguración/);
    assert.equal(r.llamadas.modelo.length, 0);
    await correr(env, [texto('f2', '5214421234567', 'hola, ¿dónde consigo una blusa talla M para un regalo de cumpleaños?')]);
    assert.equal(r.llamadas.modelo.length, 1);
    assert.match(r.llamadas.meta[1].text.body, /Claro, te cuento/);
  } finally { r.restaurar(); }
});

test('una imagen recibe la respuesta corta, sin el modelo', async () => {
  const r = red('no debe usarse');
  try {
    await correr(entorno({}, { ANTHROPIC_API_KEY: 'clave' }), [{ id: 'm6', from: '5214421234567', type: 'image', image: {} }]);
    assert.match(r.llamadas.meta[0].text.body, /Recibimos tu imagen/);
    assert.equal(r.llamadas.modelo.length, 0);
  } finally { r.restaurar(); }
});

/** Modelo que responde en secuencia (herramienta, luego texto) y Meta que registra envíos. */
function redSecuencia(respuestas) {
  const modelo = [];
  const meta = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opciones) => {
    if (String(url).includes('anthropic')) {
      modelo.push(JSON.parse(opciones.body));
      const siguiente = respuestas.shift();
      return new Response(JSON.stringify(siguiente), { status: 200 });
    }
    meta.push(JSON.parse(opciones.body));
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${meta.length}` }] }), { status: 200 });
  };
  return { modelo, meta, restaurar: () => { globalThis.fetch = original; } };
}
const herramienta = (q) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'buscar_productos', input: { q } }] });
const textoFinal = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });

test('el modelo consulta productos y la respuesta usa lo que devolvió la tienda', async () => {
  const consultas = [];
  const r = redSecuencia([herramienta('camisa'), textoFinal('Tenemos Camisa polo a $250.00.\nSCORE: 4')]);
  try {
    const texto = await generarRespuesta([], '¿tienen camisas?', 'clave', async (nombre, entrada) => {
      consultas.push([nombre, entrada]);
      return { productos: [{ nombre: 'Camisa polo', precio: '$250.00' }] };
    });
    assert.equal(texto, 'Tenemos Camisa polo a $250.00.\nSCORE: 4');
    assert.deepEqual(consultas, [['buscar_productos', { q: 'camisa' }]]);
    assert.equal(r.modelo[0].tools[0].name, 'buscar_productos');
    const resultado = r.modelo[1].messages.at(-1).content[0];
    assert.equal(resultado.type, 'tool_result');
    assert.match(resultado.content, /Camisa polo/);
  } finally { r.restaurar(); }
});

test('sin consulta disponible el modelo no recibe herramientas', async () => {
  const r = redSecuencia([textoFinal('Lo confirmo con el equipo. ESCALAR')]);
  try {
    await generarRespuesta([], '¿tienen camisas?', 'clave', null);
    assert.equal(r.modelo[0].tools, undefined);
  } finally { r.restaurar(); }
});

test('el ciclo de herramientas tiene un tope', async () => {
  const r = redSecuencia([herramienta('a'), herramienta('b'), herramienta('c')]);
  try {
    await assert.rejects(generarRespuesta([], 'hola', 'clave', async () => ({ productos: [] })), /demasiados pasos/);
    assert.equal(r.modelo.length, 3);
  } finally { r.restaurar(); }
});

test('el Worker atiende la consulta por el enlace privado con el token y responde al cliente', async () => {
  const r = redSecuencia([herramienta('camisa'), textoFinal('Tenemos Camisa polo a $250.00.\nSCORE: 3')]);
  const llamadasTienda = [];
  const env = entorno({}, {
    ANTHROPIC_API_KEY: 'clave', ASISTENTE_TOKEN: 'token-enlace',
    TIENDA: { fetch: async (peticion) => {
      llamadasTienda.push({ url: peticion.url, token: peticion.headers.get('x-asistente-token') });
      return new Response(JSON.stringify({ productos: [{ nombre: 'Camisa polo', precio: '$250.00' }] }), { status: 200 });
    } },
  });
  try {
    await correr(env, [texto('m7', '5214421234567', '¿tienen camisas?')]);
    assert.equal(llamadasTienda.length, 1);
    assert.match(llamadasTienda[0].url, /\/api\/asistente\/productos\?q=camisa$/);
    assert.equal(llamadasTienda[0].token, 'token-enlace');
    assert.equal(r.meta[0].text.body, 'Tenemos Camisa polo a $250.00.');
  } finally { r.restaurar(); }
});

// Issue #499, fase B: herramientas nuevas y tarjetas de producto.
const usar = (name, input = {}, id = 't1') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const pieza = (n, conFoto = true) => ({
  nombre: `Blusa ${n}`, precio: '$150.00', talla: 'M', disponibilidad: 'disponible',
  codigo: conFoto ? `ED-00000${n}` : null, foto: conFoto ? `https://dolarones.eldolaron.com/api/catalogo/foto/ED-00000${n}` : null,
  url: conFoto ? 'https://eldolaron.com/#catalogo' : null,
});
/** Tienda simulada por el service binding: registra rutas y responde según la ruta. */
function tiendaSimulada(respuestas) {
  const llamadas = [];
  return { llamadas, fetch: async (peticion) => {
    const url = new URL(peticion.url);
    llamadas.push({ ruta: url.pathname, params: Object.fromEntries(url.searchParams), token: peticion.headers.get('x-asistente-token') });
    return new Response(JSON.stringify(respuestas[url.pathname] ?? { error: 'no' }), { status: respuestas[url.pathname] ? 200 : 404 });
  } };
}

test('#499: el prompt obliga a consultar cupos, disponibilidad y mapa en vez de inventarlos', () => {
  assert.deepEqual(HERRAMIENTAS.map((h) => h.name), ['buscar_productos', 'cupos_promocion', 'horario_y_ubicacion']);
  assert.match(PROMPT, /usa cupos_promocion/);
  assert.match(PROMPT, /Nunca digas una cantidad sin consultarla/);
  assert.match(PROMPT, /ya se acabaron/);
  assert.match(PROMPT, /nunca cantidades/);
  assert.match(PROMPT, /horario_y_ubicacion/);
  // La categoría solo acepta las claves de la tienda.
  assert.ok(HERRAMIENTAS[0].input_schema.properties.categoria.enum.includes('ropa'));
});

test('#499: horario_y_ubicacion responde con datos confirmados sin tocar la tienda', async () => {
  const r = redSecuencia([usar('horario_y_ubicacion'), textoFinal('Abrimos de 11:00 a 20:00.\nSCORE: 2')]);
  try {
    let consultas = 0;
    await generarRespuesta([], '¿cómo llego?', 'clave', async () => { consultas++; return {}; });
    assert.equal(consultas, 0);
    const resultado = JSON.parse(r.modelo[1].messages.at(-1).content[0].content);
    assert.deepEqual(resultado, UBICACION);
    assert.match(UBICACION.direccion, /Jardín Hidalgo 129/);
    assert.match(UBICACION.horario, /11:00 a 20:00/);
    assert.match(UBICACION.mapa, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=Jard%C3%ADn%20Hidalgo%20129/);
  } finally { r.restaurar(); }
});

test('#499: cupos_promocion va a la ruta de solo lectura y el modelo recibe el «ya se acabaron» de la tienda', async () => {
  const agotada = { estado: 'agotada', restantes: 0, mensaje: 'Ya se acabaron los descuentos de la promoción.' };
  const r = redSecuencia([usar('cupos_promocion'), textoFinal('Ya se acabaron los descuentos.\nSCORE: 3')]);
  const tienda = tiendaSimulada({ '/api/asistente/promocion': agotada });
  try {
    const env = entorno({}, { ANTHROPIC_API_KEY: 'clave', ASISTENTE_TOKEN: 'token-enlace', TIENDA: tienda });
    await correr(env, [texto('p1', '5214421234567', '¿todavía alcanzo el descuento de la inauguración si voy en la tarde?')]);
    assert.deepEqual(tienda.llamadas, [{ ruta: '/api/asistente/promocion', params: {}, token: 'token-enlace' }]);
    assert.deepEqual(JSON.parse(r.modelo[1].messages.at(-1).content[0].content), agotada);
    assert.equal(r.meta.length, 1, 'sin búsqueda de productos no hay tarjetas');
  } finally { r.restaurar(); }
});

test('#499: una herramienta que no existe no llega a la tienda', async () => {
  const r = redSecuencia([usar('borrar_inventario', { todo: true }), textoFinal('Lo confirmo con el equipo. ESCALAR')]);
  const tienda = tiendaSimulada({});
  try {
    const env = entorno({}, { ANTHROPIC_API_KEY: 'clave', ASISTENTE_TOKEN: 'token-enlace', TIENDA: tienda });
    await correr(env, [texto('p2', '5214421234567', 'necesito que me ayudes con algo de la tienda por favor')]);
    assert.equal(tienda.llamadas.length, 0);
    assert.match(r.modelo[1].messages.at(-1).content[0].content, /error/);
  } finally { r.restaurar(); }
});

test('#499 B.4: tras buscar_productos manda el texto y luego a lo más 3 tarjetas con foto', async () => {
  const productos = [pieza(1), pieza(2, false), pieza(3), pieza(4), pieza(5)];
  const r = redSecuencia([usar('buscar_productos', { q: 'blusa', categoria: 'ropa', talla: 'M', precio_max: 200 }),
    textoFinal('Tengo varias blusas talla M desde $150.00.\nSCORE: 5')]);
  const tienda = tiendaSimulada({ '/api/asistente/productos': { productos } });
  try {
    const env = entorno({}, { ANTHROPIC_API_KEY: 'clave', ASISTENTE_TOKEN: 'token-enlace', TIENDA: tienda });
    await correr(env, [texto('p3', '5214421234567', '¿tienen blusas talla M de menos de 200 pesos?')]);
    assert.deepEqual(tienda.llamadas[0].params, { q: 'blusa', categoria: 'ropa', talla: 'M', max: '200' });
    assert.equal(MAX_TARJETAS, 3);
    assert.equal(r.meta.length, 1 + MAX_TARJETAS);
    assert.equal(r.meta[0].type, 'text');
    assert.equal(r.meta[0].text.body, 'Tengo varias blusas talla M desde $150.00.');
    const tarjetas = r.meta.slice(1);
    assert.ok(tarjetas.every((m) => m.type === 'image' && m.to === '5214421234567'));
    // La pieza sin foto pública se salta; el orden es el de la tienda.
    assert.deepEqual(tarjetas.map((m) => m.image.link), [1, 3, 4].map((n) => `https://dolarones.eldolaron.com/api/catalogo/foto/ED-00000${n}`));
    assert.equal(tarjetas[0].image.caption, 'Blusa 1 · $150.00 · ED-000001\nhttps://eldolaron.com/#catalogo');
    // Las tarjetas quedan en la vista de mensajes del personal, pero el historial del modelo solo guarda el texto.
    assert.equal([...env.EVENTS.guardados.keys()].filter((k) => k.startsWith('saliente:')).length, 4);
    assert.equal(JSON.parse(env.EVENTS.guardados.get('historial:5214421234567')).length, 2);
  } finally { r.restaurar(); }
});

test('#499 B.4: si el modelo falla después de buscar, no manda tarjetas sueltas', async () => {
  const r = redSecuencia([usar('buscar_productos', { q: 'blusa' }), { stop_reason: 'end_turn', content: [] }]);
  const tienda = tiendaSimulada({ '/api/asistente/productos': { productos: [pieza(1)] } });
  try {
    const env = entorno({}, { ANTHROPIC_API_KEY: 'clave', ASISTENTE_TOKEN: 'token-enlace', TIENDA: tienda });
    await correr(env, [texto('p4', '5214421234567', '¿tienen blusas bonitas para regalar a mi hermana?')]);
    assert.equal(r.meta.length, 1);
    assert.equal(r.meta[0].type, 'text');
  } finally { r.restaurar(); }
});

test('escalar no deja al cliente sin respuesta todo el día y no encontrar una pieza no escala', () => {
  assert.ok(PAUSA_SEGUNDOS <= 3600);
  assert.match(PROMPT, /no aparece lo que buscan[^\n]*no agregues ESCALAR/);
});

test('#507: un mensaje del equipo desde la app (eco de coexistencia) calla al bot en ese chat y en ningún otro', async () => {
  const r = red('Claro, te ayudo.\nSCORE: 2');
  try {
    const env = entorno({}, { ANTHROPIC_API_KEY: 'clave' });
    const eco = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'smb_message_echoes', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: 'p' },
      message_echoes: [{ from: '524445437754', to: '5214421234567', id: 'eco1', type: 'text', text: { body: 'Hola, sí la tenemos' } }],
    } }] }] });
    await worker.fetch(firmado(eco), env, ctx);
    await Promise.all(pendientes.splice(0));
    assert.equal(env.EVENTS.guardados.has('pausado:5214421234567'), true);
    assert.equal(r.llamadas.meta.length + r.llamadas.modelo.length, 0);
    await correr(env, [texto('m-eco1', '5214421234567', '¿Me la apartan para mañana en la tarde, por favor?')]);
    assert.equal(r.llamadas.meta.length, 0);
    await correr(env, [texto('m-eco2', '5214429999999', '¿Qué me recomiendan para un regalo de cumpleaños?')]);
    assert.equal(r.llamadas.meta.length, 1);
  } finally { r.restaurar(); }
});

test('#507: contesta desde el número que recibió el mensaje, y nunca desde uno fuera de la lista', async () => {
  const r = red('Claro, te ayudo.\nSCORE: 2');
  try {
    const env = entorno({}, { WHATSAPP_PHONE_NUMBER_ID: 'p442, p444' });
    const a = (numero, id, de) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: numero }, messages: [texto(id, de, 'Hola')],
    } }] }] });
    for (const [numero, id] of [['p444', 'n1'], ['p442', 'n2'], ['ajeno', 'n3']]) {
      await worker.fetch(firmado(a(numero, id, `52144212345${id.at(-1)}`)), env, ctx);
      await Promise.all(pendientes.splice(0));
    }
    assert.deepEqual(r.llamadas.urls, ['https://graph.facebook.com/v26.0/p444/messages', 'https://graph.facebook.com/v26.0/p442/messages']);
  } finally { r.restaurar(); }
});
