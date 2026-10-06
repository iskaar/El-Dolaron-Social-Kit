// node --test src/impresiones.test.ts: Worker + SQLite real y flujo de caja sin hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados } from '../public/venta.js';

const venta = (extra:Record<string, unknown> = {}) => ({ id:crypto.randomUUID(),
  lineas:[{ producto_id:PRODUCTO, cantidad:1 }], forma_pago:'tarjeta', efectivo:0,
  caja:'Caja 1', imprimir_en:'Caja 1', ...extra });
const pendientes = '/api/impresiones?caja=Caja%201';

test('venta remota queda pendiente con líneas y cifras fiables para imprimirTicket', async () => {
  const t = tienda();
  try {
    const v = venta({ lineas:[{ producto_id:PRODUCTO, cantidad:2, nombre:'alterado', precio:1 }] });
    const r = await t.pedir('/api/ventas', v);
    assert.equal(r.status, 201);
    assert.equal(r.cuerpo.imprimir_en, 'Caja 1');
    const p = (await t.pedir(pendientes)).cuerpo;
    assert.equal(p.length, 1);
    assert.equal(p[0].id, v.id);
    assert.equal(p[0].imprimir_en, 'Caja 1');
    assert.equal(p[0].impreso_en, null);
    assert.equal(p[0].total, 50000);
    assert.equal(p[0].dolarones, 0);
    assert.equal(p[0].forma_pago, 'tarjeta');
    assert.equal(p[0].efectivo, 0);
    assert.equal(p[0].cambio, 0);
    assert.ok(Number.isFinite(Date.parse(p[0].creado_en)));
    assert.equal(p[0].socio, null);
    assert.equal(p[0].vale_emitido, null);
    assert.equal(p[0].vale_usado, null);
    assert.deepEqual(p[0].lineas.map(({ nombre, precio, cantidad }: any) => ({ nombre, precio, cantidad })),
      [{ nombre:'Ventilador', precio:25000, cantidad:2 }]);
  } finally { t.db.close(); }
});

test('efectivo remoto y estaciones inválidas responden 400 sin vender ni descontar stock', async () => {
  const t = tienda();
  try {
    const efectivo = await t.pedir('/api/ventas', venta({ forma_pago:'efectivo', efectivo:25000 }));
    assert.equal(efectivo.status, 400);
    assert.match(efectivo.cuerpo.error, /sólo tarjeta o transferencia/);
    for (const imprimir_en of ['', null, 1, {}, ' Caja 1', 'Caja 1 ', 'Caja  1', 'Caja\n1', '../Caja', 'a'.repeat(31), 'Caja/1', 'Caja 9', 'Estación-Á_2.1']) {
      const r = await t.pedir('/api/ventas', venta({ imprimir_en }));
      assert.equal(r.status, 400, String(imprimir_en));
      assert.equal(r.cuerpo.error, 'Caja invalida.');
    }
    assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 0);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 50);
    assert.equal((await t.pedir('/api/ventas', venta({ imprimir_en:'Caja 3', forma_pago:'transferencia' }))).status, 201);
  } finally { t.db.close(); }
});

test('GET incluye el vale emitido y el saldo del vale usado como la respuesta de venta', async () => {
  const t = tienda();
  try {
    t.env.VALES_ABIERTOS = 'si';
    const emitida = await t.pedir('/api/ventas', venta({ imprimir_en:undefined }));
    const v = venta({ codigo_vale:emitida.cuerpo.vale_emitido.codigo, dolarones:500 });
    const r = await t.pedir('/api/ventas', v);
    assert.equal(r.status, 201);
    const p = (await t.pedir(pendientes)).cuerpo[0];
    assert.equal(p.id, v.id);
    assert.equal(p.dolarones, 500);
    assert.deepEqual(p.vale_emitido, r.cuerpo.vale_emitido);
    assert.deepEqual(p.vale_usado, r.cuerpo.vale_usado);
    assert.equal(p.vale_usado.restante, 500);
    assert.deepEqual((await t.pedir(`/api/ventas/${v.id}?imprimir=1`)).cuerpo, p);
  } finally { t.db.close(); }
});

test('GET incluye número, ganados y saldo disponible de un socio', async () => {
  const t = tienda();
  try {
    const alta = await t.pedir('/api/socios', { id:crypto.randomUUID(), nombre:'Cliente', telefono:'4441112222',
      acepta_bases:true, declara_mayor_edad:true });
    assert.equal(alta.status, 201);
    const r = await t.pedir('/api/ventas', venta({ cliente_id:alta.cuerpo.id }));
    assert.equal(r.status, 201);
    const socio = (await t.pedir(pendientes)).cuerpo[0].socio;
    assert.equal(socio.numero, alta.cuerpo.numero);
    assert.equal(socio.ganados, r.cuerpo.ganados);
    assert.equal(socio.saldo, r.cuerpo.saldo.disponible);
  } finally { t.db.close(); }
});

test('dos tomas concurrentes dan 200 y 409; la venta impresa deja de aparecer', async () => {
  const t = tienda();
  try {
    const v = venta();
    await t.pedir('/api/ventas', v);
    const ruta = `/api/impresiones/${v.id}/tomar`;
    assert.equal((await t.pedir(ruta, { caja:'Caja 2' })).status, 409);
    const tomas = await Promise.all([t.pedir(ruta, { caja:'Caja 1' }), t.pedir(ruta, { caja:'Caja 1' })]);
    assert.deepEqual(tomas.map((r) => r.status).sort(), [200, 409]);
    assert.ok(Number.isFinite(Date.parse(tomas.find((r) => r.status === 200)!.cuerpo.impreso_en)));
    assert.equal((await t.pedir(ruta, { caja:'Caja 1' })).status, 409);
    assert.deepEqual((await t.pedir(pendientes)).cuerpo, []);
  } finally { t.db.close(); }
});

test('no aparecen canceladas, tomadas, locales, de otra estación ni aceptadas hace más de 3 h', async () => {
  const t = tienda();
  try {
    const cancelada = venta(), impresa = venta(), vieja = venta(), vigente = venta();
    for (const v of [cancelada, impresa, vieja, vigente, venta({ imprimir_en:'Caja 2' }), venta({ imprimir_en:undefined })]) {
      assert.equal((await t.pedir('/api/ventas', v)).status, 201);
    }
    assert.equal((await t.pedir(`/api/ventas/${cancelada.id}/cancelar`, { motivo:'prueba', caja:'Caja 1' })).status, 200);
    assert.equal((await t.pedir(`/api/impresiones/${cancelada.id}/tomar`, { caja:'Caja 1' })).status, 409);
    await t.pedir(`/api/impresiones/${impresa.id}/tomar`, { caja:'Caja 1' });
    const ahora = Date.now();
    t.db.prepare('update ventas set registrado_en=? where id=?').run(new Date(ahora - 3 * 3600_000 - 60_000).toISOString(), vieja.id);
    t.db.prepare('update ventas set registrado_en=? where id=?').run(new Date(ahora - 3 * 3600_000 + 60_000).toISOString(), vigente.id);
    assert.deepEqual((await t.pedir(pendientes)).cuerpo.map((p: any) => p.id), [vigente.id]);
  } finally { t.db.close(); }
});

test('listado devuelve hasta 10 pendientes, los más viejos primero', async () => {
  const t = tienda();
  try {
    const ventas = Array.from({ length:12 }, () => venta());
    const ahora = Date.now();
    for (const [i, v] of ventas.entries()) {
      assert.equal((await t.pedir('/api/ventas', v)).status, 201);
      t.db.prepare('update ventas set registrado_en=? where id=?').run(new Date(ahora - (i + 1) * 60_000).toISOString(), v.id);
    }
    const ordenadas = ventas.map((v) => v.id).reverse();
    const p = (await t.pedir(pendientes)).cuerpo;
    assert.deepEqual(p.map((v: any) => v.id), ordenadas.slice(0, 10));
    for (const v of p) {
      assert.equal((await t.pedir(`/api/impresiones/${v.id}/tomar`, { caja:'Caja 1' })).status, 200);
    }
    assert.deepEqual((await t.pedir(pendientes)).cuerpo.map((v: any) => v.id), ordenadas.slice(10));
  } finally { t.db.close(); }
});

test('una venta sin red entra al sincronizar aunque su fecha de cobro sea antigua', async () => {
  const t = tienda();
  try {
    const v = venta({ creado_en:new Date(Date.now() - 48 * 3600_000).toISOString() });
    assert.equal((await t.pedir('/api/ventas', v)).status, 201);
    assert.equal((await t.pedir(pendientes)).cuerpo[0].creado_en, v.creado_en);
  } finally { t.db.close(); }
});

test('imprimir_en no altera pedido_hash: el primer destino persiste al reintentar', async () => {
  const t = tienda();
  try {
    const v = venta();
    await t.pedir('/api/ventas', v);
    const hash = t.db.prepare('select pedido_hash from ventas where id=?').get(v.id)!.pedido_hash;
    const r = await t.pedir('/api/ventas', { ...v, imprimir_en:'Caja 2' });
    assert.equal(r.status, 200);
    assert.equal(r.cuerpo.duplicada, true);
    assert.equal(r.cuerpo.imprimir_en, 'Caja 1');
    assert.equal(t.db.prepare('select pedido_hash from ventas where id=?').get(v.id)!.pedido_hash, hash);
    assert.equal((await t.pedir('/api/ventas', { ...v, forma_pago:'transferencia' })).status, 409);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 49);
  } finally { t.db.close(); }
});

test('mismos permisos que cobrar y caja asignada prevalece para consultar y tomar', async () => {
  const t = tienda();
  try {
    const v = venta();
    await t.pedir('/api/ventas', v);
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en)
      values ('cajero@prueba.mx', 'Cajero', 'cajero', 1, 'Caja 1', '', '')`).run();
    t.env.DEV_USUARIO = 'cajero@prueba.mx';
    assert.equal((await t.pedir('/api/impresiones?caja=Caja%202')).cuerpo[0].id, v.id);
    assert.equal((await t.pedir(`/api/impresiones/${v.id}/tomar`, { caja:'Caja 2' })).status, 200);
    for (const roles of ['capturista', 'computadora']) {
      t.db.prepare('update usuarios set roles=? where correo=?').run(roles, t.env.DEV_USUARIO);
      const status = roles === 'computadora' ? 401 : 403;
      assert.equal((await t.pedir(pendientes)).status, status);
      assert.equal((await t.pedir(`/api/impresiones/${v.id}/tomar`, { caja:'Caja 1' })).status, status);
    }
    t.env.DEV_USUARIO = DUENO;
    for (const caja of ['', 'a'.repeat(31), 'Caja/1', 'Caja 9']) {
      assert.equal((await t.pedir('/api/impresiones?caja=' + encodeURIComponent(caja))).status, 400);
      assert.equal((await t.pedir(`/api/impresiones/${v.id}/tomar`, { caja })).status, 400);
    }
    assert.equal((await t.pedir('/api/impresiones/no-id/tomar', { caja:'Caja 1' })).status, 400);
    assert.equal((await t.pedir(`/api/impresiones/${v.id}/tomar`, null)).status, 400);
  } finally { t.db.close(); }
});

const fuente = readFileSync('public/caja.html', 'utf8');
const cobro = fuente.slice(fuente.indexOf('async function cobrar()'), fuente.indexOf('let sincronizando = false;'));

test('modo remoto sólo sin impresora: deshabilita efectivo y cajón, recuerda destino con storage restringido', () => {
  let conectada = false;
  const elementos = new Map<string, any>();
  const $ = (id: string) => {
    if (!elementos.has(id)) elementos.set(id, { value:id === 'forma' ? 'efectivo' : '', checked:false,
      options:[], add() {}, addEventListener() {}, querySelector:() => $('opcion-efectivo') });
    return elementos.get(id);
  };
  $('caja-nombre').options = ['', 'Caja 1', 'Caja 2', 'Caja 3'].map((value) => ({ value, cloneNode:() => ({ value }) }));
  const bloque = fuente.slice(fuente.indexOf('const impresionRemota ='), fuente.indexOf('function exigirCaja()'));
  const modos = runInNewContext(`${bloque}; ({ pintarImpresionRemota, impresionRemota })`, {
    $, cobrando:false, pintar() {}, impresoraLista:() => conectada,
    localStorage:{ getItem() { throw new Error('sin memoria'); } },
  });
  assert.equal($('imprimir-en').value, 'Caja 1');
  assert.equal(modos.impresionRemota(), false);
  $('modo-remoto').checked = true;
  modos.pintarImpresionRemota();
  assert.equal(modos.impresionRemota(), true);
  assert.equal($('forma').value, 'tarjeta');
  assert.equal($('opcion-efectivo').disabled, true);
  assert.equal($('efectivo').disabled, true);
  assert.equal($('abrir-cajon').disabled, true);
  assert.equal($('destino-impresion').hidden, false);
  conectada = true;
  modos.pintarImpresionRemota();
  assert.equal(modos.impresionRemota(), false);
  assert.equal($('opcion-impresion-remota').hidden, true);
  assert.equal($('opcion-efectivo').disabled, false);
});

test('celular sin red guarda imprimir_en; no imprime localmente ni abre el cajón', async () => {
  const guardadas: any[] = [];
  const elementos = new Map<string, any>();
  const $ = (id: string) => {
    if (!elementos.has(id)) elementos.set(id, { value:id === 'forma' ? 'tarjeta' : id === 'imprimir-en' ? 'Caja 2' : '',
      textContent:'', style:{}, focus() {} });
    return elementos.get(id);
  };
  const cobrar = runInNewContext(`let idVenta = null, creadoEnVenta = null, cobrando = false;
    ${cobro}; cobrar`, {
    crypto, Date, $, AbortSignal, Object,
    lineas:[{ producto_id:PRODUCTO, codigo:'ED-000001', nombre:'Ventilador', precio:25000, cantidad:1 }],
    socio:null, catalogo:new Map(),
    impresionRemota:() => true, exigirCaja:() => true, cajaActual:() => 'Caja 1', dolaronesPedidos:() => 0,
    totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados,
    descuento:null, descuentoAplicado:() => 0, pintarDescuento() {},
    pesos:String, dolares:String, pintar() {}, quitarSocio() {}, sincronizar() {},
    fetch:async () => { throw new Error('sin red'); },
    store:async (almacen: string, _modo: string, fn: any) => fn({ put(v: any) { if (almacen === 'ventas') guardadas.push(v); } }),
    abrirCajon() { assert.fail('No se debe abrir el cajón'); },
    imprimirTicket() { assert.fail('No se debe imprimir en el celular'); },
  });
  await cobrar();
  assert.equal(guardadas.length, 1);
  assert.equal(guardadas[0].imprimir_en, 'Caja 2');
  assert.equal(guardadas[0].caja, 'Caja 1');
  assert.equal(guardadas[0].forma_pago, 'tarjeta');
  assert.equal(guardadas[0].efectivo, 0);
  assert.match($('aviso').textContent, /Ticket enviado a Caja 2.*se enviará al sincronizar/);
});

test('sincronizar reenvía el destino remoto y elimina la venta sólo después de aceptarla', async () => {
  const t = tienda();
  try {
    const v = venta({ vale_pendiente:true });
    const cola = new Map([[v.id, v]]);
    let enviada: any;
    const texto = fuente.slice(fuente.indexOf('let sincronizando = false;'), fuente.indexOf('async function pendientes()'));
    const sincronizar = runInNewContext(`${texto}; sincronizar`, {
      store:async (almacen: string, _modo: string, fn: any) => fn({
        getAll:() => almacen === 'ventas' ? [...cola.values()] : [],
        delete(id: string) { assert.equal(enviada.imprimir_en, 'Caja 1'); cola.delete(id); },
        put() { assert.fail('No ofrecer una segunda impresión de vale remoto'); },
      }),
      fetch:async (ruta: string, opciones: any) => {
        enviada = JSON.parse(opciones.body);
        const r = await t.pedir(ruta, enviada);
        return { status:r.status, json:async () => r.cuerpo };
      },
      $:() => ({ textContent:'' }), dolares:String,
      pintarResultadosVales() {}, pendientes() {}, pintarRechazadas() {}, actualizarCorte() {},
    });
    await sincronizar();
    assert.equal(cola.size, 0);
    assert.equal((await t.pedir(pendientes)).cuerpo[0].id, v.id);
  } finally { t.db.close(); }
});

function consumidor() {
  const estado = { visible:'visible', conectada:true, caja:'Caja 1', fallar:false, perderToma:false, impresas:[] as string[], llamadas:[] as string[], aviso:'' };
  const bloque = fuente.slice(fuente.indexOf('let imprimiendoRemotas = false;'), fuente.indexOf('function pintarImpresora()'));
  const imprimir = runInNewContext(`${bloque}; imprimirPendientes`, {
    document:{ get visibilityState() { return estado.visible; }, addEventListener() {} },
    impresoraLista:() => estado.conectada, cajaActual:() => estado.caja,
    setInterval(_fn: any, ms: number) { assert.equal(ms, 4000); }, AbortSignal, encodeURIComponent,
    $:() => ({ dataset:{}, addEventListener() {}, set textContent(v: string) { estado.aviso = v; } }),
    errorImpresora:() => 'USB falló', pintarImpresora() {},
    fetch:async (ruta: string) => {
      estado.llamadas.push(ruta);
      if (estado.perderToma && ruta.includes('/folio-1/tomar')) throw new Error('respuesta perdida');
      return ruta.startsWith('/api/impresiones?')
        ? { ok:true, json:async () => [{ id:'tomada-por-otra', lineas:[] }, { id:'folio-1', lineas:[] }] }
        : { status:ruta.includes('tomada-por-otra') ? 409 : 200, ok:!ruta.includes('tomada-por-otra') };
    },
    imprimirTicket:async (venta: any) => { estado.impresas.push(venta.id); return !estado.fallar; },
  });
  return { estado, imprimir };
}

test('consumidor consulta sólo visible, conectado y con estación; imprime sólo si tomó con 200', async () => {
  const { estado, imprimir } = consumidor();
  estado.visible = 'hidden'; await imprimir();
  estado.visible = 'visible'; estado.conectada = false; await imprimir();
  estado.conectada = true; estado.caja = ''; await imprimir();
  assert.equal(estado.llamadas.length, 0);
  estado.caja = 'Caja 1';
  await Promise.all([imprimir(), imprimir()]);
  assert.equal(estado.llamadas.length, 3);
  assert.deepEqual(estado.impresas, ['folio-1']);
});

test('USB falla tras tomar: se muestra folio y recuperación en Ventas de hoy', async () => {
  const { estado, imprimir } = consumidor();
  estado.fallar = true;
  await imprimir();
  assert.match(estado.aviso, /folio-1.*USB falló.*Ventas de hoy/);
  assert.deepEqual(estado.impresas, ['folio-1']);
});

test('respuesta de toma perdida: se muestra folio para recuperar sin imprimir a ciegas', async () => {
  const { estado, imprimir } = consumidor();
  estado.perderToma = true;
  await imprimir();
  assert.match(estado.aviso, /folio-1.*respuesta perdida.*Ventas de hoy/);
  assert.deepEqual(estado.impresas, []);
});
