// node --test src/propietario.test.ts
// Inventario separado (Issue #298): lo de FEP se cobra en la caja de la tienda, pero
// los reportes solo muestran lo de El Dolaron y el corte le debe a FEP lo suyo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { verificarCuadre } from '../public/graficas.js';
import { codigoPrueba } from './prueba-d1.ts';

const FEP = 'b2222222-2222-4222-8222-222222222222';

test('finanzas no modifica piezas de la tienda y puede corregir las suyas', async () => {
  const { db, env, pedir, esperar } = tienda();
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en)
              values ('fep@prueba.mx', 'FEP', 'finanzas', 1, '', '')`).run();
  db.prepare(`insert into productos (id, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en, propietario)
              values (?, 'Bolsa FEP', 30000, 2, 'S41', '', '', 'fep')`).run(FEP);
  env.DEV_USUARIO = 'fep@prueba.mx';

  const piezaTienda = db.prepare('select nombre, stock, estado_analisis, propietario from productos where id = ?').get(PRODUCTO);
  const ruta = `/api/borradores/${PRODUCTO}`;
  for (const [url, cuerpo, metodo] of [
    [ruta, { nombre: 'Cambiado' }, 'PATCH'],
    [ruta, {}, 'DELETE'],
    [`${ruta}/fusionar`, { destino_id: FEP }, 'POST'],
    [`${ruta}/analizar`, {}, 'POST'],
    [`/api/borradores/${FEP}/fusionar`, { destino_id: PRODUCTO }, 'POST'],
  ] as const) {
    const respuesta = await pedir(url, cuerpo, metodo);
    assert.equal(respuesta.status, 404, `${metodo} ${url}`);
    assert.deepEqual(respuesta.cuerpo, { error: 'Pieza no encontrada.' });
  }
  await esperar();
  assert.deepEqual(db.prepare('select nombre, stock, estado_analisis, propietario from productos where id = ?').get(PRODUCTO), piezaTienda);
  assert.equal((db.prepare('select stock from productos where id = ?').get(FEP) as { stock: number }).stock, 2);

  assert.equal((await pedir(`/api/borradores/${FEP}`, { nombre: 'Bolsa corregida' }, 'PATCH')).status, 200);
  assert.equal((db.prepare('select nombre from productos where id = ?').get(FEP) as { nombre: string }).nombre, 'Bolsa corregida');
});

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

test('lo pagado con Dolarones en una pieza de FEP se descuenta de lo que se le debe', async () => {
  const { db, pedir } = tienda();
  db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en, propietario)
              values (?, 'ED-000002', 'Bolsa FEP', 30000, 10, 'S41', '', '', 'fep')`).run(FEP);
  const socio = (await pedir('/api/socios', {
    id: crypto.randomUUID(), nombre: 'Cliente', telefono: '4449990000', pin: '1234', acepta_bases: true, declara_mayor_edad: true,
  })).cuerpo;
  assert.equal((await pedir('/api/portal/llegada', { cliente_id: socio.id })).status, 200);
  // $1,200 de FEP: $50 en Dolarones y $1,150 en efectivo. A FEP se le deben $1,150.
  assert.equal((await pedir('/api/ventas', {
    id: crypto.randomUUID(), caja: 'Caja 1', cliente_id: socio.id, dolarones: 5000, codigo_socio: await codigoPrueba(db, socio.id),
    forma_pago: 'efectivo', efectivo: 115000, lineas: [{ producto_id: FEP, cantidad: 4 }],
  })).status, 201);
  const corte = (await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 0, tarjeta_terminal: 0 })).cuerpo;
  assert.equal(corte.fep_por_pagar, 115000);
});
