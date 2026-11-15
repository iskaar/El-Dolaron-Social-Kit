// node --test src/reportes-equipo.test.ts
// Vista Equipo de /reportes (Issue #802): el endpoint contra el doble de D1 (con los mismos valores de siempre en los campos que ya existian)
// y las funciones puras de la pantalla. El bono semanal tiene sus pruebas en equipo.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { lineasNetas } from './netas.ts';
import { hoyTienda, rangoDe } from './reportes.ts';
import { sumarDias } from '../public/graficas.js';
import { tarjetasHtml } from '../public/reportes-resumen.js';
import {
  tarjetasEquipo, seriesVentas, tablaPersonas, tablaSerie, htmlVista, graficaDe, ordenarPersonas, notaAtribucion, armarEquipo, POCOS_DIAS, COLUMNAS, MEDIDAS_EQUIPO,
} from '../public/reportes-equipo.js';

type T = ReturnType<typeof tienda>;
type Persona = Record<string, number | string>;
const suma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const llamar = (t: T, consulta: string) => t.pedir(`/api/reportes/equipo?${consulta}`, undefined, 'GET');
const hoy = hoyTienda();
const dia = (n: number) => sumarDias(hoy, -n);
/** Las `h`:`m` de un dia de la tienda, en UTC (la tienda es UTC-6 fijo). */
const a = (d: string, h: number, m = 0) => new Date(Date.parse(`${d}T00:00:00.000Z`) + (h + 6) * 3_600_000 + m * 60_000).toISOString();
const ANA = 'ana@prueba.mx', BETO = 'beto@prueba.mx';

const usuario = (t: T, correo: string, nombre: string, roles: string) =>
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, 1, '', '')`).run(correo, nombre, roles);

/** Una venta de `n` piezas ($250 cada una) del producto de prueba en el dia `d`, atendida por `vendedora` ('' = sin atribuir). */
async function vender(t: T, d: string, vendedora: string, n = 1, producto = PRODUCTO, cuando = a(d, 12)) {
  const id = crypto.randomUUID();
  const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: producto, cantidad: n }], forma_pago: 'efectivo', efectivo: 100000 * n, caja: 'Caja 1', ...(vendedora ? { vendedora } : {}) });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  t.db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(cuando, cuando, id);
  return id;
}
const cancelar = async (t: T, id: string) => assert.equal((await t.pedir(`/api/ventas/${id}/cancelar`, { motivo: 'x', caja: 'Caja 1' })).status, 200);
const socio = (t: T, numero: number, por: string, creado: string) => {
  const id = `c-${numero}`;
  t.db.prepare(`insert into clientes (id, numero, nombre, telefono, bases_version, registrado_por, creado_en) values (?, ?, 'S', ?, 'v', ?, ?)`)
    .run(id, numero, `775000${numero}`, por, creado);
  return id;
};
let consecutivoPieza = 0;
/** Una pieza capturada por `por` en `creado` (ISO), con existencia de sobra. */
function pieza(t: T, por: string, creado: string, extra = '') {
  const id = crypto.randomUUID();
  t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en, capturado_por) values (?, ?, 'Pieza', 25000, 100, 'S45', ?, ?, ?)`)
    .run(id, `ED-9${String(++consecutivoPieza).padStart(5, '0')}`, creado, creado, por);
  if (extra) t.db.prepare(`update productos set ${extra} where id = ?`).run(id);
  return id;
}
const empleado = (t: T, id: string, nombre: string, correo: string) =>
  t.db.prepare(`insert into empleados (id, nombre, periodo, pago_dia, creado_en, correo) values (?, ?, 'diario', 30000, '', ?)`).run(id, nombre, correo);
const asistencia = (t: T, id: string, fecha: string) => t.db.prepare(`insert into asistencias (empleado_id, fecha, entrada, origen) values (?, ?, '', 'manual')`).run(id, fecha);

/**
 * Un periodo con de todo. Ana atiende 4 tickets (uno se cancela), Beto 1 de 3 piezas y 3 quedan sin vendedora (mas una antes de que la caja la mandara).
 * Socios: Ana da de alta 2 (una compra ese dia), Beto 1 (compra, pero en un ticket cancelado). Un apartado cerrado por Ana.
 * Capturas: Ana 3 piezas del periodo (una se vende, una en un ticket cancelado, una nunca) y una de hace 30 dias; Beto 2 (una se vende, una es de bandas).
 * Asistencias: Ana 3 dias, Beto 1, y un empleado sin cuenta ligada con 2.
 */
async function sembrar(t: T) {
  t.db.prepare('update productos set stock = 100000 where id = ?').run(PRODUCTO);
  usuario(t, ANA, 'Ana', 'cajero'); usuario(t, BETO, 'Beto', 'capturista');
  const v: Record<string, string> = {};
  v.antes = await vender(t, dia(25), '');
  v.a1 = await vender(t, dia(2), ANA); v.a2 = await vender(t, dia(2), ANA, 2); v.a3 = await vender(t, dia(3), ANA); v.a4 = await vender(t, dia(4), ANA);
  v.b1 = await vender(t, dia(3), BETO, 3);
  v.s1 = await vender(t, dia(4), ''); v.s2 = await vender(t, dia(1), '');
  await cancelar(t, v.a4);
  const c1 = socio(t, 1, ANA, a(dia(2), 9)); socio(t, 2, ANA, a(dia(3), 9)); const c3 = socio(t, 3, BETO, a(dia(4), 9));
  t.db.prepare('update ventas set cliente_id = ? where id = ?').run(c1, v.a1);
  t.db.prepare('update ventas set cliente_id = ? where id = ?').run(c3, v.a4);
  t.db.prepare(`insert into pedidos (id, folio, cliente, telefono, entrega, vendedora, estado, vence_en, anticipo, forma_pago, saldo, saldo_vence_en, venta_id, creado_en, actualizado_en)
    values ('p1', 1, 'c', '7751234567', 'tienda', ?, 'vendido', '', 0, 'efectivo', 0, '', ?, '', '')`).run(ANA, v.a2);
  const capturada = (por: string, hace: number, extra = '') => pieza(t, por, a(dia(hace), 8), extra);
  const pa1 = capturada(ANA, 8), pa2 = capturada(ANA, 8); capturada(ANA, 9); capturada(ANA, 30);
  const pb1 = capturada(BETO, 7); capturada(BETO, 7, 'sin_inventario = 1');
  await vender(t, dia(5), '', 1, pa1);
  await cancelar(t, await vender(t, dia(5), '', 1, pa2));
  await vender(t, dia(2), '', 1, pb1);
  empleado(t, 'e-ana', 'Ana', ANA); empleado(t, 'e-beto', 'Beto', BETO); empleado(t, 'e-x', 'Sin cuenta', '');
  for (const n of [2, 3, 4]) asistencia(t, 'e-ana', dia(n));
  asistencia(t, 'e-beto', dia(3)); asistencia(t, 'e-x', dia(1)); asistencia(t, 'e-x', dia(2));
  return v;
}

/** Las consultas de /api/reportes/equipo ANTES de #802, tal cual: la medida de que los campos de siempre no cambian. */
async function viejo(t: T, consulta: string) {
  const rango = rangoDe(new URL(`https://x/api/reportes/equipo?${consulta}`));
  const { desde, hasta } = rango;
  const [ventas, socios, apartados, piezas, trabajados] = await Promise.all([
    t.env.DB.prepare(
      `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
       select v.vendedora as correo, count(distinct n.venta) as tickets, coalesce(sum(n.neta), 0) as ventas
       from netas n join ventas v on v.id = n.venta where n.propietario = 'dolaron' group by v.vendedora`,
    ).bind(desde, hasta).all(),
    t.env.DB.prepare(
      `select c.registrado_por as correo, count(*) as socios,
         coalesce(sum(exists(select 1 from ventas v where v.cliente_id = c.id and v.cancelada = 0
           and substr(datetime(v.creado_en, '-6 hours'), 1, 10) = substr(datetime(c.creado_en, '-6 hours'), 1, 10))), 0) as socios_compraron
       from clientes c where c.creado_en >= ? and c.creado_en < ? group by c.registrado_por`,
    ).bind(desde, hasta).all(),
    t.env.DB.prepare(
      `select p.vendedora as correo, count(*) as apartados from pedidos p join ventas v on v.id = p.venta_id
       where p.estado = 'vendido' and v.cancelada = 0 and v.creado_en >= ? and v.creado_en < ? group by p.vendedora`,
    ).bind(desde, hasta).all(),
    t.env.DB.prepare(
      `select p.capturado_por as correo, count(*) as capturadas,
         coalesce(sum(exists(select 1 from venta_lineas l join ventas v on v.id = l.venta_id
           where l.producto_id = p.id and v.cancelada = 0 and l.cantidad > l.cancelada_cantidad
             and julianday(v.creado_en) - julianday(p.creado_en) <= 14)), 0) as vendidas_14
       from productos p where p.capturado_por <> '' and p.creado_en >= ? and p.creado_en < ? and p.sin_inventario = 0
         and p.propietario = 'dolaron' and p.estado_analisis <> 'descartado' group by p.capturado_por`,
    ).bind(desde, hasta).all(),
    t.env.DB.prepare(
      `select e.correo, count(*) as dias_trabajados from asistencias a join empleados e on e.id = a.empleado_id
       where e.correo <> '' and a.fecha >= ? and a.fecha <= ? group by e.correo`,
    ).bind(rango.dia_desde, rango.dia_hasta).all(),
  ]);
  const personas = new Map<string, Record<string, number>>();
  for (const origen of [ventas, socios, apartados, piezas, trabajados]) {
    for (const { correo, ...datos } of origen.results as { correo: string }[]) personas.set(correo, { ...(personas.get(correo) ?? {}), ...datos as Record<string, number> });
  }
  return personas;
}
const CAMPOS_DE_SIEMPRE = ['ventas', 'tickets', 'socios', 'socios_compraron', 'apartados', 'capturadas', 'vendidas_14', 'dias_trabajados'];

/** Cada persona de la respuesta nueva trae, en los campos que ya existian, lo mismo que las consultas de antes (y las que antes no salian, en cero). */
async function comparar(t: T, consulta: string) {
  const antes = await viejo(t, consulta);
  const E = (await llamar(t, consulta)).cuerpo;
  for (const p of E.personas as Persona[]) {
    const base = antes.get(String(p.correo)) ?? {};
    for (const campo of CAMPOS_DE_SIEMPRE) assert.equal(p[campo], base[campo] ?? 0, `${consulta}: ${p.correo || 'sin atribuir'} ${campo}`);
  }
  // Y nadie que antes saliera deja de salir (el renglon vacio solo sale con tickets, como siempre).
  for (const [correo, datos] of antes) {
    if (!correo && !datos.tickets) continue;
    assert.ok((E.personas as Persona[]).some((p) => p.correo === correo), `${consulta}: falta ${correo || 'sin atribuir'}`);
  }
  return E;
}

test('los campos de siempre de cada persona valen lo mismo que con las consultas de antes: periodo, 30 dias y rango pasado cerrado', async () => {
  const t = tienda();
  await sembrar(t);
  for (const consulta of ['dias=10', 'dias=30', 'dias=1', `desde=${dia(6)}&hasta=${dia(3)}`, 'dias=10&comparar=ninguna&grano=semana']) await comparar(t, consulta);
  const E = (await llamar(t, 'dias=10')).cuerpo;
  const fila = (c: string) => E.personas.find((p: Persona) => p.correo === c);
  // Los valores exactos de lo sembrado, para que la prueba diga algo de verdad y no solo «igual que antes».
  assert.deepEqual(CAMPOS_DE_SIEMPRE.map((c) => fila(ANA)[c]), [25000 * 4, 3, 2, 1, 1, 3, 1, 3]);   // a1, a2 (2 piezas) y a3: el cancelado a4 no cuenta
  assert.deepEqual(CAMPOS_DE_SIEMPRE.map((c) => fila(BETO)[c]), [25000 * 3, 1, 1, 0, 0, 1, 1, 1]);   // su socio compro, pero en un ticket cancelado: no cuenta
  assert.equal(fila('').tickets, 4);                                                                // s1, s2 y las dos ventas de piezas capturadas (la cancelada no)
  assert.equal(E.dias, 10); assert.equal(E.semanas.length, 8); assert.equal(typeof E.config.pb, 'number');
  assert.deepEqual([E.dia_desde, E.dia_hasta], [dia(9), hoy]);
  t.db.close();
});

test('«vendidas a 14 dias» no cambia en el borde de los 14 dias ni con ventas canceladas, de otra pieza o fuera del rango', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100000 where id = ?').run(PRODUCTO);
  usuario(t, ANA, 'Ana', 'cajero');
  const T0 = a(dia(60), 8), mas = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
  const DIAS = 86_400_000;
  const vendida = async (cuando: string | null, extra = '') => {
    const id = pieza(t, ANA, T0, extra);
    if (cuando) await vender(t, dia(40), '', 1, id, cuando);
    return id;
  };
  await vendida(mas(13 * DIAS));                 // si
  await vendida(mas(14 * DIAS));                 // el borde: lo que diga julianday, igual que antes
  await vendida(mas(14 * DIAS + 1000));          // un segundo despues
  await vendida(mas(15 * DIAS));                 // no
  await vendida(null);                           // nunca
  const cancelada = await vender(t, dia(40), '', 1, await vendida(null), mas(2 * DIAS));
  await cancelar(t, cancelada);                  // una venta cancelada no cuenta
  const lineaCancelada = await vender(t, dia(40), '', 2, await vendida(null), mas(3 * DIAS));
  t.db.prepare('update venta_lineas set cancelada_cantidad = cantidad where venta_id = ?').run(lineaCancelada);   // ni una pieza ya devuelta
  await vendida(mas(-1 * DIAS));                 // una venta ANTES de capturar la pieza: antes contaba (diferencia negativa), igual ahora
  const consulta = `desde=${dia(62)}&hasta=${dia(58)}`;                  // el periodo de captura; las ventas caen despues del cierre
  const E = await comparar(t, consulta);
  const ana = E.personas.find((p: Persona) => p.correo === ANA);
  assert.equal(ana.capturadas, 8);
  assert.ok([2, 3].includes(ana.vendidas_14 as number), `vendidas_14 ${ana.vendidas_14}`);   // 13 dias y 1 dia antes, mas el borde si julianday lo deja en 14; el resto, no
  await comparar(t, `desde=${dia(62)}&hasta=${dia(50)}`);
  t.db.close();
});

test('las cifras por persona suman las totales y lo no atribuido se cuenta aparte, no se descarta', async () => {
  const t = tienda();
  await sembrar(t);
  const E = (await llamar(t, 'dias=10')).cuerpo, tot = E.totales, R = (await t.pedir('/api/reportes?dias=10', undefined, 'GET')).cuerpo;
  const gente = E.personas.filter((p: Persona) => p.correo) as Persona[];
  assert.equal(tot.ventas_total, R.resumen.total);                                  // el neto de Resumen, atribuido o no
  assert.equal(tot.tickets_total, R.resumen.ventas);
  assert.equal(suma(gente.map((p) => p.ventas as number)) + E.sin_atribuir.ventas, tot.ventas_total);
  assert.equal(suma(gente.map((p) => p.tickets as number)) + E.sin_atribuir.tickets, tot.tickets_total);
  assert.equal(suma(gente.map((p) => p.ventas as number)), tot.ventas);             // lo atribuido
  assert.equal(suma(gente.map((p) => p.piezas as number)), tot.piezas);                 // lo atribuido, en piezas
  assert.equal(E.sin_atribuir.tickets, 4);
  assert.ok(E.sin_atribuir.ventas > 0);
  assert.equal(suma(gente.map((p) => p.socios as number)), tot.socios);
  assert.equal(suma(gente.map((p) => p.socios_compraron as number)), tot.socios_compraron);
  assert.equal(suma(gente.map((p) => p.capturadas as number)), tot.capturadas);
  assert.equal(suma(gente.map((p) => p.vendidas_14 as number)), tot.vendidas_14);
  assert.equal(suma(gente.map((p) => p.cancelaciones as number)) + E.sin_atribuir.cancelaciones, tot.cancel_n);
  assert.equal(tot.cancel_n, 2);                                                    // a4, de Ana, y la venta cancelada de una pieza capturada, sin vendedora
  assert.equal(E.sin_atribuir.cancelaciones, 1);
  assert.equal(gente.find((p) => p.correo === ANA)!.cancelaciones, 1);
  assert.equal(tot.dias_trab, 6);                                                   // 3 + 1 + 2 del empleado sin cuenta: cuenta en el total, no en una persona
  assert.equal(suma(gente.map((p) => p.dias_trabajados as number)), 4);
  // Cada cubeta suma lo suyo, medida por medida.
  for (const m of MEDIDAS_EQUIPO) assert.equal(suma(E.cubetas.map((c: any) => c[m])), tot[m], m);
  // Las columnas apiladas: cada persona suma sus ventas, y la serie sin atribuir lo suyo.
  for (const s of E.serie_personas) assert.equal(suma(s.valores), gente.find((p) => p.correo === s.correo)!.ventas, s.correo);
  assert.equal(suma(E.serie_sin_atribuir), E.sin_atribuir.ventas);
  E.cubetas.forEach((c: any, i: number) => assert.equal(suma(E.serie_personas.map((s: any) => s.valores[i])) + E.serie_sin_atribuir[i], c.ventas_total, `cubeta ${i}`));
  // La tabla y la grafica traen a todos, tambien a «Sin atribuir».
  const html = htmlVista(E, { clave: 'ventas', descendente: true });
  assert.match(html, /Sin atribuir/);
  assert.equal(seriesVentas(E).at(-1).nombre, 'Sin atribuir');
  t.db.close();
});

test('desde cuando hay ventas atribuidas se calcula de los datos, y el porcentaje atribuido dice lo que no se puede atribuir', async () => {
  const t = tienda();
  const v = await sembrar(t);
  void v;
  const E = (await llamar(t, 'dias=30')).cuerpo;
  assert.equal(E.atribucion.desde, dia(4));                                          // la primera venta con vendedora, no la primera venta
  assert.equal(E.atribucion.dentro_del_periodo, true);                               // el periodo (30 dias) empieza antes
  assert.ok(E.atribucion.desde_total <= E.totales.ventas_total);
  assert.ok(E.atribucion.desde_ventas <= E.atribucion.desde_total);
  const corto = (await llamar(t, 'dias=3')).cuerpo;                                  // desde hace 2 dias: el periodo ya empieza despues de la primera atribuida
  assert.equal(corto.atribucion.desde, dia(4));
  assert.equal(corto.atribucion.dentro_del_periodo, false);
  assert.equal(corto.atribucion.desde_total, corto.totales.ventas_total);            // todo el periodo es de despues: el mismo porcentaje
  const nota = notaAtribucion(E);
  assert.match(nota, /hay datos desde el/);
  assert.match(nota, /lo anterior al/);
  assert.doesNotMatch(notaAtribucion(corto), /lo anterior al/);
  const tarjetas = Object.fromEntries(tarjetasEquipo(E).map((k: any) => [k.clave, k]));
  assert.match(tarjetas.parte.pie, /Desde el/);
  assert.match(tarjetas.parte.pie, /antes no se registraba/);
  t.db.close();
});

test('sin ninguna venta atribuida ni asistencias: la pantalla lo dice en vez de mostrar ceros que parezcan datos', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100000 where id = ?').run(PRODUCTO);
  await vender(t, dia(1), ''); await vender(t, dia(2), '');
  const E = (await llamar(t, 'dias=7')).cuerpo;
  assert.equal(E.atribucion.desde, null);
  assert.equal(E.asistencias.desde, null);
  assert.equal(E.totales.ventas, 0); assert.equal(E.totales.tickets_total, 2);
  assert.deepEqual(E.personas.map((p: Persona) => p.correo), ['']);                 // solo «Sin atribuir», con sus 2 tickets
  assert.equal(E.personas[0].tickets, 2);
  const tarjetas = Object.fromEntries(tarjetasEquipo(E).map((k: any) => [k.clave, k]));
  assert.equal(tarjetas.dias.valor, '—');
  assert.match(tarjetas.dias.pie, /aún no tiene asistencias/);
  assert.match(tarjetas.parte.pie, /aún no lo registra/);
  assert.equal(tarjetas.parte.valor, '0.0 %');
  assert.match(notaAtribucion(E), /Ninguna venta tiene todavía/);
  const html = htmlVista(E, { clave: 'ventas', descendente: true });
  assert.match(html, /Nómina todavía no tiene asistencias/);
  assert.match(tablaPersonas(E), /<td class="num">—<\/td><\/tr><tr><td><b>Total/);   // dias trabajados: «—», no 0
  t.db.close();
});

test('periodo vacio: sin personas, sin series, ceros y la pantalla no dibuja ejes vacios', async () => {
  const t = tienda();
  const r = await llamar(t, 'dias=28');
  assert.equal(r.status, 200);
  const E = r.cuerpo;
  assert.equal(E.cubetas.length, 28);
  for (const m of MEDIDAS_EQUIPO) assert.equal(E.totales[m], 0, m);
  assert.deepEqual(E.personas, []);
  assert.deepEqual(E.serie_personas, []);
  assert.equal(suma(E.serie_sin_atribuir), 0);
  assert.equal(seriesVentas(E).length, 0);
  assert.equal(graficaDe('ventas', E, 600), '');
  const html = htmlVista(E, { clave: 'ventas', descendente: true });
  assert.match(html, /Sin ventas en este periodo/);
  assert.match(html, /Sin personas con actividad/);
  assert.doesNotMatch(html, /<svg/);
  const tarjetas = Object.fromEntries(tarjetasEquipo(E).map((k: any) => [k.clave, k]));
  assert.equal(tarjetas.ticket.valor, '—'); assert.equal(tarjetas.parte.valor, '—');
  t.db.close();
});

test('comparacion y grano: la semana suma lo mismo que el dia y la comparacion trae lo anterior', async () => {
  const t = tienda();
  await sembrar(t);
  const dias = (await llamar(t, 'dias=20&grano=dia')).cuerpo, semanas = (await llamar(t, 'dias=20&grano=semana')).cuerpo;
  assert.equal(semanas.grano, 'semana'); assert.ok(semanas.cubetas.length < dias.cubetas.length);
  for (const m of MEDIDAS_EQUIPO) assert.equal(semanas.totales[m], dias.totales[m], m);
  const C = (await llamar(t, `desde=${dia(3)}&hasta=${dia(1)}`)).cuerpo;            // dias 3 a 1; antes: dias 6 a 4
  assert.equal(C.comparacion.desde, dia(6));
  assert.ok(C.anterior.tickets_total > 0);
  assert.equal(C.anterior.tickets, 0);                                               // lo de antes: a4 (cancelado) y ventas sin vendedora
  assert.equal(C.anterior.tickets_total, 2);
  const ninguna = (await llamar(t, 'dias=10&comparar=ninguna')).cuerpo;
  assert.equal(ninguna.comparacion, null); assert.equal(ninguna.anterior, null);
  assert.ok(tarjetasEquipo(ninguna).every((k: any) => k.comparando === false));
  assert.match(tarjetasHtml(tarjetasEquipo(ninguna)), /Sin comparar/);
  t.db.close();
});

test('un rango pasado cerrado deja fuera lo de despues', async () => {
  const t = tienda();
  await sembrar(t);
  const E = (await llamar(t, `desde=${dia(4)}&hasta=${dia(3)}`)).cuerpo;
  assert.equal(E.dias, 2);
  assert.equal(E.totales.tickets_total, 3);       // a3 y b1 (dia 3) y s1 (dia 4); a4 esta cancelado y no entra al neto
  assert.equal(E.totales.tickets, 2); assert.equal(E.sin_atribuir.tickets, 1);
  assert.equal(E.totales.cancel_n, 1);            // a4, de Ana, vendido el dia 4
  assert.equal(E.totales.socios, 2);              // c2 (dia 3) y c3 (dia 4): c1 es del dia 2, fuera
  assert.deepEqual(E.cubetas.map((c: any) => [c.desde, c.tickets_total]), [[dia(4), 1], [dia(3), 2]]);
  t.db.close();
});

test('la API rechaza lo que no entiende y el acceso es el de /reportes', async () => {
  const t = tienda();
  for (const consulta of ['dias=7&grano=hora', 'dias=7&comparar=ayer', 'desde=2026-01-01', `desde=${hoy}&hasta=${sumarDias(hoy, 1)}`]) {
    assert.equal((await llamar(t, consulta)).status, 400, consulta);
  }
  usuario(t, 'caja@prueba.mx', 'K', 'cajero');
  (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = 'caja@prueba.mx';
  assert.equal((await llamar(t, 'dias=7')).status, 403);
  t.db.close();
});

test('consultas: ninguna subconsulta por pieza sobre venta_lineas, nada de compound de mas de 5 y no mas consultas que antes de #802 mas las nuevas', async () => {
  const t = tienda();
  await sembrar(t);
  const visto: string[] = [];
  const preparar = t.env.DB.prepare.bind(t.env.DB);
  (t.env.DB as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => { visto.push(sql); return preparar(sql); };
  assert.equal((await llamar(t, 'dias=28')).status, 200);
  assert.ok(!visto.some((sql) => /exists\s*\(\s*select 1 from venta_lineas/i.test(sql)), 'sin exists por pieza sobre venta_lineas');
  for (const sql of visto) assert.ok((sql.match(/\bunion\b/gi) ?? []).length + 1 <= 5, sql.slice(0, 80));
  // 14 prepare: el acceso del usuario y 13 del reporte (10 de la vista y 3 del bono).
  assert.ok(visto.length <= 14, `${visto.length} consultas`);
  t.db.close();
});

/* ---------- las funciones puras de la pantalla ---------- */

const persona = (nombre: string, extra: Partial<Record<string, number | string>> = {}) => ({ correo: `${nombre.toLowerCase()}@x`, nombre, ventas: 0, tickets: 0, piezas: 0, socios: 0, socios_compraron: 0,
  apartados: 0, capturadas: 0, vendidas_14: 0, dias_trabajados: 0, cancelaciones: 0, cancelaciones_valor: 0, dias_con_venta: 0, ...extra });

test('ordenarPersonas ordena por la columna que se pida, con lo que no tiene dato al final', () => {
  const lista = [persona('Ana', { ventas: 100000, tickets: 4, piezas: 8, dias_con_venta: 4 }), persona('Beto', { ventas: 50000, tickets: 1, piezas: 1, dias_con_venta: 1 }),
    persona('Cora', { ventas: 0, tickets: 0 }), persona('Dani', { ventas: 30000, tickets: 3, piezas: 6, dias_con_venta: 3 })];
  const nombres = (clave: string, desc = true) => ordenarPersonas(lista, clave, desc).map((p: any) => p.nombre);
  assert.deepEqual(nombres('ventas'), ['Ana', 'Beto', 'Dani', 'Cora']);
  assert.deepEqual(nombres('ventas', false), ['Cora', 'Dani', 'Beto', 'Ana']);
  assert.deepEqual(nombres('ticket'), ['Beto', 'Ana', 'Dani', 'Cora']);       // 50000, 25000, 10000; Cora no tiene ticket: al final
  assert.deepEqual(nombres('ticket', false), ['Dani', 'Ana', 'Beto', 'Cora']);
  assert.deepEqual(nombres('piezas_ticket'), ['Ana', 'Dani', 'Beto', 'Cora']);
  assert.deepEqual(nombres('nombre', true), ['Ana', 'Beto', 'Cora', 'Dani']);
  assert.deepEqual(nombres('nombre', false), ['Dani', 'Cora', 'Beto', 'Ana']);
  assert.deepEqual(lista.map((p: any) => p.nombre), ['Ana', 'Beto', 'Cora', 'Dani']);   // no toca la lista de entrada
  for (const [clave] of COLUMNAS) assert.doesNotThrow(() => ordenarPersonas(lista, clave), clave);
});

test('la tabla marca «pocos dias», no inventa el promedio de quien no vendio y escapa nombres, correos y enlaces', () => {
  const base = armarEquipo({ desde: '2026-11-01', hasta: '2026-11-07', grano: 'dia', ventana: null, ventas: [
    { dia: '2026-11-01', correo: 'ana@x', tickets: 2, ventas: 40000, piezas: 3 }, { dia: '2026-11-02', correo: 'ana@x', tickets: 1, ventas: 10000, piezas: 1 },
    { dia: '2026-11-03', correo: 'ana@x', tickets: 1, ventas: 10000, piezas: 1 }, { dia: '2026-11-04', correo: 'ana@x', tickets: 1, ventas: 10000, piezas: 1 },
    { dia: '2026-11-05', correo: 'ana@x', tickets: 1, ventas: 10000, piezas: 1 }, { dia: '2026-11-03', correo: 'beto@x', tickets: 1, ventas: 90000, piezas: 2 },
    { dia: '2026-11-06', correo: '', tickets: 1, ventas: 5000, piezas: 1 }],
  cancelaciones: [], socios: [], apartados: [], capturas: [{ dia: '2026-11-02', correo: 'ana@x', capturadas: 5, vendidas_14: 2 }], asistencias: [],
  usuarios: [{ correo: 'ana@x', nombre: 'Ana' }, { correo: 'beto@x', nombre: '<img src=x onerror=alert(1)> "Beto"' }, { correo: 'cora@x', nombre: 'Cora' }],
  vendedoras: [{ correo: 'ana@x' }, { correo: 'beto@x' }, { correo: 'cora@x' }], atribucionDesde: '2026-11-01' });
  // (cora@x no esta en `usuarios`: sale con su correo como nombre)
  const E = { ...base, grano: 'dia', comparar: 'anterior', comparacion: null, tienda: '', asistencias: { desde: null }, periodo: { desde: '2026-11-01', hasta: '2026-11-07', dias: 7 } };
  const html = tablaPersonas(E);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &quot;Beto&quot;/);
  assert.doesNotMatch(html, /<img/);
  // Ana trabajo 5 dias (no es «pocos»), Beto uno (si), Cora ninguno (no se marca: no vendio).
  const fila = (nombre: string) => html.split('<tr>').find((f) => f.includes(nombre))!;
  assert.doesNotMatch(fila('Ana'), /pocos días/);
  assert.match(fila('Beto'), /pocos días/);
  assert.doesNotMatch(fila('Cora'), /pocos días/);
  assert.equal(POCOS_DIAS, 5);
  // Cora: sin tickets, ticket promedio y ventas por dia con venta quedan en «—», no en $0.
  const celdas = fila('Cora').split('<td').slice(1).map((c) => c.replace(/<[^>]*>/g, '').replace(/^[^>]*>/, ''));
  assert.ok(celdas.filter((c) => c.includes('—')).length >= 3, celdas.join('|'));
  // Las capturas llevan al detalle de Capturas.
  assert.match(html, /<a href="#capturas"[^>]*>5<\/a>/);
  // Sin asistencias, «Dias trabajados» es «—» y no 0.
  assert.match(html, /<td class="num">—<\/td><\/tr>/);
  // «Sin atribuir» con su renglon y el total al final.
  assert.match(html, /Sin atribuir/);
  assert.ok(html.indexOf('Sin atribuir') < html.indexOf('<b>Total</b>'));
  // Cada encabezado ordena.
  assert.equal((html.match(/class="ordena"/g) ?? []).length, COLUMNAS.length + 1);
  assert.match(html, /aria-sort="descending"/);
  // La tabla del tiempo trae una fila por cubeta.
  assert.equal((tablaSerie(E).match(/<tr>/g) ?? []).length, 7 + 1);
});

test('la serie por persona: hasta tres con su color, el resto junto y «Sin atribuir» en gris, y las tarjetas escriben sus cifras', () => {
  const cubetas = [{ desde: '2026-11-01', hasta: '2026-11-01', dias: 1, parcial: false }, { desde: '2026-11-02', hasta: '2026-11-02', dias: 1, parcial: false }];
  const mas = ['a', 'b', 'c', 'd', 'e'].map((n, i) => ({ correo: `${n}@x`, nombre: n.toUpperCase(), valores: [(5 - i) * 100, 0] }));
  const E = { cubetas: cubetas.map((c) => ({ ...c, ventas: 0, ventas_total: 0 })), serie_personas: mas, serie_sin_atribuir: [50, 0], grano: 'dia' };
  const series = seriesVentas(E);
  assert.deepEqual(series.map((s: any) => s.nombre), ['A', 'B', 'C', 'Resto (2 personas)', 'Sin atribuir']);
  assert.deepEqual(series[3].valores, [200 + 100, 0]);
  assert.equal(series.at(-1).color, 'var(--apagado)');
  assert.equal(suma(series.map((s: any) => s.valores[0])), 1500 + 50);              // nada se pierde
  assert.deepEqual(seriesVentas({ ...E, serie_sin_atribuir: [0, 0] }).map((s: any) => s.nombre).includes('Sin atribuir'), false);
});
