// node --test src/alta-socio.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { leerMensajeAlta } from '../public/venta.js';

test('el aviso del alta solo acepta el número de socio o el cierre', () => {
  assert.deepEqual(leerMensajeAlta({ tipo: 'alta-socio', numero: 42 }), { tipo: 'alta', numero: 42 });
  assert.deepEqual(leerMensajeAlta({ tipo: 'alta-cerrar' }), { tipo: 'cerrar' });
  // Los datos personales no pasan: del mensaje solo sale el número.
  assert.deepEqual(leerMensajeAlta({ tipo: 'alta-socio', numero: 7, telefono: '4421234567', nombre: 'Ana' }), { tipo: 'alta', numero: 7 });
});

test('el aviso del alta rechaza lo que no tiene su forma', () => {
  for (const malo of [null, undefined, 'alta-socio', 42, [], {}, { tipo: 'otro' },
    { tipo: 'alta-socio' }, { tipo: 'alta-socio', numero: '42' }, { tipo: 'alta-socio', numero: 0 },
    { tipo: 'alta-socio', numero: -3 }, { tipo: 'alta-socio', numero: 1.5 }, { tipo: 'alta-socio', numero: NaN },
    { tipo: 'alta-socio', numero: Infinity }, { tipo: 'alta-socio', numero: 2 ** 60 }]) {
    assert.equal(leerMensajeAlta(malo), null, JSON.stringify(malo));
  }
});

test('la caja solo hace caso al marco del mismo origen y ya no abre otra pestaña', () => {
  const caja = readFileSync(new URL('../public/caja.html', import.meta.url), 'utf8');
  assert.match(caja, /e\.origin !== location\.origin \|\| e\.source !== \$\('dlg-alta-marco'\)\.contentWindow/);
  assert.doesNotMatch(caja, /window\.open\('\/socios'/);
  assert.doesNotMatch(caja, /se abre otra pestaña/);
});

test('el reloj de inactividad de cajero.js no corre dentro de un marco', () => {
  assert.match(readFileSync(new URL('../public/cajero.js', import.meta.url), 'utf8'), /window === window\.top\) setInterval/);
});
