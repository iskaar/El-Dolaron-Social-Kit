// node --test src/caja-menores.test.ts
// Issue #949 (H10 de la auditoría de la caja): tres arreglos menores, probados con el código REAL de public/caja.html en un contexto simulado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { totales, descuentoDe, TOPE_DESCUENTO, TOPE_DESCUENTO_CAJERO } from '../public/venta.js';

const html = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = html.indexOf(desde);
  const j = html.indexOf(hasta, i + desde.length);
  assert.ok(i >= 0 && j > i, `no se encontró «${desde}» … «${hasta}» en caja.html`);
  return html.slice(i, j);
};
const elemento = () => ({ value: '', textContent: '', hidden: false, disabled: false, style: {} as Record<string, string>, firstChild: null, focus() {}, close() {} });
/** Una pantalla mínima: `$(id)` devuelve siempre el mismo elemento; `alClic[id]` guarda el manejador que el código real registra con addEventListener('click'). */
const pantalla = () => {
  const els = new Map<string, any>();
  const alClic: Record<string, () => Promise<void>> = {};
  const $ = (id: string) => {
    if (!els.has(id)) els.set(id, { ...elemento(), addEventListener: (_t: string, f: () => Promise<void>) => { alClic[id] = f; } });
    return els.get(id);
  };
  return { $, alClic };
};

test('#949 el tope de descuento se recalcula con cada cambio del ticket, no solo al escribir el descuento', () => {
  // pintar() es quien corre con todo cambio del ticket (cambiarTicket, agregar, quitar, restaurar): ahí tiene que repintarse el tope.
  assert.match(entre('function pintar() {', '\n}\n'), /\bpintarTopeDescuento\(\);/);
  // Y la función, con el subtotal de ese momento, apaga «Enviar a gerencia» y lo vuelve a encender.
  const { $ } = pantalla();
  const ctx: Record<string, any> = { $, totales, descuentoDe, TOPE_DESCUENTO, TOPE_DESCUENTO_CAJERO, lineas: [{ precio: 10000, cantidad: 1 }] };
  runInNewContext(`let esDuenoEnCaja = false;
    ${entre('const AVISO_TOPE', "$('descuento-valor').addEventListener")}
    globalThis.pintarTopeDescuento = pintarTopeDescuento;`, ctx);
  $('descuento-tipo').value = 'monto';
  $('descuento-valor').value = '20';                       // $20 sobre $100: 20 %, pasa del 10 % del cajero
  ctx.pintarTopeDescuento();
  assert.equal($('enviar-descuento').disabled, true);
  assert.equal($('descuento-tope').hidden, false);
  ctx.lineas = [{ precio: 10000, cantidad: 3 }];           // el ticket crece: $20 sobre $300 ya no pasa del tope
  ctx.pintarTopeDescuento();
  assert.equal($('enviar-descuento').disabled, false);
  assert.equal($('descuento-tope').hidden, true);
});

/** El manejador de «Registrar y abrir cajón» con un servidor que registra bien y un cajón que abre o no. */
async function retiro(abre: boolean, errorDeImpresora: string) {
  const { $, alClic } = pantalla();
  $('retiro-importe').value = '20'; $('retiro-motivo').value = 'bolsas'; $('retiro-categoria').value = 'insumos'; $('retiro-aprobacion').hidden = true;
  const llamadas = { cajon: 0, fetch: 0, impresion: 0 };
  const ctx: Record<string, unknown> = {
    $, Math, Number, JSON, crypto: { randomUUID: () => 'u1' }, pesos: (c: number) => `$${(c / 100).toFixed(2)}`, cajaActual: () => 'Caja 1',
    tipoSalida: () => 'gasto', pintarImpresora() {}, escapar: String, ocultarAprobacionRetiro() {},
    errorImpresora: () => errorDeImpresora,
    abrirCajon: async () => { llamadas.cajon++; return abre; },
    imprimirRetiro: async () => { llamadas.impresion++; },
    fetch: async () => { llamadas.fetch++; return { ok: true, status: 201, json: async () => ({ tipo: 'gasto', importe: 2000 }) }; },
  };
  runInNewContext(`let idRetiro = 'r1', intentoRetiro = null;
    ${entre('function textoFalla(clave) {', '/** Agrega una falla')}
    ${entre("$('retiro-registrar').addEventListener('click'", '/* ---------- corte de caja')}`, ctx);
  await alClic['retiro-registrar']();
  return { aviso: $('aviso'), llamadas };
}

test('#949 un retiro con el cajón que no abrió lo dice en el aviso, y el retiro no se repite ni se deshace', async () => {
  const mal = await retiro(false, 'NetworkError: sin respuesta');
  assert.equal(mal.aviso.textContent, 'Gasto de $20.00 registrado. El cajón no abrió: ábrelo con la llave.');
  assert.equal(mal.aviso.style.color, '#D72B32');
  assert.deepEqual(mal.llamadas, { cajon: 1, fetch: 1, impresion: 1 });      // se registró una sola vez
  const sinImpresora = await retiro(false, 'no conectada');
  assert.equal(sinImpresora.aviso.textContent, 'Gasto de $20.00 registrado. Sin impresora: abre el cajón con la llave.');
  assert.equal(sinImpresora.aviso.style.color, '#1f7a4d');                   // sin impresora no es una falla nueva: línea tranquila
  const bien = await retiro(true, '');
  assert.equal(bien.aviso.textContent, 'Gasto de $20.00 registrado.');
  assert.equal(bien.aviso.style.color, '#1f7a4d');
});

test('#949 «Abrir cajón» exige caja elegida y no abre ni registra nada sin ella', async () => {
  const correr = async (caja: string) => {
    const { $, alClic } = pantalla();
    const guardado: unknown[] = [];
    let abierto = 0;
    const exigir = entre('function exigirCaja() {', '/* ---------- almacen local');
    const ctx: Record<string, unknown> = {
      $, cajaActual: () => caja, impresionRemota: () => false, abrirCajon: async () => { abierto++; return true; }, errorImpresora: () => '', pintarImpresora() {},
      store: async (_n: string, _m: string, f: (s: unknown) => unknown) => { f({ put: (v: unknown) => guardado.push(v) }); },
      crypto: { randomUUID: () => 'u1' }, Date, sincronizar() {},
    };
    runInNewContext(`${exigir}
      ${entre('async function abrirCajonRegistrado', '// En el corte hay que contar')}`, ctx);
    await alClic['abrir-cajon']();
    return { aviso: $('aviso'), guardado, abierto };
  };
  const sinCaja = await correr('');
  assert.equal(sinCaja.abierto, 0);
  assert.deepEqual(sinCaja.guardado, []);
  assert.equal(sinCaja.aviso.textContent, 'Elige arriba qué caja es esta computadora.');
  const conCaja = await correr('Caja 1');
  assert.equal(conCaja.abierto, 1);
  assert.equal((conCaja.guardado[0] as { caja: string }).caja, 'Caja 1');
});

test('#949 si el servidor rechaza el registro de la apertura, la pantalla lo avisa; una sesión caducada se reintenta', async () => {
  const bloque = entre("    for (const apertura of await store('cajon'", '  } finally {');
  const correr = async (estado: number, cuerpo: unknown) => {
    const { $ } = pantalla();
    const borradas: string[] = [];
    const ctx: Record<string, unknown> = {
      $, JSON, console: { error() {} },
      store: async (_n: string, modo: string, f: (s: unknown) => unknown) =>
        (modo === 'readonly' ? [{ id: 'a1', abierto_en: '2026-11-26T10:00:00.000Z', caja: 'Caja 1' }] : f({ delete: (id: string) => borradas.push(id) })),
      fetch: async () => ({ status: estado, json: async () => cuerpo }),
    };
    await runInNewContext(`(async () => {\n${bloque}\n})()`, ctx);
    return { aviso: $('aviso'), borradas };
  };
  const rechazada = await correr(400, { error: 'Caja que no es de esta tienda.' });
  assert.equal(rechazada.aviso.textContent, 'El servidor no registró una apertura del cajón. Caja que no es de esta tienda. Avísale a gerencia.');
  assert.equal(rechazada.aviso.style.color, '#D72B32');
  assert.deepEqual(rechazada.borradas, ['a1']);                               // un rechazo no se reenvía eternamente
  const sinCuerpo = await correr(403, null);
  assert.equal(sinCuerpo.aviso.textContent, 'El servidor no registró una apertura del cajón. Avísale a gerencia.');
  const caducada = await correr(401, { error: 'Sesión caducada.' });
  assert.equal(caducada.aviso.textContent, '');
  assert.deepEqual(caducada.borradas, []);                                    // sigue en la cola
  const bien = await correr(201, { id: 'a1' });
  assert.equal(bien.aviso.textContent, '');
  assert.deepEqual(bien.borradas, ['a1']);
});
