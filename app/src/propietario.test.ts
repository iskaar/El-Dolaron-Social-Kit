// node --test src/propietario.test.ts
// Inventario separado (Issue #298): lo de FEP se cobra en la caja de la tienda, pero
// los reportes solo muestran lo de El Dolaron y el corte le debe a FEP lo suyo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { verificarCuadre } from '../public/graficas.js';

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

test('un ticket mixto reparte el cobro por pieza: formas de pago y cuadre solo de la tienda', async () => {
  const { db, pedir } = tienda();
  db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en, propietario)
              values (?, 'ED-000002', 'Bolsa FEP', 30000, 10, 'S41', '', '', 'fep')`).run(FEP);
  // Un ticket de $550 con $250 de la tienda y $300 de FEP, pagado en tarjeta.
  await pedir('/api/ventas', { id: crypto.randomUUID(), caja: 'Caja 1', forma_pago: 'tarjeta', efectivo: 0,
    lineas: [{ producto_id: PRODUCTO, cantidad: 1 }, { producto_id: FEP, cantidad: 1 }] });
  // Y uno de $250 solo de la tienda, en efectivo.
  await pedir('/api/ventas', { id: crypto.randomUUID(), caja: 'Caja 1', forma_pago: 'efectivo', efectivo: 25000,
    lineas: [{ producto_id: PRODUCTO, cantidad: 1 }] });

  const r = (await pedir('/api/reportes?dias=7')).cuerpo;
  const porForma = Object.fromEntries(r.por_forma_pago.map((f: { forma_pago: string; total: number }) => [f.forma_pago, f.total]));
  assert.equal(r.resumen.total, 50000);
  assert.equal(porForma.tarjeta, 25000, 'la tarjeta cuenta solo la parte de la tienda');
  assert.equal(porForma.efectivo, 25000);
  assert.deepEqual(verificarCuadre(r).filter((c) => !c.ok), [], 'todas las revisiones del reporte cuadran');
});
