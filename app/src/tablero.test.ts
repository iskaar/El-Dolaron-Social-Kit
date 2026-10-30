// node --test src/tablero.test.ts
// /api/tablero (Issue #610): solo agregados, al centavo, sin ningun dato de personas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import { hoyTienda } from './reportes.ts';

const INVERSIONISTA = 'socio.capital@prueba.mx';
const CLIENTE_PRIVADO = 'Carla Privada Sintetica';
const TELEFONO_PRIVADO = '4441230000';
const REVENDEDORA = 'ana.privada@revende.mx';

type T = ReturnType<typeof tienda>;
const venta = async (t: T, piezas = 1) => {
  const id = crypto.randomUUID();
  const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: piezas }], forma_pago: 'efectivo', efectivo: 25000 * piezas, caja: 'Caja 1' });
  assert.equal(r.status, 201);
  return id;
};
const pedido = (t: T, vendedora: string, ventaId: string, folio: number) => {
  const id = crypto.randomUUID();
  t.db.prepare(`insert into pedidos (id, folio, cliente, telefono, entrega, envio, vendedora, estado, vence_en, anticipo, forma_pago,
      saldo, saldo_vence_en, venta_id, creado_en, actualizado_en)
    values (?, ?, ?, ?, 'tienda', 0, ?, 'vendido', '', 0, 'efectivo', 0, '', ?, '', '')`).run(id, folio, CLIENTE_PRIVADO, TELEFONO_PRIVADO, vendedora, ventaId);
  t.db.prepare('update ventas set pedido_id = ? where id = ?').run(id, ventaId);
};
const cuenta = (t: T, correo: string, roles: string) =>
  t.db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, 1, '', '')").run(correo, 'Nombre Privado', roles);
const cliente = (t: T, n: number) => {
  const id = crypto.randomUUID();
  t.db.prepare(`insert into clientes (id, numero, nombre, telefono, correo, bases_version, registrado_por, creado_en)
    values (?, ?, ?, ?, 'privado@correo.mx', 'v', 'x', '')`).run(id, n, CLIENTE_PRIVADO, `44400000${String(n).padStart(2, '0')}`);
  return id;
};
const comoUsuario = (t: T, correo: string) => { (t.env as unknown as Record<string, string>).DEV_USUARIO = correo; };

test('/api/tablero suma al centavo ventas, canales, gastos y publicidad, y no suelta ningun dato privado', async () => {
  const t = tienda();
  const hoy = hoyTienda();
  t.db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  cuenta(t, REVENDEDORA, 'revendedora');
  cuenta(t, 'caja@prueba.mx', 'cajero');

  const v1 = await venta(t);                                   // tienda $250
  const v2 = await venta(t, 2);                                // tienda $500
  const v3 = await venta(t);                                   // cancelada: no cuenta
  assert.equal((await t.pedir(`/api/ventas/${v3}/cancelar`, { motivo: 'motivo privado sintetico', caja: 'Caja 1' })).status, 200);
  const v4 = await venta(t, 2);                                // $500, devuelve 1 pieza -> $250
  const linea = (await t.pedir(`/api/ventas/${v4}`)).cuerpo.lineas[0].id;
  assert.equal((await t.pedir(`/api/ventas/${v4}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' })).status, 201);
  const v5 = await venta(t);                                   // WhatsApp $250
  pedido(t, 'caja@prueba.mx', v5, 1);
  const v6 = await venta(t);                                   // revendedora $250 -> comision $25
  pedido(t, REVENDEDORA, v6, 2);

  // Mercado Libre: estimado con el precio publicado; la orden cancelada no cuenta.
  t.db.prepare("insert into ml_publicaciones (producto_id, ml_item_id, estado, precio_ml, actualizado_en) values (?, 'MLM1', 'activa', 18000, '')").run(PRODUCTO);
  const ahoraIso = new Date().toISOString();
  t.db.prepare("insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values ('o1', 'MLM1', ?, 2, 'descontada', 2, ?)").run(PRODUCTO, ahoraIso);
  t.db.prepare("insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values ('o2', 'MLM1', ?, 5, 'cancelada', 0, ?)").run(PRODUCTO, ahoraIso);

  // Gastos: capturados, un retiro de caja sin fila en gastos, y otro con fila (cuenta una sola vez), mas nomina.
  const gasto = t.db.prepare("insert into gastos (id, fecha, categoria, importe, nota, origen, retiro_id, creado_por, creado_en) values (?, ?, ?, ?, 'nota privada', ?, ?, 'x', ?)");
  gasto.run(crypto.randomUUID(), hoy, 'publicidad', 10000, 'fuera', null, ahoraIso);
  gasto.run(crypto.randomUUID(), hoy, 'renta', 50000, 'fuera', null, ahoraIso);
  gasto.run(crypto.randomUUID(), hoy, 'luz', 3000, 'fuera', null, ahoraIso);
  const retiro = t.db.prepare("insert into retiros (id, tipo, caja, cajero, importe, motivo, corte_id, creado_en, categoria) values (?, 'gasto', 'Caja 1', 'caja@prueba.mx', ?, 'motivo privado', null, ?, ?)");
  retiro.run('r1', 2000, ahoraIso, 'comida_consumibles');
  retiro.run('r2', 1500, ahoraIso, 'limpieza');
  gasto.run(crypto.randomUUID(), hoy, 'limpieza', 1500, 'caja', 'r2', ahoraIso);
  t.db.prepare("insert into empleados (id, nombre, periodo, pago_dia, creado_en) values ('e1', 'Empleado Privado', 'diario', 30000, '')").run();
  const mov = t.db.prepare("insert into nomina_movimientos (id, empleado_id, fecha, tipo, importe, creado_por, creado_en) values (?, 'e1', ?, ?, ?, 'x', ?)");
  mov.run('m1', hoy, 'devengo', 90000, ahoraIso);              // devengado: no es dinero pagado
  mov.run('m2', hoy, 'adelanto', 20000, ahoraIso);
  mov.run('m3', hoy, 'pago', -80000, ahoraIso);

  // Clientes: 5 socios; dos compraron dos veces (la cancelada no cuenta).
  const c = [1, 2, 3, 4, 5].map((n) => cliente(t, n));
  const asignar = t.db.prepare('update ventas set cliente_id = ? where id = ?');
  asignar.run(c[0], v1); asignar.run(c[0], v2); asignar.run(c[1], v4); asignar.run(c[1], v5); asignar.run(c[2], v6); asignar.run(c[2], v3);
  t.db.prepare("insert into config (clave, valor) values ('meta_ventas_mes', '600000')").run();

  const r = await t.pedir('/api/tablero', undefined, 'GET');
  assert.equal(r.status, 200);
  const d = r.cuerpo;

  // 250 + 500 + 250 (queda tras la devolucion) + 250 + 250 = 1,500
  assert.equal(d.ventas.total, 150000);
  assert.equal(d.ventas.tickets, 5);
  assert.equal(d.ventas.ticket_promedio, 30000);
  assert.equal(d.ventas.semanas.reduce((s: number, w: { total: number }) => s + w.total, 0), 150000);
  assert.equal(d.ventas.semana.actual.total, 150000);
  assert.equal(d.ventas.semana.anterior.total, 0);
  assert.equal(d.ventas.semana.poca_historia, true);

  const canales = d.canales;
  assert.deepEqual([canales.tienda.total, canales.whatsapp.total, canales.revendedoras.total], [100000, 25000, 25000]);
  assert.equal(canales.tienda.total + canales.whatsapp.total + canales.revendedoras.total, d.ventas.total);
  assert.equal(canales.revendedoras.comision, 2500);
  assert.equal(canales.revendedoras.personas, null);           // 1 persona: no se cuenta
  assert.deepEqual(canales.mercado_libre, { estimado: true, total: 36000, piezas: 2 });

  // 100 + 500 + 30 + 20 + 15 + 1,000 (adelanto 200 + pago 800)
  assert.equal(d.gastos.total, 166500);
  assert.deepEqual(d.gastos.por_categoria, [
    { categoria: 'nomina', importe: 100000 }, { categoria: 'renta', importe: 50000 },
    { categoria: 'otros', importe: 6500 }, { categoria: 'publicidad', importe: 10000 },
  ]);
  assert.equal(d.ventas_menos_gastos, 150000 - 166500);
  assert.deepEqual(d.publicidad, { gasto: 10000, ventas_por_peso: 15 });

  assert.equal(d.meta.monto, 600000);
  assert.equal(d.meta.avance_pct, 25);
  assert.equal(d.meta.ritmo_monto, Math.round(600000 * d.mes.transcurridos / d.mes.dias));
  assert.equal(d.meta.estado, 150000 >= d.meta.ritmo_monto ? 'arriba' : 'abajo');

  assert.deepEqual(d.clientes, { socios: 5, regresaron_pct: 40 });

  // Nada de personas: ni llaves ni valores.
  const texto = JSON.stringify(d);
  const llaves = new Set<string>();
  const recorrer = (x: unknown) => { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { llaves.add(k); recorrer(v); } };
  recorrer(d);
  for (const llave of llaves) assert.doesNotMatch(llave, /nombre|telefono|correo|mail|codigo|motivo|sueldo|empleado|(^|_)vendedora(_|$)|^cliente_|^id$|_id$|^ticket$|pin|token/i, llave);
  for (const privado of [CLIENTE_PRIVADO, TELEFONO_PRIVADO, REVENDEDORA, 'caja@prueba.mx', 'Nombre Privado', 'Empleado Privado', 'motivo privado',
    'nota privada', 'ED-000001', 'Ventilador', DUENO, v1, v2, v3, v4, v5, v6]) assert.ok(!texto.includes(privado), privado);
  assert.doesNotMatch(texto, /@/);
  assert.ok(!('mas_viejas' in d.inventario));
  t.db.close();
});

test('grupos de menos de 5 personas no se cuentan y sin meta no hay barra', async () => {
  const t = tienda();
  [1, 2, 3, 4].forEach((n) => cliente(t, n));
  const d = (await t.pedir('/api/tablero', undefined, 'GET')).cuerpo;
  assert.deepEqual(d.clientes, { socios: null, regresaron_pct: null });
  assert.equal(d.meta, null);
  assert.equal(d.publicidad.ventas_por_peso, null);
  cliente(t, 5);
  assert.equal((await t.pedir('/api/tablero', undefined, 'GET')).cuerpo.clientes.socios, 5);

  // Cinco revendedoras con venta: ya se puede decir cuantas son.
  t.db.prepare('update productos set stock = 100 where id = ?').run(PRODUCTO);
  for (let n = 0; n < 5; n++) {
    const correo = `rev${n}@revende.mx`;
    cuenta(t, correo, 'revendedora');
    pedido(t, correo, await venta(t), 10 + n);
  }
  const e = (await t.pedir('/api/tablero', undefined, 'GET')).cuerpo;
  assert.equal(e.canales.revendedoras.personas, 5);
  assert.equal(e.canales.revendedoras.comision, 5 * 2500);
  t.db.close();
});

test('el navegador nunca guarda /api/tablero y el inversionista entra a /tablero, no a lo demas', async () => {
  const t = tienda();
  cuenta(t, INVERSIONISTA, 'inversionista');
  comoUsuario(t, INVERSIONISTA);
  const r = await t.enviar('/api/tablero');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  for (const ruta of ['/api/reportes', '/api/reportes/tickets', '/api/gastos?mes=2026-10', '/api/pedidos', '/api/config', '/api/avisos', '/api/mensajes', '/api/cuentas']) {
    assert.equal((await t.pedir(ruta, undefined, 'GET')).status, 403, ruta);
  }
  assert.equal((await t.pedir('/api/tablero', {}, 'POST')).status, 403);
  const inicio = await t.enviar('/');
  assert.equal(inicio.status, 302);
  assert.equal(new URL(inicio.headers.get('location')!).pathname, '/tablero');
  assert.equal(new URL((await t.enviar('/reportes')).headers.get('location')!).pathname, '/sin-acceso');
  t.db.close();
});
