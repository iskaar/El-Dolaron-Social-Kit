// node --test src/caja-cupon-socio.test.ts
// #927: lo que la caja manda y muestra cuando un socio paga con cupón y con su cuenta. Sin pantalla: se corta la función real de caja.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { pagoConDolarones, dolaronesGanados } from '../public/venta.js';
import { formularioPieza } from '../public/ticket.js';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => fuente.slice(fuente.indexOf(desde), fuente.indexOf(hasta, fuente.indexOf(desde) + desde.length));

const CUPON = { codigo: 'DP-CCCCCCCCCCCCCCCC', disponible: 1000, expira_en: '2099-01-01T00:00:00Z', origen: 'manual' };
const CUPON_2 = { codigo: 'DP-DDDDDDDDDDDDDDDD', disponible: 500, expira_en: '2099-02-01T00:00:00Z', origen: 'devolucion' };
const SOCIO = { id: 's1', numero: 7, disponible: 5000, regalo_disponible: 0, maximo: 5000, expira_en: '2099-01-01T00:00:00Z', vale: false };

function montar(socio: Record<string, unknown>, vales: unknown[], codigoSocio: string, respuesta: Record<string, unknown> = {}) {
  const el = { textContent: '', style: {} };
  const enviadas: any[] = [];
  const contexto = {
    $: () => el, AbortSignal, Date, Object, dolaronesGanados, pagoConDolarones, promoAgotada() {}, valesCargados: vales, codigoSocio, socio,
    fetch: async (_r: string, o: any) => { enviadas.push(JSON.parse(o.body)); return { ok: true, status: 201, json: async () => ({ id: 'x', ganados: 2000, vale_emitido: null, ...respuesta }) }; },
  };
  const rutina = runInNewContext(`let folioIncierto = null; ${entre('async function cobrarConDolarones(', '/* ---------- pedidos por WhatsApp')}; cobrarConDolarones`, contexto);
  return { cobrar: (venta: Record<string, unknown>) => rutina(venta, { total: 25000, aPagar: 22000 }), enviadas, aviso: el };
}

test('socio con cupón y cuenta: manda los dos códigos, cupón primero; el servidor reparte y el ticket recibe lo que él dijo (#927)', async () => {
  const c = montar(SOCIO, [CUPON], 'DC-x', { dolarones_papel: 1000, saldo: { disponible: 3000 } });
  const venta: Record<string, unknown> = { id: 'f1', dolarones: 3000 };
  const r = await c.cobrar(venta);
  assert.deepEqual(c.enviadas[0], { id: 'f1', dolarones: 3000, codigo_vale: CUPON.codigo, codigo_socio: 'DC-x' });
  assert.equal(venta.dolarones_papel, 1000);
  assert.deepEqual({ ...r }, { numero: 7, ganados: 2000, bono_promo: 0, saldo: 3000 });
});

test('varios cupones viajan en lista; solo cupones por teléfono no mandan el código del socio (no lo gastan)', async () => {
  const varios = montar(SOCIO, [CUPON, CUPON_2], 'DC-x');
  await varios.cobrar({ id: 'f2', dolarones: 1200 });
  assert.deepEqual(varios.enviadas[0].codigo_vale, [CUPON.codigo, CUPON_2.codigo]);
  assert.equal(varios.enviadas[0].codigo_socio, 'DC-x', 'con socio real el código viaja siempre, como en main (entra al hash del folio)');

  const telefono = montar({ ...SOCIO, maximo: undefined, expira_en: undefined }, [CUPON], '');
  const r = await telefono.cobrar({ id: 'f3', dolarones: 1000 });
  assert.ok(r, 'el cupón solo no pide código');
  assert.deepEqual(telefono.enviadas[0], { id: 'f3', dolarones: 1000, codigo_vale: CUPON.codigo, codigo_socio: '' });
  // Pero la cuenta sí: pedir más que el cupón sin código no sale.
  const mas = montar({ ...SOCIO, maximo: undefined, expira_en: undefined }, [CUPON], '');
  assert.equal(await mas.cobrar({ id: 'f4', dolarones: 1500 }), false);
  assert.equal(mas.enviadas.length, 0);
  assert.match(mas.aviso.textContent, /debe autorizar este importe/);
});

test('solo vales (sin socio): el cuerpo es el de siempre y el ticket no lleva socio (#927)', async () => {
  const c = montar({ vale: true, disponible: 1000, maximo: 1000, expira_en: '2099-01-01T00:00:00Z' }, [{ ...CUPON, origen: 'compra' }], CUPON.codigo);
  const r = await c.cobrar({ id: 'f5', dolarones: 500 });
  assert.deepEqual(c.enviadas[0], { id: 'f5', dolarones: 500, codigo_vale: CUPON.codigo });
  assert.deepEqual({ ...r }, { vale: true });
});

test('un cupón vencido en el ticket frena el cobro aunque la cuenta alcance', async () => {
  const vencido = { ...CUPON, expira_en: '2000-01-01T00:00:00Z' };
  const c = montar(SOCIO, [vencido], 'DC-x');
  assert.equal(await c.cobrar({ id: 'f6', dolarones: 500 }), false);
  assert.equal(c.enviadas.length, 0);
});

test('el formulario de una pieza de un ticket con cupón solo ofrece el cupón; el normal sigue ofreciendo dinero (#927)', () => {
  const solo = formularioPieza(12, 2, 100, 'efectivo', true);
  assert.match(solo, /data-cupon-linea="12"/);
  assert.match(solo, /solo se devuelve en cupón/);
  assert.doesNotMatch(solo, /Devolver dinero/);
  assert.match(solo, /class="cancelar-normal" hidden[\s\S]*data-confirmar-linea="12"[\s\S]*Cancelar la pieza/, 'la cancelación normal está escondida hasta que el servidor diga «Cancélalas normal»');
  assert.match(solo, /cantidad-cancelar/);
  const normal = formularioPieza(12, 2, 100, 'efectivo');
  assert.match(normal, /data-confirmar-linea="12"/);
  assert.match(normal, /Devolver dinero/);
  assert.match(formularioPieza(12, 1, null, 'efectivo', true), /solo se devuelve en cupón/, 'sin porcentaje de cupón (sin red) la nota igual aclara');
});

test('pagoConDolarones con cupones y cuenta a la vez devuelve el reparto que la caja muestra', () => {
  const p = pagoConDolarones({ socio: SOCIO, vales: [CUPON], codigoSocio: 'DC-x', total: 25000, usados: 3000 });
  assert.deepEqual({ ...p.reparto }, { papel: 1000, cuenta: 2000 });
  assert.equal(p.autorizado, true);
});

test('socio sin cupones: el cuerpo del cobro es el mismo de siempre (el código viaja y entra al hash del folio) (#927)', async () => {
  const c = montar(SOCIO, [], 'DC-x');
  await c.cobrar({ id: 'f7', dolarones: 1000 });
  assert.deepEqual(c.enviadas[0], { id: 'f7', dolarones: 1000, codigo_socio: 'DC-x' });
  assert.deepEqual(Object.keys(c.enviadas[0]).sort(), ['codigo_socio', 'dolarones', 'id']);
});
