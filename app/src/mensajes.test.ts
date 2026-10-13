// node --test src/mensajes.test.ts: conversaciones, ventana de 24 h y respuestas (Issues #287 y #290).
import test from 'node:test';
import assert from 'node:assert/strict';
import { conversaciones, responderApi } from './mensajes.ts';
import { permiso } from './cuentas.ts';

const AHORA = Date.parse('2026-10-12T20:00:00Z');
const evento = (mensajes: unknown[], contactos: unknown[] = []) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { contacts: contactos, messages: mensajes } }] }] });
const entrante = (id: string, de: string, cuando: string, texto = 'hola') => evento([{ id, from: de, type: 'text', text: { body: texto }, timestamp: String(Date.parse(cuando) / 1000) }], [{ wa_id: de, profile: { name: 'Ana' } }]);

function almacen(datos: Record<string, string> = {}) {
  const guardados = new Map<string, string>(Object.entries(datos));
  const kv = {
    list: async ({ prefix }: { prefix: string }) => ({ list_complete: true, keys: [...guardados.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, expiration: 1900000000 })) }),
    get: async (name: string) => guardados.get(name) ?? null,
    put: async (name: string, valor: string) => { guardados.set(name, valor); },
  } as unknown as KVNamespace;
  return { kv, guardados };
}
const enviosReales = (respuesta = 200, id = 'wamid.salida') => {
  const llamadas: { url: string; cuerpo: any; cabeceras: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, opciones: any) => {
    llamadas.push({ url, cuerpo: JSON.parse(opciones.body), cabeceras: opciones.headers });
    return new Response(JSON.stringify({ messages: [{ id }] }), { status: respuesta });
  }) as typeof fetch;
  return { llamadas, restaurar: () => { globalThis.fetch = original; } };
};
const pedir = (cuerpo: unknown) => new Request('https://personal.test/api/mensajes/responder', { method: 'POST', body: JSON.stringify(cuerpo) });

test('agrupa por cliente, con nombre, y marca si todavía se puede responder', async () => {
  const { kv } = almacen({
    'event:1': entrante('a', '5214421234567', '2026-10-12T19:00:00Z', 'Horario?'),
    'event:2': entrante('b', '5214429999999', '2026-10-10T10:00:00Z'),
  });
  const lista = (await conversaciones({ WHATSAPP_EVENTOS: kv } as Env, AHORA))!;
  assert.deepEqual(lista.map((c) => c.de), ['5214421234567', '5214429999999']);
  assert.equal(lista[0].nombre, 'Ana');
  assert.equal(lista[0].puede_responder, true);
  assert.equal(lista[1].puede_responder, false);
});

test('las respuestas del personal aparecen en la conversación con quien la envió', async () => {
  const { kv } = almacen({
    'event:1': entrante('a', '5214421234567', '2026-10-12T19:00:00Z'),
    'saliente:s1': JSON.stringify({ id: 's1', para: '5214421234567', texto: 'Claro', enviado_por: 'dueno@x.com', creado: '2026-10-12T19:05:00Z' }),
  });
  const [c] = (await conversaciones({ WHATSAPP_EVENTOS: kv } as Env, AHORA))!;
  assert.equal(c.mensajes.length, 2);
  assert.equal(c.mensajes[1].sentido, 'saliente');
  assert.equal(c.mensajes[1].enviado_por, 'dueno@x.com');
});

test('sin almacén (sandbox) no hay conversaciones', async () => {
  assert.equal(await conversaciones({} as Env), null);
});

test('responde dentro de 24 h, guarda la respuesta y no registra el texto en logs', async () => {
  const { kv, guardados } = almacen({ 'event:1': entrante('a', '5214421234567', new Date(Date.now() - 60_000).toISOString()) });
  const envios = enviosReales(200, 'wamid.nuevo');
  const errores: unknown[] = [];
  const original = console.error; console.error = (...a: unknown[]) => { errores.push(a); };
  try {
    const env = { WHATSAPP_EVENTOS: kv, WHATSAPP_ACCESS_TOKEN: 'token-prueba', WHATSAPP_PHONE_NUMBER_ID: '1433484303171531' } as unknown as Env;
    const r = await responderApi(pedir({ de: '5214421234567', texto: 'Sí, abrimos a las 11' }), env, 'dueno@x.com');
    assert.equal(r.status, 201);
    assert.equal(envios.llamadas[0].url, 'https://graph.facebook.com/v26.0/1433484303171531/messages');
    assert.equal(envios.llamadas[0].cabeceras.authorization, 'Bearer token-prueba');
    assert.equal(envios.llamadas[0].cuerpo.to, '5214421234567');
    const guardado = JSON.parse(guardados.get('saliente:wamid.nuevo')!);
    assert.equal(guardado.enviado_por, 'dueno@x.com');
    assert.equal(guardado.texto, 'Sí, abrimos a las 11');
    assert.equal(errores.length, 0);
  } finally { envios.restaurar(); console.error = original; }
});

test('fuera de la ventana de 24 h no envía nada', async () => {
  const { kv } = almacen({ 'event:1': entrante('a', '5214421234567', '2026-10-09T19:00:00Z') });
  const envios = enviosReales();
  try {
    const env = { WHATSAPP_EVENTOS: kv, WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'p' } as unknown as Env;
    const r = await responderApi(pedir({ de: '5214421234567', texto: 'hola' }), env, 'd@x.com');
    assert.equal(r.status, 409);
    assert.equal(envios.llamadas.length, 0);
  } finally { envios.restaurar(); }
});

test('entradas inválidas y falta de configuración se rechazan sin enviar', async () => {
  const { kv } = almacen({ 'event:1': entrante('a', '5214421234567', '2026-10-12T19:00:00Z') });
  const envios = enviosReales();
  try {
    const env = { WHATSAPP_EVENTOS: kv, WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'p' } as unknown as Env;
    assert.equal((await responderApi(pedir({ de: 'abc', texto: 'hola' }), env, 'd')).status, 400);
    assert.equal((await responderApi(pedir({ de: '5214421234567', texto: '   ' }), env, 'd')).status, 400);
    assert.equal((await responderApi(pedir({ de: '5214421234567', texto: 'x'.repeat(1001) }), env, 'd')).status, 400);
    assert.equal((await responderApi(pedir({ de: '5214421234567', texto: 'hola' }), { ...env, WHATSAPP_ACCESS_TOKEN: undefined } as Env, 'd')).status, 503);
    assert.equal(envios.llamadas.length, 0);
  } finally { envios.restaurar(); }
});

test('si Meta rechaza el envío, no se guarda como enviado', async () => {
  const { kv, guardados } = almacen({ 'event:1': entrante('a', '5214421234567', new Date(Date.now() - 60_000).toISOString()) });
  const envios = enviosReales(500);
  const original = console.error; console.error = () => {};
  try {
    const env = { WHATSAPP_EVENTOS: kv, WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'p' } as unknown as Env;
    assert.equal((await responderApi(pedir({ de: '5214421234567', texto: 'hola' }), env, 'd')).status, 502);
    assert.equal([...guardados.keys()].some((k) => k.startsWith('saliente:')), false);
  } finally { envios.restaurar(); console.error = original; }
});

test('la lectura y la respuesta son solo del dueño', () => {
  assert.deepEqual(permiso('/mensajes', 'GET'), []);
  assert.deepEqual(permiso('/api/mensajes', 'GET'), []);
  assert.deepEqual(permiso('/api/mensajes/responder', 'POST'), []);
});
