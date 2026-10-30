// Service worker de /avisos (Issue #600): muestra las notificaciones push al dueño
// (el botón «Ayuda» de la caja) y al tocarlas abre /avisos. No guarda nada en caché.
self.addEventListener('push', (e) => {
  let datos = {};
  try { datos = e.data?.json() ?? {}; } catch { /* sin datos legibles: el aviso genérico */ }
  e.waitUntil(self.registration.showNotification(datos.titulo || 'El Dolarón', {
    body: datos.cuerpo || 'Te necesitan en la tienda.', icon: '/icono-app.png',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow('/avisos'));
});
