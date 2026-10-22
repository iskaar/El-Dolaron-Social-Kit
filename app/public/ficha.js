// Ficha de una pieza (#441): datos, existencia ± con rastro y corrección de nombre, marca,
// talla y precios. Es un módulo para que /pieza y la pantalla única de #446 usen lo mismo.
// Todo dato de la pieza entra con textContent/value, nunca como HTML.
import { CATEGORIAS } from './categorias.js';
import { nombreEstado } from './estados.js';
import { TALLAS } from './tallas.js';
import { impresas, etiquetaVigente, precioImpreso } from './etiquetera.js';

const $ = (id) => document.getElementById(id);
export const pesos = (centavos) => new Intl.NumberFormat('es-MX', { style:'currency', currency:'MXN', maximumFractionDigits:2 }).format(centavos / 100);

export async function api(ruta, cuerpo, metodo = 'POST') {
  const r = await fetch(ruta, { cache:'no-store', signal:AbortSignal.timeout(15000),
    ...(cuerpo ? { method:metodo, headers:{ 'content-type':'application/json' }, body:JSON.stringify(cuerpo) } : {}) });
  const datos = await r.json();
  if (!r.ok) throw Object.assign(new Error(datos.error || 'No se pudo completar la acción.'), { status:r.status, datos });
  return datos;
}

/** Pesos escritos a mano → centavos enteros, o null si no es un monto válido. */
export const aCentavos = (texto) => {
  const t = String(texto ?? '').trim().replace(',', '.');
  return /^\d{1,7}(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null;
};

/**
 * Cuerpo del PATCH /api/borradores/:id. Sin `precio` el servidor recalcula precio y destino desde la
 * configuración (pisaría un precio puesto a mano) y con `stock` pisaría una venta intercalada: por eso
 * el cuerpo SIEMPRE lleva precio y destino y NUNCA stock. Quien no ve el campo de precio manda el actual.
 */
export function cuerpoCorreccion(pieza, campos, puedePrecio) {
  const nombre = String(campos.nombre ?? '').trim();
  if (!nombre) return { error:'El nombre no puede quedar vacío.' };
  let precio = pieza.precio, lista = pieza.precio_lista;
  if (puedePrecio && pieza.destino === 'etiqueta') {
    precio = aCentavos(campos.precio); lista = String(campos.precio_lista ?? '').trim() === '' ? 0 : aCentavos(campos.precio_lista);
    if (precio === null || lista === null) return { error:'Escribe los precios en pesos, por ejemplo 450 o 450.50.' };
    if (precio <= 0) return { error:'El precio de venta debe ser mayor a cero.' };
    if (lista > 0 && precio > lista) return { error:'El precio de venta no puede ser mayor al precio de lista.' };
  }
  return { cuerpo:{ nombre, marca:String(campos.marca ?? '').trim(), talla:String(campos.talla ?? '').trim(),
    precio_lista:lista, precio, destino:pieza.destino } };
}

/** Qué cambia, en líneas para confirmar. `marca` es lo que este navegador imprimió (etiquetera.impresas). */
export function resumenCorreccion(pieza, cuerpo, marca) {
  const lineas = [];
  if (cuerpo.precio !== pieza.precio) {
    const pegado = marca?.precio ?? pieza.precio;
    lineas.push(`Precio ${pesos(pieza.precio)} → ${pesos(cuerpo.precio)}.`
      + (pieza.codigo ? ` La etiqueta pegada dice ${pesos(pegado)}: la caja cobrará ${pesos(cuerpo.precio)} desde ahora.`
        : ` La caja cobrará ${pesos(cuerpo.precio)} desde ahora.`));
  }
  if (cuerpo.precio_lista !== pieza.precio_lista) lineas.push(`Precio de lista ${pesos(pieza.precio_lista)} → ${pesos(cuerpo.precio_lista)}.`);
  for (const [campo, rotulo] of [['nombre', 'Nombre'], ['marca', 'Marca'], ['talla', 'Talla']])
    if (cuerpo[campo] !== (pieza[campo] ?? '')) lineas.push(`${rotulo} «${pieza[campo] ?? ''}» → «${cuerpo[campo]}».`);
  return lineas;
}

/**
 * Misma regla que /etiquetas (etiquetaVigente): si la etiqueta pegada ya no dice el precio, el nombre o la
 * talla de hoy, hay que reimprimirla. Sin marca en este navegador se toma como pegada la pieza antes de guardar.
 */
export function avisoReimpresion(marca, antes, ahora) {
  if (!antes.codigo || ahora.destino !== 'etiqueta') return null;
  const pegada = marca ?? antes;
  if (etiquetaVigente(pegada, ahora)) return null;
  return precioImpreso(pegada) !== precioImpreso(ahora)
    ? `La etiqueta pegada dice ${pesos(pegada.precio)} y ahora cuesta ${pesos(ahora.precio)}.`
    : `La etiqueta pegada dice «${pegada.nombre ?? ''}${pegada.talla ? ` · ${pegada.talla}` : ''}».`;
}

export function crearFicha({ mensaje, alAbrir = () => {} }) {
  let pieza = null, apertura = 0, puedeEditar = false, puedePrecio = false;
  let pendiente = null, enviando = false, guardando = false, deshacer = null, temporizador;
  for (const t of TALLAS) { const o = document.createElement('option'); o.value = t; $('tallas').append(o); }

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
    $('existencia').hidden = !puedeEditar;
    $('menos').hidden = $('sumar').hidden = !puedeEditar;
    $('menos').disabled = enviando || !!pendiente || pieza.stock <= 0 || $('motivo').value === 'entrada';
    $('sumar').disabled = enviando || !!pendiente || pieza.stock >= 999 || ['robo', 'merma', 'error de captura'].includes($('motivo').value);
    $('ajustar').disabled = $('deshacer').disabled = enviando || !!pendiente;
    // PATCH deja la pieza `listo`: una que aún se analiza se revisa en /admin.
    const corregible = puedeEditar && pieza.estado_analisis === 'listo';
    $('edicion').hidden = !puedeEditar;
    $('editar').hidden = !corregible || !$('corregir').hidden;
    $('nota-edicion').textContent = puedeEditar && !corregible ? 'Esta pieza aún no está lista: se corrige en /admin.' : '';
    $('guardar-correccion').disabled = $('cancelar-correccion').disabled = guardando;
    $('foto').hidden = !pieza.tiene_foto;
    $('sin-foto').hidden = !!pieza.tiene_foto;
    if (pieza.tiene_foto) { $('foto').src = `/api/foto/${pieza.id}?v=${encodeURIComponent(pieza.actualizado_en)}`; $('foto').alt = pieza.nombre; }
  }

  function pintarHistorial(historial) {
    $('historial').replaceChildren();
    for (const a of historial) {
      const li = document.createElement('li');
      const delta = a.despues - a.antes;
      li.textContent = `${new Date(a.ajustado_en).toLocaleString('es-MX', { timeZone:'America/Mexico_City' })} · ${delta > 0 ? '+' : ''}${delta} · ${a.antes} → ${a.despues} · ${a.motivo} · ${a.ajustado_por}`;
      $('historial').append(li);
    }
    if (!historial.length) { const li = document.createElement('li'); li.textContent = 'Sin ajustes registrados.'; $('historial').append(li); }
  }

  function cerrarFormulario() { $('corregir').hidden = true; $('reimprimir').hidden = true; }

  function quitarDeshacer() {
    clearTimeout(temporizador); deshacer = null; $('deshacer').hidden = true;
  }

  async function abrir(id) {
    const turno = ++apertura;
    quitarDeshacer(); cerrarFormulario();
    $('motivo').value = 'correccion'; $('fijar-a').value = '';
    pieza = null; pintar();
    try {
      const datos = await api(`/api/piezas/${id}`);
      if (turno !== apertura) return;
      pieza = datos.pieza;
      puedeEditar = datos.puede_editar === true;
      puedePrecio = datos.puede_precio === true;
      pintarHistorial(datos.historial);
      pintar();
      alAbrir(pieza);
      mensaje(`Pieza abierta: ${pieza.nombre}. Existencia ${pieza.stock}.`);
    } catch (error) { if (turno === apertura) mensaje(error.message); }
  }

  async function ajustar(cuerpo, inverso = false) {
    if (!pieza || !puedeEditar || pendiente || enviando) return;
    pendiente = { piezaId:pieza.id, nombre:pieza.nombre, cuerpo:{ id:crypto.randomUUID(), ...cuerpo }, inverso };
    quitarDeshacer();
    await enviarAjuste();
  }

  async function enviarAjuste() {
    if (!pendiente || enviando) return;
    enviando = true; pintar(); $('reintentar').hidden = true;
    const operacion = pendiente, turno = apertura;
    let texto;
    try {
      const a = await api(`/api/piezas/${operacion.piezaId}/existencia`, operacion.cuerpo);
      pendiente = null;
      texto = `${operacion.nombre}: existencia de ${a.antes} a ${a.despues}.`;
      if (pieza?.id === operacion.piezaId && turno === apertura) {
        pieza.stock = a.despues;
        if (!operacion.inverso) {
          deshacer = { delta:a.antes - a.despues, hasta:Date.now() + 5000 };
          $('deshacer').hidden = false;
          temporizador = setTimeout(quitarDeshacer, 5000);
        }
      }
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        pendiente = null;
        if (error.status === 403 && pieza?.id === operacion.piezaId) puedeEditar = false;
        texto = error.message;
      } else texto = `No se confirmó el ajuste de ${operacion.nombre}. Reintenta para consultar el mismo folio.`;
    }
    // Refrescar también después de un conflicto: una venta pudo cambiar existencia e historial.
    if (!pendiente && pieza?.id === operacion.piezaId && turno === apertura) {
      try {
        const datos = await api(`/api/piezas/${operacion.piezaId}`);
        if (turno === apertura) { pieza = datos.pieza; puedeEditar = datos.puede_editar === true; puedePrecio = datos.puede_precio === true; pintarHistorial(datos.historial); }
      } catch { texto += ' No se pudo actualizar la ficha; vuelve a abrirla.'; }
    }
    enviando = false; pintar(); $('reintentar').hidden = !pendiente;
    mensaje(texto);
  }

  function abrirFormulario() {
    if (!pieza || !puedeEditar || guardando) return;
    $('e-nombre').value = pieza.nombre ?? ''; $('e-marca').value = pieza.marca ?? ''; $('e-talla').value = pieza.talla ?? '';
    const precios = puedePrecio && pieza.destino === 'etiqueta';
    $('campos-precio').hidden = !precios;
    $('e-precio').value = (pieza.precio / 100).toFixed(2); $('e-lista').value = pieza.precio_lista > 0 ? (pieza.precio_lista / 100).toFixed(2) : '';
    $('nota-precio').textContent = pieza.destino !== 'etiqueta' ? 'Pieza de banda: el precio se cambia en /admin.'
      : puedePrecio ? '' : 'El precio lo cambia solo el dueño.';
    $('reimprimir').hidden = true;
    $('corregir').hidden = false; pintar();
    $('e-nombre').focus();
  }

  async function guardarCorreccion() {
    if (!pieza || !puedeEditar || guardando) return;
    const r = cuerpoCorreccion(pieza, { nombre:$('e-nombre').value, marca:$('e-marca').value, talla:$('e-talla').value,
      precio:$('e-precio').value, precio_lista:$('e-lista').value }, puedePrecio);
    if (r.error) return mensaje(r.error);
    const lineas = resumenCorreccion(pieza, r.cuerpo, impresas()[pieza.id]);
    if (!lineas.length) return mensaje('No hay cambios que guardar.');
    if (!confirm(`${lineas.join('\n')}\n\n¿Guardar?`)) return;
    const antes = { ...pieza }, turno = apertura;
    guardando = true; pintar();
    let texto;
    try {
      const g = await api(`/api/borradores/${antes.id}`, r.cuerpo, 'PATCH');
      texto = `${g.nombre}: cambios guardados.`;
      if (pieza?.id === antes.id && turno === apertura) {
        Object.assign(pieza, { nombre:g.nombre, marca:g.marca, talla:g.talla, precio:g.precio, precio_lista:g.precio_lista,
          destino:g.destino, stock:g.stock, estado_analisis:'listo' });
        $('corregir').hidden = true;
        const aviso = avisoReimpresion(impresas()[antes.id], antes, pieza);
        $('reimprimir').hidden = !aviso;
        if (aviso) $('reimprimir-texto').textContent = aviso;
      }
    } catch (error) {
      if (error.status === 403 && pieza?.id === antes.id) puedeEditar = false;
      texto = error.message;
    }
    guardando = false; pintar(); mensaje(texto);
  }

  $('motivo').addEventListener('change', pintar);
  $('menos').addEventListener('click', () => ajustar({ delta:-1, motivo:$('motivo').value }));
  $('sumar').addEventListener('click', () => ajustar({ delta:1, motivo:$('motivo').value }));
  $('fijar').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pieza || !puedeEditar || pendiente) return;
    const n = Number($('fijar-a').value), esperado = pieza.stock;
    if ($('fijar-a').value === '' || !Number.isInteger(n) || n < 0 || n > 999 || n === esperado) return mensaje('Escribe una existencia distinta entre 0 y 999.');
    if (!confirm(`¿Cambiar existencia de ${esperado} a ${n}?`)) return;
    void ajustar({ fijar_a:n, esperado, motivo:$('motivo').value });
  });
  $('deshacer').addEventListener('click', () => {
    if (deshacer && Date.now() < deshacer.hasta) void ajustar({ delta:deshacer.delta, motivo:'correccion' }, true);
    else quitarDeshacer();
  });
  $('reintentar').addEventListener('click', enviarAjuste);
  $('editar').addEventListener('click', abrirFormulario);
  $('cancelar-correccion').addEventListener('click', () => { $('corregir').hidden = true; pintar(); });
  $('corregir').addEventListener('submit', (e) => { e.preventDefault(); void guardarCorreccion(); });
  $('foto').addEventListener('error', () => { $('foto').hidden = true; $('sin-foto').hidden = false; });

  return {
    abrir,
    /** Una búsqueda nueva o un cambio de consulta: la ficha abierta deja de existir. */
    cerrar() { ++apertura; pieza = null; pintar(); },
    /** «Volver»: respuestas atrasadas no reabren la ficha, pero lo abierto se conserva. */
    invalidar() { ++apertura; },
  };
}
