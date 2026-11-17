// node --test src/ver-por-tienda.test.ts
// Sucursales 3/3 (#793, #798): ver y cuadrar por tienda. Con los datos de hoy (sin sucursales ni bultos) las cifras no cambian; con
// mercancía repartida entre Soledad, una sucursal y un bulto, el valor del inventario suma las tres y el desglose dice dónde está.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { calcularTablero } from './tablero.ts';
import { inventarioEnPiso } from './reportes.ts';

const PC_SALK = 'pcsalk@prueba.mx';
const PC_ROMERO = 'pcromero@prueba.mx';
const CAPTURISTA = 'cap@prueba.mx';
const DUENO_SALK = 'duenosalk@prueba.mx';
const ANA = 'ana@prueba.mx';
const PIN = '482913';
const PIEZA2 = 'b2222222-2222-4222-8222-222222222222';

function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values
    (?, 'PC Salk', 'computadora', 1, 'salk', '', ''), (?, 'PC Romero', 'computadora', 1, 'romero', '', ''),
    (?, 'Cap', 'capturista', 1, '', '', ''), (?, 'Dueño Salk', 'dueno', 1, 'salk', '', ''), (?, 'Ana', 'cajero', 1, '', '', '')`)
    .run(PC_SALK, PC_ROMERO, CAPTURISTA, DUENO_SALK, ANA);
  t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, categoria, semana_ingreso, creado_en, actualizado_en)
    values (?, 'ED-000002', 'Lámpara', 40000, 6, 'hogar', 'S40', '', '')`).run(PIEZA2);
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  const sesiones = new Map<string, string>();
  let conPin = false;
  const terminal = async (pc: string) => {
    if (!conPin) { como(DUENO); await t.pedir('/api/cuentas/pin', { correo: ANA, pin: PIN }, 'PUT'); conPin = true; }
    como(pc);
    // #850: la cajera solo vale en la tienda de su cuenta; estas pruebas la mueven de terminal, asi que su cuenta sigue a la computadora en turno.
    t.db.prepare('update usuarios set tienda = (select tienda from usuarios where correo = ?) where correo = ?').run(pc, ANA);
    const token = sesiones.get(pc) ?? (await t.pedir('/api/cajeros/entrar', { correo: ANA, pin: PIN })).cuerpo.token as string;
    sesiones.set(pc, token);
    return (ruta: string, cuerpo?: unknown, metodo = 'POST') => { como(pc); t.db.prepare('update usuarios set tienda = (select tienda from usuarios where correo = ?) where correo = ?').run(pc, ANA); return t.pedir(ruta, cuerpo, metodo, { 'x-cajero': token }); };
  };
  const yo = (correo: string) => (ruta: string, cuerpo?: unknown, metodo = 'POST') => { como(correo); return t.pedir(ruta, cuerpo, metodo); };
  /** Arma un bulto desde Soledad con `unidades` de la pieza; lo deja abierto, cerrado (en camino) o recibido. */
  const bulto = async (destino: 'salk' | 'romero', codigo: string, unidades: number, hasta: 'abierto' | 'cerrado' | 'recibido') => {
    const cap = yo(CAPTURISTA);
    const nuevo = await cap('/api/bultos', { id: crypto.randomUUID(), destino });
    assert.equal(nuevo.status, 201, JSON.stringify(nuevo.cuerpo));
    const folio = nuevo.cuerpo.folio as string;
    for (let i = 0; i < unidades; i += 1) assert.equal((await cap(`/api/bultos/${folio}/piezas`, { id: crypto.randomUUID(), codigo })).status, 201);
    if (hasta !== 'abierto') assert.equal((await cap(`/api/bultos/${folio}/cerrar`, {})).status, 200);
    if (hasta === 'recibido') {
      const pc = await terminal(destino === 'salk' ? PC_SALK : PC_ROMERO);
      assert.equal((await pc('/api/bultos/recibir', { folio })).status, 200);
    }
    return folio;
  };
  const reportes = async (consulta = '') => (await yo(DUENO)(`/api/reportes?dias=7${consulta}`, undefined, 'GET'));
  const stock = (id = PRODUCTO) => (t.db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock;
  return { ...t, como, terminal, yo, bulto, reportes, stock };
}

const unidades = (f: { unidades: number; valor: number }) => [f.unidades, f.valor];

test('con los datos de hoy (sin sucursales ni bultos) el inventario es exactamente lo de productos.stock y el desglose lo pone todo en Soledad', async () => {
  const m = montar();
  // La cuenta independiente de lo que hacía la consulta antes de #798: precio × stock de las piezas en piso.
  const esperado = m.db.prepare(`select count(*) as piezas, sum(stock) as unidades, sum(precio * stock) as valor from productos
    where sin_inventario = 0 and stock > 0 and destino = 'etiqueta' and codigo is not null and codigo != ''
      and propietario = 'dolaron' and estado_fisico <> 'caducado'`).get() as { piezas: number; unidades: number; valor: number };
  assert.ok(esperado.piezas >= 2 && esperado.unidades === 56, JSON.stringify(esperado));

  const r = await m.reportes();
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  const inv = r.cuerpo.inventario;
  assert.deepEqual([inv.piezas, inv.unidades, inv.valor], [esperado.piezas, esperado.unidades, esperado.valor]);
  assert.deepEqual(inv.por_tienda, {
    soledad: { unidades: 56, valor: esperado.valor },
    salk: { unidades: 0, valor: 0 }, romero: { unidades: 0, valor: 0 }, en_camino: { unidades: 0, valor: 0 },
  });
  assert.equal(inv.por_categoria.reduce((s: number, c: { valor: number }) => s + c.valor, 0), esperado.valor);

  const tablero = await calcularTablero(m.env);
  assert.deepEqual([tablero.inventario.piezas, tablero.inventario.valor], [esperado.unidades, esperado.valor], 'el tablero ve lo mismo que /reportes');
});

test('una pieza en Soledad, en una sucursal y en bultos (abierto y cerrado) vale lo mismo que antes de moverla; el desglose dice dónde está', async () => {
  const m = montar();
  const antes = (await m.reportes()).cuerpo.inventario;

  await m.bulto('salk', 'ED-000001', 10, 'recibido');    // en Avenida Salk
  await m.bulto('romero', 'ED-000001', 5, 'cerrado');     // en camino a Coronel Romero
  await m.bulto('salk', 'ED-000001', 2, 'abierto');       // se está armando: tampoco es de ninguna tienda
  await m.bulto('salk', 'ED-000002', 6, 'cerrado');       // la Lámpara sale toda de Soledad: Soledad se queda en 0 y NO desaparece del valor
  assert.deepEqual([m.stock(), m.stock(PIEZA2)], [33, 0]);

  const despues = (await m.reportes()).cuerpo.inventario;
  assert.deepEqual([despues.piezas, despues.unidades, despues.valor], [antes.piezas, antes.unidades, antes.valor], 'moverla no cambia lo que vale el negocio');
  assert.deepEqual(despues.por_categoria, antes.por_categoria);
  assert.deepEqual(despues.por_antiguedad, antes.por_antiguedad);
  assert.deepEqual(unidades(despues.por_tienda.soledad), [33, 33 * 25000]);
  assert.deepEqual(unidades(despues.por_tienda.salk), [10, 10 * 25000]);
  assert.deepEqual(unidades(despues.por_tienda.romero), [0, 0]);
  assert.deepEqual(unidades(despues.por_tienda.en_camino), [5 + 2 + 6, (5 + 2) * 25000 + 6 * 40000]);
  const suma = ['soledad', 'salk', 'romero', 'en_camino'].reduce((s, t) => ({ u: s.u + despues.por_tienda[t].unidades, v: s.v + despues.por_tienda[t].valor }), { u: 0, v: 0 });
  assert.deepEqual([suma.u, suma.v], [despues.unidades, despues.valor], 'el desglose suma el total');

  const tablero = await calcularTablero(m.env);
  assert.deepEqual([tablero.inventario.piezas, tablero.inventario.valor], [antes.unidades, antes.valor], '/tablero también cuenta sucursal y en camino');
  const directo = await inventarioEnPiso(m.env);
  assert.equal(directo.valor, antes.valor);
});

test('/api/piezas/:id y la búsqueda traen el desglose; filtrar por tienda trae solo lo que está ahí', async () => {
  const m = montar();
  await m.bulto('salk', 'ED-000001', 10, 'recibido');
  await m.bulto('romero', 'ED-000001', 5, 'cerrado');
  const dueno = m.yo(DUENO);
  const ficha = await dueno(`/api/piezas/${PRODUCTO}`, undefined, 'GET');
  assert.equal(ficha.status, 200, JSON.stringify(ficha.cuerpo));
  assert.deepEqual(ficha.cuerpo.existencia, { soledad: 35, sucursales: { salk: 10, romero: 0 }, en_camino: 5, total: 50 });
  assert.equal(ficha.cuerpo.pieza.stock, 35, 'stock sigue siendo lo de Soledad');
  assert.ok(ficha.cuerpo.movimientos_bulto.some((x: { tipo: string; folio: string; tienda: string }) => x.tipo === 'bulto_entrada' && /^BU-/.test(x.folio) && x.tienda === 'salk'));
  assert.ok(ficha.cuerpo.movimientos_bulto.some((x: { tipo: string; tienda: string }) => x.tipo === 'bulto_salida' && x.tienda === 'soledad'));

  const lista = (consulta: string) => dueno(`/api/piezas?${consulta}`, undefined, 'GET');
  const sinFiltro = await lista('');
  assert.deepEqual(sinFiltro.cuerpo.piezas.find((p: { id: string }) => p.id === PRODUCTO).existencia.total, 50);
  const ids = async (consulta: string) => (await lista(consulta)).cuerpo.piezas.map((p: { id: string }) => p.id).sort();
  assert.deepEqual(await ids('tienda=salk'), [PRODUCTO]);
  assert.deepEqual(await ids('tienda=romero'), [], 'lo de Romero aún va en camino: no es de ninguna tienda');
  assert.deepEqual(await ids('tienda=en_camino'), [PRODUCTO]);
  assert.deepEqual(await ids('tienda=soledad'), [PRODUCTO, PIEZA2].sort());
  assert.equal((await lista('tienda=narnia')).status, 400);
  assert.equal((await dueno(`/api/piezas?q=ED-000001&tienda=salk`, undefined, 'GET')).cuerpo.piezas.length, 1);
  assert.equal((await dueno(`/api/piezas?q=ED-000002&tienda=salk`, undefined, 'GET')).cuerpo.piezas.length, 0);
});

test('/reportes filtra las ventas por tienda y el negocio completo es la suma; con ventas solo de Soledad, filtrar Soledad da lo mismo que no filtrar', async () => {
  const m = montar();
  await m.bulto('salk', 'ED-000001', 4, 'recibido');
  const salk = await m.terminal(PC_SALK);
  assert.equal((await salk('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], forma_pago: 'efectivo', efectivo: 50000, caja: 'Salk 1' })).status, 201);
  // Una venta de Soledad por dueño (Caja 1).
  const dueno = m.yo(DUENO);
  assert.equal((await dueno('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }, { producto_id: PIEZA2, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 65000, caja: 'Caja 1' })).status, 201);

  const todo = (await m.reportes()).cuerpo, deSalk = (await m.reportes('&tienda=salk')).cuerpo;
  const deSoledad = (await m.reportes('&tienda=soledad')).cuerpo, deRomero = (await m.reportes('&tienda=romero')).cuerpo;
  assert.equal(todo.tienda, '');
  assert.deepEqual(todo.tiendas.map((x: { clave: string }) => x.clave), ['soledad', 'salk', 'romero']);
  assert.equal(deSalk.tienda, 'salk');
  assert.deepEqual([deSalk.resumen.ventas, deSalk.resumen.total, deSalk.resumen.piezas], [1, 50000, 2]);
  assert.deepEqual([deSoledad.resumen.ventas, deSoledad.resumen.total, deSoledad.resumen.piezas], [1, 65000, 2]);
  assert.deepEqual([deRomero.resumen.ventas, deRomero.resumen.total], [0, 0]);
  assert.equal(todo.resumen.total, deSalk.resumen.total + deSoledad.resumen.total + deRomero.resumen.total, 'el total del negocio es la suma de las tiendas');
  assert.equal(todo.resumen.ventas, 2);
  assert.equal(deSalk.cuadre.vendido + deSoledad.cuadre.vendido, todo.cuadre.vendido);
  assert.deepEqual(deSalk.top_productos.map((x: { codigo: string; cantidad: number }) => [x.codigo, x.cantidad]), [['ED-000001', 2]]);
  assert.equal(deSalk.por_dia.reduce((s: number, d: { total: number }) => s + d.total, 0), 50000);
  // El inventario es la foto del negocio: no depende del filtro.
  assert.deepEqual(deSalk.inventario, todo.inventario);
  assert.equal((await m.reportes('&tienda=narnia')).status, 400);

  // La lista de tickets filtra igual, y cada ticket dice su tienda.
  const tickets = (consulta: string) => dueno(`/api/reportes/tickets?dias=7${consulta}`, undefined, 'GET');
  const t0 = (await tickets('')).cuerpo, t1 = (await tickets('&tienda=salk')).cuerpo;
  assert.equal(t0.tickets.length, 2);
  assert.deepEqual(t1.tickets.map((x: { tienda: string; caja: string }) => [x.tienda, x.caja]), [['salk', 'Salk 1']]);
  assert.equal(t1.resumen.vendido, 50000);
});

test('filtrar por tienda acota también cortes, retiros y cajón a las cajas de esa tienda', async () => {
  const m = montar();
  m.db.prepare(`insert into retiros (id, creado_en, tipo, caja, cajero, importe, motivo) values (?, ?, 'retiro', ?, 'x', 100, 'm'), (?, ?, 'retiro', ?, 'x', 200, 'm')`)
    .run(crypto.randomUUID(), new Date().toISOString(), 'Caja 2', crypto.randomUUID(), new Date().toISOString(), 'Salk 2');
  const caja = async (consulta: string) => (await m.reportes(consulta)).cuerpo.retiros.map((x: { caja: string }) => x.caja).sort();
  assert.deepEqual(await caja(''), ['Caja 2', 'Salk 2']);
  assert.deepEqual(await caja('&tienda=salk'), ['Salk 2']);
  assert.deepEqual(await caja('&tienda=soledad'), ['Caja 2']);
});

test('conteo de una sucursal: cuenta SU existencia, ajusta sobre ella con rastro y con su tienda, y no toca productos.stock', async () => {
  const m = montar();
  m.db.prepare("update productos set precio = 40000 where id = ?").run(PRODUCTO);   // sobre el umbral de $300
  await m.bulto('salk', 'ED-000001', 4, 'recibido');
  const soledadAntes = m.stock();
  assert.equal(soledadAntes, 46);

  const salk = m.yo(DUENO_SALK);
  const lista = await salk('/api/conteo', undefined, 'GET');
  assert.equal(lista.status, 200, JSON.stringify(lista.cuerpo));
  assert.deepEqual(lista.cuerpo.map((p: { id: string; stock: number }) => [p.id, p.stock]), [[PRODUCTO, 4]], 'solo lo que hay en Salk, con la existencia de Salk');
  const soledad = await m.yo(DUENO)('/api/conteo', undefined, 'GET');
  assert.ok(soledad.cuerpo.some((p: { id: string; stock: number }) => p.id === PRODUCTO && p.stock === 46), 'Soledad sin cambio');

  const falta = await salk('/api/conteo', { conteos: [{ producto_id: PRODUCTO, contado: 3 }] });
  assert.deepEqual(falta.cuerpo.faltantes.map((f: { sistema: number; contado: number; faltan: number }) => [f.sistema, f.contado, f.faltan]), [[4, 3, 1]]);

  const folio = crypto.randomUUID();
  const ajuste = await salk('/api/conteo/ajustes', { id: folio, producto_id: PRODUCTO, cantidad: 1, esperado: 4, motivo: 'robo' });
  assert.equal(ajuste.status, 201, JSON.stringify(ajuste.cuerpo));
  assert.deepEqual([ajuste.cuerpo.antes, ajuste.cuerpo.despues, ajuste.cuerpo.tienda], [4, 3, 'salk']);
  assert.equal(m.stock(), soledadAntes, 'productos.stock no se movió');
  assert.equal((m.db.prepare("select unidades from existencia_tienda where tienda = 'salk' and producto_id = ?").get(PRODUCTO) as { unidades: number }).unidades, 3);
  const renglon = m.db.prepare('select tienda, antes, despues, motivo, ajustado_por from conteo_ajustes where id = ?').get(folio);
  assert.deepEqual({ ...renglon }, { tienda: 'salk', antes: 4, despues: 3, motivo: 'robo', ajustado_por: DUENO_SALK });

  const repetido = await salk('/api/conteo/ajustes', { id: folio, producto_id: PRODUCTO, cantidad: 1, esperado: 4, motivo: 'robo' });
  assert.equal(repetido.status, 200, 'el mismo folio no descuenta dos veces');
  assert.equal((m.db.prepare("select unidades from existencia_tienda where tienda = 'salk'").get() as { unidades: number }).unidades, 3);
  const viejo = await salk('/api/conteo/ajustes', { id: crypto.randomUUID(), producto_id: PRODUCTO, cantidad: 1, esperado: 4, motivo: 'merma' });
  assert.equal(viejo.status, 409, 'lo que vio quien cuenta ya no es lo que hay');
  const demas = await salk('/api/conteo/ajustes', { id: crypto.randomUUID(), producto_id: PRODUCTO, cantidad: 9, esperado: 3, motivo: 'merma' });
  assert.equal(demas.status, 409);
  assert.equal(m.stock(), soledadAntes);
  assert.equal((await m.yo(CAPTURISTA)('/api/conteo/ajustes', { id: crypto.randomUUID(), producto_id: PRODUCTO, cantidad: 1, esperado: 3, motivo: 'merma' })).status, 403, 'ajustar sigue siendo del dueño');
});

test('conteo de Soledad sin cambio: ajusta productos.stock y el rastro queda como de Soledad', async () => {
  const m = montar();
  m.db.prepare("update productos set precio = 40000 where id = ?").run(PRODUCTO);
  const folio = crypto.randomUUID();
  const r = await m.yo(DUENO)('/api/conteo/ajustes', { id: folio, producto_id: PRODUCTO, cantidad: 2, esperado: 50, motivo: 'merma' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.deepEqual([r.cuerpo.antes, r.cuerpo.despues, 'tienda' in r.cuerpo], [50, 48, false], 'la respuesta no gana campos para Soledad');
  assert.equal(m.stock(), 48);
  assert.equal((m.db.prepare('select tienda from conteo_ajustes where id = ?').get(folio) as { tienda: string }).tienda, 'soledad');
});

test('ajuste de faltante en una sucursal sobre un bulto recibido: la pantalla trae lo que hay ahora, el ajuste deja rastro con su tienda y Soledad no se mueve', async () => {
  const m = montar();
  const folio = await m.bulto('salk', 'ED-000001', 5, 'recibido');
  const dueno = m.yo(DUENO);
  const bulto = (await dueno(`/api/bultos/${folio}`, undefined, 'GET')).cuerpo;
  assert.ok(bulto.lineas.length > 0 && bulto.lineas.every((l: { existencia_destino: number }) => l.existencia_destino === 5), 'cada línea trae la existencia actual de Salk');
  const abierto = await m.yo(CAPTURISTA)('/api/bultos', { id: crypto.randomUUID(), destino: 'romero' });
  assert.equal((await dueno(`/api/bultos/${abierto.cuerpo.folio}`, undefined, 'GET')).cuerpo.lineas.length, 0, 'un bulto que no está recibido no trae el campo');

  const soledadAntes = m.stock();
  const id = crypto.randomUUID();
  const ajuste = await dueno(`/api/piezas/${PRODUCTO}/existencia`, { id, tienda: 'salk', fijar_a: 3, esperado: 5, motivo: 'correccion' });
  assert.equal(ajuste.status, 200, JSON.stringify(ajuste.cuerpo));
  assert.equal(m.stock(), soledadAntes);
  assert.equal((m.db.prepare("select unidades from existencia_tienda where tienda = 'salk' and producto_id = ?").get(PRODUCTO) as { unidades: number }).unidades, 3);
  assert.deepEqual({ ...(m.db.prepare('select tienda, antes, despues, motivo, ajustado_por from conteo_ajustes where id = ?').get(id) as object) },
    { tienda: 'salk', antes: 5, despues: 3, motivo: 'correccion', ajustado_por: DUENO });
  const repetido = await dueno(`/api/piezas/${PRODUCTO}/existencia`, { id, tienda: 'salk', fijar_a: 3, esperado: 5, motivo: 'correccion' });
  assert.equal(repetido.status, 200);
  assert.equal((m.db.prepare("select unidades from existencia_tienda where tienda = 'salk' and producto_id = ?").get(PRODUCTO) as { unidades: number }).unidades, 3, 'reintentar no descuenta dos veces');
  const ficha = (await dueno(`/api/piezas/${PRODUCTO}`, undefined, 'GET')).cuerpo;
  assert.equal(ficha.tienda_de_ajustes[id], 'salk', 'la ficha dice en qué tienda fue el ajuste');
  assert.equal('tienda' in ficha.historial.find((h: { id: string }) => h.id === id), false, 'los renglones del historial conservan su forma');
  assert.deepEqual(ficha.existencia, { soledad: 45, sucursales: { salk: 3, romero: 0 }, en_camino: 0, total: 48 });
  assert.equal((await m.yo(CAPTURISTA)(`/api/piezas/${PRODUCTO}/existencia`, { id: crypto.randomUUID(), tienda: 'salk', fijar_a: 0, esperado: 3, motivo: 'correccion' })).status, 403, 'solo el dueño ajusta una sucursal');
});

test('inventario.csv: con los datos de hoy `stock` es lo de siempre; con mercancía repartida `stock` es el total y las columnas nuevas dicen dónde está', async () => {
  const m = montar();
  const csv = async () => {
    m.como(DUENO);
    const r = await m.enviar('/api/reportes/inventario.csv', undefined, 'GET');
    assert.equal(r.status, 200);
    const [cabecera, ...filas] = (await r.text()).trim().split('\r\n').map((l) => l.split(','));
    const fila = (nombre: string) => Object.fromEntries(cabecera.map((c, i) => [c, filas.find((f) => f[1]?.includes(nombre))?.[i]]));
    return { cabecera, fila };
  };
  const antes = await csv();
  assert.deepEqual(antes.cabecera.slice(-4), ['en_soledad', 'en_salk', 'en_romero', 'en_camino'], 'las columnas nuevas van al final');
  assert.deepEqual([antes.fila('Ventilador').stock, antes.fila('Ventilador').en_soledad, antes.fila('Ventilador').en_salk], ['50', '50', '0']);
  await m.bulto('salk', 'ED-000001', 10, 'recibido');
  await m.bulto('romero', 'ED-000001', 5, 'cerrado');
  const despues = (await csv()).fila('Ventilador');
  assert.deepEqual([despues.stock, despues.en_soledad, despues.en_salk, despues.en_romero, despues.en_camino], ['50', '35', '10', '0', '5']);
});
