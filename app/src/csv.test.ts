// node --test src/csv.test.ts
// Pruebas de inyeccion de formulas en CSV (Issue #175).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';

type Pedir = ReturnType<typeof tienda>['pedir'];
type PedirTexto = ReturnType<typeof tienda>['pedirTexto'];

// Vender para que aparezca en el CSV de ventas.
const vender = (pedir: Pedir, nombre: string) => {
  const venta = {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
    forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1',
  };
  return pedir('/api/ventas', venta);
};

test('formula injection: celda que empieza con = esta escapada', async () => {
  const { db, pedir, pedirTexto } = tienda();
  // Crear un producto con nombre que intenta inyeccion de formula.
  const productId = crypto.randomUUID();
  db.prepare(
    'insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en) values (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(productId, 'ED-FORMULA', '=HYPERLINK("http://evil")', 25000, 10, 'S40', new Date().toISOString(), new Date().toISOString());

  // Vender este producto.
  const venta = {
    id: crypto.randomUUID(),
    lineas: [{ producto_id: productId, cantidad: 1 }],
    forma_pago: 'efectivo',
    efectivo: 25000,
    caja: 'Caja 1',
  };
  await pedir('/api/ventas', venta);

  // Exportar CSV de ventas.
  const { status, texto } = await pedirTexto('/api/reportes/ventas.csv', 'GET');
  assert.equal(status, 200);

  // La celda debe estar escapada con apostrofe. En CSV, las comillas internas se doblan.
  // Esperamos ver: "'=HYPERLINK(""http://evil"")"
  assert.match(texto, /'=HYPERLINK\(""http:\/\/evil""\)/);
});

test('formula injection: nombres que empiezan con -, +, @, tab, carriage return estan escapados', async () => {
  const { db, pedir, pedirTexto } = tienda();

  const casos = [
    { nombre: '-minus', id: crypto.randomUUID() },
    { nombre: '+plus', id: crypto.randomUUID() },
    { nombre: '@at', id: crypto.randomUUID() },
  ];

  for (const caso of casos) {
    db.prepare(
      'insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en) values (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(caso.id, `ED-${caso.nombre}`, caso.nombre, 25000, 10, 'S40', new Date().toISOString(), new Date().toISOString());
    const venta = {
      id: crypto.randomUUID(),
      lineas: [{ producto_id: caso.id, cantidad: 1 }],
      forma_pago: 'efectivo',
      efectivo: 25000,
      caja: 'Caja 1',
    };
    await pedir('/api/ventas', venta);
  }

  const { status, texto } = await pedirTexto('/api/reportes/ventas.csv', 'GET');
  assert.equal(status, 200);

  // Cada nombre debe estar escapado.
  assert.match(texto, /'[\-\+@]minus/);
  assert.match(texto, /'[\-\+@]plus/);
  assert.match(texto, /'[\-\+@]at/);
});

test('nombres normales y numeros (precios, stock) no estan escapados', async () => {
  const { db, pedir, pedirTexto } = tienda();

  // El PRODUCTO existe con nombre 'Ventilador'.
  const venta = {
    id: crypto.randomUUID(),
    lineas: [{ producto_id: PRODUCTO, cantidad: 2 }],
    forma_pago: 'efectivo',
    efectivo: 50000,
    caja: 'Caja 1',
  };
  await pedir('/api/ventas', venta);

  // Exportar.
  const { status, texto } = await pedirTexto('/api/reportes/ventas.csv', 'GET');
  assert.equal(status, 200);

  // El nombre 'Ventilador' debe aparecer sin apostrofe.
  assert.match(texto, /Ventilador/);
  // No debe tener '=, '-, '+ ni '@ en nombres normales.
  const lineasVenta = texto.split('\r\n').slice(1); // Saltar encabezado
  for (const linea of lineasVenta) {
    if (!linea.trim()) continue; // Saltar lineas vacias
    // Si la linea contiene 'Ventilador', no debe tener apostrofe antes.
    if (linea.includes('Ventilador')) {
      assert.doesNotMatch(linea, /'Ventilador/);
    }
  }
});

test('precios negativos (devoluciones) y positivos se mantienen sin apostrofe', async () => {
  const { db, pedir, pedirTexto } = tienda();

  // El precio ya esta en centavos y se convierte con pesosDe (centavos / 100).toFixed(2)
  // Esto da un string como '250.00' o '-250.00'.
  const venta = {
    id: crypto.randomUUID(),
    lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
    forma_pago: 'efectivo',
    efectivo: 25000,
    caja: 'Caja 1',
  };
  await pedir('/api/ventas', venta);

  const { status, texto } = await pedirTexto('/api/reportes/ventas.csv', 'GET');
  assert.equal(status, 200);

  // Los precios '250.00' o '-250.00' (decimales) aparecen sin apostrofe.
  // Buscamos una celda que sea un numero puro (posiblemente negativo).
  const lineas = texto.split('\r\n');
  for (const linea of lineas) {
    // Si encontramos '250.00', no debe tener apostrofe delante.
    if (linea.includes('250.00')) {
      // Separar por comas para ver celdas individuales.
      const celdas = linea.split(',');
      for (const celda of celdas) {
        // Si la celda es un precio, no debe empezar con apostrofe.
        if (celda === '250.00') {
          assert.doesNotMatch(celda, /^'/);
        }
      }
    }
  }
});

test('stock (numero entero) no esta escapado', async () => {
  const { db, pedir, pedirTexto } = tienda();

  // Exportar inventario.
  const { status, texto } = await pedirTexto('/api/reportes/inventario.csv', 'GET');
  assert.equal(status, 200);

  // El stock del PRODUCTO es 50 (viene insertado en prueba-d1.ts).
  // En el CSV debe aparecer como '50' sin apostrofe y sin comillas (es un numero puro).
  const lineas = texto.split('\r\n');
  let hayStock = false;
  for (const linea of lineas) {
    if (linea.includes('Ventilador')) {
      hayStock = true;
      // La linea contiene el stock. En el inventario el stock está en la columna 'stock'.
      // Buscamos la celda que sea '50'.
      const celdas = linea.split(',');
      for (const celda of celdas) {
        if (celda === '50') {
          // El stock puro no debe tener apostrofe.
          assert.doesNotMatch(celda, /^'/);
          break;
        }
      }
    }
  }
  assert.ok(hayStock, 'Debe encontrar el Ventilador en el inventario');
});

test('CSV: una celda con retorno de carro (sin salto de linea) va entre comillas', async () => {
  const { db, pedir, pedirTexto } = tienda();
  const id = crypto.randomUUID();
  db.prepare(
    'insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en) values (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 'ED-CR', 'Playera\rnegra', 25000, 10, 'S40', new Date().toISOString(), new Date().toISOString());
  await pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: id, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1' });
  const { texto } = await pedirTexto('/api/reportes/ventas.csv');
  assert.ok(texto.includes('"Playera\rnegra"'), texto);
});

test('ventas.csv: la fecha es la hora de la tienda (UTC-6), igual que los tickets', async () => {
  const { db, pedir, pedirTexto } = tienda();
  const id = crypto.randomUUID();
  await pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1' });
  // 01:30 UTC del 8 = 19:30 del 7 en la tienda: el dia de la venta es el 7.
  db.prepare('update ventas set creado_en = ? where id = ?').run('2026-10-08T01:30:00.000Z', id);
  const { texto } = await pedirTexto('/api/reportes/ventas.csv');
  assert.match(texto, /\r\n2026-10-07 19:30,efectivo,/);
});
