// Ficha de una pieza (#441): datos, existencia ± con rastro y corrección de nombre, marca,
// talla y precios. Es un módulo para que /pieza y la pantalla única de #446 usen lo mismo.
// Todo dato de la pieza entra con textContent/value, nunca como HTML.
import { CATEGORIAS } from './categorias.js';
import { nombreEstado } from './estados.js';
import { TALLAS } from './tallas.js';
import { etiquetaVigente, precioImpreso } from './etiquetera.js';
import { estadoEnvio } from './envio-etiquetas.js';
import { normalizarUpc } from './upc.js';
import { esRopa } from './ropa.js';

const $ = (id) => document.getElementById(id);
export const pesos = (centavos) => new Intl.NumberFormat('es-MX', { style:'currency', currency:'MXN', maximumFractionDigits:2 }).format(centavos / 100);

// Bitácora de campos (#485, migración 054): «Precio $450.00 → $400.00 · ana@… · 23/10 14:05». Los valores llegan como texto.
const CAMPOS = { nombre:'Nombre', marca:'Marca', talla:'Talla', categoria:'Categoría', precio:'Precio', precio_lista:'Precio de lista',
  destino:'Destino', estado_fisico:'Grado', upc:'UPC', codigo:'Código', estado_analisis:'Estado' };
const ESTADOS_ANALISIS = { pendiente:'en análisis', listo:'lista', error:'por revisar', descartado:'descartada' };
const AUTORES = { ia:'IA', cola:'búsqueda por código', cron:'proceso automático', sistema:'sistema', manifiesto:'manifiesto' };
function valorCambio(campo, v) {
  if (v === null || v === undefined || v === '') return '(vacío)';
  if (campo === 'precio' || campo === 'precio_lista') return pesos(Number(v));
  if (campo === 'estado_fisico') return nombreEstado(v);
  if (campo === 'estado_analisis') return ESTADOS_ANALISIS[v] ?? v;
  if (campo === 'categoria') return CATEGORIAS.find(([c]) => c === v)?.[1] ?? v;
  return v;
}
export function textoCambio(c) {
  const fecha = new Date(c.en).toLocaleString('es-MX', { timeZone:'America/Mexico_City', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).replace(', ', ' ');
  return [`${CAMPOS[c.campo] ?? c.campo} ${valorCambio(c.campo, c.antes)} → ${valorCambio(c.campo, c.despues)}`, c.por && (AUTORES[c.por] ?? c.por), fecha].filter(Boolean).join(' · ');
}

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
  const upc = campos.upc === undefined ? undefined : String(campos.upc).trim();
  if (upc && !normalizarUpc(upc)) return { error:'Código de barras inválido.' };
  return { cuerpo:{ nombre, marca:String(campos.marca ?? '').trim(), talla:String(campos.talla ?? '').trim(),
    precio_lista:lista, precio, destino:pieza.destino, ...(upc !== undefined && upc !== (pieza.upc ?? '') ? {upc} : {}) } };
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
  if (cuerpo.upc !== undefined && cuerpo.upc !== (pieza.upc ?? '')) lineas.push(`UPC «${pieza.upc || 'sin UPC'}» → «${cuerpo.upc || 'sin UPC'}».`);
  return lineas;
}

/** Misma hoja para un conflicto al corregir y para los grupos históricos de Revisar. */
export function resolverRepetida(origen, destino, { nodo, boton, hoja, api, mensaje, imprimir, cerrar, alTerminar = async () => {}, upc = destino.upc }) {
  const queda = origen.codigo && !destino.codigo ? origen : destino;
  const sale = queda.id === destino.id ? origen : destino;
  const dosEtiquetas = !!origen.codigo && !!destino.codigo;
  const contenido = nodo('div', undefined, 'formulario'), id = crypto.randomUUID();
  let ocupada = false, movida = null, fusionIntentada = false;
  contenido.append(nodo('p', `Pasa ${sale.stock} piezas a ${queda.codigo || queda.nombre}. ${dosEtiquetas ? 'La etiqueta anterior conserva su código con existencia cero.' : 'Se conserva una sola pieza.'}`));
  const juntar = boton(`Juntar en ${queda.codigo || queda.nombre}`, async () => {
    if (ocupada) return; ocupada = true; juntar.setAttribute('aria-disabled','true');
    try {
      const reintento = fusionIntentada; fusionIntentada = true;
      movida ??= dosEtiquetas ? await api(`/api/piezas/${sale.id}/juntar`, {id, destino_id:queda.id})
        : await api(`/api/borradores/${sale.id}/fusionar`, {destino_id:queda.id}).catch(e => {
          if (!reintento || e.status !== 404) throw e;
          return {};
        });
      if (normalizarUpc(queda.upc) !== normalizarUpc(upc)) await api(`/api/borradores/${queda.id}`, {upc:upc || ''}, 'PATCH');
      cerrar(); await alTerminar(queda.id);
      mensaje('Existencias juntas', 'ok');
      if (dosEtiquetas && movida.movidas > 0) {
        const c = nodo('div', undefined, 'formulario');
        c.append(nodo('p', `Reemplaza las ${movida.movidas} etiquetas de ${sale.codigo}.`),
          boton(`Imprimir ${movida.movidas} etiquetas de ${queda.codigo}`, async b => {
            b.setAttribute('aria-disabled','true');
            try { if (await imprimir([queda.id],new Map([[queda.id,movida.movidas]]),{ reimprimir:true })) cerrar(); }
            finally { b.setAttribute('aria-disabled','false'); }
          },'primario'), boton('Cerrar',cerrar));
        hoja('Reetiquetar',c);
      }
    } catch (e) { mensaje((movida ? 'Existencias juntas · falta guardar UPC. ' : '') + e.message, 'error'); }
    finally { ocupada = false; juntar.setAttribute('aria-disabled','false'); }
  },'primario');
  contenido.append(juntar, boton('Cancelar', cerrar));
  hoja(`Ya existe como ${destino.codigo || 'pieza sin etiqueta'} · ${destino.nombre} · ×${destino.stock}`, contenido);
}

/**
 * Misma regla que /etiquetas (etiquetaVigente): si la etiqueta pegada ya no dice el precio, el nombre, la
 * talla o el grado de hoy, hay que reimprimirla. Sin marca en este navegador se toma como pegada la pieza antes de guardar.
 */
export function avisoReimpresion(marca, antes, ahora) {
  if (!antes.codigo || ahora.destino !== 'etiqueta') return null;
  const pegada = marca ?? antes;
  if (etiquetaVigente(pegada, ahora)) return null;
  const grado = (p) => p.estado_fisico ?? 'nuevo';   // las marcas de antes del grado (#453) se leen como A
  return precioImpreso(pegada) !== precioImpreso(ahora)
    ? `La etiqueta pegada dice ${pesos(pegada.precio)} y ahora cuesta ${pesos(ahora.precio)}.`
    : !esRopa(ahora) && grado(pegada) !== grado(ahora)
    ? `La etiqueta pegada dice grado ${nombreEstado(grado(pegada))} y ahora es ${nombreEstado(grado(ahora))}.`
    : `La etiqueta pegada dice «${pegada.nombre ?? ''}${pegada.talla ? ` · ${pegada.talla}` : ''}».`;
}

export function crearFicha({ mensaje, alAbrir = () => {}, confirmar = (texto) => Promise.resolve(confirm(texto)), integrada = false, elegirMotivo = async () => $('motivo').value, alRepetida = () => {}, antesCamara = async () => {} }) {
  let pieza = null, apertura = 0, puedeEditar = false, puedePrecio = false;
  let pendiente = null, enviando = false, guardando = false, deshacer = null, temporizador;
  let apagarUpc = null, camaraTurno = 0;
  async function cerrarCamaraUpc() { ++camaraTurno; await apagarUpc?.(); apagarUpc = null; if ($('e-upc-visor')) $('e-upc-visor').hidden = true; }
  for (const t of TALLAS) { const o = document.createElement('option'); o.value = t; $('tallas').append(o); }

  function pintar() {
    $('ficha').hidden = !pieza;
    if (!pieza) return;
    $('codigo').textContent = pieza.codigo || 'Sin código asignado';
    $('nombre').textContent = pieza.nombre || 'Sin nombre';
    $('detalles').textContent = [pieza.marca, pieza.talla, !esRopa(pieza) && nombreEstado(pieza.estado_fisico), CATEGORIAS.find(([c]) => c === pieza.categoria)?.[1]].filter(Boolean).join(' · ');
    $('upc').textContent = pieza.upc ? `UPC: ${pieza.upc}` : 'Sin UPC';
    $('precio').textContent = pesos(pieza.precio);
    $('precio-lista').textContent = pieza.precio_lista > 0 ? `Lista ${pesos(pieza.precio_lista)}` : '';
    $('stock').value = String(pieza.stock);
    $('existencia').hidden = !puedeEditar;
    $('menos').hidden = $('sumar').hidden = !puedeEditar;
    $('menos').disabled = enviando || !!pendiente || pieza.stock <= 0 || $('motivo').value === 'entrada';
    $('sumar').disabled = enviando || !!pendiente || pieza.stock >= 999 || ['robo', 'merma', 'error de captura'].includes($('motivo').value);
    $('ajustar').disabled = $('deshacer').disabled = enviando || !!pendiente;
    if (integrada) for (const id of ['menos', 'sumar', 'ajustar', 'deshacer']) {
      const b = $(id), sinRed = globalThis.navigator?.onLine === false;
      const motivo = sinRed ? 'Sin red: se suma al volver la señal' : b.disabled ? 'Revisa el ajuste pendiente o el límite' : '';
      b.disabled = false; b.setAttribute('aria-disabled', String(!!motivo)); b.dataset.motivo = motivo;
    }
    // PATCH deja la pieza `listo`: una que aún se analiza se corrige en Inventario › Revisar.
    const corregible = puedeEditar && pieza.estado_analisis === 'listo';
    $('edicion').hidden = !puedeEditar;
    $('editar').hidden = !corregible || !$('corregir').hidden;
    $('nota-edicion').textContent = puedeEditar && !corregible ? 'Esta pieza aún no está lista: corrígela en Inventario › Revisar.' : '';
    $('guardar-correccion').disabled = $('cancelar-correccion').disabled = guardando;
    $('foto').hidden = !pieza.tiene_foto;
    $('sin-foto').hidden = !!pieza.tiene_foto;
    if (pieza.tiene_foto) { $('foto').src = `/api/foto/${pieza.id}?v=${encodeURIComponent(pieza.actualizado_en)}`; $('foto').alt = pieza.nombre; }
  }

  const MOTIVOS_TEXTO = { fusion:'Fusión', descarte:'Descarte' };   // el resto ya se lee tal cual
  function pintarHistorial(historial) {
    $('historial').replaceChildren();
    for (const a of historial) {
      const li = document.createElement('li');
      if (a.campo) li.textContent = textoCambio(a);   // cambio de campo (bitácora #485)
      else {
        const delta = a.despues - a.antes;
        li.textContent = `${new Date(a.ajustado_en).toLocaleString('es-MX', { timeZone:'America/Mexico_City' })} · ${delta > 0 ? '+' : ''}${delta} · ${a.antes} → ${a.despues} · ${MOTIVOS_TEXTO[a.motivo] ?? a.motivo} · ${a.ajustado_por}`;
      }
      $('historial').append(li);
    }
    if (!historial.length) { const li = document.createElement('li'); li.textContent = 'Sin cambios registrados.'; $('historial').append(li); }
  }

  function cerrarFormulario() { void cerrarCamaraUpc(); $('corregir').hidden = true; $('reimprimir').hidden = true; }

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
      alAbrir(pieza, datos);
      mensaje(`Pieza abierta: ${pieza.nombre}. Existencia ${pieza.stock}.`);
    } catch (error) { if (turno === apertura) mensaje(error.message, 'error'); }
  }

  async function ajustar(cuerpo, inverso = false) {
    if (!pieza || !puedeEditar || pendiente || enviando) return;
    if (globalThis.navigator?.onLine === false) return mensaje('Sin red: se suma al volver la señal');
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
    if ($('e-upc')) $('e-upc').value = pieza.upc ?? '';
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
      precio:$('e-precio').value, precio_lista:$('e-lista').value, upc:$('e-upc')?.value }, puedePrecio);
    if (r.error) return mensaje(r.error);
    const lineas = resumenCorreccion(pieza, r.cuerpo, estadoEnvio(pieza).marca);
    if (!lineas.length) return mensaje('No hay cambios que guardar.');
    if (!await confirmar(`${lineas.join('\n')}\n\n¿Guardar?`)) return;
    const antes = { ...pieza }, turno = apertura;
    guardando = true; pintar();
    let texto;
    try {
      const g = await api(`/api/borradores/${antes.id}`, r.cuerpo, 'PATCH');
      texto = `${g.nombre}: cambios guardados.`;
      if (pieza?.id === antes.id && turno === apertura) {
        Object.assign(pieza, { nombre:g.nombre, marca:g.marca, talla:g.talla, precio:g.precio, precio_lista:g.precio_lista,
          destino:g.destino, stock:g.stock, upc:g.upc ?? pieza.upc, estado_analisis:'listo' });
        await cerrarCamaraUpc();
        $('corregir').hidden = true;
        const aviso = avisoReimpresion(estadoEnvio(antes).marca, antes, pieza);
        $('reimprimir').hidden = !aviso;
        if (aviso) $('reimprimir-texto').textContent = aviso;
      }
    } catch (error) {
      if (error.status === 409 && error.datos?.existente && turno === apertura) alRepetida(antes, error.datos.existente, r.cuerpo.upc ?? antes.upc);
      if (error.status === 403 && pieza?.id === antes.id) puedeEditar = false;
      texto = error.message;
    }
    guardando = false; pintar(); mensaje(texto);
  }

  $('motivo').addEventListener('change', pintar);
  $('menos').addEventListener('click', async () => {
    const motivo = integrada ? await elegirMotivo() : $('motivo').value;
    if (motivo) void ajustar({ delta:-1, motivo });
  });
  $('sumar').addEventListener('click', () => ajustar({ delta:1, motivo:integrada ? 'entrada' : $('motivo').value }));
  $('fijar').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pieza || !puedeEditar || pendiente) return;
    const n = Number($('fijar-a').value), esperado = pieza.stock;
    if ($('fijar-a').value === '' || !Number.isInteger(n) || n < 0 || n > 999 || n === esperado) return mensaje('Escribe una existencia distinta entre 0 y 999.');
    const motivo = integrada ? await elegirMotivo() : $('motivo').value;
    if (!motivo) return;
    if (!await confirmar(`¿Cambiar existencia de ${esperado} a ${n}?`)) return;
    void ajustar({ fijar_a:n, esperado, motivo });
  });
  $('deshacer').addEventListener('click', () => {
    if (deshacer && Date.now() < deshacer.hasta) void ajustar({ delta:deshacer.delta, motivo:'correccion' }, true);
    else quitarDeshacer();
  });
  $('reintentar').addEventListener('click', enviarAjuste);
  $('editar').addEventListener('click', abrirFormulario);
  $('cancelar-correccion').addEventListener('click', () => { void cerrarCamaraUpc(); $('corregir').hidden = true; pintar(); });
  $('e-upc')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); } });
  $('leer-upc')?.addEventListener('click', async () => {
    if (!puedeEditar || guardando) return;
    try {
      await cerrarCamaraUpc(); await antesCamara(); const turno = ++camaraTurno;
      $('e-upc-visor').hidden = false;
      const { abrirCamara } = await import('./camara.js');
      const apagar = await abrirCamara('e-upc-visor', codigo => {
        if (turno !== camaraTurno) return;
        if (!normalizarUpc(codigo)) return mensaje('Código de barras inválido.', 'error');
        $('e-upc').value = codigo; void cerrarCamaraUpc(); $('e-upc').focus();
      }, { producto:true });
      if (turno !== camaraTurno) await apagar(); else apagarUpc = apagar;
    } catch (e) { mensaje(e.message,'error'); }
  });
  if (globalThis.document?.addEventListener) document.addEventListener('visibilitychange', () => { if (document.hidden) void cerrarCamaraUpc(); });
  $('corregir').addEventListener('submit', (e) => { e.preventDefault(); void guardarCorreccion(); });
  $('foto').addEventListener('error', () => { $('foto').hidden = true; $('sin-foto').hidden = false; });

  return {
    abrir,
    repintar: pintar,
    /** La pieza abierta con lo último que guardó la ficha (Revisar la usa para no pisar esas correcciones). */
    pieza: () => pieza,
    /** Una búsqueda nueva o un cambio de consulta: la ficha abierta deja de existir. */
    cerrar() { ++apertura; void cerrarCamaraUpc(); pieza = null; pintar(); },
    /** «Volver»: respuestas atrasadas no reabren la ficha, pero lo abierto se conserva. */
    invalidar() { ++apertura; void cerrarCamaraUpc(); },
  };
}
