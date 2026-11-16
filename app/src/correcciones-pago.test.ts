// node --test src/correcciones-pago.test.ts
// Corregir la forma de pago de un ticket antes del corte (Issue #831) contra SQLite real con todas las migraciones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, codigoPrueba, datosTransferencia, PRODUCTO, DUENO } from './prueba-d1.ts';
import { readFileSync } from 'node:fs';
import { permiso } from './cuentas.ts';

type T = ReturnType<typeof tienda>;

const CAJERO = 'caja@prueba.mx';
const CAPTURISTA = 'captura@prueba.mx';
const PC = 'pc@prueba.mx';

// Ventas de $250 por pieza (el producto de prueba) en la Caja 1.
function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values
    ('${CAJERO}', 'Ana', 'cajero', 1, '', ''), ('${CAPTURISTA}', 'C', 'capturista', 1, '', '')`).run();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values ('${PC}', 'Computadora', 'computadora', 1, 'soledad', '', '')`).run();
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  const vender = async (extra: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    const r = await t.pedir('/api/ventas', {
      id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1', ...extra,
    });
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    return id;
  };
  const corregir = (id: string, forma: string, extra: Record<string, unknown> = {}) =>
    t.pedir(`/api/ventas/${id}/corregir-pago`, { id: crypto.randomUUID(), forma_pago: forma, motivo: 'Era con tarjeta', caja: 'Caja 1', ...extra });
  const cortar = (extra: Record<string, unknown> = {}) =>
    t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 0, sin_efectivo: true, tarjeta_terminal: 0, ...extra });
  const venta = (id: string) => ({ ...t.db.prepare('select forma_pago, efectivo, cambio, total, revision, corte_id from ventas where id = ?').get(id) } as
    { forma_pago: string; efectivo: number; cambio: number; total: number; revision: number; corte_id: string | null });
  const rastros = (id?: string) => t.db.prepare(`select * from correcciones_pago ${id ? 'where venta_id = ?' : ''} order by rowid`).all(...(id ? [id] : [])) as Record<string, any>[];
  // Corre `accion` justo antes del siguiente batch de D1: lo que se cuela entre la lectura y la escritura de una solicitud.
  const entreLecturaYBatch = (accion: () => Promise<unknown>) => {
    const original = t.env.DB.batch.bind(t.env.DB);
    t.env.DB.batch = (async (s: never) => { t.env.DB.batch = original as never; await accion(); return original(s); }) as never;
  };
  return { ...t, como, vender, corregir, cortar, venta, rastros, entreLecturaYBatch };
}

const AVISO_CORTE = 'Este ticket ya entró a un corte de caja: su forma de pago ya no se puede corregir aquí. Avísale al dueño.';

test('efectivo a tarjeta: el ticket cambia, deja su rastro y el corte espera menos efectivo y más tarjeta', async () => {
  const t = montar();
  const id = await t.vender({ efectivo: 30000 });   // cobró $250 con un billete de $300: cambio $50
  await t.vender();                                 // otro ticket de efectivo, sin tocar
  assert.deepEqual({ ...t.venta(id), revision: 0 }, { forma_pago: 'efectivo', efectivo: 30000, cambio: 5000, total: 25000, revision: 0, corte_id: null });

  const r = await t.corregir(id, 'tarjeta', { motivo: '  Era   con tarjeta  ' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.deepEqual(r.cuerpo, { id: r.cuerpo.id, venta_id: id, forma_anterior: 'efectivo', forma_pago: 'tarjeta', importe: 25000 });
  assert.deepEqual({ ...t.venta(id), revision: 0 }, { forma_pago: 'tarjeta', efectivo: 0, cambio: 0, total: 25000, revision: 0, corte_id: null });
  assert.equal(t.venta(id).revision, 1);
  const [fila] = t.rastros(id);
  assert.deepEqual({ ...fila, creado_en: typeof fila.creado_en },
    { id: r.cuerpo.id, venta_id: id, forma_anterior: 'efectivo', forma_nueva: 'tarjeta', importe: 25000, efectivo_anterior: 30000, cambio_anterior: 5000,
      motivo: 'Era con tarjeta', autor: DUENO, caja: 'Caja 1', tienda: 'soledad', creado_en: 'string' });

  // Sin la corrección el corte esperaba $500 + $250 + $250; con ella, solo el efectivo del ticket de control.
  const c = await t.cortar({ efectivo_contado: 75000, sin_efectivo: undefined, tarjeta_terminal: 25000 });
  assert.equal(c.status, 201, JSON.stringify(c.cuerpo));
  assert.equal(c.cuerpo.efectivo_ventas, 25000);
  assert.equal(c.cuerpo.efectivo_esperado, 75000);
  assert.equal(c.cuerpo.tarjeta_sistema, 25000);
  assert.equal(c.cuerpo.diferencia, 0);
  assert.equal(c.cuerpo.formas_corregidas, 1);
});

test('tarjeta o transferencia (menos de $300, sin clave) a efectivo: queda lo pagado en dinero y sin cambio; varias correcciones, cada una con su rastro', async () => {
  const t = montar();
  const id = await t.vender({ forma_pago: 'tarjeta', efectivo: 0 });
  assert.equal((await t.corregir(id, 'efectivo')).status, 201);
  assert.deepEqual({ ...t.venta(id), revision: 0, corte_id: null }, { forma_pago: 'efectivo', efectivo: 25000, cambio: 0, total: 25000, revision: 0, corte_id: null });
  assert.equal((await t.corregir(id, 'transferencia')).status, 201);   // $250 < $300: sin clave
  assert.equal(t.venta(id).forma_pago, 'transferencia');
  assert.equal(t.venta(id).efectivo, 0);
  assert.deepEqual(t.rastros(id).map((f) => [f.forma_anterior, f.forma_nueva, f.efectivo_anterior]), [['tarjeta', 'efectivo', 0], ['efectivo', 'transferencia', 25000]]);

  const c = await t.cortar();
  assert.equal(c.cuerpo.efectivo_ventas, 0);
  assert.equal(c.cuerpo.tarjeta_sistema, 0);
  assert.equal(c.cuerpo.transferencias, 25000);
  assert.equal(c.cuerpo.formas_corregidas, 2);
});

test('lo pagado con Dolarones y con el saldo de un pedido no cambia de forma: solo el dinero', async () => {
  const t = montar();
  const socio = (await t.pedir('/api/socios', { id: crypto.randomUUID(), nombre: 'Cliente', telefono: '4449990000', pin: '1234', acepta_bases: true, declara_mayor_edad: true })).cuerpo;
  assert.equal((await t.pedir('/api/portal/llegada', { cliente_id: socio.id })).status, 200);
  // Ticket de $1,000 con 50 D: $950 en dinero.
  const conD = await t.vender({ cliente_id: socio.id, dolarones: 5000, codigo_socio: await codigoPrueba(t.db, socio.id), efectivo: 95000, lineas: [{ producto_id: PRODUCTO, cantidad: 4 }] });
  assert.equal((await t.corregir(conD, 'tarjeta')).cuerpo.importe, 95000);
  assert.equal(t.venta(conD).efectivo, 0);
  assert.equal((await t.corregir(conD, 'efectivo')).status, 201);
  assert.equal(t.venta(conD).efectivo, 95000, 'a efectivo queda lo pagado en dinero, no el total');
  // Un saldo de pedido (anticipo) tampoco: se escribe directo, el pedido tiene su propia prueba.
  const conAnticipo = await t.vender({ lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 50000 });
  t.db.prepare('update ventas set anticipo = 20000 where id = ?').run(conAnticipo);
  const r = await t.corregir(conAnticipo, 'tarjeta');
  assert.equal(r.cuerpo.importe, 30000);
  assert.equal(t.rastros(conAnticipo)[0].importe, 30000);
  const c = await t.cortar({ tarjeta_terminal: 125000 });
  assert.equal(c.cuerpo.efectivo_ventas, 95000);
  assert.equal(c.cuerpo.tarjeta_sistema, 30000);
});

test('rechazos: cada caso con su mensaje y sin tocar nada', async () => {
  const t = montar();
  // Cancelada.
  const cancelada = await t.vender();
  assert.equal((await t.pedir(`/api/ventas/${cancelada}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' })).status, 200);
  let r = await t.corregir(cancelada, 'tarjeta');
  assert.deepEqual([r.status, r.cuerpo.error], [409, 'Este ticket está cancelado: no hay forma de pago que corregir.']);

  // Con devoluciones.
  const devuelta = await t.vender({ lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 50000 });
  const linea = (t.db.prepare('select id from venta_lineas where venta_id = ?').get(devuelta) as { id: number }).id;
  assert.equal((await t.pedir(`/api/ventas/${devuelta}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'defecto', caja: 'Caja 1' })).status, 201);
  r = await t.corregir(devuelta, 'tarjeta');
  assert.deepEqual([r.status, r.cuerpo.error], [409, 'Este ticket tiene piezas devueltas: su forma de pago ya no se puede corregir.']);

  // Transferencia desde $300: hace falta clave; se cobra de nuevo.
  const grande = await t.vender({ lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 50000 });
  r = await t.corregir(grande, 'transferencia');
  assert.deepEqual([r.status, r.cuerpo.error], [409, 'Desde $300.00 la transferencia necesita clave de rastreo: cancela la venta y vuelve a cobrarla por transferencia.']);
  assert.equal(t.venta(grande).forma_pago, 'efectivo');
  // ...pero de ahí a tarjeta sí se puede, y desde una transferencia de $300+ sin clave (venta vieja) no hay nada que bloquee a efectivo.
  assert.equal((await t.corregir(grande, 'tarjeta')).status, 201);

  // Transferencia con clave registrada: no se corrige aquí, ni a otra forma.
  const conClave = await t.vender({ forma_pago: 'transferencia', efectivo: 0, lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], ...datosTransferencia(50000) });
  r = await t.corregir(conClave, 'efectivo');
  assert.deepEqual([r.status, r.cuerpo.error], [409, 'Esta transferencia tiene clave de rastreo registrada: no se corrige aquí. Cancela la venta y vuelve a cobrarla.']);
  const conClaveChica = await t.vender({ forma_pago: 'transferencia', efectivo: 0, ...datosTransferencia(25000) });
  r = await t.corregir(conClaveChica, 'tarjeta');
  assert.equal(r.status, 409, 'una clave de rastreo guardada, aunque sea de menos de $300, tampoco se corrige aquí');
  assert.equal(t.venta(conClave).forma_pago, 'transferencia');

  // La misma forma.
  const igual = await t.vender();
  r = await t.corregir(igual, 'efectivo');
  assert.deepEqual([r.status, r.cuerpo.error], [409, 'Este ticket ya está cobrado con esa forma de pago.']);

  // Pagado completo con Dolarones (o saldo de pedido): no hay forma de pago que corregir.
  const gratis = await t.vender();
  t.db.prepare('update ventas set dolarones = total where id = ?').run(gratis);
  r = await t.corregir(gratis, 'tarjeta');
  assert.deepEqual([r.status, r.cuerpo.error], [409, 'Este ticket se pagó completo con Dolarones o con el saldo de un pedido: no tiene forma de pago que corregir.']);

  // Cobrada en el celular (impresión remota): nunca efectivo.
  const celular = await t.vender({ forma_pago: 'tarjeta', efectivo: 0 });
  t.db.prepare(`update ventas set imprimir_en = 'Caja 1' where id = ?`).run(celular);
  r = await t.corregir(celular, 'efectivo');
  assert.deepEqual([r.status, r.cuerpo.error], [409, 'Esta venta se cobró en el celular: solo puede ser tarjeta o transferencia.']);
  assert.equal((await t.corregir(celular, 'transferencia')).status, 201);

  // Entradas inválidas (400) y ticket inexistente (404).
  const buena = await t.vender();
  for (const [mal, mensaje] of [
    [{ motivo: '   ' }, 'Escribe el motivo de la corrección.'], [{ motivo: undefined }, 'Escribe el motivo de la corrección.'],
    [{ forma_pago: 'cheque' }, 'Forma de pago invalida.'], [{ id: 'no-es-uuid' }, 'Identificador invalido.'],
  ] as [Record<string, unknown>, string][]) {
    r = await t.corregir(buena, 'tarjeta', mal);
    assert.deepEqual([r.status, r.cuerpo.error], [400, mensaje], JSON.stringify(mal));
  }
  assert.equal((await t.pedir('/api/ventas/no-es-uuid/corregir-pago', { id: crypto.randomUUID(), forma_pago: 'tarjeta', motivo: 'x' })).status, 400);
  r = await t.corregir(crypto.randomUUID(), 'tarjeta');
  assert.deepEqual([r.status, r.cuerpo.error], [404, 'La venta no existe.']);
  r = await t.corregir(buena, 'tarjeta', { caja: 'Caja 99' });
  assert.deepEqual([r.status, r.cuerpo.error], [400, 'Esa caja no es de esta tienda.']);
  assert.equal(t.venta(buena).forma_pago, 'efectivo');
  // Solo quedaron los rastros de las correcciones que sí pasaron (grande, celular).
  assert.equal(t.rastros().length, 2);
});

test('un ticket de otra tienda no se corrige desde esta', async () => {
  const t = montar();
  const id = await t.vender();
  t.db.prepare(`update ventas set tienda = 'salk' where id = ?`).run(id);
  const r = await t.corregir(id, 'tarjeta');
  assert.equal(r.status, 403);
  assert.equal(r.cuerpo.error, 'Ese ticket es de otra tienda: corrígelo desde su tienda.');
  assert.equal(t.rastros().length, 0);
  assert.deepEqual((await t.pedir(`/api/ventas/${id}`)).cuerpo.corregible, []);
});

test('después del corte ya no: el mensaje lo dice, nada cambia y el corte conserva su cuenta', async () => {
  const t = montar();
  const id = await t.vender();
  const corte = (await t.cortar({ efectivo_contado: 75000, sin_efectivo: undefined })).cuerpo;
  assert.equal(corte.formas_corregidas, 0);
  const r = await t.corregir(id, 'tarjeta');
  assert.deepEqual([r.status, r.cuerpo.error], [409, AVISO_CORTE]);
  assert.equal(t.venta(id).forma_pago, 'efectivo');
  assert.equal(t.rastros().length, 0);
});

test('el mismo identificador es la misma corrección: reenviar no repite ni cambia nada; otro ticket con ese id, no', async () => {
  const t = montar();
  const id = await t.vender();
  const otro = await t.vender();
  const corrId = crypto.randomUUID();
  const primera = await t.corregir(id, 'tarjeta', { id: corrId });
  assert.equal(primera.status, 201);
  const revision = t.venta(id).revision;

  const repetida = await t.corregir(id, 'tarjeta', { id: corrId });
  assert.equal(repetida.status, 200);
  assert.deepEqual(repetida.cuerpo, { ...primera.cuerpo, duplicada: true });
  assert.equal(t.rastros().length, 1);
  assert.equal(t.venta(id).revision, revision);

  // Aunque el ticket ya entró a un corte, el reenvío de lo que sí se hizo responde igual (la caja sin red no se queda a medias).
  await t.cortar();
  assert.equal((await t.corregir(id, 'tarjeta', { id: corrId })).status, 200);

  const ajeno = await t.corregir(otro, 'tarjeta', { id: corrId });
  assert.deepEqual([ajeno.status, ajeno.cuerpo.error], [409, 'Ese identificador ya se usó en otra corrección.']);
  assert.equal(t.venta(otro).forma_pago, 'efectivo');
});

test('dos correcciones a la vez: gana una, la otra no deja el ticket mezclado y no deja rastro', async () => {
  const t = montar();
  for (const [a, b] of [['tarjeta', 'transferencia'], ['tarjeta', 'tarjeta']]) {
    const id = await t.vender();
    const antes = t.rastros().length;
    const [x, y] = await Promise.all([t.corregir(id, a), t.corregir(id, b)]);
    assert.deepEqual([x.status, y.status].sort(), [201, 409], `${a}/${b}: ${JSON.stringify([x.cuerpo, y.cuerpo])}`);
    const gana = x.status === 201 ? a : b;
    const pierde = x.status === 201 ? y : x;
    assert.match(pierde.cuerpo.error, /Alguien más cambió este ticket|ya está cobrado con esa forma de pago/);
    assert.equal(t.venta(id).forma_pago, gana);
    assert.equal(t.venta(id).revision, 1, 'solo una escritura');
    const nuevos = t.rastros(id);
    assert.equal(nuevos.length, 1);
    assert.equal(nuevos[0].forma_nueva, gana, 'el ticket y su rastro dicen lo mismo');
    assert.equal(t.rastros().length, antes + 1);
  }
});

test('un corte que entra entre la lectura y la escritura gana: la corrección no escribe nada (ni rastro)', async () => {
  const t = montar();
  const id = await t.vender();
  t.entreLecturaYBatch(() => t.cortar({ efectivo_contado: 75000, sin_efectivo: undefined }));
  const r = await t.corregir(id, 'tarjeta');
  assert.deepEqual([r.status, r.cuerpo.error], [409, AVISO_CORTE]);
  assert.equal(t.venta(id).forma_pago, 'efectivo');
  assert.equal(t.rastros().length, 0);
  // El corte contó el ticket como efectivo, tal como estaba.
  assert.equal((t.db.prepare('select efectivo_ventas as e from cortes').get() as { e: number }).e, 25000);
});

test('una devolución que entra entre la lectura y la escritura gana: la corrección no escribe nada', async () => {
  const t = montar();
  const id = await t.vender({ lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 50000 });
  const linea = (t.db.prepare('select id from venta_lineas where venta_id = ?').get(id) as { id: number }).id;
  t.entreLecturaYBatch(() => t.pedir(`/api/ventas/${id}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'defecto', caja: 'Caja 1' }));
  const r = await t.corregir(id, 'tarjeta');
  assert.deepEqual([r.status, r.cuerpo.error], [409, 'Este ticket tiene piezas devueltas: su forma de pago ya no se puede corregir.']);
  assert.equal(t.venta(id).forma_pago, 'efectivo');
  assert.equal(t.rastros().length, 0);
});

test('una devolución que ya leyó la forma anterior aborta si la corrección se adelanta: no resta del corte una forma equivocada', async () => {
  const t = montar();
  const id = await t.vender({ lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 50000 });
  const linea = (t.db.prepare('select id from venta_lineas where venta_id = ?').get(id) as { id: number }).id;
  let correccion: Awaited<ReturnType<typeof t.corregir>> | undefined;
  t.entreLecturaYBatch(async () => { correccion = await t.corregir(id, 'tarjeta'); });
  const r = await t.pedir(`/api/ventas/${id}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'defecto', caja: 'Caja 1' });
  assert.equal(correccion?.status, 201);
  assert.deepEqual([r.status, r.cuerpo.error], [409, 'Alguien mas cambio este ticket. Vuelve a abrirlo.']);
  assert.equal((t.db.prepare('select count(*) as n from devoluciones').get() as { n: number }).n, 0);
  assert.equal(t.venta(id).forma_pago, 'tarjeta');
});

test('el detalle del ticket dice a qué formas se puede corregir y trae las correcciones; después del corte, ninguna', async () => {
  const t = montar();
  const id = await t.vender();
  let d = (await t.pedir(`/api/ventas/${id}`)).cuerpo;
  assert.deepEqual(d.corregible, ['tarjeta', 'transferencia']);
  assert.deepEqual(d.correcciones, []);
  await t.corregir(id, 'tarjeta', { motivo: 'Era con tarjeta' });
  d = (await t.pedir(`/api/ventas/${id}`)).cuerpo;
  assert.deepEqual(d.corregible, ['efectivo', 'transferencia']);
  assert.equal(d.forma_pago, 'tarjeta');
  assert.deepEqual(d.correcciones.map((c: Record<string, string>) => [c.forma_anterior, c.forma_nueva, c.motivo, c.autor, c.caja]), [['efectivo', 'tarjeta', 'Era con tarjeta', DUENO, 'Caja 1']]);
  // Una venta de $500: a transferencia no (hace falta clave).
  const grande = await t.vender({ lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], efectivo: 50000 });
  assert.deepEqual((await t.pedir(`/api/ventas/${grande}`)).cuerpo.corregible, ['tarjeta']);
  await t.cortar();
  assert.deepEqual((await t.pedir(`/api/ventas/${id}`)).cuerpo.corregible, []);
  assert.equal((await t.pedir(`/api/ventas/${id}`)).cuerpo.correcciones.length, 1, 'el rastro se sigue viendo');
});

test('el corte repetido o reimpreso muestra el mismo número de formas corregidas', async () => {
  const t = montar();
  const a = await t.vender();
  const b = await t.vender();
  await t.corregir(a, 'tarjeta');
  await t.corregir(b, 'tarjeta');
  const corteId = crypto.randomUUID();
  const primero = await t.cortar({ id: corteId, efectivo_contado: 50000, sin_efectivo: undefined });
  assert.equal(primero.cuerpo.formas_corregidas, 2);
  assert.equal((await t.cortar({ id: corteId })).cuerpo.formas_corregidas, 2);        // reenvío del mismo corte
  assert.equal((await t.pedir('/api/cortes?caja=Caja%201')).cuerpo.formas_corregidas, 2);   // reimpresión del último
  // El siguiente corte no arrastra las anteriores.
  assert.equal((await t.cortar()).cuerpo.formas_corregidas, 0);
});

test('quién puede: cajero y dueño sí; quien solo captura, no; la computadora sin PIN de cajero, tampoco', async () => {
  const t = montar();
  const id = await t.vender();
  assert.deepEqual(permiso(`/api/ventas/${id}/corregir-pago`, 'POST'), permiso(`/api/ventas/${id}/cancelar`, 'POST'));
  t.como(CAPTURISTA);
  assert.equal((await t.corregir(id, 'tarjeta')).status, 403);
  t.como(PC);
  assert.equal((await t.corregir(id, 'tarjeta')).status, 401);
  assert.equal(t.rastros().length, 0);
  t.como(CAJERO);
  const r = await t.corregir(id, 'tarjeta');
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(t.rastros()[0].autor, CAJERO, 'el cajero sale de la sesión, no del cuerpo');
  assert.equal(t.rastros()[0].tienda, 'soledad');
  t.como(DUENO);
  assert.equal((await t.corregir(id, 'efectivo')).status, 201);
});

test('el cuerpo no decide quién ni dónde: un autor o una tienda mandados a mano se ignoran', async () => {
  const t = montar();
  const id = await t.vender();
  t.como(CAJERO);
  assert.equal((await t.corregir(id, 'tarjeta', { autor: DUENO, tienda: 'salk', cajero: DUENO })).status, 201);
  const [f] = t.rastros();
  assert.deepEqual([f.autor, f.tienda], [CAJERO, 'soledad']);
});

test('la ventana del ticket: botón solo si el servidor dice que se puede, rastro «antes X», formulario sin confirm() ni prompt()', async () => {
  const previo = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ textContent: '' }), head: { append() {} } } });
  try {
    const { pintarDetalle, formularioCorreccion } = await import('../public/ticket.js');
    const t = { id: crypto.randomUUID(), creado_en: new Date().toISOString(), forma_pago: 'efectivo', total: 25000, devuelto: 0, dolarones_devueltos: 0, cancelada: 0,
      lineas: [{ id: 1, nombre: 'Ventilador', codigo: 'ED-1', precio: 25000, cantidad: 1, cancelada_cantidad: 0 }], devoluciones: [] };
    const con = { ...t, corregible: ['tarjeta', 'transferencia'], correcciones: [] };
    assert.match(pintarDetalle(con, { editable: true }), /data-corregir-pago>Corregir forma de pago<[\s\S]*id="form-pago" hidden/);
    // Sin lo que el servidor manda (ticket viejo, reportes, ya en corte, cancelado) no hay botón.
    for (const sin of [t, { ...con, corregible: [] }, { ...con, cancelada: 1 }]) assert.doesNotMatch(pintarDetalle(sin, { editable: true }), /Corregir forma de pago/);
    assert.doesNotMatch(pintarDetalle(con), /Corregir forma de pago/);   // reportes: solo consulta
    // El rastro se ve aunque ya no se pueda corregir; el motivo y el autor se escapan.
    const corregida = pintarDetalle({ ...t, forma_pago: 'tarjeta', corregible: [], correcciones: [
      { forma_anterior: 'efectivo', forma_nueva: 'tarjeta', motivo: '<b>era</b> tarjeta', autor: 'caja@prueba.mx', caja: 'Caja 1', creado_en: new Date().toISOString() }] }, { editable: true });
    assert.match(corregida, /Forma de pago corregida: antes Efectivo/);
    assert.match(corregida, /&lt;b&gt;era&lt;\/b&gt; tarjeta/);
    assert.doesNotMatch(corregida, /Corregir forma de pago/);
    const form = formularioCorreccion(['efectivo', 'transferencia']);
    assert.match(form, /<option value="efectivo">Efectivo<\/option>\s*<option value="transferencia">Transferencia<\/option>/);
    assert.doesNotMatch(form, /tarjeta/);
    assert.match(form, /data-confirmar-pago/);
    assert.match(form, /data-volver/);
  } finally {
    if (previo) Object.defineProperty(globalThis, 'document', previo);
    else delete (globalThis as any).document;
  }
});

test('caja.html: la corrección manda el id de la caja, la caja y el motivo; refresca ticket, «Ventas de hoy» y el corte; no abre el cajón ni usa confirm()', () => {
  const caja = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
  const inicio = caja.indexOf('if (d.corregirPago !== undefined)');
  const fin = caja.indexOf('if (d.imprimirDevolucion !== undefined', inicio);
  assert.ok(inicio > 0 && fin > inicio);
  const bloque = caja.slice(inicio, fin);
  assert.match(bloque, /\/corregir-pago/);
  assert.match(bloque, /body: JSON\.stringify\(\{ id: idCorreccion, forma_pago: campoForma\.value, motivo, caja: cajaActual\(\) \}\)/);
  assert.match(bloque, /await abrirTicket\(ticketId\)/);
  assert.match(bloque, /await actualizarCorte\(\)/);
  assert.doesNotMatch(bloque, /abrirCajon|confirm\(|prompt\(/);
  // El foco vuelve al código al cerrar la ventana (ya lo hacía) y el id de la corrección se suelta con ella.
  assert.match(caja, /ticketAbierto = null; idCancelacion = null; idCorreccion = null;[^}]*\$\('codigo'\)\)\.focus\(\)/);
  // El resumen del corte trae el renglón solo cuando hubo correcciones.
  assert.match(caja, /\$\{c\.formas_corregidas \? renglon\('Formas de pago corregidas', c\.formas_corregidas\) : ''\}/);
});
