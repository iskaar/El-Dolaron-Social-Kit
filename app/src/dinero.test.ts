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
