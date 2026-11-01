// Carrito del portal (Issue #681, C2 de #643; docs/UX-COMPRA.md §4.2).
//
// COPIA DELIBERADA en site/public/catalogo.js: el sitio nunca importa de app/ ni la app de site/. La clave, el tope de 10
// piezas, el formato de ?carrito=ED-1,ED-2 y la revisión contra GET /api/catalogo?codigo= deben ser iguales en los dos lados.
// ponytail: el carrito es una lista de códigos en el localStorage de ESTE navegador; no se sincroniza entre dispositivos ni se
// guarda en el servidor. Lo que cuenta es el apartado (POST /api/portal/apartar), que revalida precio y existencia en D1.
import { pesos } from './vender.js';

export const TOPE_CARRITO = 10;
export const CLAVE_CARRITO = 'carrito-dolaron';
const CODIGO = /^ED-\d{1,10}$/;

/** Códigos válidos, en mayúsculas, sin repetir (son piezas únicas) y hasta el tope. */
export const codigosValidos = (lista) => [...new Set((Array.isArray(lista) ? lista : [])
  .map((c) => String(c ?? '').trim().toUpperCase()).filter((c) => CODIGO.test(c)))].slice(0, TOPE_CARRITO);

/** ?carrito=ED-1,ED-2 (lo que manda el sitio, #681); lo malformado se ignora. */
export const codigosDeUrl = (search) => codigosValidos((new URLSearchParams(search).get('carrito') || '').split(','));

/** Agrega un código: { lista, estado: 'agregado' | 'ya_estaba' | 'lleno' }. */
export function agregarCodigo(lista, codigo) {
  if (lista.includes(codigo)) return { lista, estado: 'ya_estaba' };
  if (lista.length >= TOPE_CARRITO) return { lista, estado: 'lleno' };
  return { lista: [...lista, codigo], estado: 'agregado' };
}

/**
 * Revisa cada código contra el catálogo público (el mismo que muestra la ficha): disponible, vendida (el catálogo ya no la
 * trae) o fallo de red. `pedir(url)` es fetch; se inyecta para la prueba.
 */
export async function piezasDe(codigos, pedir = (url) => fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })) {
  const lecturas = await Promise.all(codigos.map(async (codigo) => {
    try {
      const r = await pedir(`/api/catalogo?codigo=${encodeURIComponent(codigo)}`);
      if (!r.ok) return { codigo, fallo: true };
      const pieza = (await r.json()).piezas?.find((x) => x.codigo === codigo);
      return pieza ? { codigo, pieza } : { codigo, vendida: true };
    } catch { return { codigo, fallo: true }; }
  }));
  return { disponibles: lecturas.filter((l) => l.pieza).map((l) => l.pieza), vendidas: lecturas.filter((l) => l.vendida).map((l) => l.codigo),
    fallaron: lecturas.filter((l) => l.fallo).map((l) => l.codigo) };
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Arma el botón «Carrito (n)» (`.carrito-boton`, en la cabecera del catálogo) y la hoja <dialog id="carrito-dialogo"> (portal.html).
 * `alApartar(piezas)` recibe las piezas que SÍ siguen disponibles cuando se toca «Apartar todo» (abre el resumen de apartar.js).
 * Devuelve { codigos, cantidad, tiene, agregar(pieza), quitar(codigos), sumar(codigos), abrir() }.
 */
export function iniciarCarrito({ alApartar }) {
  const dialogo = document.getElementById('carrito-dialogo');
  const boton = document.querySelector('.carrito-boton');
  let lista = [];
  try { lista = codigosValidos(JSON.parse(localStorage.getItem(CLAVE_CARRITO) || '[]')); } catch { /* sin almacenamiento: el carrito vive solo en esta página */ }
  function guardar() {
    try { localStorage.setItem(CLAVE_CARRITO, JSON.stringify(lista)); } catch { /* idem */ }
    if (boton) boton.querySelector('.carrito-n').textContent = String(lista.length);
  }
  guardar();
  // Otra pestaña cambió el carrito: esta lo recoge.
  globalThis.addEventListener?.('storage', (e) => {
    if (e.key !== CLAVE_CARRITO) return;
    try { lista = codigosValidos(JSON.parse(e.newValue || '[]')); } catch { lista = []; }
    guardar();
  });

  const api = {
    codigos: () => [...lista],
    cantidad: () => lista.length,
    tiene: (codigo) => lista.includes(codigo),
    agregar(pieza) {
      const r = agregarCodigo(lista, pieza.codigo);
      lista = r.lista; guardar();
      return r.estado;
    },
    quitar(codigos) { lista = lista.filter((c) => !codigos.includes(c)); guardar(); },
    /** Suma los códigos que lleguen (p. ej. ?carrito= del sitio) hasta el tope; devuelve los que caben. */
    sumar(codigos) { for (const c of codigos) lista = agregarCodigo(lista, c).lista; guardar(); return codigos.filter((c) => lista.includes(c)); },
    abrir() {},
  };
  if (!dialogo || !boton) return api;

  const q = (sel) => dialogo.querySelector(sel);
  const titulo = q('.carrito-titulo'), ul = q('.carrito-lista'), vacio = q('.carrito-vacio'), total = q('.carrito-total'), aviso = q('.carrito-aviso');
  const apartar = q('.carrito-apartar'), cuerpoTotal = q('.carrito-resumen');
  let revision = null, generacion = 0;

  function pintar() {
    const { disponibles, vendidas, fallaron } = revision;
    const suma = disponibles.reduce((s, p) => s + p.precio, 0);
    ul.replaceChildren(...lista.map((codigo) => {
      const pieza = disponibles.find((p) => p.codigo === codigo);
      const vendida = vendidas.includes(codigo), fallo = fallaron.includes(codigo);
      const li = el('li', `carrito-item${vendida ? ' vendida' : ''}`);
      const foto = el('span', 'carrito-foto');
      const img = new Image();
      img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
      img.addEventListener('error', () => img.remove());   // una pieza vendida ya no tiene foto pública
      img.src = `/api/catalogo/foto/${encodeURIComponent(codigo)}`;
      foto.append(img);
      const nombre = pieza?.nombre ?? codigo;
      const datos = el('div', 'carrito-datos');
      datos.append(el('p', 'carrito-nombre', nombre),
        vendida ? el('p', 'carrito-precio carrito-vendida', 'Se vendió')
          : fallo ? el('p', 'carrito-precio carrito-vendida', 'No pudimos revisarla')
            : el('p', 'carrito-precio', pieza ? pesos(pieza.precio) : ''));
      const quitar = el('button', 'carrito-quitar secundario', 'Quitar');
      quitar.type = 'button';
      quitar.setAttribute('aria-label', `Quitar ${nombre} del carrito`);
      quitar.addEventListener('click', () => {
        api.quitar([codigo]);
        revision = { disponibles: disponibles.filter((p) => p.codigo !== codigo), vendidas: vendidas.filter((c) => c !== codigo), fallaron: fallaron.filter((c) => c !== codigo) };
        aviso.textContent = `Quitaste ${nombre}.`;
        pintar();
        (ul.querySelector('.carrito-quitar') ?? titulo).focus();
      });
      li.append(foto, datos, quitar);
      return li;
    }));
    titulo.textContent = `Tu carrito (${lista.length})`;
    vacio.hidden = lista.length > 0;
    cuerpoTotal.hidden = lista.length === 0;
    total.textContent = `Total de las piezas: ${pesos(suma)}`;
    apartar.disabled = !disponibles.length || fallaron.length > 0;
  }

  async function abrir() {
    const mia = ++generacion;
    aviso.textContent = '';
    revision = { disponibles: [], vendidas: [], fallaron: [] };
    ul.replaceChildren();
    vacio.hidden = true; cuerpoTotal.hidden = true;
    titulo.textContent = `Tu carrito (${lista.length})`;
    if (!dialogo.open) dialogo.showModal();
    titulo.focus();
    if (!lista.length) { pintar(); return; }
    aviso.textContent = 'Revisando que sigan disponibles…';
    const r = await piezasDe(lista);
    if (mia !== generacion || !dialogo.open) return;
    revision = r;
    pintar();
    const { vendidas, fallaron } = r;
    aviso.textContent = fallaron.length ? 'No pudimos revisar todas las piezas. Revisa tu red y vuelve a abrir el carrito.'
      : vendidas.length ? `${vendidas.length === 1 ? 'Una pieza ya se vendió' : `${vendidas.length} piezas ya se vendieron`}: no ${vendidas.length === 1 ? 'cuenta' : 'cuentan'} en el total.` : '';
  }
  api.abrir = abrir;

  boton.addEventListener('click', abrir);
  apartar.addEventListener('click', () => { if (!apartar.disabled && revision.disponibles.length) alApartar(revision.disponibles); });
  for (const cerrar of dialogo.querySelectorAll('.carrito-cerrar')) cerrar.addEventListener('click', () => dialogo.close());
  dialogo.addEventListener('click', (ev) => { if (ev.target === dialogo) dialogo.close(); });
  // Las que ya se vendieron se avisaron una vez: al cerrar salen del carrito.
  dialogo.addEventListener('close', () => {
    generacion++;
    if (revision?.vendidas.length) api.quitar(revision.vendidas);
  });
  return api;
}
