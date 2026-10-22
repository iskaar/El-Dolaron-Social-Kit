import { abrirCamara } from './camara.js';
import { api, crearFicha, pesos } from './ficha.js';

const $ = (id) => document.getElementById(id);
const mensaje = (texto) => { $('estado').textContent = texto; };
let siguiente = null, consulta = '', generacion = 0;
let apagarCamara = null;

// La ficha (datos, existencia ± y corrección) vive en ficha.js; aquí solo la búsqueda, el lector y la cámara.
const ficha = crearFicha({ mensaje, alAbrir: (pieza) => {
  document.body.classList.add('con-ficha');
  for (const b of document.querySelectorAll('.resultado')) b.setAttribute('aria-current', String(b.dataset.id === pieza.id));
  if (matchMedia('(min-width:1000px)').matches) foco();
} });
const abrir = (id) => ficha.abrir(id);

function resultado(p) {
  const li = document.createElement('li'), b = document.createElement('button');
  b.type = 'button'; b.className = 'resultado'; b.dataset.id = p.id;
  const foto = document.createElement('img');
  foto.alt = ''; foto.loading = 'lazy';
  if (p.tiene_foto) foto.src = `/api/foto/${p.id}`; else foto.hidden = true;
  const texto = document.createElement('span'), nombre = document.createElement('b'), detalle = document.createElement('small'), stock = document.createElement('span');
  nombre.textContent = p.nombre || 'Sin nombre'; detalle.textContent = `${p.codigo || 'Sin código'} · ${pesos(p.precio)}`; stock.textContent = `×${p.stock}`;
  texto.append(nombre, detalle); b.append(foto, texto, stock);
  foto.addEventListener('error', () => { foto.hidden = true; });
  b.addEventListener('click', () => { void abrir(p.id); }); li.append(b); return li;
}

async function buscar(mas = false) {
  if (mas && (!siguiente || $('mas').disabled)) return;
  const turno = ++generacion;
  if (!mas) {
    ficha.cerrar();
    consulta = $('consulta').value.trim(); siguiente = null; $('resultados').replaceChildren();
    $('mas').hidden = true; document.body.classList.remove('con-ficha');
  }
  // En celular, enfocar tras leer con la cámara abre el teclado encima del resultado.
  if (matchMedia('(min-width:1000px)').matches) foco();
  const q = consulta;
  if (!q) return mensaje('Escribe un código o el nombre de la pieza.');
  $('mas').disabled = true;
  mensaje('Buscando…');
  try {
    const datos = await api(`/api/piezas?q=${encodeURIComponent(q)}${siguiente ? `&cursor=${encodeURIComponent(siguiente)}` : ''}`);
    if (turno !== generacion) return;
    siguiente = datos.siguiente;
    $('resultados').append(...datos.piezas.map(resultado));
    $('mas').hidden = !siguiente;
    const n = $('resultados').children.length;
    $('resumen').textContent = `${n} ${n === 1 ? 'pieza encontrada' : 'piezas encontradas'}${siguiente ? ' · Hay más catálogo por revisar.' : '.'}`;
    mensaje(datos.piezas.length ? 'Resultados listos.' : siguiente ? 'Sin coincidencias en este tramo. Pulsa Buscar más.' : 'No se encontraron piezas.');
    if (!mas && datos.piezas.length === 1) await abrir(datos.piezas[0].id);
    else document.body.classList.remove('con-ficha');
  } catch (error) { if (turno === generacion) mensaje(error.message); }
  finally { if (turno === generacion) $('mas').disabled = false; }
}

$('busqueda').addEventListener('submit', (e) => { e.preventDefault(); void buscar(); });
$('mas').addEventListener('click', () => void buscar(true));
$('consulta').addEventListener('input', () => {
  ++generacion; ficha.cerrar(); siguiente = null;
  $('mas').hidden = true; $('mas').disabled = false; $('resultados').replaceChildren();
  mensaje('Presiona Enter o Buscar para consultar.');
});
const foco = () => { $('consulta').focus({ preventScroll:true }); $('consulta').select(); };
$('volver').addEventListener('click', () => { ficha.invalidar(); document.body.classList.remove('con-ficha'); foco(); });
// Patrón de /escanear: Enter del lector abre la pieza sin activar el último botón tocado.
let tecleado = '', ultimaTecla = 0;
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,select,textarea') || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'Enter' && tecleado) { e.preventDefault(); $('consulta').value = tecleado; tecleado = ''; void buscar(); }
  else if (/^[\da-z-]$/i.test(e.key)) { if (Date.now() - ultimaTecla > 250) tecleado = ''; tecleado += e.key; ultimaTecla = Date.now(); }
});
$('camara').addEventListener('click', async () => {
  if ($('camara').disabled) return;
  $('camara').disabled = true;
  try {
    if (apagarCamara) { await apagarCamara(); apagarCamara = null; $('visor').hidden = true; }
    else {
      document.body.classList.remove('con-ficha'); $('visor').hidden = false;
      apagarCamara = await abrirCamara('visor', (codigo) => { $('consulta').value = codigo; void buscar(); });
    }
    $('camara').setAttribute('aria-expanded', String(!!apagarCamara));
    $('camara').textContent = apagarCamara ? 'Apagar cámara' : 'Cámara';
  } catch (error) { $('visor').hidden = true; mensaje(error.message); }
  finally { $('camara').disabled = false; }
});
document.addEventListener('visibilitychange', async () => {
  if (document.hidden && apagarCamara) { await apagarCamara(); apagarCamara = null; $('visor').hidden = true; $('camara').textContent = 'Cámara'; $('camara').setAttribute('aria-expanded', 'false'); }
});
foco();
