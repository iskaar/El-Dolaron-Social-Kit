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
  assert.match(html, /<input type="radio" name="apartar-entrega" value="tienda" checked>/);
  assert.match(html, /<input type="radio" name="apartar-entrega" value="envio">/);
  assert.match(html, /<button class="ficha-apartar" type="button" hidden>Apartar aquí<\/button>/);
  assert.match(html, /Regístrate en un minuto para apartar aquí, o escríbenos por WhatsApp\./);
  for (const texto of [html, js, readFileSync('public/portal.js', 'utf8')]) assert.ok(!/\d{18}/.test(texto.replace(/[\s-]/g, '')), 'hay 18 dígitos seguidos');
  // «Lo quiero» sigue siendo el enlace a WhatsApp de siempre.
  assert.match(html, /<a class="ficha-quiero" href="https:\/\/wa\.me\/524445437754" target="_blank" rel="noopener">Lo quiero<\/a>/);
});

/** Un DOM mínimo: cada selector es un nodo con lo que apartar.js toca. */
function dominio() {
  const nodos = new Map<string, any>();
  const nodo = (sel: string) => {
    if (!nodos.has(sel)) nodos.set(sel, { sel, hidden: false, textContent: '', href: '', disabled: false, dataset: {} as Record<string, string>,
      oyentes: {} as Record<string, (e: any) => any>, addEventListener(tipo: string, f: (e: any) => any) { this.oyentes[tipo] = f; }, focus() {} });
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
  poner('document', { getElementById: (id: string) => (id === 'apartar-dialogo' ? dialogo : null) });
  poner('navigator', { sendBeacon: (_ruta: string, cuerpo: string) => { eventos.push(JSON.parse(cuerpo)); return true; } });
  const enviar = async () => { await nodo('.apartar-form').oyentes.submit({ preventDefault() {} }); };
  const vista = () => ['invitado', 'form', 'listo'].filter((v) => !nodo(`.apartar-${v}`).hidden);
  return { dialogo, nodo, radios, eventos, enviar, vista };
}

const PIEZA = { codigo: 'ED-000123', nombre: 'Chamarra Levis', precio: 25000, foto: '/api/catalogo/foto/ED-000123' };
const RESPUESTA = (extra: Record<string, unknown> = {}) => ({
  pedido: { folio: 7, vence_en: new Date(Date.now() + 24 * 3_600_000).toISOString(), entrega: 'tienda', envio: 0, subtotal: 25000, lineas: [] },
  a_pagar: 10000, concepto: 'P-7', datos_pago: null, ...extra });

test('hoja sin sesión: avisa que registrarse toma un minuto, ofrece WhatsApp con la pieza y el registro recuerda la pieza', async () => {
  const d = dominio();
  const registros: string[] = [];
  const hoja = apartar.iniciarApartar({ api: async () => { throw new Error('no debe llamarse'); }, estaListo: () => false, irAAcceso: (c: string) => registros.push(c) });
  hoja.abrir(PIEZA);
  assert.deepEqual(d.vista(), ['invitado']);
  assert.equal(d.dialogo.abierto, true);
  assert.equal(d.nodo('.apartar-titulo').textContent, 'Apartar aquí');
  assert.equal(d.nodo('.apartar-pieza').textContent, 'Chamarra Levis · $250');
  assert.equal(d.nodo('.apartar-whatsapp').href, 'https://wa.me/524445437754?text=Quiero%20producto%20ED-000123');
  d.nodo('.apartar-registrar').oyentes.click();
  assert.deepEqual(registros, ['ED-000123']);
  assert.equal(d.dialogo.abierto, false);
});

test('hoja con sesión: elige entrega, el reintento conserva el UUID, éxito muestra folio, concepto, datos y mide una vez', async () => {
  const d = dominio();
  const llamadas: any[] = [];
  let fallar: any = new TypeError('Failed to fetch');
  let terminado = 0;
  const pagos: unknown[] = [];
  const hoja = apartar.iniciarApartar({
    api: async (ruta: string, cuerpo: any) => { llamadas.push({ ruta, ...cuerpo }); if (fallar) throw fallar; return RESPUESTA({ datos_pago: `Banco de prueba\nCLABE ${'9'.repeat(18)}\nTitular de prueba` }); },
    estaListo: () => true, irAAcceso: () => {}, alTerminar: () => { terminado++; }, alPagar: (info: unknown) => { pagos.push(info); } });
  hoja.abrir(PIEZA);
  assert.deepEqual(d.vista(), ['form']);
  assert.equal(d.nodo('.apartar-enviar').textContent, 'Apartar por $100');
  assert.match(d.nodo('.apartar-explica').textContent, /^Pagas \$100 por transferencia y el resto al recogerla/);
  assert.equal(d.nodo('.apartar-envio-costo').textContent, 'Envío $99 (gratis desde $1,000)');
  d.radios[0].checked = false; d.radios[1].checked = true;
  d.radios[1].oyentes.change();
  assert.match(d.nodo('.apartar-explica').textContent, /^Pagas \$100 ahora y abonas el resto/);

  await d.enviar();   // se cae la red
  assert.match(d.nodo('.apartar-error').textContent, /No pudimos conectar.*no se aparta dos veces/);
  assert.equal(d.nodo('.apartar-enviar').disabled, false);
  fallar = null;
  await d.enviar();   // reintento: mismo UUID
  assert.equal(llamadas.length, 2);
  assert.equal(llamadas[0].id, llamadas[1].id);
  assert.match(llamadas[0].id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([llamadas[1].ruta, llamadas[1].codigo, llamadas[1].entrega], ['apartar', 'ED-000123', 'envio']);
  assert.deepEqual(Object.keys(llamadas[1]).sort(), ['codigo', 'entrega', 'id', 'ruta']);   // nada de precio, teléfono ni nombre
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
  // «Ya pagué» abre la hoja de pago con lo que respondió el servidor (#670).
  d.nodo('.apartar-pague').oyentes.click();
  assert.deepEqual(pagos, [{ folio: 7, nombre: 'Chamarra Levis', monto: 10000, concepto: 'P-7', datos_pago: `Banco de prueba
CLABE ${'9'.repeat(18)}
Titular de prueba` }]);
  assert.deepEqual(d.eventos, [{ evento: 'apartado_portal', codigo: 'ED-000123', origen: 'portal' }]);
  d.nodo('.apartar-cerrar').oyentes.click();
  assert.equal(terminado, 1);

  // Una pieza nueva: UUID nuevo; sin datos de pago la hoja ofrece pedirlos por WhatsApp y sin CLABE no hay botón de copiar.
  hoja.abrir({ ...PIEZA, codigo: 'ED-000124' });
  await d.enviar();
  assert.notEqual(llamadas[2].id, llamadas[1].id);
});

test('hoja con sesión: sin datos de pago ofrece pedirlos; un 409 del servidor se muestra y deja volver a intentar', async () => {
  const d = dominio();
  let respuesta: any = Object.assign(new Error('Ya tienes 3 apartados sin pago. Paga o cancela alguno para apartar otra pieza.'), { status: 409 });
  const hoja = apartar.iniciarApartar({ api: async () => { if (respuesta instanceof Error) throw respuesta; return respuesta; }, estaListo: () => true, irAAcceso: () => {} });
  hoja.abrir(PIEZA);
  await d.enviar();
  assert.equal(d.nodo('.apartar-error').textContent, 'Ya tienes 3 apartados sin pago. Paga o cancela alguno para apartar otra pieza.');
  assert.deepEqual(d.vista(), ['form']);
  assert.deepEqual(d.eventos, []);
  respuesta = RESPUESTA();
  await d.enviar();
  assert.equal(d.nodo('.apartar-con-datos').hidden, true);
  assert.equal(d.nodo('.apartar-sin-datos').hidden, false);
  assert.match(decodeURIComponent(d.nodo('.apartar-pedir-datos').href), /P-7.*datos para transferir/);
});
