// node --test src/cerrar-sesion-caja.test.ts
// #856: «Cerrar sesión» en la computadora de caja solo para gerencia con su PIN. Se prueba el código real de caja.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = html.indexOf(desde);
  const j = html.indexOf(hasta, i + desde.length);
  assert.ok(i >= 0 && j > i, `no se encontró «${desde}» … «${hasta}» en caja.html`);
  return html.slice(i, j);
};

function montar(turnoGuardado: string | null = null) {
  const boton = { hidden: true };
  const rutinas = runInNewContext(`${entre('function puedeCerrarSesion(', '// Fin #856.')}
    ({ puedeCerrarSesion, pintarCerrarSesion })`, {
    $: (id: string) => { assert.equal(id, 'cerrar-sesion'); return boton; },
    localStorage: { getItem: (llave: string) => (llave === 'cajero-en-turno' ? turnoGuardado : null) },
  });
  return { ...rutinas, boton };
}

const computadora = { roles: ['computadora'] };

test('#856 el botón nace oculto y lo decide /api/yo al cargar; sin red, la otra rama', () => {
  assert.match(html, /<button id="cerrar-sesion" type="button" hidden>Cerrar sesión<\/button>/);
  assert.match(entre("fetch('/api/yo').then((r) => r.json()).then(({ usuario, cajero, cajas, tienda }) => {", '// La tienda y sus cajas'),
    /pintarCerrarSesion\(\{ usuario, cajero \}\);/);
  assert.match(html, /\}\)\.catch\(\(\) => \{ pintarCerrarSesion\(null\); \/\* sin red: la de la computadora \*\/ \}\);/);
});

test('#856 en la computadora de caja: oculto para cajero, supervisor y pantalla de bloqueo; visible para gerencia con PIN', () => {
  const { puedeCerrarSesion } = montar();
  assert.equal(puedeCerrarSesion({ usuario: computadora, cajero: { correo: 'c@x.mx', es_dueno: false } }), false);
  assert.equal(puedeCerrarSesion({ usuario: computadora, cajero: null }), false);
  assert.equal(puedeCerrarSesion({ usuario: computadora, cajero: { correo: 'g@x.mx', es_dueno: true } }), true);
});

test('#856 cualquier otra cuenta lo sigue viendo', () => {
  const { puedeCerrarSesion } = montar();
  for (const roles of [['cajero'], ['dueno'], ['computadora', 'cajero'], ['computadora', 'dueno'], ['capturista']])
    assert.equal(puedeCerrarSesion({ usuario: { roles }, cajero: null }), true, roles.join(','));
  assert.equal(puedeCerrarSesion({ usuario: null, cajero: null }), true);
});

test('#856 sin /api/yo: con turno de PIN guardado (computadora de caja) se oculta; sin turno, se muestra', () => {
  assert.equal(montar('{"token":"t"}').puedeCerrarSesion(null), false);
  assert.equal(montar(null).puedeCerrarSesion(null), true);
});

test('#856 una falla de red después de la respuesta de /api/yo no cambia lo que ya decidió', () => {
  const caja = montar(null);
  caja.pintarCerrarSesion({ usuario: computadora, cajero: { correo: 'c@x.mx', es_dueno: false } });
  assert.equal(caja.boton.hidden, true);
  caja.pintarCerrarSesion(null);   // sin turno guardado, la rama sin red lo mostraría
  assert.equal(caja.boton.hidden, true);
  const gerencia = montar('{"token":"t"}');
  gerencia.pintarCerrarSesion({ usuario: computadora, cajero: { correo: 'g@x.mx', es_dueno: true } });
  gerencia.pintarCerrarSesion(null);
  assert.equal(gerencia.boton.hidden, false);
});
