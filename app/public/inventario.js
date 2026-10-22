import { escucharLector } from './lector.js';
import { api, crearFicha, pesos } from './ficha.js';
import { $, nodo, boton, mensaje, hoja, confirmar, prepararHoja } from './inventario-ui.js';

prepararHoja();
const pc = () => matchMedia('(min-width:1000px)').matches;
const identidad = await api('/api/yo');
const modos = identidad.modos_inventario || [];
if (!modos.length) location.replace('/sin-acceso');
const dueno = identidad.usuario?.roles.includes('dueno');
let modo, siguiente = null, consulta = '', generacion = 0, apagar = null, piezaActual = null;
const modulos = new Map();
const foco = () => { if (pc()) { $('consulta').focus({ preventScroll:true }); $('consulta').select(); } };
const ficha = crearFicha({ mensaje, confirmar, alAbrir(p) {
  piezaActual = p; document.body.classList.add('con-ficha');
  $('solo-consulta').hidden = dueno || identidad.usuario?.editar_inventario === true;
  for (const b of document.querySelectorAll('.resultado')) b.setAttribute('aria-current', String(b.dataset.id === p.id));
  foco();
} });

export function resultado(p, alElegir = () => ficha.abrir(p.id)) {
  const li = nodo('li'), b = boton('', alElegir, 'resultado'), foto = nodo('img');
  b.dataset.id = p.id; foto.alt = ''; foto.loading = 'lazy';
  if (p.tiene_foto || p.foto_key) foto.src = `/api/foto/${p.id}`; else foto.hidden = true;
  foto.onerror = () => { foto.hidden = true; };
  const texto = nodo('span'); texto.append(nodo('b', p.nombre || 'Sin nombre'), nodo('small', `${p.codigo || 'Sin código'} · ${pesos(p.precio)}${!p.tiene_foto && !p.foto_key ? ' · sin foto' : ''}`));
  b.append(foto, texto, nodo('span', `×${p.stock}`, 'insignia')); li.append(b); return li;
}
async function buscar(mas = false) {
  if (!navigator.onLine) return mensaje('Este modo necesita red', 'aviso');
  const turno = ++generacion;
  if (!mas) { consulta = $('consulta').value.trim(); siguiente = null; $('resultados').replaceChildren(); ficha.cerrar(); document.body.classList.remove('con-ficha'); }
  if (!consulta) return mensaje('Escribe o escanea una pieza');
  mensaje('Buscando…');
  try {
    const datos = await api(`/api/piezas?${new URLSearchParams({ q:consulta, ...(mas && siguiente ? { cursor:siguiente } : {}) })}`);
    if (turno !== generacion) return;
    siguiente = datos.siguiente; $('mas').hidden = !siguiente;
    $('resultados').append(...datos.piezas.map((p) => resultado(p)));
    $('resumen').textContent = `${$('resultados').children.length} resultados`;
    mensaje(datos.piezas.length ? 'Resultados listos' : siguiente ? 'Busca más piezas' : 'Sin resultados');
    if (!mas && datos.piezas.length === 1) await ficha.abrir(datos.piezas[0].id);
  } catch(e) { if (turno === generacion) mensaje(e.message, 'error'); }
  foco();
}
const contexto = { $, nodo, boton, mensaje, hoja, confirmar, api, pesos, identidad, dueno, pc, foco, ficha, resultado,
  pieza:() => piezaActual, cambiarModo, imprimir:async (...args) => (await cargar('imprimir')).imprimir(...args) };
async function cargar(nombre) {
  if (!modulos.has(nombre)) {
    const archivo = { imprimir:'./inventario-imprimir.js', capturar:'./inventario-capturar.js', revisar:'./inventario-revisar.js' }[nombre];
    modulos.set(nombre, import(archivo).then((m) => m.iniciar(contexto)));
  }
  return modulos.get(nombre);
}
async function apagarCamaras() {
  await apagar?.(); apagar = null; $('visor').hidden = true;
  for (const promesa of modulos.values()) (await promesa).pausar?.();
}
async function cambiarModo(nuevo) {
  if (!modos.includes(nuevo)) return;
  await apagarCamaras(); ++generacion; ficha.cerrar(); piezaActual = null; document.body.classList.remove('con-ficha');
  modo = nuevo; localStorage.setItem('inventario-modo', modo); history.replaceState(null, '', `${location.pathname}${location.search}#${modo}`);
  for (const b of document.querySelectorAll('[data-modo]')) { const activo = b.dataset.modo === modo; b.setAttribute('aria-selected', String(activo)); b.tabIndex = activo ? 0 : -1; $(b.getAttribute('aria-controls')).hidden = !activo; }
  $('busqueda').hidden = modo === 'capturar' && !pc();
  $('consulta').placeholder = { capturar:'UPC, ED- o nombre', buscar:'ED-, UPC o nombre', revisar:'Buscar en la cola', imprimir:'Código para filtrar' }[modo];
  $('camara-etiqueta').hidden = modo !== 'buscar';
  if (modo === 'buscar') $('detalle-buscar').append($('ficha'));
  // Las fases siguientes activan estos módulos sin cargar hardware al abrir Buscar.
  if ($( `modo-${modo}`).dataset.activo) await (await cargar(modo)).abrir?.();
  mensaje(navigator.onLine ? 'Escanea o escribe' : 'Este modo necesita red', navigator.onLine ? 'neutro' : 'aviso'); foco();
}
for (const b of document.querySelectorAll('[data-modo]')) {
  b.hidden = !modos.includes(b.dataset.modo); b.onclick = () => cambiarModo(b.dataset.modo);
}
if (modos.length === 1) $('modos').hidden = true;
$('modos').addEventListener('keydown', (e) => {
  const teclas = ['ArrowLeft','ArrowRight','Home','End']; if (!teclas.includes(e.key)) return;
  e.preventDefault(); const i = modos.indexOf(modo), n = e.key === 'Home' ? 0 : e.key === 'End' ? modos.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + modos.length) % modos.length;
  void cambiarModo(modos[n]);
});
async function recibir({ codigo }) {
  if ($('hoja').open) return;
  $('consulta').value = codigo;
  if (modo === 'buscar') await buscar();
  else if ($(`modo-${modo}`).dataset.activo) await (await cargar(modo)).leer?.(codigo);
}
escucharLector((lectura) => { void recibir(lectura); }, { caja:$('consulta') });
$('busqueda').onsubmit = (e) => { e.preventDefault(); void recibir({ codigo:$('consulta').value }); };
$('mas').onclick = () => buscar(true);
$('volver').onclick = () => { ficha.cerrar(); piezaActual = null; document.body.classList.remove('con-ficha'); foco(); };
$('solo-consulta').onclick = () => hoja('Solo consulta', nodo('p', 'Tu cuenta no puede editar. Pídelo al dueño.'));
$('camara-etiqueta').onclick = async () => {
  try { await apagarCamaras(); $('visor').hidden = false; const { abrirCamara } = await import('./camara.js'); apagar = await abrirCamara('visor', (codigo) => recibir({ codigo })); }
  catch(e) { mensaje(e.message, 'error'); }
};
$('menu').onclick = () => {
  const c = nodo('div', undefined, 'formulario');
  for (const [clave, texto] of [['sonido','Sonido'],['vibracion','Vibración']]) {
    const b = boton(texto, () => { const activo = localStorage.getItem(`inventario-${clave}`) !== 'false'; localStorage.setItem(`inventario-${clave}`, String(!activo)); b.setAttribute('aria-checked', String(!activo)); });
    b.setAttribute('role','switch'); b.setAttribute('aria-checked', String(localStorage.getItem(`inventario-${clave}`) !== 'false')); c.append(b);
  }
  const inicio = nodo('a','Inicio'); inicio.href = '/'; c.append(inicio);
  if (!identidad.vendedor && (dueno || identidad.usuario?.roles.includes('capturista'))) { const a = nodo('a','Ajustes'); a.href = '/admin'; c.append(a); }
  hoja('Menú', c);
};
$('chip-red').onclick = () => { const c = nodo('div'); c.append(nodo('p', $('chip-red').textContent), boton('Subir ahora', async () => { await (await cargar('capturar')).subir?.(); } ,'primario')); hoja('Red', c); };
$('chip-celular').onclick = () => { const a = nodo('a','Abrir en el celular'); a.href = '/camara-remota'; hoja('Cámara para la PC', a); };
$('chip-impresora').onclick = async () => { if ($('modo-imprimir').dataset.activo) await (await cargar('imprimir')).conexion(); else mensaje('Conecta desde Etiquetas', 'aviso'); };
document.addEventListener('keydown', (e) => {
  if (e.altKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); void cambiarModo(['capturar','buscar','revisar','imprimir'][Number(e.key)-1]); }
  if (e.key === 'Escape' && !$('hoja').open) { $('consulta').value = ''; ficha.cerrar(); document.body.classList.remove('con-ficha'); foco(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) void apagarCamaras(); });
addEventListener('blur', () => { void apagarCamaras(); });
function red() { $('chip-red').textContent = navigator.onLine ? '● Red' : '▲ Sin red'; $('chip-red').classList.toggle('aviso', !navigator.onLine); if (!navigator.onLine) mensaje('Sin red · toma foto', 'aviso'); }
addEventListener('online', red); addEventListener('offline', red); red();
visualViewport?.addEventListener('resize', () => document.body.classList.toggle('teclado-abierto', visualViewport.height < innerHeight * .7));
await cambiarModo(new URLSearchParams(location.search).has('pieza') ? 'buscar' : modos.includes(location.hash.slice(1)) ? location.hash.slice(1) : modos.includes(localStorage.getItem('inventario-modo')) ? localStorage.getItem('inventario-modo') : modos[0]);
const inicial = new URLSearchParams(location.search).get('pieza'); if (inicial) { $('consulta').value = inicial; await buscar(); }
