// node --test src/apartar.test.ts
// «Apartar aquí» del portal (Issue #668): textos y cuentas copiados de venta.js, la hoja contra un DOM de mentira y portal.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as apartar from '../public/apartar.js';
import { envioDe, anticipoMinimoDe } from '../public/venta.js';

// apartar.js no puede importar venta.js (el host del portal no lo sirve): esta prueba la ata a su fuente.
test('envioDe y lo que se paga al apartar coinciden con venta.js en los bordes', () => {
  for (const precio of [1, 5000, 9999, 10000, 25000, 99999, 100000, 150000])
    assert.equal(apartar.envioDe(precio), envioDe(precio), String(precio));
  for (const precio of [1, 5000, 9999, 10000, 10001, 25000])
    assert.equal(apartar.aPagarDe(precio), anticipoMinimoDe(precio), String(precio));
});

test('explicaEntrega: recoger o envío, con $100, pieza barata completa y envío gratis desde $1,000', () => {
  const ahora = Date.parse('2026-10-31T18:00:00Z');   // sábado → viernes 6 de noviembre
  assert.equal(apartar.explicaEntrega(25000, 'tienda', ahora), 'Pagas $100 por transferencia y el resto al recogerla. Con tu pago te la guardamos 7 días.');
  assert.equal(apartar.explicaEntrega(6000, 'tienda', ahora), 'Pagas $60 por transferencia y pasas por ella a Soledad.');
  assert.equal(apartar.explicaEntrega(25000, 'envio', ahora),
    'Pagas $100 ahora y abonas el resto ($249, con envío de $99); cada abono te da 7 días más. Cuando el pago esté completo sale el viernes (si fuera hoy, el 6 de noviembre).');
  assert.match(apartar.explicaEntrega(150000, 'envio', ahora), /el resto \(\$1,400, el envío es gratis\)/);
  assert.match(apartar.explicaEntrega(6000, 'envio', ahora), /^Pagas \$60 ahora y abonas el resto \(\$99, con envío de \$99\)/);
});

test('WhatsApp: «Pagué el apartado P-folio» y la petición de datos; clabeDe encuentra 18 dígitos sueltos o separados', () => {
  assert.equal(apartar.enlaceWhatsApp(apartar.mensajePague(12)), 'https://wa.me/524445437754?text=Pagu%C3%A9%20el%20apartado%20P-12');
  assert.match(decodeURIComponent(apartar.enlaceWhatsApp(apartar.mensajeDatos(12))), /P-12.*datos para transferir/);
  const clabe = '9'.repeat(18);   // sintética: el repositorio es público y no lleva cuentas reales
  assert.equal(apartar.clabeDe(`Banco de prueba\nCLABE ${clabe}\nTitular de prueba`), clabe);
  assert.equal(apartar.clabeDe(`CLABE: ${'9'.repeat(3)} ${'9'.repeat(14)} ${'9'}`), clabe);
  assert.equal(apartar.clabeDe(`CLABE ${'9'.repeat(3)}-${'9'.repeat(14)}-9`), clabe);
  assert.equal(apartar.clabeDe('9'.repeat(17)), '');
  assert.equal(apartar.clabeDe('9'.repeat(19)), '');
  assert.equal(apartar.clabeDe(null), '');
  assert.equal(apartar.horasHasta('2026-11-01T12:00:00Z', Date.parse('2026-10-31T12:30:00Z')), 24);
  assert.equal(apartar.horasHasta('2026-11-01T12:00:00Z', Date.parse('2026-11-01T11:59:00Z')), 1);
});

test('portal.html trae todo lo que apartar.js busca, y ni el HTML ni el JS llevan una CLABE', () => {
  const html = readFileSync('public/portal.html', 'utf8');
  const js = readFileSync('public/apartar.js', 'utf8');
  const clases = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(' ')));
  const selectores = [...js.matchAll(/\bq\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(selectores.length > 20);
  for (const sel of new Set(selectores)) assert.ok(clases.has(sel.slice(1)), sel);
  assert.match(html, /id="apartar-dialogo"/);
  // «Recoger en tienda» llega preseleccionada y la otra opción es el envío a domicilio.
  assert.match(html, /<input type="radio" name="apartar-entrega" value="tienda" checked>\s*<span><b>Recoger en tienda<\/b>/);
  assert.match(html, /<input type="radio" name="apartar-entrega" value="envio">\s*<span><b>Envío a domicilio<\/b>/);
  assert.match(html, /<legend>¿Cómo la recibes\?<\/legend>/);
  assert.match(html, /Regístrate en un minuto para apartar aquí, o escríbenos por WhatsApp\./);
  for (const texto of [html, js, readFileSync('public/portal.js', 'utf8'), readFileSync('public/carrito.js', 'utf8')]) assert.ok(!/\d{18}/.test(texto.replace(/[\s-]/g, '')), 'hay 18 dígitos seguidos');
  // La ficha (#681): «Comprar ya» primario, «Agregar al carrito» secundario y «¿Dudas?» como enlace a WhatsApp; «Lo quiero» ya no es botón.
  assert.match(html, /<button class="ficha-comprar" type="button" hidden>Comprar ya<\/button>/);
  assert.match(html, /<button class="ficha-carrito" type="button" hidden>Agregar al carrito<\/button>/);
  assert.match(html, /<a class="ficha-sec ficha-dudas" href="https:\/\/wa\.me\/524445437754" target="_blank" rel="noopener">¿Dudas\? Pregunta por WhatsApp<\/a>/);
  assert.doesNotMatch(html, /ficha-quiero|ficha-apartar|>Lo quiero</);
});

/** Un DOM mínimo: cada selector es un nodo con lo que apartar.js toca. */
function dominio() {
  const nodos = new Map<string, any>();
  const nodo = (sel: string) => {
    if (!nodos.has(sel)) nodos.set(sel, { sel, hidden: false, textContent: '', href: '', disabled: false, dataset: {} as Record<string, string>, hijos: [] as any[],
      oyentes: {} as Record<string, (e: any) => any>, addEventListener(tipo: string, f: (e: any) => any) { this.oyentes[tipo] = f; }, focus() {},
      replaceChildren(...hijos: any[]) { this.hijos = hijos; } });
    return nodos.get(sel);
  };
  const radios = [{ value: 'tienda', checked: true, ...{ oyentes: {} as any, addEventListener(t: string, f: any) { this.oyentes[t] = f; } } },
    { value: 'envio', checked: false, ...{ oyentes: {} as any, addEventListener(t: string, f: any) { this.oyentes[t] = f; } } }];
  const cerrar = nodo('.apartar-cerrar');
  const dialogo: any = { abierto: false, oyentes: {} as Record<string, () => void>,
    querySelector: (sel: string) => nodo(sel), querySelectorAll: (sel: string) => (sel.startsWith('input') ? radios : [cerrar]),
    addEventListener(tipo: string, f: () => void) { this.oyentes[tipo] = f; }, showModal() { this.abierto = true; }, close() { this.abierto = false; this.oyentes.close?.(); } };
  const eventos: string[] = [];
  // navigator es un getter en Node reciente: se redefine en vez de asignar.
  const poner = (nombre: string, valor: unknown) => Object.defineProperty(globalThis, nombre, { value: valor, configurable: true, writable: true });
  const elemento = (tag: string) => ({ tag, className: '', textContent: '', hijos: [] as any[], append(...h: any[]) { this.hijos.push(...h); } });
  poner('document', { getElementById: (id: string) => (id === 'apartar-dialogo' ? dialogo : null), createElement: elemento });
  poner('navigator', { sendBeacon: (_ruta: string, cuerpo: string) => { eventos.push(JSON.parse(cuerpo)); return true; } });
  const enviar = async () => { await nodo('.apartar-form').oyentes.submit({ preventDefault() {} }); };
  const vista = () => ['invitado', 'form', 'listo', 'vacio'].filter((v) => !nodo(`.apartar-${v}`).hidden);
  // Los renglones del resumen: «nombre · precio».
  const renglones = () => nodo('.apartar-piezas').hijos.map((li: any) => `${li.hijos[0].textContent} · ${li.hijos[1].textContent}`);
  return { dialogo, nodo, radios, eventos, enviar, vista, renglones };
}

const PIEZA = { codigo: 'ED-000123', nombre: 'Chamarra Levis', precio: 25000, foto: '/api/catalogo/foto/ED-000123' };
const OTRA = { codigo: 'ED-000124', nombre: 'Blusa floral', precio: 4000, foto: '/api/catalogo/foto/ED-000124' };
const TERCERA = { codigo: 'ED-000125', nombre: 'Tenis Nike', precio: 60000, foto: '/api/catalogo/foto/ED-000125' };
const RESPUESTA = (extra: Record<string, unknown> = {}) => ({
  pedido: { folio: 7, vence_en: new Date(Date.now() + 24 * 3_600_000).toISOString(), entrega: 'tienda', envio: 0, subtotal: 25000, lineas: [{ codigo: 'ED-000123', nombre: 'Chamarra Levis', precio: 25000, cantidad: 1 }] },
  a_pagar: 10000, concepto: 'P-7', datos_pago: null, ...extra });

test('resumenDe: $100 por todo el pedido, el envío sale del subtotal completo y una compra de menos de $100 se paga completa', () => {
  assert.deepEqual(apartar.resumenDe(25000, 'tienda'), { subtotal: 25000, envio: 0, total: 25000, apartas: 10000, falta: 15000 });
  assert.deepEqual(apartar.resumenDe(25000, 'envio'), { subtotal: 25000, envio: 9900, total: 34900, apartas: 10000, falta: 24900 });
  // Tres piezas baratas: $100 por todo; dos de $30: se pagan completas.
  assert.deepEqual(apartar.resumenDe(12000, 'tienda'), { subtotal: 12000, envio: 0, total: 12000, apartas: 10000, falta: 2000 });
  assert.deepEqual(apartar.resumenDe(6000, 'tienda'), { subtotal: 6000, envio: 0, total: 6000, apartas: 6000, falta: 0 });
  // Dos de $600 = $1,200: el carrito junto ya tiene envío gratis aunque cada una costara menos de $1,000.
  assert.deepEqual(apartar.resumenDe(120000, 'envio'), { subtotal: 120000, envio: 0, total: 120000, apartas: 10000, falta: 110000 });
  for (const subtotal of [1, 6000, 25000, 99999, 100000, 120000])
    for (const entrega of ['tienda', 'envio'] as const) {
      const r = apartar.resumenDe(subtotal, entrega);
      assert.equal(r.apartas, anticipoMinimoDe(subtotal));
      assert.equal(r.envio, entrega === 'envio' ? envioDe(subtotal) : 0);
    }
  assert.equal(apartar.textoEnvio(25000, Date.parse('2026-10-31T18:00:00Z')), '$99 (gratis desde $1,000) · sale el viernes 6 de noviembre');
  assert.equal(apartar.textoEnvio(120000, Date.parse('2026-10-31T18:00:00Z')), 'Gratis · sale el viernes 6 de noviembre');
  // Plural: las mismas frases hablan de «ellas» cuando son varias.
  assert.equal(apartar.explicaEntrega(6000, 'tienda', Date.now(), 2), 'Pagas $60 por transferencia y pasas por ellas a Soledad.');
  assert.match(apartar.explicaEntrega(25000, 'tienda', Date.now(), 3), /el resto al recogerlas\. Con tu pago te las guardamos 7 días\.$/);
});

test('hoja sin sesión: avisa que registrarse toma un minuto, ofrece WhatsApp con las piezas y el registro las recuerda', async () => {
  const d = dominio();
  const registros: string[][] = [];
  const hoja = apartar.iniciarApartar({ api: async () => { throw new Error('no debe llamarse'); }, estaListo: () => false, irAAcceso: (c: string[]) => registros.push(c) });
  hoja.abrir([PIEZA]);
  assert.deepEqual(d.vista(), ['invitado']);
  assert.equal(d.dialogo.abierto, true);
  assert.equal(d.nodo('.apartar-titulo').textContent, 'Apartar aquí');
  assert.deepEqual(d.renglones(), ['Chamarra Levis · $250']);
  assert.equal(d.nodo('.apartar-whatsapp').href, 'https://wa.me/524445437754?text=Quiero%20producto%20ED-000123');
  d.nodo('.apartar-registrar').oyentes.click();
  assert.deepEqual(registros, [['ED-000123']]);
  assert.equal(d.dialogo.abierto, false);
  // Varias piezas: un solo mensaje con todos los códigos y el registro las guarda todas.
  hoja.abrir([PIEZA, OTRA]);
  assert.equal(decodeURIComponent(d.nodo('.apartar-whatsapp').href), 'https://wa.me/524445437754?text=Quiero estos productos: ED-000123, ED-000124');
  d.nodo('.apartar-registrar').oyentes.click();
  assert.deepEqual(registros[1], ['ED-000123', 'ED-000124']);
});

test('«Comprar ya»: resumen con recoger preseleccionado, $100 y lo que falta; el envío cambia el total; el reintento conserva el UUID', async () => {
  const d = dominio();
  const llamadas: any[] = [];
  let fallar: any = new TypeError('Failed to fetch');
  let terminado = 0;
  const apartadas: string[][] = [];
  const pagos: unknown[] = [];
  const hoja = apartar.iniciarApartar({
    api: async (ruta: string, cuerpo: any) => { llamadas.push({ ruta, ...cuerpo }); if (fallar) throw fallar; return RESPUESTA({ datos_pago: `Banco de prueba\nCLABE ${'9'.repeat(18)}\nTitular de prueba` }); },
    estaListo: () => true, irAAcceso: () => {}, alTerminar: () => { terminado++; }, alApartar: (c: string[]) => apartadas.push(c), alPagar: (info: unknown) => { pagos.push(info); } });
  hoja.abrir([PIEZA]);
  assert.deepEqual(d.vista(), ['form']);
  assert.equal(d.radios[0].checked, true);   // «Recoger en tienda» preseleccionada
  assert.deepEqual(d.renglones(), ['Chamarra Levis · $250']);
  assert.equal(d.nodo('.apartar-total').textContent, 'Total $250');
  assert.equal(d.nodo('.apartar-apartas').textContent, 'Apartas con $100');
  assert.equal(d.nodo('.apartar-falta').textContent, 'Falta por pagar $150 al recoger.');
  assert.equal(d.nodo('.apartar-enviar').textContent, 'Apartar por $100');
  assert.match(d.nodo('.apartar-explica').textContent, /^Pagas \$100 por transferencia y el resto al recogerla/);
  assert.match(d.nodo('.apartar-envio-costo').textContent, /^\$99 \(gratis desde \$1,000\) · sale el viernes /);
  d.radios[0].checked = false; d.radios[1].checked = true;
  d.radios[1].oyentes.change();
  assert.equal(d.nodo('.apartar-total').textContent, 'Total $349');
  assert.equal(d.nodo('.apartar-desglose').textContent, 'Piezas $250 + envío $99');
  assert.equal(d.nodo('.apartar-falta').textContent, 'Falta por pagar $249 antes del envío.');
  assert.match(d.nodo('.apartar-explica').textContent, /^Pagas \$100 ahora y abonas el resto/);

  await d.enviar();   // se cae la red
  assert.match(d.nodo('.apartar-error').textContent, /No pudimos conectar.*no se aparta dos veces/);
  assert.equal(d.nodo('.apartar-enviar').disabled, false);
  fallar = null;
  await d.enviar();   // reintento: mismo UUID
  assert.equal(llamadas.length, 2);
  assert.equal(llamadas[0].id, llamadas[1].id);
  assert.match(llamadas[0].id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([llamadas[1].ruta, llamadas[1].codigos, llamadas[1].entrega], ['apartar', ['ED-000123'], 'envio']);
  assert.deepEqual(Object.keys(llamadas[1]).sort(), ['codigos', 'entrega', 'id', 'ruta']);   // nada de precio, teléfono ni nombre
  assert.deepEqual(d.vista(), ['listo']);
  assert.equal(d.nodo('.apartar-titulo').textContent, '¡Apartada!');
  assert.equal(d.nodo('.apartar-folio').textContent, 'Folio P-7');
  assert.equal(d.nodo('.apartar-monto').textContent, '$100');
  assert.equal(d.nodo('.apartar-concepto').textContent, 'P-7');
  assert.match(d.nodo('.apartar-vence').textContent, /para pagar\. Si no, la pieza vuelve a la venta\.$/);
  assert.equal(d.nodo('.apartar-con-datos').hidden, false);
  assert.equal(d.nodo('.apartar-sin-datos').hidden, true);
  assert.equal(d.nodo('.apartar-copiar-clabe').hidden, false);
  assert.equal(d.nodo('.apartar-copiar-clabe').dataset.clabe, '9'.repeat(18));
  assert.equal(d.nodo('.apartar-pague-wa').href, 'https://wa.me/524445437754?text=Pagu%C3%A9%20el%20apartado%20P-7');
  assert.deepEqual(apartadas, [['ED-000123']]);   // el carrito la saca
  // «Ya pagué» abre la hoja de pago con lo que respondió el servidor (#670).
  d.nodo('.apartar-pague').oyentes.click();
  assert.deepEqual(pagos, [{ folio: 7, nombre: 'Chamarra Levis', monto: 10000, concepto: 'P-7', datos_pago: `Banco de prueba
CLABE ${'9'.repeat(18)}
Titular de prueba` }]);
  // «Comprar ya» mide apartado_portal y no carrito_apartar.
  assert.deepEqual(d.eventos, [{ evento: 'apartado_portal', codigo: 'ED-000123', origen: 'portal' }]);
  d.nodo('.apartar-cerrar').oyentes.click();
  assert.equal(terminado, 1);

  // Otra pieza: UUID nuevo.
  hoja.abrir([{ ...PIEZA, codigo: 'ED-000124' }]);
  await d.enviar();
  assert.notEqual(llamadas[2].id, llamadas[1].id);
});

test('carrito: varias piezas en un resumen, un solo pedido con todos los códigos, mide cada una y el servidor manda lo que se cobra', async () => {
  const d = dominio();
  const llamadas: any[] = [];
  const hoja = apartar.iniciarApartar({
    api: async (ruta: string, cuerpo: any) => { llamadas.push({ ruta, ...cuerpo });
      return RESPUESTA({ pedido: { folio: 8, vence_en: new Date(Date.now() + 24 * 3_600_000).toISOString(), entrega: 'tienda', envio: 0, subtotal: 89000,
        lineas: [PIEZA, OTRA, TERCERA].map(({ codigo, nombre, precio }) => ({ codigo, nombre, precio, cantidad: 1 })) }, concepto: 'P-8' }); },
    estaListo: () => true, irAAcceso: () => {} });
  hoja.abrir([PIEZA, OTRA, TERCERA], 'carrito');
  assert.deepEqual(d.renglones(), ['Chamarra Levis · $250', 'Blusa floral · $40', 'Tenis Nike · $600']);
  assert.equal(d.nodo('.apartar-total').textContent, 'Total $890');
  assert.equal(d.nodo('.apartar-apartas').textContent, 'Apartas con $100');
  assert.equal(d.nodo('.apartar-falta').textContent, 'Falta por pagar $790 al recoger.');
  await d.enviar();
  assert.deepEqual(llamadas.map((l) => l.codigos), [['ED-000123', 'ED-000124', 'ED-000125']]);
  assert.equal(d.nodo('.apartar-titulo').textContent, '¡Apartadas!');
  assert.match(d.nodo('.apartar-vence').textContent, /Si no, las piezas vuelven a la venta\.$/);
  assert.deepEqual(d.eventos.map((e: any) => [e.evento, e.codigo]), [
    ['apartado_portal', 'ED-000123'], ['carrito_apartar', 'ED-000123'], ['apartado_portal', 'ED-000124'], ['carrito_apartar', 'ED-000124'],
    ['apartado_portal', 'ED-000125'], ['carrito_apartar', 'ED-000125']]);
});

test('carrito: si el servidor dice que una ya no está, se quita del resumen y del carrito, se avisa cuál y se reintenta con las demás', async () => {
  const d = dominio();
  const llamadas: any[] = [];
  const agotadas: string[][] = [];
  let respuesta: any = Object.assign(new Error('Una pieza ya no está disponible.'), { status: 409, datos: { no_disponibles: ['ED-000124'] } });
  const hoja = apartar.iniciarApartar({ api: async (_r: string, cuerpo: any) => { llamadas.push(cuerpo); if (respuesta instanceof Error) throw respuesta; return respuesta; },
    estaListo: () => true, irAAcceso: () => {}, alAgotarse: (c: string[]) => agotadas.push(c) });
  hoja.abrir([PIEZA, OTRA], 'carrito');
  await d.enviar();
  assert.deepEqual(agotadas, [['ED-000124']]);
  assert.deepEqual(d.renglones(), ['Chamarra Levis · $250']);
  assert.match(d.nodo('.apartar-error').textContent, /^Se vendió Blusa floral y la quitamos de tu pedido\. Revisa el total y vuelve a apartar\.$/);
  assert.equal(d.nodo('.apartar-total').textContent, 'Total $250');
  assert.deepEqual(d.vista(), ['form']);
  assert.deepEqual(d.eventos, []);
  respuesta = RESPUESTA();
  await d.enviar();
  // Otro conjunto de piezas = otro UUID, y ya sin la agotada.
  assert.notEqual(llamadas[0].id, llamadas[1].id);
  assert.deepEqual(llamadas[1].codigos, ['ED-000123']);
  assert.deepEqual(d.vista(), ['listo']);
  // Si ya no queda ninguna, la hoja lo dice y no ofrece apartar.
  const d2 = dominio();
  respuesta = Object.assign(new Error('x'), { status: 409, datos: { no_disponibles: ['ED-000123'] } });
  const sola = apartar.iniciarApartar({ api: async () => { throw respuesta; }, estaListo: () => true, irAAcceso: () => {} });
  sola.abrir([PIEZA]);
  await d2.enviar();
  assert.deepEqual(d2.vista(), ['vacio']);
  assert.equal(d2.nodo('.apartar-titulo').textContent, 'Ya no están disponibles');
});

test('hoja con sesión: sin datos de pago ofrece pedirlos; un 409 del servidor (el tope) se muestra y deja volver a intentar', async () => {
  const d = dominio();
  let respuesta: any = Object.assign(new Error('Ya tienes 3 apartados sin pago. Paga o cancela alguno para apartar otra pieza.'), { status: 409, datos: { error: 'x' } });
  const hoja = apartar.iniciarApartar({ api: async () => { if (respuesta instanceof Error) throw respuesta; return respuesta; }, estaListo: () => true, irAAcceso: () => {} });
  hoja.abrir([PIEZA]);
  await d.enviar();
  assert.equal(d.nodo('.apartar-error').textContent, 'Ya tienes 3 apartados sin pago. Paga o cancela alguno para apartar otra pieza.');
  assert.deepEqual(d.vista(), ['form']);
  assert.deepEqual(d.renglones(), ['Chamarra Levis · $250']);   // un 409 sin no_disponibles no quita nada
  assert.deepEqual(d.eventos, []);
  respuesta = RESPUESTA();
  await d.enviar();
  assert.equal(d.nodo('.apartar-con-datos').hidden, true);
  assert.equal(d.nodo('.apartar-sin-datos').hidden, false);
  assert.match(decodeURIComponent(d.nodo('.apartar-pedir-datos').href), /P-7.*datos para transferir/);
});
