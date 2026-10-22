import { abrirCamara } from './camara.js';
import { CATEGORIAS } from './categorias.js';
import { nombreEstado } from './estados.js';

const $ = (id) => document.getElementById(id);
const pesos = (centavos) => new Intl.NumberFormat('es-MX', { style:'currency', currency:'MXN', maximumFractionDigits:2 }).format(centavos / 100);
const mensaje = (texto) => { $('estado').textContent = texto; };
let pieza, siguiente = null, consulta = '', generacion = 0, apertura = 0;
let apagarCamara = null;

async function api(ruta) {
  const r = await fetch(ruta, { cache:'no-store', signal:AbortSignal.timeout(15000) });
  const datos = await r.json();
  if (!r.ok) throw Object.assign(new Error(datos.error || 'No se pudo completar la acción.'), { status:r.status, datos });
  return datos;
}

function pintar() {
  $('ficha').hidden = !pieza;
  if (!pieza) return;
  $('codigo').textContent = pieza.codigo || 'Sin código asignado';
  $('nombre').textContent = pieza.nombre || 'Sin nombre';
  $('detalles').textContent = [pieza.marca, pieza.talla, nombreEstado(pieza.estado_fisico), CATEGORIAS.find(([c]) => c === pieza.categoria)?.[1]].filter(Boolean).join(' · ');
  $('upc').textContent = pieza.upc ? `UPC: ${pieza.upc}` : 'Sin UPC';
  $('precio').textContent = pesos(pieza.precio);
  $('precio-lista').textContent = pieza.precio_lista > 0 ? `Lista ${pesos(pieza.precio_lista)}` : '';
  $('stock').value = String(pieza.stock);
  $('foto').hidden = !pieza.tiene_foto;
  $('sin-foto').hidden = !!pieza.tiene_foto;
  if (pieza.tiene_foto) { $('foto').src = `/api/foto/${pieza.id}?v=${encodeURIComponent(pieza.actualizado_en)}`; $('foto').alt = pieza.nombre; }
}

async function abrir(id) {
  const turno = ++apertura;
  pieza = null; pintar();
  try {
    const datos = await api(`/api/piezas/${id}`);
    if (turno !== apertura) return;
    pieza = datos.pieza;
    $('historial').replaceChildren();
    for (const a of datos.historial) {
      const li = document.createElement('li');
      const delta = a.despues - a.antes;
      li.textContent = `${new Date(a.ajustado_en).toLocaleString('es-MX', { timeZone:'America/Mexico_City' })} · ${delta > 0 ? '+' : ''}${delta} · ${a.antes} → ${a.despues} · ${a.motivo} · ${a.ajustado_por}`;
      $('historial').append(li);
    }
    if (!datos.historial.length) { const li = document.createElement('li'); li.textContent = 'Sin ajustes registrados.'; $('historial').append(li); }
    document.body.classList.add('con-ficha');
    pintar();
    for (const b of document.querySelectorAll('.resultado')) b.setAttribute('aria-current', String(b.dataset.id === id));
    mensaje(`Pieza abierta: ${pieza.nombre}. Existencia ${pieza.stock}.`);
    if (matchMedia('(min-width:1000px)').matches) foco();
  } catch (error) { if (turno === apertura) mensaje(error.message); }
}

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
    ++apertura; pieza = null; pintar();
    consulta = $('consulta').value.trim(); siguiente = null; $('resultados').replaceChildren();
    $('mas').hidden = true; document.body.classList.remove('con-ficha');
  }
  foco();
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
  ++generacion; ++apertura; siguiente = null; pieza = null; pintar();
  $('mas').hidden = true; $('mas').disabled = false; $('resultados').replaceChildren();
  mensaje('Presiona Enter o Buscar para consultar.');
});
const foco = () => { $('consulta').focus({ preventScroll:true }); $('consulta').select(); };
$('volver').addEventListener('click', () => { ++apertura; document.body.classList.remove('con-ficha'); foco(); });
$('foto').addEventListener('error', () => { $('foto').hidden = true; $('sin-foto').hidden = false; });
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
