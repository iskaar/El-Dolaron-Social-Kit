// node --test src/alta-socio.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { leerMensajeAlta } from '../public/venta.js';

test('el aviso del alta solo acepta el número de socio o el cierre', () => {
  assert.deepEqual(leerMensajeAlta({ tipo: 'alta-socio', numero: 42 }), { tipo: 'alta', numero: 42 });
  assert.deepEqual(leerMensajeAlta({ tipo: 'alta-llegada' }), { tipo: 'llegada' });
  assert.deepEqual(leerMensajeAlta({ tipo: 'alta-cerrar' }), { tipo: 'cerrar' });
  // Los datos personales no pasan: del mensaje solo sale el número.
  assert.deepEqual(leerMensajeAlta({ tipo: 'alta-socio', numero: 7, telefono: '4421234567', nombre: 'Ana' }), { tipo: 'alta', numero: 7 });
});

test('el aviso del alta rechaza lo que no tiene su forma', () => {
  for (const malo of [null, undefined, 'alta-socio', 42, [], {}, { tipo: 'otro' },
    { tipo: 'alta-socio' }, { tipo: 'alta-socio', numero: '42' }, { tipo: 'alta-socio', numero: 0 },
    { tipo: 'alta-socio', numero: -3 }, { tipo: 'alta-socio', numero: 1.5 }, { tipo: 'alta-socio', numero: NaN },
    { tipo: 'alta-socio', numero: Infinity }, { tipo: 'alta-socio', numero: 2 ** 60 }]) {
    assert.equal(leerMensajeAlta(malo), null, JSON.stringify(malo));
  }
});

test('la caja solo hace caso al marco del mismo origen y ya no abre otra pestaña', () => {
  const caja = readFileSync(new URL('../public/caja.html', import.meta.url), 'utf8');
  assert.match(caja, /e\.origin !== location\.origin \|\| e\.source !== \$\('dlg-alta-marco'\)\.contentWindow/);
  assert.doesNotMatch(caja, /window\.open\('\/socios'/);
  assert.doesNotMatch(caja, /se abre otra pestaña/);
});

test('el reloj de inactividad de cajero.js no corre dentro de un marco', () => {
  assert.match(readFileSync(new URL('../public/cajero.js', import.meta.url), 'utf8'), /window === window\.top\) setInterval/);
});

test('la llegada física pide el código del cliente: ni un número tecleado ni el id viajan a la API (#839)', () => {
  const socios = readFileSync(new URL('../public/socios.html', import.meta.url), 'utf8');
  const caja = readFileSync(new URL('../public/caja.html', import.meta.url), 'utf8');
  assert.doesNotMatch(socios, /cliente_id/);
  assert.doesNotMatch(socios, /llegada-numero/);
  // El Enter del lector no acepta la confirmación (no hay confirm() nativo; «Sí» ignora Enter y el foco empieza en «Cancelar») ni dobla la petición en vuelo.
  assert.doesNotMatch(socios, /confirm\(/);
  assert.match(socios, /\$\('dlg-confirmar-si'\)\.addEventListener\('keydown', \(e\) => \{ if \(e\.key === 'Enter'\) e\.preventDefault\(\); \}\)/);
  assert.match(socios, /showModal\(\);\s+\$\('dlg-confirmar-no'\)\.focus\(\)/);
  assert.match(socios, /async function acreditarDelCampo\(\) \{\s+if \(\$\('acreditar-llegada'\)\.disabled\) return;/);
  assert.match(socios, /Pide al cliente su código en su celular\./);
  assert.match(socios, /enviarLlegada\(\{ codigo \}, aviso\)/);
  // El código pasa de la caja al marco por postMessage al mismo origen, no por la URL.
  assert.match(caja, /postMessage\(\{ tipo: 'llegada-codigo', codigo: llegadaAEnviar \}, location\.origin\)/);
  assert.match(caja, /\/socios\?incrustado=1'/);
});

test('la llegada del alta recién hecha usa la prueba de un solo uso, con confirmación en la página y sin salir de la memoria (#844)', () => {
  const socios = readFileSync(new URL('../public/socios.html', import.meta.url), 'utf8');
  const caja = readFileSync(new URL('../public/caja.html', import.meta.url), 'utf8');
  // La prueba viaja solo en el cuerpo del POST a la API: ni URL, ni almacenamiento, ni mensaje a la caja.
  assert.match(socios, /enviarLlegada\(\{ prueba: pruebaAlta \}, aviso\)/);
  assert.doesNotMatch(socios, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(socios, /avisarCaja\(\{[^}]*prueba/);
  assert.doesNotMatch(caja, /prueba_llegada|pruebaAlta/);
  // Sigue pidiendo confirmar antes de acreditar: Enter no la acepta (misma ventana de #839).
  assert.match(socios, /async function acreditarAlta\(\) \{[\s\S]*?await confirmar\([\s\S]*?await enviarLlegada\(\{ prueba: pruebaAlta \}/);
  // Sin prueba (reintento sin ella, alta de otra sesión) cae al código del portal.
  assert.match(socios, /if \(!pruebaAlta\) \{ pedirCodigo\(\); return; \}/);
});

// Corre ticketEnDuda, abrirLlegadaPendiente y refrescarSaldoTrasLlegada REALES de caja.html contra una pantalla mínima (#839).
function cajaLlegada(inicial: { cobroIncierto?: boolean; respuesta: () => Promise<unknown> }) {
  const fuente = readFileSync(new URL('../public/caja.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const trozo = (desde: string, hasta: string) => fuente.slice(fuente.indexOf(desde), fuente.indexOf(hasta, fuente.indexOf(desde)));
  const elementos = new Map<string, any>();
  const $ = (id: string) => { if (!elementos.has(id)) elementos.set(id, { textContent: '', style: {} }); return elementos.get(id); };
  const peticiones: string[] = [], altas: string[] = [];
  const contexto = { $, abrirAlta: (c: string) => altas.push(c), pintarSocio() {}, pintar() {},
    fetch: async (ruta: string) => { peticiones.push(ruta); return inicial.respuesta(); } };
  const programa = `
    let idVenta = 'folio-1', cobroIncierto = ${inicial.cobroIncierto ? "{ id: 'folio-1' }" : 'null'};
    let socio = { id: 's1', numero: 7, nombre: 'Ana', disponible: 30000, por_liberar: 0, regalo_disponible: 30000, maximo: 30000 };
    let codigoSocio = 'DC-AAAAAAAAAAAAAAAA', codigoLlegada = 'DC-AAAAAAAAAAAAAAAA', llegadaAcreditada = true;
    ${trozo('function ticketEnDuda()', '// Pedido por WhatsApp cargado')}
    ${trozo('function abrirLlegadaPendiente()', "$('llegada-pendiente').addEventListener")}
    ({ abrirLlegadaPendiente, refrescarSaldoTrasLlegada, estado: () => ({ socio, codigoSocio, idVenta, codigoLlegada }) })`;
  return { ...runInNewContext(programa, contexto) as { abrirLlegadaPendiente(): void; refrescarSaldoTrasLlegada(): Promise<void>; estado(): any }, $, peticiones, altas };
}

test('tras acreditar solo se refresca el saldo: un código ya vencido no quita al socio ni cambia el folio (#839)', async () => {
  const vencido = cajaLlegada({ respuesta: async () => ({ ok: false, status: 403, json: async () => ({ error: 'Código vencido o usado.' }) }) });
  await vencido.refrescarSaldoTrasLlegada();
  assert.equal(vencido.estado().socio.numero, 7);
  assert.equal(vencido.estado().codigoSocio, 'DC-AAAAAAAAAAAAAAAA');
  assert.equal(vencido.estado().idVenta, 'folio-1');
  assert.equal(vencido.estado().socio.disponible, 30000);
  assert.equal(vencido.estado().codigoLlegada, '');
  assert.equal(vencido.$('aviso').textContent, 'Llegada acreditada. El saldo se actualiza en la próxima búsqueda.');
  // Sin red pasa lo mismo.
  const sinRed = cajaLlegada({ respuesta: async () => { throw new Error('sin red'); } });
  await sinRed.refrescarSaldoTrasLlegada();
  assert.equal(sinRed.estado().socio.numero, 7);
  assert.equal(sinRed.estado().idVenta, 'folio-1');
  // Con el código vigente se actualiza el saldo y se avisa que lo nuevo pide otro código; el folio sigue igual.
  const bien = cajaLlegada({ respuesta: async () => ({ ok: true, status: 200, json: async () => ({ id: 's1', disponible: 80000, por_liberar: 100, regalo_disponible: 80000, maximo: 30000 }) }) });
  await bien.refrescarSaldoTrasLlegada();
  assert.equal(bien.estado().socio.disponible, 80000);
  assert.equal(bien.estado().socio.maximo, 30000, 'el tope del código no cambia');
  assert.equal(bien.estado().idVenta, 'folio-1');
  assert.match(bien.$('aviso').textContent, /código nuevo/);
  // Un código que ahora es de otro socio no pisa el saldo del ticket.
  const otro = cajaLlegada({ respuesta: async () => ({ ok: true, status: 200, json: async () => ({ id: 'otro', disponible: 1 }) }) });
  await otro.refrescarSaldoTrasLlegada();
  assert.equal(otro.estado().socio.disponible, 30000);
});

test('con un cobro en duda, «Tiene su llegada pendiente» no abre la ventana ni refresca (#839)', async () => {
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ id: 's1', disponible: 1 }) });
  const c = cajaLlegada({ cobroIncierto: true, respuesta: ok });
  c.abrirLlegadaPendiente();
  assert.deepEqual(c.altas, []);
  assert.match(c.$('aviso').textContent, /^Primero termina el cobro pendiente/);
  await c.refrescarSaldoTrasLlegada();
  assert.deepEqual(c.peticiones, []);
  assert.equal(c.estado().socio.disponible, 30000);
  // Sin cobro en duda sí abre, con el código.
  const libre = cajaLlegada({ respuesta: ok });
  libre.abrirLlegadaPendiente();
  assert.deepEqual(libre.altas, ['DC-AAAAAAAAAAAAAAAA']);
});
