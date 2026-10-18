// node --test src/avisos.test.ts
// Issue #75 fase 3: correo al dueno cuando llega una solicitud pendiente.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO } from './prueba-d1.ts';
import { REMITENTE } from './avisos.ts';

function conCorreo(falla = (_para: string) => false) {
  const t = tienda();
  const enviados: any[] = [];
  t.env.CORREO = { async send(m: any) { if (falla(m.to)) throw new Error('E_RECIPIENT_NOT_ALLOWED'); enviados.push(m); return { messageId: 'x' }; } } as never;
  const como = (correo: string) => { t.env.DEV_USUARIO = correo; };
  return { ...t, enviados, como };
}

test('solicitud de acceso nueva: un correo a los duenos activos; repetirla no vuelve a avisar', async () => {
  const t = conCorreo();
  t.como('nueva@prueba.mx');
  assert.equal((await t.pedir('/api/solicitudes/acceso', { nombre: 'Rosa', justificacion: 'capturar ropa' })).status, 201);
  await t.esperar();
  assert.equal(t.enviados.length, 1);
  assert.equal(t.enviados[0].to, DUENO);
  assert.equal(t.enviados[0].from.email, REMITENTE);
  assert.match(t.enviados[0].subject, /Rosa/);
  assert.match(t.enviados[0].text, /capturar ropa[\s\S]*https:\/\/caja\.prueba\/cuentas/);
  assert.equal((await t.pedir('/api/solicitudes/acceso', { nombre: 'Rosa', justificacion: 'otra vez' })).status, 200);
  await t.esperar();
  assert.equal(t.enviados.length, 1);
});

test('lo que aprueba el propio dueno no avisa; un correo que falla no tumba la solicitud ni a los otros duenos', async () => {
  const t = conCorreo();
  assert.equal((await t.pedir('/api/descuentos', { tipo: 'porcentaje', valor: 10, motivo: 'x', subtotal: 25000 })).cuerpo.estado, 'aprobada');
  await t.esperar();
  assert.equal(t.enviados.length, 0);

  // Un dueno sin verificar no le quita el aviso a los demas.
  const f = conCorreo((para) => para === 'socio@prueba.mx');
  f.db.prepare("insert into usuarios(correo, roles, activo, creado_en, actualizado_en) values ('socio@prueba.mx', 'dueno', 1, '', '')").run();
  f.como('nueva@prueba.mx');
  assert.equal((await f.pedir('/api/solicitudes/acceso', { nombre: 'Rosa', justificacion: 'capturar' })).status, 201);
  await f.esperar();
  assert.equal(f.db.prepare(`select count(*) n from solicitudes where tipo = 'acceso'`).get()!.n, 1);
  assert.deepEqual(f.enviados.map((m) => m.to), [DUENO]);
});
