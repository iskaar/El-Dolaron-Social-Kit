// node --test src/reportes-clientes.test.ts
// Vista Clientes de /reportes (Issue #802): el endpoint contra el doble de D1, cuadrado con Resumen y con /api/reportes, y la logica pura.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import { hoyTienda } from './reportes.ts';
import { permiso } from './cuentas.ts';
import { sumarDias } from '../public/graficas.js';
import { tarjetasHtml } from '../public/reportes-resumen.js';
import {
  armarClientes, tarjetasClientes, vistaClientes, graficas, avisosClientes, recompraHtml, altaCompraHtml, tablaTop, referidosHtml,
  tablaAltas, tablaParticipacion, tablaVentas, tablaRecompra, tablaCompras, tablaRecencia, datosParticipacion, mediana, MUESTRA_MIN, TOP,
} from '../public/reportes-clientes.js';

type T = ReturnType<typeof tienda>;
const PRIVADO = 'Nombre Privado Zeta';
const TEL = (n: number) => `4440000${String(n).padStart(3, '0')}`;
const hoy = hoyTienda();
const dia = (n: number) => sumarDias(hoy, -n);
const suma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

let consecutivo = 0;
/** Una venta de `piezas` del producto de prueba en el dia dado; con `socio` queda ligada a ese numero de socio. */
async function vender(t: T, d: string, piezas = 1, socio: number | null = null, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: piezas }], forma_pago: 'efectivo', efectivo: 25000 * piezas, caja: 'Caja 1', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const cuando = `${d}T${String(7 + (consecutivo++ % 10)).padStart(2, '0')}:00:00.000Z`;   // 01:00 a 10:00 de la tienda: siempre el mismo dia
  t.db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(cuando, cuando, id);
  if (socio !== null) t.db.prepare('update ventas set cliente_id = (select id from clientes where numero = ?) where id = ?').run(socio, id);
  return id;
}
function alta(t: T, numero: number, registradoPor: string, d: string) {
  t.db.prepare(`insert into clientes (id, numero, nombre, telefono, correo, bases_version, registrado_por, creado_en)
    values (?, ?, ?, ?, 'privado@correo.mx', 'v', ?, ?)`).run(crypto.randomUUID(), numero, PRIVADO, TEL(numero), registradoPor, `${d}T08:00:00.000Z`);
}
const llamar = (t: T, consulta: string) => t.pedir(`/api/reportes/clientes?${consulta}`, undefined, 'GET');

/**
 * Un programa con de todo. Socios: 1 y 3 por el portal, 2, 4, 5 y 7 por la caja, 6 es una cuenta del equipo (retos).
 *  #1 compra el dia de su alta (hace 20), dos tickets el mismo dia (hace 12; en otra tienda uno) y otra vez hace 2.
 *  #2 compra una vez (hace 15). #3 compra hace 9 y hace 4 (con una devolucion parcial). #4 compra el dia de su alta (hace 3).
 *  #5 solo tiene un ticket cancelado. #6 (equipo) compra hace 5. #7 compra un solo ticket que devuelve por completo.
 */
async function sembrar(t: T) {
  t.db.prepare('update productos set stock = 100000 where id = ?').run(PRODUCTO);
  alta(t, 1, 'portal', dia(20)); alta(t, 2, 'caja@prueba.mx', dia(20)); alta(t, 3, 'portal', dia(10)); alta(t, 4, 'caja@prueba.mx', dia(3));
  alta(t, 5, 'caja@prueba.mx', dia(3)); alta(t, 6, 'retos', dia(15)); alta(t, 7, 'caja@prueba.mx', dia(1));
  const v: Record<string, string> = {};
  v.a1 = await vender(t, dia(20), 1, 1);
  v.a2 = await vender(t, dia(12), 1, 1);
  v.a3 = await vender(t, dia(12), 2, 1);
  t.db.prepare("update ventas set tienda = 'salk' where id = ?").run(v.a3);
  v.a4 = await vender(t, dia(2), 1, 1);
  v.b1 = await vender(t, dia(15), 1, 2);
  v.c1 = await vender(t, dia(9), 1, 3);
  v.c2 = await vender(t, dia(4), 2, 3);
  const linea = (await t.pedir(`/api/ventas/${v.c2}`)).cuerpo.lineas[0].id;
  assert.equal((await t.pedir(`/api/ventas/${v.c2}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' })).status, 201);
  v.d1 = await vender(t, dia(3), 1, 4);
  v.e1 = await vender(t, dia(2), 1, 5);
  assert.equal((await t.pedir(`/api/ventas/${v.e1}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' })).status, 200);
  v.f1 = await vender(t, dia(5), 3, 6);
  v.g1 = await vender(t, dia(1), 1, 7);
  const lg = (await t.pedir(`/api/ventas/${v.g1}`)).cuerpo.lineas[0].id;
  assert.equal((await t.pedir(`/api/ventas/${v.g1}/lineas/${lg}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' })).status, 201);
  // Anonimos
  for (const n of [18, 14, 11, 8, 6, 5, 3, 2, 1, 0]) v[`x${n}`] = await vender(t, dia(n), 1 + (n % 3));
  return v;
}

test('con socio + sin socio = todos los tickets de Resumen, y las ventas suman resumen.total, por periodo y por cubeta', async () => {
  const t = tienda();
  await sembrar(t);
  for (const consulta of ['dias=25', 'dias=25&grano=semana', 'dias=25&comparar=ninguna', 'dias=25&comparar=mes']) {
    const viejo = (await t.pedir('/api/reportes?dias=25', undefined, 'GET')).cuerpo;
    const R = (await t.pedir(`/api/reportes/resumen?${consulta}`, undefined, 'GET')).cuerpo;
    const r = await llamar(t, consulta);
    assert.equal(r.status, 200, consulta);
    const C = r.cuerpo;
    assert.equal(C.grano, R.grano);
    assert.equal(C.totales.tickets_socio + C.totales.tickets_sin, R.totales.tickets, consulta);
    assert.equal(C.totales.ventas_socio + C.totales.ventas_sin, R.totales.ventas, consulta);
    assert.equal(C.totales.ventas_socio + C.totales.ventas_sin, viejo.resumen.total, consulta);
    assert.deepEqual(C.cubetas.map((c: any) => [c.desde, c.hasta, c.parcial]), R.cubetas.map((c: any) => [c.desde, c.hasta, c.parcial]));
    C.cubetas.forEach((c: any, i: number) => {
      assert.equal(c.tickets_socio + c.tickets_sin, R.cubetas[i].tickets, `${consulta} cubeta ${i}`);
      assert.equal(c.ventas_socio + c.ventas_sin, R.cubetas[i].ventas, `${consulta} cubeta ${i}`);
    });
    assert.equal(suma(C.cubetas.map((c: any) => c.tickets_socio)), C.totales.tickets_socio);
    if (R.anterior) {
      assert.equal(C.anterior.tickets_socio + C.anterior.tickets_sin, R.anterior.tickets, consulta);
      assert.equal(C.anterior.ventas_socio + C.anterior.ventas_sin, R.anterior.ventas, consulta);
    } else assert.equal(C.anterior, null);
  }
  t.db.close();
});

test('las ventas de socios son el neto: un cancelado no cuenta y una devolucion parcial o total se descuenta', async () => {
  const t = tienda();
  const v = await sembrar(t);
  const C = (await llamar(t, 'dias=25')).cuerpo;
  // Lo esperado, sin lineasNetas: total - devuelto - dolarones_devueltos de cada ticket no cancelado de un socio que no es del equipo.
  const esperado = (t.db.prepare(`select coalesce(sum(v.total - v.devuelto - v.dolarones_devueltos), 0) as n, count(*) as t from ventas v
    join clientes c on c.id = v.cliente_id where v.cancelada = 0 and c.registrado_por <> 'retos'`).get() as { n: number; t: number });
  assert.equal(C.totales.ventas_socio, esperado.n);
  assert.equal(C.totales.tickets_socio, esperado.t, 'el ticket devuelto por completo sigue siendo un ticket (como en Resumen), con neto 0');
  const devuelto = t.db.prepare('select devuelto from ventas where id = ?').get(v.c2) as { devuelto: number };
  assert.equal(devuelto.devuelto, 25000, 'devolucion parcial: una de dos piezas');
  assert.equal(t.db.prepare('select total - devuelto as n from ventas where id = ?').get(v.c2)!.n, 25000);
  // El cancelado de #5 no es compra ni ticket.
  assert.ok(!C.top.some((s: any) => s.socio === 5));
  t.db.close();
});

test('el equipo no es cliente: no es socio, no compra como socio y sus tickets son «sin socio»', async () => {
  const t = tienda();
  await sembrar(t);
  const C = (await llamar(t, 'dias=25')).cuerpo;
  assert.equal(C.programa.equipo, 1);
  assert.equal(C.programa.socios, 6, '7 cuentas menos la del equipo');
  assert.equal(C.totales.nuevos, 6);
  assert.equal(C.totales.tickets_equipo, 1);
  const ticketsDelEquipo = (t.db.prepare("select count(*) as n from ventas v join clientes c on c.id = v.cliente_id where c.registrado_por = 'retos'").get() as { n: number }).n;
  assert.equal(C.totales.tickets_equipo, ticketsDelEquipo);
  assert.ok(!C.top.some((s: any) => s.socio === 6), 'aunque compre mas que nadie, el equipo no sale entre los socios mas activos');
  assert.equal(C.con_historia, 4, 'compraron: #1, #2, #3 y #4 (#5 cancelo, #6 es del equipo, #7 devolvio todo)');
  assert.match(avisosClientes(C).join(' '), /equipo/);
  assert.match(avisosClientes(C).join(' '), /1 ticket del periodo con una de ellas cuenta como «sin socio»/);
  t.db.close();
});

test('altas por canal: portal, tienda (la cuenta de la caja) y la alta real de /api/socios', async () => {
  const t = tienda();
  await sembrar(t);
  // Una alta presencial de verdad: el registrado_por es la cuenta con la que se entro (DEV_USUARIO), un correo.
  const r = await t.pedir('/api/socios', { id: crypto.randomUUID(), nombre: PRIVADO, telefono: '4441112299', acepta_bases: true, declara_mayor_edad: true });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal((t.db.prepare("select registrado_por from clientes where telefono = '4441112299'").get() as { registrado_por: string }).registrado_por, DUENO);
  const C = (await llamar(t, 'dias=25')).cuerpo;
  assert.equal(C.totales.nuevos_canal.portal, 2);
  assert.equal(C.totales.nuevos_canal.tienda, 5);
  assert.equal(C.totales.nuevos_canal.otro, 0);
  assert.equal(C.totales.nuevos, 7);
  assert.equal(suma(C.cubetas.map((c: any) => c.nuevos)), 7);
  assert.equal(C.cubetas.at(-1).socios, 7, 'la acumulada de la ultima cubeta es el total de socios');
  // Un valor que no es portal ni correo no se adivina: va a «otro».
  alta(t, 90, 'sistema', dia(1));
  assert.equal((await llamar(t, 'dias=25')).cuerpo.totales.nuevos_canal.otro, 1);
  t.db.close();
});

test('un socio con dos tickets el mismo dia tiene un solo dia de compra; recompra y recencia usan dias', async () => {
  const t = tienda();
  await sembrar(t);
  const C = (await llamar(t, 'dias=25')).cuerpo;
  const top1 = C.top.find((s: any) => s.socio === 1);
  assert.equal(top1.tickets, 4, '4 tickets de la socia 1 en el periodo');
  assert.equal(top1.compras, 3, '...pero 3 dias de compra: hace 20, hace 12 (dos tickets) y hace 2');
  assert.equal(top1.ultima, dia(2));
  // Compras por socio: #1 tiene 3 dias, #2 uno, #3 dos, #4 uno.
  assert.deepEqual(C.compras_por_socio.map((x: any) => x.socios), [2, 1, 1, 0]);
  // Recencia a la fecha final (hoy): #1 hace 2 dias, #2 hace 15, #3 hace 4, #4 hace 3.
  assert.deepEqual(C.recencia.map((x: any) => x.socios), [3, 0, 1, 0]);
  // Regresaron en el periodo: #1 (hace 12 y hace 2) y #3 (hace 4). Compraron: #1, #2, #3 y #4.
  assert.equal(C.totales.compraron, 4);
  assert.equal(C.totales.regresaron, 2);
  // Brechas entre compras del periodo: #1: 8 y 10; #3: 5. Mediana 8.
  assert.deepEqual(C.totales.brechas, { n: 3, mediana: 8 });
  t.db.close();
});

test('recompra: el denominador solo lleva a los socios con N dias completos desde su primera compra', async () => {
  const t = tienda();
  await sembrar(t);
  const C = (await llamar(t, 'dias=25')).cuerpo;
  const [r14, r30] = C.recompra;
  // A 14 dias: #1 (hace 20, volvio hace 12), #2 (hace 15, no volvio). #3 (hace 9) y #4 (hace 3) aun no cumplen 14 dias.
  assert.deepEqual([r14.dias, r14.socios, r14.volvieron, r14.tasa], [14, 2, 1, 50]);
  // A 30 dias: nadie cumple todavia (la primera compra mas vieja es de hace 20).
  assert.deepEqual([r30.dias, r30.socios, r30.volvieron, r30.tasa], [30, 0, 0, null]);
  assert.ok(r14.muestra_chica && r30.muestra_chica);
  assert.match(recompraHtml(C), /Sin socios con tiempo/);
  assert.match(recompraHtml(C), /muestra chica/);
  // Un periodo pasado cerrado, a su fecha final: la tasa se mide como se sabia ese dia.
  const pasado = (await llamar(t, `desde=${dia(24)}&hasta=${dia(14)}`)).cuerpo;
  assert.equal(pasado.periodo.hasta, dia(14));
  assert.equal(pasado.programa.socios, 2, 'al cierre solo existian #1 y #2: #3 se registra hace 10 y #6 es del equipo');
  t.db.close();
});

test('alta -> primera compra: el mismo dia, despues o aun sin compra, y la mediana de espera', async () => {
  const t = tienda();
  await sembrar(t);
  const C = (await llamar(t, 'dias=25')).cuerpo;
  const a = C.alta_compra;
  // Socios dados de alta en el periodo (sin el equipo): #1, #2, #3, #4, #5, #7. #1 y #4 compraron el dia de su alta; #3 compro 1 dia despues; #2 5 dias despues;
  // #5 solo cancelo y #7 devolvio todo: sin compra.
  assert.deepEqual([a.socios, a.mismo_dia, a.despues, a.sin_compra], [6, 2, 2, 2]);
  assert.equal(a.mediana_dias, 0.5, 'esperas 0, 0, 1 y 5: la mediana es 0.5');
  assert.equal(a.muestra_chica, true);
  assert.match(altaCompraHtml(C), /Muestra chica: 6 socios/);
  t.db.close();
});

test('con tienda, las compras son solo de esa tienda y las altas siguen siendo de todo el negocio', async () => {
  const t = tienda();
  await sembrar(t);
  const todo = (await llamar(t, 'dias=25')).cuerpo;
  const salk = (await llamar(t, 'dias=25&tienda=salk')).cuerpo;
  assert.equal(salk.tienda, 'salk');
  assert.equal(salk.totales.tickets_socio, 1, 'solo el ticket de #1 hecho en Salk');
  assert.equal(salk.totales.nuevos, todo.totales.nuevos, 'un alta no tiene tienda');
  assert.equal(salk.programa.socios, todo.programa.socios);
  assert.equal(salk.con_historia, 1);
  assert.equal(salk.totales.compraron, 1);
  assert.equal(salk.totales.regresaron, 0, 'en Salk #1 solo compro una vez');
  assert.equal(salk.alta_compra.socios, todo.alta_compra.socios, 'el alta -> compra no se filtra por tienda');
  assert.match(avisosClientes(salk).join(' '), /Con una tienda elegida/);
  const R = (await t.pedir('/api/reportes/resumen?dias=25&tienda=salk', undefined, 'GET')).cuerpo;
  assert.equal(salk.totales.tickets_socio + salk.totales.tickets_sin, R.totales.tickets);
  assert.equal((await llamar(t, 'dias=25&tienda=nunca')).status, 400);
  t.db.close();
});

test('periodo pasado cerrado: lo posterior a la fecha final no se conoce', async () => {
  const t = tienda();
  await sembrar(t);
  const hasta = dia(11), desde = dia(21);
  const C = (await llamar(t, `desde=${desde}&hasta=${hasta}&comparar=ninguna`)).cuerpo;
  assert.equal(C.anterior, null);
  assert.equal(C.comparacion, null);
  assert.equal(C.programa.socios, 2, 'a esa fecha existian #1 y #2: #3 se registra hace 10 y #6 es del equipo');
  assert.equal(C.totales.nuevos, 2);
  assert.equal(C.con_historia, 2, 'las compras posteriores a la fecha final no se ven');
  assert.deepEqual(C.recencia.map((x: any) => x.socios), [2, 0, 0, 0], '#1 compro hace 12 y #2 hace 15: a 1 y 4 dias de la fecha final (hace 11), no a 10 ni 13');
  t.db.close();
});

test('privacidad: ninguna respuesta lleva nombre, telefono ni correo; el socio es un numero', async () => {
  const t = tienda();
  await sembrar(t);
  const crudo = JSON.stringify((await llamar(t, 'dias=25')).cuerpo);
  assert.doesNotMatch(crudo, new RegExp(`${PRIVADO}|privado@correo|4440000|@|prueba\\.mx|retos-`));
  const llaves = new Set<string>();
  const recorrer = (x: unknown) => { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { llaves.add(k); recorrer(v); } };
  recorrer(JSON.parse(crudo));
  for (const llave of llaves) assert.doesNotMatch(llave, /nombre|telefono|correo|mail|^id$|_id$|cliente|pin|token|vendedora|registrado/i, llave);
  t.db.close();
});

test('programa vacio: sin socios ni ventas la respuesta y la pantalla no inventan nada', async () => {
  const t = tienda();
  const r = await llamar(t, 'dias=7');
  assert.equal(r.status, 200);
  const C = r.cuerpo;
  assert.equal(C.programa.primero, null);
  assert.equal(C.programa.socios, 0);
  assert.equal(C.totales.nuevos, 0);
  assert.equal(C.con_historia, 0);
  assert.deepEqual(C.top, []);
  assert.deepEqual(C.recompra.map((x: any) => [x.socios, x.tasa]), [[0, null], [0, null]]);
  assert.deepEqual(C.alta_compra.socios, 0);
  const html = vistaClientes(C);
  assert.match(html, /Todavía no se ha registrado ningún socio/);
  assert.match(html, /Sin socios ni ventas en este periodo/);
  assert.match(html, /Todavía no hay referidos/);
  const tarjetas = tarjetasHtml(tarjetasClientes(C));
  assert.equal(tarjetas.match(/class="tarjeta kpi"/g)!.length, 8);
  assert.doesNotMatch(tarjetas + html, /NaN|undefined|null|Infinity/);
  const g = graficas(C, () => 640);
  for (const clave of ['altas', 'participacion', 'ventas', 'compras', 'recencia']) assert.match(g[clave], /class="vacio"/, clave);
  t.db.close();
});

test('referidos: cuenta pendientes y liberados y dice cuando no hay', async () => {
  const t = tienda();
  await sembrar(t);
  const id = (n: number) => (t.db.prepare('select id from clientes where numero = ?').get(n) as { id: string }).id;
  assert.equal((await llamar(t, 'dias=25')).cuerpo.referidos.pendientes, 0);
  assert.match(referidosHtml((await llamar(t, 'dias=25')).cuerpo), /Todavía no hay referidos/);
  t.db.prepare("insert into referidos (nuevo_id, referente_id, estado, creado_en) values (?, ?, 'pendiente', ?)").run(id(2), id(1), `${dia(3)}T10:00:00.000Z`);
  t.db.prepare("insert into referidos (nuevo_id, referente_id, estado, creado_en, liberado_en) values (?, ?, 'liberado', ?, ?)").run(id(3), id(1), `${dia(9)}T10:00:00.000Z`, `${dia(2)}T10:00:00.000Z`);
  const R = (await llamar(t, 'dias=25')).cuerpo.referidos;
  assert.deepEqual(R, { pendientes: 1, liberados: 1, nuevos_periodo: 2, liberados_periodo: 1 });
  assert.match(referidosHtml({ referidos: R }), /Pendientes[^]*1[^]*Liberados[^]*1/);
  t.db.close();
});

test('parametros invalidos y permiso: solo el dueno', async () => {
  const t = tienda();
  assert.equal((await llamar(t, 'dias=7&comparar=ayer')).status, 400);
  assert.equal((await llamar(t, 'dias=7&grano=hora')).status, 400);
  assert.equal((await llamar(t, 'desde=2026-02-30&hasta=2026-03-01')).status, 400);
  assert.equal((await llamar(t, `desde=2026-01-01&hasta=${sumarDias(hoy, 1)}`)).status, 400);
  assert.equal((await llamar(t, 'dias=abc')).status, 200);
  assert.equal((await t.pedir('/api/reportes/clientes', {}, 'POST')).status >= 400, true);
  assert.deepEqual(permiso('/api/reportes/clientes', 'GET'), permiso('/api/reportes', 'GET'));
  assert.deepEqual(permiso('/reportes-clientes.js', 'GET'), permiso('/reportes-resumen.js', 'GET'));
  assert.deepEqual(permiso('/reportes-clientes.css', 'GET'), permiso('/reportes-ventas.css', 'GET'));
  t.db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('caja@prueba.mx', 'C', 'cajero', 1, '', '')").run();
  (t.env as unknown as Record<string, string>).DEV_USUARIO = 'caja@prueba.mx';
  assert.equal((await llamar(t, 'dias=7')).status, 403);
  (t.env as unknown as Record<string, string>).DEV_USUARIO = DUENO;
  assert.equal((await llamar(t, 'dias=7')).status, 200);
  t.db.close();
});

/* ---------- la logica pura, con filas armadas a mano ---------- */

const base = { desde: '2026-10-01', hasta: '2026-10-31', grano: 'semana', ventana: null, tienda: '', filasTickets: [], filasHistoria: [], filasAltas: [], filasTop: [],
  programa: { primero: '2026-09-01', antes: 0, equipo: 0, pendientes: 0, liberados: 0, nuevos_periodo: 0, liberados_periodo: 0 } };

test('la marca de muestra chica se apaga con 20 socios con tiempo', () => {
  const socios = (n: number, vuelven: number) => Array.from({ length: n }, (_, i) => i + 1).flatMap((socio) => [
    { socio, dia: '2026-09-01', tienda: 'soledad', tickets: 1 },
    ...(socio <= vuelven ? [{ socio, dia: '2026-09-05', tienda: 'soledad', tickets: 1 }] : []),
  ]);
  const con = (n: number, vuelven: number) => armarClientes({ ...base, filasHistoria: socios(n, vuelven) }).recompra[0];
  assert.equal(MUESTRA_MIN, 20);
  assert.equal(con(19, 5).muestra_chica, true);
  assert.deepEqual([con(20, 5).muestra_chica, con(20, 5).socios, con(20, 5).volvieron, con(20, 5).tasa], [false, 20, 5, 25]);
  assert.match(recompraHtml(armarClientes({ ...base, filasHistoria: socios(19, 5) })), /muestra chica/);
  assert.doesNotMatch(recompraHtml(armarClientes({ ...base, filasHistoria: socios(20, 5) })), /muestra chica/);
});

test('la mediana, y los dias de compra repetidos en la misma fila de historia no duplican', () => {
  assert.equal(mediana([]), null);
  assert.equal(mediana([5, 1, 3]), 3);
  assert.equal(mediana([1, 2, 3, 4]), 2.5);
  const r = armarClientes({ ...base, filasHistoria: [
    { socio: 1, dia: '2026-10-03', tienda: 'soledad', tickets: 1 }, { socio: 1, dia: '2026-10-03', tienda: 'salk', tickets: 1 },
  ] });
  assert.equal(r.compras_por_socio[0].socios, 1, 'el mismo dia en dos tiendas es un solo dia de compra');
  assert.equal(r.totales.regresaron, 0);
});

test('las tarjetas: ocho, con sus minigraficas, el cambio contra la comparacion y mensajes honestos', async () => {
  const t = tienda();
  await sembrar(t);
  const C = (await llamar(t, 'dias=12')).cuerpo;
  const k = tarjetasClientes(C);
  assert.deepEqual(k.map((x: any) => x.clave), ['nuevos', 'socios', 'con_socio', 'ventas_socio', 'ticket_socio', 'compraron', 'regresaron', 'brecha']);
  const html = tarjetasHtml(k);
  assert.equal(html.match(/class="tarjeta kpi"/g)!.length, 8);
  assert.ok(html.match(/<svg class="mini /g)!.length >= 6, 'minigrafica en las series con al menos dos cubetas con dato');
  assert.match(html, /Tickets con socio/);
  assert.match(html, /muestra chica/);
  assert.match(html, /Sin socio: \$/);
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
  const sinComp = tarjetasHtml(tarjetasClientes((await llamar(t, 'dias=12&comparar=ninguna')).cuerpo));
  assert.match(sinComp, /Sin comparar/);
  t.db.close();
});

test('la vista entera y sus graficas se arman con datos; todo lo que escribe es texto escapado', async () => {
  const t = tienda();
  await sembrar(t);
  for (const consulta of ['dias=25', 'dias=25&grano=semana', 'dias=25&tienda=salk']) {
    const C = (await llamar(t, consulta)).cuerpo;
    const html = vistaClientes(C);
    for (const id of ['c-altas', 'c-part', 'c-ventas', 'c-recompra', 'c-alta-compra', 'c-compras', 'c-recencia', 'c-top', 'c-referidos']) assert.ok(html.includes(`id="${id}"`), id);
    assert.match(html, /Ver Dolarones/);
    assert.match(html, /Socio #1/);
    assert.equal(html.match(/class="alterna"/g)!.length, 7, 'Ver tabla en cada panel con grafica o barras');
    const g = graficas(C, () => 640);
    assert.match(g.altas, /<svg/); assert.match(g.participacion, /<svg/); assert.match(g.ventas, /<svg/);
    assert.doesNotMatch(html + Object.values(g).join(''), /NaN|undefined|Infinity/);
    for (const f of [tablaAltas, tablaParticipacion, tablaVentas, tablaRecompra, tablaCompras, tablaRecencia, tablaTop]) assert.doesNotMatch(f(C), /NaN|undefined/);
  }
  t.db.close();
});

test('participacion: antes de que existiera el programa no es un 0 %, es un hueco', async () => {
  const t = tienda();
  await sembrar(t);
  const C = (await llamar(t, 'dias=25')).cuerpo;
  const p = datosParticipacion(C);
  const primero = C.programa.primero;
  assert.equal(primero, dia(20));
  C.cubetas.forEach((c: any, i: number) => { if (c.hasta < primero) assert.equal(p[i], null); });
  assert.ok(p.some((x: number | null) => x != null && x > 0));
  assert.match(avisosClientes({ ...C, periodo: { ...C.periodo, desde: dia(30) } }).join(' '), /empezaron a registrarse/);
  t.db.close();
});

test('el tope de los socios mas activos es TOP y se ordena por compras netas, a empate por numero', () => {
  const filasTop = Array.from({ length: 3 }, (_, i) => ({ socio: 10 - i, tickets: 1, ventas: 100 }));
  const r = armarClientes({ ...base, filasTop });
  assert.deepEqual(r.top.map((s: any) => s.socio), [10, 9, 8], 'el orden lo da la consulta; la pagina no lo cambia');
  assert.equal(TOP, 15);
});
