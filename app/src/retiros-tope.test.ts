// node --test src/retiros-tope.test.ts
// Un retiro del cajón arriba del tope lo aprueba el supervisor o el dueño con su PIN (#846) contra SQLite real con todas las migraciones.
// El tope vive en `config` (clave tope_retiro, centavos): en el código y en el repositorio no hay ningún monto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { tienda, DUENO } from './prueba-d1.ts';

const TIENDA = 'tienda@prueba.mx';
const ANA = 'ana@prueba.mx';
const SUP = 'sup@prueba.mx';
const BETO = 'beto@prueba.mx';
const CAPTURA = 'captura@prueba.mx';
const PIN_DUENO = '111222';
const PIN_ANA = '482913';
const PIN_SUP = '735190';
const PIN_BETO = '264817';
const TOPE = 123400;   // un valor cualquiera de prueba: no es, ni se parece a, la politica real del dueño

async function montar(tope: number | null = TOPE) {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en) values
    ('${TIENDA}', 'Computadora', 'computadora', 1, '', '', ''),
    ('${ANA}', 'Ana', 'cajero', 1, '', '', ''),
    ('${SUP}', 'Sara', 'cajero,supervisor', 1, '', '', ''),
    ('${BETO}', 'Beto', 'cajero', 1, '', '', ''),
    ('${CAPTURA}', 'Cata', 'capturista', 1, '', '', ''),
    ('cs@prueba.mx', 'Cs', 'capturista,supervisor', 1, '', '', '')`).run();
  t.db.prepare(`update usuarios set tienda = 'soledad' where roles = 'computadora'`).run();
  for (const [correo, pin] of [[DUENO, PIN_DUENO], [ANA, PIN_ANA], [SUP, PIN_SUP], [BETO, PIN_BETO]]) await t.pedir('/api/cuentas/pin', { correo, pin }, 'PUT');
  // El dueño, que es la sesión de prueba, fija el tope como lo hace en /reportes.
  if (tope !== null) assert.equal((await t.pedir('/api/config', { tope_retiro: tope }, 'PUT')).status, 200);
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  como(TIENDA);
  const entrar = async (correo: string, pin: string) => ({ 'x-cajero': (await t.pedir('/api/cajeros/entrar', { correo, pin })).cuerpo.token as string });
  const ana = await entrar(ANA, PIN_ANA);
  const sup = await entrar(SUP, PIN_SUP);
  const retirar = (importe: number, extra: Record<string, unknown> = {}, encabezados: Record<string, string> = ana) =>
    t.pedir('/api/retiros', { id: crypto.randomUUID(), tipo: 'retiro', caja: 'Caja 1', importe, motivo: 'caja fuerte', ...extra }, 'POST', encabezados);
  const filas = () => t.db.prepare('select id, tipo, importe, cajero, aprobo_por from retiros').all() as Record<string, any>[];
  return { ...t, como, ana, sup, retirar, filas };
}

test('bajo el tope y justo en el tope el cajero retira solo; sin aprobación registrada', async () => {
  const { retirar, filas } = await montar();
  assert.equal((await retirar(TOPE - 1)).status, 201);
  const r = await retirar(TOPE);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.aprobo_por, null);
  assert.deepEqual(filas().map((f) => f.aprobo_por), [null, null]);
});

test('arriba del tope sin PIN se rechaza sin registrar nada, y la respuesta no dice el tope', async () => {
  const { retirar, filas } = await montar();
  const r = await retirar(TOPE + 1);
  assert.equal(r.status, 403);
  assert.equal(r.cuerpo.requiere_aprobacion, true);
  assert.deepEqual(r.cuerpo.duenos, [{ correo: DUENO, nombre: 'Isaac' }, { correo: SUP, nombre: 'Sara' }]);
  assert.doesNotMatch(JSON.stringify(r.cuerpo), new RegExp(`${TOPE}|1,?234`), 'la caja solo se entera de que necesita aprobación');
  assert.equal(filas().length, 0);
});

test('con el PIN de un supervisor o del dueño se registra y queda quién aprobó', async () => {
  const { retirar, filas } = await montar();
  const conSupervisor = await retirar(TOPE + 1, { aprobador: SUP, pin: PIN_SUP });
  assert.equal(conSupervisor.status, 201, JSON.stringify(conSupervisor.cuerpo));
  assert.equal(conSupervisor.cuerpo.aprobo_por, SUP);
  assert.equal(conSupervisor.cuerpo.cajero, ANA, 'el retiro sigue a nombre de quien lo hace');
  const conDueno = await retirar(TOPE * 3, { aprobador: DUENO, pin: PIN_DUENO });
  assert.equal(conDueno.status, 201);
  assert.deepEqual(filas().map((f) => [f.cajero, f.aprobo_por]), [[ANA, SUP], [ANA, DUENO]]);
});

test('PIN equivocado, PIN de un cajero o aprobarse a sí mismo: nada se registra', async () => {
  const { retirar, filas } = await montar();
  assert.equal((await retirar(TOPE + 1, { aprobador: SUP, pin: '000000' })).status, 403);
  assert.equal((await retirar(TOPE + 1, { aprobador: SUP, pin: '12' })).status, 400);
  const cajero = await retirar(TOPE + 1, { aprobador: BETO, pin: PIN_BETO });   // otro cajero, con su PIN correcto: no aprueba
  assert.equal(cajero.status, 404);
  const propio = await retirar(TOPE + 1, { aprobador: ANA, pin: PIN_ANA });     // ella misma, con su PIN correcto
  assert.equal(propio.status, 404);
  assert.equal(filas().length, 0);
});

test('el dueño y el supervisor en su propia sesión no necesitan PIN y quedan como quien aprobó', async () => {
  const { retirar, filas, sup, como } = await montar();
  const supervisor = await retirar(TOPE + 1, {}, sup);
  assert.equal(supervisor.status, 201, JSON.stringify(supervisor.cuerpo));
  assert.equal(supervisor.cuerpo.aprobo_por, SUP);
  como(DUENO);
  const dueno = await retirar(TOPE + 1, {}, {});
  assert.equal(dueno.status, 201, JSON.stringify(dueno.cuerpo));
  assert.deepEqual(filas().map((f) => [f.cajero, f.aprobo_por]), [[SUP, SUP], [DUENO, DUENO]]);
});

test('sin la clave de configuración todo retiro pide aprobación, también uno de $1; con tope 0 igual', async () => {
  for (const tope of [null, 0]) {
    const { retirar, filas } = await montar(tope);
    assert.equal((await retirar(100)).status, 403, `tope ${tope}`);
    assert.equal(filas().length, 0);
    assert.equal((await retirar(100, { aprobador: SUP, pin: PIN_SUP })).status, 201);
  }
});

test('una clave dañada en config cuenta como sin tope: pide aprobación', async () => {
  const { db, retirar, filas } = await montar();
  db.prepare(`update config set valor = 'mucho' where clave = 'tope_retiro'`).run();
  assert.equal((await retirar(100)).status, 403);
  assert.equal(filas().length, 0);
});

test('el reintento de un retiro aprobado no vuelve a pedir el PIN ni se cuenta dos veces', async () => {
  const { retirar, filas, pedir, ana } = await montar();
  const id = crypto.randomUUID();
  const primero = await retirar(TOPE + 1, { id, aprobador: SUP, pin: PIN_SUP });
  assert.equal(primero.status, 201);
  const reintento = await retirar(TOPE + 1, { id });   // la red cayó antes de ver la respuesta: sin PIN
  assert.equal(reintento.status, 201);
  assert.deepEqual(reintento.cuerpo, primero.cuerpo);
  assert.equal(filas().length, 1);
  const corte = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 1, tarjeta_terminal: 0 }, 'POST', ana);
  assert.equal(corte.cuerpo.retiros, TOPE + 1, 'se resta una sola vez');
});

test('el corte resta el retiro aprobado igual que uno sin aprobar', async () => {
  const { retirar, pedir, ana } = await montar();
  assert.equal((await retirar(TOPE + 1, { aprobador: SUP, pin: PIN_SUP })).status, 201);
  assert.equal((await retirar(10000)).status, 201);
  const corte = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 1, tarjeta_terminal: 0 }, 'POST', ana);
  assert.equal(corte.status, 201, JSON.stringify(corte.cuerpo));
  assert.equal(corte.cuerpo.retiros, TOPE + 1 + 10000);
});

test('gastos y entradas de la terminal no cambian: ni tope ni PIN, aunque no haya tope fijado', async () => {
  const { retirar, filas } = await montar(null);
  assert.equal((await retirar(5000, { tipo: 'gasto', categoria: 'agua', motivo: 'garrafon' })).status, 201);
  assert.equal((await retirar(TOPE * 10, { tipo: 'terminal', motivo: '' })).status, 201);
  assert.equal((await retirar(10001, { tipo: 'gasto', categoria: 'agua', motivo: 'garrafon' })).status, 403, 'el gasto de más de $100 lo sigue registrando el dueño');
  assert.deepEqual(filas().map((f) => f.aprobo_por), [null, null]);
});

test('el cajero no lee ni cambia el tope; el dueño sí; quien captura no lo ve', async () => {
  const { pedir, como, ana } = await montar();
  assert.equal((await pedir('/api/config', undefined, 'GET', ana)).status, 403);
  assert.equal((await pedir('/api/config', { tope_retiro: 99999999 }, 'PUT', ana)).status, 403);
  como(CAPTURA);
  const captura = await pedir('/api/config');
  assert.equal(captura.status, 200);
  assert.equal('tope_retiro' in captura.cuerpo, false);
  como(DUENO);
  assert.equal((await pedir('/api/config')).cuerpo.tope_retiro, String(TOPE));
});

test('el dueño solo guarda centavos enteros en el tope', async () => {
  const { pedir, como } = await montar();
  como(DUENO);
  for (const malo of [-1, 1.5, '', null, true, 1e9]) assert.equal((await pedir('/api/config', { tope_retiro: malo }, 'PUT')).status, 400, String(malo));
  assert.equal((await pedir('/api/config', { tope_retiro: 200000 }, 'PUT')).status, 200);
});

test('el mismo id con otro importe, tipo, caja o cajero se rechaza con 409 y lo registrado no cambia; el reenvío igual sigue en 201', async () => {
  const { retirar, filas, sup } = await montar();
  const id = crypto.randomUUID();
  const primero = await retirar(10000, { id });
  assert.equal(primero.status, 201);
  assert.equal((await retirar(10000, { id })).status, 201, 'reenvío idéntico');
  for (const [cambio, extra] of [['importe', { importe: 20000 }], ['tipo', { tipo: 'gasto', categoria: 'agua' }], ['caja', { caja: 'Caja 2' }]] as const) {
    const otro = await retirar((extra as { importe?: number }).importe ?? 10000, { id, ...extra });
    assert.equal(otro.status, 409, cambio);
    assert.match(otro.cuerpo.error, /ya se registró con otros datos/);
  }
  assert.equal((await retirar(10000, { id }, sup)).status, 409, 'otro cajero');
  assert.deepEqual(filas().map((f) => [f.importe, f.tipo]), [[10000, 'retiro']]);
});

test('antes de la migración 084 el retiro chico, el gasto y la entrada de la terminal funcionan como antes; lo que pide aprobación se rechaza claro', async () => {
  const { db, retirar, como } = await montar();
  db.exec('alter table retiros drop column aprobo_por');
  const chico = await retirar(10000);
  assert.equal(chico.status, 201, JSON.stringify(chico.cuerpo));
  assert.equal('aprobo_por' in chico.cuerpo, false);
  assert.equal((await retirar(10000, { id: chico.cuerpo.id })).status, 201, 'el reintento también');
  assert.equal((await retirar(5000, { tipo: 'gasto', categoria: 'agua', motivo: 'garrafon' })).status, 201);
  assert.equal((await retirar(TOPE * 10, { tipo: 'terminal', motivo: '' })).status, 201);
  for (const extra of [{}, { aprobador: SUP, pin: PIN_SUP }]) {
    const grande = await retirar(TOPE + 1, extra);
    assert.equal(grande.status, 503);
    assert.equal(grande.cuerpo.error, 'Falta actualizar el sistema: avisa al dueño.');
  }
  como(DUENO);
  assert.equal((await retirar(TOPE + 1, {}, {})).status, 503, 'ni el dueño: no habría dónde guardar quién aprobó');
  assert.equal((db.prepare('select count(*) as n from retiros').get() as { n: number }).n, 3);
  assert.equal((db.prepare('select count(*) as n from intentos_aprobacion').get() as { n: number }).n, 0, 'no se gastaron intentos de PIN');
});

test('los PIN fallidos al aprobar un retiro cuentan por aprobador y por caja, y a los 5 bloquean; el acceso del supervisor sigue libre', async () => {
  const { db, retirar, filas, pedir } = await montar();
  const fallos = () => db.prepare(`select fallos, bloqueo from intentos_aprobacion where correo = ? and caja = 'Caja 1'`).get(SUP) as { fallos: number; bloqueo: string } | undefined;
  for (let i = 1; i <= 4; i++) {
    assert.equal((await retirar(TOPE + 1, { aprobador: SUP, pin: '000000' })).status, 403);
    assert.equal(fallos()?.fallos, i);
  }
  const quinto = await retirar(TOPE + 1, { aprobador: SUP, pin: '000000' });
  assert.equal(quinto.status, 403);
  assert.match(quinto.cuerpo.error, /bloque/i);
  assert.ok(fallos()!.bloqueo > new Date().toISOString());
  assert.equal((await retirar(TOPE + 1, { aprobador: SUP, pin: PIN_SUP })).status, 423, 'bloqueado aunque el PIN sea el bueno');
  assert.equal(filas().length, 0);
  assert.equal((await pedir('/api/cajeros/entrar', { correo: SUP, pin: PIN_SUP })).status, 201, 'su acceso a la caja no se bloqueó');
});

test('un supervisor no lee el tope por /api/config: ni en una computadora de caja ni con otro rol de lectura', async () => {
  const { pedir, como, sup } = await montar();
  assert.equal((await pedir('/api/config', undefined, 'GET', sup)).status, 403);
  como(SUP);
  assert.equal((await pedir('/api/config')).status, 403);
  como('cs@prueba.mx');   // supervisor que además captura: puede leer config, pero no esa clave
  const r = await pedir('/api/config');
  assert.equal(r.status, 200);
  assert.equal('tope_retiro' in r.cuerpo, false);
  assert.equal((await pedir('/api/config', { tope_retiro: 1 }, 'PUT')).status, 403, 'ni cambiarlo');
});

const archivos = (carpeta: string): string[] => readdirSync(carpeta, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? archivos(`${carpeta}/${e.name}`) : /\.test\.ts$/.test(e.name) ? [] : [`${carpeta}/${e.name}`]);

test('ningún archivo de la app asigna un monto literal al tope (el repositorio es público)', () => {
  const lista = [...archivos('src'), ...archivos('public'), 'migracion-084-retiro-aprobo.sql'];
  assert.ok(lista.includes('src/corte.ts') && lista.includes('public/caja.html'));
  for (const archivo of lista) {
    if (!/\.(ts|js|html|sql|json|css)$/.test(archivo)) continue;
    assert.doesNotMatch(readFileSync(archivo, 'utf8'), /(?:tope_retiro|TOPE_RETIRO)['"\]]*\s*[:=]\s*['"]?\d/i, archivo);
  }
  // La pantalla de caja no pide la clave a /api/config: solo reacciona a la respuesta del servidor.
  assert.doesNotMatch(readFileSync('public/caja.html', 'utf8'), /tope_retiro/);
});
