// node --test src/promo-meta.test.ts
// Promo de noviembre (Issue #684): cada $3,000 en dinero dan 300 D. Regla pura + SQLite real con todas las migraciones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from './worker.ts';
import {
  bonosDeMeta, enPeriodoDePromo, sentenciasDeVenta, promoMeta, progresoDePromo, disponibleDesde, PROMO_META, PROMO_BONO,
} from './dolarones.ts';
import { tienda, codigoPrueba, PRODUCTO } from './prueba-d1.ts';

const DIA = 86_400_000;
const periodo = () => ({
  PROMO_META_INICIO: new Date(Date.now() - DIA).toISOString(),
  PROMO_META_FIN: new Date(Date.now() + 30 * DIA).toISOString(),
  PROMO_META_VENCE: new Date(Date.now() + 90 * DIA).toISOString(),
});

/* ---------- reglas puras ---------- */

test('bonosDeMeta: cruza múltiplos de $3,000, también varios en una venta', () => {
  assert.equal(bonosDeMeta(0, 299_999), 0);
  assert.equal(bonosDeMeta(299_999, 1), 1);
  assert.equal(bonosDeMeta(0, 300_000), 1);
  assert.equal(bonosDeMeta(0, 900_000), 3);
  assert.equal(bonosDeMeta(250_000, 500_000), 2);   // 2,500 -> 7,500: cruza 3,000 y 6,000
  assert.equal(bonosDeMeta(500_000, 200_000), 1);   // 5,000 -> 7,000: solo el 6,000
  assert.equal(bonosDeMeta(600_000, 0), 0);
  assert.equal(bonosDeMeta(100_000, -50_000), 0);
  // Ya pagados: una devolución bajó el acumulado a 2,500 con un bono pagado; no se paga el mismo bloque dos veces.
  assert.equal(bonosDeMeta(250_000, 100_000, PROMO_META, 1), 0);
  assert.equal(bonosDeMeta(250_000, 400_000, PROMO_META, 1), 1);   // llega a 6,500
  // Rezago: se enciende tarde y el socio ya llevaba 3,500 sin bono pagado.
  assert.equal(bonosDeMeta(350_000, 10_000, PROMO_META, 0), 1);
});

test('promoMeta: apagada si falta o está mal cualquier variable; el periodo es [inicio, fin)', () => {
  const ok = { PROMO_META_INICIO: '2026-11-01T06:00:00Z', PROMO_META_FIN: '2026-12-01T06:00:00Z', PROMO_META_VENCE: '2027-02-01T06:00:00Z' };
  const meta = promoMeta(ok as unknown as Env)!;
  assert.deepEqual(meta, { inicio: '2026-11-01T06:00:00.000Z', fin: '2026-12-01T06:00:00.000Z', vence: '2027-02-01T06:00:00.000Z' });
  for (const [campo, malo] of [['PROMO_META_INICIO', undefined], ['PROMO_META_FIN', ''], ['PROMO_META_VENCE', 'enero'], ['PROMO_META_FIN', '2026-99-99T00:00:00Z'],
    ['PROMO_META_FIN', '2026-11-01T06:00:00Z']] as const)
    assert.equal(promoMeta({ ...ok, [campo]: malo } as unknown as Env), null, `${campo}=${malo}`);
  assert.equal(promoMeta({} as Env), null);
  assert.equal(enPeriodoDePromo(meta, new Date('2026-11-01T05:59:59.999Z')), false);
  assert.equal(enPeriodoDePromo(meta, new Date('2026-11-01T06:00:00Z')), true);
  assert.equal(enPeriodoDePromo(meta, new Date('2026-12-01T05:59:59.999Z')), true);
  assert.equal(enPeriodoDePromo(meta, new Date('2026-12-01T06:00:00Z')), false);
});

/* ---------- con D1 ---------- */

let telefonos = 4450000000;
function abrir(encendida = true) {
  const t = tienda();
  if (encendida) Object.assign(t.env, periodo());
  const precio = (centavos: number) => t.db.prepare('update productos set precio = ? where id = ?').run(centavos, PRODUCTO);
  const alta = async () => {
    const r = await t.pedir('/api/socios', { id: crypto.randomUUID(), nombre: 'Cliente', telefono: String(telefonos++), acepta_bases: true, declara_mayor_edad: true });
    await t.pedir('/api/portal/llegada', { cliente_id: r.cuerpo.id });
    return r.cuerpo;
  };
  /** Una venta con el socio; `precio` es lo que cuesta la pieza (1 pieza) y `dolarones` lo que se paga con saldo. */
  const comprar = async (socio: Record<string, any>, centavos: number, extra: Record<string, unknown> = {}) => {
    precio(centavos);
    const dolarones = Number(extra.dolarones ?? 0);
    return t.pedir('/api/ventas', { id: crypto.randomUUID(), cliente_id: socio.id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
      forma_pago: 'efectivo', efectivo: centavos - dolarones,
      ...(dolarones ? { codigo_socio: await codigoPrueba(t.db, socio.id) } : {}), ...extra });
  };
  const bonos = () => t.db.prepare("select * from dolarones_lotes where origen = 'promo' order by rowid").all() as
    { id: string; cliente_id: string; venta_id: string | null; importe: number; restante: number; disponible_desde: string; vence_en: string }[];
  return { ...t, precio, alta, comprar, bonos };
}

test('al cruzar $3,000 en dinero la venta paga 300 D en su mismo batch, con vigencia propia y sin cambiar el 10 %', async () => {
  const t = abrir(), socio = await t.alta();
  const a = await t.comprar(socio, 150_000);
  assert.equal(a.status, 201);
  assert.equal(a.cuerpo.bono_promo, 0);
  assert.equal(t.bonos().length, 0);

  const b = await t.comprar(socio, 150_000);
  assert.equal(b.cuerpo.bono_promo, PROMO_BONO);
  assert.equal(b.cuerpo.ganados, 15_000, 'el 10 % normal no cambia');
  const [lote] = t.bonos();
  assert.deepEqual([lote.cliente_id, lote.venta_id, lote.importe, lote.restante], [socio.id, null, PROMO_BONO, PROMO_BONO]);
  assert.equal(lote.vence_en, t.env.PROMO_META_VENCE ? new Date(t.env.PROMO_META_VENCE).toISOString() : '');
  assert.equal(lote.disponible_desde, disponibleDesde(new Date()));
  assert.deepEqual({ ...t.db.prepare("select tipo, importe, venta_id from dolarones_movimientos where lote_id = ?").get(lote.id) }, { tipo: 'promo', importe: PROMO_BONO, venta_id: b.cuerpo.id });
  // Cuenta en el saldo por liberar y no es regalo de apertura.
  assert.equal(b.cuerpo.saldo.por_liberar, 15_000 * 2 + PROMO_BONO);
  assert.equal(b.cuerpo.saldo.regalo_disponible, 50_000);

  // Reenviar la misma venta no paga dos veces y repite el aviso del bono.
  const venta = t.db.prepare('select id from ventas where id = ?').get(b.cuerpo.id)!;
  assert.ok(venta);
  const otra = await t.pedir('/api/ventas', { id: b.cuerpo.id, cliente_id: socio.id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 150_000 });
  assert.equal(otra.cuerpo.duplicada, true);
  assert.equal(otra.cuerpo.bono_promo, PROMO_BONO);
  assert.equal(t.bonos().length, 1);
  t.db.close();
});

test('una venta grande cruza varios múltiplos y paga un lote por cada uno; el rezago de $1,500 sigue contando', async () => {
  const t = abrir(), socio = await t.alta();
  assert.equal((await t.comprar(socio, 100_000, { efectivo: 100_000 })).cuerpo.bono_promo, 0);   // 1,000
  const grande = await t.comprar(socio, 700_000);                                                   // 8,000 acumulado
  assert.equal(grande.cuerpo.bono_promo, 2 * PROMO_BONO);
  assert.equal(t.bonos().length, 2);
  assert.equal((await t.comprar(socio, 100_000)).cuerpo.bono_promo, PROMO_BONO);                   // 9,000
  assert.equal(t.bonos().length, 3);
  t.db.close();
});

test('lo pagado con Dolarones no suma a la meta', async () => {
  const t = abrir(), socio = await t.alta();
  // $1,500 con 500 D: solo $1,000 en dinero.
  assert.equal((await t.comprar(socio, 150_000, { dolarones: 50_000 })).status, 201);
  assert.equal((await t.comprar(socio, 150_000)).cuerpo.bono_promo, 0);   // 2,500 en dinero, aunque el total vendido ya pasa de 3,000
  assert.equal(t.bonos().length, 0);
  const meta = (await progresoDePromo(t.env, socio.id, new Date()))!;
  assert.equal(meta.acumulado, 250_000);
  assert.equal((await t.comprar(socio, 50_000)).cuerpo.bono_promo, PROMO_BONO);   // 3,000 justos
  t.db.close();
});

test('una venta fuera del periodo no genera bono ni suma; sin socio tampoco', async () => {
  const t = abrir(), socio = await t.alta();
  const vieja = await t.comprar(socio, 700_000, { creado_en: new Date(Date.now() - 40 * DIA).toISOString() });
  assert.equal(vieja.status, 201);
  assert.equal(vieja.cuerpo.bono_promo, 0);
  assert.equal(t.bonos().length, 0);
  // No cuenta para la meta aunque su fila exista.
  assert.equal((await t.comprar(socio, 150_000)).cuerpo.bono_promo, 0);
  assert.equal((await progresoDePromo(t.env, socio.id, new Date()))!.acumulado, 150_000);
  const mostrador = await t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 700_000 });
  assert.equal(mostrador.status, 201);
  assert.equal(t.bonos().length, 0);
  t.db.close();
});

test('cancelar la venta del bono lo retira y el acumulado se reconstruye sin ella', async () => {
  const t = abrir(), socio = await t.alta();
  await t.comprar(socio, 150_000);
  const b = await t.comprar(socio, 150_000);
  assert.equal(b.cuerpo.bono_promo, PROMO_BONO);
  assert.equal((await t.pedir(`/api/ventas/${b.cuerpo.id}/cancelar`, { motivo: 'prueba' })).status, 200);
  assert.equal(t.bonos()[0].restante, 0);
  assert.equal(t.db.prepare("select sum(importe) as n from dolarones_movimientos where lote_id = ?").get(t.bonos()[0].id)!.n, 0);
  assert.equal((await progresoDePromo(t.env, socio.id, new Date()))!.bonos, 0);
  // Con la venta cancelada fuera, otros $1,500 vuelven a completar los $3,000 y pagan el bono otra vez.
  assert.equal((await t.comprar(socio, 150_000)).cuerpo.bono_promo, PROMO_BONO);
  assert.equal(t.bonos().length, 2);
  t.db.close();
});

test('el bono se gasta sin mínimo de ticket y, gastado, detiene la cancelación como lo ganado por compra', async () => {
  const t = abrir(), socio = await t.alta();
  await t.comprar(socio, 150_000);
  const b = await t.comprar(socio, 150_000);
  t.db.prepare("update dolarones_lotes set disponible_desde = '2026-01-01' where origen in ('compra', 'promo')").run();
  t.db.prepare("update dolarones_lotes set restante = 0 where origen = 'regalo'").run();
  // Ticket de $250 (menor al mínimo de los regalos) pagado con 100 D: sale del lote que vence antes, el del bono.
  const gasto = await t.comprar(socio, 25_000, { dolarones: 10_000 });
  assert.equal(gasto.status, 201, JSON.stringify(gasto.cuerpo));
  assert.equal(t.bonos()[0].restante, PROMO_BONO - 10_000);
  const r = await t.pedir(`/api/ventas/${b.cuerpo.id}/cancelar`, { motivo: 'prueba' });
  assert.equal(r.status, 409);
  assert.equal(t.db.prepare('select cancelada from ventas where id = ?').get(b.cuerpo.id)!.cancelada, 0);
  assert.equal(t.bonos()[0].restante, PROMO_BONO - 10_000);
  assert.equal(t.db.prepare("select count(*) as n from dolarones_movimientos where tipo = 'reverso_promo'").get()!.n, 0);
  t.db.close();
});

test('dos cajas que leen el mismo estado no pagan el mismo bono dos veces', async () => {
  const t = abrir(), socio = await t.alta();
  await t.comprar(socio, 150_000);
  const [x, y] = [crypto.randomUUID(), crypto.randomUUID()];
  const args = { clienteId: socio.id, dolarones: 0, codigo: '', total: 150_000, autor: 'caja', ahora: new Date() };
  const [a, b] = await Promise.all([x, y].map((ventaId) => sentenciasDeVenta(t.env, { ...args, ventaId })));
  assert.ok(a.ok && b.ok);
  assert.equal(a.bono_promo, PROMO_BONO);
  assert.equal(b.bono_promo, PROMO_BONO);   // las dos leyeron lo mismo
  const venta = (id: string) => t.env.DB.prepare(`insert into ventas (id, total, forma_pago, efectivo, cambio, creado_en, registrado_en, cliente_id, dolarones)
    values (?, 150000, 'efectivo', 150000, 0, ?, ?, ?, 0)`).bind(id, new Date().toISOString(), new Date().toISOString(), socio.id);
  await t.env.DB.batch([venta(x), ...a.sentencias]);
  await t.env.DB.batch([venta(y), ...b.sentencias]);
  assert.equal(t.bonos().length, 1);
  t.db.close();
});

test('apagada o a medias, la venta y el saldo son los de siempre', async () => {
  for (const config of [{}, { PROMO_META_INICIO: periodo().PROMO_META_INICIO, PROMO_META_FIN: periodo().PROMO_META_FIN }]) {
    const t = abrir(false), socio = await t.alta();
    Object.assign(t.env, config);
    const r = await t.comprar(socio, 700_000);
    assert.equal(r.status, 201);
    assert.equal(r.cuerpo.bono_promo, 0);
    assert.deepEqual(r.cuerpo.saldo, { disponible: 50_000, por_liberar: 70_000, regalo_disponible: 50_000 });
    assert.equal(t.bonos().length, 0);
    assert.equal(await progresoDePromo(t.env, socio.id, new Date()), null);
    t.db.close();
  }
});

test('el portal informa la meta solo mientras la promo corre', async () => {
  const t = abrir();
  Object.assign(t.env, { HOST_PORTAL: 'portal.prueba', FIREBASE_PROJECT_ID: 'prueba-firebase', FIREBASE_WEB_API_KEY: 'clave' });
  const fetchOriginal = globalThis.fetch;
  const codificar = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
  globalThis.fetch = async () => Response.json({ users: [{ localId: 'u1', phoneNumber: '+524445550001' }] });
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = `${codificar({ alg: 'RS256' })}.${codificar({ aud: 'prueba-firebase', iss: 'https://securetoken.google.com/prueba-firebase',
      sub: 'u1', exp: now + 3600, iat: now, auth_time: now, phone_number: '+524445550001', firebase: { sign_in_provider: 'phone' } })}.firma`;
    const saldo = async () => {
      const r = await worker.fetch!(new Request('https://portal.prueba/api/portal/saldo', { headers: { authorization: `Bearer ${token}` } }) as never,
        t.env, { waitUntil() {} } as never);
      return (await r.json()) as Record<string, any>;
    };
    const registro = await worker.fetch!(new Request('https://portal.prueba/api/portal/registro', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ nombre: 'Cliente', acepta_bases: true, declara_mayor_edad: true, bases_version: 'prueba-1' }) }) as never,
      t.env, { waitUntil() {} } as never);
    const socio = (await registro.json()) as Record<string, any>;
    await t.comprar(socio, 150_000);
    await t.comprar(socio, 200_000);
    const dentro = await saldo();
    assert.deepEqual(dentro.promo_meta, { acumulado: 350_000, meta: PROMO_META, bono: PROMO_BONO, fin: new Date(t.env.PROMO_META_FIN!).toISOString(), bonos: 1 });
    assert.equal(dentro.lotes.filter((l: { origen: string }) => l.origen === 'promo').length, 1);
    // Fuera del periodo (ya terminó) la clave no existe.
    t.env.PROMO_META_FIN = new Date(Date.now() - 1000).toISOString();
    t.env.PROMO_META_INICIO = new Date(Date.now() - 2 * DIA).toISOString();
    assert.equal('promo_meta' in await saldo(), false);
  } finally { globalThis.fetch = fetchOriginal; t.db.close(); }
});

test('la caja, el ticket y el portal conocen el bono', () => {
  const caja = readFileSync('public/caja.html', 'utf8');
  assert.equal(caja.match(/socioTicket\.bono_promo = cuerpo\.bono_promo \?\? 0;/g)?.length, 2);
  assert.match(caja, /Bono noviembre: \+\$\{dolares\(socioTicket\.bono_promo\)\}/);
  assert.match(readFileSync('public/impresora.js', 'utf8'), /venta\.socio\.bono_promo\) partes\.push\(renglonMonto\('Bono noviembre/);
  assert.match(readFileSync('public/portal.js', 'utf8'), /pintarPromo\(s\.promo_meta\)/);
});
