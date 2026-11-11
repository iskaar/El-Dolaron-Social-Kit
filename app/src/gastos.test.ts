import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DUENO, tienda } from './prueba-d1.ts';
import worker from './worker.ts';

test('gastos fuera y de caja: el corte descuenta caja y el mes une ambos sin duplicar', async () => {
  const t = tienda();
  const fecha = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const mes = fecha.slice(0, 7);
  const fuera = await t.pedir('/api/gastos', {
    fecha, categoria: 'renta', importe: 120000, nota: 'Renta mensual', origen: 'fuera',
  });
  assert.equal(fuera.status, 201);
  const caja = await t.pedir('/api/gastos', {
    fecha, categoria: 'limpieza', importe: 2500, nota: 'Jabón', origen: 'caja', caja: 'Caja 2',
  });
  assert.equal(caja.status, 201);
  assert.ok(caja.cuerpo.retiro_id);
  const antiguo = crypto.randomUUID();
  t.db.prepare(`insert into retiros (id, tipo, caja, cajero, importe, motivo, creado_en)
    values (?, 'gasto', 'Caja 2', ?, 100, 'Gasto viejo', ?)`)
    .run(antiguo, DUENO, `${fecha}T12:00:00-06:00`);
  assert.deepEqual({ tipo: t.db.prepare('select tipo from retiros where id = ?').get(caja.cuerpo.retiro_id)?.tipo,
    categoria: t.db.prepare('select categoria from retiros where id = ?').get(caja.cuerpo.retiro_id)?.categoria },
  { tipo: 'gasto', categoria: 'limpieza' });

  const corte = await t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 2', efectivo_contado: 47400 });
  assert.equal(corte.status, 201, JSON.stringify(corte.cuerpo));
  assert.equal(corte.cuerpo.gastos, 2600);
  const lista = await t.pedir(`/api/gastos?mes=${mes}`, undefined, 'GET');
  assert.equal(lista.status, 200);
  assert.equal(lista.cuerpo.gastos.filter((g: { retiro_id: string | null }) => g.retiro_id === caja.cuerpo.retiro_id).length, 1);
  assert.equal(lista.cuerpo.gastos.length, 3);
  assert.equal(lista.cuerpo.gastos.find((g: { id: string }) => g.id === antiguo).categoria, 'sin_categoria');
  assert.equal(lista.cuerpo.total, 122600);
  assert.deepEqual(Object.fromEntries(lista.cuerpo.por_categoria.map((g: { categoria: string; importe: number }) => [g.categoria, g.importe])),
    { limpieza: 2500, renta: 120000, sin_categoria: 100 });

  const borrado = await t.pedir(`/api/gastos/${fuera.cuerpo.id}`, {}, 'DELETE');
  assert.equal(borrado.status, 200);
  assert.equal((await t.pedir(`/api/gastos/${caja.cuerpo.id}`, {}, 'DELETE')).status, 400);
});

test('categoría inválida, permisos de dueño y categoría obligatoria en caja', async () => {
  const t = tienda();
  assert.equal((await t.pedir('/api/gastos', {
    fecha: '2026-10-15', categoria: 'inventada', importe: 500, origen: 'fuera',
  })).status, 400);
  assert.equal((await t.pedir('/api/retiros', {
    id: crypto.randomUUID(), tipo: 'gasto', caja: 'Caja 1', importe: 500, motivo: 'Sin categoría',
  })).status, 400);
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en)
    values ('cajero@prueba.mx', 'Cajero', 'cajero', 1, '', '', '')`).run();
  t.env.DEV_USUARIO = 'cajero@prueba.mx';
  assert.equal((await t.pedir('/api/gastos?mes=2026-10', undefined, 'GET')).status, 403);
  const caja = readFileSync('public/caja.html', 'utf8');
  assert.match(caja, /tipo === 'gasto' && !categoria/);
  assert.match(caja, /retiro-categoria/);
});

test('reintentar el mismo gasto de caja no lo duplica ni duplica su retiro', async () => {
  const t = tienda();
  const fecha = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const cuerpo = { id: crypto.randomUUID(), fecha, categoria: 'luz', importe: 50000, nota: 'CFE', origen: 'caja', caja: 'Caja 1' };
  assert.equal((await t.pedir('/api/gastos', cuerpo)).status, 201);
  assert.equal((await t.pedir('/api/gastos', cuerpo)).status, 201);
  assert.equal(t.db.prepare('select count(*) n from gastos').get()!.n, 1);
  assert.equal(t.db.prepare(`select count(*) n from retiros where tipo = 'gasto'`).get()!.n, 1);
});

test('pagos a inversionistas (#768): salen en /api/gastos, no cuentan en /api/tablero y la caja no los registra', async () => {
  const t = tienda();
  const fecha = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const mes = fecha.slice(0, 7);
  const antes = (await t.pedir('/api/tablero', undefined, 'GET')).cuerpo;
  assert.equal((await t.pedir('/api/gastos', { fecha, categoria: 'luz', importe: 3000, origen: 'fuera' })).status, 201);
  const reparto = await t.pedir('/api/gastos', { fecha, categoria: 'inversionistas', importe: 50000, nota: 'Pago de prueba', origen: 'fuera' });
  assert.equal(reparto.status, 201);
  const desdeCajon = await t.pedir('/api/gastos', { fecha, categoria: 'inversionistas', importe: 7000, origen: 'caja', caja: 'Caja 1' });
  assert.equal(desdeCajon.status, 201);

  const lista = (await t.pedir(`/api/gastos?mes=${mes}`, undefined, 'GET')).cuerpo;
  assert.equal(lista.gastos.filter((g: { categoria: string }) => g.categoria === 'inversionistas').length, 2);
  assert.equal(lista.por_categoria.find((x: { categoria: string }) => x.categoria === 'inversionistas').importe, 57000);

  const despues = (await t.pedir('/api/tablero', undefined, 'GET')).cuerpo;
  assert.equal(despues.gastos.total, antes.gastos.total + 3000);
  assert.equal(despues.ventas_menos_gastos, antes.ventas_menos_gastos - 3000);
  assert.ok(!despues.gastos.por_categoria.some((x: { categoria: string }) => x.categoria === 'inversionistas'));

  assert.equal((await t.pedir('/api/retiros', {
    id: crypto.randomUUID(), tipo: 'gasto', caja: 'Caja 1', importe: 500, motivo: 'Reparto', categoria: 'inversionistas',
  })).status, 400);
  t.db.close();
});

test('comprobante del gasto (#770): subir, ver, reemplazar, rechazar tipo y tamaño, borrar y permisos', async () => {
  const t = tienda();
  const fecha = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const gasto = await t.pedir('/api/gastos', { fecha, categoria: 'renta', importe: 1000, origen: 'fuera' });
  const ruta = `/api/gastos/${gasto.cuerpo.id}/comprobante`;
  const objetos = (t.env.FOTOS as unknown as { objetos: Map<string, ArrayBuffer> }).objetos;
  const subir = (tipo: string, datos: BodyInit, destino = ruta) =>
    worker.fetch!(new Request(`https://caja.prueba${destino}`, { method: 'PUT', headers: { 'content-type': tipo }, body: datos }) as never, t.env, t.ctx as never);
  const llaveActual = () => t.db.prepare('select comprobante_key k from gastos where id = ?').get(gasto.cuerpo.id)!.k as string;
  const fila = async () => (await t.pedir(`/api/gastos?mes=${fecha.slice(0, 7)}`, undefined, 'GET')).cuerpo.gastos[0];

  assert.equal((await t.enviar(ruta)).status, 404);   // todavia sin comprobante
  assert.equal((await fila()).con_comprobante, false);
  assert.equal((await subir('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).status, 200);
  const llave = llaveActual();
  assert.match(llave, new RegExp(`^gastos/${gasto.cuerpo.id}/[0-9a-f-]{36}\\.jpg$`));
  assert.equal((await fila()).con_comprobante, true);
  assert.ok(!Object.values(await fila()).includes(llave), 'la API no devuelve la llave');

  const ver = await t.enviar(ruta);
  assert.equal(ver.status, 200);
  assert.equal(ver.headers.get('content-type'), 'image/jpeg');
  assert.equal(ver.headers.get('cache-control'), 'no-store');
  assert.equal(ver.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ver.headers.get('content-security-policy'), 'sandbox');
  assert.equal(ver.headers.get('content-disposition'), 'inline');

  assert.equal((await subir('text/xml; charset=utf-8', '<cfdi/>')).status, 200);
  assert.ok(!objetos.has(llave), 'el objeto anterior se borra');
  const llaveXml = llaveActual();
  assert.match(llaveXml, /\.xml$/);
  assert.equal((await t.enviar(ruta)).headers.get('content-disposition'), 'attachment');

  assert.equal((await subir('image/svg+xml', '<svg/>')).status, 415);
  assert.equal((await subir('text/html', '<html/>')).status, 415);
  assert.equal((await subir('application/pdf', new Uint8Array(0))).status, 413);
  assert.equal((await subir('application/pdf', new Uint8Array(10 * 1024 * 1024 + 1))).status, 413);
  assert.equal(llaveActual(), llaveXml);
  assert.equal(objetos.size, 1);
  assert.equal((await subir('application/pdf', '%PDF-1', `/api/gastos/${crypto.randomUUID()}/comprobante`)).status, 404);
  assert.equal((await subir('application/pdf', '%PDF-1', '/api/gastos/no-es-uuid/comprobante')).status, 400);

  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en)
    values ('cajero@prueba.mx', 'Cajero', 'cajero', 1, '', '', '')`).run();
  t.env.DEV_USUARIO = 'cajero@prueba.mx';
  assert.equal((await t.enviar(ruta)).status, 403);
  assert.equal((await subir('application/pdf', '%PDF-1')).status, 403);
  t.env.DEV_USUARIO = DUENO;

  assert.equal((await t.pedir(`/api/gastos/${gasto.cuerpo.id}`, {}, 'DELETE')).status, 200);
  assert.equal(objetos.size, 0, 'borrar el gasto borra su comprobante');
  t.db.close();
});
