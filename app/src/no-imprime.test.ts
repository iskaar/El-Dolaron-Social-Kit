// «Este aparato no imprime» (#781): la guarda unica de etiquetera.js y su efecto en Capturar. El motor completo
// (ningun reclamo en la base) se prueba en etiquetas-automaticas.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { conectarEtiquetera, reconectarEtiquetera, etiqueteraLista, mandarTspl, errorEnvio, noImprime, ponerNoImprime, MENSAJE_NO_IMPRIME } from '../public/etiquetera.js';

/** localStorage de mentira mientras corre `fn` (se limpia siempre: el interruptor no puede quedar encendido para otros tests). */
async function conAlmacen<R>(fn: () => Promise<R> | R): Promise<R> {
  const almacen = new Map<string, string>(), g = globalThis as any, previo = Object.getOwnPropertyDescriptor(g, 'localStorage');
  Object.defineProperty(g, 'localStorage', { configurable: true, writable: true,
    value: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => almacen.set(k, v), removeItem: (k: string) => almacen.delete(k) } });
  try { return await fn(); } finally { if (previo) Object.defineProperty(g, 'localStorage', previo); else delete g.localStorage; }
}

test('con el interruptor encendido: no hay impresora lista, no se reconecta ni se pide permiso Bluetooth, y se desconecta la actual', () => conAlmacen(async () => {
  const navegador = globalThis.navigator as unknown as { bluetooth?: unknown };
  const llamadas = { requestDevice: 0, getDevices: 0, desconectada: 0, escrito: 0 };
  const aparato: any = {
    name: 'AE240-bt_1DDE-LE', addEventListener(_e: string, fn: () => void) { aparato.alSoltar = fn; },
    gatt: { connected: true, disconnect() { llamadas.desconectada++; aparato.alSoltar?.(); }, connect: async () => ({ getPrimaryService: async () => ({
      getCharacteristic: async () => ({ properties: { writeWithoutResponse: true }, writeValueWithoutResponse: async () => { llamadas.escrito++; } }) }) }) },
  };
  navegador.bluetooth = { requestDevice: async () => { llamadas.requestDevice++; return aparato; }, getDevices: async () => { llamadas.getDevices++; return [aparato]; } };
  try {
    // Apagado todo funciona como siempre: se conecta y queda lista.
    assert.equal(noImprime(), false);
    await conectarEtiquetera();
    assert.equal(etiqueteraLista(), true);
    assert.equal(llamadas.requestDevice, 1);

    // Encendido: suelta el enlace y ninguna entrada vuelve a abrirlo.
    assert.equal(ponerNoImprime(true), true);
    assert.equal(llamadas.desconectada, 1);
    assert.equal(etiqueteraLista(), false);
    assert.equal(await reconectarEtiquetera(), false);
    await assert.rejects(conectarEtiquetera(), (e: any) => e.noImprime === true && e.message === MENSAJE_NO_IMPRIME && /no imprime.*PC/.test(e.message));
    await assert.rejects(conectarEtiquetera({ cualquiera: true }), /no imprime/);
    assert.equal(await mandarTspl('SIZE 50.8 mm,25.4 mm\r\n'), false);
    assert.equal(errorEnvio(), MENSAJE_NO_IMPRIME);
    assert.deepEqual(llamadas, { requestDevice: 1, getDevices: 0, desconectada: 1, escrito: 0 });

    // Apagado otra vez, vuelve a conectar sin recargar.
    assert.equal(ponerNoImprime(false), false);
    await conectarEtiquetera();
    assert.equal(etiqueteraLista(), true);
    assert.equal(llamadas.requestDevice, 2);
  } finally { delete navegador.bluetooth; ponerNoImprime(false); }
}));

test('sin almacenamiento el interruptor no lanza: se queda apagado', () => {
  const g = globalThis as any, previo = Object.getOwnPropertyDescriptor(g, 'localStorage');
  Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); }, removeItem() { throw new Error('bloqueado'); } } });
  try { assert.equal(noImprime(), false); assert.equal(ponerNoImprime(true), false); } finally { if (previo) Object.defineProperty(g, 'localStorage', previo); else delete g.localStorage; }
});

test('Capturar con el interruptor: la etiqueta ni se pide ni deja la alerta roja del modo enfocado', async () => {
  const fuente = readFileSync('public/inventario-capturar.js', 'utf8');
  const trozo = fuente.slice(fuente.indexOf('let impresionPedida=false;'), fuente.indexOf('const flujo=crearCaptura'));
  const apagado = true;   // el interruptor; la impresora sigue «conectada» pero no debe usarse
  const envios: unknown[] = [], ctx: any = { problemas: {}, imprimir: async (...a: unknown[]) => { envios.push(a); return true; } };
  const imprimir = runInNewContext(`${trozo};imprimir`, { ctx, etiqueteraLista: () => true, noImprime: () => apagado, Map });
  assert.equal(await imprimir('a', 1), false);
  assert.equal(await imprimir('a', 1, { reimprimir: true }), false);
  assert.deepEqual(envios, [], 'ningun envio ni reclamo');
  assert.equal(ctx.problemas.impresora(), false, 'sin «Impresora sin conectar · falta etiqueta»');
  // Sin el interruptor y sin impresora conectada, como antes: pide la etiqueta y alerta.
  const sinImpresora = runInNewContext(`${trozo};imprimir`, { ctx, etiqueteraLista: () => false, noImprime: () => false, Map });
  assert.equal(await sinImpresora('a', 1), false);
  assert.equal(ctx.problemas.impresora(), true);
});

test('los textos de Capturar y de la revision no prometen ni confirman etiqueta con el interruptor', () => {
  const capturar = readFileSync('public/inventario-capturar.js', 'utf8'), celular = readFileSync('public/inventario-celular.js', 'utf8');
  assert.match(capturar, /noImprime\(\)\)mensaje\('Guardada · la etiqueta sale en la PC','aviso'\)/);
  assert.match(capturar, /!noImprime\(\)\)tarjeta\.append\(boton\(`Imprimir/, '«Imprimir N etiquetas» no se ofrece');
  assert.match(capturar, /estado_analisis==='listo'&&!noImprime\(\)\?`Sumar \$\{k\} e imprimir/, '«Sumar N e imprimir N» pasa a «Sumar N»');
  assert.match(celular, /noImprime\(\)\)mensaje\(`Guardada · la etiqueta de/);
  assert.match(celular, /faltan&&noImprime\(\)\)mensaje\(`Faltan/, 'la correccion de cantidad dice que se reimprime en la PC');
  const hoja = readFileSync('public/inventario-imprimir.js', 'utf8');
  assert.match(hoja, /boton\('Este aparato no imprime'[\s\S]*setAttribute\('role','switch'\)/, 'el interruptor vive en la hoja Impresora');
  assert.match(hoja, /'○ No imprime'/, 'el chip lo dice');
  assert.match(hoja, /boton\('Marcar como impresas',\(\)=>\{if\(noImprime\(\)\)/, 'tampoco marca como impresas desde aqui');
  assert.match(hoja, /if\(noImprime\(\)\)return mensaje\(MENSAJE_NO_IMPRIME,'aviso'\);if\(!etiqueteraLista\(\)\)return conexion\(\)/, 'las bandas avisan en vez de abrir la conexion');
});
