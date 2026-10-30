// node --test src/manual.test.ts: el manual interactivo de la revendedora (#594) no se desfasa de /vender.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { permiso, puede, esDeCaja, type Rol } from './cuentas.ts';
import { estadoMia, agruparMias, cobradoMias, gananciaDe, gananciaSemana } from '../public/vender.js';

const leer = (ruta: string) => readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
const manual = leer('public/manual.html');
const app = leer('public/vender.html') + leer('public/vender.js');
const cuenta = (...roles: Rol[]) => ({ correo: 'x@prueba.mx', nombre: '', caja: '', activo: true, editar_inventario: false, roles });

test('/manual abre para quien abre /vender (revendedora, cajero, computadora) y el dueno; cierra para el resto', () => {
  for (const ruta of ['/manual', '/manual.html']) {
    const regla = permiso(ruta, 'GET');
    assert.deepEqual(regla, permiso('/vender', 'GET'), ruta);
    for (const rol of ['revendedora', 'cajero', 'computadora', 'dueno'] as Rol[]) assert.equal(puede(cuenta(rol), regla), true, `${ruta} ${rol}`);
    for (const rol of ['capturista', 'finanzas', 'auxiliar'] as Rol[]) assert.equal(puede(cuenta(rol), regla), false, `${ruta} ${rol}`);
    assert.equal(puede(null, regla), false);
    assert.equal(puede({ ...cuenta('revendedora'), activo: false }, regla), false);
  }
  // Como /vender: la computadora de caja sigue necesitando el PIN.
  assert.equal(esDeCaja(permiso('/manual', 'GET')), true);
  // El modulo que importa el manual sigue siendo de quien vende.
  assert.equal(puede(cuenta('revendedora'), permiso('/vender.js', 'GET')), true);
});

test('cada data-etiqueta del manual existe literalmente en vender.html o vender.js, y el texto visible la empieza igual', () => {
  // Las que llevan ${...} se arman en el código: sus textos se revisan más abajo (avisos, etiqueta('...') y grupos).
  const etiquetas = [...manual.matchAll(/data-etiqueta="([^"$]+)"/g)].map((m) => m[1]);
  assert.ok(etiquetas.length > 50, 'el manual debe usar las etiquetas reales de la app');
  for (const etiqueta of etiquetas) assert.ok(app.includes(etiqueta), `«${etiqueta}» no está en vender.html ni vender.js`);
  // El texto que se ve es el de la etiqueta: nadie reescribe a mano lo que dice la app.
  for (const [, etiqueta, texto] of manual.matchAll(/data-etiqueta="([^"]+)"[^>]*>([^<]*)</g)) {
    if (texto.trim() && !texto.includes('${')) assert.ok(texto.trim().startsWith(etiqueta), `«${texto}» no empieza con «${etiqueta}»`);
  }
  // Los avisos y errores de la réplica se asignan en el código: también tienen que ser los de la app.
  const mensajes = [...manual.matchAll(/(?:est\.(?:err|aviso) = |etiqueta\()'([^']+)'/g), ...manual.matchAll(/\['([^']+)', g\.\w+\]/g)].map((m) => m[1]);
  assert.ok(mensajes.length >= 6, String(mensajes.length));
  for (const mensaje of mensajes) assert.ok(app.includes(mensaje), `«${mensaje}» no está en vender.html ni vender.js`);
});

test('el manual no hace red: sin fetch, sin API, sin wa.me, sin compartir del teléfono', () => {
  for (const prohibido of ['fetch(', '/api/', 'wa.me', 'navigator.share', 'navigator.canShare', 'XMLHttpRequest', 'sendBeacon', 'WebSocket']) {
    assert.ok(!manual.includes(prohibido), `manual.html no debe contener ${prohibido}`);
  }
  // Ninguna página, imagen ni fuente de otro dominio. Solo se importa el código de la propia app.
  assert.ok(!/(?:src|href)="https?:/.test(manual) && !/url\(\s*['"]?https?:/.test(manual));
  assert.deepEqual([...manual.matchAll(/import\(\s*'([^']+)'/g)].map((m) => m[1]), ['/vender.js']);
  assert.ok(manual.includes('Esta práctica no cargó. Pídele ayuda a la tienda.'));
});

test('el repositorio es público: ningún número de 18 dígitos (CLABE) ni teléfono personal en el manual ni en el kit de bienvenida', () => {
  const textos = [manual, leer('../docs/manual-revendedora/entrar.html'), leer('../docs/manual-revendedora/bienvenida.txt')];
  for (const texto of textos) {
    assert.ok(!/\d{18}/.test(texto.replace(/[\s-]/g, '')), 'hay una secuencia de 18 dígitos');
    // El único teléfono es el WhatsApp oficial de la tienda; el ejemplo de la app (444 123 4567) es ficticio.
    const telefonos = [...texto.matchAll(/(?<!\d)(?:\d[ -]?){9}\d(?!\d)/g)].map((m) => m[0].replace(/\D/g, ''));
    for (const tel of telefonos) assert.ok(['4445437754', '4441234567'].includes(tel), `teléfono inesperado: ${tel}`);
  }
  assert.match(manual, /444 543 7754/);
  assert.match(manual, /Los datos para que tu cliente transfiera te los mandamos por WhatsApp\. Guárdalos y reenvíaselos\./);
  assert.ok(!/CLABE|titular/i.test(manual.replace(/Los datos para que tu cliente transfiera[^<]*/, '')), 'el manual no nombra cuentas bancarias');
});

test('los chips de «Mis ventas» salen de estadoMia() con las ventas de ejemplo del manual', () => {
  const ventas = new Function(`return ${manual.split('/*ventas*/')[1].split('/*fin-ventas*/')[0]}`)() as
    { folio: number; estado: string; horas: number }[];
  assert.equal(ventas.length, 4);
  const ahora = Date.now();
  const pedidos = ventas.map((v) => ({ folio: v.folio, estado: v.estado, saldo: 0, subtotal: 10000, vence_en: new Date(ahora + v.horas * 3_600_000).toISOString() }));
  assert.deepEqual(pedidos.map((p) => estadoMia(p, ahora)), [
    { clase: 'aviso', texto: '⏳ Esperando pago · te quedan 30 h' },
    { clase: 'alerta', texto: '⚠ Se vence pronto · te quedan 3 h' },
    { clase: 'ok', texto: '✓ Cobrada: la tienda ya cobró' },
    { clase: 'cerrada', texto: '✕ Cancelada' },
  ]);
  const grupos = agruparMias(pedidos);
  assert.deepEqual([grupos.esperando.length, grupos.pagadas.length, grupos.anteriores.length], [2, 1, 1]);
  assert.equal(cobradoMias(pedidos), 10000);
  // El manual los pinta con las funciones de la app y no los copia a mano.
  assert.match(manual, /V\.estadoMia\(/);
  assert.match(manual, /V\.agruparMias\(/);
  assert.match(manual, /V\.cobradoMias\(/);
  for (const chip of ['⏳', '⚠ Se vence', '✓ Cobrada', '✕ Cancelada', '✕ Se venció']) assert.ok(!manual.includes(chip), `el chip «${chip}» no se escribe a mano`);
});

test('las reglas confirmadas por Isaac están en el manual y el tamaño cabe en el presupuesto', () => {
  for (const frase of ['10 % del precio de cada pieza que la tienda cobra (sin contar el envío)', 'cada lunes por transferencia',
    'Jardín Hidalgo 129, Soledad', 'de 11 a. m. a 8 p. m.', '48 horas', '$99', '$1,000', 'los viernes', 'Máximo 10 piezas apartadas sin pago a la vez',
    'PRÁCTICA: no se manda nada de verdad', 'En «Mis ventas» la app te muestra']) {
    assert.ok(manual.includes(frase), frase);
  }
  for (const id of ['entrar', 'compartir', 'varias', 'buscar', 'vendi', 'avisar', 'mis-ventas', 'cancelar', 'ganancia', 'ayuda']) assert.ok(manual.includes(`id="${id}"`), id);
  assert.ok(Buffer.byteLength(manual) <= 120 * 1024, 'manual.html pasa de 120 KB');
  // 18 px de letra y 56 px de toque, como body.rev
  assert.match(manual, /font: 18px\/1\.5/);
  assert.match(manual, /min-height: 56px/);
  assert.match(manual, /@media print/);
});

test('gananciaDe: 10 % del precio de lo vendido, sin envío y redondeado a centavos', () => {
  assert.equal(gananciaDe({ estado: 'vendido', subtotal: 25000, envio: 9900 }), 2500);
  assert.equal(gananciaDe({ estado: 'vendido', subtotal: 12345, envio: 0 }), 1235);
  assert.equal(gananciaDe({ estado: 'apartado', subtotal: 25000, envio: 0 }), 0);
  assert.equal(gananciaDe({ estado: 'cancelado', subtotal: 25000, envio: 0 }), 0);
});

test('gananciaSemana: lunes 00:00 a domingo 23:59 de la tienda (UTC-6), solo lo que tiene liquidado_en', () => {
  // Miércoles 28/10/2026 12:00 en la tienda; su semana va del lunes 26/10 06:00Z al lunes 02/11 06:00Z.
  const ahora = Date.parse('2026-10-28T18:00:00Z');
  const v = (liquidado_en: string | null) => ({ estado: 'vendido', subtotal: 10000, liquidado_en });
  const pedidos = [
    v('2026-10-26T05:59:59Z'), // domingo 23:59:59 de la semana anterior: fuera
    v('2026-10-26T06:00:00Z'), // lunes 00:00: dentro
    v('2026-11-02T05:59:59Z'), // domingo 23:59:59: dentro
    v('2026-11-02T06:00:00Z'), // lunes siguiente: fuera
    v(null),                   // sin liquidar: no cuenta
    { estado: 'apartado', subtotal: 10000, liquidado_en: '2026-10-28T00:00:00Z' },
  ];
  assert.equal(gananciaSemana(pedidos, ahora), 2000);
  // El domingo 23:59 de la tienda todavía es la misma semana; el lunes 00:00 ya empieza otra.
  assert.equal(gananciaSemana(pedidos, Date.parse('2026-11-02T05:59:59Z')), 2000);
  assert.equal(gananciaSemana(pedidos, Date.parse('2026-11-02T06:00:00Z')), 1000); // solo el liquidado el lunes 00:00
  assert.equal(gananciaSemana([], ahora), 0);
});

test('Mis ventas muestra la ganancia con los ayudantes de vender.js', () => {
  const html = readFileSync(new URL('../public/vender.html', import.meta.url), 'utf8');
  assert.match(html, /Tu ganancia esta semana: \$\{pesos\(gananciaSemana\(pedidos, ahora\)\)\} · te pagamos el lunes/);
  assert.match(html, /Tu ganancia: \$\{pesos\(gananciaDe\(p\)\)\}/);
});
