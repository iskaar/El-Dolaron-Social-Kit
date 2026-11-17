// node --test src/pin-por-tienda.test.ts
// #850: el PIN de cajero, supervisor y «quien atendió» solo vale en la computadora de la tienda de su cuenta; el dueño entra en cualquiera.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { cajeroEnTurno } from './cajeros.ts';

const PC_SOLEDAD = 'pcsoledad@prueba.mx';
const PC_SALK = 'pcsalk@prueba.mx';
const ANA = 'ana@prueba.mx';          // cajera de Soledad (sin tienda = Soledad)
const SOFI = 'sofi@prueba.mx';        // cajera de Salk
const SARA = 'sara@prueba.mx';        // supervisora de Soledad
const SUSI = 'susi@prueba.mx';        // supervisora de Salk
const CAPA = 'capa@prueba.mx';        // capturista de Soledad
const PIN = '482913';
const PIN_DUENO = '111222';

async function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, tienda, creado_en, actualizado_en) values
    (?, 'PC Soledad', 'computadora', 1, '', 'soledad', '', ''), (?, 'PC Salk', 'computadora', 1, '', 'salk', '', ''),
    (?, 'Ana', 'cajero', 1, '', '', '', ''), (?, 'Sofi', 'cajero', 1, '', 'salk', '', ''),
    (?, 'Sara', 'cajero,supervisor', 1, '', '', '', ''), (?, 'Susi', 'cajero,supervisor', 1, '', 'salk', '', ''),
    (?, 'Capa', 'capturista', 1, '', '', '', '')`).run(PC_SOLEDAD, PC_SALK, ANA, SOFI, SARA, SUSI, CAPA);
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  como(DUENO);
  for (const correo of [DUENO, ANA, SOFI, SARA, SUSI]) await t.pedir('/api/cuentas/pin', { correo, pin: correo === DUENO ? PIN_DUENO : PIN }, 'PUT');
  const entrar = (pc: string, correo: string, pin = PIN) => { como(pc); return t.pedir('/api/cajeros/entrar', { correo, pin }); };
  const venta = (pc: string, token: string, extra: Record<string, unknown> = {}) => {
    como(pc);
    return t.pedir('/api/ventas', {
      id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000,
      caja: pc === PC_SALK ? 'Salk 1' : 'Caja 1', ...extra,
    }, 'POST', { 'x-cajero': token });
  };
  t.db.prepare(`insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, 'salk', 5, '')`).run(PRODUCTO);
  const sesiones = () => (t.db.prepare('select count(*) n from sesiones_cajero').get() as { n: number }).n;
  return { ...t, como, entrar, venta, sesiones };
}

test('una cajera de Soledad con su PIN correcto en la computadora de Salk: 403 con el aviso y sin sesión', async () => {
  const { entrar, sesiones } = await montar();
  const r = await entrar(PC_SALK, ANA);
  assert.equal(r.status, 403);
  assert.equal(r.cuerpo.error, 'Tu cuenta es de Soledad; esta caja es de Avenida Salk. Pídele a gerencia que te cambie de tienda.');
  assert.equal(r.cuerpo.token, undefined);
  assert.equal(sesiones(), 0);
  assert.equal((await entrar(PC_SOLEDAD, ANA)).status, 201);    // en su tienda sí
  assert.equal((await entrar(PC_SALK, SOFI)).status, 201);      // y la de Salk en Salk
  assert.equal((await entrar(PC_SOLEDAD, SOFI)).cuerpo.error, 'Tu cuenta es de Avenida Salk; esta caja es de Soledad. Pídele a gerencia que te cambie de tienda.');
});

test('el aviso de otra tienda no gasta intentos de PIN ni delata el PIN: con PIN malo o bueno es el mismo 403', async () => {
  const { entrar, db } = await montar();
  for (let i = 0; i < 8; i++) assert.equal((await entrar(PC_SALK, ANA, '000000')).status, 403);
  assert.equal((db.prepare('select pin_fallos, pin_bloqueo from usuarios where correo = ?').get(ANA) as { pin_fallos: number }).pin_fallos, 0);
  assert.equal((await entrar(PC_SOLEDAD, ANA)).status, 201, 'su acceso en su tienda no quedó bloqueado');
});

test('el token de una sesión de Soledad no abre la caja de Salk (token viejo o copiado): 401 y pide PIN', async () => {
  const { entrar, venta, como, pedir } = await montar();
  const token = (await entrar(PC_SOLEDAD, ANA)).cuerpo.token as string;
  assert.equal((await venta(PC_SOLEDAD, token)).status, 201);
  const r = await venta(PC_SALK, token);
  assert.equal(r.status, 401);
  assert.equal(r.cuerpo.pin, true);
  como(PC_SALK);
  assert.equal((await pedir('/api/yo', undefined, 'GET', { 'x-cajero': token })).cuerpo.cajero, null);
});

test('cajeroEnTurno compara la tienda de la terminal', async () => {
  const { entrar, env } = await montar();
  const token = (await entrar(PC_SOLEDAD, ANA)).cuerpo.token as string;
  const peticion = new Request('https://x/api/ventas', { headers: { 'x-cajero': token } });
  assert.equal((await cajeroEnTurno(peticion, env, 'soledad'))?.correo, ANA);
  assert.equal(await cajeroEnTurno(peticion, env, 'salk'), null);
  assert.equal(await cajeroEnTurno(peticion, env, ''), null);
});

test('gerencia entra con su PIN en la computadora de cualquier tienda y cobra', async () => {
  const { entrar, venta } = await montar();
  for (const pc of [PC_SOLEDAD, PC_SALK]) {
    const r = await entrar(pc, DUENO, PIN_DUENO);
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    assert.equal((await venta(pc, r.cuerpo.token)).status, 201);
  }
});

test('la pantalla de bloqueo lista solo a los de esta tienda más los dueños; /api/vendedoras igual (los capturistas también)', async () => {
  const { pedir, como, entrar } = await montar();
  como(PC_SALK);
  assert.deepEqual((await pedir('/api/cajeros')).cuerpo.map((c: { correo: string }) => c.correo).sort(), [DUENO, SOFI, SUSI].sort());
  como(PC_SOLEDAD);
  const soledad = (await pedir('/api/cajeros')).cuerpo.map((c: { correo: string }) => c.correo);
  assert.ok(soledad.includes(ANA) && soledad.includes(SARA) && soledad.includes(DUENO));
  assert.ok(!soledad.includes(SOFI) && !soledad.includes(SUSI));

  const vendedorasDe = async (pc: string) => {
    const token = (await entrar(pc, DUENO, PIN_DUENO)).cuerpo.token as string;   // gerencia entra en cualquiera: ve lo mismo que una cajera de la tienda
    return (await pedir('/api/vendedoras', undefined, 'GET', { 'x-cajero': token })).cuerpo.map((c: { correo: string }) => c.correo) as string[];
  };
  const salk = await vendedorasDe(PC_SALK);
  assert.deepEqual(salk.filter((c) => c !== DUENO).sort(), [SOFI, SUSI].sort());
  const enSoledad = await vendedorasDe(PC_SOLEDAD);
  assert.ok(enSoledad.includes(ANA) && enSoledad.includes(CAPA) && !enSoledad.includes(SOFI));
});

test('quien atendió debe ser de esta tienda: la venta en Salk con una vendedora de Soledad es 400; con una de Salk, 201', async () => {
  const { entrar, venta } = await montar();
  const token = (await entrar(PC_SALK, SOFI)).cuerpo.token as string;
  const mala = await venta(PC_SALK, token, { vendedora: ANA });
  assert.equal(mala.status, 400);
  assert.match(mala.cuerpo.error, /Quien atendió/);
  const buena = await venta(PC_SALK, token, { vendedora: SUSI });
  assert.equal(buena.status, 201, JSON.stringify(buena.cuerpo));
});

test('el supervisor de otra tienda no aprueba un retiro; el de la tienda y gerencia sí; y no se ofrece como aprobador', async () => {
  const { entrar, como, pedir, db } = await montar();
  como(DUENO);
  assert.equal((await pedir('/api/config', { tope_retiro: 1000 }, 'PUT')).status, 200);
  const sofi = { 'x-cajero': (await entrar(PC_SALK, SOFI)).cuerpo.token as string };
  const retirar = (extra: Record<string, unknown>) => { como(PC_SALK); return pedir('/api/retiros', { id: crypto.randomUUID(), tipo: 'retiro', caja: 'Salk 1', importe: 5000, motivo: 'caja fuerte', ...extra }, 'POST', sofi); };

  const sinPin = await retirar({});
  assert.equal(sinPin.status, 403);
  assert.deepEqual(sinPin.cuerpo.duenos.map((d: { correo: string }) => d.correo).sort(), [DUENO, SUSI].sort(), 'Sara (Soledad) no se ofrece en Salk');

  const ajena = await retirar({ aprobador: SARA, pin: PIN });
  assert.equal(ajena.status, 403);
  assert.match(ajena.cuerpo.error, /otra tienda/);
  assert.equal((db.prepare('select count(*) n from retiros').get() as { n: number }).n, 0);
  assert.equal((db.prepare('select count(*) n from intentos_aprobacion where correo = ?').get(SARA) as { n: number }).n, 0, 'no gastó intentos de Sara');

  assert.equal((await retirar({ aprobador: SUSI, pin: PIN })).cuerpo.aprobo_por, SUSI);
  assert.equal((await retirar({ aprobador: DUENO, pin: PIN_DUENO })).cuerpo.aprobo_por, DUENO);
});

test('cambiarle la tienda a una cuenta en /cuentas cierra sus sesiones de PIN; guardar sin cambiar la tienda no', async () => {
  const { entrar, venta, como, pedir, sesiones } = await montar();
  const token = (await entrar(PC_SOLEDAD, ANA)).cuerpo.token as string;
  como(DUENO);
  const guardada = await pedir('/api/cuentas', { correo: ANA, nombre: 'Ana', roles: ['cajero'], tienda: 'soledad' }, 'PUT');
  assert.equal(guardada.status, 200, JSON.stringify(guardada.cuerpo));   // sin tienda = Soledad: no cambia
  assert.equal((await venta(PC_SOLEDAD, token)).status, 201);
  como(DUENO);
  assert.equal((await pedir('/api/cuentas', { correo: ANA, nombre: 'Ana', roles: ['cajero'], tienda: 'salk' }, 'PUT')).status, 200);
  assert.equal(sesiones(), 0);
  assert.equal((await venta(PC_SOLEDAD, token)).status, 401);
  assert.equal((await entrar(PC_SOLEDAD, ANA)).status, 403);
  assert.equal((await entrar(PC_SALK, ANA)).status, 201);
});
