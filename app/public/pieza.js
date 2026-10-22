import { abrirCamara } from './camara.js';
import { CATEGORIAS } from './categorias.js';
import { nombreEstado } from './estados.js';
import { TALLAS } from './tallas.js';

const $ = (id) => document.getElementById(id);
export const pesos = (centavos) => new Intl.NumberFormat('es-MX', { style:'currency', currency:'MXN', maximumFractionDigits:2 }).format(centavos / 100);
const mensaje = (texto) => { $('estado').textContent = texto; };
let usuario, pieza, siguiente = null, consulta = '', generacion = 0, apertura = 0, ocupado = false;
let apagarCamara = null;
const puedeEditar = () => usuario?.roles.some((r) => ['dueno', 'inventario'].includes(r));

async function api(ruta, cuerpo, method = 'POST') {
  const r = await fetch(ruta, cuerpo === undefined ? { cache:'no-store' } : {
    method, headers:{ 'content-type':'application/json' }, body:JSON.stringify(cuerpo),
  });
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
  $('precio').textContent = pesos(pieza.precio);
  $('precio-lista').textContent = pieza.precio_lista > 0 ? `Lista ${pesos(pieza.precio_lista)}` : '';
  $('stock').value = String(pieza.stock);
  $('foto').hidden = !pieza.tiene_foto;
  $('sin-foto').hidden = !!pieza.tiene_foto;
  if (pieza.tiene_foto) { $('foto').src = `/api/foto/${pieza.id}?v=${encodeURIComponent(pieza.actualizado_en)}`; $('foto').alt = pieza.nombre; }
  $('consulta-sola').hidden = puedeEditar();
  $('ajustar').hidden = !puedeEditar();
  $('menos').disabled = !puedeEditar() || ocupado || pieza.stock <= 0;
  $('sumar').disabled = !puedeEditar() || ocupado || pieza.stock >= 999;
  $('editar').hidden = !puedeEditar();
  $('editar').disabled = ocupado;
  const hoy = new Intl.DateTimeFormat('sv-SE', { timeZone:'America/Mexico_City' });
  $('cola-hoy').hidden = !Number.isFinite(Date.parse(pieza.creado_en)) || hoy.format(new Date(pieza.creado_en)) !== hoy.format(new Date());
  const motivo = motivoNoImprimir(pieza);
  $('no-imprimir').textContent = motivo;
  $('imprimir').disabled = ocupado || !!motivo;
}

export function motivoNoImprimir(p) {
  if (p.destino !== 'etiqueta') return 'Es de banda: su etiqueta se imprime en /bandas.';
  if (p.estado_analisis !== 'listo' || !p.nombre?.trim() || p.precio <= 0) return 'Necesita nombre, precio y revisión lista antes de imprimir.';
  return p.stock <= 0 ? 'Sin existencia: no hay etiquetas para imprimir.' : '';
}

async function abrir(id) {
  const turno = ++apertura;
  try {
    const datos = await api(`/api/piezas/${id}`);
    if (turno !== apertura) return;
    pieza = datos.pieza;
    $('editor').hidden = true;
    $('reimprimir-aviso').hidden = true;
    $('fijar-form').hidden = true;
    $('copias').value = '1';
    $('pausas').hidden = true;
    $('historial').replaceChildren();
    for (const a of datos.ajustes) {
      const li = document.createElement('li');
      const delta = a.despues - a.antes;
      li.textContent = `${new Date(a.ajustado_en).toLocaleString('es-MX')} · ${delta > 0 ? '+' : ''}${delta} · ${a.antes} → ${a.despues} · ${a.motivo} · ${a.ajustado_por}`;
      $('historial').append(li);
    }
    if (!datos.ajustes.length) { const li = document.createElement('li'); li.textContent = 'Sin ajustes registrados.'; $('historial').append(li); }
    document.body.classList.add('con-ficha');
    pintar();
    for (const b of document.querySelectorAll('.resultado')) b.setAttribute('aria-current', String(b.dataset.id === id));
    mensaje(`Pieza abierta: ${pieza.nombre}. Existencia ${pieza.stock}.`);
    if (matchMedia('(min-width:900px)').matches) { $('consulta').focus(); $('consulta').select(); }
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
  b.addEventListener('click', () => { if (!ocupado) void abrir(p.id); }); li.append(b); return li;
}

async function buscar(mas = false) {
  if (ocupado) return;
  const turno = ++generacion;
  if (!mas) { consulta = $('consulta').value.trim(); siguiente = null; $('resultados').replaceChildren(); }
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
    $('resumen').textContent = `${$('resultados').children.length} piezas encontradas${siguiente ? ' · Hay más catálogo por revisar.' : '.'}`;
    mensaje(datos.piezas.length ? 'Resultados listos.' : siguiente ? 'Sin coincidencias en este tramo. Pulsa Buscar más.' : 'No se encontraron piezas.');
    if (!mas && datos.piezas.length === 1) await abrir(datos.piezas[0].id);
    else document.body.classList.remove('con-ficha');
  } catch (error) { if (turno === generacion) mensaje(error.message); }
  finally { if (turno === generacion) $('mas').disabled = false; }
}

$('busqueda').addEventListener('submit', (e) => { e.preventDefault(); void buscar(); });
$('mas').addEventListener('click', () => void buscar(true));
$('volver').addEventListener('click', () => { document.body.classList.remove('con-ficha'); $('consulta').focus(); $('consulta').select(); });
// El Enter del lector cambia la ficha; nunca pulsa el último botón de existencia.
let tecleado = '', ultimaTecla = 0;
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,select,textarea') || !$('editor').hidden || ocupado) return;
  if (e.key === 'Enter' && tecleado) { e.preventDefault(); $('consulta').value = tecleado; tecleado = ''; void buscar(); }
  else if (/^[\da-z-]$/i.test(e.key)) { if (Date.now() - ultimaTecla > 250) tecleado = ''; tecleado += e.key; ultimaTecla = Date.now(); }
});
$('camara').addEventListener('click', async () => {
  if (ocupado) return;
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
for (const talla of TALLAS) $('editar-talla').add(new Option(talla, talla));
try { ({ usuario } = await api('/api/yo')); } catch (error) { mensaje(error.message); }
$('consulta').focus();
