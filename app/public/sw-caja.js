// Service worker de la caja (Issue #206): recargar /caja sin internet.
// Red primero: con red siempre llega la version nueva; sin red, la ultima copia buena.
// Las ventas sin red NO pasan por aqui: siguen en la cola de IndexedDB de caja.html.
const CACHE = 'caja-v1';   // ponytail: subir el numero si cambia esta logica; activate borra los demas
const RUTAS = ['/caja', '/cajero.js', '/venta.js', '/camara.js', '/impresora.js', '/ticket.js', '/code128.js'];

// Solo GET del mismo origen, de la lista, con 200 directo (ni redireccion de Access ni opaca).
function debeCachear(request, response, origen = self.location.origin) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== origen || url.pathname.startsWith('/api/')) return false;
  if (!RUTAS.includes(url.pathname)) return false;
  return response.type === 'basic' && response.status === 200 && !response.redirected;
}

self.addEventListener('install', (e) => { e.waitUntil(self.skipWaiting()); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const nombre of await caches.keys()) if (nombre !== CACHE) await caches.delete(nombre);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !RUTAS.includes(url.pathname)) return;
  e.respondWith((async () => {
    try {
      const respuesta = await fetch(e.request);
      if (debeCachear(e.request, respuesta)) {
        const copia = respuesta.clone();
        e.waitUntil(caches.open(CACHE).then((c) => c.put(url.pathname, copia)));
      }
      return respuesta;
    } catch (error) {
      const guardada = await caches.match(url.pathname, { cacheName: CACHE });
      if (guardada) return guardada;
      throw error;
    }
  })());
});
