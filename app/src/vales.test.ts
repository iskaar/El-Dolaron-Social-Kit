// node --test src/vales.test.ts: Worker + SQLite real, todas las migraciones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';

const venta = (extra:Record<string, unknown> = {}) => ({ id:crypto.randomUUID(),
  lineas:[{ producto_id:PRODUCTO, cantidad:1 }], forma_pago:'efectivo', efectivo:25000, caja:'Caja 1', ...extra });
function abrir() {
  const t = tienda();
  t.env.VALES_ABIERTOS = 'si';
  const emitir = async () => {
    const v = venta();
    const r = await t.pedir('/api/ventas', v);
    assert.equal(r.status, 201);
    return { v, vale:r.cuerpo.vale_emitido };
  };
  const liberar = (id:string) => t.db.prepare("update vales_dolarones set disponible_desde='2000-01-01T00:00:00.000Z' where id=?").run(id);
  const canjear = (codigo:string, usados=1000, extra:Record<string, unknown> = {}) =>
    t.pedir('/api/ventas', venta({ codigo_vale:codigo, dolarones:usados, efectivo:25000-usados, ...extra }));
  const cancelar = (id:string) => t.pedir(`/api/ventas/${id}/cancelar`, { motivo:'prueba', caja:'Caja 1' });
  return { ...t, emitir, liberar, canjear, cancelar };
}

test('vale anónimo al 5%, 30 días exactos, sin socio, cerrado por defecto y sin bases', async () => {
  const t = abrir();
  try {
    delete t.env.VALES_ABIERTOS;
    assert.equal((await t.pedir('/api/ventas', venta())).cuerpo.vale_emitido, null);
    t.env.VALES_ABIERTOS = 'si';
    t.env.PORTAL_BASES_TEXTO = '';
    assert.equal((await t.pedir('/api/ventas', venta())).cuerpo.vale_emitido, null);
    t.env.PORTAL_BASES_TEXTO = 'Bases sintéticas.';
    const { v, vale } = await t.emitir();
    assert.match(vale.codigo, /^DP-[A-Za-z0-9_-]{16}$/);
    assert.equal(vale.importe, 1000); // $250: dos bloques, 5 D c/u
    const row = t.db.prepare('select * from vales_dolarones where id=?').get(vale.id)!;
    assert.equal(Date.parse(String(row.vence_en)) - Date.parse(String(row.creado_en)), 30 * 86400000);
    assert.equal(t.db.prepare('select count(*) as n from clientes').get()!.n, 0);
    assert.equal(t.db.prepare('select count(*) as n from dolarones_lotes').get()!.n, 0);
    assert.equal((await t.pedir('/api/vales/buscar', { codigo:vale.codigo })).status, 403, 'aún no disponible');
    const reintento = await t.pedir('/api/ventas', v);
    assert.equal(reintento.cuerpo.vale_emitido.codigo, vale.codigo);
    assert.equal(t.db.prepare('select count(*) as n from vales_dolarones').get()!.n, 1);
    assert.deepEqual((await t.pedir(`/api/ventas/${v.id}/vale`, {})).cuerpo, vale);
  } finally { t.db.close(); }
});

test('vale de venta en cola usa hora del servidor al sincronizar, no la hora del dispositivo', async () => {
  const t = abrir();
  try {
    t.env.PROMOCION_INICIO = new Date(Date.now() + 60_000).toISOString();
    const antes = await t.pedir('/api/ventas', venta({ creado_en:'2026-10-02T18:00:00.000Z' }));
    assert.equal(antes.status, 201);
    assert.equal(antes.cuerpo.vale_emitido, null);
    assert.equal((await t.pedir('/api/vales/config', undefined, 'GET')).cuerpo.habilitado, false);
    t.env.PROMOCION_INICIO = new Date(Date.now() - 60_000).toISOString();
    const despues = await t.pedir('/api/ventas', venta({ creado_en:'2026-09-01T18:00:00.000Z' }));
    assert.equal(despues.status, 201);
    assert.equal(despues.cuerpo.vale_emitido.importe, 1000);
    assert.equal((await t.pedir('/api/vales/config', undefined, 'GET')).cuerpo.habilitado, true);
  } finally { t.db.close(); }
});

test('socios conservan 10%, teléfono sólo acumula y no emite vale en paralelo', async () => {
  const t = abrir();
  try {
    const socio = (await t.pedir('/api/socios', { id:crypto.randomUUID(), nombre:'Cliente',
      telefono:'4441234567', acepta_bases:true, declara_mayor_edad:true })).cuerpo;
    const r = await t.pedir('/api/ventas', venta({ cliente_id:socio.id }));
    assert.equal(r.cuerpo.ganados, 2000);
    assert.equal(r.cuerpo.vale_emitido, null);
    assert.equal(t.db.prepare('select count(*) as n from vales_dolarones').get()!.n, 0);
    t.db.prepare("update dolarones_lotes set disponible_desde='2000-01-01T00:00:00Z'").run();
    const encontrado = (await t.pedir('/api/socios?q=4441234567')).cuerpo;
    assert.equal(encontrado.disponible, 2000);
    assert.equal((await t.pedir('/api/ventas', venta({ cliente_id:encontrado.id, dolarones:1000 }))).status, 403);
    const { vale } = await t.emitir(); t.liberar(vale.id);
    assert.equal((await t.canjear(vale.codigo, 500, { cliente_id:socio.id })).status, 400);
  } finally { t.db.close(); }
});

test('canje parcial y copia comparten saldo; ticket pagado con D no genera otros D', async () => {
  const t = abrir();
  try {
    const { v, vale } = await t.emitir(); t.liberar(vale.id);
    t.db.prepare('update productos set precio=10000 where id=?').run(PRODUCTO);
    const id = crypto.randomUUID();
    const r = await t.canjear(vale.codigo, 500, { id, efectivo:9500 });
    assert.equal(r.status, 201);
    assert.equal(r.cuerpo.vale_usado.restante, 500);
    assert.equal(r.cuerpo.vale_emitido, null, '$95 monetarios no llegan al bloque');
    const copia = await t.pedir(`/api/ventas/${v.id}/vale`, {});
    assert.equal(copia.cuerpo.codigo, vale.codigo);
    assert.equal(copia.cuerpo.restante, 500);
    assert.equal(copia.cuerpo.vence_en, vale.vence_en);
    const mismo = await t.canjear(vale.codigo, 500, { id, efectivo:9500 });
    assert.equal(mismo.status, 200);
    assert.equal(mismo.cuerpo.vale_usado.restante, 500);
    assert.equal((await t.canjear(vale.codigo, 501, { efectivo:9500 })).status, 409);
    assert.equal((await t.canjear(vale.codigo, 500, { efectivo:9500 })).status, 201);
    assert.equal((await t.pedir('/api/vales/buscar', { codigo:vale.codigo })).status, 403);
    assert.equal((await t.pedir(`/api/ventas/${v.id}/vale`, {})).status, 404);
  } finally { t.db.close(); }
});

test('dos cajas leen el vale antes de gastar: el segundo batch revierte venta, stock y emisión', async () => {
  const t = abrir();
  try {
    const { vale } = await t.emitir(); t.liberar(vale.id);
    const batch = t.env.DB.batch.bind(t.env.DB);
    let inyectar = true;
    t.env.DB.batch = async (sentencias) => {
      if (inyectar) {
        inyectar = false;
        assert.equal((await t.canjear(vale.codigo, 800, { caja:'Caja 2' })).status, 201);
      }
      return batch(sentencias);
    };
    const r = await t.canjear(vale.codigo, 800);
    assert.equal(r.status, 409);
    assert.equal(t.db.prepare('select restante from vales_dolarones where id=?').get(vale.id)!.restante, 200);
    assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 2);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 48);
    assert.equal(t.db.prepare('select count(*) as n from vales_dolarones').get()!.n, 2);
  } finally { t.db.close(); }
});

test('caducar en vuelo o fallar stock revierte canje y emisión; valores inválidos no tocan nada', async () => {
  const t = abrir();
  try {
    const { vale } = await t.emitir(); t.liberar(vale.id);
    for (const usados of [-1, 1.1, 25001]) assert.equal((await t.canjear(vale.codigo, usados)).status, 400);
    assert.equal((await t.canjear('DP-inventado')).status, 400);
    t.db.prepare('update productos set stock=0 where id=?').run(PRODUCTO);
    assert.equal((await t.canjear(vale.codigo, 500)).status, 409);
    assert.equal(t.db.prepare('select restante from vales_dolarones where id=?').get(vale.id)!.restante, 1000);
    t.db.prepare('update productos set stock=49 where id=?').run(PRODUCTO);
    const batch = t.env.DB.batch.bind(t.env.DB);
    t.env.DB.batch = async (sentencias) => {
      t.db.prepare("update vales_dolarones set vence_en='2000-01-01T00:00:00.000Z' where id=?").run(vale.id);
      return batch(sentencias);
    };
    assert.equal((await t.canjear(vale.codigo, 500)).status, 409);
    assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 1);
    assert.equal(t.db.prepare('select count(*) as n from vales_dolarones').get()!.n, 1);
    assert.equal((await t.pedir('/api/vales/buscar', { codigo:vale.codigo })).status, 403);
  } finally { t.db.close(); }
});

test('cancelación revierte canje sin ampliar vida, retira emisión y no devuelve dos veces', async () => {
  const t = abrir();
  try {
    const { v, vale } = await t.emitir(); t.liberar(vale.id);
    const canje = await t.canjear(vale.codigo, 500);
    assert.equal(canje.status, 201);
    assert.equal((await t.cancelar(v.id)).status, 409, 'emisor con saldo gastado requiere resolución');
    assert.equal(t.db.prepare('select cancelada from ventas where id=?').get(v.id)!.cancelada, 0);
    assert.equal((await t.cancelar(canje.cuerpo.id)).status, 200);
    assert.equal((await t.cancelar(canje.cuerpo.id)).status, 200);
    const original = t.db.prepare('select * from vales_dolarones where id=?').get(vale.id)!;
    assert.equal(original.restante, 1000);
    assert.equal(original.vence_en, vale.vence_en);
    assert.equal(t.db.prepare('select restante from vales_dolarones where id=?').get(canje.cuerpo.vale_emitido.id)!.restante, 0);
    assert.equal((await t.cancelar(v.id)).status, 200);
    assert.equal((await t.pedir(`/api/ventas/${v.id}/vale`, {})).status, 404);
    assert.equal((await t.canjear(vale.codigo, 500)).status, 409);
  } finally { t.db.close(); }
});

test('cancelar el emisor mientras otro cajero tiene el vale leído aborta el canje completo', async () => {
  const t = abrir();
  try {
    const { v, vale } = await t.emitir(); t.liberar(vale.id);
    const batch = t.env.DB.batch.bind(t.env.DB);
    let inyectar = true;
    t.env.DB.batch = async (sentencias) => {
      if (inyectar) { inyectar = false; assert.equal((await t.cancelar(v.id)).status, 200); }
      return batch(sentencias);
    };
    assert.equal((await t.canjear(vale.codigo, 500)).status, 409);
    assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 1);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 50);
  } finally { t.db.close(); }
});

test('vale no expone saldo/código al portal público ni a capturistas; al cerrar emisión respeta vales previos', async () => {
  const t = abrir();
  try {
    const { v, vale } = await t.emitir(); t.liberar(vale.id);
    t.env.VALES_ABIERTOS = 'no';
    assert.equal((await t.canjear(vale.codigo, 500)).status, 201);
    assert.equal(t.db.prepare('select count(*) as n from vales_dolarones').get()!.n, 1);
    t.db.prepare("update usuarios set roles='capturista' where correo=?").run(DUENO);
    assert.equal((await t.pedir('/api/vales/buscar', { codigo:vale.codigo })).status, 403);
    assert.equal((await t.pedir(`/api/ventas/${v.id}/vale`, {})).status, 403);
    t.env.HOST_PORTAL = 'caja.prueba';
    assert.equal((await t.pedir('/api/vales/buscar', { codigo:vale.codigo })).status, 404);
    assert.equal((await t.pedir(`/api/ventas/${v.id}/vale`, {})).status, 404);
  } finally { t.db.close(); }
});
