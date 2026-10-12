// node --test src/mensajes.test.ts: lectura de mensajes de WhatsApp (Issue #287).
import test from 'node:test';
import assert from 'node:assert/strict';
import { listarMensajes } from './mensajes.ts';
import { permiso } from './cuentas.ts';

const evento = (mensajes: unknown[], contactos: unknown[] = []) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { contacts: contactos, messages: mensajes } }] }] });
function almacen(eventos: Record<string, string>, vence = 1900000000) {
  return {
    list: async ({ prefix }: { prefix: string }) => ({ list_complete: true, keys: Object.keys(eventos).filter((k) => k.startsWith(prefix)).map((name) => ({ name, expiration: vence })) }),
    get: async (name: string) => eventos[name] ?? null,
  } as unknown as KVNamespace;
}

test('lee mensajes de texto con nombre, numero y hora, del mas reciente al mas antiguo', async () => {
  const kv = almacen({
    'event:1': evento([{ id: 'a', from: '5214421234567', type: 'text', text: { body: 'Horario?' }, timestamp: '1700000000' }], [{ wa_id: '5214421234567', profile: { name: 'Ana' } }]),
    'event:2': evento([{ id: 'b', from: '5214429999999', type: 'image', image: {}, timestamp: '1800000000' }]),
    'respondido:c': '1',
  });
  const mensajes = await listarMensajes({ WHATSAPP_EVENTOS: kv } as Env);
  assert.equal(mensajes!.length, 2);
  assert.equal(mensajes![0].id, 'b');
  assert.equal(mensajes![0].texto, '[image]');
  assert.equal(mensajes![1].nombre, 'Ana');
  assert.equal(mensajes![1].texto, 'Horario?');
  assert.equal(mensajes![1].de, '5214421234567');
});

test('sin almacen configurado (sandbox) no muestra nada', async () => {
  assert.equal(await listarMensajes({} as Env), null);
});

test('eventos corruptos se ignoran sin tumbar la lista', async () => {
  const kv = almacen({ 'event:x': '{roto', 'event:y': evento([{ id: 'ok', from: '1', type: 'text', text: { body: 'hola' }, timestamp: '1' }]) });
  const mensajes = await listarMensajes({ WHATSAPP_EVENTOS: kv } as Env);
  assert.deepEqual(mensajes!.map((m) => m.id), ['ok']);
});

test('la lectura es solo del dueño', () => {
  assert.deepEqual(permiso('/mensajes', 'GET'), []);
  assert.deepEqual(permiso('/api/mensajes', 'GET'), []);
});
