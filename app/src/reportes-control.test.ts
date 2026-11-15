// node --test src/reportes-control.test.ts
// Vista Control de /reportes (Issue #802): el endpoint contra el doble de D1, cuadrado con /api/reportes, y las funciones puras.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import { hoyTienda } from './reportes.ts';
import { permiso, puede } from './cuentas.ts';
import { sumarDias } from '../public/graficas.js';
import { tarjetasHtml } from '../public/reportes-resumen.js';
import {
  armarControl, agruparMotivos, claveMotivo, tramoDemora, momentoTienda, tarjetasControl, htmlVista, graficaDe, tablaPersonas, tablaMotivos, motivosHtml,
  MEDIDAS_CONTROL, MAX_MOTIVOS, TRAMOS_DEMORA,
} from '../public/reportes-control.js';

type T = ReturnType<typeof tienda>;
const suma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const llamar = (t: T, consulta: string) => t.pedir(`/api/reportes/control?${consulta}`, undefined, 'GET');
const hoy = hoyTienda();
const dia = (n: number) => sumarDias(hoy, -n);
/** Un instante de la tienda: las `h`:`m` de un dia de la tienda, en UTC (la tienda es UTC-6 fijo). */
const a = (d: string, h: number, m = 0) => new Date(Date.parse(`${d}T00:00:00.000Z`) + (h + 6) * 3_600_000 + m * 60_000).toISOString();

const usuario = (t: T, correo: string, nombre: string, roles: string) =>
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, 1, '', '')`).run(correo, nombre, roles);

/** Una venta de `n` piezas del producto de prueba ($250 cada una) en el dia `d`, cobrada por `cajero` y atendida por `vendedora`. Devuelve el id. */
async function vender(t: T, d: string, cajero: string, n = 1, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: n }], forma_pago: 'efectivo', efectivo: 25000 * n, caja: 'Caja 1', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const cuando = a(d, 12);   // siempre a las 12:00 de la tienda: las demoras y los patrones de hora salen exactos
  t.db.prepare('update ventas set creado_en = ?, registrado_en = ?, cajero = ? where id = ?').run(cuando, cuando, cajero, id);
  return id;
}
const mas = (iso: string, minutos: number) => new Date(Date.parse(iso) + minutos * 60_000).toISOString();
const cuandoSeVendio = (t: T, id: string) => (t.db.prepare('select creado_en from ventas where id = ?').get(id) as { creado_en: string }).creado_en;
/** Cancela el ticket completo (por la API) y deja quien y por que como se pidan, `minutos` despues de la venta. */
async function cancelar(t: T, id: string, por: string, minutos: number, motivo: string) {
  const r = await t.pedir(`/api/ventas/${id}/cancelar`, { motivo: 'x', caja: 'Caja 1' });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  t.db.prepare('update ventas set cancelada_por = ?, cancelada_en = ?, motivo_cancelacion = ? where id = ?').run(por, mas(cuandoSeVendio(t, id), minutos), motivo, id);
}
/** Devuelve una pieza del ticket (por la API) y deja autor, hora (`minutos` despues de la venta) y motivo como se pidan. */
async function devolver(t: T, id: string, autor: string, minutos: number, motivo: string) {
  const linea = (await t.pedir(`/api/ventas/${id}`)).cuerpo.lineas[0].id;
  const iddev = crypto.randomUUID();
  const r = await t.pedir(`/api/ventas/${id}/lineas/${linea}/cancelar`, { id: iddev, cantidad: 1, motivo: 'x', caja: 'Caja 1' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  t.db.prepare('update devoluciones set autor = ?, creado_en = ?, motivo = ? where id = ?').run(autor, mas(cuandoSeVendio(t, id), minutos), motivo, iddev);
}
const apertura = (t: T, por: string, en: string) =>
  t.db.prepare(`insert into cajon_aperturas (id, abierto_por, abierto_en, registrado_en, caja) values (?, ?, ?, ?, 'Caja 1')`).run(crypto.randomUUID(), por, en, en);
const corte = (t: T, hasta: string, diferencia: number) =>
  t.db.prepare(`insert into cortes (id, caja, cajero, desde, hasta, tickets, fondo_inicial, efectivo_ventas, efectivo_devoluciones, retiros, gastos, efectivo_esperado,
    efectivo_contado, diferencia, tarjeta_sistema, tarjeta_terminal, transferencias, dolarones, fondo_siguiente, entregado, notas, creado_en)
    values (?, 'Caja 1', 'ana@prueba.mx', null, ?, 1, 0, 0, 0, 0, 0, 0, ?, ?, 0, 0, 0, 0, 0, 0, '', ?)`).run(crypto.randomUUID(), hasta, diferencia, diferencia, hasta);

const ANA = 'ana@prueba.mx', BETO = 'beto@prueba.mx', PC = 'pc@prueba.mx';

/**
 * Un periodo con de todo. Pesos de $250 la pieza. Cajero: ana cobra 4 tickets, beto 4, la computadora 1 y la cuenta vacia ('') 1.
 *  - ayer-2: v1, v2 (ana), v3 (beto) cancelado por ana a los 3 minutos («No encendió. »);
 *  - ayer-3: v4 (beto, 2 piezas) con una pieza devuelta por beto («no encendio»); v5 (ana) cancelado por el dueno al dia siguiente («cliente ya no quiso  »);
 *  - ayer-4: v6 (ana) con descuento aprobado pedido por ana y aprobado por el dueno; v7 (beto) pedido y aprobado por el dueno; v8 (beto) con descuento sin solicitud; v9 (pc), v10 ('').
 */
async function sembrar(t: T) {
  t.db.prepare('update productos set stock = 100000 where id = ?').run(PRODUCTO);
  usuario(t, ANA, 'Ana', 'cajero'); usuario(t, BETO, 'Beto', 'cajero'); usuario(t, PC, 'Caja Soledad', 'computadora');
  const v: Record<string, string> = {};
  v.v1 = await vender(t, dia(2), ANA); v.v2 = await vender(t, dia(2), ANA); v.v3 = await vender(t, dia(2), BETO);
  v.v4 = await vender(t, dia(3), BETO, 2); v.v5 = await vender(t, dia(3), ANA);
  v.v6 = await vender(t, dia(4), ANA); v.v7 = await vender(t, dia(4), BETO); v.v8 = await vender(t, dia(4), BETO);
  v.v9 = await vender(t, dia(4), PC); v.v10 = await vender(t, dia(4), '');
  await cancelar(t, v.v3, ANA, 3, 'No encendió. ');                 // a los 3 minutos
  await devolver(t, v.v4, BETO, 30, 'no encendio');                // a la media hora
  await cancelar(t, v.v5, DUENO, 24 * 60, 'cliente ya no quiso  ');  // al dia siguiente
  const solicitud = (id: string, pidio: string, aprobo: string) => t.db.prepare(
    `insert into solicitudes (id, tipo, correo, nombre, justificacion, datos, estado, creado_en, resuelto_en, resuelto_por)
     values (?, 'descuento', ?, '', 'x', '{}', 'aprobada', '', '', ?)`).run(id, pidio, aprobo);
  solicitud('s6', ANA, DUENO); solicitud('s7', DUENO, DUENO);
  t.db.prepare("update ventas set descuento = 3000, promo = 1000, descuento_id = 's6' where id = ?").run(v.v6);   // aprobado: 2000
  t.db.prepare("update ventas set descuento = 1500, promo = 0, descuento_id = 's7' where id = ?").run(v.v7);      // aprobado: 1500, autoaprobado
  t.db.prepare('update ventas set descuento = 500, promo = 0 where id = ?').run(v.v8);                           // 500 sin solicitud ligada
  apertura(t, ANA, a(dia(2), 11)); apertura(t, ANA, a(dia(3), 11)); apertura(t, ANA, a(dia(3), 12)); apertura(t, BETO, a(dia(1), 18));
  apertura(t, ANA, a(dia(40), 11));                                                                                // fuera del periodo
  corte(t, a(dia(2), 20), -500); corte(t, a(dia(3), 20), 0); corte(t, a(dia(4), 20), 1200); corte(t, a(dia(2), 21), -300);
  return v;
}

test('las tarjetas cuadran con /api/reportes: lo devuelto es bruto - vendido y un ticket cancelado esta en el bruto pero no en el neto', async () => {
  const t = tienda();
  await sembrar(t);
  for (const consulta of ['dias=10', 'dias=10&grano=semana', 'dias=10&comparar=ninguna', 'dias=10&comparar=mes']) {
    const R = (await t.pedir('/api/reportes?dias=10', undefined, 'GET')).cuerpo;
    const rr = await llamar(t, consulta);
    assert.equal(rr.status, 200, consulta);
    const C = rr.cuerpo, tot = C.totales;
    // Denominador: el bruto del cuadre (todos los tickets, cancelados incluidos) y los tickets cobrados.
    assert.equal(tot.bruto, R.cuadre.bruto, consulta);
    assert.equal(tot.tickets, 10);
    // Numerador: lo que el cuadre resta del bruto para llegar a lo vendido.
    assert.equal(tot.canc_valor, R.cuadre.cancelados + R.cuadre.devoluciones_pieza, consulta);
    assert.equal(tot.bruto - tot.canc_valor, R.cuadre.vendido, consulta);
    assert.equal(R.cuadre.vendido, R.resumen.total);
    assert.equal(tot.tk_valor, 25000 * 2);            // v3 y v5, completos
    assert.equal(tot.pz_valor, 25000);                // una pieza de v4
    assert.equal(tot.tk_n, 2); assert.equal(tot.pz_n, 1); assert.equal(tot.canc_n, 3);
    // El mismo conjunto de movimientos que el bloque de siempre.
    assert.equal(tot.canc_n, R.cancelaciones.n);
    assert.deepEqual(C.demora.map((x: any) => [x.ticket, x.pieza]), [[1, 0], [0, 1], [0, 0], [1, 0]]);   // 3 min, 30 min, otro dia
    const tarjetas = Object.fromEntries(tarjetasControl(C).map((k: any) => [k.clave, k]));
    assert.equal(tarjetas.tasa.valor, `${((3 * 25000 * 100) / tot.bruto).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`);
    assert.equal(tarjetas.tk.valor, '2');
    assert.match(tarjetas.tk.pie, /20\.0 %/);          // 2 de 10 tickets
    assert.equal(tarjetas.valor.valor, '$750.00');
    // Los patrones de hora son los de la ACCION: cancelaciones y devoluciones a las 12:03, 12:30 y 12:00; el cajon a las 11, 11, 12 y 18.
    const celdas = (filas: { dia_semana: number; hora: number; n: number }[]) => filas.map((f) => `${f.dia_semana}-${f.hora}-${f.n}`).sort();
    const esperadas = (lista: string[]) => { const m = new Map<string, number>(); for (const iso of lista) { const k = momentoTienda(iso)!; const c = `${k.dia_semana}-${k.hora}`; m.set(c, (m.get(c) ?? 0) + 1); } return [...m].map(([c, n]) => `${c}-${n}`).sort(); };
    assert.deepEqual(celdas(C.por_hora.movimientos), esperadas([a(dia(2), 12, 3), a(dia(3), 12, 30), a(dia(2), 12, 0)]));
    assert.deepEqual(celdas(C.por_hora.cajon), esperadas([a(dia(2), 11), a(dia(3), 11), a(dia(3), 12), a(dia(1), 18)]));
    // Cajon, cortes y descuentos del periodo.
    assert.equal(tot.cajon_n, 4);                      // la de hace 40 dias no entra
    assert.equal(tot.cortes_n, 4); assert.equal(tot.cortes_corto, 2); assert.equal(tot.cortes_sobra, 1); assert.equal(tot.cortes_exacto, 1);
    assert.equal(tot.dif, -500 + 0 + 1200 - 300); assert.equal(tot.falta, 800); assert.equal(tot.sobra, 1200);
    assert.equal(tot.desc_n, 3); assert.equal(tot.desc_monto, 2000 + 1500 + 500);
    assert.equal(C.descuentos.autoaprobados, 1); assert.equal(C.descuentos.sin_solicitud, 1);
    // Las cubetas suman los totales, medida por medida.
    for (const m of MEDIDAS_CONTROL) assert.equal(suma(C.cubetas.map((c: any) => c[m])), tot[m], `${consulta} ${m}`);
    // Los descuentos aprobados de Ventas son los mismos (otros = descuento - promo, sin cancelados).
    assert.equal(tot.desc_monto, R.descuentos.otros);
  }
  t.db.close();
});

test('una pieza devuelta en cupon (importe 0, el dinero va en `cupon`) y una pagada con Dolarones valen en Control lo mismo que resta el cuadre', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100000 where id = ?').run(PRODUCTO);
  const v = await vender(t, dia(1), DUENO, 3);
  const linea = (t.db.prepare('select id from venta_lineas where venta_id = ?').get(v) as { id: number }).id;
  // Como la deja devolverEnCupon: ventas.devuelto sube con el dinero que se paso a cupon y la devolucion trae importe 0.
  t.db.prepare('update ventas set devuelto = 25000, devuelto_cupon = 25000, dolarones_devueltos = 1000 where id = ?').run(v);
  t.db.prepare('update venta_lineas set cancelada_cantidad = 2 where id = ?').run(linea);
  const dev = (id: string, importe: number, cupon: number, dolarones: number) => t.db.prepare(
    `insert into devoluciones (id, venta_id, linea_id, cantidad, importe, dolarones, cupon, forma_pago, caja, autor, motivo, creado_en, tienda)
     values (?, ?, ?, 1, ?, ?, ?, 'efectivo', 'Caja 1', ?, 'talla', ?, 'soledad')`).run(id, v, linea, importe, dolarones, cupon, DUENO, a(dia(1), 13));
  dev('d1', 0, 25000, 0); dev('d2', 0, 0, 1000);
  const R = (await t.pedir('/api/reportes?dias=3', undefined, 'GET')).cuerpo, C = (await llamar(t, 'dias=3')).cuerpo;
  assert.equal(C.totales.pz_n, 2);
  assert.equal(C.totales.canc_valor, R.cuadre.devoluciones_pieza + R.cuadre.cancelados);   // 26000: el cupon cuenta como dinero devuelto
  assert.equal(C.totales.canc_valor, 26000);
  assert.equal(C.totales.bruto - C.totales.canc_valor, R.cuadre.vendido);
  t.db.close();
});

test('un ticket vendido antes del periodo y cancelado dentro cuenta en el periodo de su VENTA, igual que el bloque cancelaciones', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100000 where id = ?').run(PRODUCTO);
  const vieja = await vender(t, dia(10), DUENO);
  await vender(t, dia(1), DUENO);
  await cancelar(t, vieja, DUENO, 10 * 24 * 60, 'se cobro doble');   // cancelada 10 dias despues: hoy, a la misma hora
  const corto = (await llamar(t, 'dias=7')).cuerpo, largo = (await llamar(t, 'dias=14')).cuerpo;
  assert.equal(corto.totales.canc_n, 0);                                           // la venta cae antes: no cuenta aqui aunque se cancelo hoy
  assert.equal((await t.pedir('/api/reportes?dias=7', undefined, 'GET')).cuerpo.cancelaciones.n, 0);   // y el bloque de siempre dice lo mismo
  assert.equal(largo.totales.canc_n, 1);
  assert.equal((await t.pedir('/api/reportes?dias=14', undefined, 'GET')).cuerpo.cancelaciones.n, 1);
  const indice = largo.cubetas.findIndex((c: any) => c.desde === dia(10));
  assert.equal(largo.cubetas[indice].tk_n, 1);                                     // en la cubeta del dia de la venta
  assert.equal(largo.cubetas[largo.cubetas.length - 1].tk_n, 0);                   // no en la de hoy
  assert.equal(largo.demora[3].ticket, 1);                                         // otro dia
  const hora = momentoTienda(mas(cuandoSeVendio(t, vieja), 10 * 24 * 60))!;      // el patron de hora usa cuando se CANCELO
  assert.deepEqual(largo.por_hora.movimientos, [{ dia_semana: hora.dia_semana, hora: hora.hora, n: 1 }]);
  t.db.close();
});

test('los motivos iguales sin importar mayusculas, acentos ni espacios se agrupan; lo demas no se reclasifica', async () => {
  const t = tienda();
  await sembrar(t);
  const C = (await llamar(t, 'dias=10')).cuerpo;
  const { lista, otros, distintos } = C.motivos;
  assert.equal(otros, null);
  assert.equal(distintos, 2);
  assert.deepEqual(lista.map((g: any) => [g.clave, g.n, g.tickets, g.piezas, g.valor]), [
    ['no encendio', 2, 1, 1, 50000],            // «No encendió. » (ticket) y «no encendio» (pieza)
    ['cliente ya no quiso', 1, 1, 0, 25000],
  ]);
  assert.equal(lista[0].texto, 'no encendio');   // se muestra una escritura real del grupo: la mas usada y, a igualdad, la primera por orden alfabetico
  assert.equal(lista[1].texto, 'cliente ya no quiso');   // sin los espacios de mas
  t.db.close();
});

test('claveMotivo y agruparMotivos: top y «otros», sin motivo aparte, nada de categorias inventadas', () => {
  assert.equal(claveMotivo('  Talla   EQUIVOCADA!  '), 'talla equivocada');
  assert.equal(claveMotivo('Cambió de opinión.'), 'cambio de opinion');
  assert.equal(claveMotivo(null), '');
  assert.notEqual(claveMotivo('talla equivocada'), claveMotivo('talla incorrecta'));   // no se unen por parecidos
  const ev = (motivo: string, n = 1, tipo = 'ticket') => Array.from({ length: n }, () => ({ motivo, tipo, dinero: 1000, dolarones: 500 }));
  const muchos = [...ev('A', 5), ...ev('B', 4), ...ev('C', 3), ...ev('D', 3), ...ev('E', 2), ...ev('F', 2), ...ev('G', 2), ...ev('H', 1), ...ev('I', 1, 'pieza'), ...ev('J', 1), ...ev('  ', 2)];
  const g = agruparMotivos(muchos);
  assert.equal(g.lista.length, MAX_MOTIVOS);
  assert.equal(g.distintos, 11);
  assert.equal(g.otros!.distintos, 3);
  assert.equal(g.otros!.n, 3);                                    // H, I y J: las tres de menos uso, de una sola vez cada una
  assert.equal(suma(g.lista.map((x: any) => x.n)) + g.otros!.n, muchos.length);
  assert.equal(suma(g.lista.map((x: any) => x.valor)) + g.otros!.valor, muchos.length * 1500);   // nada se pierde
  assert.ok(g.lista.some((x: any) => x.texto === 'Sin motivo') || g.otros!.n > 0);
  assert.equal(agruparMotivos([]).lista.length, 0);
  assert.equal(agruparMotivos([]).otros, null);
  assert.equal(agruparMotivos(ev('x', 2)).otros, null);
});

test('por persona: cada total suma exactamente la tarjeta, y quien no esta registrado se cuenta, no se descarta', async () => {
  const t = tienda();
  await sembrar(t);
  const C = (await llamar(t, 'dias=10')).cuerpo, tot = C.totales;
  const campos: [string, string][] = [['tickets', 'tickets'], ['tk_n', 'tk_n'], ['pz_n', 'pz_n'], ['cajon_n', 'cajon_n'], ['desc_pidio_n', 'desc_n'], ['desc_aprobo_n', 'desc_n'], ['desc_pidio_monto', 'desc_monto']];
  for (const [persona, total] of campos) assert.equal(suma(C.personas.map((p: any) => p[persona])), tot[total], persona);
  assert.equal(suma(C.personas.map((p: any) => p.tk_valor + p.pz_valor)), tot.canc_valor);
  const por = (c: string) => C.personas.find((p: any) => p.correo === c);
  assert.deepEqual([por(ANA).tickets, por(ANA).tk_n, por(ANA).pz_n, por(ANA).cajon_n], [4, 1, 0, 3]);          // ana cobro v1, v2, v5 y v6, y cancelo el ticket de beto
  assert.deepEqual([por(BETO).tickets, por(BETO).tk_n, por(BETO).pz_n, por(BETO).cajon_n], [4, 0, 1, 1]);
  assert.equal(por(DUENO).tk_n, 1);                                                                          // cancelo el de ana
  assert.equal(por(PC).computadora, true);                                                                   // la cuenta de la computadora se marca
  assert.equal(por(PC).tickets, 1);
  assert.equal(por('').nombre, 'Sin registrar');                                                             // un ticket sin cuenta guardada: se cuenta
  assert.equal(por('').tickets, 1);
  assert.equal(por(ANA).desc_pidio_n, 1); assert.equal(por(DUENO).desc_aprobo_n, 2); assert.equal(por(DUENO).desc_auto_n, 1);
  assert.equal(por('').desc_pidio_n, 1);                                                                     // el descuento sin solicitud
  assert.equal(por(ANA).nombre, 'Ana');
  assert.equal(tot.tickets, 10);                                                                             // v1..v10: ninguno se pierde
  t.db.close();
});

test('periodo vacio: ceros, sin series inventadas y el HTML lo dice', async () => {
  const t = tienda();
  const r = await llamar(t, 'dias=28');
  assert.equal(r.status, 200);
  const C = r.cuerpo;
  assert.equal(C.cubetas.length, 28);
  for (const m of MEDIDAS_CONTROL) assert.equal(C.totales[m], 0, m);
  assert.deepEqual(C.personas, []);
  assert.deepEqual(C.motivos, { lista: [], otros: null, distintos: 0 });
  assert.deepEqual(C.por_hora, { movimientos: [], cajon: [] });
  const tarjetas = Object.fromEntries(tarjetasControl(C).map((k: any) => [k.clave, k]));
  assert.equal(tarjetas.tasa.valor, '—');               // sin ventas no hay tasa: ni 0 %
  assert.equal(tarjetas.dif.valor, '—');
  assert.match(tarjetas.dif.pie, /Sin cortes/);
  const html = htmlVista(C);
  assert.match(html, /Sin cancelaciones ni devoluciones en este periodo/);
  assert.match(html, /Nadie abrió el cajón sin venta/);
  assert.match(html, /Sin cortes en este periodo/);
  for (const g of ['tiempo', 'cajon', 'cortes', 'demora']) assert.match(graficaDe(g, C, 600), /class="vacio"/, g);
  assert.doesNotMatch(Object.values(['tiempo', 'cajon', 'cortes', 'demora']).map((g) => graficaDe(g, C, 600)).join(''), /<svg/);
  t.db.close();
});

test('un rango pasado cerrado: tickets, movimientos y cortes son solo los de esos dias', async () => {
  const t = tienda();
  await sembrar(t);
  const C = (await llamar(t, `desde=${dia(4)}&hasta=${dia(3)}`)).cuerpo;
  assert.equal(C.periodo.dias, 2);
  assert.equal(C.totales.tickets, 7);                 // v4, v5 (dia 3) y v6..v10 (dia 4)
  assert.equal(C.totales.tk_n, 1); assert.equal(C.totales.pz_n, 1);   // v5 y la pieza de v4; lo de ayer-2 queda fuera
  assert.equal(C.totales.cajon_n, 2);                 // las dos de ana del dia 3
  assert.equal(C.totales.cortes_n, 2);
  assert.equal(C.totales.desc_n, 3);
  assert.equal(C.cubetas.length, 2);
  // Con comparacion: el periodo de igual largo justo antes (dias 6 y 5, sin nada) y el del mes pasado.
  assert.equal(C.comparacion.desde, dia(6));
  assert.equal(C.anterior.tickets, 0);
  const mes = (await llamar(t, `desde=${dia(4)}&hasta=${dia(3)}&comparar=mes`)).cuerpo;
  assert.equal(mes.comparar, 'mes');
  assert.ok(mes.comparacion.hasta < dia(4));
  const ninguna = (await llamar(t, `desde=${dia(4)}&hasta=${dia(3)}&comparar=ninguna`)).cuerpo;
  assert.equal(ninguna.comparacion, null); assert.equal(ninguna.anterior, null);
  t.db.close();
});

test('la comparacion y el grano: la semana suma lo mismo que los dias; las tarjetas dicen contra que se compara', async () => {
  const t = tienda();
  await sembrar(t);
  const dias = (await llamar(t, 'dias=20&grano=dia')).cuerpo, semanas = (await llamar(t, 'dias=20&grano=semana')).cuerpo;
  assert.equal(semanas.grano, 'semana');
  for (const m of MEDIDAS_CONTROL) assert.equal(semanas.totales[m], dias.totales[m], m);
  assert.ok(semanas.cubetas.length < dias.cubetas.length);
  // Ahora el periodo es la semana de los movimientos y la comparacion trae lo anterior: sube y baja salen con flecha y signo.
  const C = (await llamar(t, `desde=${dia(6)}&hasta=${dia(1)}`)).cuerpo;
  assert.equal(C.anterior.tickets, 0);                                              // antes de ayer-6 no hay ventas
  const tarjetas = tarjetasControl(C);
  assert.equal(tarjetas.length, 8);
  assert.ok(tarjetas.every((k: any) => k.comparando === true && k.hayComp === false));   // sin ventas en el periodo comparado: «Sin datos en el periodo comparado»
  assert.match(tarjetasHtml(tarjetas), /Sin datos en el periodo comparado/);
  // Con ventas antes: se pide una ventana que las contenga y los cambios llevan flecha escrita.
  const E = (await llamar(t, `desde=${dia(3)}&hasta=${dia(2)}`)).cuerpo;            // periodo: dias 3 y 2; antes: dias 5 y 4
  assert.equal(E.anterior.tickets, 5);
  const html = tarjetasHtml(tarjetasControl(E));
  assert.match(html, /[▲▼=] /);
  t.db.close();
});

test('la pantalla escapa todo lo que escriben otras personas: motivos, nombres y correos', async () => {
  const t = tienda();
  await sembrar(t);
  usuario(t, 'x@prueba.mx', '<b>Mala</b> & "Co"', 'cajero');
  const v = await vender(t, dia(1), 'x@prueba.mx');
  await cancelar(t, v, 'x@prueba.mx', 5, '<script>alert(1)</script> ñandú');
  const C = (await llamar(t, 'dias=10')).cuerpo;
  const todo = `${htmlVista(C)}${tablaPersonas(C)}${tablaMotivos(C)}${motivosHtml(C)}`;
  assert.doesNotMatch(todo, /<script>/);
  assert.doesNotMatch(todo, /<b>Mala/);
  assert.match(todo, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(todo, /&lt;b&gt;Mala&lt;\/b&gt; &amp; &quot;Co&quot;/);
  t.db.close();
});

test('la hora de un movimiento es la de la tienda (UTC-6): una accion a las 23:30 de un sabado cae en sabado 23, aunque en UTC ya sea domingo', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100000 where id = ?').run(PRODUCTO);
  let sabado = 1;
  while (new Date(`${dia(sabado)}T12:00:00Z`).getUTCDay() !== 6) sabado++;           // el sabado mas reciente de ayer hacia atras
  const tarde = a(dia(sabado), 23, 30);
  assert.equal(new Date(tarde).getUTCDay(), 0);                                      // en UTC es domingo 05:30
  const v = await vender(t, dia(sabado), DUENO, 2);
  await cancelar(t, v, DUENO, 11 * 60 + 30, 'x');                                    // la venta fue a las 12:00; el cancelado, a las 23:30
  const v2 = await vender(t, dia(sabado), DUENO, 2);
  await devolver(t, v2, DUENO, 11 * 60 + 30, 'x');                                   // la devolucion, a las 23:30
  apertura(t, DUENO, tarde);
  assert.equal(t.db.prepare('select cancelada_en from ventas where id = ?').get(v)!.cancelada_en, tarde);
  const C = (await llamar(t, 'dias=14')).cuerpo;
  assert.deepEqual(C.por_hora.movimientos, [{ dia_semana: 6, hora: 23, n: 2 }]);
  assert.deepEqual(C.por_hora.cajon, [{ dia_semana: 6, hora: 23, n: 1 }]);
  assert.equal(C.cubetas.find((c: any) => c.desde === dia(sabado)).cajon_n, 1);       // y cuenta en el sabado, no en el domingo
  assert.deepEqual(momentoTienda(tarde), { dia: dia(sabado), hora: 23, dia_semana: 6 });
  t.db.close();
});

test('tiempo entre la venta y el movimiento: tramos, y un reloj de caja adelantado cuenta como cero', () => {
  const venta = '2026-11-10T16:00:00.000Z';   // 10:00 de la tienda
  assert.equal(tramoDemora(venta, '2026-11-10T16:05:00.000Z'), 0);     // justo en la ventana del cajero
  assert.equal(tramoDemora(venta, '2026-11-10T16:05:01.000Z'), 1);
  assert.equal(tramoDemora(venta, '2026-11-10T17:00:00.000Z'), 1);     // una hora exacta
  assert.equal(tramoDemora(venta, '2026-11-10T17:00:01.000Z'), 2);     // mas de una hora, mismo dia de la tienda
  assert.equal(tramoDemora(venta, '2026-11-11T05:59:00.000Z'), 2);     // 23:59 de la tienda: todavia el mismo dia
  assert.equal(tramoDemora(venta, '2026-11-11T06:00:00.000Z'), 3);     // 00:00 del siguiente
  assert.equal(tramoDemora(venta, '2026-11-10T15:00:00.000Z'), 0);     // la venta «viene del futuro»: cero
  assert.equal(tramoDemora(venta, 'x'), null);
  assert.equal(TRAMOS_DEMORA.length, 4);
  assert.deepEqual(momentoTienda('2026-11-11T05:59:00.000Z'), { dia: '2026-11-10', hora: 23, dia_semana: 2 });
  assert.equal(momentoTienda('nada'), null);
});

test('armarControl ignora lo que cae fuera del periodo y de la comparacion, y lo de la comparacion no entra a personas ni motivos', () => {
  const base = { desde: '2026-11-10', hasta: '2026-11-11', grano: 'dia', ventana: { desde: '2026-11-08', hasta: '2026-11-09', dias: 2 }, usuarios: [], cortes: [], aperturas: [], descuentos: [] };
  const evento = (d: string, por: string) => ({ tipo: 'ticket', dia: d, venta_en: `${d}T16:00:00.000Z`, en: `${d}T16:01:00.000Z`, por, motivo: 'm', dinero: 1000, dolarones: 0 });
  const C = armarControl({ ...base, ventas: [{ dia: '2026-11-05', cajero: 'z', tickets: 9, bruto: 9 }, { dia: '2026-11-08', cajero: 'a', tickets: 1, bruto: 100 }, { dia: '2026-11-10', cajero: 'a', tickets: 2, bruto: 400 }],
    eventos: [evento('2026-11-05', 'z'), evento('2026-11-08', 'a'), evento('2026-11-10', 'a')] });
  assert.equal(C.totales.tickets, 2); assert.equal(C.anterior.tickets, 1);
  assert.equal(C.totales.canc_n, 1); assert.equal(C.anterior.canc_n, 1);
  assert.deepEqual(C.personas.map((p: any) => [p.correo, p.tickets, p.tk_n]), [['a', 2, 1]]);     // la comparacion y lo de antes no salen por persona
  assert.equal(C.motivos.lista[0].n, 1);
});

test('el acceso es el de /reportes (solo el dueno) y los parametros malos dan 400', async () => {
  for (const metodo of ['GET', 'POST']) assert.deepEqual(permiso('/api/reportes/control', metodo), permiso('/api/reportes', metodo));
  const cajero = { correo: 'k@x', nombre: '', roles: ['cajero'], activo: true, caja: '', tienda: '', editar_inventario: false };
  assert.equal(puede(cajero as never, permiso('/api/reportes/control', 'GET')), false);
  assert.equal(puede({ ...cajero, roles: ['dueno'] } as never, permiso('/api/reportes/control', 'GET')), true);
  const t = tienda();
  for (const consulta of ['dias=7&grano=hora', 'dias=7&comparar=ayer', 'dias=7&tienda=luna', 'desde=2026-01-01', `desde=${hoy}&hasta=${sumarDias(hoy, 1)}`]) {
    assert.equal((await llamar(t, consulta)).status, 400, consulta);
  }
  // Un cajero con PIN, aunque sea dueno, no entra: /reportes pide la cuenta del dueno.
  usuario(t, 'caja@prueba.mx', 'K', 'cajero');
  (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = 'caja@prueba.mx';
  assert.equal((await llamar(t, 'dias=7')).status, 403);
  t.db.close();
});

test('la tienda acota tickets, movimientos, cajon y cortes a sus cajas', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 100000 where id = ?').run(PRODUCTO);
  const v = await vender(t, dia(1), DUENO);
  t.db.prepare("update ventas set tienda = 'salk', caja = 'Salk 1' where id = ?").run(v);
  await vender(t, dia(1), DUENO);
  apertura(t, DUENO, a(dia(1), 11));
  t.db.prepare("update cajon_aperturas set caja = 'Salk 1'").run();
  corte(t, a(dia(1), 20), -100);
  const todas = (await llamar(t, 'dias=3')).cuerpo, salk = (await llamar(t, 'dias=3&tienda=salk')).cuerpo, sol = (await llamar(t, 'dias=3&tienda=soledad')).cuerpo;
  assert.equal(todas.totales.tickets, 2); assert.equal(salk.totales.tickets, 1); assert.equal(sol.totales.tickets, 1);
  assert.equal(salk.totales.cajon_n, 1); assert.equal(sol.totales.cajon_n, 0);
  assert.equal(todas.totales.cortes_n, 1); assert.equal(salk.totales.cortes_n, 0); assert.equal(sol.totales.cortes_n, 1);
  assert.equal(salk.tienda, 'salk');
  t.db.close();
});

test('D1 admite a lo mas 5 terminos por compound SELECT: las consultas de Control se quedan en dos', async () => {
  const t = tienda();
  const visto: string[] = [];
  const preparar = t.env.DB.prepare.bind(t.env.DB);
  (t.env.DB as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => { visto.push(sql); return preparar(sql); };
  assert.equal((await llamar(t, 'dias=7&tienda=salk')).status, 200);
  assert.ok(visto.length >= 6);
  for (const sql of visto) assert.ok((sql.match(/\bunion\b/gi) ?? []).length + 1 <= 5, sql.slice(0, 80));
  // Y ninguna subconsulta por pieza sobre venta_lineas (no tiene indice por producto).
  assert.ok(!visto.some((sql) => /venta_lineas/.test(sql)), 'Control no lee venta_lineas');
  t.db.close();
});
