// node --test src/cupon-plazo.test.ts
// #948 (H9): devolver en cupón una venta de más de 7 días pide la aprobación del supervisor o de gerencia, como devolver dinero (#837).
// Dentro del plazo todo sigue igual: el cajero lo hace solo. Contra SQLite real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { PLAZO_DEVOLUCION_MS, fueraDePlazo } from './devoluciones.ts';

const TIENDA = 'tienda@prueba.mx';
const ANA = 'ana@prueba.mx';
const SUP = 'sup@prueba.mx';
const PIN_DUENO = '111222';
const PIN_ANA = '482913';
const PIN_SUP = '735190';
const DIA = 86_400_000;

async function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en) values
    ('${TIENDA}', 'Computadora', 'computadora', 1, '', '', ''),
    ('${ANA}', 'Ana', 'cajero', 1, 'Caja 2', '', ''),
    ('${SUP}', 'Sara', 'cajero,supervisor', 1, '', '', '')`).run();
  t.db.prepare(`update usuarios set tienda = 'soledad' where roles = 'computadora'`).run();
  await t.pedir('/api/cuentas/pin', { correo: DUENO, pin: PIN_DUENO }, 'PUT');
  await t.pedir('/api/cuentas/pin', { correo: ANA, pin: PIN_ANA }, 'PUT');
  await t.pedir('/api/cuentas/pin', { correo: SUP, pin: PIN_SUP }, 'PUT');
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  como(TIENDA);
  const entrar = async (correo: string, pin: string) => ({ 'x-cajero': (await t.pedir('/api/cajeros/entrar', { correo, pin })).cuerpo.token as string });
  const ana = await entrar(ANA, PIN_ANA);
  // Una venta de dos piezas de $250 que llegó al servidor hace `registradaHace` y se cobró hace `cobradaHace` (por omisión, la misma hora).
  const vender = async (cobradaHace: number, registradaHace = cobradaHace) => {
    const id = crypto.randomUUID();
    const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], forma_pago: 'efectivo', efectivo: 50000, caja: 'Caja 1' }, 'POST', ana);
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    t.db.prepare('update ventas set creado_en = ?, registrado_en = ? where id = ?')
      .run(new Date(Date.now() - cobradaHace).toISOString(), new Date(Date.now() - registradaHace).toISOString(), id);
    return id;
  };
  const linea = async (venta: string) => (await t.pedir(`/api/ventas/${venta}`, undefined, 'GET', ana)).cuerpo.lineas[0].id as number;
  const cupon = (venta: string, lineaId: number, extra: Record<string, unknown> = {}, encabezados: Record<string, string> = ana) =>
    t.pedir(`/api/ventas/${venta}/cupon`, { id: crypto.randomUUID(), lineas: [{ linea: lineaId, cantidad: 1 }], motivo: 'prefiere cambio', caja: 'Caja 1', ...extra }, 'POST', encabezados);
  const stock = () => (t.db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock;
  const nada = (id: string) => ({
    venta: { ...t.db.prepare('select devuelto, devuelto_cupon, revision from ventas where id = ?').get(id) },
    devoluciones: (t.db.prepare('select count(*) as n from devoluciones').get() as { n: number }).n,
    vales: (t.db.prepare(`select count(*) as n from vales_dolarones where origen = 'devolucion'`).get() as { n: number }).n,
    stock: stock(),
  });
  const aprobadoPor = (idCupon: string) => (t.db.prepare('select aprobado_por from vales_dolarones where id = ?').get(idCupon) as { aprobado_por: string | null }).aprobado_por;
  return { ...t, como, entrar, ana, vender, linea, cupon, stock, nada, aprobadoPor };
}

test('la regla: 7 días corridos, medidos desde la fecha MÁS ANTIGUA entre la de la caja y la del servidor; sin fecha legible, fuera', () => {
  const ahora = Date.parse('2026-11-26T12:00:00Z');
  const hace = (ms: number) => new Date(ahora - ms).toISOString();
  assert.equal(PLAZO_DEVOLUCION_MS, 7 * DIA);
  assert.equal(fueraDePlazo(hace(7 * DIA), hace(7 * DIA), ahora), false);            // justo 7 días: todavía dentro
  assert.equal(fueraDePlazo(hace(7 * DIA + 1), hace(7 * DIA + 1), ahora), true);
  assert.equal(fueraDePlazo(hace(1000), hace(8 * DIA), ahora), true);               // la caja dice «hoy», el servidor la recibió hace 8 días
  assert.equal(fueraDePlazo(hace(8 * DIA), hace(1000), ahora), true);               // cobrada sin red hace 8 días y sincronizada hoy
  assert.equal(fueraDePlazo('', hace(1000), ahora), false);                         // una fecha ilegible se ignora
  assert.equal(fueraDePlazo('', '', ahora), true);                                  // sin ninguna: lo conservador
});

test('dentro del plazo el cajero devuelve en cupón solo, igual que antes: sin aprobación ni rastro de aprobador', async () => {
  const { vender, linea, cupon, stock, nada, aprobadoPor } = await montar();
  const id = await vender(6 * DIA);
  const antes = stock();
  const idCupon = crypto.randomUUID();
  const r = await cupon(id, await linea(id), { id: idCupon });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.cupon.importe, 25000);
  assert.equal(stock(), antes + 1);
  assert.equal(nada(id).vales, 1);
  assert.equal(aprobadoPor(idCupon), null);
  assert.equal((await cupon(id, await linea(id), { id: idCupon })).cuerpo.duplicada, true);   // el reenvío sigue siendo idempotente
});

test('fuera del plazo sin aprobación: 403 con el mensaje y los aprobadores; no se escribe nada (ni existencia, ni historial, ni cupón)', async () => {
  const { vender, linea, cupon, nada } = await montar();
  // La caja dice «hoy» pero el servidor la recibió hace 8 días: no rejuvenece. Y la cobrada hace 8 días sin red y sincronizada hoy.
  for (const [cobrada, registrada] of [[8 * DIA, 8 * DIA], [1000, 8 * DIA], [8 * DIA, 1000]]) {
    const id = await vender(cobrada, registrada);
    const antes = nada(id);
    const r = await cupon(id, await linea(id));
    assert.equal(r.status, 403, JSON.stringify(r.cuerpo));
    assert.equal(r.cuerpo.requiere_aprobacion, true);
    assert.equal(r.cuerpo.fuera_de_plazo, true);
    assert.match(r.cuerpo.error, /más de 7 días.*aprobación del supervisor o de gerencia.*PIN/);
    assert.deepEqual(r.cuerpo.duenos, [{ correo: DUENO, nombre: 'Isaac' }, { correo: SUP, nombre: 'Sara' }]);
    assert.deepEqual(nada(id), antes);
  }
});

test('compatibilidad: la caja anterior (sin aprobador ni pin) recibe un rechazo legible en `error`, no un 500', async () => {
  const { vender, linea, cupon } = await montar();
  const id = await vender(30 * DIA);
  const r = await cupon(id, await linea(id), { lineas: 'todo' });           // el cuerpo exacto de la página anterior
  assert.equal(r.status, 403);
  assert.equal(typeof r.cuerpo.error, 'string');
  assert.match(r.cuerpo.error, /más de 7 días/);
});

test('fuera del plazo con el PIN de un supervisor o de gerencia: pasa, una sola vez, y el cupón queda con quien aprobó', async () => {
  const { vender, linea, cupon, stock, nada, aprobadoPor } = await montar();
  const id = await vender(8 * DIA);
  const l = await linea(id);
  const antes = stock();
  const idCupon = crypto.randomUUID();
  const r = await cupon(id, l, { id: idCupon, aprobador: SUP.toUpperCase(), pin: PIN_SUP });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.cupon.importe, 25000);
  assert.equal(stock(), antes + 1);
  assert.equal(aprobadoPor(idCupon), SUP);
  const hecho = nada(id);
  // Reenvío (la caja no vio la respuesta): lo mismo, sin aprobador siquiera, y sin repetir nada.
  const otra = await cupon(id, l, { id: idCupon });
  assert.equal(otra.status, 200);
  assert.equal(otra.cuerpo.duplicada, true);
  assert.deepEqual(nada(id), hecho);
  // Gerencia por PIN, en otra venta.
  const id2 = await vender(40 * DIA);
  const idCupon2 = crypto.randomUUID();
  assert.equal((await cupon(id2, await linea(id2), { id: idCupon2, aprobador: DUENO, pin: PIN_DUENO })).status, 201);
  assert.equal(aprobadoPor(idCupon2), DUENO);
});

test('fuera del plazo con PIN equivocado o de quien no aprueba: se rechaza sin escribir y el intento cuenta en el contador de aprobación', async () => {
  const { vender, linea, cupon, nada, db } = await montar();
  const id = await vender(8 * DIA);
  const l = await linea(id);
  const antes = nada(id);
  assert.equal((await cupon(id, l, { aprobador: SUP, pin: '000000' })).status, 403);
  assert.equal((await cupon(id, l, { aprobador: ANA, pin: PIN_ANA })).status, 404);      // Ana tiene PIN pero no es supervisora
  assert.deepEqual(nada(id), antes);
  const fila = db.prepare('select caja, fallos from intentos_aprobacion where correo = ?').get(SUP) as { caja: string; fallos: number };
  assert.equal(fila.fallos, 1);
  for (let i = 0; i < 4; i++) await cupon(id, l, { aprobador: SUP, pin: '000000' });
  assert.equal((await cupon(id, l, { aprobador: SUP, pin: PIN_SUP })).status, 423);      // 5 fallos: el mismo bloqueo que devolver dinero
  assert.deepEqual(nada(id), antes);
});

test('fuera del plazo, quien ya es supervisor o gerencia en la caja devuelve en cupón directo y queda como quien aprobó', async () => {
  const { como, entrar, vender, linea, cupon, aprobadoPor } = await montar();
  const sup = await entrar(SUP, PIN_SUP);
  const id = await vender(8 * DIA);
  const idCupon = crypto.randomUUID();
  assert.equal((await cupon(id, await linea(id), { id: idCupon }, sup)).status, 201);
  assert.equal(aprobadoPor(idCupon), SUP);
  como(DUENO);
  const id2 = await vender(8 * DIA);
  const idCupon2 = crypto.randomUUID();
  assert.equal((await cupon(id2, await linea(id2), { id: idCupon2 }, {})).status, 201);
  assert.equal(aprobadoPor(idCupon2), DUENO);
});

test('una pieza que no es del ticket se rechaza antes de pedir ni gastar un PIN', async () => {
  const { vender, cupon, db } = await montar();
  const id = await vender(8 * DIA);
  assert.equal((await cupon(id, 999_999, { aprobador: SUP, pin: '000000' })).status, 404);
  assert.equal(db.prepare('select count(*) as n from intentos_aprobacion').get()!.n, 0);
});
