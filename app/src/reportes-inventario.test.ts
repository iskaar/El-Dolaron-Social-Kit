// node --test src/reportes-inventario.test.ts
// Vista «Inventario» de /reportes (Issue #802): entradas y salidas, cohortes de venta y rebajas, todo con datos inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { hoyTienda } from './reportes.ts';
import { lunesDe, sumarDias } from './equipo.ts';
import { armarCohortes, compararRebajas, medianaDe, reporteInventario, type FilaDia, type FilaRebaja } from './reportes-inventario.ts';

const DIA_MS = 86_400_000;
type T = ReturnType<typeof tienda>;
const hace = (dias: number) => new Date(Date.now() - dias * DIA_MS).toISOString();
const diaDe = (dias: number) => hoyTienda(Date.now() - dias * DIA_MS);

let consecutivo = 0;
/** Una pieza del inventario capturada hace `dias` dias con `stock` unidades (la cantidad inicial que se vende o se queda). */
function pieza(t: T, dias: number, stock: number, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en, estado_analisis)
    values (?, ?, 'Pieza de prueba', ?, ?, 'S40', ?, ?, 'listo')`).run(id, `ED-9${String(++consecutivo).padStart(5, '0')}`, extra.precio ?? 30000, stock, hace(dias), hace(dias));
  return id;
}
/** Vende `cantidad` unidades de una pieza y pone el ticket hace `dias` dias (la hora se guarda como de la caja). */
async function vender(t: T, producto: string, cantidad: number, dias: number) {
  const id = crypto.randomUUID();
  const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: producto, cantidad }], forma_pago: 'efectivo', efectivo: 30000 * cantidad, caja: 'Caja 1' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  fecharVenta(t, id, dias);
  return id;
}
const fecharVenta = (t: T, id: string, dias: number) => t.db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?').run(hace(dias), hace(dias), id);
/** Cambia el precio como `por` y deja el renglon de la bitacora hace `dias` dias. */
function cambiarPrecio(t: T, producto: string, precio: number, por: string, dias: number) {
  t.db.prepare('update productos set precio = ?, modificado_por = ? where id = ?').run(precio, por, producto);
  const ultimo = t.db.prepare("select max(id) as id from productos_cambios where campo = 'precio'").get()!.id;
  t.db.prepare('update productos_cambios set en = ? where id = ?').run(hace(dias), ultimo);
}
const inventario = async (t: T, consulta = 'dias=28') => {
  const r = await t.pedir(`/api/reportes/inventario?${consulta}`);
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  return r.cuerpo;
};
const semanaDe = (r: any, dias: number) => r.cohortes.semanas.find((s: any) => s.lunes === lunesDe(diaDe(dias)));

test('cohorte: pieza con existencia 3 que vendio 1 en la semana 1 y 1 en la 3, venta el mismo dia, ticket cancelado y devolucion parcial', async () => {
  const t = tienda();
  const A = pieza(t, 40, 3);   // unidades 3: una a los 2 dias, otra a los 16, queda 1
  const B = pieza(t, 40, 1);   // vendida el mismo dia de la captura
  const C = pieza(t, 40, 2);   // la venta se cancela: sigue siendo 2 sin vender
  const D = pieza(t, 40, 4);   // vende 2 y devuelve 1: neto 1 vendida, existencia 3
  await vender(t, A, 1, 38);
  await vender(t, A, 1, 24);
  await vender(t, B, 1, 40 - 0.04);
  const cancelada = await vender(t, C, 1, 39);
  const venta = await vender(t, D, 2, 39);
  // Cancelar y devolver antes de que se acabe la ventana del ticket: se fecharon despues de la prueba de la API.
  fecharVenta(t, cancelada, 0); fecharVenta(t, venta, 0);
  assert.equal((await t.pedir(`/api/ventas/${cancelada}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' })).status, 200);
  const linea = (await t.pedir(`/api/ventas/${venta}`)).cuerpo.lineas[0].id;
  assert.equal((await t.pedir(`/api/ventas/${venta}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' })).status, 201);
  fecharVenta(t, cancelada, 39); fecharVenta(t, venta, 39);

  const r = await inventario(t, 'dias=60');
  const s = semanaDe(r, 40);
  // 3 + 1 + 2 + 4 unidades capturadas; vendidas 2 (A) + 1 (B) + 0 (C) + 1 (D) = 4; existencia 1 + 0 + 2 + 3 = 6.
  assert.deepEqual({ piezas: s.piezas, unidades: s.unidades, vendidas: s.vendidas, existencia: s.existencia, apartadas: s.apartadas }, { piezas: 4, unidades: 10, vendidas: 4, existencia: 6, apartadas: 0 });
  assert.equal(s.unidades, s.vendidas + s.existencia + s.apartadas, 'unidades = vendidas + existencia + apartadas');
  // Hace 40 dias: las dos primeras ventas de A estan a 2 y 16 dias; B a 0; D a 1.
  assert.deepEqual(s.pct, { 1: 30, 2: 30, 4: 40, 8: null }, 'A: 1 a los 2 dias y otra a los 16; B y D el primer dia; a las 8 semanas aun no llega');
});

test('una semana que aun no cumple k semanas no tiene valor (null), no 0 %', async () => {
  const t = tienda();
  pieza(t, 3, 5);        // semana actual: nada ha madurado
  pieza(t, 12, 2);       // la semana pasada o antepasada: ya tiene 1 semana pero no 4
  const r = await inventario(t, 'dias=28');
  const actual = semanaDe(r, 3);
  assert.deepEqual(actual.pct, { 1: null, 2: null, 4: null, 8: null });
  assert.deepEqual(actual.vendidas_en, { 1: null, 2: null, 4: null, 8: null });
  const vieja = semanaDe(r, 12);
  assert.equal(vieja.pct[4], null);
  assert.equal(vieja.pct[8], null);
  const antigua = r.cohortes.semanas[0];
  assert.ok(antigua.unidades === 0 && antigua.pct[1] === null, 'una semana sin capturas no es 0 % vendido');
  assert.equal(r.cohortes.vendido_4.pct, null, 'ninguna cohorte tiene 4 semanas con datos: no hay KPI');
});

test('una cohorte madura sin ventas si es 0 %, y alimenta el vendido a 4 semanas', async () => {
  const t = tienda();
  const A = pieza(t, 50, 2);
  pieza(t, 50, 2);
  await vender(t, A, 1, 48);
  const r = await inventario(t, 'dias=60');
  assert.equal(semanaDe(r, 50).pct[4], 25);
  assert.deepEqual({ pct: r.cohortes.vendido_4.pct, unidades: r.cohortes.vendido_4.unidades, vendidas: r.cohortes.vendido_4.vendidas }, { pct: 25, unidades: 4, vendidas: 1 });
  const otra = tienda();
  pieza(otra, 50, 3);
  assert.equal(semanaDe(await inventario(otra, 'dias=60'), 50).pct[4], 0);
});

test('existencia en una sucursal, apartados vivos, Mercado Libre y lo que salio por merma', async () => {
  const t = tienda();
  const A = pieza(t, 40, 1);
  t.db.prepare("insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, 'salk', 2, '')").run(A);
  const M = pieza(t, 40, 3);
  t.db.prepare("insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values ('O1', 'MLM1', ?, 1, 'descontada', 1, ?)").run(M, hace(35));
  t.db.prepare("insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values ('O2', 'MLM2', ?, 1, 'cancelada', 0, ?)").run(M, hace(35));
  t.db.prepare('update productos set stock = 2 where id = ?').run(M);   // la orden descontada bajo una; la cancelada no toco nada
  const X = pieza(t, 40, 3);
  t.db.prepare('update productos set stock = 2 where id = ?').run(X);   // se perdio una: queda registrada como merma
  t.db.prepare(`insert into conteo_ajustes (id, producto_id, motivo, cantidad, antes, despues, ajustado_por, ajustado_en) values ('aj1', ?, 'merma', 1, 3, 2, 'a@b.mx', ?)`).run(X, hace(30));
  const P = pieza(t, 40, 3);
  t.db.prepare('update productos set stock = 1 where id = ?').run(P);   // dos apartadas
  t.db.prepare(`insert into pedidos (id, folio, cliente, telefono, entrega, vendedora, estado, vence_en, creado_en, actualizado_en, anticipo, forma_pago, saldo, saldo_vence_en)
    values ('ped1', 1, 'Cliente', '000', 'tienda', 'v@b.mx', 'apartado', ?, ?, ?, 0, 'efectivo', 0, '')`).run(hace(-3), hace(2), hace(2));
  t.db.prepare("insert into pedido_lineas (pedido_id, producto_id, cantidad, precio) values ('ped1', ?, 2, 30000)").run(P);

  const r = await inventario(t, 'dias=60');
  const s = semanaDe(r, 40);
  // A: 1 + 2 = 3; M: 2 + 1 de ML = 3; X: 2 (la merma no esta en el denominador); P: 1 + 2 apartadas = 3.
  assert.deepEqual({ unidades: s.unidades, vendidas: s.vendidas, existencia: s.existencia, apartadas: s.apartadas, sin_venta: s.sin_venta }, { unidades: 11, vendidas: 1, existencia: 8, apartadas: 2, sin_venta: 1 });
  assert.equal(r.flujo.total.vendidas_ml, 1);
});

test('entradas y salidas: salidas = unidades netas de /api/reportes, capturas = lo capturado, y el neto es la diferencia', async () => {
  const t = tienda();
  const A = pieza(t, 20, 5);
  const B = pieza(t, 9, 2);
  pieza(t, 3, 4);
  pieza(t, 100, 7);                         // fuera del periodo
  await vender(t, A, 2, 15);
  const doble = await vender(t, A, 2, 8);
  await vender(t, B, 1, 1);
  const cancelado = await vender(t, B, 1, 0);
  assert.equal((await t.pedir(`/api/ventas/${cancelado}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' })).status, 200);
  const linea = (await t.pedir(`/api/ventas/${doble}`)).cuerpo.lineas[0].id;
  fecharVenta(t, doble, 0);
  assert.equal((await t.pedir(`/api/ventas/${doble}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' })).status, 201);
  fecharVenta(t, doble, 8);

  const viejo = (await t.pedir('/api/reportes?dias=28')).cuerpo;
  const r = await inventario(t, 'dias=28');
  assert.equal(r.flujo.total.vendidas, viejo.resumen.piezas, 'las salidas son las piezas netas del reporte de siempre');
  assert.equal(r.flujo.total.vendidas, 2 + 1 + 1);
  assert.equal(r.flujo.total.capturadas, 5 + 2 + 4, 'la pieza de hace 100 dias no cuenta');
  assert.equal(r.flujo.total.piezas, 3);
  assert.equal(r.flujo.total.neto, 11 - 4);
  assert.equal(r.flujo.semanas.reduce((s: number, w: any) => s + w.capturadas, 0), r.flujo.total.capturadas, 'las semanas suman el total');
  assert.equal(r.flujo.semanas.reduce((s: number, w: any) => s + w.vendidas, 0), r.flujo.total.vendidas);
  assert.equal(r.flujo.semanas.every((w: any) => w.neto === w.capturadas - w.vendidas), true);
  assert.equal(r.flujo.semanas[0].desde, r.dia_desde);
  assert.equal(r.flujo.semanas.at(-1).hasta, r.dia_hasta);
  assert.equal(r.flujo.semanas.at(-1).hasta >= r.flujo.semanas.at(-1).desde, true);
});

test('rebajas: baja a mano cuenta; subir, la IA y lo de las primeras 24 h no; dos bajas son dos movimientos de una pieza', async () => {
  const t = tienda();
  const A = pieza(t, 40, 3, { precio: 30000 });
  cambiarPrecio(t, A, 25000, 'ia', 39.9);                 // la IA al capturar: no es rebaja
  cambiarPrecio(t, A, 24000, 'caja@x.mx', 39.5);          // una persona dentro de las primeras 24 h: ajuste del alta, no rebaja
  cambiarPrecio(t, A, 20000, 'dueno@x.mx', 10);           // rebaja 1: 20 %
  cambiarPrecio(t, A, 22000, 'dueno@x.mx', 9);            // sube: no
  cambiarPrecio(t, A, 11000, 'dueno@x.mx', 8);            // rebaja 2: 50 %
  const B = pieza(t, 30, 1, { precio: 10000 });
  cambiarPrecio(t, B, 9000, 'sistema', 5);                // rebaja 10 % hecha por el sistema
  const C = pieza(t, 30, 1, { precio: 10000 });
  cambiarPrecio(t, C, 0, 'dueno@x.mx', 4);                // dejarla en 0 no es rebaja
  const D = pieza(t, 30, 1, { precio: 10000 });
  cambiarPrecio(t, D, 8000, 'dueno@x.mx', 60);            // fuera del periodo de 28 dias

  const r = await inventario(t, 'dias=28');
  assert.equal(r.rebajas.total.eventos, 3);
  assert.equal(r.rebajas.total.piezas, 2, 'dos piezas distintas aunque una se rebajo dos veces');
  assert.equal(Math.round(r.rebajas.total.pct_promedio * 100) / 100, Math.round((((4000 / 24000) * 100 + 50 + 10) / 3) * 100) / 100);
  assert.equal(r.rebajas.semanas.reduce((s: number, w: any) => s + w.eventos, 0), 3);
  assert.equal(typeof r.rebajas.desde_bitacora, 'string', 'desde cuando hay bitacora, de los datos');

  const vacio = await inventario(tienda(), 'dias=28');
  assert.equal(vacio.rebajas.desde_bitacora, null);
});

test('rebajadas contra piezas de la misma edad sin rebaja: unidades pendientes y vendidas en 14 dias', async () => {
  const t = tienda();
  const rebajada = pieza(t, 40, 4);
  cambiarPrecio(t, rebajada, 20000, 'dueno@x.mx', 20);      // 20 dias atras, con 20 dias de edad: tramo 0-2 semanas
  await vender(t, rebajada, 1, 17);                         // 3 dias despues
  await vender(t, rebajada, 1, 10);                         // 10 dias despues
  const sin = pieza(t, 40, 4);
  await vender(t, sin, 1, 20);                              // 6 dias despues de su punto de referencia (14 dias de edad = hace 26 dias)

  const r = await inventario(t, 'dias=28');
  const c = r.rebajas.comparacion;
  const { piezas, pendientes, vendidas } = c.tramos[0].rebajadas;
  assert.deepEqual({ piezas, pendientes, vendidas }, { piezas: 1, pendientes: 4, vendidas: 2 });
  assert.equal(c.tramos[0].rebajadas.pct, 50);
  assert.deepEqual({ piezas: c.tramos[0].sin_rebaja.piezas, pendientes: c.tramos[0].sin_rebaja.pendientes, vendidas: c.tramos[0].sin_rebaja.vendidas }, { piezas: 1, pendientes: 4, vendidas: 1 });
  assert.equal(c.comparables.pct, 50);
  assert.equal(c.comparables.pct_sin_rebaja, 25);
  assert.equal(c.comparables.diferencia_pp, 25);
  assert.equal(c.poca_muestra, true, 'cuatro unidades no concluyen nada');
  // Una rebaja de hace menos de 14 dias todavia no se puede juzgar.
  const t2 = tienda();
  const reciente = pieza(t2, 40, 4);
  cambiarPrecio(t2, reciente, 20000, 'dueno@x.mx', 5);
  const r2 = await inventario(t2, 'dias=28');
  assert.equal(r2.rebajas.comparacion.rebajadas.piezas, 0);
  assert.equal(r2.rebajas.total.piezas, 1, 'pero si cuenta como pieza rebajada del periodo');
});

test('dias en venta: mediana del periodo y del anterior desde el histograma', async () => {
  const t = tienda();
  const A = pieza(t, 40, 5);
  await vender(t, A, 1, 35);   // 5 dias
  await vender(t, A, 1, 30);   // 10
  await vender(t, A, 1, 5);    // 35 (periodo actual)
  const B = pieza(t, 12, 3);
  await vender(t, B, 1, 2);    // 10
  const r = await inventario(t, 'dias=10');
  assert.equal(r.dias_en_venta.mediana, (10 + 35) / 2);
  assert.equal(r.dias_en_venta.unidades, 2);
  assert.equal(r.dias_en_venta.tramos.reduce((s: number, x: any) => s + x.unidades, 0), 2);
  assert.equal(medianaDe([{ d: 3, n: 1 }, { d: 9, n: 1 }, { d: 20, n: 1 }]), 9);
  assert.equal(medianaDe([{ d: 3, n: 2 }, { d: 9, n: 2 }]), 6);
  assert.equal(medianaDe([]), null);
});

test('periodo vacio: todo en cero, cohortes sin valores y sin inventar nada', async () => {
  const t = tienda();
  const r = await inventario(t, 'dias=7');
  assert.deepEqual(r.flujo.total, { capturadas: 0, piezas: 0, vendidas: 0, vendidas_ml: 0, neto: 0 });
  assert.equal(r.cohortes.semanas.length >= 8, true, 'al menos ocho semanas de captura aunque el periodo sea corto');
  assert.equal(r.cohortes.semanas.every((s: any) => s.pct[1] === null && s.unidades === 0), true);
  assert.equal(r.cohortes.vendido_4.pct, null);
  assert.equal(r.dias_en_venta.mediana, null);
  assert.equal(r.rebajas.total.eventos, 0);
  assert.equal(r.rebajas.comparacion.comparables.pct, null);
  assert.equal(r.rebajas.comparacion.poca_muestra, true);
  // La pieza de fabrica de la tienda de prueba no tiene fecha de captura: no se cuenta ni se rompe nada.
  await vender(t, PRODUCTO, 1, 1);
  const con = await inventario(t, 'dias=7');
  assert.equal(con.flujo.total.vendidas, 1);
  assert.equal(con.flujo.total.capturadas, 0);
  assert.equal(con.dias_en_venta.unidades, 0, 'sin fecha de captura no hay dias en venta');
});

test('un rango pasado y cerrado: solo sus semanas, y las ventas posteriores cuentan en la cohorte pero no en las salidas del rango', async () => {
  const t = tienda();
  const P = pieza(t, 85, 2);
  await vender(t, P, 1, 82);
  await vender(t, P, 1, 0);                  // hoy: fuera del rango
  const consulta = `desde=${diaDe(90)}&hasta=${diaDe(60)}`;
  const r = await inventario(t, consulta);
  assert.equal(r.dia_desde, diaDe(90));
  assert.equal(r.dia_hasta, diaDe(60));
  assert.equal(r.flujo.total.vendidas, 1, 'la venta de hoy no es de ese rango');
  assert.equal(r.flujo.total.capturadas, 2);
  const s = semanaDe(r, 85);
  assert.deepEqual(s.pct, { 1: 50, 2: 50, 4: 50, 8: 50 }, 'la cohorte ya maduro: 1 de 2 a los 3 dias; la de hoy esta a mas de 8 semanas');
  assert.equal(s.vendidas, 2);
  assert.equal(r.cohortes.semanas.at(-1).lunes, lunesDe(diaDe(60)));
  assert.equal(r.cohortes.vendido_4.pct, 50);
});

test('tienda: una clave invalida es 400 y una valida no cambia nada (la vista es del negocio completo)', async () => {
  const t = tienda();
  pieza(t, 10, 2);
  assert.equal((await t.pedir('/api/reportes/inventario?dias=7&tienda=nada')).status, 400);
  const a = await inventario(t, 'dias=28'), b = await inventario(t, 'dias=28&tienda=soledad');
  assert.deepEqual({ ...b, ahora: 0 }, { ...a, ahora: 0 });
  assert.equal((await t.pedir('/api/reportes/inventario?desde=2026-01-02&hasta=2026-01-01')).status, 400);
  assert.equal(typeof reporteInventario, 'function');
});

/* ---------- aritmetica pura ---------- */

const fila = (dia: string, p: Partial<FilaDia>): FilaDia => ({ dia, piezas: 1, unidades: 10, vendidas: 0, existencia: 10, apartadas: 0, sin_venta: 0, v1: 0, v2: 0, v4: 0, v8: 0, ...p });

test('armarCohortes: madurez por semana y vendido a 4 semanas solo de lo maduro', () => {
  const lunes = '2026-10-05';
  const ahora = Date.parse('2026-11-15T12:00:00Z');
  const filas = [fila('2026-10-05', { v1: 1, v2: 2, v4: 4, v8: 5 }), fila('2026-10-08', { v1: 1, v2: 2, v4: 4, v8: 5 }), fila('2026-11-10', { v1: 3 })];
  const { semanas, vendido_4 } = armarCohortes(filas, [lunes, '2026-11-09'], ahora);
  assert.deepEqual(semanas[0].pct, { 1: 10, 2: 20, 4: 40, 8: null }, 'cuatro semanas si, ocho no: el 12 de oct + 56 dias pasa de hoy');
  assert.deepEqual(semanas[1].pct, { 1: null, 2: null, 4: null, 8: null });
  assert.deepEqual(vendido_4, { pct: 40, unidades: 20, vendidas: 8, semanas: 1 });
});

test('compararRebajas: la tasa esperada usa la mezcla de edades de las rebajadas y deja fuera tramos sin comparacion', () => {
  const filas: FilaRebaja[] = [
    { grupo: 'rebajada', tramo: 0, piezas: 5, pendientes: 10, vendidas: 5 },
    { grupo: 'rebajada', tramo: 2, piezas: 5, pendientes: 30, vendidas: 3 },
    { grupo: 'rebajada', tramo: 3, piezas: 1, pendientes: 4, vendidas: 4 },        // sin control: no entra
    { grupo: 'control', tramo: 0, piezas: 20, pendientes: 100, vendidas: 20 },     // 20 %
    { grupo: 'control', tramo: 2, piezas: 20, pendientes: 100, vendidas: 10 },     // 10 %
  ];
  const c = compararRebajas(filas);
  assert.equal(c.comparables.pendientes, 40);
  assert.equal(c.comparables.vendidas, 8);
  assert.equal(c.comparables.pct, 20);
  assert.equal(c.comparables.pct_sin_rebaja, (10 * 0.2 + 30 * 0.1) * 100 / 40);   // 12.5 %
  assert.equal(c.comparables.diferencia_pp, 7.5);
  assert.equal(c.poca_muestra, false);
  assert.equal(c.rebajadas.pendientes, 44, 'el total sin filtrar cuenta todas las rebajadas');
  assert.equal(compararRebajas([]).comparables.pct, null);
  assert.equal(sumarDias('2026-01-31', 1), '2026-02-01');
});
