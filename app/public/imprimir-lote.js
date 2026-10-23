import {
  conectarEtiquetera, etiqueteraLista, imprimirEtiquetas, historialTexto, detenerEnvio, envioDetenido,
  errorEnvio, desmarcarDesde, etiquetaVigente, precioImpreso, gradoImpreso,
} from '/etiquetera.js';

import { estadoEnvio } from './envio-etiquetas.js';
import { nombreEstado } from '/estados.js';
import { esRopa } from './ropa.js';

export async function iniciarEtiquetas(raiz = globalThis.document, vista = null) {
const document = { getElementById: (id) => raiz.getElementById ? raiz.getElementById(id) : raiz.querySelector('#' + id) };
const lista = document.getElementById('lista');
const resumen = document.getElementById('resumen');
const historial = document.getElementById('historial');
const pintarHistorial = () => { historial.textContent = historialTexto(); };
pintarHistorial();
const pesos = (centavos) => `$${Math.round(centavos / 100)}`;
const escapar = (texto) => texto.replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

let piezas = [];
let verImpresas = false;
// Lo que el usuario quito de la seleccion. Sobrevive a los filtros: una pieza
// oculta por el filtro no se vuelve a marcar al cambiarlo.
const desmarcadas = new Set();
let filtroCodigo = '';
// El lector manda el numero sin "ED-" y sin ceros de relleno ("0006" para
// ED-000006), asi que los digitos se comparan como numero. Tambien acepta
// escribir el codigo completo, o su inicio, como "ED-0000".
function coincideCodigo(codigo, filtro) {
  const texto = filtro.trim().toUpperCase();
  if (!texto) return true;
  if (texto.startsWith('ED')) return codigo.toUpperCase().startsWith(texto);
  return /^\d+$/.test(texto) && codigo.startsWith('ED-') && Number(codigo.slice(3)) === Number(texto);
}
const verBoton = document.getElementById('ver-impresas');
const copiasDe = (p) => Math.min(99, Math.max(1, p.stock ?? 1));
const hora = (iso) => new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

/** Solo lo que lleva etiqueta: los bins se cobran con la tarjeta de la caja. */
async function cargar() {
  const respuesta = await fetch('/api/borradores?estado=listo', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!respuesta.ok) throw new Error(`Error HTTP ${respuesta.status}. Revisa la red y la sesión.`);
  piezas = (await respuesta.json())
    .filter((p) => p.destino === 'etiqueta' && p.precio > 0);
  pintar();
}

function pintar() {
  const hechas = estadoEnvio().marcas;
  const idDudoso = localStorage.getItem(CLAVE_DUDOSA);
  // Las marcas de antes no guardaban el precio, ni el nombre y la talla (#361): se les
  // pone lo de hoy una vez, para que un cambio de aqui en adelante si se note. El
  // precio ya guardado se respeta: un cambio pendiente sigue arriba.
  for (const p of piezas) {
    const marca = hechas[p.id];
    if (marca && (marca.precio === undefined || marca.nombre === undefined)) {
      const lo = marca.precio === undefined ? p : { ...p, precio: marca.precio, precio_lista: marca.precio_lista };
      estadoEnvio(lo, 'marcar', marca.hora);
      hechas[p.id] = { hora: marca.hora, precio: lo.precio, precio_lista: lo.precio_lista, nombre: p.nombre ?? '', talla: p.talla ?? '' };
    }
  }
  const vigente = (p) => estadoEnvio(p).vigente;
  // Precio, nombre o talla cambiados despues de imprimir: la etiqueta pegada miente. Van arriba,
  // fuera de la numeracion, porque esas piezas ya no estan en la fila de captura.
  const cambiadas = piezas.filter((p) => hechas[p.id] && !vigente(p));
  const nuevas = piezas.filter((p) => !hechas[p.id]);
  const pendientes = [...cambiadas, ...nuevas];
  const visibles = verImpresas ? [...cambiadas, ...piezas.filter((p) => !cambiadas.includes(p))] : pendientes;
  if (vista) { vista.pintar({ piezas, hechas, pendientes, visibles, filtroCodigo, desmarcadas, idDudoso, copiasDe }); return; }
  verBoton.textContent = verImpresas ? 'Ocultar impresas' : `Mostrar impresas (${piezas.length - pendientes.length})`;

  resumen.textContent = `${pendientes.length} piezas por etiquetar`
    + (cambiadas.length ? ` · ${cambiadas.length} corregidas para reimprimir (arriba)` : '');
  if (visibles.length === 0) {
    lista.innerHTML = `<div class="vacio">${piezas.length === 0
      ? 'Nada para etiquetar. Las piezas de bin no llevan etiqueta.'
      : 'Todo lo que había ya se imprimió.'}</div>`;
    return;
  }

  // El numero es la posicion en el orden de captura: las piezas se quedan
  // fisicamente donde se tomaron hasta que se les pega la etiqueta, asi que
  // contar "1, 2, 3..." contra la fila de piezas evita tener que adivinar
  // cual etiqueta impresa es de cual pieza. Las impresas no cuentan: ya se
  // etiquetaron y se quitaron de la fila.
  // El numero de cada pieza se fija antes de filtrar: el filtro oculta filas, no renumera.
  const numeros = new Map();
  let posicion = 0;
  for (const p of visibles) if (!hechas[p.id]) numeros.set(p.id, ++posicion);
  const mostradas = visibles.filter((p) => coincideCodigo(p.codigo ?? '', filtroCodigo));
  if (mostradas.length === 0) {
    lista.innerHTML = `<div class="vacio">Ningún código de barras coincide con «${escapar(filtroCodigo.trim())}».</div>`;
    return;
  }
  lista.innerHTML = '<div class="renglon" style="font-size:12px;color:#5b6478"><span></span><span></span><span></span><span>Pieza</span><span>Precio</span><span>Existencia</span><span>Etiquetas</span></div>'
    + mostradas.map((p) => {
      const marca = hechas[p.id];
      const impresa = marca && vigente(p);
      const cambiada = marca && !impresa;
      const dudosa = p.id === idDudoso;
      return `
    <label class="renglon${impresa ? ' impresa' : ''}${cambiada || dudosa ? ' cambiada' : ''}">
      <span class="posicion">${impresa ? '✓' : cambiada ? '↻' : numeros.get(p.id)}</span>
      <input type="checkbox" value="${p.id}" ${impresa || desmarcadas.has(p.id) ? '' : 'checked'}>
      <img src="/api/foto/${p.id}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <span>${escapar(p.nombre || 'Sin nombre')}${p.talla ? ` · ${escapar(p.talla)}` : ''}${dudosa
        ? '<span class="marca aviso">Envío incierto: revisa el papel y recupera esta pieza manualmente.</span>'
        : impresa
        ? `<span class="marca">Impresa ${hora(marca.hora)}<button type="button" class="claro" data-desde="${p.id}">No salió desde aquí</button></span>`
        : cambiada
          ? `<span class="marca aviso">La etiqueta pegada dice ${escapar(precioImpreso(marca) !== precioImpreso(p)
            ? pesos(marca.precio) : !esRopa(p) && gradoImpreso(marca) !== gradoImpreso(p) ? `grado ${nombreEstado(gradoImpreso(marca))}`
            : `«${marca.nombre}${marca.talla ? ` · ${marca.talla}` : ''}»`)}: reimprime y cámbiala.</span>`
          : ''}</span>
      <span class="precio">${pesos(p.precio)}${p.precio_lista > p.precio ? ` <s style="font-weight:400;color:#777">${pesos(p.precio_lista)}</s>` : ''}</span>
      <span>${p.stock} ${p.stock === 1 ? 'pieza' : 'piezas'}</span>
      <input type="number" class="copias" data-id="${p.id}" min="1" max="99" value="${copiasDe(p)}" aria-label="Etiquetas a imprimir">
    </label>`;
    }).join('');
}

// Las casillas de seleccion, no los campos de cuantas etiquetas.
const casillas = () => lista.querySelectorAll('input[type=checkbox]');
// Solo afectan a las filas que se ven: lo que el filtro oculta no se toca.
document.getElementById('todas').addEventListener('click', () => {
  casillas().forEach((c) => {
    if (c.closest('.impresa')) { c.checked = false; return; }
    c.checked = true;
    desmarcadas.delete(c.value);
  });
});
document.getElementById('ninguna').addEventListener('click', () => {
  casillas().forEach((c) => { c.checked = false; desmarcadas.add(c.value); });
});
lista.addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  if (e.target.checked) desmarcadas.delete(e.target.value);
  else desmarcadas.add(e.target.value);
});
document.getElementById('buscar-codigo').addEventListener('input', (e) => {
  filtroCodigo = e.target.value;
  pintar();
});
verBoton.addEventListener('click', () => { verImpresas = !verImpresas; pintar(); });

// Para piezas que ya traen etiqueta (impresa antes de que existiera esta marca,
// o en otra computadora). Cada una se marca un milisegundo despues de la
// anterior, en el orden de la lista: asi «No salió desde aquí» regresa esa y
// las de abajo, no el grupo entero.
document.getElementById('marcar').addEventListener('click', async () => {
  const ids = [...lista.querySelectorAll('.renglon:not(.impresa) input[type=checkbox]:checked')].map((c) => c.value);
  if (ids.length === 0) return;
  // También se pide el código, como al imprimir: marcada sin código salía de esta
  // lista y nunca llegaba a la caja (bug-log #11). A la que ya tiene se le respeta.
  for (let i = 0; i < ids.length; i += 100) {
    const respuesta = await fetch('/api/etiquetas', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ids.slice(i, i + 100) }),
    }).catch(() => null);
    if (!respuesta?.ok) {
      resumen.textContent = (await respuesta?.json().catch(() => ({})))?.error ?? 'No se pudieron marcar: revisa la red e intenta otra vez.';
      return;
    }
  }
  const base = Date.now();
  const porId = new Map(piezas.map((p) => [p.id, p]));
  ids.forEach((id, i) => estadoEnvio(porId.get(id), 'marcar', new Date(base + i).toISOString()));
  const dudosa = localStorage.getItem(CLAVE_DUDOSA);
  if (ids.includes(dudosa) && estadoEnvio().marcas[dudosa]) localStorage.removeItem(CLAVE_DUDOSA);
  pintar();
  resumen.textContent = `${ids.length} ${ids.length === 1 ? 'pieza marcada' : 'piezas marcadas'} como impresas. Se regresan con «Mostrar impresas».`;
});
lista.addEventListener('click', (e) => {
  const boton = e.target.closest('[data-desde]');
  if (!boton) return;
  e.preventDefault();
  desmarcarDesde(boton.dataset.desde);
  pintar();
});

/** Traduce la falla de Bluetooth a algo accionable parado junto a la impresora. */
function avisarFalla(error) {
  resumen.textContent = error.name === 'NotFoundError'
    ? 'No se escogió impresora. Préndela y vuelve a intentar, o usa «¿No aparece la impresora?».'
    : /disconnected/i.test(error.message)
      ? 'La impresora soltó la conexión. Apágala y préndela, cierra cualquier otra pestaña o programa que la use (y desconéctala del Bluetooth de Windows si aparece como conectada) y vuelve a intentar.'
      : `No se pudo conectar la impresora: ${error.message}`;
}

// La lista filtrada por nombre es la de diario. Esta es la salida para cuando
// la impresora no sale ahi: enseña todos los aparatos Bluetooth cercanos, que
// es como la sonda la encontro.
const estado = document.getElementById('impresora-estado');
const botonConectar = document.getElementById('conectar-impresora');
function pintarImpresora() {
  const lista = etiqueteraLista();
  estado.textContent = lista ? 'Impresora conectada' : 'Impresora no conectada';
  estado.style.color = lista ? '#2f7a3a' : '#D72B32';
  botonConectar.hidden = lista;
  vista?.conexion?.(lista);
}
pintarImpresora();
setInterval(pintarImpresora, 2000);   // el enlace se puede caer solo

// Web Bluetooth solo existe en Chrome/Edge y solo pide permiso desde un clic real.
async function conectarDesdeClic(cualquiera) {
  if (!navigator.bluetooth) {
    resumen.textContent = 'Este navegador no tiene Bluetooth web. Abre esta página en Chrome o Edge, en la computadora que tiene Bluetooth prendido.';
    return;
  }
  try {
    await conectarEtiquetera({ cualquiera });
    resumen.textContent = 'Impresora conectada. Ya puedes imprimir.';
  } catch (error) {
    avisarFalla(error);
  }
  pintarImpresora();
}
botonConectar.addEventListener('click', () => conectarDesdeClic(false));
document.getElementById('otra').addEventListener('click', () => conectarDesdeClic(true));

document.getElementById('detener').addEventListener('click', () => {
  pausarAutomatica();
  detenerEnvio();
});

let imprimiendo = false;
document.getElementById('imprimir').addEventListener('click', () => {
  if (automaticaActiva) return;
  const ids = [...lista.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
  // Cuantas etiquetas pidio el usuario por pieza. Solo se imprimen: la existencia
  // no cambia aqui, se corrige en la cola de revision.
  const pedidas = new Map([...lista.querySelectorAll('.copias')]
    .map((c) => [c.dataset.id, Math.min(99, Math.max(1, Math.round(Number(c.value)) || 1))]));
  return imprimir(ids, pedidas);
});

async function imprimir(ids, pedidas = new Map(), automatico = false) {
  if (imprimiendo || ids.length === 0) return false;
  vista?.inicio?.(ids, pedidas);
  imprimiendo = true;
  pintarControles();
  if (!automatico) detenerEnvio(false);
  let terminadas = 0;
  try {
    // Pedir la impresora necesita un clic real, nunca el temporizador automático.
    if (!etiqueteraLista()) {
      if (automatico) {
        resumen.textContent = 'La impresora se desconectó. Conéctala y retoma la impresión automática.';
        return false;
      }
      try {
        await conectarEtiquetera();
      } catch (error) {
        avisarFalla(error);
        return false;
      } finally {
        pintarImpresora();
      }
    }

    // El servidor prepara hasta 100 piezas por llamada, asi que se manda por tramos.
    for (let i = 0; i < ids.length; i += 100) {
      if (envioDetenido()) return false;
      // El codigo se asigna aqui: una pieza sin etiqueta impresa no necesita codigo.
      const respuesta = await fetch('/api/etiquetas', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ids.slice(i, i + 100) }),
        signal: AbortSignal.timeout(15000),
      });
      const preparadas = await respuesta.json();
      if (!respuesta.ok) {
        resumen.textContent = preparadas.error;
        return false;
      }

      for (const p of preparadas) {
        if (envioDetenido()) return false;
        if (automatico && (!p.nombre?.trim() || p.precio <= 0 || p.stock <= 0 || p.destino !== 'etiqueta')) {
          resumen.textContent = 'La pieza cambió antes de imprimir. Revisa la cola y retoma la sesión.';
          return false;
        }
        // Las que se pidieron en la columna Etiquetas; de inicio, una por pieza en existencia.
        const copias = automatico ? p.stock : pedidas.get(p.id) ?? copiasDe(p);
        const detalle = `pieza ${terminadas + 1} de ${ids.length}`;
        resumen.textContent = `Imprimiendo ${detalle}: ${copias} ${copias === 1 ? 'etiqueta' : 'etiquetas'}…`;
        // Si se cierra la página durante BLE, no se reenvía una etiqueta incierta a ciegas.
        if (automatico) localStorage.setItem(CLAVE_DUDOSA, p.id);
        let hechasDePieza = 0;
        const salio = await imprimirEtiquetas(
          p, copias,
          (hechas) => { hechasDePieza = hechas; vista?.progreso?.(p, hechas, copias); resumen.textContent = `Imprimiendo ${detalle}: etiqueta ${hechas} de ${copias}…`; },
          (segundos) => { resumen.textContent = `Pausa de ${segundos} s para que la impresora vacíe lo que tiene (${detalle})…`; },
        );
        vista?.resultado?.(p, hechasDePieza, copias, salio);
        pintarHistorial();
        if (!salio) {
          resumen.textContent = envioDetenido()
            ? `Detenido en la pieza ${terminadas + 1} de ${ids.length}. Las que faltan siguen en la lista.`
            : `Se cortó en la pieza ${terminadas + 1} de ${ids.length} (${p.nombre}): ${errorEnvio()}. Las que faltan siguen en la lista.`;
          return false;
        }
        estadoEnvio(p, 'marcar');
        if ((automatico || localStorage.getItem(CLAVE_DUDOSA) === p.id) && !estadoEnvio().marcas[p.id]) {
          throw new Error('No se pudo recordar el envío. Revisa el almacenamiento del navegador y la etiqueta.');
        }
        if (localStorage.getItem(CLAVE_DUDOSA) === p.id) localStorage.removeItem(CLAVE_DUDOSA);
        terminadas += 1;
      }
    }
    resumen.textContent = `${terminadas} piezas enviadas. Si alguna no salió, usa «Mostrar impresas» y «No salió desde aquí».`;
    return true;
  } catch (error) {
    // Nada de fallar en silencio: si algo revienta a media lista, se dice donde.
    console.error('Etiquetas: fallo el lote', error);
    resumen.textContent = `Se detuvo en la pieza ${terminadas + 1} de ${ids.length}: ${error.message}`;
    return false;
  } finally {
    pintarHistorial();
    const aviso = resumen.textContent;
    try { await cargar(); } catch { /* el aviso del envío conserva prioridad */ }
    resumen.textContent = aviso;   // cargar() pinta el conteo encima; el aviso importa mas
    imprimiendo = false;
    pintarControles();
  }
}

/* ---------- impresión automática en la computadora ---------- */

const CLAVE_SESION = 'etiqueta-automatica-desde';
const CLAVE_DUDOSA = 'etiqueta-automatica-dudosa';
const botonAutomatica = document.getElementById('automatica');
let ambiente = null;
const automaticaDisponible = () => ambiente?.ambiente === 'sandbox' || ambiente?.ambiente === 'produccion';
let automaticaDesde = '';
// La sesión vive aquí: al empezar se lee completa una vez y después solo lo que cambió
// (`cambios`). Releerla entera cada 30 s agotaba la cuota diaria de lecturas de D1 (15/10).
let piezasSesion = new Map();
let cambiosDesde = null;   // hora del SERVIDOR de la última consulta, menos un traslape
const TRASLAPE_MS = 2 * 60_000;
let automaticaActiva = false;
let consultandoAutomatica = false;

function pintarControles() {
  document.getElementById('imprimir').disabled = imprimiendo || automaticaActiva;
  document.getElementById('marcar').disabled = imprimiendo || automaticaActiva;
  botonAutomatica.disabled = !automaticaActiva && (imprimiendo || consultandoAutomatica);
  document.getElementById('nueva-sesion').disabled = automaticaActiva || imprimiendo || consultandoAutomatica;
  botonAutomatica.textContent = automaticaActiva ? 'Pausar impresión automática' : 'Retomar / iniciar impresión automática';
  vista?.controles?.({ imprimiendo, automaticaActiva });
}

function pausarAutomatica() {
  automaticaActiva = false;
  pintarControles();
}

async function iniciarAutomatica() {
  if (!automaticaDisponible()) return;
  if (automaticaActiva) {
    pausarAutomatica();
    detenerEnvio();
    resumen.textContent = 'Impresión automática pausada. Las pendientes siguen en la sesión.';
    return;
  }
  if (imprimiendo || consultandoAutomatica) return;
  if (!navigator.bluetooth || !navigator.locks) {
    resumen.textContent = 'Abre esta página en Chrome o Edge en la computadora con Bluetooth.';
    return;
  }
  consultandoAutomatica = true;
  pintarControles();
  try {
    // El permiso se pide en el clic, antes de consultar el servidor.
    if (!etiqueteraLista()) await conectarEtiquetera();
    const dudosa = localStorage.getItem(CLAVE_DUDOSA);
    if (dudosa) {
      resumen.textContent = `Envío incierto (${dudosa}). Revisa el papel y la foto; imprime esa pieza manualmente o márcala como impresa antes de retomar.`;
      return;
    }
    const respuesta = await fetch('/api/salud', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!respuesta.ok) throw new Error('No se pudo iniciar la sesión.');
    const salud = await respuesta.json();
    if (!automaticaDisponible() || salud.ambiente !== ambiente.ambiente) return;
    automaticaDesde = localStorage.getItem(CLAVE_SESION) || salud.ahora;
    localStorage.setItem(CLAVE_SESION, automaticaDesde);
    cambiosDesde = null;
    automaticaActiva = true;
    detenerEnvio(false);
    resumen.textContent = 'Automática activa. Toma las fotos en la cámara del mismo entorno; esperando nombre y precio.';
  } catch (error) {
    avisarFalla(error);
  } finally {
    consultandoAutomatica = false;
    pintarImpresora();
    pintarControles();
  }
  await imprimirNuevas();
}

async function imprimirNuevas() {
  if (!automaticaActiva || consultandoAutomatica || imprimiendo) return;
  consultandoAutomatica = true;
  pintarControles();
  try {
    // Una sola pestaña de este navegador consume la sesión a la vez.
    await navigator.locks.request('etiqueta-automatica', { ifAvailable: true }, async (lock) => {
      if (!lock) { resumen.textContent = 'Ya imprime otra pantalla'; return; }
      if (localStorage.getItem(CLAVE_DUDOSA)) {
        pausarAutomatica();
        resumen.textContent = 'Hay un envío incierto. Revisa el papel y recupera esa pieza manualmente antes de retomar.';
        return;
      }
      const cambios = cambiosDesde ? `&cambios=${encodeURIComponent(cambiosDesde)}` : '';
      const respuesta = await fetch(`/api/borradores?desde=${encodeURIComponent(automaticaDesde)}${cambios}`, {
        cache: 'no-store', signal: AbortSignal.timeout(15000),
      });
      if (!respuesta.ok) throw new Error(`No se pudo consultar la cola (error HTTP ${respuesta.status}). Revisa la red y la sesión.`);
      const llegadas = await respuesta.json();
      if (!automaticaActiva) return;
      if (!cambios) piezasSesion = new Map();
      for (const p of llegadas) {
        if (p.estado_analisis === 'descartado') piezasSesion.delete(p.id);
        else piezasSesion.set(p.id, p);
      }
      const servidor = Date.parse(respuesta.headers?.get?.('date') ?? '');
      const ahora = Number.isFinite(servidor) ? servidor : Date.now();
      cambiosDesde = new Date(ahora - TRASLAPE_MS).toISOString();
      const nuevas = [...piezasSesion.values()].sort((a, b) => a.creado_en.localeCompare(b.creado_en));
      const hechas = estadoEnvio().marcas;
      const cola = [];
      let esperando = '';
      for (const p of nuevas) {
        // La automática imprime ropa y lo escaneado (#369); el resto de la mercancía general
        // se imprime a mano y nunca detiene la cola (#335).
        // Del escáner: `upc` con código, o vacío si se dio de alta solo con foto (#379). Las fotos de /captura lo traen nulo.
        const delEscaner = p.upc != null;
        if ((p.categoria !== 'ropa' && !delEscaner) || estadoEnvio(p).vigente || p.stock <= 0 || p.destino !== 'etiqueta') continue;
        const quien = `${p.nombre?.trim() || 'pieza sin nombre'} (capturada ${hora(p.creado_en)})`;
        const lista = p.estado_analisis === 'listo' && p.nombre?.trim() && p.precio > 0;
        // Lo escaneado sale en cuanto se guarda: su cantidad se cierra en el escáner (otro código
        // o Guardar, #446). No detiene la cola: su etiqueta trae el nombre exacto del producto, así que
        // no depende del orden de la mesa, y una pieza que espera foto no frena las demás (#375).
        if (delEscaner && !lista) {
          // Sin coincidencia exacta (nombre y precio) va aparte: se revisa en el admin y sale cuando
          // quede lista; nunca detiene la cola (#385).
          esperando ||= p.estado_analisis === 'error'
            ? `Aparte para revisar en el admin: ${quien}. La cola sigue.`
            : `Identificando lo escaneado: ${quien}. La cola sigue.`;
          continue;
        }
        // Conservar el orden de la mesa aunque un análisis posterior termine primero.
        if (!lista) {
          esperando = p.estado_analisis === 'error'
            ? `Una foto necesita revisión: ${quien}. Completa nombre y precio en la cola de revisión.`
            : `Esperando precio de: ${quien}.`;
          break;
        }
        cola.push(p);
      }
      if (cola.length) {
        if (!await imprimir(cola.map((p) => p.id), new Map(), true)) pausarAutomatica();
      } else {
        resumen.textContent = esperando || 'Automática activa. Esperando la siguiente foto.';
      }
      // shortcut: el endpoint limita a 2000 capturas por sesión; empezar otra al alcanzar el tope.
      if (!cambios && llegadas.length === 2000) {
        pausarAutomatica();
        resumen.textContent = 'La sesión llegó a 2000 fotos. Termina las pendientes manualmente y empieza otra sesión.';
      }
    });
  } catch (error) {
    pausarAutomatica();
    resumen.textContent = `${error.message} La impresión automática está pausada; retoma cuando se resuelva.`;
  } finally {
    consultandoAutomatica = false;
    pintarControles();
  }
}

botonAutomatica.addEventListener('click', iniciarAutomatica);
document.getElementById('nueva-sesion').addEventListener('click', () => {
  if (!automaticaDisponible() || automaticaActiva || imprimiendo || consultandoAutomatica) return;
  localStorage.removeItem(CLAVE_SESION);
  resumen.textContent = 'Nueva sesión preparada. Inicia la impresión automática antes de tomar las próximas fotos; las pendientes anteriores quedan para impresión manual.';
});
// Con `cambios` cada consulta lee solo lo modificado (índice de la migración 038), y la tienda está en
// Workers Paid: 3 s deja salir la etiqueta casi al guardar (#383). Releer la sesión entera a 2 s agotó
// la cuota gratuita de D1 (#313); no quitar `cambios`.
const CONSULTA_AUTOMATICA_MS = 3000;
setInterval(imprimirNuevas, CONSULTA_AUTOMATICA_MS);
try {
  const respuesta = await fetch('/api/salud', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (respuesta.ok) ambiente = await respuesta.json();
  botonAutomatica.hidden = !automaticaDisponible();
  document.getElementById('nueva-sesion').hidden = botonAutomatica.hidden;
  document.getElementById('ayuda-automatica').hidden = botonAutomatica.hidden;
} catch { /* sin confirmar el entorno, solo queda la impresión manual */ }

try {
  await cargar();
} catch (error) {
  console.error('Etiquetas: falló la carga inicial', error);
  lista.innerHTML = '<div class="vacio">No se pudo cargar la lista.</div>';
  resumen.textContent = `No se pudo cargar la lista de etiquetas: ${error.message} Recarga la página para intentar de nuevo.`;
}
return { imprimir, pintar, cargar, iniciarAutomatica, pausarAutomatica,
  conexion: conectarDesdeClic, activa: () => automaticaActiva,
  filtrar(codigo) { filtroCodigo = codigo; pintar(); },
  seleccionar(ids) { for (const p of piezas) { if (ids.includes(p.id)) desmarcadas.delete(p.id); else desmarcadas.add(p.id); } pintar(); },
};
}
