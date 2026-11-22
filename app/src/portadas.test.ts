import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';

test('migración 087: portada_estado existe y rechaza un valor fuera del check', () => {
  const t = tienda();
  try {
    assert.equal(t.db.prepare("select count(*) n from pragma_table_info('productos') where name in ('portada_estado','portada_origen','portada_fecha','portada_revision')").get()?.n, 4);
    t.db.prepare("update productos set portada_estado='lista', portada_origen='ia'").run();
    assert.throws(() => t.db.prepare("update productos set portada_estado='inventado'").run(), /CHECK/);
    assert.throws(() => t.db.prepare("update productos set portada_origen='otro'").run(), /CHECK/);
  } finally { t.db.close(); }
});
