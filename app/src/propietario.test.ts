// node --test src/propietario.test.ts
// Inventario separado (Issue #298): lo de FEP se cobra en la caja de la tienda, pero
// los reportes solo muestran lo de El Dolaron y el corte le debe a FEP lo suyo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';

const FEP = 'b2222222-2222-4222-8222-222222222222';

test('una pieza de FEP se cobra en la caja, no sale en los reportes de la tienda y el corte se la debe', async () => {
  const { db, pedir } = tienda();
  db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en, propietario)
              values (?, 'ED-000002', 'Bolsa FEP', 30000, 10, 'S41', '', '', 'fep')`).run(FEP);

  const tiendaVenta = { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1' };
  const fepVenta = { id: crypto.randomUUID(), lineas: [{ producto_id: FEP, cantidad: 2 }], forma_pago: 'efectivo', efectivo: 60000, caja: 'Caja 1' };
  assert.equal((await pedir('/api/ventas', tiendaVenta)).status, 201);
  assert.equal((await pedir('/api/ventas', fepVenta)).status, 201);

  const reporte = (await pedir('/api/reportes?dias=7')).cuerpo.resumen;
  assert.equal(reporte.total, 25000, 'el reporte de la tienda no cuenta lo de FEP');
  assert.equal(reporte.piezas, 1);

  const corte = (await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 0, tarjeta_terminal: 0 })).cuerpo;
  assert.equal(corte.fep_por_pagar, 60000, 'FEP recibe lo que se cobro de sus piezas');
  assert.equal(corte.efectivo_ventas, 85000, 'el cajon cuenta todo el efectivo, el de FEP tambien');
});
