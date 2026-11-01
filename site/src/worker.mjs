// Vista previa por pieza (Issue #671): https://eldolaron.com/?pieza=ED-000123 reescribe las etiquetas
// Open Graph de la portada con la foto, el nombre y el precio de esa pieza. Todo lo demás lo sirven los
// assets tal cual. Autocontenido: el sitio no importa código de app/ (las constantes son copias de
// site/public/catalogo.js y app/public/venta.js). Cualquier fallo sirve el HTML original; sin cookies ni logs.

const API = 'https://dolarones.eldolaron.com/api/catalogo';
const FOTOS = 'https://dolarones.eldolaron.com/api/catalogo/';
const CODIGO = /^ED-\d{1,10}$/i;
const ESPERA_MS = 1500;
const APARTADO = 100_00;
const ENVIO_COSTO = 99_00;
const ENVIO_GRATIS_DESDE = 1000_00;

const precio = (centavos) => new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'MXN',
  minimumFractionDigits: centavos % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
}).format(centavos / 100);

// ponytail: sin la fecha del viernes de envío (la ficha la calcula); la vista previa se guarda en WhatsApp y se vencería.
function descripcion(p) {
  const paga = p.precio < APARTADO ? 'Se paga completa al apartar.' : `Apártala con ${precio(APARTADO)} por 7 días.`;
  return `${p.ultima === true ? '¡Última pieza! ' : ''}${paga} Recoge en Soledad (11 a 8) o te la enviamos el viernes (envío nacional gratis desde ${precio(ENVIO_GRATIS_DESDE)}; si no, ${precio(ENVIO_COSTO)}).`;
}

/** La pieza o null; nunca lanza. Solo acepta lo que la API promete (código igual, precio entero, foto de la API). */
async function buscar(codigo) {
  try {
    const r = await fetch(`${API}?codigo=${codigo}`, { signal: AbortSignal.timeout(ESPERA_MS) });
    if (!r.ok) return null;
    const p = (await r.json())?.piezas?.[0];
    const imagen = p?.recorte || p?.foto;
    if (!p || p.codigo !== codigo || typeof p.nombre !== 'string' || !p.nombre.trim()
      || !Number.isInteger(p.precio) || p.precio <= 0 || typeof imagen !== 'string' || !imagen.startsWith(FOTOS)) return null;
    return { nombre: p.nombre.trim(), precio: p.precio, ultima: p.ultima, imagen };
  } catch { return null; }
}

function reescribir(respuesta, p, url) {
  const titulo = `${p.nombre} · ${precio(p.precio)} | El Dolarón`;
  const texto = descripcion(p);
  const meta = (atributo, nombre, contenido) => [`meta[${atributo}="${nombre}"]`, {
    element: (el) => { if (contenido === null) el.remove(); else el.setAttribute('content', contenido); },
  }];
  const reglas = [
    ['title', { element: (el) => el.setInnerContent(titulo) }],
    meta('property', 'og:title', titulo), meta('name', 'twitter:title', titulo),
    meta('property', 'og:description', texto), meta('name', 'twitter:description', texto),
    meta('property', 'og:image', p.imagen), meta('name', 'twitter:image', p.imagen),
    meta('property', 'og:image:alt', p.nombre), meta('name', 'twitter:image:alt', p.nombre),
    meta('property', 'og:image:width', null), meta('property', 'og:image:height', null), // las de la portada no son las de la foto
    meta('property', 'og:url', url),
    meta('name', 'twitter:card', 'summary_large_image'),
  ];
  const rewriter = new HTMLRewriter();
  for (const [selector, manejador] of reglas) rewriter.on(selector, manejador);
  return rewriter.transform(respuesta);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const codigo = (url.searchParams.get('pieza') || '').trim();
    // ponytail: solo GET; los rastreadores de vistas previas piden GET y HEAD pasa sin reescribir.
    if (request.method !== 'GET' || url.pathname !== '/' || !CODIGO.test(codigo)) return env.ASSETS.fetch(request);
    const pieza = await buscar(codigo.toUpperCase());
    const original = await env.ASSETS.fetch(request);
    if (!pieza || !original.ok || !original.headers.get('content-type')?.includes('text/html')) return original;
    try {
      const headers = new Headers(original.headers);
      headers.delete('content-length');
      headers.delete('etag');
      headers.set('cache-control', 'public, max-age=300');
      const nueva = reescribir(original, pieza, `https://eldolaron.com/?pieza=${codigo.toUpperCase()}`);
      return new Response(nueva.body, { status: original.status, headers });
    } catch { return original; }
  },
};
