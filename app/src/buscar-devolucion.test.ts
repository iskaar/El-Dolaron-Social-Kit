// node --test src/buscar-devolucion.test.ts
// Caja: buscar la venta de una devolucion por pieza escaneada, nombre o folio (Issue #764).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';

const OTRO = 'b2222222-2222-4222-8222-222222222222';

function montar() {
  const t = tienda();
  // Ventilador ED-000001 (PRODUCTO) con UPC; una segunda pieza con otro nombre y UPC con ceros iniciales.
  t.db.prepare(`update productos set upc = '12345678905' where id = ?`).run(PRODUCTO);
  t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en, upc)
    values (?, 'ED-000002', 'Lampara de mesa', 12000, 50, 'S40', '', '', '000987654321')`).run(OTRO);
  const vender = async (producto: string, creado_en: string) => {
    const id = crypto.randomUUID();
    const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: producto, cantidad: 1 }],
      forma_pago: 'efectivo', efectivo: 50000, caja: 'Caja 1', creado_en });
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    return id;
  };
  const buscar = (q: string) => t.pedir(`/api/ventas?buscar=${encodeURIComponent(q)}`);
  const haceDias = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  return { ...t, vender, buscar, haceDias };
}

test('la pieza escaneada encuentra su venta de otro dia: etiqueta, numero suelto y UPC (con o sin ceros)', async () => {
  const { vender, buscar, haceDias, db } = montar();
  const ayer = await vender(PRODUCTO, haceDias(1));
  const lampara = await vender(OTRO, haceDias(2));
  const linea = (db.prepare('select id from venta_lineas where venta_id = ?').get(ayer) as { id: number }).id;

  for (const leido of ['ED-000001', 'ed-1', '001', '12345678905', '012345678905']) {
    const r = await buscar(leido);
    assert.equal(r.status, 200, leido);
    const filas = r.cuerpo as unknown as { id: string; lineas: string }[];
    assert.deepEqual(filas.map((f) => f.id), [ayer], leido);
    assert.equal(filas[0].lineas, String(linea), leido);
  }
  // El UPC guardado con ceros se encuentra con o sin ellos.
  assert.deepEqual(((await buscar('987654321')).cuerpo as unknown as { id: string }[]).map((f) => f.id), [lampara]);
  assert.deepEqual(((await buscar('000987654321')).cuerpo as unknown as { id: string }[]).map((f) => f.id), [lampara]);
});

test('la misma pieza en varios tickets: el mas reciente primero, con las mismas columnas que la lista', async () => {
  const { vender, buscar, haceDias, pedir } = montar();
  const vieja = await vender(PRODUCTO, haceDias(30));
  const reciente = await vender(PRODUCTO, new Date(Date.now() - 60_000).toISOString());   // hoy: tambien sale en la lista del dia
  const filas = (await buscar('ED-000001')).cuerpo as unknown as Record<string, unknown>[];
  assert.deepEqual(filas.map((f) => f.id), [reciente, vieja]);
  const lista = (await pedir('/api/ventas?lista=1')).cuerpo as unknown as Record<string, unknown>[];
  assert.equal(lista.length, 1);
  assert.deepEqual(Object.keys(filas[0]).filter((k) => k !== 'lineas'), Object.keys(lista[0]));
  assert.deepEqual({ ...filas[0], lineas: undefined }, { ...lista[0], lineas: undefined });
});

test('por nombre (palabras, sin importar mayusculas) y por el inicio del folio', async () => {
  const { vender, buscar, haceDias } = montar();
  const ventilador = await vender(PRODUCTO, haceDias(5));
  const lampara = await vender(OTRO, haceDias(4));

  assert.deepEqual(((await buscar('VENTIL')).cuerpo as unknown as { id: string }[]).map((f) => f.id), [ventilador]);
  assert.deepEqual(((await buscar('lampara mesa')).cuerpo as unknown as { id: string }[]).map((f) => f.id), [lampara]);
  assert.deepEqual((await buscar('lampara ventilador')).cuerpo, []);   // todas las palabras

  const porFolio = (await buscar(ventilador.slice(0, 8))).cuerpo as unknown as { id: string; lineas: string | null }[];
  assert.deepEqual(porFolio.map((f) => f.id), [ventilador]);
  assert.equal(porFolio[0].lineas, null);   // el folio no resalta ninguna pieza
  assert.deepEqual(((await buscar(lampara)).cuerpo as unknown as { id: string }[]).map((f) => f.id), [lampara]);
});

test('solo los ultimos 90 dias y a lo mas 30 tickets', async () => {
  const { vender, buscar, haceDias, db } = montar();
  const vieja = await vender(PRODUCTO, haceDias(91));
  const limite = await vender(PRODUCTO, haceDias(89));
  assert.deepEqual(((await buscar('ED-000001')).cuerpo as unknown as { id: string }[]).map((f) => f.id), [limite]);
  assert.ok(vieja);

  // Un numero suelto no busca por nombre: «119» no trae lo que dice «119» en su descripcion.
  db.prepare(`update venta_lineas set nombre = 'Banda 119'`).run();
  assert.deepEqual((await buscar('119')).cuerpo, []);
  assert.equal(((await buscar("banda 119")).cuerpo as unknown as unknown[]).length, 1);

  const ventas = db.prepare('select * from ventas where id = ?').get(limite) as Record<string, unknown>;
  const lin = db.prepare('select * from venta_lineas where venta_id = ?').get(limite) as Record<string, unknown>;
  for (let i = 0; i < 35; i++) {
    const id = crypto.randomUUID();
    db.prepare(`insert into ventas (id, total, forma_pago, efectivo, cambio, creado_en, registrado_en, dolarones, caja, cajero, pedido_hash)
      values (?, ?, 'efectivo', ?, 0, ?, ?, 0, 'Caja 1', 'x', ?)`)
      .run(id, ventas.total, ventas.efectivo, haceDias(1), haceDias(1), `h${i}`);
    db.prepare(`insert into venta_lineas (venta_id, producto_id, codigo, nombre, precio, cantidad, propietario) values (?, ?, ?, ?, ?, 1, 'dolaron')`)
      .run(id, lin.producto_id, lin.codigo, lin.nombre, lin.precio);
  }
  assert.equal(((await buscar('ED-000001')).cuerpo as unknown as unknown[]).length, 30);
});

test('texto vacio o corto: 400 con mensaje; la entrada nunca se concatena en el SQL', async () => {
  const { buscar } = montar();
  for (const q of ['', '  ', 'ab', '12']) {
    const r = await buscar(q);
    assert.equal(r.status, 400, JSON.stringify(q));
    assert.match(String(r.cuerpo.error), /al menos 3/);
  }
  assert.equal((await buscar('x'.repeat(81))).status, 400);
  const r = await buscar(`'); drop table ventas; --`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.cuerpo, []);
});
