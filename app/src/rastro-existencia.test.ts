// node --test src/rastro-existencia.test.ts
// #480: toda existencia que desaparece o se mueve deja renglón en conteo_ajustes (fusionar, descartar, miniatura, cancelar captura).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';

type T = ReturnType<typeof tienda>;
function pieza(t: T, { codigo = null as string | null, stock = 3, estado = 'listo', upc = null as string | null } = {}) {
  const id = crypto.randomUUID();
  t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, estado_analisis, foto_key, upc,
    semana_ingreso, creado_en, actualizado_en, capturado_por) values (?, ?, 'Camisa', 35000, ?, ?, ?, ?, 'S43', ?, '', ?)`)
    .run(id, codigo, stock, estado, `fotos/${id}.jpg`, upc, new Date().toISOString(), DUENO);
  return id;
}
const rastros = (t: T, id: string) => t.db.prepare('select motivo, cantidad, antes, despues, codigo, nombre, ajustado_por from conteo_ajustes where producto_id = ? order by rowid')
  .all(id).map((r) => ({ ...r }));
const total = (t: T) => (t.db.prepare('select count(*) n from conteo_ajustes').get() as { n: number }).n;
const stockDe = (t: T, id: string) => (t.db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock;
const venderla = (t: T, id: string) => {
  t.db.prepare("insert into ventas (id, total, forma_pago, efectivo, cambio, creado_en, registrado_en) values ('v1', 100, 'efectivo', 100, 0, '', '')").run();
  t.db.prepare("insert into venta_lineas (venta_id, producto_id, codigo, nombre, precio, cantidad) values ('v1', ?, '', 'x', 100, 1)").run(id);
};

test('D1 (#480): fusionar deja dos renglones (origen −stock, destino +stock) y borra el origen', async () => {
  const t = tienda();
  try {
    const origen = pieza(t, { stock: 3 });
    const r = await t.pedir(`/api/borradores/${origen}/fusionar`, { destino_id: PRODUCTO });
    assert.equal(r.status, 200); assert.equal(r.cuerpo.stock, 53);
    assert.equal(t.db.prepare('select 1 from productos where id = ?').get(origen), undefined);
    assert.deepEqual(rastros(t, origen), [{ motivo: 'fusion', cantidad: 3, antes: 3, despues: 0, codigo: '', nombre: 'Camisa', ajustado_por: DUENO }]);
    assert.deepEqual(rastros(t, PRODUCTO), [{ motivo: 'fusion', cantidad: 3, antes: 50, despues: 53, codigo: 'ED-000001', nombre: 'Ventilador', ajustado_por: DUENO }]);
    assert.equal(total(t), 2);
  } finally { t.db.close(); }
});

test('D1 (#480): fusionar conserva en los renglones el código del origen que pasa al destino', async () => {
  const t = tienda();
  try {
    t.db.prepare('update productos set codigo = null where id = ?').run(PRODUCTO);
    const origen = pieza(t, { codigo: 'ED-002400', stock: 2 });
    assert.equal((await t.pedir(`/api/borradores/${origen}/fusionar`, { destino_id: PRODUCTO })).status, 200);
    assert.equal(rastros(t, origen)[0].codigo, 'ED-002400');
    assert.equal(rastros(t, PRODUCTO)[0].codigo, 'ED-002400');
  } finally { t.db.close(); }
});

test('D1 (#480): una fusión rechazada (venta del origen) no deja renglones; con stock 0 tampoco', async () => {
  const t = tienda();
  try {
    const vendida = pieza(t, { stock: 3 });
    venderla(t, vendida);
    const r = await t.pedir(`/api/borradores/${vendida}/fusionar`, { destino_id: PRODUCTO });
    assert.equal(r.status, 409);
    assert.equal(total(t), 0);
    assert.equal(stockDe(t, PRODUCTO), 50);
    const vacia = pieza(t, { stock: 0 });
    assert.equal((await t.pedir(`/api/borradores/${vacia}/fusionar`, { destino_id: PRODUCTO })).status, 200);
    assert.equal(total(t), 0);
  } finally { t.db.close(); }
});

test('D1 (#480): descartar sin código borra la fila y deja un renglón; con código la deja en cero y deja un renglón', async () => {
  const t = tienda();
  try {
    const sinCodigo = pieza(t, { stock: 4 }), conCodigo = pieza(t, { codigo: 'ED-002401', stock: 5 });
    assert.equal((await t.pedir(`/api/borradores/${sinCodigo}`, {}, 'DELETE')).status, 200);
    assert.equal(t.db.prepare('select 1 from productos where id = ?').get(sinCodigo), undefined);
    assert.deepEqual(rastros(t, sinCodigo), [{ motivo: 'descarte', cantidad: 4, antes: 4, despues: 0, codigo: '', nombre: 'Camisa', ajustado_por: DUENO }]);
    assert.equal((await t.pedir(`/api/borradores/${conCodigo}`, {}, 'DELETE')).status, 200);
    assert.equal(stockDe(t, conCodigo), 0);
    assert.deepEqual(rastros(t, conCodigo), [{ motivo: 'descarte', cantidad: 5, antes: 5, despues: 0, codigo: 'ED-002401', nombre: 'Camisa', ajustado_por: DUENO }]);
    // Repetir no suma otro renglón.
    assert.equal((await t.pedir(`/api/borradores/${conCodigo}`, {}, 'DELETE')).status, 200);
    assert.equal(total(t), 2);
  } finally { t.db.close(); }
});

test('D1 (#480): descartar sin existencia o rechazado (venta) no deja renglón', async () => {
  const t = tienda();
  try {
    const vacia = pieza(t, { stock: 0 }), vendida = pieza(t, { stock: 2 }), conCodigo = pieza(t, { codigo: 'ED-002402', stock: 0 });
    venderla(t, vendida);
    assert.equal((await t.pedir(`/api/borradores/${vacia}`, {}, 'DELETE')).status, 200);
    assert.equal((await t.pedir(`/api/borradores/${conCodigo}`, {}, 'DELETE')).status, 200);
    assert.equal((await t.pedir(`/api/borradores/${vendida}`, {}, 'DELETE')).status, 409);
    assert.equal(total(t), 0);
    assert.equal(stockDe(t, vendida), 2);
  } finally { t.db.close(); }
});

test('D1 (#480): eliminar desde la miniatura deja un renglón solo si la baja ocurre', async () => {
  const t = tienda();
  try {
    const id = pieza(t, { stock: 6 }), vendida = pieza(t, { stock: 2 }), vacia = pieza(t, { stock: 0 });
    venderla(t, vendida);
    assert.equal((await t.pedir(`/api/borradores/${vendida}/revision`, {}, 'DELETE')).status, 409);
    assert.equal((await t.pedir(`/api/borradores/${vacia}/revision`, {}, 'DELETE')).status, 200);
    assert.equal(total(t), 0);
    assert.equal((await t.pedir(`/api/borradores/${id}/revision`, {}, 'DELETE')).status, 200);
    assert.deepEqual(rastros(t, id), [{ motivo: 'descarte', cantidad: 6, antes: 6, despues: 0, codigo: '', nombre: 'Camisa', ajustado_por: DUENO }]);
    assert.equal((await t.pedir(`/api/borradores/${id}/revision`, {}, 'DELETE')).status, 200);   // reintento
    assert.equal(total(t), 1);
  } finally { t.db.close(); }
});

test('D1 (#480): cancelar una captura (existencia 0) deja un renglón; si ya está lista con etiqueta se rechaza sin renglón', async () => {
  const t = tienda();
  try {
    const id = pieza(t, { stock: 4, estado: 'pendiente', upc: '0191907910414' });
    const lista = pieza(t, { stock: 4, estado: 'listo', upc: '0191907910415' });
    assert.equal((await t.pedir(`/api/borradores/${lista}/existencia`, { stock: 0 }, 'PATCH')).status, 404);
    assert.equal(total(t), 0);
    const r = await t.pedir(`/api/borradores/${id}/existencia`, { stock: 0 }, 'PATCH');
    assert.equal(r.status, 200); assert.equal(r.cuerpo.descartado, true);
    assert.deepEqual(rastros(t, id), [{ motivo: 'descarte', cantidad: 4, antes: 4, despues: 0, codigo: '', nombre: 'Camisa', ajustado_por: DUENO }]);
    assert.equal((await t.pedir(`/api/borradores/${id}/existencia`, { stock: 0 }, 'PATCH')).status, 404);   // ya descartada
    assert.equal(total(t), 1);
  } finally { t.db.close(); }
});
