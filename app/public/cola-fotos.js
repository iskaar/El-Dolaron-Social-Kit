// La captura y el escáner comparten la cola: una foto fallida sigue disponible en Fotos.
async function conStore(modo, fn) {
  const base = await new Promise((resolve, reject) => {
    const s = indexedDB.open('eldolaron', 1);
    s.onupgradeneeded = () => s.result.createObjectStore('pendientes', { keyPath: 'id' });
    s.onsuccess = () => resolve(s.result);
    s.onerror = () => reject(s.error);
  });
  return new Promise((resolve, reject) => {
    const transaccion = base.transaction('pendientes', modo);
    const solicitud = fn(transaccion.objectStore('pendientes'));
    transaccion.oncomplete = () => { base.close(); resolve(solicitud.result); };
    transaccion.onabort = () => { base.close(); reject(transaccion.error); };
    transaccion.onerror = () => { base.close(); reject(transaccion.error); };
  });
}
export const guardar = (registro) => conStore('readwrite', (s) => s.put(registro));
export const leer = (id) => conStore('readonly', (s) => s.get(id));
export const borrar = (id) => conStore('readwrite', (s) => s.delete(id));
export const pendientes = () => conStore('readonly', (s) => s.getAll());
