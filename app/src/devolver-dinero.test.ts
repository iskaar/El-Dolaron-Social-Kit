// node --test src/devolver-dinero.test.ts
// Devolver dinero lo aprueba el dueño; devolver en cupón lo hace el cajero solo (#837, regla de Isaac del 16/11/2026) contra SQLite real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO, codigoPrueba } from './prueba-d1.ts';
import { VENTANA_CANCELACION_MS } from './cancelaciones.ts';

const TIENDA = 'tienda@prueba.mx';
const ANA = 'ana@prueba.mx';
const PIN_DUENO = '111222';
const PIN_ANA = '482913';
const SUP = 'sup@prueba.mx';
const BETO = 'beto@prueba.mx';
const PIN_SUP = '735190';
const PIN_BETO = '264817';
const VIEJA = VENTANA_CANCELACION_MS + 60_000;

async function montar() {
  const t = tienda();
  const correos: { to: string; subject: string; text: string }[] = [];
  t.env.CORREO = { async send(m: { to: string; subject: string; text: string }) { correos.push(m); return { messageId: 'x' }; } } as never;
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en) values
    ('${TIENDA}', 'Computadora', 'computadora', 1, '', '', ''),
    ('${ANA}', 'Ana', 'cajero', 1, 'Caja 2', '', ''),
    ('${SUP}', 'Sara', 'cajero,supervisor', 1, '', '', ''),
    ('${BETO}', 'Beto', 'cajero', 1, '', '', '')`).run();
  t.db.prepare(`update usuarios set tienda = 'soledad' where roles = 'computadora'`).run();
  await t.pedir('/api/cuentas/pin', { correo: DUENO, pin: PIN_DUENO }, 'PUT');
  await t.pedir('/api/cuentas/pin', { correo: ANA, pin: PIN_ANA }, 'PUT');
  await t.pedir('/api/cuentas/pin', { correo: SUP, pin: PIN_SUP }, 'PUT');
  await t.pedir('/api/cuentas/pin', { correo: BETO, pin: PIN_BETO }, 'PUT');
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  como(TIENDA);
  const token = (await t.pedir('/api/cajeros/entrar', { correo: ANA, pin: PIN_ANA })).cuerpo.token as string;
  const ana = { 'x-cajero': token };
  // Dos piezas de $250: con `forma` distinta de efectivo, la misma venta pagada con tarjeta.
  const vender = async (haceMs = 0, extra: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    const r = await t.pedir('/api/ventas', {
      id, lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], forma_pago: 'efectivo', efectivo: 50000, caja: 'Caja 1', ...extra,
    }, 'POST', ana);
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    if (haceMs) t.db.prepare('update ventas set creado_en = ? where id = ?').run(new Date(Date.now() - haceMs).toISOString(), id);
    return id;
  };
  const linea = async (venta: string) => (await t.pedir(`/api/ventas/${venta}`, undefined, 'GET', ana)).cuerpo.lineas[0].id as number;
  const devolver = (venta: string, lineaId: number, extra: Record<string, unknown> = {}, encabezados: Record<string, string> = ana) =>
    t.pedir(`/api/ventas/${venta}/lineas/${lineaId}/cancelar`,
      { id: crypto.randomUUID(), cantidad: 1, motivo: 'no le quedo', caja: 'Caja 1', ...extra }, 'POST', encabezados);
  const cupon = (venta: string, lineaId: number, extra: Record<string, unknown> = {}) =>
    t.pedir(`/api/ventas/${venta}/cupon`,
      { id: crypto.randomUUID(), lineas: [{ linea: lineaId, cantidad: 1 }], motivo: 'prefiere cambio', caja: 'Caja 1', ...extra }, 'POST', ana);
  const stock = () => (t.db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock;
  const venta = (id: string) => ({ ...t.db.prepare('select devuelto, dolarones_devueltos, devuelto_cupon, cancelada from ventas where id = ?').get(id) } as
    { devuelto: number; dolarones_devueltos: number; devuelto_cupon: number; cancelada: number });
  const devoluciones = () => t.db.prepare('select * from devoluciones').all() as Record<string, any>[];
  const solicitudes = () => t.db.prepare('select * from solicitudes').all() as Record<string, any>[];
  const cortar = (contado: number, caja = 'Caja 2') => t.pedir('/api/cortes',
    { id: crypto.randomUUID(), caja, efectivo_contado: contado, tarjeta_terminal: 0, sin_efectivo: contado === 0 });
  return { ...t, correos, como, ana, vender, linea, devolver, cupon, stock, venta, devoluciones, solicitudes, cortar };
}

test('el cajero devuelve en cupón sin pedir nada al dueño, aun pasados 5 minutos', async () => {
  const { vender, linea, cupon, stock, venta, devoluciones, solicitudes } = await montar();
  const id = await vender(VIEJA);
  const antes = stock();
  const r = await cupon(id, await linea(id));
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.cupon.importe, 25000);
  assert.equal(stock(), antes + 1);
  assert.equal(venta(id).devuelto_cupon, 25000);
  assert.equal(devoluciones()[0].cupon, 25000);
  assert.equal(solicitudes().length, 0);
});

test('el cajero que pide dinero por pieza recibe la exigencia de aprobación: no se mueve dinero, existencia ni historial', async () => {
  const { vender, linea, devolver, stock, venta, devoluciones, solicitudes } = await montar();
  for (const haceMs of [0, VIEJA]) {                       // la excepción de 5 minutos es de cancelar el ticket completo, no de la pieza
    const id = await vender(haceMs);
    const antes = stock();
    const r = await devolver(id, await linea(id));
    assert.equal(r.status, 403);
    assert.equal(r.cuerpo.requiere_aprobacion, true);
    assert.match(r.cuerpo.error, /aprobación del supervisor o del dueño/);
    assert.match(r.cuerpo.error, /cupón/);
    assert.deepEqual(r.cuerpo.duenos, [{ correo: DUENO, nombre: 'Isaac' }, { correo: SUP, nombre: 'Sara' }]);
    assert.equal(stock(), antes);
    assert.deepEqual(venta(id), { devuelto: 0, dolarones_devueltos: 0, devuelto_cupon: 0, cancelada: 0 });
  }
  assert.equal(devoluciones().length, 0);
  assert.equal(solicitudes().length, 0);
});

test('compatibilidad: una caja con la página anterior (sin aprobador ni solicitar) no devuelve dinero y el mensaje dice qué hacer', async () => {
  const { vender, linea, devolver, devoluciones } = await montar();
  const id = await vender();
  const r = await devolver(id, await linea(id), { devolver_en: 'efectivo' });   // el cuerpo exacto de la página anterior
  assert.equal(r.status, 403);
  assert.match(r.cuerpo.error, /Devolver dinero necesita la aprobación del supervisor o del dueño/);
  assert.match(r.cuerpo.error, /Devolver en cupón/);
  assert.match(r.cuerpo.error, /PIN del supervisor o del dueño/);
  assert.equal(devoluciones().length, 0);
});

test('el dueño en la caja (PIN de dueño al entrar) devuelve dinero directo y sin solicitud', async () => {
  const { como, vender, linea, devolver, stock, venta, solicitudes } = await montar();
  const id = await vender(VIEJA);
  const antes = stock();
  como(DUENO);
  const r = await devolver(id, await linea(id), {}, {});
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.devuelto, 25000);
  assert.equal(stock(), antes + 1);
  assert.equal(venta(id).devuelto, 25000);
  assert.equal(solicitudes().length, 0);
});

test('PIN del dueño: devuelve una sola vez a nombre de Ana y deja la solicitud aprobada por pin con el mismo id; un reintento no repite', async () => {
  const { vender, linea, devolver, stock, venta, devoluciones, solicitudes } = await montar();
  const id = await vender(VIEJA);
  const antes = stock();
  const idDev = crypto.randomUUID();
  const l = await linea(id);

  const mal = await devolver(id, l, { id: idDev, aprobador: DUENO, pin: '000000' });
  assert.equal(mal.status, 403);
  assert.equal(devoluciones().length, 0);
  const noDueno = await devolver(id, l, { id: idDev, aprobador: ANA, pin: PIN_ANA });   // Ana tiene PIN pero no es dueña
  assert.equal(noDueno.status, 404);
  assert.equal(devoluciones().length, 0);

  const r = await devolver(id, l, { id: idDev, aprobador: DUENO.toUpperCase(), pin: PIN_DUENO });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(stock(), antes + 1);
  assert.equal(devoluciones()[0].autor, ANA);
  const [s, ...resto] = solicitudes();
  assert.equal(resto.length, 0);
  assert.equal(s.id, idDev);
  assert.equal(s.tipo, 'devolucion');
  assert.equal(s.estado, 'aprobada');
  assert.equal(s.resuelto_por, DUENO);
  assert.equal(JSON.parse(s.datos).via, 'pin');

  const otra = await devolver(id, l, { id: idDev, aprobador: DUENO, pin: PIN_DUENO });
  assert.equal(otra.status, 200);
  assert.equal(otra.cuerpo.duplicada, true);
  assert.equal(stock(), antes + 1);
  assert.equal(venta(id).devuelto, 25000);
  assert.equal(devoluciones().length, 1);
});


test('solicitud remota: queda pendiente sin mover nada; el reintento devuelve la misma; el dueño la ve en la lista', async () => {
  const { como, vender, linea, devolver, stock, venta, devoluciones, solicitudes, pedir, correos, esperar } = await montar();
  const id = await vender(VIEJA);
  const antes = stock();
  const idDev = crypto.randomUUID();
  const l = await linea(id);
  const r = await devolver(id, l, { id: idDev, solicitar: true, devolver_en: 'efectivo' });
  assert.equal(r.status, 202, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.pendiente, true);
  assert.equal(r.cuerpo.solicitud_id, idDev);
  const otra = await devolver(id, l, { id: idDev, solicitar: true, devolver_en: 'efectivo' });
  assert.equal(otra.status, 202);
  assert.equal(otra.cuerpo.solicitud_id, idDev);
  await esperar();
  assert.deepEqual(correos.map((c) => [c.to, c.subject]), [[DUENO, 'Devolución de dinero por aprobar: $250.00']]);   // un solo aviso al dueño
  assert.ok(correos[0].text.startsWith('Ana pide devolver 1 × Ventilador por $250.00 (efectivo) de una venta de $500.00.\nMotivo: no le quedo'));

  assert.equal(stock(), antes);
  assert.deepEqual(venta(id), { devuelto: 0, dolarones_devueltos: 0, devuelto_cupon: 0, cancelada: 0 });
  assert.equal(devoluciones().length, 0);
  const [s, ...resto] = solicitudes();
  assert.equal(resto.length, 0);
  assert.equal(s.tipo, 'devolucion');
  assert.equal(s.estado, 'pendiente');
  assert.equal(s.correo, ANA);
  assert.deepEqual(JSON.parse(s.datos), { venta_id: id, linea_id: l, cantidad: 1, devolver_en: 'efectivo', caja: 'Caja 1', dinero: 25000,
    resumen: '1 × Ventilador por $250.00 (efectivo)', via: 'remoto' });

  // El dueño la ve en la misma lista de /avisos y /cuentas, con su tipo; la lista de acceso de /cuentas no la mezcla.
  como(DUENO);
  const lista = (await pedir('/api/solicitudes/cancelaciones', undefined, 'GET')).cuerpo;
  assert.equal(lista.length, 1);
  assert.equal(lista[0].tipo, 'devolucion');
  assert.equal(lista[0].resumen, '1 × Ventilador por $250.00 (efectivo)');
  assert.equal(lista[0].venta_id, id);
  assert.equal(lista[0].total, 50000);
  const pendientes = (await pedir('/api/cuentas', undefined, 'GET')).cuerpo.solicitudes as { tipo: string }[];
  assert.deepEqual(pendientes.map((x) => x.tipo), ['devolucion']);
});

test('el dueño aprueba: se devuelve exactamente lo pedido una sola vez y el corte resta el efectivo solo desde entonces', async () => {
  const { como, vender, linea, devolver, stock, venta, devoluciones, solicitudes, pedir, ana } = await montar();
  const id = await vender(VIEJA);                              // $500 en la Caja 2 de Ana
  const antes = stock();
  const idDev = crypto.randomUUID();
  const l = await linea(id);
  await devolver(id, l, { id: idDev, solicitar: true, devolver_en: 'efectivo', cantidad: 1 });

  // Pendiente: el corte no resta nada (fondo $500 + venta $500) y la venta se lleva su corte.
  const primero = (await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 2', efectivo_contado: 100000, tarjeta_terminal: 0 }, 'POST', ana)).cuerpo;
  assert.equal(primero.efectivo_devoluciones, 0);
  assert.equal(primero.diferencia, 0);

  // Un cajero no la resuelve.
  assert.equal((await pedir(`/api/solicitudes/${idDev}/resolver`, { aprobar: true }, 'POST', ana)).status, 403);
  assert.equal(solicitudes()[0].estado, 'pendiente');

  como(DUENO);
  const r = await pedir(`/api/solicitudes/${idDev}/resolver`, { aprobar: true });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.estado, 'aprobada');
  assert.equal(r.cuerpo.devuelto, 25000);
  assert.equal(stock(), antes + 1);
  assert.deepEqual(venta(id), { devuelto: 25000, dolarones_devueltos: 0, devuelto_cupon: 0, cancelada: 0 });
  const [d, ...otras] = devoluciones();
  assert.equal(otras.length, 0);
  assert.deepEqual({ id: d.id, autor: d.autor, caja: d.caja, cantidad: d.cantidad, importe: d.importe, forma_pago: d.forma_pago, motivo: d.motivo },
    { id: idDev, autor: ANA, caja: 'Caja 2', cantidad: 1, importe: 25000, forma_pago: 'efectivo', motivo: 'no le quedo' });
  assert.equal(solicitudes()[0].estado, 'aprobada');
  assert.equal(solicitudes()[0].resuelto_por, DUENO);

  // Resolver otra vez no devuelve otra pieza; el reintento de la caja con el mismo id tampoco.
  assert.equal((await pedir(`/api/solicitudes/${idDev}/resolver`, { aprobar: true })).status, 409);
  assert.equal((await devolver(id, l, { id: idDev, solicitar: true })).cuerpo.duplicada, true);
  assert.equal(stock(), antes + 1);
  assert.equal(devoluciones().length, 1);

  // Ya aprobada, el corte siguiente sí resta ese efectivo: fondo $500 - $250 devueltos.
  const siguiente = (await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 2', efectivo_contado: 25000, tarjeta_terminal: 0 }, 'POST', ana)).cuerpo;
  assert.equal(siguiente.efectivo_devoluciones, 25000);
  assert.equal(siguiente.diferencia, 0);
});

test('aprobaciones simultáneas (o aprobar y rechazar a la vez): solo gana una y la pieza se devuelve una sola vez', async () => {
  const { como, vender, linea, devolver, stock, devoluciones, solicitudes, pedir } = await montar();
  const id = await vender(VIEJA);
  const antes = stock();
  const idDev = crypto.randomUUID();
  await devolver(id, await linea(id), { id: idDev, solicitar: true });
  como(DUENO);
  const resultados = await Promise.all([
    pedir(`/api/solicitudes/${idDev}/resolver`, { aprobar: true }),
    pedir(`/api/solicitudes/${idDev}/resolver`, { aprobar: true }),
    pedir(`/api/solicitudes/${idDev}/resolver`, { aprobar: false }),
  ]);
  assert.equal(resultados.filter((r) => r.status === 200).length, 1, JSON.stringify(resultados.map((r) => r.cuerpo)));
  assert.equal(resultados.filter((r) => r.status === 409).length, 2);
  const hechas = solicitudes()[0].estado === 'aprobada' ? 1 : 0;
  assert.equal(devoluciones().length, hechas);
  assert.equal(stock(), antes + hechas);
});

test('el dueño rechaza: no se mueve nada, la caja se entera, y reenviar el mismo folio no devuelve; uno nuevo vuelve a pedir', async () => {
  const { como, vender, linea, devolver, stock, venta, devoluciones, solicitudes, pedir, ana } = await montar();
  const id = await vender(VIEJA);
  const antes = stock();
  const idDev = crypto.randomUUID();
  const l = await linea(id);
  await devolver(id, l, { id: idDev, solicitar: true });
  como(DUENO);
  const r = await pedir(`/api/solicitudes/${idDev}/resolver`, { aprobar: false });
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.estado, 'rechazada');
  assert.equal(stock(), antes);
  assert.equal(venta(id).devuelto, 0);
  assert.equal(devoluciones().length, 0);
  assert.equal(solicitudes()[0].estado, 'rechazada');
  como(TIENDA);
  assert.equal((await pedir(`/api/solicitudes/${idDev}`, undefined, 'GET', ana)).cuerpo.estado, 'rechazada');

  const igual = await devolver(id, l, { id: idDev, solicitar: true });
  assert.equal(igual.status, 409);
  assert.match(igual.cuerpo.error, /rechazada/);
  assert.equal(devoluciones().length, 0);
  assert.equal((await devolver(id, l, { solicitar: true })).status, 202);
});

test('si el ticket cambió mientras tanto (ya se canceló), aprobar da 409 y la solicitud sigue pendiente sin mover nada', async () => {
  const { como, vender, linea, devolver, stock, devoluciones, solicitudes, pedir } = await montar();
  const id = await vender(VIEJA);
  const idDev = crypto.randomUUID();
  await devolver(id, await linea(id), { id: idDev, solicitar: true });
  como(DUENO);
  assert.equal((await pedir(`/api/ventas/${id}/cancelar`, { motivo: 'error', caja: 'Caja 1' })).status, 200);
  const despues = stock();
  const r = await pedir(`/api/solicitudes/${idDev}/resolver`, { aprobar: true });
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /cancelado/);
  assert.equal(solicitudes()[0].estado, 'pendiente');
  assert.equal(devoluciones().length, 0);
  assert.equal(stock(), despues);
});

test('no se pide al dueño lo que la devolución no haría: pieza ajena, cantidad de más o sin motivo se rechazan antes de crear la solicitud', async () => {
  const { vender, linea, devolver, solicitudes } = await montar();
  const id = await vender(VIEJA);
  const l = await linea(id);
  assert.equal((await devolver(id, l + 99, { solicitar: true })).status, 404);
  assert.equal((await devolver(id, l, { solicitar: true, cantidad: 3 })).status, 400);
  assert.equal((await devolver(id, l, { solicitar: true, motivo: ' ' })).status, 400);
  assert.equal(solicitudes().length, 0);
});

test('lo que no es dinero no pide aprobación: la pieza pagada toda con Dolarones regresa al saldo sin dueño; la que tiene dinero sí lo pide', async () => {
  const { db, pedir, ana, vender, linea, devolver, venta, solicitudes } = await montar();
  const socio = (await pedir('/api/socios', { id: crypto.randomUUID(), nombre: 'Socia', telefono: '4449990000', acepta_bases: true, declara_mayor_edad: true }, 'POST', ana)).cuerpo;
  db.prepare(`insert into dolarones_lotes (id, cliente_id, origen, importe, restante, disponible_desde, vence_en, creado_en)
    values (?, ?, 'compra', 100000, 100000, '2000-01-01T00:00:00Z', '2999-01-01T00:00:00Z', '2000-01-01T00:00:00Z')`).run(crypto.randomUUID(), socio.id);
  // Dos piezas ($500) pagadas $250 en dinero y $250 con Dolarones: la primera sale en dinero, la segunda solo en Dolarones.
  const id = await vender(VIEJA, { cliente_id: socio.id, dolarones: 25000, codigo_socio: await codigoPrueba(db, socio.id), efectivo: 25000 });
  const l = await linea(id);
  const sinAprobacion = await devolver(id, l);
  assert.equal(sinAprobacion.status, 403, JSON.stringify(sinAprobacion.cuerpo));
  assert.equal(solicitudes().length, 0);
  assert.equal(venta(id).devuelto, 0);
  const conPin = await devolver(id, l, { aprobador: DUENO, pin: PIN_DUENO });
  assert.equal(conPin.status, 201, JSON.stringify(conPin.cuerpo));
  assert.equal(conPin.cuerpo.devuelto, 25000);
  const segunda = await devolver(id, l);
  assert.equal(segunda.status, 201, JSON.stringify(segunda.cuerpo));
  assert.equal(segunda.cuerpo.devuelto, 0);
  assert.equal(segunda.cuerpo.dolarones, 25000);
});

test('cancelar el ticket completo no cambia: el cajero lo hace solo dentro de 5 minutos; pasado ese tiempo pide aprobación', async () => {
  const { vender, ana, pedir } = await montar();
  const reciente = await vender(60_000);
  assert.equal((await pedir(`/api/ventas/${reciente}/cancelar`, { motivo: 'error de cobro', caja: 'Caja 1' }, 'POST', ana)).status, 200);
  const vieja = await vender(VIEJA);
  const r = await pedir(`/api/ventas/${vieja}/cancelar`, { motivo: 'error de cobro', caja: 'Caja 1' }, 'POST', ana);
  assert.equal(r.status, 403);
  assert.equal(r.cuerpo.requiere_aprobacion, true);
});

/* ---------- supervisor (alcance agregado a #837 el 16/11/2026) ---------- */

test('un supervisor aprueba con su PIN devolver dinero: queda como quien aprobó y la solicitud lleva su cuenta', async () => {
  const { vender, linea, devolver, stock, solicitudes, devoluciones } = await montar();
  const id = await vender(VIEJA);
  const antes = stock();
  const r = await devolver(id, await linea(id), { aprobador: SUP.toUpperCase(), pin: PIN_SUP });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(stock(), antes + 1);
  assert.equal(devoluciones()[0].autor, ANA);
  assert.equal(solicitudes()[0].resuelto_por, SUP);
  assert.equal(solicitudes()[0].estado, 'aprobada');
});

test('un supervisor aprueba con su PIN la cancelación pasados 5 minutos', async () => {
  const { vender, ana, pedir, stock, solicitudes } = await montar();
  const id = await vender(VIEJA);
  const antes = stock();
  const r = await pedir(`/api/ventas/${id}/cancelar`, { motivo: 'error de cobro', caja: 'Caja 1', aprobador: SUP, pin: PIN_SUP }, 'POST', ana);
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(stock(), antes + 2);
  assert.equal(solicitudes()[0].tipo, 'cancelacion');
  assert.equal(solicitudes()[0].resuelto_por, SUP);
});

test('la caja ofrece como aprobadores al dueño y a los supervisores con PIN, no a los cajeros', async () => {
  const { vender, linea, devolver, ana, pedir } = await montar();
  const id = await vender(VIEJA);
  const esperados = [{ correo: DUENO, nombre: 'Isaac' }, { correo: SUP, nombre: 'Sara' }];
  const pieza = await devolver(id, await linea(id));
  assert.deepEqual(pieza.cuerpo.duenos, esperados);
  const ticket = await pedir(`/api/ventas/${id}/cancelar`, { motivo: 'x', caja: 'Caja 1' }, 'POST', ana);
  assert.equal(ticket.status, 403);
  assert.deepEqual(ticket.cuerpo.duenos, esperados);
  assert.match(ticket.cuerpo.error, /supervisor o del dueño/);
});

test('el PIN de un supervisor no vale para descuentos ni cupones (siguen siendo del dueño)', async () => {
  const { pedir, ana } = await montar();
  const descuento = await pedir('/api/descuentos', { tipo: 'porcentaje', valor: 10, motivo: 'cliente frecuente', subtotal: 25000, aprobador: SUP, pin: PIN_SUP }, 'POST', ana);
  assert.equal(descuento.status, 404, JSON.stringify(descuento.cuerpo));
  const cupon = await pedir('/api/cupones', { id: crypto.randomUUID(), importe: 10000, motivo: 'cortesía', aprobador: SUP, pin: PIN_SUP }, 'POST', ana);
  assert.equal(cupon.status, 404, JSON.stringify(cupon.cuerpo));
  assert.deepEqual((await pedir('/api/descuentos/duenos', undefined, 'GET', ana)).cuerpo, [{ correo: DUENO, nombre: 'Isaac' }]);
});

test('el PIN de otro cajero no aprueba, y nadie se aprueba a sí mismo', async () => {
  const { vender, linea, devolver, devoluciones, pedir, ana } = await montar();
  const id = await vender(VIEJA);
  const l = await linea(id);
  assert.equal((await devolver(id, l, { aprobador: BETO, pin: PIN_BETO })).status, 404);   // cajero sin rol de supervisor
  assert.equal((await devolver(id, l, { aprobador: ANA, pin: PIN_ANA })).status, 404);     // la propia cajera que cobra
  const ticket = await pedir(`/api/ventas/${id}/cancelar`, { motivo: 'x', caja: 'Caja 1', aprobador: ANA, pin: PIN_ANA }, 'POST', ana);
  assert.equal(ticket.status, 404);
  assert.equal(devoluciones().length, 0);
});

test('el bloqueo por PIN malos es el mismo de siempre, también para un supervisor', async () => {
  const { vender, linea, devolver, devoluciones } = await montar();
  const id = await vender(VIEJA);
  const l = await linea(id);
  for (let i = 0; i < 5; i++) await devolver(id, l, { aprobador: SUP, pin: '000000' });
  const r = await devolver(id, l, { aprobador: SUP, pin: PIN_SUP });
  assert.equal(r.status, 423);
  assert.equal(devoluciones().length, 0);
});

test('si quien cobra es supervisor, devuelve y cancela directo, como el dueño, sin solicitud', async () => {
  const { como, pedir, vender, linea, devolver, stock, solicitudes, devoluciones } = await montar();
  como(TIENDA);
  const token = (await pedir('/api/cajeros/entrar', { correo: SUP, pin: PIN_SUP })).cuerpo.token as string;
  const sup = { 'x-cajero': token };
  const id = await vender(VIEJA);
  const antes = stock();
  const r = await devolver(id, await linea(id), {}, sup);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(devoluciones()[0].autor, SUP);
  const completa = await pedir(`/api/ventas/${id}/cancelar`, { motivo: 'error', caja: 'Caja 1' }, 'POST', sup);
  assert.equal(completa.status, 200, JSON.stringify(completa.cuerpo));
  assert.equal(stock(), antes + 2);
  assert.equal(solicitudes().length, 0);
});

test('solo el dueño asigna el rol de supervisor; la solicitud a distancia sigue siendo del dueño', async () => {
  const { como, pedir, ana, vender, linea, devolver } = await montar();
  const asignar = (encabezados: Record<string, string>) =>
    pedir('/api/cuentas', { correo: BETO, nombre: 'Beto', roles: ['cajero', 'supervisor'] }, 'PUT', encabezados);
  assert.equal((await asignar(ana)).status, 403);                       // un cajero no se asigna ni asigna a otro
  como(SUP);
  assert.equal((await asignar({})).status, 403);                        // ni un supervisor
  como(DUENO);
  const r = await asignar({});
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual(r.cuerpo.roles, ['cajero', 'supervisor']);
  assert.ok((await pedir('/api/cuentas', undefined, 'GET')).cuerpo.roles.includes('supervisor'));

  // Un supervisor no resuelve solicitudes a distancia (/avisos): esas siguen siendo del dueño.
  como(TIENDA);
  const id = await vender(VIEJA);
  const idDev = crypto.randomUUID();
  await devolver(id, await linea(id), { id: idDev, solicitar: true });
  como(SUP);
  assert.equal((await pedir(`/api/solicitudes/${idDev}/resolver`, { aprobar: true }, 'POST')).status, 403);
  void ana;
});
