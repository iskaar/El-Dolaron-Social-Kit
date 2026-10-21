import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { codigoLeido, normalizarUpc, SIN_CODIGO } from '../public/upc.js';
import { ESTADOS } from '../public/estados.js';

function pantalla(fallaFoto = false, desconocida = false) {
  const elementos = new Map<string, any>(), llamadas: { ruta: string; opciones?: RequestInit }[] = [], cola = new Map<string, any>();
  const el = (id: string): any => {
    if (!elementos.has(id)) elementos.set(id, { hidden: false, value: '', textContent: '', atributos: {}, eventos: {}, files: [],
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(evento: string, fn: any) { this.eventos[evento] = fn; },
      getAttribute(nombre: string) { return this.atributos[nombre] ?? null; },
      setAttribute(nombre: string, valor: string) { this.atributos[nombre] = valor; }, removeAttribute(nombre: string) { delete this.atributos[nombre]; },
      closest() { return this; }, querySelector(selector: string) { return selector === '.dato' ? null : el(id + ':' + selector); }, querySelectorAll() { return []; },
      get firstElementChild() { return el(id + '-primero'); },
      insertAdjacentHTML() {}, remove() { this.eliminado = true; }, click() {}, focus() { this.enfocado = true; },
    });
    return elementos.get(id);
  };
  let proximoTemporizador = 0;
  const temporizadores = new Map<number, { fn: () => unknown; ms: number }>();
  const html = readFileSync('public/escanear.html', 'utf8');
  const codigo = html.split('<script type="module">')[1].split('</script>')[0].replace(/^import .*;\r?\n/gm, '');
  const api = runInNewContext(codigo + '\n({procesar, cerrarActual, pintar, actual:()=>actual, desconocido:()=>desconocido, cola:()=>fila, conservarFoto, elegirPiezaFoto})', {
    document: { getElementById: el, addEventListener() {}, body: { className: '' }, querySelector: el, querySelectorAll: (selector: string) => [el(selector)] },
    CATEGORIAS: [['otros', 'Otros']], ESTADOS, SIN_CODIGO, codigoLeido, normalizar: normalizarUpc, crypto, Blob, File, FormData,
    navigator: {}, addEventListener() {}, setTimeout: (fn: () => unknown, ms: number) => { temporizadores.set(++proximoTemporizador, { fn, ms }); return proximoTemporizador; }, clearTimeout: (id: number) => temporizadores.delete(id),
    guardarFoto: async (r: any) => cola.set(r.id, r), leerFoto: async (id: string) => cola.get(id), borrarFoto: async (id: string) => cola.delete(id), pendientes: async () => [...cola.values()],
    fetch: async (ruta: string, opciones?: RequestInit) => {
      llamadas.push({ ruta, opciones });
      if (ruta.endsWith('/imagen')) return Response.json({ imagen: { url: 'https://target.scene7.com/is/image/Target/ejemplo', nombre: 'Estuche', tcin: '94882460', confirmada: opciones?.method === 'PUT' } });
      if (ruta === '/api/borradores') return new Response('{}', { status: fallaFoto ? 503 : 201 });
      if (ruta === '/api/borradores/upc') return Response.json({ nombre: 'Estuche', stock: 2, precio: 100 });
      if (ruta === '/api/borradores/upc/buscar') return Response.json({ ...JSON.parse(String(opciones?.body)), estado_analisis: 'pendiente' }, { status: 202 });
      if (ruta === '/api/borradores/upc/manual') {
        if (fallaFoto) return Response.json({ error: 'Sin red' }, { status: 503 });
        const cuerpo = JSON.parse(String(opciones?.body));
        return Response.json({ ...cuerpo, precio: cuerpo.precio ?? 24900, estado_analisis: 'listo', creado_en: new Date().toISOString() }, { status: 201 });
      }
      if (desconocida && ruta.startsWith('/api/manifiesto/')) return new Response('{}', { status: 404 });
      if (desconocida && ruta.startsWith('/api/borradores/upc/')) return Response.json({ estado_analisis: 'error' });
      return Response.json({ nombre: 'Estuche', categoria: 'otros', precio: 100, traducido: true, imagen: null });
    },
  });
  return { api, el, llamadas, cola, temporizadores };
}

const asentarse = () => new Promise((resolve) => setImmediate(resolve));
test('lector conserva ceros, suma alias, no confirma sola la imagen y la imagen no detiene el guardado (#383)', async () => {
  const { api, el, llamadas, temporizadores } = pantalla();
  await api.procesar('0191907910414');
  await asentarse();
  assert.equal(api.actual().leido, '0191907910414');
  assert.equal(llamadas[0].ruta, '/api/manifiesto/0191907910414');
  assert.equal(api.actual().imagen.confirmada, false);
  assert.equal(el('confirmar-imagen').hidden, false);
  // avisar() pone un temporizador de color y programarGuardado() el de 25 s, aunque falte confirmar la imagen.
  assert.equal(temporizadores.size, 2);
  await api.procesar('191907910414');
  assert.equal(api.actual().stock, 2);
  assert.equal(llamadas.filter((r) => r.ruta.endsWith('/imagen')).length, 1);
  await el('confirmar-imagen').eventos.click();
  assert.equal(api.actual().imagen.confirmada, true);
  await api.cerrarActual();
  const guardado = llamadas.find((r) => r.ruta === '/api/borradores/upc')!;
  assert.equal(JSON.parse(String(guardado.opciones!.body)).upc, '0191907910414');
});

test('la foto se conserva antes de subir y un fallo de red deja el mismo id en la cola compartida', async () => {
  const { api, llamadas, cola } = pantalla(true);
  await api.procesar('8438051051054');
  await asentarse();
  const id = api.actual().id;
  assert.equal(api.elegirPiezaFoto(), true);
  await api.conservarFoto(new Blob(['foto']));
  assert.equal(cola.get(id).upc, '8438051051054');
  assert.equal(cola.get(id).desde_escaner, true);
  assert.equal(api.actual(), null);
  const subida = llamadas.find((r) => r.ruta === '/api/borradores')!;
  assert.equal((subida.opciones!.body as FormData).get('id'), id);
  assert.equal((subida.opciones!.body as FormData).get('upc'), '8438051051054');
  assert.equal(llamadas.some((r) => r.ruta === '/api/borradores/upc'), false);
});

test('un EAN-8 con varios ceros conserva el código completo y una clave corta sigue encontrando su foto', async () => {
  const { api, llamadas } = pantalla();
  await api.procesar('00001234');
  await asentarse();
  assert.equal(api.actual().leido, '00001234');
  assert.equal(api.actual().upc, '1234');
  assert.equal(llamadas[0].ruta, '/api/manifiesto/00001234');
  assert.equal(normalizarUpc('1234'), '1234');
});

test('Sin código o UPC no encontrado → Sin foto: foco, centavos, cantidad e id estables (#399)', async () => {
  for (const upc of ['', '0012345678905']) {
    const { api, el, llamadas, cola } = pantalla(false, true);
    if (upc) await api.procesar(upc);
    else { el('sin-codigo').eventos.click(); await api.cola(); }
    const id = api.desconocido().id;
    el('sin-foto').eventos.click();
    assert.equal(el('manual').hidden, false);
    assert.equal(el('manual-nombre').enfocado, true);
    // No se cierra ni se guarda otra pieza mientras se escribe o cambia de app.
    await api.procesar('99999999'); await api.cerrarActual();
    assert.equal(api.desconocido().id, id);
    assert.equal(api.elegirPiezaFoto(), false);
    el('manual-nombre').value = 'Tazón'; el('manual-categoria').value = 'otros';
    el('manual-estado').value = 'danado'; el('manual-tipo-precio').value = 'precio';
    el('manual-precio').value = '123.45'; el('manual-cantidad').value = '3';
    el('manual').eventos.submit({ preventDefault() {} });
    await api.cola();
    const enviada = llamadas.find((r) => r.ruta === '/api/borradores/upc/manual')!;
    assert.deepEqual(JSON.parse(String(enviada.opciones?.body)), { id, upc, nombre: 'Tazón', categoria: 'otros', estado_fisico: 'danado', stock: 3, precio: 12345 });
    assert.equal(api.desconocido(), null); assert.equal(el('manual').hidden, true);
    assert.equal(el('total').textContent, '3 piezas'); assert.equal(cola.size, 0);
  }
});

test('un error guardando Sin foto conserva el formulario y el mismo id para reintentar (#399)', async () => {
  const { api, el, llamadas } = pantalla(true, true);
  el('sin-codigo').eventos.click(); await api.cola();
  const id = api.desconocido().id;
  el('sin-foto').eventos.click();
  el('manual-nombre').value = 'Taza'; el('manual-precio').value = '500';
  el('manual').eventos.submit({ preventDefault() {} }); await api.cola();
  assert.equal(el('manual').hidden, false); assert.equal(el('manual-nombre').value, 'Taza');
  assert.equal(api.desconocido().id, id); assert.equal(el('manual-guardar').disabled, false);
  el('manual').eventos.submit({ preventDefault() {} }); await api.cola();
  const cuerpos = llamadas.filter((r) => r.ruta === '/api/borradores/upc/manual').map((r) => JSON.parse(String(r.opciones?.body)));
  assert.equal(cuerpos.length, 2); assert.equal(cuerpos[0].id, cuerpos[1].id); assert.equal(cuerpos[0].precio_lista, 50000);
});

test('la fila falta foto abre Sin foto con el mismo id y no cuenta dos veces la pieza (#399)', async () => {
  const { api, el, llamadas, temporizadores } = pantalla(false, true);
  await api.procesar('0012345678905');
  const id = api.desconocido().id;
  await api.cerrarActual();
  assert.equal(el('total').textContent, '1 pieza');
  await [...temporizadores.values()].find((t) => t.ms === 4000)!.fn();
  const li = el('guardadas').firstElementChild;
  li.eventos.click({ target: { closest: () => null } }); await api.cola();
  assert.equal(api.desconocido().id, id); assert.equal(api.desconocido().buscada, true);
  el('sin-foto').eventos.click();
  el('manual-nombre').value = 'Taza'; el('manual-precio').value = '500'; el('manual-cantidad').value = '3';
  el('manual').eventos.submit({ preventDefault() {} }); await api.cola();
  const cuerpo = JSON.parse(String(llamadas.find((r) => r.ruta === '/api/borradores/upc/manual')!.opciones?.body));
  assert.equal(cuerpo.id, id); assert.equal(cuerpo.upc, '0012345678905');
  assert.equal(el('total').textContent, '3 piezas'); assert.equal(li.eliminado, true);
  assert.equal(llamadas.filter((r) => r.ruta === '/api/borradores/upc/buscar').length, 1);
});
