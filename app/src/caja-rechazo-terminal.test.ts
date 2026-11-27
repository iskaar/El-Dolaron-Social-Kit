// node --test src/caja-rechazo-terminal.test.ts
// Issue #944: «primero la terminal, después la caja». Si el servidor rechaza la venta cuando el dinero ya se cobró fuera de la caja (tarjeta o
// transferencia), el aviso dice qué hacer con la terminal. Corre el cobrar() REAL de public/caja.html, una prueba por cada ruta de cobro.
import test from 'node:test';
import assert from 'node:assert/strict';
import { montar, type Ruta } from './prueba-cobro.ts';

const RECHAZO = 'No hay existencia suficiente para completar la venta. Quita Ventilador: ya no está disponible.';
const rechaza = (status = 409) => async () => ({ ok: false, status, json: async () => ({ error: RECHAZO }) });
const NOTA = /Si la terminal ya cobró \$\d+, no vuelvas a cobrar en la terminal\. Corrige el ticket y toca otra vez el mismo botón de cobro; si el total cambia, llama a gerencia/;
const A_PAGAR: Record<Ruta, string> = { normal: '$300', dolarones: '$290', pedido: '$200' };   // lo que se cobró en la terminal: sin Dolarones ni anticipo

for (const ruta of ['normal', 'dolarones', 'pedido'] as Ruta[]) {
  test(`#944 ruta ${ruta}: un rechazo del servidor después de cobrar con tarjeta dice que no se cobre otra vez en la terminal y a quién llamar`, async () => {
    const c = montar({ ruta, forma: 'tarjeta', fetch: rechaza() });
    await c.cobrar();
    const aviso = c.$('aviso').textContent as string;
    assert.ok(aviso.startsWith(RECHAZO), `el motivo del servidor va primero; salió: ${aviso}`);
    assert.match(aviso, NOTA);
    assert.ok(aviso.includes(`Si la terminal ya cobró ${A_PAGAR[ruta]},`), aviso);
    assert.equal(c.$('aviso').style.color, '#D72B32');
    assert.equal(c.impresos.length, 0);
    assert.equal(c.cuerpos.length, 1, 'no se reintenta solo');
  });

  test(`#944 ruta ${ruta}: con transferencia habla de la transferencia; con efectivo, sin respuesta o con un 5xx no se agrega nada`, async () => {
    // Menos de $300 por transferencia: no se pide clave de rastreo y el cobro sale al primer toque.
    const transferencia = montar({ ruta, forma: 'transferencia', fetch: rechaza(400),
      contexto: ruta === 'normal' ? { lineas: [{ producto_id: 'p1', codigo: 'ED-000001', nombre: 'Ventilador', precio: 20000, cantidad: 1 }] } : {} });
    await transferencia.cobrar();
    assert.match(transferencia.$('aviso').textContent, /ya no está disponible\. Si el cliente ya transfirió \$\d+, no le pidas otra transferencia\. Corrige el ticket.*gerencia/);

    const efectivo = montar({ ruta, forma: 'efectivo', fetch: rechaza() });
    await efectivo.cobrar();
    assert.equal(efectivo.$('aviso').textContent, RECHAZO);

    // Red caída, tiempo agotado o 5xx: no se sabe si se cobró (#933); ese aviso no cambia.
    for (const fetch of [async () => { throw new TypeError('Failed to fetch'); }, async () => { throw new DOMException('timeout', 'TimeoutError'); }, rechaza(503)]) {
      const duda = montar({ ruta, forma: 'tarjeta', fetch, contexto: ruta === 'normal' ? { lineas: [{ producto_id: 'p1', codigo: 'ED-000001', nombre: 'Ventilador', precio: 30000, cantidad: 1, en_mano: 1 }] } : {} });
      await duda.cobrar();
      assert.doesNotMatch(duda.$('aviso').textContent, /ya cobró|ya transfirió/, `${ruta}: ${duda.$('aviso').textContent}`);
    }
  });
}

test('#944 un ticket ya pagado con el saldo del pedido («Cobrar: ya está pagado») no menciona la terminal aunque se registre como tarjeta', async () => {
  const c = montar({ ruta: 'pedido', forma: 'sin-dinero', fetch: rechaza(),
    contexto: { pedidoCargado: { id: 'ped-1', folio: 17, saldo: 30000 }, impresionRemota: () => true } });
  c.$('imprimir-en').value = 'Caja 2';   // desde el celular, «ya está pagado» se registra como tarjeta
  await c.cobrar();
  assert.equal(JSON.parse(c.cuerpos[0]).forma_pago, 'tarjeta');
  assert.equal(c.$('aviso').textContent, RECHAZO);
});
