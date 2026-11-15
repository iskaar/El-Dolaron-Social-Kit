// node --test src/reportes-finanzas.test.ts
// Vista Finanzas de /reportes (Issue #802): el endpoint contra el doble de D1, cuadrado con /api/reportes y con Resumen, la comision de
// la terminal y las funciones puras.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import { hoyTienda } from './reportes.ts';
import { GASTOS_Y_NOMINA } from './reportes-finanzas.ts';
import { permiso, puede, type Usuario } from './cuentas.ts';
import { sumarDias } from '../public/graficas.js';
import { tarjetasHtml } from '../public/reportes-resumen.js';
import {
  armarFinanzas, etiquetaMes, tituloMes, ordenGastos, nombreGasto, validarComisionPct, comisionDe, bpDeConfig, configInvalida, textoPct,
  tarjetasFinanzas, estadoHtml, notaEstado, graficas, graficaCortes, tablaCortes, tablaGastos, tablaPago, textoDiferencia, resumenCortesHtml,
  comisionHtml, LIMITE_COMISION_BP, CLAVE_COMISION, MAX_CATEGORIAS,
} from '../public/reportes-finanzas.js';

type T = ReturnType<typeof tienda>;
const suma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const llamar = (t: T, ruta: string, consulta: string) => t.pedir(`/api/reportes/${ruta}?${consulta}`, undefined, 'GET');
const finanzas = (t: T, consulta: string) => llamar(t, 'finanzas', consulta);

let consecutivo = 0;
/** Una venta de `piezas` ventiladores ($250 c/u) en `dia` (dia de la tienda), con la forma de pago dada. */
async function vender(t: T, dia: string, piezas = 1, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: piezas }], forma_pago: 'efectivo', efectivo: 25000 * piezas, caja: 'Caja 1', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const cuando = `${dia}T${String(15 + (consecutivo++ % 5)).padStart(2, '0')}:00:00.000Z`;   // 09:00 a 13:00 de la tienda: siempre el mismo dia
  t.db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(cuando, cuando, id);
  return id;
}
const gasto = (t: T, fecha: string, categoria: string, importe: number, origen = 'fuera', retiroId: string | null = null) =>
  t.db.prepare("insert into gastos (id, fecha, categoria, importe, nota, origen, retiro_id, creado_por, creado_en) values (?, ?, ?, ?, '', ?, ?, 'x', '')")
    .run(crypto.randomUUID(), fecha, categoria, importe, origen, retiroId);
const retiro = (t: T, id: string, tipo: string, dia: string, importe: number, categoria = '', caja = 'Caja 1') =>
  t.db.prepare("insert into retiros (id, tipo, caja, cajero, importe, motivo, corte_id, creado_en, categoria) values (?, ?, ?, 'c@prueba.mx', ?, 'm', null, ?, ?)")
    .run(id, tipo, caja, importe, `${dia}T18:00:00.000Z`, categoria);
const movimiento = (t: T, id: string, fecha: string, tipo: string, importe: number) =>
  t.db.prepare("insert into nomina_movimientos (id, empleado_id, fecha, tipo, importe, creado_por, creado_en) values (?, 'e1', ?, ?, ?, 'x', '')").run(id, fecha, tipo, importe);
const corte = (t: T, caja: string, dia: string, hora: string, diferencia: number) =>
  t.db.prepare(`insert into cortes (id, caja, cajero, desde, hasta, tickets, fondo_inicial, efectivo_ventas, efectivo_devoluciones, retiros, efectivo_esperado, efectivo_contado,
    diferencia, tarjeta_sistema, tarjeta_terminal, transferencias, dolarones, fondo_siguiente, entregado, creado_en)
    values (?, ?, 'c@prueba.mx', null, ?, 1, 0, 0, 0, 0, 0, 0, ?, 0, 0, 0, 0, 0, 0, '')`).run(crypto.randomUUID(), caja, `${dia}T${hora}:00.000Z`, diferencia);

/** Un periodo que cruza un limite de mes: los ultimos 3 dias del mes pasado hasta hoy, con de todo. */
function periodoCruzado() {
  const hoy = hoyTienda(), primero = `${hoy.slice(0, 8)}01`;
  const desde = sumarDias(primero, -3);
  return { hoy, primero, desde, ultimoMesPasado: sumarDias(primero, -1) };
}

async function sembrar(t: T) {
  t.db.prepare('update productos set stock = 100000 where id = ?').run(PRODUCTO);
  t.db.prepare("insert into empleados (id, nombre, periodo, pago_dia, creado_en) values ('e1', 'E', 'diario', 30000, '')").run();
  const { hoy, primero, desde, ultimoMesPasado } = periodoCruzado();
  // Ventas: 2 piezas el penultimo dia del mes pasado, 1 el ultimo, 3 el primero de este mes y 1 hoy (a veces el primero es hoy: se suma).
  await vender(t, sumarDias(ultimoMesPasado, -1), 2);
  await vender(t, ultimoMesPasado, 1, { forma_pago: 'tarjeta', tarjeta: 25000, efectivo: 0 });
  await vender(t, primero, 3);
  await vender(t, hoy, 1, { forma_pago: 'transferencia', efectivo: 0 });
  // Gastos: del mes pasado y de este mes; «otros» y sin categoria tal cual; un gasto de caja que esta en las dos tablas; inversionistas.
  gasto(t, ultimoMesPasado, 'renta', 100000);
  gasto(t, primero, 'luz', 30000);
  gasto(t, primero, 'otros', 5000);
  gasto(t, primero, 'inversionistas', 999000);
  retiro(t, 'rg1', 'gasto', ultimoMesPasado, 2000, 'limpieza');             // solo en retiros: cuenta una vez
  retiro(t, 'rg2', 'gasto', primero, 1500, 'limpieza');                     // en retiros Y en gastos: una sola vez
  gasto(t, primero, 'limpieza', 1500, 'caja', 'rg2');
  retiro(t, 'rg3', 'gasto', primero, 700, '');                              // gasto de caja sin categoria
  // Nomina pagada (el libro guarda el pago en negativo; el devengo no es dinero pagado).
  movimiento(t, 'm1', ultimoMesPasado, 'adelanto', 20000);
  movimiento(t, 'm2', primero, 'pago', -80000);
  movimiento(t, 'm3', primero, 'devengo', 90000);
  // Retiros de caja sin clasificar: dinero que salio del cajon sin decir para que.
  retiro(t, 'rs1', 'retiro', ultimoMesPasado, 30000);
  retiro(t, 'rs2', 'retiro', primero, 12000);
  retiro(t, 'rs3', 'retiro', primero, 9000);
  gasto(t, primero, 'limpieza', 9000, 'caja', 'rs3');                       // con fila en gastos: ya esta clasificado
  // Cortes: uno de cada tipo.
  corte(t, 'Caja 1', ultimoMesPasado, '20:00:00', -3500);
  corte(t, 'Caja 1', primero, '20:00:00', 1200);
  corte(t, 'Caja 2', primero, '20:30:00', 0);
  corte(t, 'Salk 1', primero, '21:00:00', 800);
  return { hoy, primero, desde, ultimoMesPasado };
}

/* ---------- el endpoint ---------- */

test('el estado de resultados cuadra: ventas por mes con /api/reportes, gastos y retiros con Resumen, y las columnas con el acumulado', async () => {
  const t = tienda();
  const { hoy, primero, desde, ultimoMesPasado } = await sembrar(t);
  const q = `desde=${desde}&hasta=${hoy}`;
  const f = (await finanzas(t, q)).cuerpo;
  const R = (await llamar(t, 'resumen', q)).cuerpo;
  assert.equal(f.meses.length, 2);
  assert.deepEqual(f.meses.map((m: any) => [m.desde, m.hasta]), [[desde, ultimoMesPasado], [primero, hoy]]);

  // Cada columna de ventas = lo que dice /api/reportes para el rango de ESE mes.
  for (const [i, m] of f.meses.entries()) {
    const viejo = (await t.pedir(`/api/reportes?desde=${m.desde}&hasta=${m.hasta}`, undefined, 'GET')).cuerpo;
    assert.equal(f.estado.ventas[i], viejo.resumen.total, `ventas ${m.desde}`);
  }
  const viejoTodo = (await t.pedir(`/api/reportes?${q}`, undefined, 'GET')).cuerpo;
  assert.equal(f.totales.ventas, viejoTodo.resumen.total);

  // Las columnas suman el acumulado, en cada fila.
  assert.equal(suma(f.estado.ventas), f.totales.ventas);
  assert.equal(suma(f.estado.total_gastos), f.totales.gastos);
  assert.equal(suma(f.estado.inversionistas), f.totales.inversionistas);
  assert.equal(suma(f.estado.sin_clasificar), f.totales.sin_clasificar);
  for (const g of f.estado.gastos) assert.equal(suma(g.valores), g.total, g.categoria);
  assert.equal(suma(f.estado.gastos.map((g: any) => g.total)), f.totales.gastos, 'las categorias suman el total de gastos');
  for (const [i] of f.meses.entries()) assert.equal(suma(f.estado.gastos.map((g: any) => g.valores[i])), f.estado.total_gastos[i], `mes ${i}`);

  // El total de gastos y los retiros sin clasificar son los de Resumen para el mismo rango; las cubetas, las mismas.
  assert.equal(f.totales.gastos, R.totales.gastos);
  assert.deepEqual(f.retiros_sin_clasificar, R.retiros_sin_clasificar);
  assert.equal(f.totales.ventas, R.totales.ventas);
  assert.deepEqual(f.cubetas.map((c: any) => [c.desde, c.hasta, c.ventas, c.gastos]), R.cubetas.map((c: any) => [c.desde, c.hasta, c.ventas, c.gastos]));
  assert.equal(f.anterior.ventas, R.anterior.ventas);
  assert.equal(f.anterior.gastos, R.anterior.gastos);
  assert.equal(f.grano, R.grano);
  assert.deepEqual(f.comparacion, R.comparacion);
  t.db.close();
});

test('las definiciones: un gasto de caja cuenta una vez, inversionistas y retiros sin clasificar nunca son gasto, la nomina pagada si', async () => {
  const t = tienda();
  const { hoy, primero, desde } = await sembrar(t);
  const f = (await finanzas(t, `desde=${desde}&hasta=${hoy}&comparar=ninguna`)).cuerpo;
  const por = Object.fromEntries(f.estado.gastos.map((g: any) => [g.categoria, g.total]));
  assert.equal(por.limpieza, 2000 + 1500 + 9000, 'el de caja en las dos tablas cuenta una vez; el retiro con fila en gastos tambien');
  assert.equal(por.renta, 100000);
  assert.equal(por.luz, 30000);
  assert.equal(por.otros, 5000, '«Otros» se muestra tal cual');
  assert.equal(por.sin_categoria, 700, 'el gasto de caja sin categoria no se esconde');
  assert.equal(por.nomina, 20000 + 80000, 'adelantos y pagos; el devengo no es dinero pagado');
  assert.equal(por.inversionistas, undefined, 'inversionistas no es una fila de gasto');
  assert.equal(f.totales.inversionistas, 999000);
  assert.equal(f.totales.gastos, 2000 + 1500 + 9000 + 100000 + 30000 + 5000 + 700 + 100000);
  assert.deepEqual(f.retiros_sin_clasificar, { n: 2, importe: 30000 + 12000 });   // rs3 tiene fila en gastos
  // Las filas salen en orden: nomina, categorias.js, desconocidas y sin categoria al final.
  assert.deepEqual(f.estado.gastos.map((g: any) => g.categoria), ['nomina', 'limpieza', 'renta', 'luz', 'otros', 'sin_categoria']);
  // Ni los retiros sin clasificar ni los inversionistas estan en lo que se dibuja como gasto.
  const dibujado = suma(f.gastos_tiempo.map((c: any) => c.total));
  assert.equal(dibujado, f.totales.gastos);
  assert.ok(!f.gastos_tiempo.some((c: any) => c.categoria === 'inversionistas'));
  assert.equal(primero.length, 10);
  t.db.close();
});

test('un periodo que cruza el limite de mes pone una columna por mes y marca el mes cortado con sus dias', async () => {
  const t = tienda();
  const { hoy, primero, desde } = await sembrar(t);
  const f = (await finanzas(t, `desde=${desde}&hasta=${hoy}`)).cuerpo;
  assert.equal(f.meses[0].parcial, true);          // los ultimos 3 dias del mes pasado
  assert.equal(f.meses[0].dias, 3);
  assert.match(etiquetaMes(f.meses[0]), /^[a-zñ]{3,4} \d+–\d+$/);
  const ultimoDia = new Date(Date.UTC(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)), 0)).getUTCDate();
  assert.equal(f.meses[1].parcial, hoy !== `${primero.slice(0, 8)}${String(ultimoDia).padStart(2, '0')}`);
  assert.match(tituloMes(f.meses[0]), /parcial: 3 días/);
  t.db.close();
});

test('un mes entero tiene su etiqueta con el anio y un solo dia, solo el numero', () => {
  assert.equal(etiquetaMes({ desde: '2026-10-01', hasta: '2026-10-31', dias: 31, parcial: false }), 'oct 2026');
  assert.equal(etiquetaMes({ desde: '2026-11-01', hasta: '2026-11-15', dias: 15, parcial: true }), 'nov 1–15');
  assert.equal(etiquetaMes({ desde: '2026-11-15', hasta: '2026-11-15', dias: 1, parcial: true }), 'nov 15');
  assert.equal(etiquetaMes({ desde: '2026-09-20', hasta: '2026-09-30', dias: 11, parcial: true }), 'sep 20–30');
});

test('un rango pasado y cerrado solo trae lo suyo', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100000 where id = ?').run(PRODUCTO);
  t.db.prepare("insert into empleados (id, nombre, periodo, pago_dia, creado_en) values ('e1', 'E', 'diario', 30000, '')").run();
  await vender(t, '2026-08-31', 4);          // antes del rango
  await vender(t, '2026-09-10', 2);
  await vender(t, '2026-09-30', 1);
  await vender(t, '2026-10-01', 5);          // despues del rango
  gasto(t, '2026-08-31', 'renta', 11111);
  gasto(t, '2026-09-15', 'renta', 22222);
  gasto(t, '2026-10-01', 'renta', 33333);
  gasto(t, '2026-09-20', 'inversionistas', 44444);
  retiro(t, 'p1', 'retiro', '2026-09-12', 5000);
  retiro(t, 'p2', 'retiro', '2026-10-01', 6000);
  movimiento(t, 'n1', '2026-09-30', 'pago', -7000);
  movimiento(t, 'n2', '2026-10-01', 'pago', -8000);
  corte(t, 'Caja 1', '2026-09-30', '23:00:00', -500);   // 17:00 de la tienda
  corte(t, 'Caja 1', '2026-10-01', '20:00:00', 900);
  const f = (await finanzas(t, 'desde=2026-09-01&hasta=2026-09-30&comparar=ninguna')).cuerpo;
  assert.equal(f.meses.length, 1);
  assert.equal(f.meses[0].parcial, false);
  assert.equal(etiquetaMes(f.meses[0]), 'sep 2026');
  assert.equal(f.totales.ventas, 3 * 25000);
  assert.equal(f.totales.gastos, 22222 + 7000);
  assert.equal(f.totales.inversionistas, 44444);
  assert.deepEqual(f.retiros_sin_clasificar, { n: 1, importe: 5000 });
  assert.equal(f.anterior, null);
  assert.equal(f.comparacion, null);
  assert.deepEqual(f.efectivo.cortes.map((c: any) => c.diferencia), [-500]);
  const viejo = (await t.pedir('/api/reportes?desde=2026-09-01&hasta=2026-09-30', undefined, 'GET')).cuerpo;
  assert.equal(f.estado.ventas[0], viejo.resumen.total);
  assert.equal(viejo.cortes.length, 1);
  t.db.close();
});

test('un periodo vacio se calcula sin romperse: todo en cero y sin inventar filas', async () => {
  const t = tienda();
  const f = (await finanzas(t, 'dias=7')).cuerpo;
  assert.equal(f.totales.ventas, 0);
  assert.equal(f.totales.gastos, 0);
  assert.deepEqual(f.retiros_sin_clasificar, { n: 0, importe: 0 });
  assert.deepEqual(f.estado.gastos, []);
  assert.deepEqual(f.gastos_tiempo, []);
  assert.deepEqual(f.efectivo.cortes, []);
  assert.equal(f.efectivo.resumen.n, 0);
  assert.equal(f.terminal.comision, null);
  assert.equal(f.cubetas.length, 7);
  // Y la pantalla lo dice en lugar de dibujar ejes sin sentido.
  const g = graficas(f, () => 600);
  assert.match(g.gastos, /Sin gastos/);
  assert.match(g.pago, /Sin cobros/);
  assert.match(g.cortes, /Sin cortes/);
  assert.match(estadoHtml(f), /Sin gastos en el periodo/);
  assert.equal(resumenCortesHtml(f), '');
  assert.ok(tarjetasHtml(tarjetasFinanzas(f)).includes('Resultado operativo'));
  t.db.close();
});

test('lo cobrado por forma de pago es el de /api/reportes y los cortes traen su diferencia', async () => {
  const t = tienda();
  const { hoy, desde } = await sembrar(t);
  const f = (await finanzas(t, `desde=${desde}&hasta=${hoy}`)).cuerpo;
  const viejo = (await t.pedir(`/api/reportes?desde=${desde}&hasta=${hoy}`, undefined, 'GET')).cuerpo;
  const total = new Map<string, number>(viejo.por_forma_pago.map((x: any) => [x.forma_pago, x.total]));
  for (const p of f.pago) assert.equal(p.total, total.get(p.clave) ?? 0, p.clave);
  assert.equal(f.pago.find((p: any) => p.clave === 'tarjeta').total, 25000);
  assert.deepEqual(f.pago.map((p: any) => p.clave), ['efectivo', 'tarjeta', 'transferencia']);
  for (const p of f.pago) assert.equal(suma(p.valores), p.total);

  // Cortes: los mismos que /api/reportes y el resumen cuenta sobrantes, faltantes y exactos.
  assert.equal(f.efectivo.cortes.length, viejo.cortes.length);
  assert.deepEqual(f.efectivo.cortes.map((c: any) => c.diferencia).sort((a: number, b: number) => a - b), [-3500, 0, 800, 1200]);
  assert.deepEqual(f.efectivo.resumen, { n: 4, exactos: 1, n_sobrante: 2, sobrante: 2000, n_faltante: 1, faltante: -3500, neto: -1500 });
  assert.equal(f.efectivo.resumen.sobrante + f.efectivo.resumen.faltante, f.efectivo.resumen.neto);
  t.db.close();
});

test('con una tienda: ventas, cortes y formas de pago se acotan; gastos, nomina, retiros e inversionistas no se inventan por tienda', async () => {
  const t = tienda();
  const { hoy, desde, primero } = await sembrar(t);
  t.db.prepare("update ventas set tienda = 'salk' where id = (select id from ventas order by creado_en desc limit 1)").run();
  const todo = (await finanzas(t, `desde=${desde}&hasta=${hoy}`)).cuerpo;
  const salk = (await finanzas(t, `desde=${desde}&hasta=${hoy}&tienda=salk`)).cuerpo;
  assert.equal(salk.tienda, 'salk');
  assert.equal(salk.totales.ventas, 25000);
  assert.ok(todo.totales.ventas > salk.totales.ventas);
  assert.equal(salk.totales.gastos, null);
  assert.equal(salk.totales.inversionistas, null);
  assert.equal(salk.retiros_sin_clasificar, null);
  assert.equal(salk.cubetas[0].gastos, null);
  assert.equal(salk.estado.total_gastos, undefined);
  assert.deepEqual(salk.efectivo.cortes.map((c: any) => c.caja), ['Salk 1']);
  assert.equal(salk.pago.find((p: any) => p.clave === 'tarjeta').total, 0);
  assert.ok(todo.totales.gastos > 0);
  assert.match(estadoHtml(salk), /son de todo el negocio y no se calculan por tienda/);
  assert.match(tarjetasHtml(tarjetasFinanzas(salk)), /Es del negocio completo/);
  assert.match(graficas(salk, () => 600).gastos, /negocio completo/);
  assert.equal(notaEstado(salk), '');
  assert.equal((await finanzas(t, 'dias=7&tienda=narnia')).status, 400);
  assert.equal((await finanzas(t, 'dias=7&comparar=nunca')).status, 400);
  assert.equal((await finanzas(t, 'dias=7&grano=hora')).status, 400);
  assert.equal(primero.length, 10);
  t.db.close();
});

test('comision de la terminal: sin porcentaje no hay estimacion; con el, ventas con tarjeta por el porcentaje y sin tocar los gastos', async () => {
  const t = tienda();
  const { hoy, desde } = await sembrar(t);
  const q = `desde=${desde}&hasta=${hoy}`;
  const sin = (await finanzas(t, q)).cuerpo;
  assert.equal(sin.terminal.tarjeta, 25000);
  assert.equal(sin.terminal.comision_bp, null);
  assert.equal(sin.terminal.comision, null);
  assert.match(comisionHtml(sin), /Opcional/);
  assert.doesNotMatch(comisionHtml(sin), /Comisión estimada/);

  assert.equal((await t.pedir('/api/config', { [CLAVE_COMISION]: 350 }, 'PUT')).status, 200);
  const con = (await finanzas(t, q)).cuerpo;
  assert.equal(con.terminal.comision_bp, 350);
  assert.equal(con.terminal.comision, 875);                      // $250.00 x 3.50 % = $8.75
  assert.match(comisionHtml(con), /Comisión estimada de la terminal \(3\.50 %\)/);
  assert.match(comisionHtml(con), /No se suma a los gastos/);
  assert.equal(con.totales.gastos, sin.totales.gastos, 'la comision no es gasto');
  assert.equal(suma(con.estado.total_gastos), sin.totales.gastos);

  // Con 0 se apaga: se sigue sin estimar.
  assert.equal((await t.pedir('/api/config', { [CLAVE_COMISION]: 0 }, 'PUT')).status, 200);
  assert.equal((await finanzas(t, q)).cuerpo.terminal.comision, null);
  t.db.close();
});

test('la comision se valida: de 0 a 20 % en puntos base enteros, y solo la guarda el dueno', async () => {
  const t = tienda();
  const guardar = (valor: unknown) => t.pedir('/api/config', { [CLAVE_COMISION]: valor }, 'PUT');
  for (const bueno of [0, 1, 350, 1999, LIMITE_COMISION_BP, '350']) assert.equal((await guardar(bueno)).status, 200, String(bueno));
  for (const malo of [LIMITE_COMISION_BP + 1, 350.5, -1, 'tres', '', null, true, 1e9]) assert.equal((await guardar(malo)).status, 400, String(malo));
  assert.equal((await t.pedir('/api/config', undefined, 'GET')).cuerpo[CLAVE_COMISION], '350', 'un valor invalido no pisa el ultimo valido');
  // El resto de la configuracion sigue como siempre: solo enteros >= 0.
  assert.equal((await t.pedir('/api/config', { pct_ropa: 40 }, 'PUT')).status, 200);
  assert.equal((await t.pedir('/api/config', { pct_ropa: -1 }, 'PUT')).status, 400);

  // Como los demas ajustes de /reportes (fondo de caja, cupon): PUT solo del dueno, igual que GET /api/reportes/finanzas.
  const usuario = (roles: Usuario['roles']): Usuario => ({ correo: 'a@b.mx', nombre: 'A', roles, activo: true, caja: '', tienda: '', editar_inventario: false });
  for (const rol of ['cajero', 'capturista', 'finanzas', 'auxiliar', 'inversionista', 'revendedora'] as const) {
    assert.equal(puede(usuario([rol]), permiso('/api/config', 'PUT')), false, `PUT ${rol}`);
    assert.equal(puede(usuario([rol]), permiso('/api/reportes/finanzas', 'GET')), false, `GET finanzas ${rol}`);
  }
  assert.equal(puede(usuario(['dueno']), permiso('/api/config', 'PUT')), true);
  assert.equal(puede(usuario(['dueno']), permiso('/api/reportes/finanzas', 'GET')), true);
  assert.equal(puede(usuario(['cajero']), permiso('/reportes-finanzas.js', 'GET')), true, 'el codigo de la pantalla se sirve como el de las demas; los datos los cobra la API');
  t.db.close();
});

test('D1 admite a lo mas 5 terminos por compound SELECT: la consulta de gastos y nomina se queda corta', () => {
  assert.ok((GASTOS_Y_NOMINA.match(/union all/g) ?? []).length + 1 <= 5);
});

/* ---------- puras ---------- */

test('validarComisionPct: de 0 a 20 con hasta dos decimales, sin pasar por decimales binarios', () => {
  assert.deepEqual(validarComisionPct('3.5'), { bp: 350 });
  assert.deepEqual(validarComisionPct('3,50'), { bp: 350 });
  assert.deepEqual(validarComisionPct('0.01'), { bp: 1 });
  assert.deepEqual(validarComisionPct('0'), { bp: 0 });
  assert.deepEqual(validarComisionPct(' 20 '), { bp: 2000 });
  assert.deepEqual(validarComisionPct('20.00'), { bp: 2000 });
  assert.deepEqual(validarComisionPct('1.15'), { bp: 115 });           // 1.15 * 100 en flotante da 114.99999999999999
  assert.deepEqual(validarComisionPct('4.35'), { bp: 435 });
  for (const malo of ['', ' ', 'abc', '3.456', '20.01', '21', '-1', '1e1', '3.', '.5', '100', null, undefined]) {
    assert.ok('error' in validarComisionPct(malo), String(malo));
  }
  assert.equal(textoPct(350), '3.50 %');
  assert.equal(textoPct(5), '0.05 %');
});

test('comisionDe y bpDeConfig: el estimado se redondea al centavo; lo guardado fuera de rango no cuenta', () => {
  assert.equal(comisionDe(10_000, 350), 350);
  assert.equal(comisionDe(12_345, 349), 431);      // 430.8405 -> 431
  assert.equal(comisionDe(0, 350), 0);
  assert.equal(comisionDe(10_000, null), null);
  assert.equal(comisionDe(10_000, 0), null);
  assert.equal(bpDeConfig('350'), 350);
  assert.equal(bpDeConfig(undefined), null);
  assert.equal(bpDeConfig(null), null);
  assert.equal(bpDeConfig('0'), null);
  assert.equal(bpDeConfig('2001'), null);
  assert.equal(bpDeConfig('3.5'), null);
  assert.equal(configInvalida('pct_ropa', -5), false);               // otras claves: sin limite propio
  assert.equal(configInvalida(CLAVE_COMISION, 2001), true);
  assert.equal(configInvalida(CLAVE_COMISION, 2000), false);
});

test('ordenGastos y nombreGasto: nomina primero, el orden de categorias.js, desconocidas y sin categoria al final', () => {
  assert.deepEqual(ordenGastos(['otros', 'sin_categoria', 'zeta', 'luz', 'nomina', 'renta', 'alfa']), ['nomina', 'renta', 'luz', 'otros', 'alfa', 'zeta', 'sin_categoria']);
  assert.equal(nombreGasto('papeleria_empaque'), 'Papelería y empaque');
  assert.equal(nombreGasto('nomina'), 'Nómina');
  assert.equal(nombreGasto('sin_categoria'), 'Sin categoría');
  assert.equal(nombreGasto('otros'), 'Otros');
  assert.equal(nombreGasto('cosa_rara'), 'Cosa rara');
});

const filasBase = () => ({
  filasVentas: [{ dia: '2026-10-30', ventas: 1000 }, { dia: '2026-10-31', ventas: 2000 }, { dia: '2026-11-01', ventas: 3000 }, { dia: '2026-11-02', ventas: 4000 }],
  filasGasto: [
    { fecha: '2026-10-31', categoria: 'renta', importe: 500 }, { fecha: '2026-11-01', categoria: 'renta', importe: 700 }, { fecha: '2026-11-01', categoria: '', importe: 50 },
    { fecha: '2026-11-02', categoria: 'inversionistas', importe: 9999 }, { fecha: '2026-11-02', categoria: 'nomina', importe: 300 },
  ],
  filasSinClasificar: [{ dia: '2026-10-30', n: 1, importe: 40 }, { dia: '2026-11-02', n: 2, importe: 60 }],
  filasPago: [{ dia: '2026-11-01', forma_pago: 'tarjeta', total: 1000 }, { dia: '2026-11-02', forma_pago: 'efectivo', total: 3000 }, { dia: '2026-11-02', forma_pago: 'dolarones', total: 77 }],
  filasCortes: [{ dia: '2026-11-01', hasta: '2026-11-02T02:00:00.000Z', caja: 'Caja 1', diferencia: -250 }],
  comisionBp: '200',
});

test('armarFinanzas: columnas por mes, sin tirar nada, y los gastos en el tiempo suman lo gastado de cada cubeta', () => {
  const d = armarFinanzas({ desde: '2026-10-30', hasta: '2026-11-02', grano: 'dia', ventana: null, ...filasBase() });
  assert.deepEqual(d.estado.ventas, [3000, 7000]);
  assert.deepEqual(d.estado.total_gastos, [500, 1050]);
  assert.deepEqual(d.estado.gastos.map((g: any) => g.categoria), ['nomina', 'renta', 'sin_categoria']);
  assert.deepEqual(d.estado.inversionistas, [0, 9999]);
  assert.deepEqual(d.estado.sin_clasificar, [40, 60]);
  assert.deepEqual(d.estado.sin_clasificar_n, [1, 2]);
  assert.equal(d.totales.gastos, 1550);
  assert.equal(d.totales.ventas - d.totales.gastos, 10_000 - 1550);
  for (let i = 0; i < d.cubetas.length; i++) assert.equal(suma(d.gastos_tiempo.map((c: any) => c.valores[i])), d.cubetas[i].gastos, `cubeta ${i}`);
  assert.equal(d.terminal.comision, 20);            // $10.00 de tarjeta x 2.00 %
  assert.equal(d.pago.find((p: any) => p.clave === 'tarjeta').total, 1000);
  assert.ok(!d.pago.some((p: any) => p.clave === 'dolarones'), 'los Dolarones no son dinero cobrado: estan en Ventas');
  assert.equal(d.anterior, null);
});

test('armarFinanzas: pocas categorias van sueltas y las demas juntas en «Otras categorias», sin perder ni un centavo', () => {
  const claves = ['renta', 'luz', 'agua', 'limpieza', 'contador', 'publicidad', 'mantenimiento', 'transporte_envios'];
  const filas = { ...filasBase(), filasGasto: claves.map((c, i) => ({ fecha: '2026-11-01', categoria: c, importe: (i + 1) * 100 })), filasSinClasificar: [] };
  const d = armarFinanzas({ desde: '2026-11-01', hasta: '2026-11-02', grano: 'dia', ventana: null, ...filas });
  assert.equal(d.gastos_tiempo.length, MAX_CATEGORIAS + 1);
  assert.equal(d.gastos_tiempo.at(-1).categoria, 'otras');
  assert.equal(d.gastos_tiempo.at(-1).otras, 2);
  assert.equal(suma(d.gastos_tiempo.map((c: any) => c.total)), suma(claves.map((_, i) => (i + 1) * 100)));
  assert.equal(d.gastos_tiempo[0].categoria, 'transporte_envios');       // la mayor primero
  assert.match(tablaGastos(d), /Otras categorías \(2\)/);
});

test('armarFinanzas: la comparacion suma sus dias; con ventana, el cambio de las tarjetas sale con flecha y texto', () => {
  const ventana = { desde: '2026-10-30', hasta: '2026-10-31', dias: 2 };
  const base = filasBase();
  const d = armarFinanzas({ desde: '2026-11-01', hasta: '2026-11-02', grano: 'dia', ventana, ...base });
  assert.equal(d.anterior.ventas, 3000);
  assert.equal(d.anterior.gastos, 500);
  assert.equal(d.anterior.sin_clasificar, 40);
  const datos = { ...d, periodo: { desde: '2026-11-01', hasta: '2026-11-02', dias: 2 }, comparar: 'anterior', comparacion: ventana };
  const [ventas, gastos, resultado, pct, sin, inv] = tarjetasFinanzas(datos);
  assert.equal(ventas.valor, '$70.00');
  assert.equal(ventas.cambio.texto, '+133.3%');
  assert.equal(gastos.cambio.tono, 'mal');            // los gastos subieron: malo
  assert.equal(resultado.valor, '$59.50');            // 7000 de ventas - 1050 de gasto, antes del costo de la mercancia
  assert.equal(resultado.cambio.direccion, 'sube');
  assert.equal(pct.valor, '85.0 %');
  assert.equal(pct.cambio.texto.endsWith('pp'), true);
  assert.equal(sin.cambio.tono, 'mal');               // mas retiros sin clasificar: malo
  assert.equal(inv.cambio, null);                     // antes no habia pagos: sin base
  assert.equal(inv.cambio === null && inv.hayComp, true);
  const html = tarjetasHtml(tarjetasFinanzas(datos));
  assert.match(html, /Retiros sin clasificar/);
  assert.match(html, /▲/);
});

test('armarFinanzas: sin ventas no hay porcentaje, y un resultado negativo se escribe con su signo', () => {
  const filas = { ...filasBase(), filasVentas: [], filasPago: [], comisionBp: null };
  const d = armarFinanzas({ desde: '2026-10-30', hasta: '2026-11-02', grano: 'dia', ventana: null, ...filas });
  const html = estadoHtml(d);
  assert.match(html, /Resultado sobre ventas<\/td>(<td class="num[^"]*">—<\/td>)+/);
  assert.match(html, /−\$/);
  assert.match(html, /class="num neg"/);
  const [, , resultado, pct] = tarjetasFinanzas({ ...d, periodo: { desde: '2026-10-30', hasta: '2026-11-02', dias: 4 }, comparar: 'anterior', comparacion: null });
  assert.equal(pct.valor, '—');
  assert.match(resultado.valor, /^−\$/);
});

test('el estado de resultados en pantalla: una columna por mes y Acumulado, lo aparte debajo y la nota de lo que no incluye', () => {
  const d = armarFinanzas({ desde: '2026-10-30', hasta: '2026-11-02', grano: 'dia', ventana: null, ...filasBase() });
  d.retiros_sin_clasificar = { n: 3, importe: 100 };
  const html = estadoHtml(d);
  assert.match(html, />oct 30–31</);
  assert.match(html, />nov 1–2</);
  assert.match(html, />Acumulado</);
  for (const fila of ['Ventas netas', 'Nómina', 'Renta', 'Sin categoría', 'Total de gastos', 'Resultado operativo', 'Resultado sobre ventas', 'Retiros de caja sin clasificar', 'Pagos a inversionistas', 'Aparte: no se restan del resultado']) {
    assert.ok(html.includes(fila), fila);
  }
  assert.ok(html.indexOf('Total de gastos') < html.indexOf('Aparte: no se restan'), 'lo aparte va despues del resultado');
  assert.ok(html.indexOf('Pagos a inversionistas') > html.indexOf('Resultado operativo'));
  assert.match(html, /3 retiros/);
  assert.match(notaEstado(d), /antes del costo de la mercancía/);
  assert.match(notaEstado(d), /antes de los retiros de caja sin clasificar/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test('graficas: gastos y formas de pago apiladas, y la de cortes con una marca por corte y la suma acumulada', () => {
  const d = armarFinanzas({ desde: '2026-10-30', hasta: '2026-11-02', grano: 'dia', ventana: null, ...filasBase(), filasCortes: [
    { dia: '2026-10-31', hasta: '', caja: 'Caja 1', diferencia: -250 }, { dia: '2026-11-01', hasta: '', caja: 'Caja 2', diferencia: 100 },
    { dia: '2026-11-02', hasta: '', caja: 'Caja 1', diferencia: 0 }] });
  const g = graficas(d, () => 640);
  assert.match(g.gastos, /<svg/);
  assert.match(g.pago, /<svg/);
  assert.equal((g.cortes.match(/class="hit pasiva"/g) ?? []).length, 3);
  assert.match(g.cortes, /c-falta/);
  assert.match(g.cortes, /c-sobra/);
  assert.match(g.cortes, /c-exacto/);
  assert.match(g.cortes, /suma-corte/);
  assert.match(g.cortes, /Faltante \$2\.50/);
  assert.match(g.cortes, /Suma acumulada: Faltante \$1\.50/);
  assert.equal(graficaCortes({ cortes: [] }, { ancho: 600 }), '');
  assert.match(tablaCortes(d), /Faltante \$2\.50/);
  assert.match(tablaPago(d), /Tarjeta/);
  assert.equal(textoDiferencia(0), 'Exacto');
  assert.equal(textoDiferencia(150), 'Sobrante $1.50');
  assert.match(resumenCortesHtml(d), /Suma de las diferencias/);
  // Con demasiadas columnas se pide una agrupacion mayor; la tabla sigue teniendo todo.
  const muchas = { ...d, cubetas: Array.from({ length: 200 }, (_, i) => ({ ...d.cubetas[0], desde: sumarDias('2026-01-01', i), hasta: sumarDias('2026-01-01', i) })) };
  assert.match(graficas(muchas, () => 640).pago, /Semana/);
});
