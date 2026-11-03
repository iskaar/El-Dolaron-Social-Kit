// node --test src/bandas.test.ts
// Los nueve montos de banda (Issue #168): lo que dan las migraciones y lo que crea una familia nueva.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';

const MONTOS = [19, 29, 39, 49, 69, 79, 99, 119, 129, 149, 199];

test('/api/familias ofrece los once montos y cada familia sembrada tiene sus once productos', async () => {
  const { db, pedir } = tienda();
  const { montos, familias } = (await pedir('/api/familias')).cuerpo;
  assert.deepEqual(montos, MONTOS);
  assert.equal(familias.length, 18);

  for (const f of familias as { nombre: string; prefijo: string }[]) {
    for (const monto of MONTOS) {
      const p = db.prepare('select nombre, precio, destino, stock, sin_inventario from productos where codigo = ?')
        .get(`${f.prefijo.toUpperCase()}${monto}`) as Record<string, unknown> | undefined;
      assert.ok(p, `falta ${f.prefijo.toUpperCase()}${monto}`);
      assert.equal(p.precio, monto * 100);
      assert.equal(p.destino, `banda_${f.prefijo}${monto}`);
      assert.equal(p.sin_inventario, 1);
      assert.equal(p.stock, 0);
    }
  }
  assert.equal((db.prepare(`select count(*) as n from productos where destino like 'banda_%'`).get() as { n: number }).n, 18 * 11);
});

test('la migracion 024 es repetible: correrla otra vez no duplica nada', async () => {
  const { db } = tienda();
  const antes = (db.prepare('select count(*) as n from productos').get() as { n: number }).n;
  const sql = (await import('node:fs')).readFileSync('migracion-024-bandas-119-129.sql', 'utf8');
  db.exec(sql);
  assert.equal((db.prepare('select count(*) as n from productos').get() as { n: number }).n, antes);
  assert.equal((db.prepare(`select valor from config where clave = 'banda_119'`).get() as { valor: string }).valor, '11900');
});

test('una familia nueva nace con los nueve montos, y el precio de la configuracion manda', async () => {
  const { db, pedir } = tienda();
  db.prepare(`update config set valor = '12500' where clave = 'banda_129'`).run();
  const r = await pedir('/api/familias', { nombre: 'Termos' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const filas = db.prepare(`select codigo, precio from productos where destino like ? order by precio`)
    .all(`banda_${r.cuerpo.prefijo}%`) as { codigo: string; precio: number }[];
  assert.equal(filas.length, 11);
  assert.ok(filas.some((f) => f.codigo === `${r.cuerpo.prefijo.toUpperCase()}119`));
  assert.equal(filas.find((f) => f.codigo.endsWith('129'))?.precio, 12500);
});

// Familias de FEP (#694): cada propietario tiene las suyas y sus bandas se venden a su nombre.
import { DUENO, PRODUCTO } from './prueba-d1.ts';
const CAPTURISTA = 'cap@prueba.mx', CAJERO = 'caja@prueba.mx', FEP = 'fep@prueba.mx';
function conFamiliaFep() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, editar_inventario, creado_en, actualizado_en) values
    (?, 'Cap', 'capturista', 1, 0, '', ''), (?, 'Caja', 'cajero', 1, 0, '', ''), (?, 'FEP', 'finanzas', 1, 1, '', '')`).run(CAPTURISTA, CAJERO, FEP);
  const como = (correo: string) => { t.env.DEV_USUARIO = correo; };
  return { ...t, como };
}

test('finanzas crea una familia: ella y sus once productos nacen de FEP; las sembradas siguen de la tienda', async () => {
  const { db, pedir, como } = conFamiliaFep();
  como(FEP);
  const r = await pedir('/api/familias', { nombre: 'Termos FEP' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal((db.prepare('select propietario from familias where prefijo = ?').get(r.cuerpo.prefijo) as { propietario: string }).propietario, 'fep');
  const filas = db.prepare(`select propietario from productos where destino like ?`).all(`banda_${r.cuerpo.prefijo}%`) as { propietario: string }[];
  assert.equal(filas.length, 11);
  assert.ok(filas.every((f) => f.propietario === 'fep'));
  assert.equal((db.prepare(`select count(*) n from familias where propietario = 'dolaron'`).get() as { n: number }).n, 18);
  // Clave y prefijo son globales: la tienda no repite el nombre de FEP ni le toma el prefijo.
  como(DUENO);
  assert.equal((await pedir('/api/familias', { nombre: 'Termos FEP' })).status, 409);
  const otra = await pedir('/api/familias', { nombre: 'Termos Tienda' });
  assert.equal(otra.status, 201);
  assert.notEqual(otra.cuerpo.prefijo, r.cuerpo.prefijo);
});

test('cada quien lista las familias de su propietario; ?todas=1 las junta salvo para FEP; solo dueño y finanzas crean', async () => {
  const { pedir, como } = conFamiliaFep();
  como(FEP);
  const fep = (await pedir('/api/familias', { nombre: 'Termos FEP' })).cuerpo;

  const ver = async (correo: string, ruta = '/api/familias') => {
    como(correo);
    const r = await pedir(ruta);
    assert.equal(r.status, 200, `${correo} ${ruta}`);
    return r.cuerpo.familias as { prefijo: string; propietario: string }[];
  };
  const propios = await ver(FEP);
  assert.deepEqual(propios.map((f) => f.prefijo), [fep.prefijo]);
  assert.equal(propios[0].propietario, 'fep');
  for (const quien of [DUENO, CAPTURISTA, CAJERO]) {
    const f = await ver(quien);
    assert.equal(f.length, 18, quien);
    assert.ok(f.every((x) => x.propietario === 'dolaron') && !f.some((x) => x.prefijo === fep.prefijo), quien);
  }
  const todas = await ver(CAJERO, '/api/familias?todas=1');
  assert.equal(todas.length, 19);
  assert.equal(todas.filter((x) => x.propietario === 'fep').length, 1);
  assert.deepEqual((await ver(FEP, '/api/familias?todas=1')).map((f) => f.prefijo), [fep.prefijo], 'FEP no ve las de la tienda');

  // Crear: capturista y cajero siguen sin poder.
  for (const quien of [CAPTURISTA, CAJERO]) {
    como(quien);
    assert.equal((await pedir('/api/familias', { nombre: 'Intruso' })).status, 403, quien);
  }
});

test('una pieza solo puede ir a una banda de una familia de su propietario', async () => {
  const { db, pedir, como } = conFamiliaFep();
  como(FEP);
  const fep = (await pedir('/api/familias', { nombre: 'Termos FEP' })).cuerpo;
  const FEP_ID = 'b2222222-2222-4222-8222-222222222222';
  db.prepare(`insert into productos (id, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en, propietario)
              values (?, 'Bolsa FEP', 30000, 2, 'S41', '', '', 'fep')`).run(FEP_ID);
  const destino = (id: string) => (db.prepare('select destino from productos where id = ?').get(id) as { destino: string }).destino;

  const aBandaTienda = await pedir(`/api/borradores/${FEP_ID}`, { destino: 'banda_r49' }, 'PATCH');
  assert.equal(aBandaTienda.status, 400, JSON.stringify(aBandaTienda.cuerpo));
  assert.equal(destino(FEP_ID), 'etiqueta');
  const aBandaPropia = await pedir(`/api/borradores/${FEP_ID}`, { destino: `banda_${fep.prefijo}49` }, 'PATCH');
  assert.equal(aBandaPropia.status, 200, JSON.stringify(aBandaPropia.cuerpo));
  assert.equal(destino(FEP_ID), `banda_${fep.prefijo}49`);

  como(DUENO);
  const aBandaFep = await pedir(`/api/borradores/${PRODUCTO}`, { destino: `banda_${fep.prefijo}49` }, 'PATCH');
  assert.equal(aBandaFep.status, 400, JSON.stringify(aBandaFep.cuerpo));
  assert.equal(destino(PRODUCTO), 'etiqueta');
  assert.equal((await pedir(`/api/borradores/${PRODUCTO}`, { destino: 'banda_r49' }, 'PATCH')).status, 200);
});

test('vender el código de una banda de FEP registra la línea como de FEP; la de la tienda, como de la tienda', async () => {
  const { db, pedir, como } = conFamiliaFep();
  como(FEP);
  const fep = (await pedir('/api/familias', { nombre: 'Termos FEP' })).cuerpo;
  como(CAJERO);
  const id = (codigo: string) => (db.prepare('select id from productos where codigo = ?').get(codigo) as { id: string }).id;
  const venta = { id: crypto.randomUUID(), caja: 'Caja 1', forma_pago: 'efectivo', efectivo: 10000,
    lineas: [{ producto_id: id(`${fep.prefijo.toUpperCase()}49`), cantidad: 1 }, { producto_id: id('R49'), cantidad: 1 }] };
  const r = await pedir('/api/ventas', venta);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const lineas = db.prepare('select codigo, propietario from venta_lineas order by codigo').all() as { codigo: string; propietario: string }[];
  assert.equal(lineas.find((l) => l.codigo === `${fep.prefijo.toUpperCase()}49`)?.propietario, 'fep');
  assert.equal(lineas.find((l) => l.codigo === 'R49')?.propietario, 'dolaron');
});
