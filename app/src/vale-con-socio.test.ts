// node --test src/vale-con-socio.test.ts
// #927: cupón impreso junto con los Dolarones de la cuenta de un socio, en un mismo ticket (el vale de compra no se junta). SQLite real y todas las migraciones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, codigoPrueba, PRODUCTO } from './prueba-d1.ts';
import { vista } from './tablero-prueba.ts';

const LEJOS = '2099-01-01T00:00:00.000Z';
const DIA = 86_400_000;
let telefonos = 4470000000;

function abrir() {
  const t = tienda();
  t.env.VALES_ABIERTOS = 'si';
  const venta = (extra: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(),
    lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1', ...extra });
  /** Un vale de compra de 10 D (una venta sin socio de $250). Con socio NO se junta: solo los cupones (#927). */
  const vale = async () => {
    const r = await t.pedir('/api/ventas', venta());
    assert.equal(r.status, 201);
    return r.cuerpo.vale_emitido as { id: string; codigo: string; importe: number; vence_en: string };
  };
  const cupon = async (importe: number) => {
    const r = await t.pedir('/api/cupones', { id: crypto.randomUUID(), importe, motivo: 'cortesía' });
    assert.equal(r.status, 201);
    return r.cuerpo.cupon as { id: string; codigo: string; vence_en: string };
  };
  /** Un socio con `saldo` centavos de Dolarones de compra, ya disponibles y vigentes hasta 2099. */
  const socio = async (saldo = 0) => {
    const r = await t.pedir('/api/socios', { id: crypto.randomUUID(), nombre: 'Cliente', telefono: String(telefonos++),
      acepta_bases: true, declara_mayor_edad: true });
    assert.equal(r.status, 201);
    const lote = crypto.randomUUID();
    if (saldo) t.db.prepare(`insert into dolarones_lotes (id, cliente_id, origen, venta_id, importe, restante, disponible_desde, vence_en, creado_en)
      values (?, ?, 'compra', null, ?, ?, '2000-01-01T00:00:00.000Z', ?, ?)`).run(lote, r.cuerpo.id, saldo, saldo, LEJOS, new Date().toISOString());
    return { id: r.cuerpo.id as string, lote };
  };
  const restante = (id: string) => t.db.prepare('select restante from vales_dolarones where id = ?').get(id)!.restante as number;
  const lote = (id: string) => t.db.prepare('select restante, vence_en from dolarones_lotes where id = ?').get(id)! as { restante: number; vence_en: string };
  const precio = (centavos: number) => t.db.prepare('update productos set precio = ? where id = ?').run(centavos, PRODUCTO);
  /** Todo lo que una venta puede tocar: si no cambia, no se escribió nada. */
  const foto = () => JSON.stringify({
    ventas: t.db.prepare('select id, dolarones from ventas order by id').all(),
    vales: t.db.prepare('select id, restante from vales_dolarones order by id').all(),
    lotes: t.db.prepare('select id, restante from dolarones_lotes order by id').all(),
    valesMov: t.db.prepare('select count(*) as n from vales_movimientos').get(),
    cuentaMov: t.db.prepare('select count(*) as n from dolarones_movimientos').get(),
    codigos: t.db.prepare('select cliente_id, venta_id from codigos_cliente order by cliente_id').all(),
    stock: t.db.prepare('select stock from productos where id = ?').get(PRODUCTO),
  });
  const movimientos = (tabla: 'vales_movimientos' | 'dolarones_movimientos', ventaId: string, tipo: string) =>
    t.db.prepare(`select coalesce(sum(importe), 0) as n from ${tabla} where venta_id = ? and tipo = ?`).get(ventaId, tipo)!.n as number;
  return { ...t, venta, vale, cupon, socio, restante, lote, precio, foto, movimientos };
}

test('socio + cupón + cuenta en un ticket: el papel va primero, el reparto queda en las dos bitácoras y se gana sobre el dinero (#927)', async () => {
  const t = abrir();
  try {
    const v = await t.cupon(1000);                                   // 10 D de papel
    const s = await t.socio(5000);                              // 50 D en la cuenta
    const id = crypto.randomUUID();
    const r = await t.pedir('/api/ventas', t.venta({ id, cliente_id: s.id, codigo_vale: v.codigo,
      codigo_socio: await codigoPrueba(t.db, s.id), dolarones: 3000, efectivo: 22000 }));
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    assert.equal(r.cuerpo.dolarones, 3000);
    assert.equal(r.cuerpo.dolarones_papel, 1000);
    assert.deepEqual(r.cuerpo.vales_usados.map((x: { id: string }) => x.id), [v.id]);
    assert.equal(r.cuerpo.vale_usado.id, v.id);
    assert.equal(r.cuerpo.cambio, 0);
    // Papel 10 D (todo el vale) y la cuenta pone los 20 D que faltan.
    assert.equal(t.restante(v.id), 0);
    assert.equal(t.lote(s.lote).restante, 3000);
    assert.equal(t.movimientos('vales_movimientos', id, 'canje'), -1000);
    assert.equal(t.movimientos('dolarones_movimientos', id, 'canje'), -2000);
    assert.equal(t.db.prepare('select dolarones from ventas where id = ?').get(id)!.dolarones, 3000, 'ventas.dolarones guarda la suma');
    assert.equal(t.db.prepare('select venta_id from codigos_cliente where cliente_id = ?').get(s.id)!.venta_id, id, 'el código se consumió');
    // $220 en dinero: 2 bloques de $100 al 10 %. Con socio no sale vale.
    assert.equal(r.cuerpo.ganados, 2000);
    assert.equal(r.cuerpo.vale_emitido, null);
    assert.equal(t.db.prepare('select count(*) as n from vales_dolarones where venta_id = ?').get(id)!.n, 0);
    assert.equal(r.cuerpo.saldo.disponible, 3000);
    assert.equal(r.cuerpo.saldo.por_liberar, 2000);
    // El detalle (reimpresión, impresión remota, ventana del ticket) dice cuánto fue papel.
    const detalle = (await t.pedir(`/api/ventas/${id}`, undefined, 'GET')).cuerpo;
    assert.equal(detalle.dolarones, 3000);
    assert.equal(detalle.dolarones_papel, 1000);
    assert.equal(detalle.socio.numero, 1);
  } finally { t.db.close(); }
});

test('el papel que vence antes va primero y el que no hace falta no se toca; la cuenta solo pone el resto (#927)', async () => {
  const t = abrir();
  try {
    const v = await t.cupon(1000);                                   // 10 D, vence en 30 días
    t.db.prepare('update vales_dolarones set vence_en = ? where id = ?').run('2098-01-01T00:00:00.000Z', v.id);
    const c = await t.cupon(1500);                              // 15 D, vence en 30 días: sale antes que el vale
    const s = await t.socio(5000);
    // Solo 10 D: alcanza el cupón. No hace falta el código del socio ni se toca nada más.
    const a = await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_vale: [v.codigo, c.codigo], dolarones: 1000, efectivo: 24000 }));
    assert.equal(a.status, 201, JSON.stringify(a.cuerpo));
    assert.deepEqual([t.restante(c.id), t.restante(v.id), t.lote(s.lote).restante], [500, 1000, 5000]);
    assert.equal(a.cuerpo.dolarones_papel, 1000);
    assert.deepEqual(a.cuerpo.vales_usados.map((x: { id: string }) => x.id), [c.id]);
    // Escanear un vale sin usarlo tampoco lo toca ni pide nada.
    const sin = await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_vale: v.codigo, dolarones: 0 }));
    assert.equal(sin.status, 201);
    assert.deepEqual([t.restante(v.id), sin.cuerpo.dolarones_papel, sin.cuerpo.vales_usados], [1000, 0, []]);
    // 30 D: 5 del cupón + 10 del vale (el papel que queda) y 15 de la cuenta.
    const b = await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_vale: [v.codigo, c.codigo],
      codigo_socio: await codigoPrueba(t.db, s.id), dolarones: 3000, efectivo: 22000 }));
    assert.equal(b.status, 201, JSON.stringify(b.cuerpo));
    assert.deepEqual([t.restante(c.id), t.restante(v.id), t.lote(s.lote).restante], [0, 0, 3500]);
    assert.equal(b.cuerpo.dolarones_papel, 1500);
    assert.deepEqual(b.cuerpo.vales_usados.map((x: { id: string }) => x.id), [c.id, v.id]);
    assert.equal(t.movimientos('dolarones_movimientos', b.cuerpo.id, 'canje'), -1500);
  } finally { t.db.close(); }
});

test('socio encontrado por teléfono + cupón: paga el papel, no hace falta código y la compra acumula (#927)', async () => {
  const t = abrir();
  try {
    const c = await t.cupon(1000);
    const s = await t.socio(5000);
    const r = await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_vale: c.codigo, dolarones: 1000, efectivo: 24000 }));
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    assert.equal(r.cuerpo.dolarones_papel, 1000);
    assert.equal(r.cuerpo.ganados, 2000, '$240 en dinero: 2 bloques');
    assert.equal(r.cuerpo.vale_emitido, null);
    assert.equal(t.restante(c.id), 0);
    assert.equal(t.lote(s.lote).restante, 5000, 'la cuenta no se toca');
    assert.equal(t.db.prepare('select count(*) as n from codigos_cliente').get()!.n, 0);
    assert.equal(t.movimientos('dolarones_movimientos', r.cuerpo.id, 'canje'), 0);
    // La cuenta sigue exigiendo su código: pedir más de lo que cubre el papel, sin código, no pasa.
    const v = await t.cupon(1000);
    const antes = t.foto();
    const sinCodigo = await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_vale: v.codigo, dolarones: 1500, efectivo: 23500 }));
    assert.equal(sinCodigo.status, 403);
    assert.equal(t.foto(), antes, 'nada se escribe');
  } finally { t.db.close(); }
});

test('la parte de la cuenta pide su código, su máximo y su saldo; si falla, no se escribe nada y el vale no se gasta (#927)', async () => {
  const t = abrir();
  try {
    const v = await t.cupon(1000);                                   // 10 D
    const s = await t.socio(5000);
    const pedir = (extra: Record<string, unknown>) =>
      t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_vale: v.codigo, dolarones: 3000, efectivo: 22000, ...extra }));
    const antes = t.foto();
    // Sin código.
    assert.equal((await pedir({})).status, 403);
    // Código autorizado por menos de lo que le toca a la cuenta (20 D): 15 D no alcanzan aunque el total sea 30 D.
    assert.equal((await pedir({ codigo_socio: await codigoPrueba(t.db, s.id, 1500) })).status, 403);
    // Código de otro socio.
    const otro = await t.socio(5000);
    assert.equal((await pedir({ codigo_socio: await codigoPrueba(t.db, otro.id) })).status, 403);
    // Más de lo que cubren el papel y la cuenta juntos.
    const sinSaldo = await t.socio(500);
    const mucho = await t.pedir('/api/ventas', t.venta({ cliente_id: sinSaldo.id, codigo_vale: v.codigo,
      codigo_socio: await codigoPrueba(t.db, sinSaldo.id), dolarones: 2000, efectivo: 23000 }));
    assert.equal(mucho.status, 409);
    assert.match(mucho.cuerpo.error, /insuficiente/);
    assert.equal(t.restante(v.id), 1000);
    assert.equal(t.lote(s.lote).restante, 5000);
    assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 0, 'ninguna venta se escribió');
    assert.equal(t.db.prepare("select count(*) as n from codigos_cliente where venta_id <> ''").get()!.n, 0);
    // Un código con el máximo justo de lo que le toca a la cuenta (20 D) sí vale.
    const bien = await pedir({ codigo_socio: await codigoPrueba(t.db, s.id, 2000) });
    assert.equal(bien.status, 201, JSON.stringify(bien.cuerpo));
    assert.deepEqual([t.restante(v.id), t.lote(s.lote).restante], [0, 3000]);
    assert.notEqual(t.foto(), antes);
  } finally { t.db.close(); }
});

test('vales mal escritos, repetidos o vencidos con socio: se rechazan sin escribir nada (#927)', async () => {
  const t = abrir();
  try {
    const v = await t.cupon(1000);
    const s = await t.socio(5000);
    const base = { cliente_id: s.id, dolarones: 500, efectivo: 24500 };
    const antes = t.foto();
    assert.equal((await t.pedir('/api/ventas', t.venta({ ...base, codigo_vale: 'DP-inventado' }))).status, 400);
    assert.equal((await t.pedir('/api/ventas', t.venta({ ...base, codigo_vale: [v.codigo, v.codigo] }))).status, 400);
    assert.equal((await t.pedir('/api/ventas', t.venta({ ...base, codigo_vale: v.codigo, dolarones: 10.5 }))).status, 400);
    assert.equal((await t.pedir('/api/ventas', t.venta({ ...base, codigo_vale: v.codigo, dolarones: 30000 }))).status, 400);
    t.db.prepare("update vales_dolarones set vence_en = '2000-01-01T00:00:00.000Z' where id = ?").run(v.id);
    assert.equal((await t.pedir('/api/ventas', t.venta({ ...base, codigo_vale: v.codigo }))).status, 409, 'vencido');
    t.db.prepare("update vales_dolarones set vence_en = ? where id = ?").run(v.vence_en, v.id);
    assert.equal(t.foto(), antes);
  } finally { t.db.close(); }
});

test('el papel cambia entre la lectura y el batch: 409, nada se escribe y el código del socio sigue sirviendo (#927)', async () => {
  const t = abrir();
  try {
    const v = await t.cupon(1000);
    const s = await t.socio(5000);
    const codigo = await codigoPrueba(t.db, s.id);
    const cuerpo = t.venta({ cliente_id: s.id, codigo_vale: v.codigo, codigo_socio: codigo, dolarones: 3000, efectivo: 22000 });
    const batch = t.env.DB.batch.bind(t.env.DB);
    // Otra caja gasta 8 D de ese vale justo antes de que se confirme esta venta.
    let inyectar = true;
    t.env.DB.batch = async (sentencias) => {
      if (inyectar) {
        inyectar = false;
        assert.equal((await t.pedir('/api/ventas', t.venta({ codigo_vale: v.codigo, dolarones: 800, efectivo: 24200 }))).status, 201);
      }
      return batch(sentencias);
    };
    const r = await t.pedir('/api/ventas', cuerpo);
    assert.equal(r.status, 409, JSON.stringify(r.cuerpo));
    assert.match(r.cuerpo.error, /vale/i);
    assert.equal(t.restante(v.id), 200);
    assert.equal(t.lote(s.lote).restante, 5000);
    assert.equal(t.db.prepare('select venta_id from codigos_cliente where cliente_id = ?').get(s.id)!.venta_id, '');
    assert.equal(t.db.prepare('select count(*) as n from ventas where id = ?').get(cuerpo.id)!.n, 0);
    // Vencer en vuelo también aborta todo.
    t.db.prepare('update vales_dolarones set restante = 1000 where id = ?').run(v.id);
    t.env.DB.batch = async (sentencias) => {
      t.db.prepare("update vales_dolarones set vence_en = '2000-01-01T00:00:00.000Z' where id = ?").run(v.id);
      return batch(sentencias);
    };
    assert.equal((await t.pedir('/api/ventas', t.venta({ ...cuerpo, id: crypto.randomUUID() }))).status, 409);
    assert.equal(t.lote(s.lote).restante, 5000);
    assert.equal(t.db.prepare("select count(*) as n from codigos_cliente where venta_id <> ''").get()!.n, 0);
  } finally { t.db.close(); }
});

test('reintentar el mismo folio devuelve lo mismo y no gasta ni gana dos veces (#927)', async () => {
  const t = abrir();
  try {
    const v = await t.cupon(1000);
    const s = await t.socio(5000);
    const pedido = t.venta({ cliente_id: s.id, codigo_vale: v.codigo, codigo_socio: await codigoPrueba(t.db, s.id), dolarones: 3000, efectivo: 22000 });
    const primera = await t.pedir('/api/ventas', pedido);
    assert.equal(primera.status, 201, JSON.stringify(primera.cuerpo));
    const despues = t.foto();
    const repetida = await t.pedir('/api/ventas', pedido);
    assert.equal(repetida.status, 200);
    assert.equal(repetida.cuerpo.duplicada, true);
    assert.equal(repetida.cuerpo.dolarones_papel, 1000);
    assert.equal(repetida.cuerpo.ganados, 2000);
    assert.deepEqual(repetida.cuerpo.vales_usados.map((x: { id: string }) => x.id), [v.id]);
    assert.equal(t.foto(), despues);
    // Otro reparto con el mismo folio es otra venta: no se acepta.
    assert.equal((await t.pedir('/api/ventas', { ...pedido, dolarones: 2000, efectivo: 23000 })).status, 409);
    assert.equal(t.foto(), despues);
  } finally { t.db.close(); }
});

test('cancelar el ticket completo regresa cada parte a su origen con su vencimiento y retira lo ganado (#927)', async () => {
  const t = abrir();
  try {
    const v = await t.cupon(1000);
    const c = await t.cupon(500);
    const s = await t.socio(5000);
    const vencimientos = { vale: t.db.prepare('select vence_en from vales_dolarones where id = ?').get(v.id)!.vence_en,
      cupon: t.db.prepare('select vence_en from vales_dolarones where id = ?').get(c.id)!.vence_en, lote: t.lote(s.lote).vence_en };
    const id = crypto.randomUUID();
    const venta = await t.pedir('/api/ventas', t.venta({ id, cliente_id: s.id, codigo_vale: [v.codigo, c.codigo],
      codigo_socio: await codigoPrueba(t.db, s.id), dolarones: 3000, efectivo: 22000 }));
    assert.equal(venta.status, 201, JSON.stringify(venta.cuerpo));
    assert.deepEqual([t.restante(c.id), t.restante(v.id), t.lote(s.lote).restante], [0, 0, 3500]);   // 5 + 10 de papel, 15 de cuenta
    const ganado = t.db.prepare('select id, restante from dolarones_lotes where venta_id = ?').get(id)!;
    assert.equal(ganado.restante, 2000);

    const r = await t.pedir(`/api/ventas/${id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' });
    assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
    assert.equal(r.cuerpo.devuelto, 22000);
    assert.equal(r.cuerpo.dolarones, 3000);
    assert.deepEqual([t.restante(c.id), t.restante(v.id), t.lote(s.lote).restante], [500, 1000, 5000]);
    assert.equal(t.db.prepare('select vence_en from vales_dolarones where id = ?').get(v.id)!.vence_en, vencimientos.vale);
    assert.equal(t.db.prepare('select vence_en from vales_dolarones where id = ?').get(c.id)!.vence_en, vencimientos.cupon);
    assert.equal(t.lote(s.lote).vence_en, vencimientos.lote);
    assert.equal(t.db.prepare('select restante from dolarones_lotes where id = ?').get(ganado.id)!.restante, 0, 'lo ganado se retira');
    assert.equal(t.movimientos('vales_movimientos', id, 'reverso_canje'), 1500);
    assert.equal(t.movimientos('dolarones_movimientos', id, 'reverso_canje'), 1500);
    // Cancelar otra vez no devuelve dos veces.
    assert.equal((await t.pedir(`/api/ventas/${id}/cancelar`, { motivo: 'otra', caja: 'Caja 1' })).cuerpo.ya_estaba, true);
    assert.deepEqual([t.restante(c.id), t.restante(v.id), t.lote(s.lote).restante], [500, 1000, 5000]);
    // Y el papel vuelve a servir.
    assert.equal((await t.pedir('/api/ventas', t.venta({ codigo_vale: v.codigo, dolarones: 1000, efectivo: 24000 }))).status, 201);
  } finally { t.db.close(); }
});

test('con papel en el ticket el dinero de una pieza no se devuelve (sí en cupón, o se cancela completo); con solo cuenta sigue como antes (#927)', async () => {
  const t = abrir();
  try {
    const v = await t.cupon(1000);
    const s = await t.socio(100000);
    const mixto = crypto.randomUUID();
    const r = await t.pedir('/api/ventas', t.venta({ id: mixto, cliente_id: s.id, codigo_vale: v.codigo,
      codigo_socio: await codigoPrueba(t.db, s.id), dolarones: 3000, efectivo: 72000, lineas: [{ producto_id: PRODUCTO, cantidad: 3 }] }));
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    const detalle = async (id: string) => (await t.pedir(`/api/ventas/${id}`, undefined, 'GET')).cuerpo;
    const antes = await detalle(mixto);
    const fotoAntes = t.foto();
    const parcial = await t.pedir(`/api/ventas/${mixto}/lineas/${antes.lineas[0].id}/cancelar`,
      { id: crypto.randomUUID(), cantidad: 1, motivo: 'prueba', caja: 'Caja 1' });
    assert.equal(parcial.status, 409);
    assert.equal(parcial.cuerpo.error, 'Este ticket se pagó con un vale o cupón: devuelve la pieza en cupón o cancélalo completo.');
    assert.deepEqual(await detalle(mixto), antes);
    assert.equal(t.foto(), fotoAntes);

    // Solo cuenta: la pieza se devuelve y el reparto de siempre (dinero primero) sigue igual, también en cupón.
    const soloCuenta = async (cantidad = 2) => {
      const id = crypto.randomUUID();
      const c = await t.pedir('/api/ventas', t.venta({ id, cliente_id: s.id, codigo_socio: await codigoPrueba(t.db, s.id),
        dolarones: 25000, efectivo: 25000 * (cantidad - 1), lineas: [{ producto_id: PRODUCTO, cantidad }] }));
      assert.equal(c.status, 201, JSON.stringify(c.cuerpo));
      assert.equal(c.cuerpo.dolarones_papel, 0);
      return id;
    };
    const unaPieza = await soloCuenta();
    const pieza = await t.pedir(`/api/ventas/${unaPieza}/lineas/${(await detalle(unaPieza)).lineas[0].id}/cancelar`,
      { id: crypto.randomUUID(), cantidad: 1, motivo: 'prueba', caja: 'Caja 1' });
    assert.equal(pieza.status, 201, JSON.stringify(pieza.cuerpo));
    const aCupon = await soloCuenta();
    const enCupon = await t.pedir(`/api/ventas/${aCupon}/cupon`, { id: crypto.randomUUID(), lineas: 'todo', motivo: 'prueba', caja: 'Caja 1' });
    assert.equal(enCupon.status, 201, JSON.stringify(enCupon.cuerpo));
    // Un ticket de vale sin socio, como siempre.
    const w = await t.vale();
    const solo = await t.pedir('/api/ventas', t.venta({ codigo_vale: w.codigo, dolarones: 500, efectivo: 24500 }));
    assert.equal(solo.cuerpo.dolarones_papel, 500);
    const lineaSolo = (await detalle(solo.cuerpo.id)).lineas[0].id;
    assert.equal((await t.pedir(`/api/ventas/${solo.cuerpo.id}/lineas/${lineaSolo}/cancelar`,
      { id: crypto.randomUUID(), cantidad: 1, motivo: 'prueba', caja: 'Caja 1' })).status, 409);
  } finally { t.db.close(); }
});

test('la promo de noviembre y los referidos cuentan solo dinero: el papel no suma (#927)', async () => {
  const t = abrir();
  try {
    Object.assign(t.env, { PROMO_META_INICIO: new Date(Date.now() - DIA).toISOString(), PROMO_META_FIN: new Date(Date.now() + 30 * DIA).toISOString(),
      PROMO_META_VENCE: new Date(Date.now() + 90 * DIA).toISOString() });
    // Promo: $3,000 de ticket pagados con $300 de cupón son $2,700 en dinero; no completan el bloque.
    const s = await t.socio();
    t.precio(300000);
    const cupon = await t.cupon(30000);
    const a = await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_vale: cupon.codigo, dolarones: 30000, efectivo: 270000 }));
    assert.equal(a.status, 201, JSON.stringify(a.cuerpo));
    assert.equal(a.cuerpo.bono_promo, 0);
    assert.equal(a.cuerpo.ganados, 27000, '$2,700 en dinero al 10 %');
    // Con $300 más en dinero se juntan los $3,000 y entonces sí hay bono.
    t.precio(30000);
    const b = await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, efectivo: 30000 }));
    assert.equal(b.cuerpo.bono_promo, 30000);

    // Referidos: el mínimo de $150 es en dinero. $160 con $20 de cupón son $140: no libera; $170 con $20 son $150: sí.
    const referente = await t.socio();
    const nuevo = await t.socio();
    t.db.prepare("insert into referidos (nuevo_id, referente_id, estado, creado_en) values (?, ?, 'pendiente', '')").run(nuevo.id, referente.id);
    const estado = () => t.db.prepare('select estado from referidos where nuevo_id = ?').get(nuevo.id)!.estado;
    t.precio(16000);
    const corta = await t.pedir('/api/ventas', t.venta({ cliente_id: nuevo.id, codigo_vale: (await t.cupon(2000)).codigo, dolarones: 2000, efectivo: 14000 }));
    assert.equal(corta.status, 201, JSON.stringify(corta.cuerpo));
    assert.equal(corta.cuerpo.referido_liberado, 0);
    assert.equal(estado(), 'pendiente');
    t.precio(17000);
    const justa = await t.pedir('/api/ventas', t.venta({ cliente_id: nuevo.id, codigo_vale: (await t.cupon(2000)).codigo, dolarones: 2000, efectivo: 15000 }));
    assert.equal(justa.cuerpo.referido_liberado, 2500);
    assert.equal(estado(), 'liberado');
  } finally { t.db.close(); }
});

test('el tablero cuenta como «pagó con Dolarones» solo a quien gastó de su cuenta, no a quien presentó papel (#927)', async () => {
  const t = abrir();
  try {
    // Cinco socios que pagan solo con cupón: ninguno pagó con su cuenta.
    for (let i = 0; i < 5; i++) {
      const s = await t.socio(5000);
      const r = await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_vale: (await t.cupon(1000)).codigo, dolarones: 1000, efectivo: 24000 }));
      assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    }
    assert.equal((await vista(t, 'clientes')).cuerpo.dolarones_pagados, null);
    // Cinco que combinan 10 D de papel y 10 D de cuenta: se cuentan 5 × 10 D, sin el papel.
    for (let i = 0; i < 5; i++) {
      const s = await t.socio(5000);
      const r = await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_vale: (await t.cupon(1000)).codigo,
        codigo_socio: await codigoPrueba(t.db, s.id), dolarones: 2000, efectivo: 23000 }));
      assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    }
    assert.equal((await vista(t, 'clientes')).cuerpo.dolarones_pagados, 5 * 1000);
  } finally { t.db.close(); }
});

test('cajas sin actualizar: vale solo, socio solo y ninguno responden como antes (#927)', async () => {
  const t = abrir();
  try {
    const v = await t.vale();
    const soloVale = await t.pedir('/api/ventas', t.venta({ codigo_vale: v.codigo, dolarones: 500, efectivo: 24500 }));
    assert.equal(soloVale.status, 201);
    assert.equal(soloVale.cuerpo.dolarones, 500);
    assert.equal(soloVale.cuerpo.dolarones_papel, 500);
    assert.equal(soloVale.cuerpo.vale_usado.id, v.id);
    assert.equal(soloVale.cuerpo.saldo, null);
    // Con vale pero sin socio y sin Dolarones suficientes: igual que siempre.
    assert.equal((await t.pedir('/api/ventas', t.venta({ codigo_vale: v.codigo, dolarones: 600, efectivo: 24400 }))).status, 409);
    const s = await t.socio(5000);
    const soloSocio = await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_socio: await codigoPrueba(t.db, s.id), dolarones: 1000, efectivo: 24000 }));
    assert.equal(soloSocio.status, 201, JSON.stringify(soloSocio.cuerpo));
    assert.equal(soloSocio.cuerpo.dolarones_papel, 0);
    assert.deepEqual(soloSocio.cuerpo.vales_usados, []);
    assert.equal(t.movimientos('dolarones_movimientos', soloSocio.cuerpo.id, 'canje'), -1000);
    const ninguno = await t.pedir('/api/ventas', t.venta());
    assert.equal(ninguno.status, 201);
    assert.equal(ninguno.cuerpo.dolarones_papel, 0);
    assert.ok(ninguno.cuerpo.vale_emitido, 'una venta sin socio ni vale sigue emitiendo el suyo');
    // Sin socio no hay a quién cobrarle Dolarones que el papel no cubre.
    assert.equal((await t.pedir('/api/ventas', t.venta({ dolarones: 100 }))).status, 400);
  } finally { t.db.close(); }
});

test('un vale de compra no se junta con un socio, ni solo ni con cupones; no se escribe nada (#927)', async () => {
  const t = abrir();
  try {
    const compra = await t.vale();
    const cupon = await t.cupon(1000);
    const s = await t.socio(5000);
    const codigo = await codigoPrueba(t.db, s.id);
    const antes = t.foto();
    const msg = 'Usa vales o una membresía, no ambos en el mismo ticket.';
    for (const [codigos, dolarones] of [[compra.codigo, 500], [compra.codigo, 0], [[cupon.codigo, compra.codigo], 1500], [[compra.codigo, cupon.codigo], 0]] as const) {
      const r = await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_vale: codigos, codigo_socio: codigo, dolarones, efectivo: 25000 - dolarones }));
      assert.equal(r.status, 400, JSON.stringify(codigos));
      assert.equal(r.cuerpo.error, msg);
    }
    // Un código que no existe tampoco pasa con socio; sin socio sigue siendo 409 («no disponible»).
    const falso = 'DP-' + 'A'.repeat(16);
    assert.equal((await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_vale: falso, dolarones: 500, efectivo: 24500 }))).status, 400);
    assert.equal((await t.pedir('/api/ventas', t.venta({ codigo_vale: falso, dolarones: 500, efectivo: 24500 }))).status, 409);
    assert.equal(t.foto(), antes);
    // Sin socio, vale de compra y cupón siguen juntándose como siempre; el cupón solo con socio sí entra.
    assert.equal((await t.pedir('/api/ventas', t.venta({ codigo_vale: [compra.codigo, cupon.codigo], dolarones: 1500, efectivo: 23500 }))).status, 201);
    const otro = await t.cupon(1000);
    assert.equal((await t.pedir('/api/ventas', t.venta({ cliente_id: s.id, codigo_vale: otro.codigo, dolarones: 500, efectivo: 24500 }))).status, 201);
  } finally { t.db.close(); }
});

/** Un ticket de `piezas` piezas de $250 con socio, un cupón de `papel`, `cuenta` de su cuenta y el resto en efectivo. */
async function ticketMixto(t: ReturnType<typeof abrir>, piezas: number, papel: number, cuenta: number) {
  const cupon = await t.cupon(papel);
  const s = await t.socio(cuenta + 5000);
  const id = crypto.randomUUID();
  const r = await t.pedir('/api/ventas', t.venta({ id, cliente_id: s.id, codigo_vale: cupon.codigo, codigo_socio: await codigoPrueba(t.db, s.id),
    dolarones: papel + cuenta, efectivo: 25000 * piezas - papel - cuenta, lineas: [{ producto_id: PRODUCTO, cantidad: piezas }] }));
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const lineas = (await t.pedir(`/api/ventas/${id}`, undefined, 'GET')).cuerpo.lineas;
  const devolver = (extra: Record<string, unknown> = {}) => t.pedir(`/api/ventas/${id}/cupon`,
    { id: crypto.randomUUID(), lineas: [{ linea: lineas[0].id, cantidad: 1 }], motivo: 'no le quedó', caja: 'Caja 1', ...extra });
  const venta = () => ({ ...t.db.prepare('select total, dolarones, devuelto, devuelto_cupon, dolarones_devueltos from ventas where id = ?').get(id) } as Record<string, number>);
  return { id, cupon, s, lineas, devolver, venta };
}

const nuevosCupones = (t: ReturnType<typeof abrir>) => t.db.prepare("select count(*) as n from vales_dolarones where origen = 'devolucion'").get()!.n as number;
const bitacoraVieja = (t: ReturnType<typeof abrir>, id: string, tipo: string) => t.db.prepare(
  'select coalesce(sum(importe), 0) as n from vales_movimientos where vale_id = ? and tipo = ?').get(id, tipo)!.n as number;

test('devolver una pieza en cupón con socio + cupón: dinero primero; lo que pasa va a la cuenta y luego al cupón nuevo (1:1) (#927)', async () => {
  const t = abrir();
  try {
    // 3 piezas de $250 = $750: 50 D de cupón viejo, 300 D de la cuenta y $400 en efectivo.
    const m = await ticketMixto(t, 3, 5000, 30000);
    const viejo = () => t.db.prepare('select restante from vales_dolarones where id = ?').get(m.cupon.id)!.restante as number;
    assert.deepEqual(m.venta(), { total: 75000, dolarones: 35000, devuelto: 0, devuelto_cupon: 0, dolarones_devueltos: 0 });
    assert.deepEqual([viejo(), t.lote(m.s.lote).restante], [0, 5000]);

    // 1) La primera pieza cabe en el dinero pagado ($400): cupón de $250 y nada de Dolarones se mueve.
    const a = await m.devolver();
    assert.equal(a.status, 201, JSON.stringify(a.cuerpo));
    assert.equal(a.cuerpo.cupon.importe, 25000);
    assert.deepEqual([a.cuerpo.dolarones, a.cuerpo.dolarones_cuenta, a.cuerpo.cupon_papel], [0, 0, 0]);
    assert.deepEqual(m.venta(), { total: 75000, dolarones: 35000, devuelto: 25000, devuelto_cupon: 25000, dolarones_devueltos: 0 });
    assert.equal(bitacoraVieja(t, m.cupon.id, 'retiro') + bitacoraVieja(t, m.cupon.id, 'reverso_canje'), 0);

    // 2) La segunda: quedan $150 de dinero y 100 D pasan. Todo cabe en lo que la cuenta tiene canjeado (300 D): regresan a sus lotes.
    //    Cupón nuevo: $150 (100 %) y nada del cupón viejo.
    const b = await m.devolver();
    assert.equal(b.cuerpo.cupon.importe, 15000);
    assert.deepEqual([b.cuerpo.dolarones, b.cuerpo.dolarones_cuenta, b.cuerpo.cupon_papel], [10000, 10000, 0]);
    assert.equal(t.lote(m.s.lote).restante, 15000);
    assert.deepEqual(m.venta(), { total: 75000, dolarones: 35000, devuelto: 40000, devuelto_cupon: 40000, dolarones_devueltos: 10000 });
    assert.equal(bitacoraVieja(t, m.cupon.id, 'reverso_canje'), 0);

    // 3) La tercera es toda Dolarones (250 D): los 200 D que le quedan a la cuenta regresan a ella y los 50 D que pagó el cupón viejo
    //    se suman 1:1 al cupón nuevo. El cupón viejo NO se restaura; su bitácora asienta que ya salieron en el nuevo.
    const c = await m.devolver();
    assert.equal(c.status, 201, JSON.stringify(c.cuerpo));
    assert.equal(c.cuerpo.cupon.importe, 5000);
    assert.deepEqual([c.cuerpo.dolarones, c.cuerpo.dolarones_cuenta, c.cuerpo.cupon_papel], [25000, 20000, 5000]);
    assert.equal(t.lote(m.s.lote).restante, 35000, 'la cuenta recupera todo lo que gastó');
    assert.equal(viejo(), 0, 'el cupón viejo no se restaura');
    assert.deepEqual([bitacoraVieja(t, m.cupon.id, 'canje'), bitacoraVieja(t, m.cupon.id, 'reverso_canje'), bitacoraVieja(t, m.cupon.id, 'retiro')], [-5000, 5000, -5000]);
    assert.deepEqual(m.venta(), { total: 75000, dolarones: 35000, devuelto: 40000, devuelto_cupon: 40000, dolarones_devueltos: 35000 });
    // Cada devolución quedó con su parte: dinero en `cupon`, Dolarones en `dolarones`.
    assert.deepEqual(t.db.prepare('select cupon, dolarones, importe from devoluciones where venta_id = ? order by rowid').all(m.id).map((d) => ({ ...d })),
      [{ cupon: 25000, dolarones: 0, importe: 0 }, { cupon: 15000, dolarones: 10000, importe: 0 }, { cupon: 0, dolarones: 25000, importe: 0 }]);
    assert.equal(nuevosCupones(t), 3);
  } finally { t.db.close(); }
});

test('cupón nuevo con toda la parte de Dolarones pagada por el cupón viejo; reenviar con el mismo id emite uno solo; cancelar completo queda bloqueado (#927)', async () => {
  const t = abrir();
  try {
    // 2 piezas = $500: 100 D de cupón viejo, nada de la cuenta, $400 en efectivo.
    const m = await ticketMixto(t, 2, 10000, 0);
    assert.equal((await m.devolver()).cuerpo.cupon.importe, 25000);
    const id = crypto.randomUUID();
    // Segunda pieza: quedan $150 de dinero y 100 D pasan; la cuenta no gastó nada en este ticket: todo es del cupón viejo.
    const b = await m.devolver({ id });
    assert.equal(b.status, 201, JSON.stringify(b.cuerpo));
    assert.equal(b.cuerpo.cupon.importe, 15000 + 10000);
    assert.deepEqual([b.cuerpo.dolarones, b.cuerpo.dolarones_cuenta, b.cuerpo.cupon_papel], [10000, 0, 10000]);
    assert.deepEqual([bitacoraVieja(t, m.cupon.id, 'reverso_canje'), bitacoraVieja(t, m.cupon.id, 'retiro')], [10000, -10000]);
    assert.equal(t.db.prepare('select restante from vales_dolarones where id = ?').get(m.cupon.id)!.restante, 0);
    const despues = t.foto();
    const otra = await m.devolver({ id });
    assert.equal(otra.cuerpo.duplicada, true);
    assert.equal(otra.cuerpo.cupon.id, id);
    assert.equal(t.foto(), despues);
    assert.equal(nuevosCupones(t), 2);
    // Con piezas devueltas en cupón el ticket ya no se cancela completo (regla de siempre).
    const completo = await t.pedir(`/api/ventas/${m.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' });
    assert.equal(completo.status, 409);
    assert.match(completo.cuerpo.error, /pieza por pieza/);
  } finally { t.db.close(); }
});

test('si el cupón viejo pagó todo y la pieza no mueve dinero, igual queda un cupón nuevo y el ticket ya no se cancela completo; el dinero de la pieza sigue bloqueado (#927)', async () => {
  const t = abrir();
  try {
    const m = await ticketMixto(t, 2, 50000, 0);                // todo con cupón viejo: $0 en dinero
    const r = await m.devolver();
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    assert.equal(r.cuerpo.cupon.importe, 25000);
    assert.deepEqual([r.cuerpo.dolarones, r.cuerpo.cupon_papel], [25000, 25000]);
    assert.deepEqual(m.venta(), { total: 50000, dolarones: 50000, devuelto: 0, devuelto_cupon: 0, dolarones_devueltos: 25000 });
    // devuelto_cupon sigue en 0, pero ya se re-emitió lo del cupón viejo: cancelar completo lo devolvería dos veces.
    const completo = await t.pedir(`/api/ventas/${m.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' });
    assert.equal(completo.status, 409);
    const dinero = await t.pedir(`/api/ventas/${m.id}/lineas/${m.lineas[0].id}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'x', caja: 'Caja 1' });
    assert.equal(dinero.status, 409);
    assert.equal(dinero.cuerpo.error, 'Este ticket se pagó con un vale o cupón: devuelve la pieza en cupón o cancélalo completo.');
  } finally { t.db.close(); }
});

test('si el cupón nuevo saldría en cero (la cuenta pagó la pieza) el servidor lo dice y la pieza se cancela normal; sin socio un ticket de vale sigue bloqueado (#927)', async () => {
  const t = abrir();
  try {
    const m = await ticketMixto(t, 2, 5000, 45000);             // 50 D de cupón viejo + 450 D de cuenta: $0 en dinero
    const antes = t.foto();
    const r = await m.devolver();
    assert.equal(r.status, 409);
    assert.equal(r.cuerpo.error, 'Esas piezas se pagaron con Dolarones: no hay dinero que pasar a cupón. Cancélalas normal.');
    assert.equal(t.foto(), antes);
    // «Cancélalas normal» sí tiene salida: la pieza no mueve dinero y la cuenta cubre todo.
    const normal = await t.pedir(`/api/ventas/${m.id}/lineas/${m.lineas[0].id}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'x', caja: 'Caja 1' });
    assert.equal(normal.status, 201, JSON.stringify(normal.cuerpo));
    assert.deepEqual([normal.cuerpo.devuelto, normal.cuerpo.dolarones], [0, 25000]);
    assert.equal(t.lote(m.s.lote).restante, 5000 + 25000);
    assert.equal((await t.pedir(`/api/ventas/${m.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' })).status, 200, 'y el ticket aún se cancela completo');

    const w = await t.vale();
    const solo = await t.pedir('/api/ventas', t.venta({ codigo_vale: w.codigo, dolarones: 500, efectivo: 24500 }));
    const r2 = await t.pedir(`/api/ventas/${solo.cuerpo.id}/cupon`, { id: crypto.randomUUID(), lineas: 'todo', motivo: 'x', caja: 'Caja 1' });
    assert.equal(r2.status, 409);
    assert.equal(r2.cuerpo.error, 'Este ticket se pagó con un vale: cancélalo completo, en dinero.');
  } finally { t.db.close(); }
});

test('callejón sin salida cerrado: cupón → pieza pagada por la cuenta (cancelación normal) → pieza pagada por el cupón viejo (cupón nuevo); el dinero de una pieza no sale en ningún paso (#927)', async () => {
  const t = abrir();
  try {
    // 3 piezas de $250 iguales: una tercera parte en dinero, una de la cuenta y una del cupón.
    const m = await ticketMixto(t, 3, 25000, 25000);
    const viejo = () => t.db.prepare('select restante from vales_dolarones where id = ?').get(m.cupon.id)!.restante as number;
    const dinero = () => t.pedir(`/api/ventas/${m.id}/lineas/${m.lineas[0].id}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'x', caja: 'Caja 1' });
    const completo = () => t.pedir(`/api/ventas/${m.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' });
    const MSG = 'Este ticket se pagó con un vale o cupón: devuelve la pieza en cupón o cancélalo completo.';
    assert.deepEqual(m.venta(), { total: 75000, dolarones: 50000, devuelto: 0, devuelto_cupon: 0, dolarones_devueltos: 0 });
    assert.equal(t.lote(m.s.lote).restante, 5000);

    // Paso 0: aún hay dinero; devolver dinero de una pieza sigue rechazado.
    const antes = t.foto();
    const r0 = await dinero();
    assert.equal(r0.status, 409);
    assert.equal(r0.cuerpo.error, MSG);
    assert.equal(t.foto(), antes);

    // Paso 1 (A): la pieza va a cupón con el dinero que sí se pagó.
    const a = await m.devolver();
    assert.equal(a.status, 201, JSON.stringify(a.cuerpo));
    assert.equal(a.cuerpo.cupon.importe, 25000);
    assert.deepEqual(m.venta(), { total: 75000, dolarones: 50000, devuelto: 25000, devuelto_cupon: 25000, dolarones_devueltos: 0 });

    // Paso 2 (B): el dinero ya se acabó y la cuenta cubre toda la pieza: en cupón no hay nada que dar («Cancélalas normal»)...
    const b0 = await m.devolver();
    assert.equal(b0.status, 409);
    assert.match(b0.cuerpo.error, /Cancélalas normal/);
    // ...y la cancelación normal sí pasa: sin dinero ni cupón, los Dolarones regresan a la cuenta.
    const b = await dinero();
    assert.equal(b.status, 201, JSON.stringify(b.cuerpo));
    assert.deepEqual([b.cuerpo.devuelto, b.cuerpo.dolarones], [0, 25000]);
    assert.equal(t.lote(m.s.lote).restante, 30000);
    assert.deepEqual(m.venta(), { total: 75000, dolarones: 50000, devuelto: 25000, devuelto_cupon: 25000, dolarones_devueltos: 25000 });
    assert.equal(viejo(), 0);
    assert.equal(bitacoraVieja(t, m.cupon.id, 'reverso_canje') + bitacoraVieja(t, m.cupon.id, 'retiro'), 0, 'el cupón viejo ni se toca');
    assert.equal(nuevosCupones(t), 1);

    // Paso 3 (C): lo que queda lo pagó el cupón viejo. El dinero de la pieza sigue rechazado y la salida es un cupón nuevo con esa parte.
    const antesC = t.foto();
    const rC = await dinero();
    assert.equal(rC.status, 409);
    assert.equal(rC.cuerpo.error, MSG);
    assert.equal(t.foto(), antesC);
    const c = await m.devolver();
    assert.equal(c.status, 201, JSON.stringify(c.cuerpo));
    assert.equal(c.cuerpo.cupon.importe, 25000);
    assert.deepEqual([c.cuerpo.dolarones, c.cuerpo.dolarones_cuenta, c.cuerpo.cupon_papel], [25000, 0, 25000]);

    // Saldos finales.
    assert.equal(t.lote(m.s.lote).restante, 30000, 'la cuenta recuperó lo que gastó, una sola vez');
    assert.equal(viejo(), 0, 'el cupón viejo no se restaura');
    assert.deepEqual([bitacoraVieja(t, m.cupon.id, 'canje'), bitacoraVieja(t, m.cupon.id, 'reverso_canje'), bitacoraVieja(t, m.cupon.id, 'retiro')], [-25000, 25000, -25000]);
    assert.deepEqual(m.venta(), { total: 75000, dolarones: 50000, devuelto: 25000, devuelto_cupon: 25000, dolarones_devueltos: 50000 });
    assert.equal(nuevosCupones(t), 2);
    assert.deepEqual(t.db.prepare("select importe, restante from vales_dolarones where origen = 'devolucion' order by creado_en, rowid").all().map((x) => ({ ...x })),
      [{ importe: 25000, restante: 25000 }, { importe: 25000, restante: 25000 }]);
    assert.deepEqual(t.db.prepare('select cupon, dolarones, importe, vale_id is not null as con_cupon from devoluciones where venta_id = ? order by rowid').all(m.id).map((d) => ({ ...d })),
      [{ cupon: 25000, dolarones: 0, importe: 0, con_cupon: 1 }, { cupon: 0, dolarones: 25000, importe: 0, con_cupon: 0 }, { cupon: 0, dolarones: 25000, importe: 0, con_cupon: 1 }]);
    // Ya con tres piezas devueltas, el dinero y la cancelación completa siguen sin pasar.
    assert.equal((await completo()).status, 409);
  } finally { t.db.close(); }
});
