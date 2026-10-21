import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { codigoLeido, normalizarUpc } from '../public/upc.js';

function pantalla(fallaFoto = false) {
  const elementos = new Map<string, any>(), llamadas: { ruta: string; opciones?: RequestInit }[] = [], cola = new Map<string, any>();
  const el = (id: string): any => {
    if (!elementos.has(id)) elementos.set(id, { hidden: false, value: '', textContent: '', atributos: {}, eventos: {}, files: [],
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(evento: string, fn: any) { this.eventos[evento] = fn; },
      getAttribute(nombre: string) { return this.atributos[nombre] ?? null; },
      setAttribute(nombre: string, valor: string) { this.atributos[nombre] = valor; }, removeAttribute(nombre: string) { delete this.atributos[nombre]; },
      closest() { return this; }, querySelector() { return null; },
      get firstElementChild() { return el(id + '-primero'); },
      insertAdjacentHTML() {}, click() {}, focus() {},
    });
    return elementos.get(id);
  };
  let proximoTemporizador = 0;
  const temporizadores = new Set<number>();
  const html = readFileSync('public/escanear.html', 'utf8');
  const codigo = html.split('<script type="module">')[1].split('</script>')[0].replace(/^import .*;\r?\n/gm, '');
  const api = runInNewContext(codigo + '\n({procesar, cerrarActual, pintar, actual:()=>actual, cola:()=>fila, conservarFoto, elegirPiezaFoto})', {
    document: { getElementById: el, addEventListener() {}, body: { className: '' }, querySelector: el, querySelectorAll: (selector: string) => [el(selector)] },
    CATEGORIAS: [['otros', 'Otros']], codigoLeido, normalizar: normalizarUpc, crypto, Blob, File, FormData,
    navigator: {}, addEventListener() {}, setTimeout: () => { temporizadores.add(++proximoTemporizador); return proximoTemporizador; }, clearTimeout: (id: number) => temporizadores.delete(id),
    guardarFoto: async (r: any) => cola.set(r.id, r), leerFoto: async (id: string) => cola.get(id), borrarFoto: async (id: string) => cola.delete(id), pendientes: async () => [...cola.values()],
    fetch: async (ruta: string, opciones?: RequestInit) => {
      llamadas.push({ ruta, opciones });
      if (ruta.endsWith('/imagen')) return Response.json({ imagen: { url: 'https://target.scene7.com/is/image/Target/ejemplo', nombre: 'Estuche', tcin: '94882460', confirmada: opciones?.method === 'PUT' } });
      if (ruta === '/api/borradores') return new Response('{}', { status: fallaFoto ? 503 : 201 });
      if (ruta === '/api/borradores/upc') return Response.json({ nombre: 'Estuche', stock: 2, precio: 100 });
      return Response.json({ nombre: 'Estuche', categoria: 'otros', precio: 100, traducido: true, imagen: null });
    },
  });
  return { api, el, llamadas, cola, temporizadores };
}

const asentarse = () => new Promise((resolve) => setImmediate(resolve));
test('lector conserva ceros, suma alias y no confirma ni programa guardado mientras se revisa la imagen', async () => {
  const { api, el, llamadas, temporizadores } = pantalla();
  await api.procesar('0191907910414');
  await asentarse();
  assert.equal(api.actual().leido, '0191907910414');
  assert.equal(llamadas[0].ruta, '/api/manifiesto/0191907910414');
  assert.equal(api.actual().imagen.confirmada, false);
  assert.equal(el('confirmar-imagen').hidden, false);
  // avisar() pone un temporizador de color; programarGuardado() no añade otro.
  assert.equal(temporizadores.size, 1);
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
