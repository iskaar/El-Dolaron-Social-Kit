// node --test src/cep.test.ts
// Verificacion de transferencias con el CEP de Banxico (#603): la PC de la caja consulta y reporta; el Worker decide,
// avisa al dueno y deja que el valide a mano. SQLite real con todas las migraciones. Claves, bancos y cuentas sinteticos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tienda, PRODUCTO, DUENO, datosTransferencia } from './prueba-d1.ts';
import { verificarJwt, verificarJwtServicio, permiso, puede } from './cuentas.ts';
import { bancoDe } from '../public/venta.js';

const SERVICIO = 'servicio-pc-prueba.access';
const BBVA = '40012';

type Tienda = ReturnType<typeof tienda>;

function conServicio() {
  const t = tienda();
  t.env.CEP_CLIENT_ID = SERVICIO;
  t.env.DEV_SERVICIO = SERVICIO;
  const correos: any[] = [];
  t.env.CORREO = { async send(m: any) { correos.push(m); return { messageId: 'x' }; } } as never;
  // Con DEV_USUARIO = dueno, una persona tambien existe: /api/cep/* debe ignorarla.
  const comoServicio = (id: string | undefined) => { t.env.DEV_SERVICIO = id; };
  return { ...t, correos, comoServicio };
}

/** Una venta por transferencia de $500 (2 piezas de $250) con banco; devuelve el id de la fila de transferencias_spei. */
async function transferencia(t: Tienda, extra: Record<string, unknown> = { banco_emisor: BBVA }, registradoEn?: string): Promise<number> {
  const r = await t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], forma_pago: 'transferencia',
    caja: 'Caja 1', promo: 0, ...datosTransferencia(50000), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const fila = t.db.prepare('select id from transferencias_spei order by id desc limit 1').get() as { id: number };
  // Banxico tarda en tener el CEP: por omision la transferencia ya tiene mas de 10 minutos.
  t.db.prepare('update transferencias_spei set registrado_en = ? where id = ?').run(registradoEn ?? new Date(Date.now() - 20 * 60_000).toISOString(), fila.id);
  return fila.id;
}
const fila = (db: DatabaseSync, id: number) => db.prepare('select * from transferencias_spei where id = ?').get(id) as Record<string, any>;
const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const reportar = (t: Tienda, cuerpo: Record<string, unknown>) => t.pedir('/api/cep/resultado', cuerpo);

test('la migracion 062 deja las columnas y una transferencia nueva nace pendiente, con su banco', async () => {
  const t = conServicio();
  const id = await transferencia(t);
  const f = fila(t.db, id);
  assert.deepEqual([f.cep_estado, f.cep_intentos, f.cep_ultimo_intento, f.banco_emisor, f.verificacion], ['pendiente', 0, null, BBVA, 'cajero']);
  // El CHECK del banco: 5 digitos o null.
  assert.throws(() => t.db.prepare("update transferencias_spei set banco_emisor = 'BBVA' where id = ?").run(id));
});

test('el banco que captura el cajero: opcional, «otro» no se verifica, uno fuera de la lista se rechaza y no frena el cobro', async () => {
  assert.equal(bancoDe(''), null);
  assert.equal(bancoDe('otro'), null);
  assert.equal(bancoDe(BBVA), BBVA);
  assert.equal(bancoDe('99999'), undefined);

  const t = conServicio();
  const sinBanco = await transferencia(t, {});
  const otro = await transferencia(t, { banco_emisor: 'otro' });
  assert.equal(fila(t.db, sinBanco).banco_emisor, null);
  assert.equal(fila(t.db, otro).banco_emisor, null);
  const mala = await t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], forma_pago: 'transferencia',
    caja: 'Caja 1', promo: 0, ...datosTransferencia(50000), banco_emisor: '99999' });
  assert.equal(mala.status, 400);
  assert.equal(mala.cuerpo.campo, 'banco');
  // Sin banco no hay con que consultar: la PC no las ve.
  t.comoServicio(SERVICIO);
  assert.deepEqual((await t.pedir('/api/cep/pendientes')).cuerpo.transferencias, []);
});

test('/api/cep/*: solo el service token configurado; sin identidad, con otra, sin CEP_CLIENT_ID o una persona (ni el dueno) = 401', async () => {
  const t = conServicio();
  await transferencia(t);
  assert.equal((await t.pedir('/api/cep/pendientes')).status, 200);

  t.comoServicio(undefined);                                        // ni token ni sesion de servicio
  assert.equal((await t.pedir('/api/cep/pendientes')).status, 401);
  assert.equal((await reportar(t, { id: 1, intento: 1, estado: 'no_existe' })).status, 401);
  t.comoServicio('otro-servicio.access');                           // un service token que no es el de la PC de la caja
  assert.equal((await t.pedir('/api/cep/pendientes')).status, 401);
  t.comoServicio(DUENO);                                            // un correo no es un service token
  assert.equal((await t.pedir('/api/cep/pendientes')).status, 401);
  t.comoServicio(SERVICIO);
  delete t.env.CEP_CLIENT_ID;                                       // sin configurar: cerrado por omision
  assert.equal((await t.pedir('/api/cep/pendientes')).status, 401);
  t.env.CEP_CLIENT_ID = SERVICIO;

  // Minimo privilegio: lo unico que hace es listar y reportar.
  assert.equal((await t.pedir('/api/cep/otra-cosa')).status, 404);
  assert.equal((await t.pedir('/api/cep/pendientes', {})).status, 404);   // POST a una ruta de GET
  // Y con ese servicio no se entra a nada mas: sin correo, el resto de la API no lo reconoce.
  t.env.DEV_USUARIO = undefined;
  assert.equal((await t.pedir('/api/avisos')).status, 401);
  assert.equal((await t.pedir('/api/ventas', { lineas: [] })).status, 401);
});

/* ---------- JWT del service token de Access, firmado aqui con una llave generada en la prueba ---------- */

const b64url = (datos: Uint8Array | string) => Buffer.from(datos).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const par = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']) as CryptoKeyPair;
const AUD = 'aud-prueba';
const EMISOR = 'https://equipo.cloudflareaccess.com';
const llave = async (kid: string) => (kid === 'k1' ? par.publicKey : undefined);
async function jwt(carga: Record<string, unknown>) {
  const cuerpo = { aud: [AUD], iss: EMISOR, exp: Math.floor(Date.now() / 1000) + 600, ...carga };
  const firmado = `${b64url(JSON.stringify({ alg: 'RS256', kid: 'k1' }))}.${b64url(JSON.stringify(cuerpo))}`;
  const firma = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', par.privateKey, new TextEncoder().encode(firmado)));
  return `${firmado}.${b64url(firma)}`;
}

test('JWT de servicio: el common_name sale de un token firmado, vigente y de esta aplicacion; uno de persona no es servicio ni al reves', async () => {
  const servicio = await jwt({ common_name: SERVICIO, type: 'app', sub: '' });
  assert.equal(await verificarJwtServicio(servicio, AUD, EMISOR, llave), SERVICIO);
  // Un service token no trae correo: no puede entrar como persona.
  assert.equal(await verificarJwt(servicio, AUD, EMISOR, llave), null);
  // Y el token de una persona no sirve como servicio.
  const persona = await jwt({ email: DUENO });
  assert.equal(await verificarJwtServicio(persona, AUD, EMISOR, llave), null);
  assert.equal(await verificarJwt(persona, AUD, EMISOR, llave), DUENO);
  assert.equal(await verificarJwtServicio(await jwt({ common_name: SERVICIO, email: DUENO }), AUD, EMISOR, llave), null);
  // Otra aplicacion, otro equipo, vencido, sin common_name, firma ajena.
  assert.equal(await verificarJwtServicio(await jwt({ common_name: SERVICIO, aud: ['otra'] }), AUD, EMISOR, llave), null);
  assert.equal(await verificarJwtServicio(await jwt({ common_name: SERVICIO, iss: 'https://otro.cloudflareaccess.com' }), AUD, EMISOR, llave), null);
  assert.equal(await verificarJwtServicio(await jwt({ common_name: SERVICIO, exp: 1 }), AUD, EMISOR, llave), null);
  assert.equal(await verificarJwtServicio(await jwt({}), AUD, EMISOR, llave), null);
  assert.equal(await verificarJwtServicio(servicio.slice(0, -4) + 'AAAA', AUD, EMISOR, llave), null);
});

test('la ruta de validar a mano es solo del dueno en el mapa de permisos', () => {
  const ruta = permiso('/api/avisos/transferencias/7/validar', 'POST');
  const usuario = (roles: string[]) => ({ correo: 'a@b.mx', nombre: 'A', roles, activo: true, caja: '', editar_inventario: false }) as never;
  assert.equal(puede(usuario(['dueno']), ruta), true);
  assert.equal(puede(usuario(['cajero']), ruta), false);
  assert.equal(puede(usuario(['computadora']), ruta), false);
  assert.equal(puede(usuario(['cajero']), permiso('/api/avisos', 'GET')), true);   // verla si
});

/* ---------- pendientes ---------- */

test('pendientes: con banco, de mas de 10 minutos, con la fecha de ABONO en hora de tienda y el intento que toca', async () => {
  const t = conServicio();
  // 02:00 UTC del 30/10 = 20:00 del 29/10 en la tienda (UTC-6): se busca el 29.
  const noche = await transferencia(t, { banco_emisor: BBVA }, '2026-10-30T02:00:00.000Z');
  await transferencia(t, { banco_emisor: BBVA }, hace(3));
  const { cuerpo } = await t.pedir('/api/cep/pendientes');
  assert.deepEqual(cuerpo.transferencias.map((x: any) => x.id), [noche]);   // la de 3 minutos todavia no
  const x = cuerpo.transferencias[0];
  assert.equal(x.fecha, '2026-10-29');
  assert.equal(x.monto, 50000);
  assert.equal(x.banco_emisor, BBVA);
  assert.equal(x.intento, 1);
  assert.match(x.clave, /^PRUEBA\d{10}$/);
  assert.equal(Object.keys(x).sort().join(), 'banco_emisor,clave,fecha,id,intento,monto');   // sin CLABE, nombres ni quien la capturo

  // Segunda y ultima consulta: el dia anterior, y no antes de 10 minutos de la primera.
  assert.equal((await reportar(t, { id: noche, intento: 1, estado: 'no_existe' })).cuerpo.estado, 'pendiente');
  assert.deepEqual((await t.pedir('/api/cep/pendientes')).cuerpo.transferencias, []);
  t.db.prepare('update transferencias_spei set cep_ultimo_intento = ? where id = ?').run(hace(11), noche);
  const otra = (await t.pedir('/api/cep/pendientes')).cuerpo.transferencias[0];
  assert.deepEqual([otra.id, otra.fecha, otra.intento], [noche, '2026-10-28', 2]);
});

test('pendientes: las ya resueltas no vuelven; nunca mas de 10 por corrida', async () => {
  const t = conServicio();
  const ids: number[] = [];
  for (let i = 0; i < 12; i++) ids.push(await transferencia(t));
  assert.equal((await t.pedir('/api/cep/pendientes')).cuerpo.transferencias.length, 10);
  for (const id of ids) t.db.prepare("update transferencias_spei set cep_estado = 'banxico_ok' where id = ?").run(id);
  assert.deepEqual((await t.pedir('/api/cep/pendientes')).cuerpo.transferencias, []);
});

/* ---------- resultados ---------- */

test('encontrada con monto y cuenta correctos: banxico_ok, verificacion banxico; repetir el reporte no cambia nada', async () => {
  const t = conServicio();
  const id = await transferencia(t);
  const r = await reportar(t, { id, intento: 1, estado: 'encontrada', monto_cep: 50000, cuenta_ok: true });
  assert.deepEqual([r.status, r.cuerpo.estado], [200, 'banxico_ok']);
  const f = fila(t.db, id);
  assert.deepEqual([f.cep_estado, f.cep_intentos, f.verificacion], ['banxico_ok', 1, 'banxico']);
  assert.ok(f.cep_ultimo_intento);
  const otra = await reportar(t, { id, intento: 1, estado: 'encontrada', monto_cep: 50000, cuenta_ok: true });
  assert.deepEqual([otra.status, otra.cuerpo.estado, otra.cuerpo.repetido], [200, 'banxico_ok', true]);
  // Un reporte contrario despues no deshace lo verificado.
  assert.equal((await reportar(t, { id, intento: 1, estado: 'no_existe' })).cuerpo.estado, 'banxico_ok');
  assert.equal(fila(t.db, id).cep_intentos, 1);
  await t.esperar();
  assert.equal(t.correos.length, 0);   // todo bien: nadie se entera
});

test('no coincide (monto distinto o cuenta ajena): no_coincide al primer reporte y el dueno recibe un solo aviso', async () => {
  const t = conServicio();
  const a = await transferencia(t);
  const b = await transferencia(t);
  assert.equal((await reportar(t, { id: a, intento: 1, estado: 'encontrada', monto_cep: 49999, cuenta_ok: true })).cuerpo.estado, 'no_coincide');
  assert.equal((await reportar(t, { id: b, intento: 1, estado: 'encontrada', monto_cep: 50000, cuenta_ok: false })).cuerpo.estado, 'no_coincide');
  // El aviso no se repite si la PC reporta lo mismo otra vez.
  await reportar(t, { id: a, intento: 1, estado: 'encontrada', monto_cep: 49999, cuenta_ok: true });
  assert.equal(t.correos.length, 2);
  assert.equal(fila(t.db, a).verificacion, 'cajero');
});

test('no existe dos veces (el dia y el anterior): no_encontrada y aviso al dueno por correo, con el enlace a Avisos y sin la clave', async () => {
  const t = conServicio();
  const id = await transferencia(t);
  assert.equal((await reportar(t, { id, intento: 1, estado: 'no_existe' })).cuerpo.estado, 'pendiente');
  assert.equal(t.correos.length, 0);                                 // un intento fallido todavia no molesta a nadie
  assert.equal((await reportar(t, { id, intento: 1, estado: 'no_existe' })).cuerpo.repetido, true);   // el mismo intento dos veces = uno
  assert.equal(fila(t.db, id).cep_intentos, 1);
  const r = await reportar(t, { id, intento: 2, estado: 'no_existe' });
  assert.equal(r.cuerpo.estado, 'no_encontrada');
  assert.equal(fila(t.db, id).cep_intentos, 2);
  assert.equal(t.correos.length, 1);
  const correo = t.correos[0];
  assert.equal(correo.to, DUENO);
  assert.match(correo.subject, /Transferencia por validar/);
  assert.match(correo.text, /\$500\.00.*no la encontró/);
  assert.match(correo.text, /https:\/\/caja\.prueba\/avisos/);
  assert.doesNotMatch(correo.text, /PRUEBA\d/);
  // Ya no hay mas consultas: ni un tercer intento ni un reporte saltado.
  assert.equal((await reportar(t, { id, intento: 3, estado: 'no_existe' })).cuerpo.repetido, true);
  t.db.prepare('update transferencias_spei set cep_ultimo_intento = ? where id = ?').run(hace(60), id);
  assert.deepEqual((await t.pedir('/api/cep/pendientes')).cuerpo.transferencias, []);
});

test('con un dispositivo del dueno suscrito, el aviso llega por push (sin la clave) y no por correo', async () => {
  const t = conServicio();
  const llaves = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  t.env.VAPID_JWK = JSON.stringify(await crypto.subtle.exportKey('jwk', llaves.privateKey));
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  t.db.prepare('insert into push_suscripciones (endpoint, correo, p256dh, auth, creado_en) values (?, ?, ?, ?, ?)').run(
    'https://web.push.apple.com/prueba', DUENO,
    Buffer.from(await crypto.subtle.exportKey('raw', ua.publicKey) as ArrayBuffer).toString('base64url'),
    Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'), '');
  const llegadas: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { llegadas.push(url); return new Response('', { status: 201 }); }) as typeof fetch;
  try {
    const id = await transferencia(t);
    await reportar(t, { id, intento: 1, estado: 'encontrada', monto_cep: 50000, cuenta_ok: false });
  } finally { globalThis.fetch = original; }
  assert.deepEqual(llegadas, ['https://web.push.apple.com/prueba']);
  assert.equal(t.correos.length, 0);
});

test('si ni el push ni el correo salen, el reporte igual se guarda y la transferencia sigue en Avisos', async () => {
  const t = conServicio();
  const id = await transferencia(t);
  // Sin VAPID_JWK ni dispositivos pushADuenos devuelve 0 -> correo (ya probado arriba). Con el correo roto:
  t.env.CORREO = { async send() { throw new Error('E_RECIPIENT_NOT_ALLOWED'); } } as never;
  const r = await reportar(t, { id, intento: 1, estado: 'encontrada', monto_cep: 1, cuenta_ok: true });
  assert.equal(r.status, 200);
  assert.equal(fila(t.db, id).cep_estado, 'no_coincide');
  assert.equal((await t.pedir('/api/avisos')).cuerpo.transferencias.length, 1);   // sigue en la lista de Avisos
});

test('reportes mal formados o de una transferencia que no existe', async () => {
  const t = conServicio();
  const id = await transferencia(t);
  for (const malo of [{}, { id, intento: 1 }, { id, intento: 1, estado: 'captcha' }, { id, intento: 'a', estado: 'no_existe' },
    { id, intento: 1, estado: 'encontrada' }, { id, intento: 1, estado: 'encontrada', monto_cep: 50000 },
    { id, intento: 1, estado: 'encontrada', monto_cep: '50000', cuenta_ok: true }]) {
    assert.equal((await reportar(t, malo)).status, 400, JSON.stringify(malo));
  }
  assert.equal((await reportar(t, { id: 99999, intento: 1, estado: 'no_existe' })).status, 404);
  assert.equal(fila(t.db, id).cep_estado, 'pendiente');
  assert.equal(fila(t.db, id).cep_intentos, 0);
});

test('dos reportes a la vez del mismo intento: gana uno y el aviso sale una sola vez', async () => {
  const t = conServicio();
  const id = await transferencia(t);
  t.db.prepare('update transferencias_spei set cep_intentos = 1 where id = ?').run(id);
  const cuerpo = { id, intento: 2, estado: 'no_existe' };
  const [a, b] = await Promise.all([reportar(t, cuerpo), reportar(t, cuerpo)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(fila(t.db, id).cep_intentos, 2);
  assert.equal(t.correos.length, 1);
});

/* ---------- avisos y validacion manual ---------- */

test('Avisos trae las transferencias por validar para la caja; validar a mano es solo del dueno, deja quien y cuando, y es idempotente', async () => {
  const t = conServicio();
  const id = await transferencia(t);
  const pendiente = await transferencia(t);
  await reportar(t, { id, intento: 1, estado: 'encontrada', monto_cep: 1, cuenta_ok: true });

  // El cajero ve el aviso (la caja lo pinta) pero no puede validarla.
  t.db.prepare("insert into usuarios(correo, nombre, roles, activo, creado_en, actualizado_en) values ('cajero@prueba.mx', 'Cajero', 'cajero', 1, '', '')").run();
  t.env.DEV_USUARIO = 'cajero@prueba.mx';
  const vista = (await t.pedir('/api/avisos')).cuerpo;
  assert.deepEqual(vista.ventas_ml, []);
  assert.equal(vista.transferencias.length, 1);
  assert.deepEqual(Object.keys(vista.transferencias[0]).sort(), ['clave', 'donde', 'estado', 'id', 'monto', 'registrado_en']);
  assert.equal(vista.transferencias[0].estado, 'no_coincide');
  assert.match(vista.transferencias[0].donde, /^Ticket [0-9A-F]{8}$/);
  const intento = await t.pedir(`/api/avisos/transferencias/${id}/validar`, {});
  assert.equal(intento.status, 403);
  assert.equal(fila(t.db, id).cep_estado, 'no_coincide');

  // El dueno si; una que sigue pendiente no se puede dar por buena todavia.
  t.env.DEV_USUARIO = DUENO;
  assert.equal((await t.pedir(`/api/avisos/transferencias/${pendiente}/validar`, {})).status, 409);
  assert.equal(fila(t.db, pendiente).cep_estado, 'pendiente');
  assert.equal((await t.pedir('/api/avisos/transferencias/99999/validar', {})).status, 404);
  const ok = await t.pedir(`/api/avisos/transferencias/${id}/validar`, {});
  assert.deepEqual([ok.status, ok.cuerpo.ok], [200, true]);
  const f = fila(t.db, id);
  assert.deepEqual([f.cep_estado, f.validada_por, f.verificacion], ['validada_manual', DUENO, 'cajero']);
  assert.ok(f.validada_en);
  const otra = await t.pedir(`/api/avisos/transferencias/${id}/validar`, {});
  assert.deepEqual([otra.status, otra.cuerpo.repetido], [200, true]);
  assert.equal(fila(t.db, id).validada_en, f.validada_en);
  assert.deepEqual((await t.pedir('/api/avisos')).cuerpo.transferencias, []);
});

test('un aviso de transferencia nunca toca el cobro: la venta y su existencia quedan como estaban', async () => {
  const t = conServicio();
  const antes = (t.db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock;
  const id = await transferencia(t);
  await reportar(t, { id, intento: 1, estado: 'encontrada', monto_cep: 1, cuenta_ok: false });
  const ventas = t.db.prepare('select count(*) n from ventas').get() as { n: number };
  assert.equal(ventas.n, 1);
  assert.equal((t.db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock, antes - 2);
});

test('el banco emisor tambien se guarda en el anticipo y en el abono de /pedidos', async () => {
  const t = conServicio();
  const apartado = await t.pedir('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], cliente: 'Ana',
    telefono: '4441234567', entrega: 'envio', anticipo: 10000, forma_pago: 'transferencia', caja: 'Caja 1', ...datosTransferencia(10000), banco_emisor: '90722' });
  assert.equal(apartado.status, 201, JSON.stringify(apartado.cuerpo));
  const folio = apartado.cuerpo.pedido.folio;
  const abono = await t.pedir(`/api/pedidos/${folio}/abonos`, { id: crypto.randomUUID(), importe: 5000, forma_pago: 'transferencia', caja: 'Caja 1',
    ...datosTransferencia(5000), banco_emisor: BBVA });
  assert.equal(abono.status, 200, JSON.stringify(abono.cuerpo));
  const filas = t.db.prepare('select origen, banco_emisor, cep_estado from transferencias_spei order by id').all();
  assert.deepEqual(filas.map((f: any) => [f.origen, f.banco_emisor, f.cep_estado]), [['anticipo', '90722', 'pendiente'], ['abono', BBVA, 'pendiente']]);
});
