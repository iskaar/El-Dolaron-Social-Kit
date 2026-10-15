// node --test src/indice-productos.test.ts
// La cola de captura e impresion filtra por propietario y creado_en (Issue #308).
// El indice tiene que usarse; si no, cada consulta lee toda la tabla productos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';

test('la cola de borradores usa el indice propietario + creado_en', () => {
  const { db } = tienda();
  const plan = db.prepare(
    `explain query plan select id from productos
     where sin_inventario = 0 and propietario = ? and estado_analisis <> 'descartado' and creado_en >= ?
     order by creado_en asc limit 2000`,
  ).all('dolaron', '2026-10-01T00:00:00Z') as { detail: string }[];
  assert.ok(plan.some((f) => f.detail.includes('productos_propietario_creado')), JSON.stringify(plan));
});
