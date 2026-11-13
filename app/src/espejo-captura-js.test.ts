// node --test src/espejo-captura-js.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { serializar, debeAplicar, esReciente, crearEspejo, RECIENTE_MS } from '../public/espejo-captura.js';

const YO = crypto.randomUUID(), OTRO = crypto.randomUUID();
const ahora = '2026-11-13T12:00:00.000Z';
const nueva = () => ({ tipo: 'nueva', id: crypto.randomUUID(), upc: '012345678905', ficha: { nombre: 'Lámpara', precio: 24900, precios: { nuevo: 24900 } },
  enCamino: false, cantidad: 2, estado: 'nuevo', estadoInicial: 'nuevo', imagenBuscada: true, imagen: { url: 'x' }, buscando: true, ajuste: () => 1, nodo: { dom: true } });

test('serializar: solo datos de la tarjeta, sin funciones, nodos ni banderas locales', () => {
  const e = serializar(nueva());
  assert.deepEqual(Object.keys(e), ['tipo', 'id', 'upc', 'ficha', 'enCamino', 'cantidad', 'estado', 'estadoInicial']);
  assert.equal(JSON.stringify(e), JSON.stringify(JSON.parse(JSON.stringify(e))));
  assert.deepEqual(serializar(null), {});
  assert.deepEqual(serializar({ tipo: 'sin-registro', id: 'a', upc: '1', cantidad: 1, estado: 'nuevo', buscando: true }), { tipo: 'sin-registro', id: 'a', upc: '1', cantidad: 1, estado: 'nuevo' });
  // una pieza por revisar sí lleva su foto: no se puede volver a buscar
  assert.deepEqual(serializar({ ...nueva(), revision: true }).imagen, { url: 'x' });
});

test('serializar: una pieza registrada viaja solo por su id', () => {
  const pieza = { id: 'p1', nombre: 'Ventilador', stock: 50, precio: 25000, tiene_foto: true };
  assert.deepEqual(serializar({ tipo: 'existente', pieza, cantidad: 3 }), { tipo: 'existente', pieza_id: 'p1', cantidad: 3 });
  assert.deepEqual(serializar({ tipo: 'guardada', pieza, cantidad: 2, faltaEtiqueta: true }), { tipo: 'guardada', pieza_id: 'p1', cantidad: 2, faltaEtiqueta: true });
  assert.deepEqual(serializar({ tipo: 'guardada', pieza, faltaEtiqueta: false }), { tipo: 'guardada', pieza_id: 'p1', faltaEtiqueta: false });
  assert.deepEqual(serializar({ tipo: 'existente' }), {});
});

test('debeAplicar: nunca el eco propio; la primera lectura exige que sea reciente', () => {
  const v = (extra = {}) => ({ version: 5, dispositivo: OTRO, actualizado_en: ahora, ahora, estado: { tipo: 'nueva' }, ...extra });
  assert.equal(debeAplicar(v(), { version: 4, dispositivo: YO }), true);
  assert.equal(debeAplicar(v(), { version: 5, dispositivo: YO }), false);            // ya la tengo
  assert.equal(debeAplicar(v({ dispositivo: YO }), { version: 4, dispositivo: YO }), false);   // la escribí yo
  assert.equal(debeAplicar(v(), { version: null, dispositivo: YO }), true);          // primera lectura, reciente
  assert.equal(debeAplicar(v({ actualizado_en: new Date(Date.parse(ahora) - RECIENTE_MS - 1).toISOString() }), { version: null, dispositivo: YO }), false);
  assert.equal(debeAplicar(v({ version: 0 }), { version: null, dispositivo: YO }), false);   // sin fila
  assert.equal(debeAplicar(v({ dispositivo: YO }), { version: null, dispositivo: YO }), false);
  assert.equal(esReciente(ahora, ahora), true);
});

/** Un flujo falso que, como el real, avisa al espejo en cada pintar (retomar/limpiar). */
function montar(opciones: { activo?: boolean } = {}) {
  const servidor = { version: 0, estado: {} as object, dispositivo: '', actualizado_en: ahora };
  const puts: any[] = [];
  const f: any = { actual: null as any, retomadas: [] as any[], lista: 0 };
  const flujo = {
    actual: () => f.actual,
    retomar: (a: any, limpiar: boolean) => { f.actual = a; f.retomadas.push(a); f.lista += limpiar ? 1 : 0; espejo.cambio(); },
    limpiar: () => { f.actual = null; espejo.cambio(); },
  };
  const api = async (ruta: string, cuerpo?: any, metodo = 'GET') => {
    if (ruta.startsWith('/api/piezas/')) return { pieza: { id: ruta.split('/').pop(), nombre: 'Ventilador' } };
    if (metodo === 'PUT') {
      puts.push(cuerpo);
      if (cuerpo.version_esperada !== servidor.version) throw Object.assign(new Error('409'), { status: 409, datos: { vigente: { ...servidor, ahora } } });
      Object.assign(servidor, { version: servidor.version + 1, estado: cuerpo.estado, dispositivo: cuerpo.dispositivo, actualizado_en: ahora });
      return { ...servidor, ahora };
    }
    return { ...servidor, ahora };
  };
  const espejo = crearEspejo({ api, flujo, cargarPieza: (id: string) => api('/api/piezas/' + id), activo: () => opciones.activo ?? true, dispositivo: YO, encendido: () => true });
  return { espejo, servidor, puts, f };
}

test('el espejo no publica antes de su primera lectura (no borra la tarjeta del otro al abrir)', async () => {
  const { espejo, puts, f } = montar();
  f.actual = nueva();
  await espejo.publicar();
  assert.equal(puts.length, 0);
  assert.equal(espejo.version(), null);
});

test('aplica la tarjeta del otro aparato sin volver a publicarla (sin eco)', async () => {
  const { espejo, servidor, puts, f } = montar();
  const tarjeta = serializar(nueva());
  Object.assign(servidor, { version: 3, estado: tarjeta, dispositivo: OTRO });
  await espejo.sondear();
  assert.deepEqual(serializar(f.actual), tarjeta); assert.equal(f.lista, 1);
  assert.equal(espejo.version(), 3);
  await espejo.publicar();            // lo que haría el pintar: nada que decir
  assert.equal(puts.length, 0);
  await espejo.sondear();             // sin cambios: tampoco se reaplica
  assert.equal(f.retomadas.length, 1);
});

test('un cambio local se publica con la versión esperada y el siguiente igual no se repite', async () => {
  const { espejo, servidor, puts, f } = montar();
  await espejo.sondear();             // primera lectura, sin fila
  assert.equal(espejo.version(), 0);
  f.actual = nueva();
  await espejo.publicar();
  assert.equal(puts.length, 1); assert.equal(puts[0].version_esperada, 0); assert.equal(puts[0].dispositivo, YO);
  assert.equal(servidor.version, 1);
  await espejo.publicar(); assert.equal(puts.length, 1);   // mismo estado: no hay PUT
  f.actual.cantidad = 5;
  await espejo.publicar();
  assert.equal(puts[1].version_esperada, 1); assert.equal(servidor.version, 2);
  await espejo.sondear();             // mi propia escritura no se aplica
  assert.equal(f.retomadas.length, 0);
});

test('409: se adopta la vigente del otro aparato; si la vigente es mía solo se actualiza la versión', async () => {
  const { espejo, servidor, puts, f } = montar();
  await espejo.sondear();
  const otra = serializar({ ...nueva(), cantidad: 7 });
  Object.assign(servidor, { version: 4, estado: otra, dispositivo: OTRO });   // el otro escribió entre mi lectura y mi PUT
  f.actual = nueva();
  await espejo.publicar();
  assert.equal(puts.length, 1);
  assert.equal(f.actual.cantidad, 7); assert.equal(espejo.version(), 4);
  await espejo.publicar(); assert.equal(puts.length, 1);      // lo adoptado no se republica
  Object.assign(servidor, { version: 9, estado: { tipo: 'sin-registro', id: 'a', upc: '1', cantidad: 1, estado: 'nuevo' }, dispositivo: YO });   // mi escritura perdida
  f.actual = nueva();
  await espejo.publicar();
  assert.equal(espejo.version(), 9); assert.equal(f.retomadas.length, 1);   // sin aplicar nada
});

test('pieza registrada del otro aparato: se recarga de D1 y se muestra con su existencia real', async () => {
  const { espejo, servidor, f } = montar();
  Object.assign(servidor, { version: 2, estado: { tipo: 'guardada', pieza_id: 'p9', cantidad: 2, faltaEtiqueta: true }, dispositivo: OTRO });
  await espejo.sondear();
  assert.equal(f.actual.tipo, 'guardada'); assert.equal(f.actual.pieza.id, 'p9'); assert.equal(f.actual.faltaEtiqueta, true);
  assert.equal(f.lista, 1);
});

test('tarjeta vacía del otro aparato limpia la pantalla; sin Capturar visible no se pregunta', async () => {
  const quieto = montar({ activo: false });
  Object.assign(quieto.servidor, { version: 2, estado: serializar(nueva()), dispositivo: OTRO });
  await quieto.espejo.sondear();
  assert.equal(quieto.f.retomadas.length, 0); assert.equal(quieto.espejo.version(), null);
  const { espejo, servidor, f } = montar();
  f.actual = nueva();
  await espejo.sondear();
  Object.assign(servidor, { version: 1, estado: {}, dispositivo: OTRO });
  await espejo.sondear();
  assert.equal(f.actual, null);
});

test('foto subida desde este aparato: publica la pieza con «refresco» aunque ya se mostrara', async () => {
  const { espejo, servidor, puts } = montar();
  await espejo.sondear();
  await espejo.pieza('p1'); await new Promise((r) => setTimeout(r, 5)); await espejo.pieza('p1');
  assert.equal(puts.length, 2);   // distinta marca: el otro aparato recarga la pieza con su foto
  assert.equal((servidor.estado as any).pieza_id, 'p1'); assert.ok((servidor.estado as any).refresco);
});
