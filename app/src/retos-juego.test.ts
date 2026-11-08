// node --test src/retos-juego.test.ts
// Cuentas puras de /retos (#760): anillos, ritmo, premio nuevo, estantería y «siguiente paso».
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { metaPersonal, anillos, ritmoPct, diasQuedan, estadoTienda, premiosNuevos, estanteria, siguientePaso, dd } from '../public/retos.js';

const REGLAS = [
  { logro: 'antiguedad', etiqueta: 'Pieza con antigüedad', texto: 'Vende una pieza con 90 días', d: 50 },
  { logro: 'racha', etiqueta: 'Racha de días con venta', texto: '5 días seguidos con venta', d: 100 },
  { logro: 'socio', etiqueta: 'Socio nuevo', texto: 'Registra un socio que compra ese mismo día', d: 30 },
];
const SEMANA = { desde: '2026-11-02', hoy: '2026-11-04', dia: 3, ventas: 0, tickets: 0, socios: 0, apartados: 0 };
const PROMEDIO = { ventas: 0, tickets: 0, socios: 0, apartados: 0 };
const base = (extra: Record<string, unknown> = {}) => ({
  semana: SEMANA, promedio_4_semanas: PROMEDIO,
  tienda_pct: 0, tienda_alcanzada: false, racha: null, logros: [], logros_por_tipo: {}, reglas: REGLAS, ...extra,
});
const semana = (s: Record<string, number>, p: Record<string, number>, extra: Record<string, unknown> = {}) =>
  base({ semana: { ...SEMANA, ...s }, promedio_4_semanas: { ...PROMEDIO, ...p }, ...extra });
const racha = (cajas: number, hoy = 'vendio', largo = cajas) => ({ largo, cajas, meta: 5, d: 100, hoy });

test('meta personal: promedio + 10 % hacia arriba, sin errores de coma flotante', () => {
  assert.equal(metaPersonal(10), 11);
  assert.equal(metaPersonal(3.5), 4);
  assert.equal(metaPersonal(0.1), 1);
  assert.equal(metaPersonal(842000), 926200);   // centavos
  assert.equal(metaPersonal(0), 0);
});

test('anillos: porcentaje contra la meta propia; sin promedio no se inventa uno', () => {
  const [v, t, s] = anillos(semana({ ventas: 842_00, tickets: 31, socios: 2 }, { ventas: 835_00, tickets: 32.5, socios: 2.5 }));
  assert.deepEqual([v.meta, v.pct, v.texto], [91_850, 91, '$842 de $919']);
  assert.deepEqual([t.meta, t.pct, t.texto], [36, 86, '31 de 36']);
  assert.deepEqual([s.meta, s.pct], [3, 66]);
  const [nuevo] = anillos(semana({ ventas: 500_00 }, {}));
  assert.deepEqual([nuevo.meta, nuevo.pct, nuevo.texto], [null, null, '$500']);
  assert.equal(anillos(semana({ tickets: 20 }, { tickets: 10 }))[1].pct, 181);   // pasa de 100: el aro se llena y el texto dice la verdad
});

test('ritmo de la tienda: días transcurridos entre 7 y estado sin culpa', () => {
  assert.deepEqual([1, 3, 7].map(ritmoPct), [14, 43, 100]);
  assert.deepEqual([1, 5, 7].map(diasQuedan), [6, 2, 0]);
  assert.match(estadoTienda(base({ tienda_pct: 50 })).texto, /delante/);
  assert.match(estadoTienda(base({ tienda_pct: 10 })).texto, /detrás/);
  assert.doesNotMatch(estadoTienda(base({ tienda_pct: 10 })).texto, /perdi|fall/i);
  assert.match(estadoTienda(base({ tienda_pct: 120, tienda_alcanzada: true })).texto, /Llegamos a la meta/);
});

test('premio nuevo: lo que está antes del último visto; sin visto, solo la última semana', () => {
  const ahora = Date.parse('2026-11-08T12:00:00Z');
  const l = (id: string, fecha: string) => ({ id, fecha, d: 30 });
  const logros = [l('c', '2026-11-08T10:00:00Z'), l('b', '2026-11-06T10:00:00Z'), l('a', '2026-10-01T10:00:00Z')];
  assert.deepEqual(premiosNuevos(logros, 'b', ahora).map((x) => x.id), ['c']);
  assert.deepEqual(premiosNuevos(logros, 'c', ahora), []);
  assert.deepEqual(premiosNuevos(logros, null, ahora).map((x) => x.id), ['c', 'b']);
  assert.deepEqual(premiosNuevos(logros, 'desconocido', ahora).map((x) => x.id), ['c', 'b']);
  assert.deepEqual(premiosNuevos([], 'x', ahora), []);
});

test('estantería: ganada con su conteo o bloqueada con lo que falta; solo reglas con premio', () => {
  const e = estanteria(base({ logros_por_tipo: { antiguedad: 3 }, reglas: [...REGLAS, { logro: 'x', etiqueta: 'X', texto: 'x', d: 0 }] }));
  assert.deepEqual(e.map((x) => [x.logro, x.ganado, x.veces]), [['antiguedad', true, 3], ['racha', false, 0], ['socio', false, 0]]);
});

test('siguiente paso: gana lo más cercano a cerrarse entre racha y anillos', () => {
  // Racha 4 de 5 (80 %) contra tickets al 50 %: gana la racha.
  const p = siguientePaso(semana({ tickets: 5 }, { tickets: 9.1 }, { racha: racha(4, 'pendiente') }))!;
  assert.deepEqual([p.tipo, p.ancla], ['racha', 'racha']);
  assert.match(p.texto, /Con tu primera venta de hoy completas la racha de 5 días y ganas 100 D/);
  // Anillo al 90 % contra racha 1 de 5: gana el anillo.
  const anillo = siguientePaso(semana({ tickets: 10 }, { tickets: 9.1 }, { racha: racha(1) }))!;
  assert.deepEqual([anillo.tipo, anillo.ancla], ['anillo', 'semana']);
  assert.match(anillo.texto, /Te falta 1 ticket para cerrar tu anillo de tickets/);
  // Hoy ya vendió y le faltan dos días.
  assert.match(siguientePaso(base({ racha: racha(3, 'vendio') }))!.texto, /Te faltan 2 días trabajados con venta para ganar 100 D/);
  // Empate: la racha.
  assert.equal(siguientePaso(semana({ tickets: 3 }, { tickets: 4.5 }, { racha: racha(3) }))!.tipo, 'racha');
});

test('siguiente paso: racha completa o sin dato se omite; sin nada a medias propone el primer logro pendiente; o nada', () => {
  const completa = siguientePaso(base({ racha: racha(5) }))!;   // completa: ya no es paso; queda un logro por ganar
  assert.equal(completa.tipo, 'logro');
  assert.match(completa.texto, /Pieza con antigüedad/);
  assert.equal(siguientePaso(base({ racha: racha(0, 'sin_registro', 0) }))!.tipo, 'logro');
  assert.equal(siguientePaso(base({ logros_por_tipo: { antiguedad: 1, racha: 1, socio: 1 } })), null);
  // Anillos al 100 % o más no son pasos.
  assert.equal(siguientePaso(semana({ tickets: 12 }, { tickets: 10 }, { logros_por_tipo: { antiguedad: 1, socio: 1 } })), null);
});

test('siguiente paso: racha 0 con hoy pendiente invita a empezar sin culpa', () => {
  const p = siguientePaso(base({ racha: racha(0, 'pendiente', 0) }))!;
  assert.equal(p.tipo, 'racha');
  assert.match(p.texto, /suma el día 1 de 5/);
  for (const e of [p.texto, estadoTienda(base()).texto]) assert.doesNotMatch(e, /perdiste|rompiste|fallaste/i);
});

test('Dolarones se muestran sin ceros de sobra', () => {
  assert.deepEqual([24500, 1250, 8000].map(dd), ['245 D', '12.5 D', '80 D']);
});

test('retos.html no pide Google Fonts, guarda lo visto con try/catch y respeta movimiento reducido', () => {
  const html = readFileSync('public/retos.html', 'utf8');
  assert.equal(/fonts\.googleapis|fonts\.gstatic/.test(html), false);
  assert.match(html, /try \{ return localStorage\.getItem/);
  assert.match(html, /try \{ localStorage\.setItem/);
  assert.match(html, /prefers-reduced-motion: reduce/);
});
