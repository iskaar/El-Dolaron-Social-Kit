// node --test src/venta-en-mano.test.ts
// Issue #832: «La tengo en la mano». Una pieza con existencia 0 que el cliente trae se vende con un ajuste auditado dentro del MISMO batch de la
// venta, condicionado a la existencia que vio la caja. SQLite real (schema + todas las migraciones), con sus disparadores de existencia no negativa.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { permiso } from './cuentas.ts';
import { sentenciasEnMano, type MarcaEnMano } from './venta-en-mano.ts';

const PC = 'pc@prueba.mx';
const ANA = 'ana@prueba.mx';
const CERO = 'b2222222-2222-4222-8222-222222222222';     // Lámpara: $100, existencia 0
const BANDA = 'c3333333-3333-4333-8333-333333333333';
const EN_MANO = { motivo: 'otra_etiqueta', esperado: 0 };

function montar(tiendaPc = 'soledad') {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, tienda, creado_en, actualizado_en) values
    (?, 'Computadora', 'computadora', 1, '', ?, '', ''), (?, 'Ana', 'cajero', 1, '', ?, '', '')`).run(PC, tiendaPc, ANA, tiendaPc);   // #850: Ana es de la tienda de la terminal
  t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en)
    values (?, 'ED-000002', 'Lámpara', 10000, 0, 'S40', '', '')`).run(CERO);
  t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, sin_inventario, semana_ingreso, creado_en, actualizado_en)
    values (?, 'TESTBANDA', 'Juguetes $49', 4900, 0, 1, 'S40', '', '')`).run(BANDA);
  const correos: { to: string; subject: string; text: string }[] = [];
  t.env.CORREO = { async send(m: { to: string; subject: string; text: string }) { correos.push(m); return { messageId: 'x' }; } } as never;
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  const entrar = async () => {
    como(DUENO);
    await t.pedir('/api/cuentas/pin', { correo: ANA, pin: '482913' }, 'PUT');
    como(PC);
    return (await t.pedir('/api/cajeros/entrar', { correo: ANA, pin: '482913' })).cuerpo.token as string;
  };
  const stock = (id = CERO) => (t.db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock;
  const enSucursal = (id = CERO, de = 'salk') => (t.db.prepare('select unidades from existencia_tienda where producto_id = ? and tienda = ?').get(id, de) as { unidades: number } | undefined)?.unidades;
  const ajustes = () => t.db.prepare(`select * from conteo_ajustes where motivo = 'hallada_en_caja' order by id`).all() as Record<string, any>[];
  const ventas = () => (t.db.prepare('select count(*) n from ventas').get() as { n: number }).n;
  const cuerpo = (lineas: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    ({ id: crypto.randomUUID(), lineas, forma_pago: 'efectivo', efectivo: 100000, caja: tiendaPc === 'soledad' ? 'Caja 1' : 'Salk 1', ...extra });
  const vender = (token: string, c: Record<string, unknown>) => t.pedir('/api/ventas', c, 'POST', { 'x-cajero': token });
  return { ...t, correos, como, entrar, stock, enSucursal, ajustes, ventas, cuerpo, vender };
}
const mano = (producto_id = CERO, extra: Record<string, unknown> = {}) => ({ producto_id, cantidad: 1, en_mano: EN_MANO, ...extra });

test('Soledad: la venta con la pieza en la mano deja la existencia en 0, el ajuste auditado y el resto del ticket igual', async () => {
  const t = montar();
  const token = await t.entrar();
  const c = t.cuerpo([mano(), { producto_id: PRODUCTO, cantidad: 2 }], { efectivo: 60000 });
  const r = await t.vender(token, c);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.total, 10000 + 2 * 25000);
  assert.equal(t.stock(), 0, 'neto cero: subió 1 y la venta la bajó');
  assert.equal(t.stock(PRODUCTO), 48, 'el resto del ticket baja como siempre');
  const [a, ...otros] = t.ajustes();
  assert.equal(otros.length, 0);
  assert.deepEqual({ id: a.id, p: a.producto_id, codigo: a.codigo, nombre: a.nombre, cantidad: a.cantidad, antes: a.antes, despues: a.despues,
    por: a.ajustado_por, tienda: a.tienda, venta: a.venta_id, caja: a.caja, razon: a.razon },
  { id: `${c.id}:${CERO}`, p: CERO, codigo: 'ED-000002', nombre: 'Lámpara', cantidad: 1, antes: 0, despues: 1, por: ANA, tienda: 'soledad', venta: c.id, caja: 'Caja 1', razon: 'otra_etiqueta' });
  assert.match(a.ajustado_en, /^\d{4}-\d\d-\d\dT/);
  // El historial de la pieza lo muestra: +1 hallada_en_caja y -1 venta.
  const mov = t.db.prepare('select tipo, cantidad, tienda, referencia from movimientos_existencia where producto_id = ? order by cantidad').all(CERO) as any[];
  assert.deepEqual(mov.map((m) => [m.tipo, m.cantidad, m.tienda, m.referencia]), [['venta', -1, 'soledad', c.id], ['hallada_en_caja', 1, 'soledad', `${c.id}:${CERO}`]]);
  // No cuenta como entrada de captura ni como baja del conteo: los lectores filtran por motivo.
  assert.equal((t.db.prepare(`select count(*) n from conteo_ajustes where motivo in ('entrada', 'robo', 'merma', 'error de captura')`).get() as { n: number }).n, 0);
});

test('un reintento del mismo folio responde duplicada y no ajusta dos veces; el folio con otra marca o sin marca es otra venta (la marca está en el hash)', async () => {
  const t = montar();
  const token = await t.entrar();
  const c = t.cuerpo([mano()]);
  assert.equal((await t.vender(token, c)).status, 201);
  const otra = await t.vender(token, c);
  assert.equal(otra.status, 200);
  assert.equal(otra.cuerpo.duplicada, true);
  assert.equal(t.stock(), 0);
  assert.equal(t.ajustes().length, 1);
  assert.equal(t.ventas(), 1);
  const otroMotivo = await t.vender(token, { ...c, lineas: [mano(CERO, { en_mano: { motivo: 'no_se', esperado: 0 } })] });
  assert.equal(otroMotivo.status, 409);
  assert.match(otroMotivo.cuerpo.error, /folio ya pertenece a otra venta/);
  const sinMarca = await t.vender(token, { ...c, lineas: [{ producto_id: CERO, cantidad: 1 }] });
  assert.equal(sinMarca.status, 409);
  assert.equal(t.ajustes().length, 1);
  assert.equal(t.stock(), 0);
});

test('un reintento concurrente que pierde el insert de la venta no deja ajuste ni existencia de más', async () => {
  const t = montar();
  const token = await t.entrar();
  const c = t.cuerpo([mano()]);
  assert.equal((await t.vender(token, c)).status, 201);
  // Como si otra solicitud con el mismo folio hubiera ganado entre la lectura y el batch: el insert de la venta choca y todo se deshace.
  const lectura = t.env.DB.prepare;
  let primera = true;
  t.env.DB.prepare = ((sql: string) => {
    const s = lectura(sql);
    if (primera && /select pedido_hash, imprimir_en/.test(sql)) { primera = false; return { bind: () => ({ first: async () => null }) } as never; }
    return s;
  }) as never;
  const r = await t.vender(token, c);
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.duplicada, true);
  assert.equal(t.stock(), 0);
  assert.equal(t.ajustes().length, 1);
});

test('si alguien subió la existencia entre lo que vio la caja y el cobro, no se ajusta de más: la baja normal vende la que ya hay', async () => {
  const t = montar();
  const token = await t.entrar();
  t.db.prepare('update productos set stock = 1 where id = ?').run(CERO);   // otra persona la repuso: la caja aún creía 0
  const r = await t.vender(token, t.cuerpo([mano()]));
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(t.stock(), 0, 'se vendió la unidad que ya estaba; no se subió nada');
  assert.equal(t.ajustes().length, 0);
  assert.equal(t.db.prepare(`select count(*) n from movimientos_existencia where producto_id = ? and tipo = 'hallada_en_caja'`).get(CERO)!.n, 0);
  await t.esperar();
  assert.equal(t.correos.length, 0, 'sin ajuste no hay aviso a gerencia');
});

/** Como si el impedimento apareciera DESPUÉS de la lectura previa: se agrega justo antes de que corra el batch de la venta. */
function antesDelBatch(t: ReturnType<typeof montar>, hacer: () => void) {
  const batch = t.env.DB.batch.bind(t.env.DB);
  t.env.DB.batch = (async (sentencias: never[]) => { hacer(); return batch(sentencias); }) as never;
}
const apartar = (t: ReturnType<typeof montar>, id = CERO) => t.db.exec(`insert into pedidos (id, folio, cliente, telefono, entrega, vendedora, estado, vence_en, anticipo, saldo, forma_pago, saldo_vence_en, creado_en, actualizado_en)
  values ('ped-${id}', 21, 'X', '4441234567', 'tienda', 'portal', 'apartado', 'z', 0, 0, 'transferencia', 'z', '', '');
  insert into pedido_lineas (pedido_id, producto_id, cantidad, precio) values ('ped-${id}', '${id}', 1, 10000)`);
const enBulto = (t: ReturnType<typeof montar>, estado = 'cerrado', origen = 'soledad', destino = 'salk', id = CERO) => t.db.exec(`
  insert into bultos (id, folio, origen, destino, estado, creado_por, creado_en) values ('bu-${id}', 'BU-K7Q2M', '${origen}', '${destino}', 'abierto', 'x', '');
  insert into bulto_lineas (id, bulto_id, producto_id, cantidad, creado_por, creado_en) values ('bl-${id}', 'bu-${id}', '${id}', 1, 'x', '');
  ${estado === 'abierto' ? '' : `update bultos set estado = '${estado}' where id = 'bu-${id}'`}`);
const cancelacionPendiente = (t: ReturnType<typeof montar>, ventaId: string) => t.db.prepare(`insert into solicitudes (id, tipo, correo, nombre, justificacion, datos, estado, creado_en)
  values (?, 'cancelacion', 'x', '', 'x', ?, 'pendiente', '')`).run(crypto.randomUUID(), JSON.stringify({ venta_id: ventaId }));

test('si la guarda del batch bloquea el ajuste (apartado, orden de ML, bulto o cancelación pendiente aparecidos tras la lectura previa), la venta falla y el 409 nombra la pieza', async () => {
  const casos: [string, (t: ReturnType<typeof montar>) => void][] = [
    ['apartado', (t) => apartar(t)],
    ['orden de ML', (t) => t.db.exec(`insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values ('o', 'i', '${CERO}', 1, 'descontada', 1, '')`)],
    ['bulto', (t) => enBulto(t)],
    ['cancelación pendiente', (t) => { t.db.prepare('insert into ventas (id, total, forma_pago, efectivo, cambio, creado_en, registrado_en) values (?, 1, ?, 1, 0, ?, ?)').run('v-vieja', 'efectivo', '', '');
      t.db.prepare('insert into venta_lineas (venta_id, producto_id, codigo, nombre, precio, cantidad) values (?, ?, ?, ?, 1, 1)').run('v-vieja', CERO, 'ED-000002', 'Lámpara');
      cancelacionPendiente(t, 'v-vieja'); }],
  ];
  for (const [que, impedimento] of casos) {
    const t = montar();
    const token = await t.entrar();
    antesDelBatch(t, () => impedimento(t));
    const r = await t.vender(token, t.cuerpo([mano(), { producto_id: PRODUCTO, cantidad: 1 }], { efectivo: 40000 }));
    assert.equal(r.status, 409, `${que}: ${JSON.stringify(r.cuerpo)}`);
    assert.match(r.cuerpo.error, /Quita Lámpara: ya no está disponible\./, que);
    assert.equal(r.cuerpo.codigo, 'ED-000002', que);
    assert.equal(t.stock(), 0, que);
    assert.equal(t.stock(PRODUCTO), 50, `${que}: el ticket completo se deshace`);
    assert.equal(t.ajustes().length, 0, que);
    assert.equal((t.db.prepare('select count(*) n from ventas where id <> ?').get('v-vieja') as { n: number }).n, 0, que);
  }
});

test('con una línea marcada y otra sin existencia que sí falla, el ticket completo se deshace: ni venta ni ajuste', async () => {
  const t = montar();
  const token = await t.entrar();
  const OTRA = 'd4444444-4444-4444-8444-444444444444';
  t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en) values (?, 'ED-000004', 'Sin marcar', 5000, 0, 'S40', '', '')`).run(OTRA);
  const r = await t.vender(token, t.cuerpo([mano(), { producto_id: OTRA, cantidad: 1 }]));
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /Quita Sin marcar: ya no está disponible\./, 'la marcada con la condición vigente no es la que falta');
  assert.equal(t.ventas(), 0);
  assert.equal(t.ajustes().length, 0);
  assert.equal(t.stock(), 0);
});

test('sin la marca, una pieza sin existencia se rechaza como siempre', async () => {
  const t = montar();
  const token = await t.entrar();
  const r = await t.vender(token, t.cuerpo([{ producto_id: CERO, cantidad: 1 }]));
  assert.equal(r.status, 409);
  assert.equal(t.ajustes().length, 0);
  assert.equal(t.ventas(), 0);
});

test('sucursal: ajusta y baja SU existencia (existencia_tienda) y no toca productos.stock', async () => {
  const t = montar('salk');
  const token = await t.entrar();
  t.db.prepare('update productos set stock = 5 where id = ?').run(CERO);   // Soledad sí tiene; la sucursal nunca la recibió
  const c = t.cuerpo([mano()]);
  const r = await t.vender(token, c);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(t.stock(), 5, 'Soledad no se toca');
  assert.equal(t.enSucursal(), 0);
  const [a] = t.ajustes();
  assert.deepEqual({ tienda: a.tienda, antes: a.antes, despues: a.despues, caja: a.caja, venta: a.venta_id }, { tienda: 'salk', antes: 0, despues: 1, caja: 'Salk 1', venta: c.id });
  const mov = t.db.prepare(`select tipo, cantidad, tienda from movimientos_existencia where producto_id = ? and tipo in ('hallada_en_caja', 'venta') order by cantidad`).all(CERO) as any[];
  assert.deepEqual(mov.map((m) => [m.tipo, m.cantidad, m.tienda]), [['venta', -1, 'salk'], ['hallada_en_caja', 1, 'salk']]);
});

test('sucursal: si ya había una unidad ahí cuando se cobró, no se ajusta y se vende esa', async () => {
  const t = montar('salk');
  const token = await t.entrar();
  t.db.prepare(`insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, 'salk', 1, '')`).run(CERO);
  const r = await t.vender(token, t.cuerpo([mano()]));
  assert.equal(r.status, 201);
  assert.equal(t.enSucursal(), 0);
  assert.equal(t.ajustes().length, 0);
});

test('rechazos antes del batch, con lo que hay que hacer, y sin cambiar nada', async () => {
  const t = montar();
  const token = await t.entrar();
  const INCOMPLETA = 'e5555555-5555-4555-8555-555555555555';
  const ids = { D: 'f6666666-6666-4666-8666-666666666666', DESCARTADA: 'a7777777-7777-4777-8777-777777777777', APARTADA: '18888888-8888-4888-8888-888888888888',
    ML: '29999999-9999-4999-8999-999999999999', SINPRECIO: INCOMPLETA, SINCODIGO: '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const alta = (id: string, codigo: string | null, precio: number, extra = '') => t.db.exec(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en)
    values ('${id}', ${codigo ? `'${codigo}'` : 'null'}, 'Pieza ${codigo}', ${precio}, 0, 'S40', '', '');${extra}`);
  alta(ids.D, 'ED-000010', 5000, `update productos set estado_fisico = 'caducado' where id = '${ids.D}';`);
  alta(ids.DESCARTADA, 'ED-000011', 5000, `update productos set estado_analisis = 'descartado' where id = '${ids.DESCARTADA}';`);
  alta(ids.APARTADA, 'ED-000012', 5000);
  t.db.exec(`insert into pedidos (id, folio, cliente, telefono, entrega, vendedora, estado, vence_en, anticipo, saldo, forma_pago, saldo_vence_en, creado_en, actualizado_en)
    values ('ped1', 17, 'X', '4441234567', 'tienda', 'portal', 'apartado', 'z', 0, 0, 'transferencia', 'z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
    insert into pedido_lineas (pedido_id, producto_id, cantidad, precio) values ('ped1', '${ids.APARTADA}', 1, 5000);`);
  alta(ids.ML, 'ED-000013', 5000);
  t.db.exec(`insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values ('o1', 'i1', '${ids.ML}', 1, 'descontada', 1, '2026-11-16T10:00:00Z')`);
  alta(ids.SINPRECIO, 'ED-000014', 0);
  alta(ids.SINCODIGO, null, 5000);
  const casos: [string, string, number, RegExp][] = [
    ['banda', BANDA, 409, /no lleva existencia.*cóbrala normal/],
    ['grado D', ids.D, 400, /caducada \(grado D\)/],   // la rechaza prepararLineas, antes que la marca
    ['descartada', ids.DESCARTADA, 409, /descartada: no se vende/],
    ['apartada', ids.APARTADA, 409, /Apartada en P-17\. Cóbrala con ese folio \(escribe P-17\) o avisa al encargado\./],
    ['Mercado Libre', ids.ML, 409, /venta de Mercado Libre por atender.*Avisa al encargado/],
    ['sin precio', ids.SINPRECIO, 409, /no tiene etiqueta o precio.*Avisa al encargado/],
    ['sin código', ids.SINCODIGO, 409, /no tiene etiqueta o precio/],
  ];
  for (const [que, id, status, mensaje] of casos) {
    const r = await t.vender(token, t.cuerpo([mano(id)]));
    assert.equal(r.status, status, `${que}: ${JSON.stringify(r.cuerpo)}`);
    assert.match(r.cuerpo.error, mensaje, que);
  }
  assert.equal(t.ventas(), 0);
  assert.equal(t.ajustes().length, 0);
  for (const id of Object.values(ids)) assert.equal(t.stock(id), 0, id);
  assert.equal(t.stock(BANDA), 0);
});

test('marca mal formada: motivo desconocido, existencia no entera, esperado mayor o igual a lo que se vende o la pieza repetida', async () => {
  const t = montar();
  const token = await t.entrar();
  for (const [que, linea] of [
    ['motivo', mano(CERO, { en_mano: { motivo: 'porque sí', esperado: 0 } })],
    ['sin esperado', mano(CERO, { en_mano: { motivo: 'no_se' } })],
    ['esperado fraccionario', mano(CERO, { en_mano: { motivo: 'no_se', esperado: 0.5 } })],
    ['esperado negativo', mano(CERO, { en_mano: { motivo: 'no_se', esperado: -1 } })],
    ['no es objeto', mano(CERO, { en_mano: true })],
    ['nulo', mano(CERO, { en_mano: null })],
    ['esperado suficiente', mano(CERO, { en_mano: { motivo: 'no_se', esperado: 1 } })],
    ['esperado distinto de 0 aunque falte', mano(CERO, { cantidad: 2, en_mano: { motivo: 'no_se', esperado: 1 } })],
    ['más de una pieza', mano(CERO, { cantidad: 2 })],
  ] as const) {
    const r = await t.vender(token, t.cuerpo([linea]));
    assert.equal(r.status, 400, `${que}: ${JSON.stringify(r.cuerpo)}`);
  }
  const repetida = await t.vender(token, t.cuerpo([mano(), { producto_id: CERO, cantidad: 1 }]));
  assert.equal(repetida.status, 400);
  assert.equal(t.ventas(), 0);
  assert.equal(t.ajustes().length, 0);
});

test('venta y cancelación: la existencia queda en 1 (la unidad existe y vuelve al piso), sin contarla dos veces', async () => {
  const t = montar();
  const token = await t.entrar();
  const c = t.cuerpo([mano()]);
  assert.equal((await t.vender(token, c)).status, 201);
  assert.equal(t.stock(), 0);
  const cancelada = await t.pedir(`/api/ventas/${c.id}/cancelar`, { motivo: 'error de cobro', caja: 'Caja 1' }, 'POST', { 'x-cajero': token });
  assert.equal(cancelada.status, 200, JSON.stringify(cancelada.cuerpo));
  // +1 (el ajuste: la unidad estaba aunque el sistema no lo supiera) -1 (venta) +1 (cancelación) = 1 unidad real en el piso.
  assert.equal(t.stock(), 1);
  assert.equal(t.ajustes().length, 1, 'cancelar no deshace ni repite el ajuste');
  const suma = (t.db.prepare('select sum(cantidad) n from movimientos_existencia where producto_id = ?').get(CERO) as { n: number }).n;
  assert.equal(suma, 1, 'los movimientos de la pieza suman lo que dice productos.stock');
});

test('gerencia se entera después: un solo aviso por venta con pieza, motivo y caja; ninguno cuando no se ajustó', async () => {
  const t = montar();
  const token = await t.entrar();
  assert.equal((await t.vender(token, t.cuerpo([mano(CERO, { en_mano: { motivo: 'devuelta_o_apartada', esperado: 0 } })]))).status, 201);
  await t.esperar();
  assert.equal(t.correos.length, 1);
  assert.equal(t.correos[0].to, DUENO);
  assert.equal(t.correos[0].subject, 'Pieza vendida sin existencia');
  assert.match(t.correos[0].text, /ED-000002 Lámpara \(motivo: Estaba devuelta o apartada\)/);
  assert.match(t.correos[0].text, /Caja 1, Soledad/);
  assert.match(t.correos[0].text, /\/avisos$/);
  // El reintento (duplicada) no vuelve a avisar.
});

test('lista de gerencia en /avisos: solo él, solo los últimos 7 días, con tienda, caja, cajero, motivo y si se canceló', async () => {
  const t = montar();
  const token = await t.entrar();
  assert.deepEqual(permiso('/api/ventas-sin-existencia', 'GET'), []);   // por omisión, solo gerencia (como /api/ventas-rechazadas)
  const c = t.cuerpo([mano()]);
  assert.equal((await t.vender(token, c)).status, 201);
  t.db.prepare(`insert into conteo_ajustes (id, producto_id, codigo, nombre, motivo, cantidad, antes, despues, ajustado_por, ajustado_en, venta_id)
    values ('vieja:x', ?, 'ED-000002', 'Lámpara', 'hallada_en_caja', 1, 0, 1, 'x', ?, 'vieja')`).run(CERO, new Date(Date.now() - 8 * 86_400_000).toISOString());
  t.db.prepare(`insert into conteo_ajustes (id, producto_id, codigo, nombre, motivo, cantidad, antes, despues, ajustado_por, ajustado_en) values ('otro', ?, 'ED-000002', 'Lámpara', 'entrada', 1, 0, 1, 'x', ?)`)
    .run(CERO, new Date().toISOString());
  assert.equal((await t.pedir('/api/ventas-sin-existencia', undefined, 'GET', { 'x-cajero': token })).status, 403);
  t.como(DUENO);
  const lista = await t.pedir('/api/ventas-sin-existencia', undefined, 'GET');
  assert.equal(lista.status, 200);
  const filas = lista.cuerpo as unknown as Record<string, any>[];
  assert.equal(filas.length, 1);
  assert.deepEqual({ v: filas[0].venta_id, codigo: filas[0].codigo, faltante: filas[0].faltante, antes: filas[0].antes, despues: filas[0].despues, cajero: filas[0].cajero,
    caja: filas[0].caja, tienda: filas[0].tienda_nombre, razon: filas[0].razon_texto, cancelada: filas[0].cancelada },
  { v: c.id, codigo: 'ED-000002', faltante: 1, antes: 0, despues: 1, cajero: ANA, caja: 'Caja 1', tienda: 'Soledad', razon: 'Tiene otra etiqueta igual', cancelada: false });
  await t.pedir(`/api/ventas/${c.id}/cancelar`, { motivo: 'error de cobro', caja: 'Caja 1' }, 'POST', { 'x-cajero': token });
  assert.equal(((await t.pedir('/api/ventas-sin-existencia', undefined, 'GET')).cuerpo as unknown as any[])[0].cancelada, true);
});

test('una venta sin marca no cambia: mismo hash que antes y ningún renglón nuevo', async () => {
  const t = montar();
  const token = await t.entrar();
  const c = t.cuerpo([{ producto_id: PRODUCTO, cantidad: 1 }], { efectivo: 25000 });
  assert.equal((await t.vender(token, c)).status, 201);
  const esperado = JSON.stringify({ lineas: [[PRODUCTO, 1]], forma_pago: 'efectivo', efectivo: 25000, creado_en: null, cliente_id: null, dolarones: 0,
    codigo_socio: '', codigo_vale: '', caja: 'Caja 1' });
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(esperado)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal((t.db.prepare('select pedido_hash h from ventas where id = ?').get(c.id) as { h: string }).h, hash);
  assert.equal(t.ajustes().length, 0);
});

test('las condiciones del batch bastan por sí solas (la lectura previa no es la que protege): apartada, orden de Mercado Libre, folio repetido o existencia distinta', async () => {
  const t = montar();
  const marca = (id: string, extra: Partial<MarcaEnMano> = {}): MarcaEnMano => ({ producto_id: id, codigo: 'x', nombre: 'x', cantidad: 1, esperado: 0, faltante: 1, motivo: 'no_se', otras: '', ...extra });
  const correr = async (m: MarcaEnMano, venta = crypto.randomUUID()) => {
    const r = await t.env.DB.batch(sentenciasEnMano(t.env, { tienda: 'soledad', ventaId: venta, correo: ANA, caja: 'Caja 1', ahora: new Date().toISOString(), marcas: [m] }));
    return { cambios: r[0].meta.changes, venta };
  };
  assert.equal((await correr(marca(CERO))).cambios, 1, 'sin impedimentos sí ajusta');
  t.db.prepare('update productos set stock = 0').run();
  t.db.exec(`insert into pedidos (id, folio, cliente, telefono, entrega, vendedora, estado, vence_en, anticipo, saldo, forma_pago, saldo_vence_en, creado_en, actualizado_en)
    values ('ped1', 3, 'X', '4441234567', 'tienda', 'portal', 'apartado', 'z', 0, 0, 'transferencia', 'z', '', '');
    insert into pedido_lineas (pedido_id, producto_id, cantidad, precio) values ('ped1', '${CERO}', 1, 10000)`);
  assert.equal((await correr(marca(CERO))).cambios, 0, 'apartada');
  t.db.exec(`update pedidos set estado = 'vencido'`);
  t.db.prepare('update productos set stock = 50 where id = ?').run(PRODUCTO);
  assert.equal((await correr(marca(PRODUCTO, { esperado: 0 }))).cambios, 0, 'otra existencia (50 ≠ 0)');
  t.db.exec(`insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values ('o', 'i', '${CERO}', 1, 'descontada', 1, '')`);
  assert.equal((await correr(marca(CERO))).cambios, 0, 'orden de ML por atender');
  t.db.exec(`update ml_ventas set atendida_en = 'hoy'`);
  const { venta } = await correr(marca(CERO));
  t.db.prepare('update productos set stock = 0').run();
  assert.equal((await correr(marca(CERO), venta)).cambios, 0, 'mismo folio y pieza: ya se ajustó una vez');
  assert.equal(t.ajustes().length, 2, 'solo los dos que sí aplicaron (el primero y el de la orden atendida)');
});

test('las mismas condiciones protegen en una sucursal, también cuando la fila de existencia_tienda ya se creó en el mismo batch', async () => {
  const t = montar('salk');
  const marca = (id: string): MarcaEnMano => ({ producto_id: id, codigo: 'x', nombre: 'x', cantidad: 1, esperado: 0, faltante: 1, motivo: 'no_se', otras: '' });
  const correr = async () => {
    const r = await t.env.DB.batch(sentenciasEnMano(t.env, { tienda: 'salk', ventaId: crypto.randomUUID(), correo: ANA, caja: 'Salk 1', ahora: new Date().toISOString(), marcas: [marca(CERO)] }));
    return r.map((x) => x.meta.changes);   // [asegurar fila, ajuste, rastro]
  };
  const unidades = () => (t.db.prepare('select unidades from existencia_tienda where producto_id = ? and tienda = ?').get(CERO, 'salk') as { unidades: number } | undefined)?.unidades;
  apartar(t);
  assert.deepEqual(await correr(), [1, 0, 0], 'apartada: la fila se asegura en 0 y nada más');
  assert.equal(unidades(), 0);
  assert.deepEqual((await correr()).slice(1), [0, 0], 'con la fila ya creada, igual');
  t.db.exec(`update pedidos set estado = 'cancelado'`);
  t.db.exec(`insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values ('o', 'i', '${CERO}', 1, 'recibida', 0, '')`);
  assert.deepEqual((await correr()).slice(1), [0, 0], 'orden de ML por atender');
  t.db.exec(`update ml_ventas set atendida_en = 'hoy'`);
  enBulto(t, 'abierto');
  assert.deepEqual((await correr()).slice(1), [0, 0], 'bulto abierto');
  t.db.exec(`update bultos set estado = 'cerrado'`);
  assert.deepEqual((await correr()).slice(1), [0, 0], 'bulto cerrado');
  t.db.exec(`update bultos set estado = 'recibido'`);
  assert.deepEqual((await correr()).slice(1), [1, 1], 'bulto ya recibido: ya no impide');
  assert.equal(unidades(), 1);
  assert.equal(t.ajustes().length, 1);
});

test('una pieza que va en un bulto sin recibir no se vende «en la mano», en el origen ni en el destino, y dice qué bulto recibir', async () => {
  for (const [terminal, que] of [['soledad', 'origen'], ['salk', 'destino']] as const) {
    for (const estado of ['abierto', 'cerrado']) {
      const t = montar(terminal);
      const token = await t.entrar();
      enBulto(t, estado);
      const r = await t.vender(token, t.cuerpo([mano()]));
      assert.equal(r.status, 409, `${que} ${estado}: ${JSON.stringify(r.cuerpo)}`);
      assert.match(r.cuerpo.error, /Va en el bulto BU-K7Q2M: recíbelo primero en «Bultos»\./);
      assert.equal(t.ventas(), 0);
      assert.equal(t.ajustes().length, 0);
      assert.equal(t.stock(), 0);
    }
  }
  // Un bulto recibido, o la pieza quitada de él, ya no la retiene.
  const t = montar();
  const token = await t.entrar();
  enBulto(t, 'abierto');
  t.db.exec(`update bulto_lineas set quitada_en = 'hoy'`);
  assert.equal((await t.vender(token, t.cuerpo([mano()]))).status, 201);
});

test('una cancelación pendiente de una venta de esta pieza la frena; resuelta o de otra pieza, no', async () => {
  const t = montar();
  const token = await t.entrar();
  t.db.prepare('update productos set stock = 1 where id = ?').run(CERO);
  const anterior = t.cuerpo([{ producto_id: CERO, cantidad: 1 }]);
  assert.equal((await t.vender(token, anterior)).status, 201);
  cancelacionPendiente(t, anterior.id as string);
  const r = await t.vender(token, t.cuerpo([mano()]));
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /Hay una cancelación pendiente de una venta de esta pieza: espera la respuesta de gerencia\./);
  assert.equal(t.ajustes().length, 0);
  // La misma pendiente no frena otra pieza.
  const otra = await t.vender(token, t.cuerpo([{ producto_id: PRODUCTO, cantidad: 1 }], { efectivo: 25000 }));
  assert.equal(otra.status, 201);
  t.db.exec(`update solicitudes set estado = 'rechazada'`);
  assert.equal((await t.vender(token, t.cuerpo([mano()]))).status, 201);
});

test('una devolución de dinero pendiente de esa pieza (#837) también la frena; la de otra pieza o ya resuelta, no', async () => {
  const t = montar();
  const token = await t.entrar();
  t.db.prepare('update productos set stock = 1 where id = ?').run(CERO);
  const anterior = t.cuerpo([{ producto_id: CERO, cantidad: 1 }, { producto_id: PRODUCTO, cantidad: 1 }], { efectivo: 35000 });
  assert.equal((await t.vender(token, anterior)).status, 201);
  const lineaDe = (producto: string) => (t.db.prepare('select id from venta_lineas where venta_id = ? and producto_id = ?').get(anterior.id as string, producto) as { id: number }).id;
  const pendiente = (linea: number) => t.db.prepare(`insert into solicitudes (id, tipo, correo, nombre, justificacion, datos, estado, creado_en)
    values (?, 'devolucion', 'x', '', 'x', ?, 'pendiente', '')`).run(crypto.randomUUID(), JSON.stringify({ venta_id: anterior.id, linea_id: linea }));
  pendiente(lineaDe(PRODUCTO));   // pide devolver la OTRA pieza del ticket: esta no se frena
  assert.equal((await t.vender(token, t.cuerpo([mano()]))).status, 201);
  t.db.prepare('update productos set stock = 0 where id = ?').run(CERO);
  pendiente(lineaDe(CERO));
  const r = await t.vender(token, t.cuerpo([mano()]));
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /Hay una devolución de dinero pendiente de una venta de esta pieza: espera la respuesta de gerencia./);
  t.db.exec(`update solicitudes set estado = 'rechazada'`);
  assert.equal((await t.vender(token, t.cuerpo([mano()]))).status, 201);
});

test('unidades registradas en OTRA tienda no impiden vender: se avisa a gerencia y queda en la fila de /avisos', async () => {
  const t = montar();
  const token = await t.entrar();
  t.db.exec(`insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values ('${CERO}', 'salk', 1, ''), ('${CERO}', 'romero', 2, '')`);
  const r = await t.vender(token, t.cuerpo([mano()]));
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(t.stock(), 0);
  const [a] = t.ajustes();
  assert.equal(a.otras, 'Coronel Romero tiene 2 registradas de esta pieza: revisa si es la misma. Avenida Salk tiene 1 registrada de esta pieza: revisa si es la misma.');
  await t.esperar();
  assert.equal(t.correos.length, 1);
  assert.match(t.correos[0].text, /Avenida Salk tiene 1 registrada de esta pieza: revisa si es la misma\./);
  t.como(DUENO);
  assert.equal(((await t.pedir('/api/ventas-sin-existencia', undefined, 'GET')).cuerpo as unknown as any[])[0].otras, a.otras);
  // Y desde una sucursal, Soledad cuenta como «otra».
  const s = montar('salk');
  const tokenS = await s.entrar();
  s.db.prepare('update productos set stock = 3 where id = ?').run(CERO);
  assert.equal((await s.vender(tokenS, s.cuerpo([mano()]))).status, 201);
  assert.equal(s.ajustes()[0].otras, 'Soledad tiene 3 registradas de esta pieza: revisa si es la misma.');
  const sola = montar();
  assert.equal((await sola.vender(await sola.entrar(), sola.cuerpo([mano()]))).status, 201);
  assert.equal(sola.ajustes()[0].otras, '', 'sin unidades en otras tiendas no hay nada que decir');
});

test('cancelar o devolver una venta anterior de la pieza, cuando después se vendió «en la mano», avisa a gerencia sin cambiar la existencia', async () => {
  const t = montar();
  const token = await t.entrar();
  t.db.prepare('update productos set stock = 1 where id = ?').run(CERO);
  const anterior = t.cuerpo([{ producto_id: CERO, cantidad: 1 }]);
  assert.equal((await t.vender(token, anterior)).status, 201);
  t.db.prepare('update ventas set registrado_en = ? where id = ?').run(new Date(Date.now() - 3600_000).toISOString(), anterior.id);
  const en_mano = t.cuerpo([mano()]);
  assert.equal((await t.vender(token, en_mano)).status, 201);
  await t.esperar();
  assert.equal(t.correos.length, 1, 'el aviso de la venta en la mano');
  // Cancelar la venta de ESTA misma pieza «en la mano»: no hay nada que revisar.
  const propia = await t.pedir(`/api/ventas/${en_mano.id}/cancelar`, { motivo: 'error de cobro', caja: 'Caja 1' }, 'POST', { 'x-cajero': token });
  assert.equal(propia.status, 200);
  await t.esperar();
  assert.equal(t.correos.length, 1);
  t.db.prepare('update productos set stock = 0 where id = ?').run(CERO);
  // Cancelar la anterior regresa una unidad que quizá ya no existe: se avisa, y la existencia se mueve igual que siempre (+1).
  const r = await t.pedir(`/api/ventas/${anterior.id}/cancelar`, { motivo: 'error de cobro', caja: 'Caja 1' }, 'POST', { 'x-cajero': token });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(t.stock(), 1);
  await t.esperar();
  assert.equal(t.correos.length, 2);
  assert.equal(t.correos[1].subject, 'Revisa la existencia: Cancelación de una venta');
  assert.match(t.correos[1].text, /ED-000002 Lámpara.*Esta pieza se vendió después con «La tengo en la mano»: revisa la existencia\./);
  // Repetir la cancelación (ya estaba cancelada) no vuelve a avisar.
  await t.pedir(`/api/ventas/${anterior.id}/cancelar`, { motivo: 'error de cobro', caja: 'Caja 1' }, 'POST', { 'x-cajero': token });
  await t.esperar();
  assert.equal(t.correos.length, 2);
  // Una devolución de la pieza de otra venta anterior, sin «en la mano» posterior, no avisa.
  const normal = t.cuerpo([{ producto_id: PRODUCTO, cantidad: 1 }], { efectivo: 25000 });
  await t.vender(token, normal);
  await t.pedir(`/api/ventas/${normal.id}/cancelar`, { motivo: 'error de cobro', caja: 'Caja 1' }, 'POST', { 'x-cajero': token });
  await t.esperar();
  assert.equal(t.correos.length, 2);
});

test('devolver una pieza suelta de una venta anterior también avisa', async () => {
  const t = montar();
  const token = await t.entrar();
  t.db.prepare('update productos set stock = 1 where id = ?').run(CERO);
  const anterior = t.cuerpo([{ producto_id: CERO, cantidad: 1 }]);
  await t.vender(token, anterior);
  t.db.prepare('update ventas set registrado_en = ? where id = ?').run(new Date(Date.now() - 3600_000).toISOString(), anterior.id);
  await t.vender(token, t.cuerpo([mano()]));
  await t.esperar();
  const lineaId = (t.db.prepare('select id from venta_lineas where venta_id = ?').get(anterior.id) as { id: number }).id;
  t.como(DUENO);   // devolver dinero lo hace gerencia (#837); el aviso de la unidad fantasma es el mismo
  const r = await t.pedir(`/api/ventas/${anterior.id}/lineas/${lineaId}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'se arrepintió', caja: 'Caja 1' }, 'POST');
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.cuerpo));
  await t.esperar();
  assert.equal(t.correos.at(-1)!.subject, 'Revisa la existencia: Devolución de una pieza');
});

test('la devolución de dinero que gerencia aprueba a distancia (#837) también avisa; pedirla, no', async () => {
  const t = montar();
  const token = await t.entrar();
  t.db.prepare('update productos set stock = 1 where id = ?').run(CERO);
  const anterior = t.cuerpo([{ producto_id: CERO, cantidad: 1 }]);
  await t.vender(token, anterior);
  t.db.prepare('update ventas set registrado_en = ? where id = ?').run(new Date(Date.now() - 3600_000).toISOString(), anterior.id);
  await t.vender(token, t.cuerpo([mano()]));
  await t.esperar();
  const lineaId = (t.db.prepare('select id from venta_lineas where venta_id = ?').get(anterior.id) as { id: number }).id;
  const idDev = crypto.randomUUID();
  const pedida = await t.pedir(`/api/ventas/${anterior.id}/lineas/${lineaId}/cancelar`,
    { id: idDev, cantidad: 1, motivo: 'se arrepintió', caja: 'Caja 1', solicitar: true }, 'POST', { 'x-cajero': token });
  assert.equal(pedida.status, 202, JSON.stringify(pedida.cuerpo));
  await t.esperar();
  assert.ok(t.correos.every((c) => !c.subject.startsWith('Revisa la existencia')), 'pedirla no regresa ninguna unidad');
  t.como(DUENO);
  const r = await t.pedir(`/api/solicitudes/${idDev}/resolver`, { aprobar: true });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  await t.esperar();
  assert.equal(t.correos.at(-1)!.subject, 'Revisa la existencia: Devolución aprobada de una pieza');
});

test('un reintento del mismo folio no vuelve a avisar a gerencia', async () => {
  const t = montar();
  const token = await t.entrar();
  const c = t.cuerpo([mano()]);
  assert.equal((await t.vender(token, c)).status, 201);
  await t.esperar();
  assert.equal(t.correos.length, 1);
  for (let i = 0; i < 2; i++) {
    const otra = await t.vender(token, c);
    assert.equal(otra.cuerpo.duplicada, true);
    await t.esperar();
  }
  assert.equal(t.correos.length, 1, 'ningún aviso más por el reintento');
  assert.equal(t.ajustes().length, 1);
});
