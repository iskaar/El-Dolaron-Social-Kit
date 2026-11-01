// node --test src/apartados.test.ts
// «Mis apartados» del portal (Issue #669): chips y textos puros, y la lista contra un DOM de mentira.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as apartados from '../public/apartados.js';

const AHORA = Date.parse('2026-11-03T18:00:00Z');   // martes
const enHoras = (h: number) => new Date(AHORA + h * 3_600_000).toISOString();
const base = (extra: Record<string, unknown> = {}) => ({ folio: 12, estado: 'apartado', entrega: 'tienda', envio: 0, subtotal: 25000, saldo: 0, faltante: 25000,
  vence_en: enHoras(23), liquidado_en: null, guia: '', viernes_envio: null, creado_en: enHoras(-1), cancelable: true, pago_reportado: null,
  lineas: [{ codigo: 'ED-000123', nombre: 'Chamarra Levis', precio: 25000, cantidad: 1 }], ...extra });

test('chips: cuenta regresiva en horas con umbrales, pago en revisión, rechazado, listo para recoger, envío, guía, vencido y cancelado', () => {
  const chip = (extra: Record<string, unknown>) => apartados.estadoApartado(base(extra) as never, AHORA);
  assert.deepEqual(chip({}), { clase: 'aviso', texto: '⏳ Vence en 23 h' });
  assert.deepEqual(chip({ vence_en: enHoras(6) }), { clase: 'alerta', texto: '⚠ Vence en 6 h' });
  assert.deepEqual(chip({ vence_en: enHoras(0.5) }), { clase: 'alerta', texto: '⚠ Vence en menos de 1 h' });
  assert.equal(chip({ vence_en: enHoras(-1) }).clase, 'alerta');
  assert.match(chip({ vence_en: enHoras(-1) }).texto, /Ya venció/);
  assert.deepEqual(chip({ pago_reportado: { estado: 'pendiente', motivo: '' } }), { clase: 'aviso', texto: '⏳ Pago en revisión · la tienda lo está revisando' });
  assert.deepEqual(chip({ pago_reportado: { estado: 'rechazado', motivo: 'No llegó el dinero' } }), { clase: 'alerta', texto: '⚠ No encontramos tu pago: No llegó el dinero' });
  assert.deepEqual(chip({ saldo: 10000, faltante: 15000, vence_en: enHoras(150) }), { clase: 'ok', texto: '✓ Pago recibido · Listo para recoger' });
  assert.deepEqual(chip({ entrega: 'envio', envio: 9900, saldo: 10000, faltante: 24900 }), { clase: 'aviso', texto: '✓ Pago recibido ($100) · completa el pago para el envío' });
  assert.deepEqual(chip({ estado: 'vendido', entrega: 'envio', saldo: 0, faltante: 0, viernes_envio: '2026-11-06' }), { clase: 'ok', texto: '✓ Pagado · Se envía el viernes 6 de noviembre' });
  assert.deepEqual(chip({ estado: 'vendido', entrega: 'envio', guia: 'DHL 434', viernes_envio: '2026-11-06' }), { clase: 'ok', texto: '✓ Enviado · guía DHL 434' });
  assert.deepEqual(chip({ estado: 'vendido' }), { clase: 'ok', texto: '✓ Compra completada' });
  assert.match(chip({ estado: 'vencido' }).texto, /^✕ Vencido/);
  assert.equal(chip({ estado: 'cancelado' }).texto, '✕ Cancelado');
});

test('detalle: qué pagar para apartarla, lo que falta y hasta cuándo; «Ya pagué» solo sin dinero ni pago en revisión', () => {
  const detalle = (extra: Record<string, unknown>) => apartados.detalleApartado(base(extra) as never, AHORA);
  assert.deepEqual(detalle({}).slice(0, 2), ['Para apartarla paga $100 por transferencia. Total $250.', 'Falta por pagar $250.']);
  assert.match(detalle({})[2], /^Tienes hasta el miércoles 4 nov, 11:00 a\. m\.$/);
  assert.deepEqual(detalle({ subtotal: 6000, faltante: 6000 }).slice(0, 2), ['Para apartarla paga $60 por transferencia. Total $60.', 'Falta por pagar $60.']);
  assert.deepEqual(detalle({ entrega: 'envio', envio: 9900, faltante: 34900 }).slice(0, 2), ['Para apartarla paga $100 por transferencia. Total $349.', 'Falta por pagar $349.']);
  assert.deepEqual(detalle({ pago_reportado: { estado: 'pendiente', motivo: '' } }), ['Ya mandaste tu pago de $100: te avisamos al registrarlo.']);
  assert.match(detalle({ saldo: 10000, faltante: 15000 })[0], /^Falta por pagar \$150 al recogerla\.$/);
  assert.match(detalle({ saldo: 10000, faltante: 15000 })[1], /^Recógela en Soledad antes del /);
  assert.equal(detalle({ saldo: 25000, faltante: 0 })[0], 'Ya está pagada.');
  assert.match(detalle({ entrega: 'envio', envio: 9900, saldo: 10000, faltante: 24900 })[1], /Completa el pago antes del .*; después sale el viernes\./);
  assert.deepEqual(detalle({ estado: 'cancelado' }), []);
  assert.equal(apartados.puedeAvisarPago(base() as never), true);
  assert.equal(apartados.puedeAvisarPago(base({ saldo: 10000 }) as never), false);
  assert.equal(apartados.puedeAvisarPago(base({ pago_reportado: { estado: 'pendiente' } }) as never), false);
  assert.equal(apartados.puedeAvisarPago(base({ pago_reportado: { estado: 'rechazado', motivo: 'x' } }) as never), true);
  assert.equal(apartados.puedeAvisarPago(base({ estado: 'vencido' }) as never), false);
});

test('portal.html trae todo lo que apartados.js busca y «Mis apartados» va después de la membresía y antes de «Mis compras»', () => {
  const html = readFileSync('public/portal.html', 'utf8');
  const js = readFileSync('public/apartados.js', 'utf8');
  const clases = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(' ')));
  for (const sel of new Set([...js.matchAll(/\bq\('([^']+)'\)/g)].map((m) => m[1]))) assert.ok(clases.has(sel.slice(1)), sel);
  for (const sel of ['.cancelar-si', '.cancelar-no', '.cancelar-pregunta', '.cancelar-error']) assert.ok(js.includes(sel) && clases.has(sel.slice(1)), sel);
  for (const id of ['apartados', 'apartado-cancelar']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<section id="apartados"[^>]* hidden>/);   // oculta si no hay ninguno
  assert.ok(html.indexOf('class="membresia"') < html.indexOf('id="apartados"') && html.indexOf('id="apartados"') < html.indexOf('id="titulo-compras"'));
  assert.match(html, /class="apartar-ver secundario"[^>]*>Ver mis apartados</);
});

/** Un DOM mínimo con árbol, suficiente para pintar la lista y recorrerla. */
function dom() {
  const nodo = (etiqueta = 'x', clase = '') => ({ etiqueta, className: clase, textContent: '', hidden: false, disabled: false, href: '', children: [] as any[], oyentes: {} as Record<string, () => any>,
    append(...hijos: any[]) { this.children.push(...hijos); }, replaceChildren(...hijos: any[]) { this.children = hijos; },
    addEventListener(tipo: string, f: () => any) { this.oyentes[tipo] = f; }, remove() {}, setAttribute() {}, showModal() { this.abierto = true; }, close() { this.abierto = false; },
    abierto: false, dataset: {} as Record<string, string>, type: '', target: '', rel: '' });
  const secciones = new Map<string, any>();
  const buscar = (sel: string) => { if (!secciones.has(sel)) secciones.set(sel, nodo('q', sel)); return secciones.get(sel); };
  const seccion = Object.assign(nodo('section', 'apartados'), { hidden: true, querySelector: buscar });
  const dialogo = Object.assign(nodo('dialog', 'cancelar'), { querySelector: buscar });
  const poner = (nombre: string, valor: unknown) => Object.defineProperty(globalThis, nombre, { value: valor, configurable: true, writable: true });
  poner('document', { getElementById: (id: string) => (id === 'apartados' ? seccion : id === 'apartado-cancelar' ? dialogo : null), createElement: (t: string) => nodo(t) });
  poner('Image', function () { return nodo('img'); });
  poner('setInterval', () => 0);   // el repintado por minuto no debe mantener vivo el proceso de prueba
  const todos = (n: any): any[] => [n, ...n.children.flatMap(todos)];
  const textos = (n: any) => todos(n).map((x) => x.textContent).filter(Boolean);
  return { seccion, dialogo, buscar, todos, textos };
}

test('la lista agrupa por urgencia, deja lo cerrado en «Anteriores», cancela con confirmación y vuelve a pedir la lista', async (t) => {
  t.mock.method(Date, 'now', () => AHORA);
  const d = dom();
  let lista = [
    base({ folio: 1, vence_en: enHoras(30) }),
    base({ folio: 2, vence_en: enHoras(3), lineas: [{ codigo: 'ED-000124', nombre: 'Blusa', precio: 15000, cantidad: 1 }] }),
    base({ folio: 3, estado: 'apartado', saldo: 10000, faltante: 15000, cancelable: false, vence_en: enHoras(150) }),
    base({ folio: 4, estado: 'cancelado', cancelable: false }),
  ];
  const llamadas: string[] = [];
  const pagos: unknown[] = [];
  const mios = apartados.iniciarApartados({ alPagar: (info: unknown) => { pagos.push(info); }, api: async (ruta: string, cuerpo?: unknown) => {
    llamadas.push(cuerpo === undefined ? ruta : `${ruta} ${JSON.stringify(cuerpo)}`);
    if (ruta === 'apartados') return { apartados: lista, datos_pago: 'Banco de prueba' };
    lista = lista.map((a) => (a.folio === 2 ? { ...a, estado: 'cancelado', cancelable: false } : a));
    return { ok: true, folio: 2 };
  } });
  assert.equal(d.seccion.hidden, true);
  await mios.cargar();
  assert.equal(d.seccion.hidden, false);
  const principal = d.buscar('.apartados-lista');
  // Sin pago por vencer primero (P-2 vence en 3 h), luego P-1, luego los que ya tienen dinero (P-3).
  assert.deepEqual(principal.children.map((li: any) => d.todos(li).find((x) => /^P-\d+ ·/.test(x.textContent))!.textContent.slice(0, 4)), ['P-2 ', 'P-1 ', 'P-3 ']);
  assert.deepEqual(d.buscar('.apartados-previos-lista').children.length, 1);
  assert.equal(d.buscar('.apartados-previos').hidden, false);
  assert.equal(d.buscar('.apartados-resumen-previos').textContent, 'Anteriores (1)');
  const primera = principal.children[0];
  assert.ok(d.textos(primera).includes('Blusa'));
  assert.ok(d.textos(primera).includes('⚠ Vence en 3 h'));
  // «Ya pagué» abre la hoja de pago (#670) con lo del servidor: folio, qué transferir, concepto y datos de pago.
  const pague = d.todos(primera).find((x) => x.className.includes('apartado-pague'));
  assert.equal(pague.textContent, 'Ya pagué');
  pague.oyentes.click();
  assert.deepEqual(pagos, [{ folio: 2, nombre: 'Blusa', monto: 10000, concepto: 'P-2', datos_pago: 'Banco de prueba', rechazado: '' }]);
  const tercera = principal.children[2];
  assert.equal(d.todos(tercera).some((x) => x.className.includes('apartado-pague') || x.className.includes('apartado-cancelar')), false);   // con dinero ya solo la tienda
  assert.ok(d.textos(tercera).includes('✓ Pago recibido · Listo para recoger'));

  // Cancelar P-2: pregunta, y solo al confirmar manda el POST y recarga.
  d.todos(primera).find((x) => x.className.includes('apartado-cancelar')).oyentes.click();
  assert.equal(d.dialogo.abierto, true);
  assert.match(d.buscar('.cancelar-pregunta').textContent, /¿Cancelar el apartado P-2\? La pieza vuelve a la venta\. No se te cobra nada\./);
  assert.deepEqual(llamadas, ['apartados']);
  await d.buscar('.cancelar-si').oyentes.click();
  assert.deepEqual(llamadas, ['apartados', 'apartados/2/cancelar {}', 'apartados']);
  assert.equal(d.dialogo.abierto, false);
  assert.equal(d.buscar('.apartados-aviso').textContent, 'Cancelaste el apartado P-2.');
  assert.equal(d.buscar('.apartados-lista').children.length, 2);
  assert.equal(d.buscar('.apartados-resumen-previos').textContent, 'Anteriores (2)');

  mios.limpiar();
  assert.equal(d.seccion.hidden, true);
  assert.equal(d.buscar('.apartados-lista').children.length, 0);
});

test('sin apartados la sección queda oculta y un 409 al cancelar muestra el motivo y recarga', async () => {
  const d = dom();
  const mios = apartados.iniciarApartados({ api: async (ruta: string) => {
    if (ruta === 'apartados') return { apartados: [] };
    throw Object.assign(new Error('Ya no se puede cancelar aquí: pídelo a la tienda.'), { status: 409 });
  } });
  await mios.cargar();
  assert.equal(d.seccion.hidden, true);
  await d.buscar('.cancelar-si').oyentes.click();   // sin folio elegido: el servidor lo rechaza
  assert.equal(d.buscar('.cancelar-error').textContent, 'Ya no se puede cancelar aquí: pídelo a la tienda.');
});

test('un pedido de varias piezas (carrito, #681): textos en plural, una línea por pieza, «Cancelar» avisa que vuelven todas', async (t) => {
  t.mock.method(Date, 'now', () => AHORA);
  const tres = [{ codigo: 'ED-000123', nombre: 'Chamarra Levis', precio: 25000, cantidad: 1 }, { codigo: 'ED-000124', nombre: 'Blusa', precio: 4000, cantidad: 1 }, { codigo: 'ED-000125', nombre: 'Tenis', precio: 6000, cantidad: 1 }];
  const varias = base({ lineas: tres, subtotal: 35000, faltante: 35000 });
  assert.deepEqual(apartados.detalleApartado(varias as never, AHORA).slice(0, 2), ['Para apartarlas paga $100 por transferencia. Total $350.', 'Falta por pagar $350.']);
  assert.match(apartados.detalleApartado(base({ lineas: tres, saldo: 10000, faltante: 25000 }) as never, AHORA)[0], /^Falta por pagar \$250 al recogerlas\.$/);
  assert.match(apartados.detalleApartado(base({ lineas: tres, saldo: 10000, faltante: 25000 }) as never, AHORA)[1], /^Recógelas en Soledad antes del /);
  assert.match(apartados.estadoApartado(base({ lineas: tres, estado: 'vencido' }) as never, AHORA).texto, /^✕ Vencido · las piezas volvieron a la venta$/);
  assert.match(apartados.estadoApartado(base({ lineas: tres, vence_en: enHoras(-1) }) as never, AHORA).texto, /las piezas vuelven a la venta$/);
  assert.match(apartados.estadoApartado(base({ estado: 'vencido' }) as never, AHORA).texto, /^✕ Vencido · la pieza volvió a la venta$/);   // una sola: como antes

  const d = dom();
  const pagos: any[] = [];
  const mios = apartados.iniciarApartados({ alPagar: (info: unknown) => { pagos.push(info); }, api: async () => ({ apartados: [varias], datos_pago: null }) });
  await mios.cargar();
  const tarjeta = d.buscar('.apartados-lista').children[0];
  assert.ok(d.textos(tarjeta).includes('3 piezas'));
  const renglones = d.todos(tarjeta).find((x) => x.className === 'apartado-piezas')!.children.map((li: any) => li.textContent);
  assert.deepEqual(renglones, ['Chamarra Levis · $250', 'Blusa · $40', 'Tenis · $60']);
  d.todos(tarjeta).find((x) => x.className.includes('apartado-pague')).oyentes.click();
  assert.deepEqual([pagos[0].nombre, pagos[0].monto], ['3 piezas', 10000]);
  d.todos(tarjeta).find((x) => x.className.includes('apartado-cancelar')).oyentes.click();
  assert.match(d.buscar('.cancelar-pregunta').textContent, /Las piezas vuelven a la venta\. No se te cobra nada\./);
});
