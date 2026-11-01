// node --test src/pagos.test.ts
// «Ya pagué» del portal (Issue #670): monto, bancos copiados de venta.js, la hoja contra un DOM de mentira y el token en la foto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as pagos from '../public/pagos.js';
import { adjuntar } from '../public/comprobante.js';
import { BANCOS } from '../public/venta.js';

test('BANCOS copiados coinciden con venta.js y el monto se lee en pesos exactos o se rechaza', () => {
  assert.deepEqual(pagos.BANCOS, BANCOS);
  assert.equal(pagos.centavosDe(''), undefined);
  assert.equal(pagos.centavosDe('  '), undefined);
  assert.equal(pagos.centavosDe('100'), 10000);
  assert.equal(pagos.centavosDe('$1,250.5'), 125050);
  assert.equal(pagos.centavosDe('99.99'), 9999);
  for (const malo of ['0', '-5', 'cien', '1.234', '12345678', '1e3']) assert.equal(pagos.centavosDe(malo), null, malo);
});

test('portal.html trae todo lo que pagos.js busca, el campo de la foto acepta imagen y el aviso de pago es una sola hoja', () => {
  const html = readFileSync('public/portal.html', 'utf8');
  const js = readFileSync('public/pagos.js', 'utf8');
  const clases = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(' ')));
  const ids = new Set([...html.matchAll(/id="([^"]*)"/g)].map((m) => m[1]));
  for (const sel of new Set([...js.matchAll(/\bq\('([^']+)'\)/g)].map((m) => m[1]))) assert.ok(clases.has(sel.slice(1)), sel);
  for (const id of new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]).concat(['pago-dialogo']))) assert.ok(ids.has(id), id);
  assert.match(html, /<input id="pago-foto" type="file" accept="image\/\*"/);
  assert.match(html, /No es el «número de referencia»/);
  assert.match(js, /apartados\/\$\{pedido\.folio\}\/pago/);
  assert.match(js, /apartados\/\$\{pedido\.folio\}\/comprobante/);
  assert.ok(!/\d{18}/.test(js.replace(/[\s-]/g, '')) && !/\d{18}/.test(html.replace(/[\s-]/g, '')), 'hay 18 dígitos seguidos');
});

test('comprobante.js con cabeceras: el socio manda su token y la caja sigue sin él', async (t) => {
  const g = globalThis as any;
  const guardado = { bitmap: g.createImageBitmap, doc: g.document, fetch: g.fetch };
  g.createImageBitmap = async () => ({ width: 100, height: 100, close() {} });
  g.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: (cb: (b: Blob) => void) => cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])])) }) };
  t.after(() => { g.createImageBitmap = guardado.bitmap; g.document = guardado.doc; g.fetch = guardado.fetch; });
  const cabeceras: Record<string, string>[] = [];
  g.fetch = async (_url: string, init: { headers: Record<string, string> }) => { cabeceras.push(init.headers); return new Response(JSON.stringify({ key: 'comprobantes/x.jpg', lectura: null })); };
  const nodos = new Map<string, any>();
  const $ = (id: string) => nodos.get(id) ?? nodos.set(id, { value: '', textContent: '' }).get(id);
  const ids = { clave: 'c', monto: 'm', banco: 'b', aviso: 'a' };
  await adjuntar({ files: [{}], dataset: {} } as never, { ...ids, ruta: '/api/portal/apartados/3/comprobante', cabeceras: async () => ({ authorization: 'Bearer TOKEN' }) }, $);
  await adjuntar({ files: [{}], dataset: {} } as never, ids, $);
  assert.deepEqual(cabeceras, [{ 'content-type': 'image/jpeg', authorization: 'Bearer TOKEN' }, { 'content-type': 'image/jpeg' }]);
});

/** DOM mínimo: cada id y cada selector son nodos con lo que pagos.js toca. */
function dom() {
  const nodos = new Map<string, any>();
  const nodo = (clave: string) => {
    if (!nodos.has(clave)) nodos.set(clave, { clave, value: '', hidden: false, disabled: false, textContent: '', href: '', dataset: {} as Record<string, string>,
      oyentes: {} as Record<string, (e?: any) => any>, children: [] as unknown[], classList: { toggle() {} },
      addEventListener(tipo: string, f: (e?: any) => any) { this.oyentes[tipo] = f; }, append(...h: unknown[]) { this.children.push(...h); }, reset() {}, focus() {} });
    return nodos.get(clave);
  };
  const dialogo = Object.assign(nodo('#pago-dialogo'), { abierto: false, querySelector: (sel: string) => nodo(sel), showModal() { this.abierto = true; }, close() { this.abierto = false; } });
  const poner = (nombre: string, valor: unknown) => Object.defineProperty(globalThis, nombre, { value: valor, configurable: true, writable: true });
  poner('document', { getElementById: (id: string) => (id === 'pago-dialogo' ? dialogo : nodo(`#${id}`)) });
  poner('Option', class { textContent: string; value: string; constructor(texto: string, valor: string) { this.textContent = texto; this.value = valor; } });
  return { dialogo, nodo };
}

const INFO = { folio: 7, nombre: 'Chamarra Levis', monto: 10000, concepto: 'P-7', datos_pago: `Banco de prueba\nCLABE ${'9'.repeat(18)}`, rechazado: '' };

test('la hoja: llena el banco, enseña monto, concepto y CLABE; manda el pago con un solo UUID por intento y avisa al terminar', async () => {
  const d = dom();
  const llamadas: any[] = [];
  let falla: any = new TypeError('Failed to fetch');
  let reportados = 0;
  const hoja = pagos.iniciarPagos({ api: async (ruta: string, cuerpo: any) => { llamadas.push({ ruta, ...cuerpo }); if (falla) throw falla; return { reporte: { estado: 'pendiente' } }; },
    token: async () => 'TOKEN', alReportar: () => { reportados++; } });
  assert.equal(d.nodo('#pago-banco').children.length, pagos.BANCOS.length);
  hoja.abrir(INFO);
  assert.equal(d.dialogo.abierto, true);
  assert.equal(d.nodo('.pago-resumen').textContent, 'P-7 · Chamarra Levis');
  assert.equal(d.nodo('.pago-monto-texto').textContent, '$100');
  assert.equal(d.nodo('.pago-concepto').textContent, 'P-7');
  assert.equal(d.nodo('.pago-con-datos').hidden, false);
  assert.equal(d.nodo('.pago-copiar-clabe').hidden, false);
  assert.equal(d.nodo('.pago-copiar-clabe').dataset.clabe, '9'.repeat(18));
  assert.equal(d.nodo('.pago-rechazado').hidden, true);
  assert.equal(d.nodo('.pago-whatsapp').href, 'https://wa.me/524445437754?text=Pagu%C3%A9%20el%20apartado%20P-7');
  const enviar = () => d.nodo('.pago-form').oyentes.submit({ preventDefault() {} });

  // Sin foto ni clave, o con un monto inválido, no sale ninguna petición.
  await enviar();
  assert.equal(d.nodo('.pago-aviso').textContent, 'Sube la foto del comprobante o escribe la clave de rastreo.');
  d.nodo('#pago-clave').value = 'abc123456';
  d.nodo('#pago-monto').value = 'cien';
  await enviar();
  assert.match(d.nodo('.pago-aviso').textContent, /Escribe el monto en pesos/);
  assert.equal(llamadas.length, 0);

  d.nodo('#pago-monto').value = '100';
  d.nodo('#pago-banco').value = '40012';
  await enviar();   // se cae la red
  assert.match(d.nodo('.pago-aviso').textContent, /No sabemos si se mandó.*no se repite/);
  falla = null;
  await enviar();   // reintento: mismo UUID, mismo cuerpo
  assert.equal(llamadas.length, 2);
  assert.equal(llamadas[0].id, llamadas[1].id);
  assert.deepEqual(llamadas[1], { ruta: 'apartados/7/pago', id: llamadas[1].id, clave_rastreo: 'abc123456', comprobante_key: undefined, fecha_comprobante: undefined, monto: 10000, banco_emisor: '40012' });
  assert.equal(d.dialogo.abierto, false);
  assert.equal(reportados, 1);

  // Con foto ya subida basta sin clave; un rechazo del servidor se muestra y deja mandar otro.
  hoja.abrir({ ...INFO, rechazado: 'La tienda no encontró tu pago: No llegó el dinero. Manda otro comprobante.' });
  assert.equal(d.nodo('.pago-rechazado').hidden, false);
  for (const id of ['#pago-clave', '#pago-monto', '#pago-banco']) d.nodo(id).value = '';   // form.reset() del navegador
  d.nodo('#pago-foto').dataset.key = 'comprobantes/x.jpg';
  d.nodo('#pago-foto').dataset.fecha = '2026-11-02';
  falla = Object.assign(new Error('Esa clave ya se usó en otro pago.'), { status: 409 });
  await enviar();
  assert.equal(d.nodo('.pago-aviso').textContent, 'Esa clave ya se usó en otro pago.');
  assert.equal(llamadas[2].comprobante_key, 'comprobantes/x.jpg');
  assert.equal(llamadas[2].monto, undefined);
  assert.equal(d.dialogo.abierto, true);
  falla = null;
  await enviar();
  assert.notEqual(llamadas[3].id, llamadas[2].id);   // un 409 no es una respuesta perdida: nuevo intento, nuevo id
  assert.equal(reportados, 2);
});
