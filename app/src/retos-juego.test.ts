// node --test src/retos-juego.test.ts
// Cuentas puras de /retos (#760): anillos, ritmo, premio nuevo, estantería y «siguiente paso».
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { metaPersonal, anillos, ritmoPct, diasQuedan, estadoTienda, nombreMeta, panelMetas, porDelante, metasNuevas, premiosNuevos, estanteria, siguientePaso, dd } from '../public/retos.js';

const REGLAS = [
  { logro: 'antiguedad', etiqueta: 'Pieza con antigüedad', texto: 'Vende una pieza con 90 días', d: 50 },
  { logro: 'racha', etiqueta: 'Racha de días con venta', texto: '5 días seguidos con venta', d: 100 },
  { logro: 'socio', etiqueta: 'Socio nuevo', texto: 'Registra un socio que compra ese mismo día', d: 30 },
];
const SEMANA = { desde: '2026-11-02', hoy: '2026-11-04', dia: 3, ventas: 0, tickets: 0, socios: 0, apartados: 0 };
const PROMEDIO = { ventas: 0, tickets: 0, socios: 0, apartados: 0 };
const base = (extra: Record<string, unknown> = {}) => ({
  semana: SEMANA, promedio_4_semanas: PROMEDIO,
  tienda_pct: 0, tienda_alcanzada: false, metas: [], racha: null, logros: [], logros_por_tipo: {}, reglas: REGLAS, ...extra,
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

// Cinco metas: n, porcentaje y si ya se logro (solo porcentajes, como las manda el servidor).
const metas = (...pcts: number[]) => pcts.map((pct, i) => ({ n: i + 1, pct, lograda: false }));
const logradas = (k: number, ...pcts: number[]) => metas(...pcts).map((x, i) => ({ ...x, lograda: i < k }));

test('ritmo de la tienda: días transcurridos entre 7 y estado sin culpa', () => {
  assert.deepEqual([1, 3, 7].map(ritmoPct), [14, 43, 100]);
  assert.deepEqual([1, 5, 7].map(diasQuedan), [6, 2, 0]);
  assert.match(estadoTienda(base({ metas: metas(50, 33, 25, 20, 16) })).texto, /delante/);   // dia 3: ritmo 43 %
  assert.match(estadoTienda(base({ metas: metas(10, 6, 5, 4, 3) })).texto, /detrás/);
  assert.doesNotMatch(estadoTienda(base({ metas: metas(10) })).texto, /perdi|fall/i);
  assert.match(estadoTienda(base({ metas: logradas(1, 120) })).texto, /Llegamos a la meta/);   // una sola meta (la linea) lograda
  assert.match(estadoTienda(base({ metas: logradas(1, 120, 80, 60, 48, 40) })).texto, /Ya hay bono! Vamos por la meta 2/);
  assert.match(estadoTienda(base({ metas: logradas(4, 300, 200, 150, 120, 90) })).texto, /Vamos por la grande/);
  assert.match(estadoTienda(base({ metas: logradas(5, 300, 200, 150, 120, 100) })).texto, /meta más grande/);
});

test('metas: nombres, la mas cercana sin lograr y todas logradas', () => {
  assert.deepEqual([1, 2, 4, 5].map((n) => nombreMeta(n, 5)), ['Meta 1 · Arranca el bono', 'Meta 2', 'Meta 4', 'La grande']);
  assert.equal(nombreMeta(1, 1), 'Meta 1 · Arranca el bono');   // solo la linea: es la que arranca el bono
  const p = panelMetas(logradas(2, 300, 200, 90, 70, 56));
  assert.deepEqual([p.vacio, p.completa, p.actual!.n, p.actual!.pct, p.actual!.etiqueta, p.logradas], [false, false, 3, 90, 'Meta 3', 2]);
  assert.deepEqual(p.lista.map((x) => [x.etiqueta, x.pct, x.lograda]), [['Meta 1 · Arranca el bono', 300, true], ['Meta 2', 200, true], ['Meta 3', 90, false], ['Meta 4', 70, false], ['La grande', 56, false]]);
  assert.equal(panelMetas(metas(40, 20, 10, 8, 6)).actual!.etiqueta, 'Meta 1 · Arranca el bono');
  const todas = panelMetas(logradas(5, 300, 200, 150, 120, 101));
  assert.deepEqual([todas.completa, todas.actual, todas.logradas], [true, null, 5]);   // celebracion: sin barra
});

test('metas: sin metas la seccion no aparece; exactamente en una meta marca 100 % y sigue siendo la actual', () => {
  for (const sin of [undefined, null, []]) assert.deepEqual(panelMetas(sin as never), { vacio: true, completa: false, actual: null, lista: [], logradas: 0 });
  assert.equal(porDelante([], 7), false);
  // Se logra al SUPERAR la meta (lo decide el servidor): con justo 100 % la meta 2 aun no esta lograda y sigue en la barra.
  const justo = panelMetas([{ n: 1, pct: 160, lograda: true }, { n: 2, pct: 100, lograda: false }, { n: 3, pct: 80, lograda: false }]);
  assert.deepEqual([justo.actual!.n, justo.actual!.pct, justo.completa], [2, 100, false]);
  assert.equal(porDelante([{ n: 1, pct: 100, lograda: false }], 7), true);   // dia 7, ritmo 100 %: justo en el ritmo cuenta como delante
  assert.equal(porDelante([{ n: 1, pct: 99, lograda: false }], 7), false);
});

test('metas: por delante del ritmo se mide contra la meta de la barra; con todas logradas, si', () => {
  assert.equal(porDelante(metas(43, 30, 20, 15, 12), 3), true);
  assert.equal(porDelante(metas(42, 30, 20, 15, 12), 3), false);
  assert.equal(porDelante(logradas(1, 200, 40, 30, 20, 10), 3), false);   // la barra va a la meta 2 (40 %)
  assert.equal(porDelante(logradas(5, 300, 200, 150, 120, 101), 1), true);
});

test('metas nuevas: las logradas que aun no se celebraron esta semana', () => {
  const m = logradas(3, 300, 200, 150, 80, 60);
  assert.deepEqual(metasNuevas(m, 0).map((x) => x.n), [1, 2, 3]);
  assert.deepEqual(metasNuevas(m, 2).map((x) => x.n), [3]);
  assert.deepEqual(metasNuevas(m, 3), []);
  assert.deepEqual(metasNuevas(m, 9), []);
  assert.deepEqual(metasNuevas([], 0), []);
  assert.deepEqual(metasNuevas(metas(10, 5, 4, 3, 2)), []);
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

test('retos.html: la lista de metas se abre con un boton con aria-expanded y la barra tiene texto alternativo', () => {
  const html = readFileSync('public/retos.html', 'utf8');
  assert.match(html, /<button type="button" class="q" id="metas-btn" aria-expanded="false" aria-controls="metas-lista" aria-label="[^"]+"/);
  assert.match(html, /\$\('barra'\)\.setAttribute\('aria-label'/);
  assert.match(html, /id="bono-pasado"/);
});

test('retos.html no pide Google Fonts, guarda lo visto con try/catch y respeta movimiento reducido', () => {
  const html = readFileSync('public/retos.html', 'utf8');
  assert.equal(/fonts\.googleapis|fonts\.gstatic/.test(html), false);
  assert.match(html, /try \{ return localStorage\.getItem/);
  assert.match(html, /try \{ localStorage\.setItem/);
  assert.match(html, /prefers-reduced-motion: reduce/);
});
