// Solicitud de cambio de precio (#451). El capturista señala una pieza muy barata o muy cara; el dueño
// la ve en Revisar y en la ficha, cambia el precio o la deja igual. El servidor autoriza cada paso:
// aquí solo se oculta lo que la cuenta no puede hacer. Dinero siempre en centavos MXN enteros.
// Todo dato de la pieza entra con textContent, nunca como HTML.
import { api, aCentavos, pesos } from './ficha.js';
import { $, nodo, boton, mensaje, hoja, confirmar, cerrarHoja, bloquear, restaurarNeutro } from './inventario-ui.js';

export const MAXIMO = 10_000_000;   // $100,000: el mismo tope que el servidor
const TIENDA = 'America/Mexico_City';
const FALTA_SENTIDO = 'Elige si está barato o caro';

/* ---------- reglas sin DOM (probadas en inventario-precio.test.ts) ---------- */

/** Lo que el capturista manda. El servidor repite estas reglas; aquí se dicen antes de gastar red. */
export function validarPedido(sentido, texto, pieza) {
  if (sentido !== 'subir' && sentido !== 'bajar') return { error: 'Elige si está barato o caro.' };
  const cuerpo = { sentido };
  if (String(texto ?? '').trim() !== '') {
    const c = aCentavos(texto);
    if (c === null || c <= 0) return { error: 'Escribe el precio sugerido en pesos, por ejemplo 450 o 450.50.' };
    if (c > MAXIMO) return { error: `Escribe un precio menor a ${pesos(MAXIMO)}.` };
    if (sentido === 'subir' && c <= pieza.precio) return { error: `Para subirlo, escribe más de ${pesos(pieza.precio)}.` };
    if (sentido === 'bajar' && c >= pieza.precio) return { error: `Para bajarlo, escribe menos de ${pesos(pieza.precio)}.` };
    if (pieza.precio_lista > 0 && c > pieza.precio_lista) return { error: `No puede pasar del precio de lista (${pesos(pieza.precio_lista)}).` };
    cuerpo.precio_sugerido = c;
  }
  return { cuerpo };
}

/** Por qué el dueño todavía no puede cambiar el precio, o '' si puede. `s.precio` es el precio de hoy. */
export function motivoCambio(texto, s) {
  const c = aCentavos(texto);
  if (c === null || c <= 0) return 'Escribe un precio válido';
  if (c > MAXIMO) return `Escribe un precio menor a ${pesos(MAXIMO)}`;
  if (c === s.precio) return 'Es el mismo precio';
  if (s.precio_lista > 0 && c > s.precio_lista) return `No puede pasar del precio de lista (${pesos(s.precio_lista)})`;
  return '';
}

/** Un cambio de más de la mitad del precio pide confirmar. */
export const cambioGrande = (actual, nuevo) => actual > 0 && Math.abs(nuevo - actual) * 2 > actual;
export const porcentaje = (actual, nuevo) => Math.round((nuevo - actual) / actual * 100);

const dia = (fecha) => fecha.toLocaleDateString('en-CA', { timeZone:TIENDA });
/** «hoy 11:02», «ayer 18:30» o «21 oct 09:15», en la hora de la tienda. */
export function cuando(iso, ahora = new Date()) {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '';
  const hora = fecha.toLocaleTimeString('es-MX', { timeZone:TIENDA, hour:'2-digit', minute:'2-digit', hour12:false });
  if (dia(fecha) === dia(ahora)) return `hoy ${hora}`;
  if (dia(fecha) === dia(new Date(ahora.getTime() - 86_400_000))) return `ayer ${hora}`;
  return `${fecha.toLocaleDateString('es-MX', { timeZone:TIENDA, day:'numeric', month:'short' }).replace('.', '')} ${hora}`;
}

export const quien = (correo) => String(correo ?? '').split('@')[0];

/** Capturista (no dueño: él cambia el precio desde «Editar») y una pieza de etiqueta ya lista. */
export function puedePedirPrecio(identidad, pieza) {
  const roles = identidad.usuario?.roles || [];
  return roles.includes('capturista') && !roles.includes('dueno')
    && pieza.destino === 'etiqueta' && pieza.estado_analisis === 'listo' && pieza.precio > 0;
}

/* ---------- lo que se sabe de las solicitudes ---------- */

const conocidas = new Map();   // producto_id -> solicitud pendiente que este navegador ya vio
/** El dueño: cuántas esperan y cuáles. Cada cambio se anuncia con el evento «precios». */
export const precios = { n: 0, lista: [] };
const avisar = () => document.dispatchEvent(new CustomEvent('precios', { detail:precios.n }));

export async function refrescarPrecios() {
  const datos = await api('/api/solicitudes-precio?estado=pendiente');
  precios.lista = datos.solicitudes; precios.n = datos.conteo;
  for (const s of datos.solicitudes) conocidas.set(s.producto_id, s);
  avisar(); return datos;
}
function resuelta(productoId) {
  conocidas.delete(productoId);
  precios.n = Math.max(0, precios.n - 1); avisar();
}

/* ---------- capturista: pedir el cambio ---------- */

/** La hoja «¿El precio está bien?». Resuelve con la solicitud (nueva o ya existente), o null si se cerró. */
export function pedirCambio(ctx, pieza) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();   // el mismo folio en cada reintento: el servidor no duplica
    let sentido = '', enviando = false, resultado = null;
    const form = nodo('form', undefined, 'formulario hoja-precio');
    form.noValidate = true;

    const cabeza = nodo('div', undefined, 'sp-pieza');
    cabeza.append(nodo('b', pieza.nombre || 'Sin nombre'), nodo('code', pieza.codigo || ''),
      nodo('small', 'Precio actual'), nodo('strong', pesos(pieza.precio), 'precio'));

    const opciones = nodo('fieldset', undefined, 'sp-opciones');
    opciones.append(nodo('legend', 'Elige una opción'));
    let primera;
    for (const [valor, titulo, ayuda] of [['subir', '▲ Está barato', 'Hay que subirlo'], ['bajar', '▼ Está caro', 'Hay que bajarlo']]) {
      const l = nodo('label', undefined, 'sp-opcion'), radio = nodo('input'), cara = nodo('span');
      radio.type = 'radio'; radio.name = 'sentido'; radio.value = valor;
      radio.onchange = () => { sentido = valor; error.hidden = true; actualizar(); avisoViejo(); };
      cara.append(nodo('b', titulo), nodo('small', ayuda)); l.append(radio, cara); opciones.append(l);
      primera ??= radio;
    }

    const lSugerido = nodo('label', 'Precio sugerido (opcional)'), campo = nodo('div', undefined, 'campo-precio'), sugerido = nodo('input');
    sugerido.inputMode = 'decimal'; sugerido.autocomplete = 'off'; sugerido.maxLength = 10; sugerido.setAttribute('aria-describedby', 'sp-pista');
    campo.append(nodo('span', '$'), sugerido); lSugerido.append(campo);
    const pista = nodo('p', undefined, 'ayuda'); pista.id = 'sp-pista';
    const lNota = nodo('label', 'Nota (opcional)'), nota = nodo('textarea');
    nota.maxLength = 140; nota.rows = 2; nota.placeholder = 'Por qué lo crees'; lNota.append(nota);

    const error = nodo('p', undefined, 'error-hoja'); error.setAttribute('role', 'alert'); error.hidden = true;
    const motivo = nodo('p', undefined, 'ayuda');
    const enviar = boton('Enviar al dueño', () => enviarPedido(), 'primario');

    // Tocar «Enviar» sin elegir deja un aviso en la línea de estado: cuando ya no aplica (se eligió o se cerró) se quita.
    const avisoViejo = () => { if ($('estado').dataset.tipo === 'aviso' && $('estado').textContent.includes(FALTA_SENTIDO)) restaurarNeutro(); };
    function mostrarError(texto, campoError) {
      error.textContent = `■ ${texto}`; error.hidden = false; campoError?.focus();
    }
    function actualizar() {
      pista.textContent = sentido === 'subir' ? `Más de ${pesos(pieza.precio)}` : sentido === 'bajar' ? `Menos de ${pesos(pieza.precio)}` : 'Elige primero si está barato o caro.';
      const falta = sentido ? '' : FALTA_SENTIDO;
      bloquear(enviar, falta); motivo.textContent = falta;
    }
    function cargando(si) {
      enviar.textContent = si ? 'Enviando…' : 'Enviar al dueño';
      enviar.toggleAttribute('aria-busy', si);
      if (si) bloquear(enviar, 'Enviando…'); else actualizar();
    }
    async function enviarPedido() {
      if (enviando) return;
      error.hidden = true;
      const r = validarPedido(sentido, sugerido.value, pieza);
      if (r.error) return mostrarError(r.error, sentido ? sugerido : primera);
      if (navigator.onLine === false) return mostrarError('Sin red: no se envió. Inténtalo cuando vuelva la señal.');
      enviando = true; cargando(true);
      try {
        const texto = nota.value.replace(/\s+/g, ' ').trim();
        const d = await api(`/api/piezas/${pieza.id}/solicitud-precio`, { id, ...r.cuerpo, ...(texto ? { nota:texto } : {}) });
        resultado = d.solicitud; cerrarHoja(); mensaje('Solicitud enviada al dueño', 'ok');
      } catch (e) {
        if (e.status === 409 && e.datos?.solicitud) {
          resultado = e.datos.solicitud; cerrarHoja(); mensaje('Esta pieza ya tiene una solicitud de precio pendiente', 'aviso');
        } else mostrarError(e.status ? e.message : 'Sin conexión: no se envió. Inténtalo otra vez.');
      } finally { enviando = false; cargando(false); }
    }
    sugerido.addEventListener('input', () => { error.hidden = true; });
    form.onsubmit = (e) => { e.preventDefault(); void enviar.click(); };

    form.append(cabeza, opciones, lSugerido, pista, lNota, error, enviar, motivo);
    actualizar();
    hoja('¿El precio está bien?', form);
    $('hoja').addEventListener('close', () => { avisoViejo(); resolve(resultado); }, { once:true });
    primera.focus();
  });
}

/* ---------- ficha y tarjeta: botón o estado ---------- */

const textoPendiente = (s) => `${s.sentido === 'subir' ? '▲ Pediste subir' : '▼ Pediste bajar'} el precio · pendiente`;

/**
 * Pinta en `contenedor` lo que toca a esta cuenta: el botón «Pedir cambio de precio», el estado de lo ya
 * pedido o, para el dueño, la solicitud con sus controles. `solicitud`: null = sin pendiente; undefined =
 * no se sabe (la tarjeta de Capturar), se usa lo que este navegador ya vio.
 */
export function montarPrecio(ctx, contenedor, pieza, solicitud) {
  if (solicitud === null) conocidas.delete(pieza.id); else if (solicitud) conocidas.set(pieza.id, solicitud);
  const pintar = () => {
    contenedor.replaceChildren();
    const s = conocidas.get(pieza.id);
    if (s && ctx.dueno) {
      contenedor.append(filaSolicitud(ctx, { ...datosDe(pieza), ...s }, { compacta:true }));
    } else if (s) {
      const estado = nodo('div', undefined, 'sp-estado'), propia = s.pedido_por === ctx.identidad.usuario?.correo;
      const linea = nodo('p', propia ? textoPendiente(s) : `${s.sentido === 'subir' ? '▲ Piden subir' : '▼ Piden bajar'} este precio · pendiente`, 'sp-linea');
      linea.tabIndex = -1;
      estado.append(linea);
      if (propia && s.precio_sugerido) estado.append(nodo('small', `Sugeriste ${pesos(s.precio_sugerido)}`));
      contenedor.append(estado);
    } else if (puedePedirPrecio(ctx.identidad, pieza)) {
      contenedor.append(boton('Pedir cambio de precio', async () => {
        const nueva = await pedirCambio(ctx, pieza);
        if (!nueva) return;
        conocidas.set(pieza.id, nueva); pintar();
        contenedor.querySelector('.sp-linea')?.focus({ preventScroll:true });
      }));
    }
  };
  pintar();
}

const datosDe = (p) => ({ producto_id:p.id, codigo:p.codigo, nombre:p.nombre, marca:p.marca, talla:p.talla, precio:p.precio,
  precio_lista:p.precio_lista, tiene_foto:p.tiene_foto, destino:p.destino });

/* ---------- dueño: una solicitud con sus controles ---------- */

/**
 * `s`: la solicitud con los datos de hoy de la pieza (lo que devuelve GET /api/solicitudes-precio).
 * `alResolver({ estado, precio })` avisa a quien la contiene; el contador del dueño ya se actualizó.
 */
export function filaSolicitud(ctx, s, { compacta = false, alResolver = () => {}, alAbrir = null } = {}) {
  const fila = nodo('article', undefined, 'solicitud-precio'), caro = s.sentido === 'bajar';
  let ocupada = false;

  const encabezado = nodo('div', undefined, 'sp-encabezado');
  if (compacta) encabezado.append(nodo('h3', 'Precio por revisar'));
  else {
    if (s.tiene_foto) {
      const foto = nodo('img', undefined, 'sp-foto'); foto.src = `/api/foto/${s.producto_id}`; foto.alt = ''; foto.loading = 'lazy';
      foto.onerror = () => foto.remove(); encabezado.append(foto);
    }
    const titulo = nodo('span', undefined, 'sp-titulo');
    titulo.append(nodo('code', s.codigo || 'Sin código'), nodo('b', s.nombre || 'Sin nombre'),
      nodo('small', [s.marca, s.talla].filter(Boolean).join(' · ')));
    // Foto y nombre son un botón: abre la ficha de la pieza.
    if (alAbrir) {
      const abrir = boton('', alAbrir, 'sp-abrir');
      abrir.setAttribute('aria-label', `Ver pieza: ${s.nombre || s.codigo || 'sin nombre'}`);
      titulo.append(nodo('small', 'Ver pieza ›', 'sp-ver'));
      abrir.append(...encabezado.childNodes, titulo);
      encabezado.append(abrir);
    } else encabezado.append(titulo);
  }
  encabezado.append(nodo('span', caro ? '▼ Caro' : '▲ Barato', `chip-sentido ${caro ? 'bajar' : 'subir'}`));

  const cifras = nodo('div', undefined, 'sp-cifras'), rotuloActual = nodo('small', 'Precio actual'), actual = nodo('strong', pesos(s.precio), 'precio');
  const bloqueActual = nodo('div'); bloqueActual.append(rotuloActual, actual); cifras.append(bloqueActual);
  if (s.precio_sugerido) { const b = nodo('div'); b.append(nodo('small', 'Sugerido'), nodo('strong', pesos(s.precio_sugerido), 'precio')); cifras.append(b); }

  const cambio = nodo('p', undefined, 'sp-cambio');
  const marcarCambio = () => {
    cambio.hidden = s.precio === s.precio_actual;
    cambio.textContent = `▲ El precio cambió desde la solicitud (antes ${pesos(s.precio_actual)}).`;
  };
  marcarCambio();
  const partes = [encabezado, cifras, cambio];
  if (s.nota) partes.push(nodo('blockquote', `«${s.nota}»`, 'sp-nota'));
  partes.push(nodo('small', `Pidió ${quien(s.pedido_por)} · ${cuando(s.pedido_en)}`));

  const form = nodo('form', undefined, 'sp-formulario'), l = nodo('label', 'Precio nuevo'), campo = nodo('div', undefined, 'campo-precio'), entrada = nodo('input');
  entrada.inputMode = 'decimal'; entrada.autocomplete = 'off'; entrada.maxLength = 10; entrada.enterKeyHint = 'done';
  const prefill = () => { entrada.value = ((s.precio_sugerido || s.precio) / 100).toFixed(2); };
  prefill();
  campo.append(nodo('span', '$'), entrada); l.append(campo);
  const motivo = nodo('p', undefined, 'ayuda'), acciones = nodo('div', undefined, 'acciones');
  const aplicar = boton('Cambiar precio', () => resolver('aplicar'), 'primario'), dejar = boton('Dejar igual', () => resolver('rechazar'));
  acciones.append(aplicar, dejar);
  function actualizar() {
    const m = motivoCambio(entrada.value, s), c = aCentavos(entrada.value);
    aplicar.textContent = c !== null && c > 0 && c <= MAXIMO ? `Cambiar a ${pesos(c)}` : 'Cambiar precio';
    bloquear(aplicar, ocupada ? 'Un momento…' : m); motivo.textContent = ocupada ? '' : m;
    dejar.toggleAttribute('aria-busy', ocupada); bloquear(dejar, ocupada ? 'Un momento…' : '');
  }
  entrada.addEventListener('input', actualizar);
  form.onsubmit = (e) => { e.preventDefault(); void aplicar.click(); };
  form.append(l, motivo, acciones); actualizar();

  /** Cierra la fila con una línea de resultado (y, si cambió el precio, la reimpresión). */
  function terminar(linea, { antes, reimprimir = false } = {}) {
    const hecho = nodo('div', undefined, 'sp-hecho'), texto = nodo('p', linea, 'sp-linea');
    texto.tabIndex = -1; hecho.append(texto);
    if (reimprimir) {
      if (s.codigo) hecho.append(nodo('small', `La etiqueta pegada dice ${pesos(antes)}: ya no es el precio.`));
      if (ctx.identidad.vendedor) hecho.append(nodo('small', 'Reimprime la etiqueta desde la computadora.'));
      else hecho.append(boton('Reimprimir etiqueta', async () => {
        const salio = await ctx.imprimir([s.producto_id], new Map([[s.producto_id, 1]]));
        if (salio) mensaje('Etiqueta enviada', 'etiqueta');
      }, 'primario'));
    }
    form.replaceWith(hecho); texto.focus({ preventScroll:true });
  }

  async function resolver(accion) {
    if (ocupada) return;
    const nuevo = aCentavos(entrada.value);
    if (accion === 'aplicar' && cambioGrande(s.precio, nuevo)
        && !await confirmar(`El precio cambia de ${pesos(s.precio)} a ${pesos(nuevo)} (${porcentaje(s.precio, nuevo)} %). ¿Seguro?`)) return;
    ocupada = true; actualizar();
    try {
      const cuerpo = accion === 'aplicar' ? { accion, precio:nuevo, precio_esperado:s.precio } : { accion };
      const r = await api(`/api/solicitudes-precio/${s.id}`, cuerpo);
      resuelta(s.producto_id);
      if (accion === 'rechazar') {
        mensaje('Dejaste el precio igual', 'ok'); alResolver({ estado:'rechazada' }); return terminar(`✓ Sigue en ${pesos(s.precio)}`);
      }
      const antes = s.precio; s.precio = r.precio;
      rotuloActual.textContent = 'Precio ahora'; actual.textContent = pesos(r.precio); cambio.hidden = true;
      // La ficha abierta y la lista conservan el precio viejo hasta recargar: se corrigen aquí.
      if ($('precio') && ctx.pieza?.()?.id === s.producto_id) { ctx.pieza().precio = r.precio; $('precio').textContent = pesos(r.precio); }
      mensaje(`Precio cambiado a ${pesos(r.precio)}`, 'ok'); alResolver({ estado:'aplicada', precio:r.precio });
      terminar(`✓ Ahora ${pesos(r.precio)}`, { antes, reimprimir:true });
    } catch (e) {
      ocupada = false;
      if (e.status === 409 && e.datos?.precio !== undefined) {
        // Alguien cambió el precio mientras mirabas: se muestra el de hoy y se avisa, sin aplicar nada.
        s.precio = e.datos.precio; actual.textContent = pesos(s.precio); marcarCambio(); prefill(); actualizar();
        mensaje(`El precio cambió a ${pesos(s.precio)}. Revísalo y vuelve a intentar.`, 'aviso'); return;
      }
      if (e.status === 409) { resuelta(s.producto_id); alResolver({ estado:e.datos?.solicitud?.estado }); mensaje(e.message, 'aviso'); return terminar('Esta solicitud ya estaba resuelta'); }
      actualizar(); throw e;
    }
  }

  fila.append(...partes, form);
  return fila;
}
