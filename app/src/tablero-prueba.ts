// Ayudas de las pruebas de /api/tablero?vista= (Issue #610). Todo sintetico: ningun dato real.
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';

export const CLIENTE_PRIVADO = 'Carla Privada Sintetica';
export const TELEFONO_PRIVADO = '4441230000';
export const REVENDEDORA = 'ana.privada@revende.mx';
export const CAJERO = 'caja@prueba.mx';

export type T = ReturnType<typeof tienda>;

/** Una venta en efectivo de `piezas` ventiladores de $250. */
export async function venta(t: T, piezas = 1) {
  const id = crypto.randomUUID();
  const r = await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: piezas }], forma_pago: 'efectivo', efectivo: 25000 * piezas, caja: 'Caja 1' });
  assert.equal(r.status, 201);
  return id;
}

/** Cuelga la venta de un pedido de `vendedora` (WhatsApp, o revendedora si ese correo tiene el rol). */
export function pedido(t: T, vendedora: string, ventaId: string, folio: number) {
  const id = crypto.randomUUID();
  t.db.prepare(`insert into pedidos (id, folio, cliente, telefono, entrega, envio, vendedora, estado, vence_en, anticipo, forma_pago,
      saldo, saldo_vence_en, venta_id, creado_en, actualizado_en)
    values (?, ?, ?, ?, 'tienda', 0, ?, 'vendido', '', 0, 'efectivo', 0, '', ?, '', '')`).run(id, folio, CLIENTE_PRIVADO, TELEFONO_PRIVADO, vendedora, ventaId);
  t.db.prepare('update ventas set pedido_id = ? where id = ?').run(id, ventaId);
  return id;
}

export const cuenta = (t: T, correo: string, roles: string) =>
  t.db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, 1, '', '')").run(correo, 'Nombre Privado', roles);

export function cliente(t: T, n: number) {
  const id = crypto.randomUUID();
  t.db.prepare(`insert into clientes (id, numero, nombre, telefono, correo, bases_version, registrado_por, creado_en)
    values (?, ?, ?, ?, 'privado@correo.mx', 'v', 'x', ?)`).run(id, n, CLIENTE_PRIVADO, `44400000${String(n).padStart(2, '0')}`, new Date().toISOString());
  return id;
}

export const vista = (t: T, nombre: string) => t.pedir(`/api/tablero?vista=${nombre}`, undefined, 'GET');

/** Ninguna llave ni valor del JSON delata a una persona, un ticket, un pedido, un codigo ni un sueldo. */
export function sinDatosPrivados(cuerpo: unknown, privados: string[]) {
  const texto = JSON.stringify(cuerpo);
  const llaves = new Set<string>();
  const recorrer = (x: unknown) => { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { llaves.add(k); recorrer(v); } };
  recorrer(cuerpo);
  for (const llave of llaves) {
    assert.doesNotMatch(llave, /nombre|telefono|correo|mail|codigo|motivo|sueldo|empleado|(^|_)vendedora(_|$)|^cliente_|^id$|_id$|^ticket$|pin|token|guia|rastreo|folio|sku|url|permalink/i, llave);
  }
  for (const privado of [CLIENTE_PRIVADO, TELEFONO_PRIVADO, REVENDEDORA, CAJERO, 'Nombre Privado', 'Empleado Privado', 'motivo privado', 'nota privada',
    'ED-000001', 'Ventilador', ...privados]) assert.ok(!texto.includes(privado), privado);
  assert.doesNotMatch(texto, /@/);
}
