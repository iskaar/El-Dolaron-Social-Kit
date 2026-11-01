import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from './src/worker.mjs';

const HTML = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const FOTO = 'https://dolarones.eldolaron.com/api/catalogo/foto/ED-000123';
const RECORTE = 'https://dolarones.eldolaron.com/api/catalogo/recorte/ED-000123';

// HTMLRewriter no existe en Node: este doble aplica los mismos selectores (title, meta[atributo="valor"]) sobre el HTML real.
globalThis.HTMLRewriter = class {
  reglas = [];
  on(selector, manejador) { this.reglas.push([selector, manejador]); return this; }
  transform(respuesta) {
    const reglas = this.reglas;
    const cuerpo = respuesta.text().then((html) => {
      for (const [selector, m] of reglas) {
        const meta = /^meta\[(\w+)="([^"]+)"\]$/.exec(selector);
        const re = meta ? new RegExp(`<meta[^>]*${meta[1]}="${meta[2]}"[^>]*>`) : /<title>[^<]*<\/title>/;
        html = html.replace(re, (etiqueta) => {
          if (!meta) { let nuevo; m.element({ setInnerContent: (t) => { nuevo = `<title>${t}</title>`; } }); return nuevo; }
          let salida = etiqueta;
          m.element({
            remove: () => { salida = ''; },
            setAttribute: (_, v) => { salida = etiqueta.replace(/content="[^"]*"/, `content="${v}"`); },
          });
          return salida;
        });
      }
      return html;
    });
    const flujo = new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode(await cuerpo)); c.close(); } });
    return new Response(flujo, respuesta);
  }
};

const assets = () => {
  const llamadas = [];
  return { llamadas, ASSETS: { fetch: async (r) => { llamadas.push(r.url); return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', etag: '"x"' } }); } } };
};
const api = (impl) => { globalThis.fetch = impl; };
const pieza = (extra = {}) => ({ piezas: [{ codigo: 'ED-000123', nombre: 'Sudadera Nike', precio: 15000, foto: FOTO, recorte: null, ultima: false, ...extra }] });
const json = (cuerpo, status = 200) => new Response(JSON.stringify(cuerpo), { status });
const pedir = (ruta, env, method = 'GET') => worker.fetch(new Request(`https://eldolaron.com${ruta}`, { method }), env);

test('sin ?pieza= o con una ruta distinta pasa intacto y no consulta la API', async () => {
  let consultas = 0;
  api(async () => { consultas++; return json(pieza()); });
  for (const ruta of ['/', '/?x=1', '/?pieza=', '/?pieza=ED-', '/?pieza=ED-1%20OR%201', '/?pieza=ED-12345678901', '/que-es-un-saldo.html?pieza=ED-000123']) {
    const env = assets();
    assert.equal(await (await pedir(ruta, env)).text(), HTML, ruta);
  }
  assert.equal(await (await pedir('/?pieza=ED-000123', assets(), 'HEAD')).text(), HTML);   // solo GET se reescribe
  assert.equal(consultas, 0);
});

test('con pieza reescribe título, descripción, imagen y url; el resto queda igual', async () => {
  let pedido;
  api(async (u) => { pedido = String(u); return json(pieza({ recorte: RECORTE, ultima: true })); });
  const r = await pedir('/?pieza=ed-000123', assets());
  assert.equal(pedido, 'https://dolarones.eldolaron.com/api/catalogo?codigo=ED-000123');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(r.headers.get('etag'), null);
  const html = await r.text();
  assert.match(html, /<title>Sudadera Nike · \$150 \| El Dolarón<\/title>/);
  assert.match(html, /og:title" content="Sudadera Nike · \$150 \| El Dolarón"/);
  assert.match(html, /og:description" content="¡Última pieza! Apártala con \$100 por 7 días\./);
  assert.match(html, new RegExp(`og:image" content="${FOTO}"`));
  assert.match(html, new RegExp(`twitter:image" content="${FOTO}"`));
  assert.match(html, /og:image:alt" content="Sudadera Nike"/);
  assert.doesNotMatch(html, /recorte/);   // con recorte presente la imagen sigue siendo la foto
  assert.match(html, /og:url" content="https:\/\/eldolaron\.com\/\?pieza=ED-000123"/);
  assert.match(html, /twitter:card" content="summary_large_image"/);
  assert.doesNotMatch(html, /og:image:(width|height)/);
  assert.match(html, /og:site_name" content="El Dolarón"/);   // lo demás no se toca
  assert.match(html, /<link rel="canonical" href="https:\/\/eldolaron\.com\/">/);
});

test('sin recorte también usa la foto; bajo $100 el apartado dice que se paga completa; sin última no la anuncia', async () => {
  api(async () => json(pieza({ precio: 5000 })));
  const html = await (await pedir('/?pieza=ED-000123', assets())).text();
  assert.match(html, new RegExp(`og:image" content="${FOTO}"`));
  assert.match(html, /og:description" content="Se paga completa al apartar\./);
  assert.doesNotMatch(html, /og:description" content="¡Última/);
});

test('si la API falla, tarda, miente o no tiene la pieza, sirve el HTML original', async () => {
  const casos = {
    caída: async () => { throw new Error('red'); },
    '503': async () => json({ error: 'x' }, 503),
    'sin piezas': async () => json({ piezas: [] }),
    'otro código': async () => json(pieza({ codigo: 'ED-000999' })),
    'precio 0': async () => json(pieza({ precio: 0 })),
    'foto de otro sitio': async () => json(pieza({ foto: 'https://evil.example/x.jpg' })),
    'JSON roto': async () => new Response('no es json'),
    // El doble de fetch respeta la señal: AbortSignal.timeout debe cortar la espera.
    'más de 1.5 s': (_u, { signal }) => new Promise((_, rechazar) => signal.addEventListener('abort', () => rechazar(signal.reason))),
  };
  for (const [nombre, impl] of Object.entries(casos)) {
    api(impl);
    const r = await pedir('/?pieza=ED-000123', assets());
    assert.equal(await r.text(), HTML, nombre);
    assert.notEqual(r.headers.get('cache-control'), 'public, max-age=300', nombre);
  }
});
