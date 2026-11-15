// node --test src/reportes-dolarones.test.ts
// Vista «Dolarones» de /reportes (Issue #802): los dos libros cuadran al centavo y cada tabla suma su tarjeta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, codigoPrueba, PRODUCTO } from './prueba-d1.ts';
import { reclamarVale } from './vales.ts';
import { permiso } from './cuentas.ts';
import { cubetas, flujoEntre, vivoAlCierre, totalesPorOrigen, cohorteCerrada } from './reportes-dolarones.ts';

const DIA_MS = 86_400_000;
const hace = (dias: number) => new Date(Date.now() - dias * DIA_MS).toISOString();
type T = ReturnType<typeof tienda>;

const vender = async (t: T, extra: Record<string, unknown> = {}) => {
  const id = crypto.randomUUID();
  const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return { id, cuerpo: r.cuerpo };
};
const socio = async (t: T, telefono: string, nombre: string) => {
  const r = await t.pedir('/api/socios', { id: crypto.randomUUID(), nombre, telefono, pin: '1234', acepta_bases: true, declara_mayor_edad: true });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return r.cuerpo as { id: string; numero: number };
};
const reporte = async (t: T, consulta = 'dias=7') => {
  const r = await t.pedir(`/api/reportes/dolarones?${consulta}`);
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  return r.cuerpo;
};
const suma = (filas: Record<string, any>[], campo: string) => filas.reduce((s, f) => s + f[campo], 0);

/** La tienda de prueba con el programa andando: socios, vales, un cupon, un lote vencido y un vale vencido. */
async function armar() {
  const t = tienda();
  t.env.VALES_ABIERTOS = 'si';
  t.env.PROMO_META_INICIO = '2020-01-01T00:00:00Z';
  t.env.PROMO_META_FIN = '2099-01-01T00:00:00Z';
  t.env.PROMO_META_VENCE = '2099-06-30T05:59:59Z';
  t.db.prepare('update productos set stock = 500 where id = ?').run(PRODUCTO);
  const cuatro = [{ producto_id: PRODUCTO, cantidad: 4 }];

  // Socio 1: regalo de apertura, compra que gana, canje del regalo, devolucion parcial, ticket cancelado y bono de la promo.
  const s1 = await socio(t, '4440000001', 'Nombre Secreto Uno');
  assert.equal((await t.pedir('/api/portal/llegada', { cliente_id: s1.id })).status, 200);
  const A = await vender(t, { cliente_id: s1.id, lineas: cuatro, efectivo: 100000 });                                    // gana 100 D
  const B = await vender(t, { cliente_id: s1.id, lineas: cuatro, dolarones: 5000, codigo_socio: await codigoPrueba(t.db, s1.id), efectivo: 95000 });   // 50 D de regalo; gana 90 D
  const linea = (await t.pedir(`/api/ventas/${B.id}`, undefined, 'GET')).cuerpo.lineas[0].id;
  assert.equal((await t.pedir(`/api/ventas/${B.id}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'talla', caja: 'Caja 1' })).status, 201);
  const C = await vender(t, { cliente_id: s1.id, lineas: cuatro, efectivo: 100000 });
  assert.equal((await t.pedir(`/api/ventas/${C.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' })).status, 200);
  const K = await vender(t, { cliente_id: s1.id, lineas: [{ producto_id: PRODUCTO, cantidad: 12 }], efectivo: 300000 });   // pasa de $3,000 en dinero: bono

  // Vales de papel: uno gastado en parte, uno vencido gastado en parte, uno vencido sin usar, uno pasado a una cuenta.
  const V1 = (await vender(t)).cuerpo.vale_emitido;
  const E = await vender(t, { codigo_vale: V1.codigo, dolarones: 400, efectivo: 24600 });          // V1 queda en 6 D; esta venta emite otro vale
  const V3 = (await vender(t)).cuerpo.vale_emitido;
  const G = await vender(t, { codigo_vale: V3.codigo, dolarones: 300, efectivo: 24700 });
  const V5 = (await vender(t)).cuerpo.vale_emitido;
  const V6 = (await vender(t)).cuerpo.vale_emitido;
  const s2 = await socio(t, '4440000002', 'Nombre Secreto Dos');
  assert.equal((await reclamarVale(t.env, s2.id, V6.codigo)).status, 201);
  const J = await vender(t, { cliente_id: s2.id });                                                                       // gana 20 D que luego vencen
  const cupon = (await t.pedir('/api/cupones', { id: crypto.randomUUID(), importe: 1500, motivo: 'cortesía' })).cuerpo.cupon;

  // Devoluciones y cancelaciones de tickets pagados con Dolarones: el canje regresa a su lote o vale (reverso_canje).
  const L = await vender(t, { cliente_id: s1.id, lineas: cuatro, dolarones: 3000, codigo_socio: await codigoPrueba(t.db, s1.id), efectivo: 97000 });
  assert.equal((await t.pedir(`/api/ventas/${L.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' })).status, 200);
  const M = await vender(t, { codigo_vale: E.cuerpo.vale_emitido.codigo, dolarones: 200, efectivo: 24800 });
  assert.equal((await t.pedir(`/api/ventas/${M.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' })).status, 200);
  const N = await vender(t, { cliente_id: s1.id, lineas: cuatro, dolarones: 30000, codigo_socio: await codigoPrueba(t.db, s1.id), efectivo: 70000 });
  const lineaN = (await t.pedir(`/api/ventas/${N.id}`, undefined, 'GET')).cuerpo.lineas[0].id;
  assert.equal((await t.pedir(`/api/ventas/${N.id}/lineas/${lineaN}/cancelar`, { id: crypto.randomUUID(), cantidad: 4, motivo: 'no sirve', caja: 'Caja 1' })).status, 201);

  // El equipo: un lote de reto, como lo deja retos.ts.
  const reto = 'reto:prueba';
  t.db.prepare(`insert into dolarones_lotes (id, cliente_id, origen, venta_id, importe, restante, disponible_desde, vence_en, creado_en)
    values (?, ?, 'reto', null, 5000, 5000, ?, ?, ?)`).run(reto, s2.id, hace(1), hace(-300), hace(1));
  t.db.prepare(`insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en) values (?, ?, null, 'reto', 5000, 'retos', ?)`)
    .run(s2.id, reto, hace(1));

  // Vencidos: el vale V3 (usado en parte), el V5 (sin usar) y el lote de la venta J. Se reubican en el tiempo con sus movimientos.
  const atras = (tabla: string, columna: string, id: string, creado: string) =>
    t.db.prepare(`update ${tabla} set creado_en = ? where ${columna} = ?`).run(creado, id);
  for (const [v, dias] of [[V3, 40], [V5, 40]] as const) {
    t.db.prepare('update vales_dolarones set creado_en = ?, disponible_desde = ?, vence_en = ? where id = ?').run(hace(dias), hace(dias), hace(10), v.id);
    atras('vales_movimientos', 'vale_id', v.id, hace(dias));
  }
  t.db.prepare(`update vales_movimientos set creado_en = ? where vale_id = ? and tipo = 'canje'`).run(hace(35), V3.id);
  const lJ = t.db.prepare('select id from dolarones_lotes where venta_id = ?').get(J.id)!.id as string;
  t.db.prepare('update dolarones_lotes set creado_en = ?, disponible_desde = ?, vence_en = ? where id = ?').run(hace(370), hace(369), hace(5), lJ);
  t.db.prepare('update dolarones_movimientos set creado_en = ? where lote_id = ?').run(hace(370), lJ);

  return { ...t, s1, s2, A, B, C, K, L, M, N, V1, V3, V5, V6, G, J, cupon, lJ };
}

/** Lo que deben cumplir TODAS las respuestas: la identidad de cada libro y cada tabla contra su tarjeta. */
function revisarIdentidades(r: Record<string, any>) {
  for (const libro of ['socio', 'vale', 'total'] as const) {
    const c = r.cuadre[libro];
    assert.equal(c.emitido + c.traspaso - c.canjeado - c.retirado + c.otros, c.vivo + c.vencido, `identidad de ${libro}`);
  }
  const t = r.cuadre.total;
  for (const campo of ['emitido', 'traspaso', 'canjeado', 'vencido', 'vivo']) assert.equal(suma(r.por_origen, campo), t[campo], `la tabla por origen suma ${campo}`);
  assert.equal(suma(r.por_origen, 'retirado'), t.retirado - t.otros, 'la tabla por origen suma lo retirado');
  const p = r.periodo;
  assert.equal(suma(r.serie, 'emitidos'), p.emitidos, 'la serie suma lo emitido');
  assert.equal(suma(r.serie, 'canjeados'), p.canjeados, 'la serie suma lo canjeado');
  assert.equal(suma(r.serie, 'vencidos'), p.vencidos, 'la serie suma lo vencido');
  assert.equal(suma(r.serie, 'retirados'), p.retirados);
  for (const s of r.serie) assert.equal(Object.values(s.por_origen as Record<string, number>).reduce((a, b) => a + b, 0), s.emitidos, 'los origenes suman la cubeta');
  assert.equal(suma(p.por_origen, 'emitido') + suma(p.por_origen, 'traspaso'), p.emitidos);
  assert.equal(suma(p.por_origen, 'canjeado'), p.canjeados);
  assert.equal(suma(p.por_origen, 'vencido'), p.vencidos);
  assert.equal(r.saldo.disponible + r.saldo.por_liberar, r.saldo.vivo);
  assert.equal(suma(r.vencimientos.semanas, 'total') + r.vencimientos.despues, r.saldo.vivo, 'el calendario suma el saldo vivo');
  for (const s of r.vencimientos.semanas) assert.equal(Object.values(s.por_origen as Record<string, number>).reduce((a, b) => a + b, 0), s.total);
  assert.equal(suma(r.vales.resultados, 'n'), r.vales.emitidos, 'los resultados suman los vales');
  assert.equal(suma(r.vales.resultados, 'importe'), r.vales.importe);
  assert.equal(suma(r.vales.dias.histograma, 'n'), r.vales.dias.usos, 'el histograma suma los canjes');
}

test('el escenario completo cuadra al centavo: cada libro, cada tabla y los tickets', async () => {
  const t = await armar();
  try {
    const r = await reporte(t);
    revisarIdentidades(r);
    assert.equal(r.cuadre.ok, true, JSON.stringify(r.cuadre));
    assert.equal(r.cuadre.total.diferencia, 0);
    assert.equal(r.cuadre.socio.diferencia, 0);
    assert.equal(r.cuadre.vale.diferencia, 0);
    assert.equal(r.cuadre.total.asientos.diferencia, 0);
    assert.equal(r.tickets.diferencia, 0, 'lo que dicen los tickets es lo que dicen los movimientos');

    // Contra SQL escrito aparte: lo emitido, lo guardado y lo vencido de cada libro.
    const q = (sql: string) => Number((t.db.prepare(sql).get() as { n: number }).n);
    const ahora = new Date().toISOString();
    const lotes = q('select coalesce(sum(importe), 0) as n from dolarones_lotes');
    const vales = q('select coalesce(sum(importe), 0) as n from vales_dolarones');
    const claim = q('select coalesce(sum(importe), 0) as n from vales_dolarones where reclamado_por is not null');
    assert.equal(r.cuadre.socio.emitido + r.cuadre.socio.traspaso, lotes);
    assert.equal(r.cuadre.vale.emitido, vales);
    assert.equal(r.cuadre.vale.traspaso, -claim);
    assert.equal(r.cuadre.total.traspaso, 0, 'el traspaso entre libros se anula');
    assert.equal(r.cuadre.socio.guardado_vivo, q(`select coalesce(sum(restante), 0) as n from dolarones_lotes where vence_en > '${ahora}'`));
    assert.equal(r.cuadre.vale.guardado_vivo, q(`select coalesce(sum(restante), 0) as n from vales_dolarones where vence_en > '${ahora}'`));
    assert.equal(r.cuadre.total.guardado_vencido, q(`select (select coalesce(sum(restante), 0) from dolarones_lotes where vence_en <= '${ahora}')
      + (select coalesce(sum(restante), 0) from vales_dolarones where vence_en <= '${ahora}') as n`));
    assert.equal(r.saldo.vivo, r.cuadre.total.guardado_vivo);

    // Los numeros del escenario. Vales: V3 vencio con 700 sin usar y V5 con 1000; el lote de J vencio con 2000.
    const origen = (o: string) => r.por_origen.find((f: { origen: string }) => f.origen === o);
    assert.equal(origen('vale').vencido, 700 + 1000);
    assert.equal(origen('vale').traspaso, -1000, 'el vale V6 salio del libro de vales...');
    assert.equal(origen('socio').traspaso, 1000, '...y entro al libro de socio');
    assert.equal(origen('socio').vencido, 2000);
    assert.equal(origen('equipo').emitido, 5000);
    assert.equal(origen('promo').emitido, 30000, 'un bono de $3,000 en dinero');
    assert.equal(origen('cupon').emitido, 1500);
    assert.equal(origen('referido').emitido, 0, 'sin referidos: la fila existe en cero');
    // Vale de papel gastado: V1 400 y V3 300 de canje (un canje es un movimiento, no importa que el vale venza).
    assert.equal(origen('vale').canjeado, 700);
    // El regalo de apertura: 50 D canjeados y, con la devolucion de una pieza de B, parte regresa.
    const regalo = origen('regalo');
    assert.equal(regalo.canjeado, -t.db.prepare(`select coalesce(sum(m.importe), 0) as n from dolarones_movimientos m join dolarones_lotes l on l.id = m.lote_id
      where l.origen = 'regalo' and m.tipo in ('canje', 'reverso_canje')`).get()!.n);
    assert.ok(regalo.canjeado >= 5000, 'el canje de B (50 D) y lo que quedo de N');
    assert.ok(r.cuadre.socio.reversos_canje >= 3000, 'cancelar L regreso su canje al lote');
    assert.equal(r.cuadre.vale.reversos_canje, 200, 'cancelar M regreso su canje al vale');
    assert.equal(r.cuadre.vale.canjeado_bruto, 900);

    // Los 5 de ventas que de verdad pasaron por la caja del periodo.
    assert.ok(r.efecto.con.tickets >= 2);
    assert.equal(r.efecto.con.neto - r.efecto.con.dolarones, r.efecto.con.dinero);
    // Las ventas netas son las de /api/reportes, con la misma definicion.
    const venta = (await t.pedir('/api/reportes?dias=7')).cuerpo;
    assert.equal(r.periodo.ventas_netas, venta.resumen.total);
    assert.equal(r.efecto.tickets, venta.resumen.ventas);
  } finally { t.db.close(); }
});

test('si algun saldo no cuadra, la pantalla recibe la diferencia en centavos y no la esconde', async () => {
  const t = await armar();
  try {
    t.db.prepare(`update dolarones_lotes set restante = restante - 100 where id = ?`).run(t.db.prepare('select id from dolarones_lotes where venta_id = ?').get(t.A.id)!.id);
    t.db.prepare(`update vales_dolarones set restante = restante - 100 where id = ?`).run(t.V1.id);
    const r = await reporte(t);
    assert.equal(r.cuadre.ok, false);
    assert.equal(r.cuadre.socio.diferencia, 100);
    assert.equal(r.cuadre.vale.diferencia, 100);
    assert.equal(r.cuadre.total.diferencia, 200);
    assert.equal(r.cuadre.total.diferencia_vivo, 200);
  } finally { t.db.close(); }
});

test('el programa vacio responde en ceros y cuadra', async () => {
  const t = tienda();
  try {
    const r = await reporte(t, 'dias=28');
    assert.equal(r.cuadre.ok, true);
    assert.equal(r.cuadre.total.vivo, 0);
    assert.equal(r.periodo.emitidos, 0);
    assert.equal(r.inicio_programa, null);
    assert.equal(r.proximo_cierre, null);
    assert.equal(r.periodo.tasa.total.tasa, null, 'sin lotes cerrados no hay tasa');
    assert.deepEqual(r.saldos, []);
    assert.equal(r.vales.emitidos, 0);
    assert.equal(r.vencimientos.semanas.length, 8);
    assert.equal(r.serie.length, 28);
    revisarIdentidades(r);
  } finally { t.db.close(); }
});

test('un periodo pasado y cerrado ve lo de entonces, y el saldo vivo se reconstruye de los movimientos', async () => {
  const t = await armar();
  try {
    const dia = (n: number) => new Date(Date.now() - 6 * 3_600_000 - n * DIA_MS).toISOString().slice(0, 10);
    // Del dia -41 al -36: nacen V3 y V5 (10 D cada uno; el canje de V3 es del dia -35, ya fuera). El lote de J (20 D, de hace 370 dias) sigue vivo.
    const r = await reporte(t, `desde=${dia(41)}&hasta=${dia(36)}`);
    revisarIdentidades(r);
    assert.equal(r.grano, 'dia');
    assert.equal(r.periodo.emitidos, 2000);
    assert.equal(r.periodo.canjeados, 0);
    assert.equal(r.periodo.vencidos, 0);
    assert.equal(r.vales.emitidos, 2);
    assert.equal(r.vales.resultados.find((f: { clave: string }) => f.clave === 'parcial').n, 1, 'V3 se uso en parte y vencio');
    assert.equal(r.vales.resultados.find((f: { clave: string }) => f.clave === 'vencido').n, 1, 'V5 vencio sin usar');
    assert.equal(r.serie.at(-1).vivo, 4000, 'al cierre del dia -36: los dos vales y el lote de J');
    assert.equal(r.saldo.vivo_inicio, 2000, 'antes de abrir el periodo solo estaba el lote de J');
    // El mismo cuadre de siempre: no depende del periodo.
    assert.equal(r.cuadre.ok, true);

    // Del dia -11 al -9 vencen los dos vales: lo que les quedaba (700 y 1000) es lo vencido, y el saldo vivo baja.
    const v = await reporte(t, `desde=${dia(11)}&hasta=${dia(9)}`);
    revisarIdentidades(v);
    assert.equal(v.periodo.vencidos, 1700);
    assert.equal(v.periodo.tasa.vale.base, 2000);
    assert.equal(v.periodo.tasa.vale.canjeado, 300);
    assert.equal(v.periodo.tasa.vale.tasa, 0.15);
    assert.equal(v.saldo.vivo_inicio - v.serie.at(-1).vivo, 1700, 'el saldo vivo baja lo que vence');
    const [anterior, despues] = [await reporte(t, `desde=${dia(12)}&hasta=${dia(12)}`), await reporte(t, `desde=${dia(9)}&hasta=${dia(9)}`)];
    assert.equal(anterior.serie[0].vivo - despues.serie[0].vivo, 1700);
  } finally { t.db.close(); }
});

test('con tienda, los flujos son los de sus ventas y el saldo vivo sigue siendo del negocio completo', async () => {
  const t = await armar();
  try {
    const global = await reporte(t);
    t.db.prepare(`update ventas set tienda = 'salk' where id = ?`).run(t.A.id);
    const salk = await reporte(t, 'dias=7&tienda=salk');
    revisarIdentidades({ ...salk, cuadre: salk.cuadre });
    assert.equal(salk.tienda, 'salk');
    assert.equal(salk.periodo.emitidos, 10000, 'solo lo ganado en la venta A');
    assert.ok(salk.periodo.emitidos < global.periodo.emitidos);
    assert.deepEqual(salk.cuadre, global.cuadre, 'el cuadre no depende de la tienda');
    assert.deepEqual(salk.saldo, global.saldo);
    assert.equal((await t.pedir('/api/reportes/dolarones?tienda=nada')).status, 400);
    assert.equal((await t.pedir('/api/reportes/dolarones?desde=2026-02-30&hasta=2026-03-01')).status, 400);
    assert.equal((await t.pedir('/api/reportes/dolarones?desde=2026-01-01&hasta=2099-01-01')).status, 400);
  } finally { t.db.close(); }
});

test('la respuesta no lleva nombres, telefonos ni correos: un socio es solo su numero', async () => {
  const t = await armar();
  try {
    t.db.prepare(`update clientes set correo = ? where id = ?`).run('privado@ejemplo.mx', t.s1.id);
    const crudo = JSON.stringify(await reporte(t));
    for (const secreto of ['Nombre Secreto', '4440000001', '4440000002', 'privado@ejemplo.mx', t.s1.id, t.s2.id]) assert.ok(!crudo.includes(secreto), secreto);
    const r = JSON.parse(crudo);
    assert.ok(r.saldos.length >= 1);
    for (const s of r.saldos) assert.deepEqual(Object.keys(s).sort(), ['disponible', 'por_liberar', 'saldo', 'socio', 'ultima_compra', 'vence_primero']);
    assert.ok(r.saldos.every((s: { socio: number }) => Number.isInteger(s.socio)));
    assert.equal(r.saldos[0].saldo >= r.saldos.at(-1).saldo, true);
  } finally { t.db.close(); }
});

test('solo el dueno ve la vista: la ruta nueva cae en el permiso por omision', () => {
  assert.deepEqual(permiso('/api/reportes/dolarones', 'GET'), permiso('/api/reportes', 'GET'));
  assert.deepEqual(permiso('/api/reportes/dolarones', 'GET'), []);
});

test('las piezas puras: cubetas, vivo al cierre, flujo y cohorte', () => {
  assert.deepEqual(cubetas('2026-11-01', '2026-11-03', 3).cubetas.map((c) => c.desde), ['2026-11-01', '2026-11-02', '2026-11-03']);
  // 60 dias: semanas de lunes a domingo, recortadas al periodo (el 2/nov/2026 es lunes).
  const s = cubetas('2026-10-28', '2026-12-26', 60);
  assert.equal(s.grano, 'semana');
  assert.deepEqual(s.cubetas[0], { desde: '2026-10-28', hasta: '2026-11-01', parcial: true });
  assert.deepEqual(s.cubetas[1], { desde: '2026-11-02', hasta: '2026-11-08', parcial: false });
  assert.equal(s.cubetas.at(-1)!.hasta, '2026-12-26');
  const fila = (extra: Record<string, unknown>) => ({ libro: 'vale', origen: 'vale', cat: 'emision', vigente: 0, dia: '2026-11-01', dia_vence: '2026-12-01', tardio: 0,
    por_liberar: 0, t_evt: '', t_lote: '', importe: 1000, n: 1, ...extra }) as never;
  const filas = [fila({}), fila({ cat: 'canje', dia: '2026-11-10', importe: -300 }), fila({ cat: 'reverso_canje', dia: '2026-12-05', importe: 100, tardio: 1 })];
  assert.equal(vivoAlCierre(filas, '2026-10-31'), 0);
  assert.equal(vivoAlCierre(filas, '2026-11-09'), 1000);
  assert.equal(vivoAlCierre(filas, '2026-11-10'), 700);
  assert.equal(vivoAlCierre(filas, '2026-12-01'), 0, 'el ultimo dia del vale ya cuenta como vencido al cerrar');
  const f = flujoEntre(filas, '', '2026-11-01', '2026-12-31').get('vale')!;
  assert.deepEqual(f, { emitido: 1000, traspaso: 0, canjeado: 200, retirado: 0, vencido: 800 });   // 700 al vencer + 100 que regresaron tarde
  assert.equal(totalesPorOrigen(filas).get('vale')!.vencido, 800);
  const c = cohorteCerrada(filas, '', '2026-11-25', '2026-12-05');
  assert.deepEqual([c.vale.base, c.vale.canjeado, c.vale.vencido], [1000, 200, 800]);
  assert.equal(cohorteCerrada(filas, '', '2026-01-01', '2026-01-31').total.tasa, null);
});
