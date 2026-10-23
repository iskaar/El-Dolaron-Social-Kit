import { escucharLector } from './lector.js';
import { api, crearFicha, pesos, resolverRepetida } from './ficha.js';
import { $, nodo, boton, mensaje, hoja, confirmar, prepararHoja, stepper, cerrarHoja, ponerNeutro, bloquear } from './inventario-ui.js';
import { montarPrecio, refrescarPrecios } from './inventario-precio.js';

prepararHoja();
const pc = () => matchMedia('(min-width:1000px)').matches;
const identidad = await api('/api/yo');
const modos = identidad.modos_inventario || [];
if (!modos.length) location.replace('/sin-acceso');
const dueno = identidad.usuario?.roles.includes('dueno');
let modo, siguiente = null, consulta = '', generacion = 0, cambioModo = 0, apagar = null, piezaActual = null, filtroTimer, cargando = false;
const modulos = new Map(), activos = new Map();
const foco = () => { if (pc()) { $('consulta').focus({ preventScroll:true }); $('consulta').select(); } };
const ficha = crearFicha({ mensaje, confirmar, integrada:true, antesCamara:apagarCamaras,
  alRepetida:(origen,destino,upc) => resolverRepetida(origen,destino,{...contexto,cerrar:cerrarHoja,upc,alTerminar:id=>ficha.abrir(id)}), elegirMotivo:() => new Promise(resolve => {
  const c=nodo('div',undefined,'chips');
  for(const [valor,texto] of [['correccion','Corrección'],['merma','Merma'],['robo','Robo'],['entrada','Entrada']]) c.append(boton(texto,()=>{ resolve(valor);cerrarHoja(); }));
  hoja('Motivo',c);$('hoja').addEventListener('close',()=>resolve(null),{once:true});
}), alAbrir(p, datos) {
  piezaActual = p; document.body.classList.add('con-ficha');
  montarPrecio(contexto, $('bloque-precio'), p, datos?.solicitud_precio ?? null);
  $('solo-consulta').hidden = dueno || identidad.usuario?.editar_inventario === true;
  for (const b of document.querySelectorAll('.resultado')) b.setAttribute('aria-current', String(b.dataset.id === p.id));
  $('acciones-ficha').replaceChildren();
  if (dueno || identidad.usuario?.editar_inventario === true) $('acciones-ficha').append(boton('Fijar a…', () => {
    const form=$('fijar');form.hidden=false;hoja('Fijar existencia',form);
    $('hoja').addEventListener('close',()=>{form.hidden=true;$('existencia').prepend(form);},{once:true});
  }));
  if (etiquetable(p)) {
    const imprimir = async (n) => (await cargar('imprimir')).imprimir([p.id], new Map([[p.id,n]]), { reimprimir:true });
    $('acciones-ficha').append(boton('Reimprimir etiqueta', () => imprimir(1), 'primario'), boton('Varias copias…', () => {
      let n = 1; const c = nodo('div'); c.append(stepper(n, v => n = v, { nombre:'Copias' }), boton('Imprimir', async () => { cerrarHoja(); await imprimir(n); }, 'primario')); hoja('Copias', c);
    }));
  }
  if (dueno || identidad.usuario?.editar_inventario === true) $('acciones-ficha').append(boton(pc() ? 'Foto con celular' : 'Foto nueva', async () => { await (await cargar('capturar')).fotoPieza(p); await ficha.abrir(p.id); }));
  foco();
} });

export function resultado(p, alElegir = () => ficha.abrir(p.id), reimprimir = false) {
  const li = nodo('li'), b = boton('', alElegir, 'resultado'), foto = nodo('span', undefined, 'mini-foto'), imagen = nodo('img');
  const conFoto = p.tiene_foto || p.foto_key;
  b.dataset.id = p.id; imagen.alt = ''; imagen.loading = 'lazy';
  foto.textContent = 'Sin foto';
  if (conFoto) { imagen.src = `/api/foto/${p.id}`; foto.replaceChildren(imagen); }
  imagen.onerror = () => { foto.textContent = 'Sin foto'; };
  const texto = nodo('span', undefined, 'texto-pieza'), codigo = nodo(p.codigo ? 'code' : 'small', p.codigo || 'Sin código');
  texto.append(codigo, nodo('b', p.nombre || 'Sin nombre'), nodo('small', `${pesos(p.precio)}${p.upc ? ` · ${p.upc}` : ''}${!conFoto ? ' · sin foto' : ''}`));
  b.append(foto, texto, nodo('span', `×${p.stock}`, 'insignia')); li.append(b);
  if (reimprimir) li.className = 'fila-busqueda';
  if (reimprimir && p.codigo && etiquetable(p)) {
    const imprimir = boton('', async (boton) => {
      bloquear(boton, 'Espera el envío'); boton.setAttribute('aria-busy', 'true');
      try { if (await contexto.imprimir([p.id], new Map([[p.id,1]]), { reimprimir:true })) mensaje(`Etiqueta enviada · ${p.codigo}`, 'etiqueta'); }
      finally { bloquear(boton, ''); boton.setAttribute('aria-busy', 'false'); }
    }, 'reimprimir-pieza');
    const icono = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), uso = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    icono.setAttribute('class', 'icono'); icono.setAttribute('aria-hidden', 'true'); icono.setAttribute('focusable', 'false'); uso.setAttribute('href', '#i-impresora'); icono.append(uso); imprimir.prepend(icono);
    imprimir.append(nodo('span', 'Reimprimir', 'txt-reimprimir')); imprimir.setAttribute('aria-label', `Reimprimir etiqueta ${p.codigo}`); imprimir.title = `Reimprimir etiqueta ${p.codigo}`; li.append(imprimir);
  }
  return li;
}
// Reimprimir pide quedarse con la etiqueta en la base, que rechaza lo vendido o no listo: ahi el boton no se ofrece.
function etiquetable(p) { return p.destino === 'etiqueta' && p.stock > 0 && (p.estado_analisis ?? 'listo') === 'listo'; }
const NEUTRO_BUSCAR = 'Busca por código o nombre';
const filtroCorto = (q) => q.length > 0 && q.length < 3 && !/^\d+$/.test(q);
async function buscar(mas = false, abrir = false) {
  clearTimeout(filtroTimer);
  if (mas && (!siguiente || cargando)) return;
  if (!navigator.onLine) return mensaje('Este modo necesita red', 'aviso');
  const turno = ++generacion;
  if (!mas) { const q = $('consulta').value.trim(); consulta = filtroCorto(q) ? '' : q; siguiente = null; $('mas').hidden = true; $('resultados').replaceChildren(); ficha.cerrar(); piezaActual = null; document.body.classList.remove('con-ficha'); }
  cargando = true; bloquear($('mas'), 'Cargando piezas'); $('resultados').setAttribute('aria-busy', 'true');
  mensaje('Buscando…');
  try {
    const datos = await api(`/api/piezas?${new URLSearchParams({ q:consulta, ...(mas && siguiente ? { cursor:siguiente } : {}) })}`);
    if (turno !== generacion) return;
    siguiente = datos.siguiente; $('mas').hidden = !siguiente;
    $('resultados').append(...datos.piezas.map((p) => resultado(p, undefined, true)));
    const total = $('resultados').children.length; $('resumen').className = 'ayuda';
    $('resumen').textContent = consulta ? `${total}${siguiente ? '+' : ''} ${total === 1 && !siguiente ? 'resultado' : 'resultados'} para «${consulta}»` : 'Todo el inventario · más recientes primero';
    mensaje(filtroCorto($('consulta').value.trim()) ? 'Escribe 3 letras o un código' : siguiente && !total ? 'Carga más piezas' : NEUTRO_BUSCAR);
    if (abrir && consulta && !mas && datos.piezas.length === 1 && !siguiente) await ficha.abrir(datos.piezas[0].id);
  } catch(e) { if (turno === generacion) mensaje(e.message, 'error'); }
  finally { if (turno === generacion) { cargando = false; bloquear($('mas'), ''); $('resultados').setAttribute('aria-busy', 'false'); } }
}
const contexto = { $, nodo, boton, mensaje, hoja, confirmar, api, pesos, identidad, dueno, pc, foco, ficha, resultado,
  pieza:() => piezaActual, cambiarModo, imprimir:async (...args) => (await cargar('imprimir')).imprimir(...args) };
async function cargar(nombre) {
  if (!modulos.has(nombre)) {
    const archivo = { imprimir:'./inventario-imprimir.js', capturar:'./inventario-capturar.js', revisar:'./inventario-revisar.js' }[nombre];
    modulos.set(nombre, import(archivo).then((m) => m.iniciar(contexto)).then(instancia => {
      activos.set(nombre,instancia);if(modo!==nombre)instancia.pausar?.();return instancia;
    }).catch(e=>{modulos.delete(nombre);throw e;}));
  }
  return modulos.get(nombre);
}
async function apagarCamaras() {
  await apagar?.(); apagar = null; $('visor').hidden = true;
  for (const instancia of activos.values()) instancia.pausar?.();
}
async function cambiarModo(nuevo) {
  if (!modos.includes(nuevo)) return;
  const turno=++cambioModo;
  await apagarCamaras();if(turno!==cambioModo)return; clearTimeout(filtroTimer); ++generacion; cargando = false; ficha.cerrar(); piezaActual = null; document.body.classList.remove('con-ficha');
  modo = nuevo; if (dueno && nuevo !== 'revisar') actualizarPrecios();
  localStorage.setItem('inventario-modo', modo); history.replaceState(null, '', `${location.pathname}${location.search}#${modo}`);
  $('consulta').value='';
  for (const b of document.querySelectorAll('[data-modo]')) { const activo = b.dataset.modo === modo; b.setAttribute('aria-selected', String(activo)); b.tabIndex = activo ? 0 : -1; $(b.getAttribute('aria-controls')).hidden = !activo; }
  $('busqueda').hidden = modo === 'capturar' && !pc();
  $('consulta').placeholder = { capturar:'UPC, ED- o nombre', buscar:'ED-, nombre o UPC', revisar:'Buscar en la cola', imprimir:'Código para filtrar' }[modo];
  $('consulta').inputMode = modo === 'buscar' ? 'search' : 'none';
  $('camara-etiqueta').hidden = modo !== 'buscar';
  const neutros = { capturar: pc() ? 'Escanea o escribe' : 'Escanea o toma foto', buscar: NEUTRO_BUSCAR, revisar: 'Revisa tus piezas', imprimir: 'Etiquetas por imprimir' };
  ponerNeutro(neutros[modo]);
  mensaje(navigator.onLine ? neutros[modo] : modo === 'capturar' ? 'Sin red · toma foto' : 'Este modo necesita red', navigator.onLine ? 'neutro' : 'aviso');
  if (modo === 'buscar') { $('detalle-buscar').append($('ficha')); await buscar(); if (turno !== cambioModo) return; }
  // Las fases siguientes activan estos módulos sin cargar hardware al abrir Buscar.
  if ($( `modo-${modo}`).dataset.activo) {
    const instancia=await cargar(modo);if(turno!==cambioModo)return;await instancia.abrir?.();
  }
  foco();
}
for (const b of document.querySelectorAll('[data-modo]')) {
  b.hidden = !modos.includes(b.dataset.modo); b.onclick = () => cambiarModo(b.dataset.modo).catch(e=>mensaje(e.message,'error'));

}
if (modos.length === 1) $('modos').hidden = true;
$('modos').addEventListener('keydown', (e) => {
  const teclas = ['ArrowLeft','ArrowRight','Home','End']; if (!teclas.includes(e.key)) return;
  e.preventDefault(); const i = modos.indexOf(modo), n = e.key === 'Home' ? 0 : e.key === 'End' ? modos.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + modos.length) % modos.length;
  void cambiarModo(modos[n]);
});
// Precios por revisar (#451): el dueño ve cuántas esperan en la pestaña Revisar, con número y no solo con color.
const insigniaPrecios = nodo('span', '', 'insignia insignia-modo'); insigniaPrecios.hidden = true; insigniaPrecios.setAttribute('aria-hidden', 'true');
const actualizarPrecios = () => { if (navigator.onLine) refrescarPrecios().catch(() => {}); };
if (dueno) {
  $('tab-revisar').append(insigniaPrecios);
  document.addEventListener('precios', (e) => {
    const n = e.detail; insigniaPrecios.hidden = !n; insigniaPrecios.textContent = n > 99 ? '99+' : String(n);
    if (n) $('tab-revisar').setAttribute('aria-label', `Revisar, ${n} ${n === 1 ? 'precio' : 'precios'} por revisar`); else $('tab-revisar').removeAttribute('aria-label');
  });
  addEventListener('online', actualizarPrecios);
}
async function recibir({ codigo }) {
  if ($('hoja').open) return;
  $('consulta').value = codigo;
  if (modo === 'buscar') await buscar(false, true);
  else if ($(`modo-${modo}`).dataset.activo) await (await cargar(modo)).leer?.(codigo);
}
const lector=escucharLector((lectura) => recibir(lectura).catch(e=>mensaje(e.message,'error')), { caja:$('consulta') });
contexto.recibir=(codigo,origen)=>lector.recibir(codigo,origen);
$('busqueda').onsubmit = (e) => { e.preventDefault(); void lector.recibir($('consulta').value,'caja'); };
$('consulta').addEventListener('input', () => {
  if (modo !== 'buscar') return;
  clearTimeout(filtroTimer); ficha.cerrar(); piezaActual = null; document.body.classList.remove('con-ficha');
  const q = $('consulta').value.trim();
  if (filtroCorto(q) && !consulta) { bloquear($('mas'), cargando ? 'Cargando piezas' : ''); mensaje('Escribe 3 letras o un código'); return; }
  ++generacion; cargando = false;
  if (!q || filtroCorto(q)) { void buscar(); return; }
  bloquear($('mas'), 'Espera el filtro');
  filtroTimer = setTimeout(() => { void buscar(); }, 250);
});
$('mas').onclick = () => buscar(true);
const observador = globalThis.IntersectionObserver ? new IntersectionObserver((entradas) => {
  if (modo === 'buscar' && !document.body.classList.contains('con-ficha') && entradas.some(e => e.isIntersecting) && $('mas').getAttribute('aria-disabled') !== 'true') void buscar(true);
}, { rootMargin:'160px' }) : null;
observador?.observe($('mas'));
$('volver').onclick = async () => { if(modo==='revisar') (await cargar('revisar')).cerrar(); ficha.cerrar(); piezaActual = null; document.body.classList.remove('con-ficha'); foco(); };
$('solo-consulta').onclick = () => hoja('Solo consulta', nodo('p', 'Tu cuenta no puede editar. Pídelo al dueño.'));
$('camara-etiqueta').onclick = async () => {
  try { await apagarCamaras(); $('visor').hidden = false; const { abrirCamara } = await import('./camara.js'); apagar = await abrirCamara('visor', (codigo) => recibir({ codigo })); }
  catch(e) { mensaje(e.message, 'error'); }
};
$('menu').onclick = () => {
  const c = nodo('div', undefined, 'formulario');
  if (!pc() && modo === 'capturar') c.append(boton('⌨ Escribir', () => { cerrarHoja(); $('busqueda').hidden = false; $('consulta').inputMode = 'numeric'; $('consulta').focus(); }));
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
document.addEventListener('click', (e) => {
  const b=e.target.closest?.('[aria-disabled="true"]');
  if (b) { e.preventDefault();e.stopImmediatePropagation();mensaje(b.dataset.motivo||'Espera un momento','aviso'); }
}, true);
document.addEventListener('keydown', (e) => {
  if (e.altKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); void cambiarModo(['capturar','buscar','revisar','imprimir'][Number(e.key)-1]); }
  if (e.key === 'Escape' && !$('hoja').open) { $('consulta').value = ''; ficha.cerrar(); document.body.classList.remove('con-ficha'); if (modo === 'buscar') void buscar(); foco(); }
  if (e.key === 'Enter' && pc() && e.target === $('consulta') && !$('consulta').value && !$('hoja').open) {
    e.preventDefault();const b=[...$(`modo-${modo}`).querySelectorAll('.primario')].find(b=>b.getClientRects().length);b?.click();
  }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) void apagarCamaras(); });
addEventListener('blur', () => { void apagarCamaras(); });
function red() { $('chip-red').textContent = navigator.onLine ? '● Red' : '▲ Sin red'; $('chip-red').classList.toggle('aviso', !navigator.onLine);ficha.repintar(); if (!navigator.onLine) mensaje('Sin red · toma foto', 'aviso'); }
addEventListener('online', red); addEventListener('offline', red); red();
visualViewport?.addEventListener('resize', () => document.body.classList.toggle('teclado-abierto', visualViewport.height < innerHeight * .7));
await cambiarModo(new URLSearchParams(location.search).has('pieza') ? 'buscar' : modos.includes(location.hash.slice(1)) ? location.hash.slice(1) : modos.includes(localStorage.getItem('inventario-modo')) ? localStorage.getItem('inventario-modo') : modos[0]);
// Celular (#440): recupera sin clic la impresora que el navegador recuerda; si no se puede, el chip sigue pidiendo conectarla.
if (!pc() && modos.includes('imprimir') && navigator.bluetooth?.getDevices) void import('./etiquetera.js').then(async (m) => {
  if (await m.reconectarEtiquetera()) { $('chip-impresora').textContent = '● Impresora · Lista'; $('chip-impresora').classList.remove('aviso'); }
}).catch(() => {});
const inicial = new URLSearchParams(location.search).get('pieza'); if (inicial) { $('consulta').value = inicial; await buscar(false, true); }
