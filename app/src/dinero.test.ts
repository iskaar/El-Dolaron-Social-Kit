// node --test src/dinero.test.ts
// Recolección del efectivo de los cortes por tienda (Issue #909) contra SQLite real con todas las migraciones.
// Importes y nombres de prueba: inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import { permiso, puede, type Usuario } from './cuentas.ts';

const ANA = 'ana@prueba.mx';        // cajera de Soledad (sin tienda = Soledad)
const SARA = 'sara@prueba.mx';      // cajera de Avenida Salk
const OTRA = 'otra@prueba.mx';      // cajera de Soledad, sin PIN
const PIN_DUENO = '111222';
const PIN_ANA = '482913';
const PIN_SARA = '735190';
const plano = (filas: unknown) => JSON.parse(JSON.stringify(filas));   // node:sqlite devuelve objetos sin prototipo

async function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values
    ('${ANA}', 'Ana', 'cajero', 1, '', '', ''),
    ('${SARA}', 'Sara', 'cajero', 1, 'salk', '', ''),
    ('${OTRA}', 'Otra', 'cajero', 1, '', '', '')`).run();
  for (const [correo, pin] of [[DUENO, PIN_DUENO], [ANA, PIN_ANA], [SARA, PIN_SARA]]) await t.pedir('/api/cuentas/pin', { correo, pin }, 'PUT');
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  let n = 0;
  // Un corte ya hecho: sin pasar por las ventas, solo lo que /dinero lee.
  const corte = (caja: string, entregado: number, hasta = new Date(Date.now() + ++n).toISOString()) => {
    const id = crypto.randomUUID();
    t.db.prepare(
      `insert into cortes (id, caja, cajero, hasta, tickets, fondo_inicial, efectivo_ventas, efectivo_devoluciones, retiros,
         efectivo_esperado, efectivo_contado, diferencia, tarjeta_sistema, tarjeta_terminal, transferencias, dolarones,
         fondo_siguiente, entregado, creado_en)
       values (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, 0, 0, 0, 0, 0, 0, ?, ?)`,
    ).run(id, caja, ANA, hasta, entregado, entregado, hasta);
    return id;
  };
  const recoger = (cuerpo: Record<string, unknown>) =>
    t.pedir('/api/dinero/recolecciones', { id: crypto.randomUUID(), tienda: 'soledad', contado: 0, ...cuerpo }, 'POST');
  const cuenta = (tabla: string) => (t.db.prepare(`select count(*) as n from ${tabla}`).get() as { n: number }).n;
  return { ...t, como, corte, recoger, cuenta };
}

test('sin rol dueno (cajero, capturista, sin cuenta) todo /dinero responde 403', async () => {
  const { pedir, como, corte, db } = await montar();
  const c = corte('Caja 1', 1000);
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('cap@prueba.mx', 'Cap', 'capturista', 1, '', '')`).run();
  for (const quien of [ANA, 'cap@prueba.mx', 'nadie@prueba.mx']) {
    como(quien);
    assert.equal((await pedir('/dinero', undefined, 'GET')).status, 302, `pantalla ${quien}: a /sin-acceso`);
    assert.equal((await pedir('/api/dinero', undefined, 'GET')).status, 403, `GET ${quien}`);
    assert.equal((await pedir('/api/dinero/recolecciones', { id: crypto.randomUUID(), tienda: 'soledad', cortes: [c], contado: 1000 })).status, 403, `POST ${quien}`);
    assert.equal((await pedir('/api/dinero/desde', { desde: '2020-01-01' }, 'PUT')).status, 403, `PUT ${quien}`);
  }
  assert.equal((db.prepare('select count(*) as n from recolecciones').get() as { n: number }).n, 0);
  como(DUENO);
  assert.equal((await pedir('/api/dinero', undefined, 'GET')).status, 200);
  // La regla es explícita: solo gerencia, en la pantalla y en cada ruta de la API.
  const con = (...roles: Usuario['roles']) => ({ correo: 'x@prueba.mx', nombre: 'X', roles, activo: true, caja: '', tienda: '', editar_inventario: false }) as Usuario;
  for (const [ruta, metodo] of [['/dinero', 'GET'], ['/api/dinero', 'GET'], ['/api/dinero/recolecciones', 'POST'], ['/api/dinero/desde', 'PUT']] as const) {
    assert.equal(puede(con('dueno'), permiso(ruta, metodo)), true, ruta);
    // `finanzas` solo lee (#910): la pantalla y GET /api/dinero; toda escritura es de gerencia.
    const lee = ruta === '/dinero' || (ruta === '/api/dinero' && metodo === 'GET');
    assert.equal(puede(con('finanzas'), permiso(ruta, metodo)), lee, `finanzas ${ruta} ${metodo}`);
    for (const rol of ['cajero', 'supervisor', 'capturista', 'auxiliar', 'inversionista', 'computadora'] as const)
      assert.equal(puede(con(rol), permiso(ruta, metodo)), false, `${rol} ${ruta}`);
  }
  for (const [ruta, metodo] of [['/api/dinero/movimientos', 'POST'], ['/api/dinero/arqueos', 'POST']] as const) {
    assert.equal(puede(con('dueno'), permiso(ruta, metodo)), true, ruta);
    for (const rol of ['cajero', 'supervisor', 'capturista', 'finanzas', 'auxiliar', 'inversionista', 'computadora'] as const)
      assert.equal(puede(con(rol), permiso(ruta, metodo)), false, `${rol} ${ruta}`);
  }
});

test('recoger marca los cortes y guarda esperado, contado y diferencia; lo pendiente se vacía y /api/cortes no cambia', async () => {
  const { pedir, corte, recoger, db, cuenta } = await montar();
  // Un corte real por la caja: la respuesta de /api/cortes no debe traer nada de recolecciones.
  const venta = { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 3' };
  assert.equal((await pedir('/api/ventas', venta)).status, 201);
  const real = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 3', efectivo_contado: 75000, tarjeta_terminal: 0 });
  assert.equal(real.status, 201);
  assert.equal(real.cuerpo.entregado, 25000);
  assert.deepEqual(Object.keys(real.cuerpo).filter((k) => /recolec/i.test(k)), []);
  assert.deepEqual(Object.keys((await pedir('/api/cortes?caja=Caja%203', undefined, 'GET')).cuerpo).filter((k) => /recolec/i.test(k)), []);

  const a = corte('Caja 1', 10000), b = corte('Caja 2', 20050);
  const antes = (await pedir('/api/dinero', undefined, 'GET')).cuerpo;
  const soledad = antes.tiendas.find((t: any) => t.clave === 'soledad');
  assert.equal(soledad.cortes.length, 3);
  assert.equal(soledad.total, 25000 + 10000 + 20050);
  assert.equal(antes.tiendas.find((t: any) => t.clave === 'salk').total, 0);

  const id = crypto.randomUUID();
  const r = await recoger({ id, cortes: [a, b, real.cuerpo.id], contado: 55000, nota: 'faltó un billete de prueba' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.esperado, 55050);
  assert.equal(r.cuerpo.contado, 55000);
  assert.equal(r.cuerpo.diferencia, -50);
  assert.equal(r.cuerpo.recibio, DUENO);
  assert.equal(r.cuerpo.entrego, '');
  assert.equal(r.cuerpo.tomados, 3);
  assert.equal(r.cuerpo.parcial, false);
  assert.equal(cuenta('recolecciones_cortes'), 3);
  assert.deepEqual(plano(db.prepare('select distinct recoleccion_id from recolecciones_cortes').all()), [{ recoleccion_id: id }]);

  const despues = (await pedir('/api/dinero', undefined, 'GET')).cuerpo;
  assert.equal(despues.tiendas.find((t: any) => t.clave === 'soledad').cortes.length, 0);
  assert.equal(despues.recolecciones.length, 1);
  assert.equal(despues.recolecciones[0].cortes.length, 3);
  assert.equal(despues.recolecciones[0].recibio_nombre, 'Isaac');
});

test('una diferencia sin nota se rechaza y no marca nada; con nota se guarda', async () => {
  const { corte, recoger, cuenta } = await montar();
  const a = corte('Caja 1', 10000);
  assert.equal((await recoger({ cortes: [a], contado: 9000 })).status, 400);
  assert.equal(cuenta('recolecciones'), 0);
  assert.equal(cuenta('recolecciones_cortes'), 0);
  const sobra = await recoger({ cortes: [a], contado: 10500, nota: 'sobró' });
  assert.equal(sobra.status, 201);
  assert.equal(sobra.cuerpo.diferencia, 500);
});

test('reintento con el mismo id devuelve la misma recolección sin duplicar nada ni volver a pedir el PIN', async () => {
  const { corte, recoger, cuenta } = await montar();
  const a = corte('Caja 1', 10000);
  const id = crypto.randomUUID();
  const primera = await recoger({ id, cortes: [a], contado: 10000, entrego: ANA, pin: PIN_ANA });
  assert.equal(primera.status, 201, JSON.stringify(primera.cuerpo));
  const segunda = await recoger({ id, cortes: [a], contado: 10000, entrego: ANA, pin: '000000' });   // el PIN ya no se revisa: es un reintento
  assert.equal(segunda.status, 200);
  assert.equal(segunda.cuerpo.id, id);
  assert.equal(segunda.cuerpo.creado_en, primera.cuerpo.creado_en);
  assert.equal(segunda.cuerpo.entrego, ANA);
  assert.equal(cuenta('recolecciones'), 1);
  assert.equal(cuenta('recolecciones_cortes'), 1);
  // El mismo id para otra tienda no es un reintento.
  assert.equal((await recoger({ id, tienda: 'salk', cortes: [a], contado: 10000 })).status, 409);
});

test('un corte nunca queda en dos recolecciones: la segunda solo toma lo que sigue libre, y si no hay nada no crea nada', async () => {
  const { corte, recoger, db, cuenta } = await montar();
  const a = corte('Caja 1', 10000), b = corte('Caja 2', 7000);
  const A = crypto.randomUUID(), B = crypto.randomUUID(), C = crypto.randomUUID();
  assert.equal((await recoger({ id: A, cortes: [a], contado: 10000 })).status, 201);

  const parcial = await recoger({ id: B, cortes: [a, b], contado: 7000 });   // `a` ya se fue en A
  assert.equal(parcial.status, 201, JSON.stringify(parcial.cuerpo));
  assert.equal(parcial.cuerpo.esperado, 7000, 'lo esperado sale de lo que de verdad quedó marcado');
  assert.equal(parcial.cuerpo.pedidos, 2);
  assert.equal(parcial.cuerpo.tomados, 1);
  assert.equal(parcial.cuerpo.parcial, true);
  assert.deepEqual(plano(db.prepare('select corte_id, recoleccion_id from recolecciones_cortes where corte_id in (?, ?) order by corte_id = ? desc').all(a, b, a)), [
    { corte_id: a, recoleccion_id: A }, { corte_id: b, recoleccion_id: B },
  ]);

  const nada = await recoger({ id: C, cortes: [a, b], contado: 17000 });
  assert.equal(nada.status, 409);
  assert.equal(cuenta('recolecciones'), 2, 'sin cortes libres no se crea recolección');
  assert.equal(cuenta('recolecciones_cortes'), 2);
  // Aunque se intente por debajo del código, la base no deja un corte en dos recolecciones.
  assert.throws(() => db.prepare('insert into recolecciones_cortes (corte_id, recoleccion_id) values (?, ?)').run(a, C), /UNIQUE|PRIMARY/i);
});

test('dos recolecciones que piden el mismo corte al mismo tiempo: solo una lo cuenta', async () => {
  const { corte, recoger, db } = await montar();
  const a = corte('Caja 1', 10000);
  const resultados = await Promise.all([
    recoger({ cortes: [a], contado: 10000 }),
    recoger({ cortes: [a], contado: 10000 }),
  ]);
  assert.deepEqual(resultados.map((r) => r.status).sort(), [201, 409]);
  assert.equal((db.prepare('select count(*) as n from recolecciones_cortes where corte_id = ?').get(a) as { n: number }).n, 1);
  assert.equal((db.prepare('select count(*) as n from recolecciones').get() as { n: number }).n, 1);
});

test('el mismo id enviado dos veces a la vez crea una sola recolección', async () => {
  const { corte, recoger, cuenta } = await montar();
  const a = corte('Caja 1', 10000);
  const id = crypto.randomUUID();
  const resultados = await Promise.all([recoger({ id, cortes: [a], contado: 10000 }), recoger({ id, cortes: [a], contado: 10000 })]);
  assert.ok(resultados.every((r) => r.status === 200 || r.status === 201), JSON.stringify(resultados.map((r) => r.status)));
  assert.equal(new Set(resultados.map((r) => r.cuerpo.id)).size, 1);
  assert.equal(cuenta('recolecciones'), 1);
});

test('los cortes de otra tienda no se toman, y los anteriores a recolecciones_desde ni se listan ni se toman', async () => {
  const { pedir, corte, recoger, db, cuenta } = await montar();
  const soledad = corte('Caja 1', 10000), salk = corte('Salk 1', 3000), romero = corte('Romero 2', 4000);
  const vieja = corte('Caja 2', 9999, new Date(Date.now() - 3 * 86400_000).toISOString());
  const sinEntrega = corte('Caja 3', 0);

  // Soledad pide los de todas las tiendas: solo se lleva el suyo; lo viejo y lo que no entregó nada, no.
  const r = await recoger({ cortes: [soledad, salk, romero, vieja, sinEntrega], contado: 10000 });
  assert.equal(r.status, 201);
  assert.equal(r.cuerpo.tomados, 1);
  assert.equal(r.cuerpo.esperado, 10000);
  assert.deepEqual(plano(db.prepare('select corte_id from recolecciones_cortes').all()), [{ corte_id: soledad }]);

  // Pedir solo lo de otra tienda: nada que tomar.
  assert.equal((await recoger({ cortes: [salk], contado: 3000 })).status, 409);
  assert.equal(cuenta('recolecciones'), 1);

  // Mover la fecha: lo anterior deja de ser pendiente. La vieja ya estaba fuera por la fecha de arranque (la migración corrió después).
  const pendientes = (await pedir('/api/dinero', undefined, 'GET')).cuerpo.tiendas.flatMap((t: any) => t.cortes.map((c: any) => c.id)).sort();
  assert.deepEqual(pendientes, [salk, romero].sort());
  const manana = new Date(Date.now() + 86400_000).toISOString();
  assert.equal((await pedir('/api/dinero/desde', { desde: manana }, 'PUT')).status, 200);
  assert.deepEqual((await pedir('/api/dinero', undefined, 'GET')).cuerpo.tiendas.flatMap((t: any) => t.cortes), []);
  assert.equal((await recoger({ tienda: 'salk', cortes: [salk], contado: 3000 })).status, 409);
  assert.equal(cuenta('recolecciones'), 1);
  // Y se puede volver atrás: la fecha es editable.
  assert.equal((await pedir('/api/dinero/desde', { desde: '2020-01-01' }, 'PUT')).status, 200);
  assert.equal((await pedir('/api/dinero', undefined, 'GET')).cuerpo.tiendas.find((t: any) => t.clave === 'soledad').cortes.map((c: any) => c.id).includes(vieja), true);
  assert.equal((await pedir('/api/dinero/desde', { desde: 'ayer' }, 'PUT')).status, 400);
});

test('la firma: PIN correcto guarda a quien entregó; PIN incorrecto, de otra tienda, propio o ajeno no registran nada', async () => {
  const { corte, recoger, db, cuenta } = await montar();
  const a = corte('Caja 1', 10000), s = corte('Salk 1', 5000);
  const intentar = (extra: Record<string, unknown>, cortes = [a], tienda = 'soledad', contado = 10000) =>
    recoger({ tienda, cortes, contado, ...extra });
  const sinRastro = () => { assert.equal(cuenta('recolecciones'), 0); assert.equal(cuenta('recolecciones_cortes'), 0); };

  assert.equal((await intentar({ entrego: ANA, pin: '000000' })).status, 403, 'PIN incorrecto');
  sinRastro();
  assert.equal((await intentar({ entrego: ANA })).status, 400, 'sin PIN');
  sinRastro();
  assert.equal((await intentar({ entrego: OTRA, pin: PIN_ANA })).status, 404, 'cuenta sin PIN');
  sinRastro();
  assert.equal((await intentar({ entrego: SARA, pin: PIN_SARA })).status, 403, 'cajera de otra tienda');
  sinRastro();
  assert.equal((await intentar({ entrego: DUENO, pin: PIN_DUENO })).status, 400, 'quien recibe no firma su propia entrega');
  sinRastro();
  assert.equal((await intentar({ entrego: 'nadie@prueba.mx', pin: PIN_ANA })).status, 404);
  sinRastro();

  const buena = await intentar({ entrego: ANA.toUpperCase(), pin: PIN_ANA });
  assert.equal(buena.status, 201, JSON.stringify(buena.cuerpo));
  assert.equal(buena.cuerpo.entrego, ANA);
  assert.equal(buena.cuerpo.entrego_nombre, 'Ana');
  assert.equal((db.prepare('select entrego from recolecciones').get() as { entrego: string }).entrego, ANA);

  // Cada tienda firma con su gente.
  const salk = await intentar({ entrego: SARA, pin: PIN_SARA }, [s], 'salk', 5000);
  assert.equal(salk.status, 201, JSON.stringify(salk.cuerpo));
  assert.equal(salk.cuerpo.entrego, SARA);
});

test('sin firma queda dicho (entrego vacío); y el PIN falla con el bloqueo de la aprobación sin tocar el acceso a la caja', async () => {
  const { corte, recoger, db } = await montar();
  const a = corte('Caja 1', 10000), b = corte('Caja 2', 2000);
  const sin = await recoger({ cortes: [a], contado: 10000 });
  assert.equal(sin.status, 201);
  assert.equal(sin.cuerpo.entrego, '');

  for (let i = 0; i < 5; i++) await recoger({ cortes: [b], contado: 2000, entrego: ANA, pin: '000000' });
  const bloqueada = await recoger({ cortes: [b], contado: 2000, entrego: ANA, pin: PIN_ANA });
  assert.equal(bloqueada.status, 423, 'tras 5 fallos ni el PIN bueno pasa durante el bloqueo');
  assert.equal((db.prepare('select pin_fallos from usuarios where correo = ?').get(ANA) as { pin_fallos: number }).pin_fallos, 0, 'su acceso a la caja no se toca');
  assert.equal((db.prepare('select count(*) as n from recolecciones').get() as { n: number }).n, 1);
});

test('datos inválidos: id, tienda, cortes y contado', async () => {
  const { corte, recoger } = await montar();
  const a = corte('Caja 1', 10000);
  assert.equal((await recoger({ id: 'x', cortes: [a] })).status, 400);
  assert.equal((await recoger({ tienda: 'luna', cortes: [a] })).status, 400);
  assert.equal((await recoger({ cortes: [] })).status, 400);
  assert.equal((await recoger({ cortes: ['no-es-uuid'] })).status, 400);
  assert.equal((await recoger({ cortes: [a], contado: 100.5 })).status, 400);
  assert.equal((await recoger({ cortes: [a], contado: -1, nota: 'x' })).status, 400);
});

// ---------------------------------------------------------------------------------------------------------------------
// Fase 2 (#910): saldo esperado, movimientos, arqueos y «¿Con qué se pagó?». Importes y nombres: inventados.
// ---------------------------------------------------------------------------------------------------------------------
const EMPLEADO = '22222222-2222-4222-8222-222222222222';
const hoyTienda = (dias = 0) => new Date(Date.now() - 6 * 3_600_000 + dias * 86_400_000).toISOString().slice(0, 10);

// Espera a que el reloj pase del último arqueo: el arqueo y lo que sigue no pueden caer en el mismo milisegundo.
async function tictac(db: { prepare(sql: string): { get(): unknown } }) {
  const ultimo = (db.prepare('select max(creado_en) as m from arqueos').get() as { m: string | null }).m;
  if (!ultimo) return;
  while (new Date().toISOString() <= ultimo) await new Promise((r) => setTimeout(r, 1));
}

async function montarCaja() {
  const t = await montar();
  const gasto = (extra: Record<string, unknown>) =>
    t.pedir('/api/gastos', { fecha: hoyTienda(), categoria: 'renta', importe: 1000, nota: 'prueba', origen: 'fuera', ...extra });
  const nomina = (extra: Record<string, unknown>) =>
    t.pedir('/api/nomina/movimientos', { id: crypto.randomUUID(), empleado_id: EMPLEADO, fecha: hoyTienda(), ...extra });
  const arqueo = async (contado: number, extra: Record<string, unknown> = {}) => {
    const r = await t.pedir('/api/dinero/arqueos', { id: crypto.randomUUID(), contado, ...extra });
    await tictac(t.db);
    return r;
  };
  const mover = (tipo: string, importe: number, extra: Record<string, unknown> = {}) =>
    t.pedir('/api/dinero/movimientos', { id: crypto.randomUUID(), tipo, importe, ...extra });
  const saldo = async () => (await t.pedir('/api/dinero', undefined, 'GET')).cuerpo;
  await t.pedir(`/api/nomina/empleados/${EMPLEADO}`, { nombre: 'Empleado prueba', periodo: 'quincenal', pago_dia: 10000, dias: [1], hora_entrada: '09:00', pin: '123456' });
  return { ...t, gasto, nomina, arqueo, mover, saldo };
}

test('saldo esperado: mezcla recolección, terminal, gastos y nómina en efectivo, transferencias que no cuentan, depósito y arqueo', async () => {
  const { db, pedir, gasto, nomina, arqueo, mover, saldo } = await montarCaja();
  assert.equal((await saldo()).saldo, null, 'sin arqueo no hay saldo');
  assert.equal((await saldo()).caja_lista, true);

  // El primer arqueo es el saldo inicial. Se adelanta 5 s hacia atrás para que lo que sigue quede claramente después.
  const primero = await arqueo(100000);
  assert.equal(primero.status, 201, JSON.stringify(primero.cuerpo));
  assert.deepEqual([primero.cuerpo.esperado, primero.cuerpo.contado, primero.cuerpo.diferencia], [100000, 100000, 0]);
  db.prepare('update arqueos set creado_en = ?').run(new Date(Date.now() - 5000).toISOString());
  const insertarRecoleccion = (contado: number, creado: string) => db.prepare(
    `insert into recolecciones (id, tienda, recibio, esperado, contado, diferencia, nota, creado_en) values (?, 'soledad', ?, ?, ?, 0, '', ?)`,
  ).run(crypto.randomUUID(), DUENO, contado, contado, creado);

  // Lo que NO cuenta: anterior al arqueo (aunque sea del mismo día), transferencias, gasto del cajón.
  const antesDelArqueo = new Date(Date.now() - 6000).toISOString();
  insertarRecoleccion(66600, antesDelArqueo);
  db.prepare(`insert into gastos (id, fecha, categoria, importe, nota, origen, creado_por, creado_en, pagado_con)
    values (?, ?, 'renta', 44400, 'registrado antes del arqueo', 'fuera', ?, ?, 'efectivo')`).run(crypto.randomUUID(), hoyTienda(), DUENO, antesDelArqueo);
  assert.equal((await gasto({ importe: 99900, pagado_con: 'banco' })).status, 201);
  assert.equal((await gasto({ importe: 3300, origen: 'caja', caja: 'Caja 1' })).status, 201);
  // Gasto viejo capturado tarde: fecha anterior a la del arqueo, registrado después. No mueve el saldo.
  assert.equal((await gasto({ importe: 77700, fecha: hoyTienda(-1) })).status, 201);
  assert.equal((await saldo()).saldo.esperado, 100000, 'nada de lo anterior mueve el saldo');

  // Lo que SÍ cuenta.
  insertarRecoleccion(50000, new Date().toISOString());
  assert.equal((await pedir('/api/terminal', { id: crypto.randomUUID(), importe: 30000 })).status, 201);
  assert.equal((await mover('entrada', 1000, { nota: 'Aporte de prueba' })).status, 201);
  assert.equal((await gasto({ importe: 12000 })).status, 201);   // sin pagado_con: un cliente viejo guarda efectivo
  assert.equal((await nomina({ tipo: 'devengo', origen: 'manual' })).status, 201);
  assert.equal((await nomina({ tipo: 'pago', importe: 10000, origen: 'fuera', pagado_con: 'efectivo' })).status, 201);
  assert.equal((await nomina({ tipo: 'adelanto', importe: 5000, origen: 'fuera' })).status, 201);   // idem: efectivo
  assert.equal((await nomina({ tipo: 'adelanto', importe: 1100, origen: 'fuera', pagado_con: 'banco' })).status, 201);   // no cuenta
  assert.equal((await mover('deposito', 8000)).status, 201);
  assert.equal((await mover('a_tienda', 2000)).status, 201);
  assert.equal((await mover('salida', 700, { nota: 'Salida de prueba' })).status, 201);

  const { arqueo: _a, desde: _d, ...desglose } = (await saldo()).saldo;
  assert.deepEqual(desglose, { base: 100000, recolecciones: 50000, terminal: 30000, entradas: 1000, gastos: 12000, nomina: 15000,
    depositos: 8000, a_tienda: 2000, salidas: 700, esperado: 143300 });

  // El segundo arqueo guarda esperado, contado y diferencia; una diferencia pide nota y, sin ella, no queda nada.
  assert.equal((await arqueo(143000)).status, 400);
  assert.equal((db.prepare('select count(*) as n from arqueos').get() as { n: number }).n, 1);
  const segundo = await arqueo(143000, { nota: 'Faltante de prueba' });
  assert.equal(segundo.status, 201, JSON.stringify(segundo.cuerpo));
  assert.deepEqual([segundo.cuerpo.esperado, segundo.cuerpo.contado, segundo.cuerpo.diferencia], [143300, 143000, -300]);
  // Tras el arqueo el saldo arranca de lo contado; un gasto de fecha anterior capturado después no lo mueve, uno de hoy sí.
  assert.equal((await saldo()).saldo.esperado, 143000);
  assert.equal((await gasto({ importe: 5000, fecha: hoyTienda(-3) })).status, 201);
  assert.equal((await saldo()).saldo.esperado, 143000, 'gasto con fecha anterior al arqueo, capturado después');
  assert.equal((await gasto({ importe: 5000 })).status, 201);
  assert.equal((await saldo()).saldo.esperado, 138000);
  // Un arqueo exacto no pide nota.
  assert.equal((await arqueo(138000)).cuerpo.diferencia, 0);
});

test('el primer arqueo es el saldo inicial; los movimientos esperan a que exista; entrada y salida piden nota', async () => {
  const { arqueo, mover, saldo, db } = await montarCaja();
  assert.equal((await mover('deposito', 1000)).status, 409, 'sin arqueo no hay saldo que mover');
  assert.equal((await arqueo(-5)).status, 400);
  assert.equal((await arqueo(10.5)).status, 400);
  const primero = await arqueo(250000);
  assert.equal(primero.status, 201);
  assert.equal(primero.cuerpo.diferencia, 0);
  assert.equal(primero.cuerpo.esperado, 250000);
  assert.equal((await saldo()).saldo.esperado, 250000);
  assert.equal((await mover('entrada', 100)).status, 400, 'entrada sin nota');
  assert.equal((await mover('salida', 100, { nota: '  ' })).status, 400, 'salida sin nota');
  assert.equal((await mover('regalo', 100)).status, 400);
  assert.equal((await mover('deposito', 0)).status, 400);
  assert.equal((await mover('deposito', 10.5)).status, 400);
  assert.equal((await mover('deposito', 1000)).status, 201);
  assert.equal((await saldo()).saldo.esperado, 249000);
  assert.equal((db.prepare('select count(*) as n from dinero_movimientos').get() as { n: number }).n, 1);
});

test('un movimiento lleva fecha: el anterior al último arqueo se guarda pero no mueve el saldo; hoy sí; futura o inválida, 400', async () => {
  const { arqueo, mover, saldo, db } = await montarCaja();
  assert.equal((await arqueo(100000)).status, 201);
  const antes = await mover('deposito', 8000, { fecha: hoyTienda(-1) });
  assert.equal(antes.status, 201, JSON.stringify(antes.cuerpo));
  assert.equal(antes.cuerpo.cuenta, false);
  assert.equal(antes.cuerpo.fecha, hoyTienda(-1));
  assert.equal((await saldo()).saldo.esperado, 100000, 'fecha anterior al arqueo: guardado, sin mover el saldo');
  assert.equal((db.prepare('select count(*) as n from dinero_movimientos').get() as { n: number }).n, 1);
  assert.equal((await saldo()).movimientos.length, 1);
  const hoy = await mover('deposito', 8000, { fecha: hoyTienda() });
  assert.equal(hoy.cuerpo.cuenta, true);
  assert.equal((await saldo()).saldo.esperado, 92000);
  const sinFecha = await mover('salida', 1000, { nota: 'Sin fecha' });
  assert.deepEqual([sinFecha.cuerpo.cuenta, sinFecha.cuerpo.fecha], [true, hoyTienda()]);
  assert.equal((await saldo()).saldo.esperado, 91000);
  for (const fecha of [hoyTienda(1), '2026-02-30', 'ayer', 20261120]) assert.equal((await mover('deposito', 100, { fecha })).status, 400, String(fecha));
  assert.equal((db.prepare('select count(*) as n from dinero_movimientos').get() as { n: number }).n, 3);
});

test('reintentar con el mismo id no duplica movimientos ni arqueos', async () => {
  const { pedir, saldo, db } = await montarCaja();
  const idArqueo = crypto.randomUUID(), idMov = crypto.randomUUID();
  assert.equal((await pedir('/api/dinero/arqueos', { id: idArqueo, contado: 5000 })).status, 201);
  await tictac(db);
  const otra = await pedir('/api/dinero/arqueos', { id: idArqueo, contado: 5000 });
  assert.equal(otra.status, 200);
  assert.equal(otra.cuerpo.repetida, true);
  assert.equal((await pedir('/api/dinero/movimientos', { id: idMov, tipo: 'deposito', importe: 1000 })).status, 201);
  assert.equal((await pedir('/api/dinero/movimientos', { id: idMov, tipo: 'deposito', importe: 1000 })).cuerpo.repetida, true);
  // Dos peticiones a la vez con el mismo id: queda una sola fila.
  const nuevo = crypto.randomUUID();
  await Promise.all([1, 2].map(() => pedir('/api/dinero/movimientos', { id: nuevo, tipo: 'a_tienda', importe: 500 })));
  assert.equal((db.prepare('select count(*) as n from arqueos').get() as { n: number }).n, 1);
  assert.equal((db.prepare('select count(*) as n from dinero_movimientos').get() as { n: number }).n, 2);
  assert.equal((await saldo()).saldo.esperado, 3500);
});

test('sin rol dueno no se escribe (finanzas solo lee, sin lista de personal); sin migración responde 503 y gastos/nómina siguen guardando', async () => {
  const { pedir, como, db, arqueo, saldo } = await montarCaja();
  await arqueo(5000);
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('fin@prueba.mx', 'Fin', 'finanzas', 1, '', '')`).run();
  como('fin@prueba.mx');
  const lectura = await pedir('/api/dinero', undefined, 'GET');
  assert.equal(lectura.status, 200);
  assert.equal(lectura.cuerpo.puede_escribir, false);
  assert.equal(lectura.cuerpo.saldo.esperado, 5000);
  assert.deepEqual(lectura.cuerpo.tiendas.flatMap((t: any) => t.personal), []);
  const filas = () => (db.prepare('select (select count(*) from arqueos) + (select count(*) from dinero_movimientos) as n').get() as { n: number }).n;
  for (const [ruta, cuerpo, metodo] of [
    ['/api/dinero/arqueos', { id: crypto.randomUUID(), contado: 1 }, 'POST'],
    ['/api/dinero/movimientos', { id: crypto.randomUUID(), tipo: 'deposito', importe: 100 }, 'POST'],
    ['/api/dinero/recolecciones', { id: crypto.randomUUID(), tienda: 'soledad', cortes: [crypto.randomUUID()], contado: 1 }, 'POST'],
    ['/api/dinero/desde', { desde: '2020-01-01' }, 'PUT'],
  ] as const) assert.equal((await pedir(ruta, cuerpo, metodo)).status, 403, ruta);
  assert.equal(filas(), 1);
  como(DUENO);
  assert.equal((await saldo()).puede_escribir, true);

  // Código desplegado antes de la migración 090: /api/dinero conserva lo de la fase 1, lo nuevo responde 503 y gastos/nómina guardan como antes.
  db.exec('drop table arqueos; drop table dinero_movimientos; alter table gastos drop column pagado_con; alter table nomina_movimientos drop column pagado_con;');
  const vieja = await saldo();
  assert.deepEqual([vieja.caja_lista, vieja.saldo, vieja.puede_escribir], [false, null, true]);
  assert.ok(Array.isArray(vieja.tiendas) && Array.isArray(vieja.recolecciones) && vieja.desde);
  assert.equal((await pedir('/api/dinero/arqueos', { id: crypto.randomUUID(), contado: 1 })).status, 503);
  assert.equal((await pedir('/api/dinero/movimientos', { id: crypto.randomUUID(), tipo: 'deposito', importe: 100 })).status, 503);
  const g = await pedir('/api/gastos', { fecha: hoyTienda(), categoria: 'renta', importe: 1000, origen: 'fuera', pagado_con: 'banco' });
  assert.equal(g.status, 201, JSON.stringify(g.cuerpo));
  const lista = await pedir(`/api/gastos?mes=${hoyTienda().slice(0, 7)}`, undefined, 'GET');
  assert.equal(lista.status, 200);
  assert.equal(lista.cuerpo.gastos.length, 1);
  assert.equal(lista.cuerpo.gastos[0].pagado_con, '');
  const n = await pedir('/api/nomina/movimientos', { id: crypto.randomUUID(), empleado_id: EMPLEADO, tipo: 'adelanto', fecha: hoyTienda(), importe: 500, origen: 'fuera' });
  assert.equal(n.status, 201, JSON.stringify(n.cuerpo));
  assert.equal((await pedir(`/api/nomina/${EMPLEADO}/movimientos`, undefined, 'GET')).cuerpo.movimientos.length, 1);
});

test('«¿Con qué se pagó?»: efectivo por omisión con origen fuera, vacío con origen caja, valores raros se rechazan y el listado lo trae', async () => {
  const { pedir, gasto, nomina, db } = await montarCaja();
  const mes = hoyTienda().slice(0, 7);
  const a = await gasto({});
  const b = await gasto({ pagado_con: 'banco' });
  const c = await gasto({ origen: 'caja', caja: 'Caja 1', pagado_con: 'banco' });
  assert.deepEqual([a.status, b.status, c.status], [201, 201, 201]);
  assert.deepEqual([a.cuerpo.pagado_con, b.cuerpo.pagado_con, c.cuerpo.pagado_con], ['efectivo', 'banco', '']);
  assert.equal((await gasto({ pagado_con: 'cheque' })).status, 400);
  const guardado = (id: string) => (db.prepare('select pagado_con from gastos where id = ?').get(id) as { pagado_con: string }).pagado_con;
  assert.deepEqual([guardado(a.cuerpo.id), guardado(b.cuerpo.id), guardado(c.cuerpo.id)], ['efectivo', 'banco', '']);
  const lista = (await pedir(`/api/gastos?mes=${mes}`, undefined, 'GET')).cuerpo.gastos;
  assert.deepEqual(lista.map((g: any) => [g.id, g.pagado_con]).sort(), [[a.cuerpo.id, 'efectivo'], [b.cuerpo.id, 'banco'], [c.cuerpo.id, '']].sort());
  // Las columnas de siempre siguen ahí.
  assert.ok(['id', 'fecha', 'categoria', 'importe', 'nota', 'origen', 'retiro_id', 'caja', 'creado_por', 'creado_en', 'con_comprobante'].every((k) => k in lista[0]));

  assert.equal((await nomina({ tipo: 'devengo', origen: 'manual' })).status, 201);
  const fuera = await nomina({ tipo: 'adelanto', importe: 500, origen: 'fuera' });
  const banco = await nomina({ tipo: 'adelanto', importe: 500, origen: 'fuera', pagado_con: 'banco' });
  const caja = await nomina({ tipo: 'adelanto', importe: 500, origen: 'caja', caja: 'Caja 1', pagado_con: 'banco' });
  assert.deepEqual([fuera.cuerpo.pagado_con, banco.cuerpo.pagado_con, caja.cuerpo.pagado_con], ['efectivo', 'banco', '']);
  assert.equal((await nomina({ tipo: 'adelanto', importe: 500, origen: 'fuera', pagado_con: 'x' })).status, 400);
  const historial = (await pedir(`/api/nomina/${EMPLEADO}/movimientos`, undefined, 'GET')).cuerpo.movimientos;
  assert.deepEqual(historial.filter((m: any) => m.tipo === 'adelanto').map((m: any) => m.pagado_con).sort(), ['', 'banco', 'efectivo']);
  assert.equal(historial.find((m: any) => m.tipo === 'devengo').pagado_con, '');
});

test('GET /api/dinero: el personal de cada tienda no incluye a quien consulta, pero sí a su otro personal con PIN', async () => {
  const { pedir } = await montar();   // consulta gerencia (DUENO)
  const { tiendas } = (await pedir('/api/dinero', undefined, 'GET')).cuerpo;
  const personal = (clave: string) => tiendas.find((t: any) => t.clave === clave).personal.map((p: any) => p.correo);
  assert.equal(personal('soledad').includes(DUENO), false, 'quien consulta no se ofrece a sí mismo');
  assert.equal(personal('soledad').includes(ANA), true, 'la cajera de Soledad sigue');
  assert.equal(personal('salk').includes(DUENO), false, 'quien consulta no se ofrece a sí mismo en Salk');
  assert.equal(personal('salk').includes(SARA), true, 'la cajera de Salk sigue');
});
