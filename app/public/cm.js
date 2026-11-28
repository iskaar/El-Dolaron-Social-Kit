import {
  pesosDeCentavos, centavosDePesos, pctDeBp, bpDePct,
  isoAMxLocal, mxLocalAIso, isoADiaMx, bonoDesdeAFecha, fechaABonoDesde,
  armarPayloadCambios, contarCambios, coincideBusqueda,
} from '/cm-logica.js';

document.getElementById('salir').addEventListener('click', async () => {
  (await import('/cerrar-sesion.js')).cerrarSesion();
});

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const $ = (id) => document.getElementById(id);

let estadoServidor = null;
let inicial = { config: {}, nomina: {}, env: {} };
let actual = { config: {}, nomina: {}, env: {} };
const erroresValidacion = new Map();

function clonar(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function textoDeValor(v, omision = '') {
  return v !== null && v !== undefined && v !== '' ? String(v) : String(omision);
}

function construirEstadoEditable(datos) {
  const cfg = datos.config ?? {};
  const om = datos.omisiones ?? {};
  const configPlano = {};

  for (const k of Object.keys(om)) {
    configPlano[k] = textoDeValor(cfg[k], om[k]);
  }
  configPlano.tope_retiro = cfg.tope_retiro ?? null;
  configPlano.recolecciones_desde = isoADiaMx(cfg.recolecciones_desde);
  for (const t of datos.catalogo.tiendas) {
    for (const c of t.cajas) {
      configPlano[c.clave] = cfg[c.clave] ?? null;
    }
  }

  const nominaPlano = {
    checador_activo: Boolean(datos.nomina?.checador_activo),
    bono_centavos: String(datos.nomina?.bono_centavos ?? 0),
    tolerancia_minutos: String(datos.nomina?.tolerancia_minutos ?? 0),
    retardos_permitidos: String(datos.nomina?.retardos_permitidos ?? 0),
    faltas_permitidas: String(datos.nomina?.faltas_permitidas ?? 0),
  };

  const envPlano = {};
  for (const e of datos.env_overrides ?? []) {
    envPlano[e.clave] = e.override; // null = hereda wrangler, string = override activo (incluye '')
  }

  return { config: configPlano, nomina: nominaPlano, env: envPlano };
}

function campoId(seccion, clave) {
  return `campo-${seccion}-${clave}`;
}

function marcarSuciedad() {
  const payload = armarPayloadCambios(inicial, actual);
  const n = contarCambios(payload);
  const barra = $('barra-guardar');
  const estado = $('estado-guardar');

  for (const el of document.querySelectorAll('.campo[data-seccion][data-clave]')) {
    const s = el.dataset.seccion;
    const k = el.dataset.clave;
    const sucio = (inicial[s]?.[k] ?? null) !== (actual[s]?.[k] ?? null);
    el.classList.toggle('sucio', sucio);
  }

  if (erroresValidacion.size > 0) {
    barra.hidden = false;
    estado.className = 'estado-guardar error';
    estado.textContent = [...erroresValidacion.values()][0];
    $('btn-guardar').disabled = true;
    return;
  }

  $('btn-guardar').disabled = n === 0;
  if (n > 0) {
    barra.hidden = false;
    estado.className = 'estado-guardar';
    estado.textContent = `${n} ${n === 1 ? 'cambio pendiente' : 'cambios pendientes'} sin guardar`;
  } else {
    barra.hidden = true;
    estado.textContent = '';
  }
}

window.addEventListener('beforeunload', (e) => {
  if (contarCambios(armarPayloadCambios(inicial, actual)) > 0) {
    e.preventDefault();
  }
});

/* ---------- Constructores de campos ---------- */

function crearCampo({ seccion, clave, etiqueta, ayuda = '', busqueda = '', controlHtml, extraClass = '' }) {
  const div = document.createElement('div');
  div.className = `campo ${extraClass}`.trim();
  div.dataset.seccion = seccion;
  div.dataset.clave = clave;
  div.dataset.busqueda = `${etiqueta} ${clave} ${ayuda} ${busqueda}`;
  div.innerHTML = `<label for="${campoId(seccion, clave)}">${esc(etiqueta)}</label>${controlHtml}${ayuda ? `<span class="ayuda">${esc(ayuda)}</span>` : ''}`;
  return div;
}

function campoNumeroConfig({ clave, etiqueta, ayuda = '', min = 0, max = '', step = '1', modo = 'entero', nullable = false, botonLimpiar = '' }) {
  const crudo = actual.config[clave];
  const valorVisual = modo === 'pesos' ? pesosDeCentavos(crudo)
    : modo === 'bp' ? pctDeBp(crudo)
    : (crudo ?? '');
  const escala = modo === 'pesos' || modo === 'bp' ? 100 : 1;
  const minHtml = min !== '' ? String(Number(min) / escala) : '';
  const maxHtml = max !== '' ? String(Number(max) / escala) : '';
  const id = campoId('config', clave);
  const limpiarHtml = nullable && botonLimpiar ? `<button type="button" class="mini" data-limpiar-config="${esc(clave)}">${esc(botonLimpiar)}</button>` : '';
  const div = crearCampo({
    seccion: 'config',
    clave,
    etiqueta,
    ayuda,
    controlHtml: `<div class="fila-input"><input id="${id}" type="number" ${minHtml !== '' ? `min="${minHtml}"` : ''} ${maxHtml !== '' ? `max="${maxHtml}"` : ''} step="${step}" value="${esc(valorVisual)}">${limpiarHtml}</div>`,
  });
  const input = div.querySelector('input');
  const validar = () => {
    const t = input.value.trim();
    if (t === '') {
      if (nullable) {
        erroresValidacion.delete(`config:${clave}`);
        actual.config[clave] = null;
      } else {
        erroresValidacion.set(`config:${clave}`, `${etiqueta}: escribe un valor.`);
      }
      marcarSuciedad();
      return;
    }
    let convertido = null;
    if (modo === 'pesos') convertido = centavosDePesos(t);
    else if (modo === 'bp') convertido = bpDePct(t);
    else {
      const n = Number(t);
      convertido = Number.isInteger(n) ? n : Number.NaN;
    }
    if (convertido === null || Number.isNaN(convertido)) {
      erroresValidacion.set(`config:${clave}`, `${etiqueta}: número inválido.`);
    } else if ((min !== '' && convertido < min) || (max !== '' && convertido > max)) {
      erroresValidacion.set(`config:${clave}`, `${etiqueta}: valor fuera de rango.`);
    } else {
      erroresValidacion.delete(`config:${clave}`);
      actual.config[clave] = String(convertido);
    }
    marcarSuciedad();
  };
  input.addEventListener('input', validar);
  if (nullable && botonLimpiar) {
    div.querySelector('[data-limpiar-config]').addEventListener('click', () => {
      input.value = '';
      validar();
    });
  }
  return div;
}

function campoSelectConfig({ clave, etiqueta, ayuda = '', opciones }) {
  const id = campoId('config', clave);
  const val = actual.config[clave] ?? '';
  const opts = opciones.map(([v, t]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const div = crearCampo({ seccion: 'config', clave, etiqueta, ayuda, controlHtml: `<select id="${id}">${opts}</select>` });
  div.querySelector('select').addEventListener('change', (e) => {
    actual.config[clave] = e.target.value;
    marcarSuciedad();
  });
  return div;
}

function campoCheckboxConfig({ clave, etiqueta, ayuda = '', invertir = false }) {
  const id = campoId('config', clave);
  const marcado = invertir ? actual.config[clave] !== '0' : actual.config[clave] === '1';
  const div = crearCampo({
    seccion: 'config',
    clave,
    etiqueta,
    ayuda,
    controlHtml: `<label class="check-fila"><input id="${id}" type="checkbox" ${marcado ? 'checked' : ''}><span>${marcado ? 'Activado' : 'Apagado'}</span></label>`,
  });
  const input = div.querySelector('input');
  const txt = div.querySelector('.check-fila span');
  input.addEventListener('change', () => {
    const val = invertir ? (input.checked ? '1' : '0') : (input.checked ? '1' : '0');
    actual.config[clave] = val;
    txt.textContent = input.checked ? 'Activado' : 'Apagado';
    marcarSuciedad();
  });
  return div;
}

function metaEnv(clave) {
  return (estadoServidor.env_overrides ?? []).find((e) => e.clave === clave) ?? { clave, efectivo: null, wrangler: null, override: null, fuente: 'sin_valor' };
}

function actualizarBadgeEnv(div, clave) {
  const m = metaEnv(clave);
  const overrideActual = actual.env[clave];
  const fuente = overrideActual !== null && overrideActual !== undefined ? 'override' : m.wrangler !== null ? 'wrangler' : 'vacio';
  div.classList.toggle('es-override', fuente === 'override');
  const pill = div.querySelector('.pill');
  const btn = div.querySelector('[data-heredar]');
  if (fuente === 'override') {
    pill.className = 'pill override';
    pill.textContent = 'Override D1 activo';
    btn.hidden = false;
  } else if (fuente === 'wrangler') {
    pill.className = 'pill wrangler';
    pill.textContent = 'De wrangler.jsonc';
    btn.hidden = true;
  } else {
    pill.className = 'pill vacio';
    pill.textContent = 'Sin valor';
    btn.hidden = true;
  }
}

function campoEnv({ clave, etiqueta, ayuda = '', tipo, opciones = [] }) {
  const m = metaEnv(clave);
  const efectivoInicial = actual.env[clave] !== null && actual.env[clave] !== undefined ? actual.env[clave] : (m.wrangler ?? '');
  const id = campoId('env', clave);
  let control = '';
  if (tipo === 'si_no') {
    const on = efectivoInicial === 'si';
    control = `<label class="check-fila"><input id="${id}" type="checkbox" ${on ? 'checked' : ''}><span>${on ? 'Encendido (si)' : 'Apagado'}</span></label>`;
  } else if (tipo === 'select') {
    control = `<select id="${id}">${opciones.map(([v, t]) => `<option value="${esc(v)}" ${v === efectivoInicial ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  } else if (tipo === 'datetime') {
    control = `<input id="${id}" type="datetime-local" value="${esc(isoAMxLocal(efectivoInicial))}">`;
  } else if (tipo === 'pesos') {
    control = `<input id="${id}" type="number" min="0" step="0.01" value="${esc(pesosDeCentavos(efectivoInicial))}">`;
  } else if (tipo === 'entero') {
    control = `<input id="${id}" type="number" min="0" step="1" value="${esc(efectivoInicial)}">`;
  } else if (tipo === 'tiendas') {
    const elegidas = new Set(String(efectivoInicial).split(',').map((s) => s.trim()).filter(Boolean));
    control = `<div class="tiendas-checks" id="${id}">${estadoServidor.catalogo.tiendas.map((t) =>
      `<label><input type="checkbox" value="${esc(t.clave)}" ${elegidas.has(t.clave) ? 'checked' : ''}>${esc(t.nombre)}</label>`).join('')}</div>`;
  }

  const baseTxt = m.wrangler ? `Base en wrangler: ${m.wrangler}` : 'Base en wrangler: (sin definir)';
  const div = crearCampo({
    seccion: 'env',
    clave,
    etiqueta,
    ayuda: `${ayuda ? `${ayuda} · ` : ''}${baseTxt}`,
    controlHtml: `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px"><span class="pill"></span><button type="button" class="mini" data-heredar="${esc(clave)}">Heredar</button></div>${control}`,
  });

  const repintarDesdeValor = (valEfectivo) => {
    if (tipo === 'si_no') {
      const cb = div.querySelector('input');
      cb.checked = valEfectivo === 'si';
      div.querySelector('.check-fila span').textContent = cb.checked ? 'Encendido (si)' : 'Apagado';
    } else if (tipo === 'select') {
      div.querySelector('select').value = valEfectivo;
    } else if (tipo === 'datetime') {
      div.querySelector('input').value = isoAMxLocal(valEfectivo);
    } else if (tipo === 'pesos') {
      div.querySelector('input').value = pesosDeCentavos(valEfectivo);
    } else if (tipo === 'entero') {
      div.querySelector('input').value = valEfectivo;
    } else if (tipo === 'tiendas') {
      const set = new Set(String(valEfectivo).split(',').map((s) => s.trim()).filter(Boolean));
      for (const cb of div.querySelectorAll('input[type="checkbox"]')) cb.checked = set.has(cb.value);
    }
  };

  if (tipo === 'si_no') {
    const cb = div.querySelector('input');
    cb.addEventListener('change', () => {
      actual.env[clave] = cb.checked ? 'si' : '';
      div.querySelector('.check-fila span').textContent = cb.checked ? 'Encendido (si)' : 'Apagado';
      actualizarBadgeEnv(div, clave);
      marcarSuciedad();
    });
  } else if (tipo === 'select') {
    div.querySelector('select').addEventListener('change', (e) => {
      actual.env[clave] = e.target.value;
      actualizarBadgeEnv(div, clave);
      marcarSuciedad();
    });
  } else if (tipo === 'datetime') {
    div.querySelector('input').addEventListener('input', (e) => {
      const iso = mxLocalAIso(e.target.value);
      if (iso === null) erroresValidacion.set(`env:${clave}`, `${etiqueta}: fecha/hora inválida.`);
      else { erroresValidacion.delete(`env:${clave}`); actual.env[clave] = iso; }
      actualizarBadgeEnv(div, clave);
      marcarSuciedad();
    });
  } else if (tipo === 'pesos') {
    div.querySelector('input').addEventListener('input', (e) => {
      const t = e.target.value.trim();
      if (t === '') { erroresValidacion.delete(`env:${clave}`); actual.env[clave] = ''; }
      else {
        const c = centavosDePesos(t);
        if (Number.isNaN(c)) erroresValidacion.set(`env:${clave}`, `${etiqueta}: monto inválido.`);
        else { erroresValidacion.delete(`env:${clave}`); actual.env[clave] = String(c); }
      }
      actualizarBadgeEnv(div, clave);
      marcarSuciedad();
    });
  } else if (tipo === 'entero') {
    div.querySelector('input').addEventListener('input', (e) => {
      const t = e.target.value.trim();
      if (t === '') { erroresValidacion.delete(`env:${clave}`); actual.env[clave] = ''; }
      else {
        const n = Number(t);
        if (!Number.isInteger(n) || n < 0) erroresValidacion.set(`env:${clave}`, `${etiqueta}: entero >= 0.`);
        else { erroresValidacion.delete(`env:${clave}`); actual.env[clave] = String(n); }
      }
      actualizarBadgeEnv(div, clave);
      marcarSuciedad();
    });
  } else if (tipo === 'tiendas') {
    for (const cb of div.querySelectorAll('input[type="checkbox"]')) {
      cb.addEventListener('change', () => {
        const seleccion = [...div.querySelectorAll('input[type="checkbox"]:checked')].map((x) => x.value);
        actual.env[clave] = seleccion.join(',');
        actualizarBadgeEnv(div, clave);
        marcarSuciedad();
      });
    }
  }

  div.querySelector('[data-heredar]').addEventListener('click', () => {
    erroresValidacion.delete(`env:${clave}`);
    actual.env[clave] = null;
    repintarDesdeValor(m.wrangler ?? '');
    actualizarBadgeEnv(div, clave);
    marcarSuciedad();
  });

  actualizarBadgeEnv(div, clave);
  return div;
}

/* ---------- Pintado completo ---------- */

function pintarTodo() {
  erroresValidacion.clear();
  const { catalogo, salud, historial_listo, historial } = estadoServidor;

  // 1. Precios y Dólar
  const secPrecios = $('sec-precios');
  secPrecios.replaceChildren(
    campoNumeroConfig({ clave: 'tipo_cambio', etiqueta: 'Tipo de cambio ($ MXN por 1 USD)', ayuda: 'Precio de Target/manifiesto en USD × esto = precio de lista en MXN.', modo: 'pesos', min: 100, max: 20000, step: '0.01' }),
    ...catalogo.categorias.map(([c, nombre]) => campoNumeroConfig({ clave: `pct_${c}`, etiqueta: `${nombre} (%)`, min: 0, max: 500 })),
    campoNumeroConfig({ clave: 'pct_danado', etiqueta: 'Dañado grado B (%)', ayuda: 'Multiplica sobre el % de categoría.', min: 0, max: 500 }),
    campoNumeroConfig({ clave: 'pct_liquidacion', etiqueta: 'Liquidación grado C (%)', ayuda: '% directo del precio de lista.', min: 0, max: 500 }),
    campoNumeroConfig({ clave: 'meta_ventas_mes', etiqueta: 'Meta de ventas del mes ($)', ayuda: 'Tablero de inversionistas (0 = oculta la barra).', modo: 'pesos', min: 0, max: 1_000_000_000, step: '1' }),
  );

  // 2. Bandas
  const extraSet = new Set(catalogo.montos_extra ?? []);
  $('sec-bandas').replaceChildren(
    ...catalogo.montos_banda.map((m) => campoNumeroConfig({
      clave: `banda_${m}`,
      etiqueta: extraSet.has(m) ? `Banda $${m} (agregada)` : `Banda $${m}`,
      ayuda: extraSet.has(m) ? 'Agregada desde /cm.' : '',
      modo: 'pesos',
      min: 0,
      max: 10_000_000,
      step: '1',
    })),
    campoNumeroConfig({ clave: 'limite_banda', etiqueta: 'Límite histórico de banda ($)', ayuda: 'Referencia heredada del arranque.', modo: 'pesos', min: 0, max: 10_000_000, step: '1' }),
  );
  $('sec-bandas-anteriores').replaceChildren(
    ...catalogo.montos_anteriores.map((m) => campoNumeroConfig({ clave: `banda_${m}`, etiqueta: `Banda anterior $${m}`, modo: 'pesos', min: 0, max: 10_000_000, step: '1' })),
  );

  // 3. Caja y Efectivo
  const desdeDiv = crearCampo({
    seccion: 'config',
    clave: 'recolecciones_desde',
    etiqueta: 'Contar cortes para recolección desde',
    ayuda: 'Cortes anteriores a esta fecha no salen como pendientes en /dinero.',
    controlHtml: `<input id="${campoId('config', 'recolecciones_desde')}" type="date" value="${esc(actual.config.recolecciones_desde)}">`,
  });
  desdeDiv.querySelector('input').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (!v) erroresValidacion.set('config:recolecciones_desde', 'Contar cortes desde: elige una fecha.');
    else { erroresValidacion.delete('config:recolecciones_desde'); actual.config.recolecciones_desde = v; }
    marcarSuciedad();
  });

  $('sec-caja').replaceChildren(
    campoNumeroConfig({ clave: 'fondo_caja', etiqueta: 'Fondo de caja centralizado ($)', ayuda: 'Lo que queda en cada cajón tras el corte si la caja no tiene fondo propio.', modo: 'pesos', min: 0, max: 100_000_000, step: '1' }),
    campoNumeroConfig({ clave: 'tope_retiro', etiqueta: 'Retiro sin aprobación ($)', ayuda: 'Arriba de este monto pide PIN de gerencia/supervisor. Vacío = siempre pedir PIN.', modo: 'pesos', min: 0, max: 100_000_000, step: '1', nullable: true, botonLimpiar: 'Siempre PIN' }),
    campoNumeroConfig({ clave: 'cupon_porcentaje', etiqueta: 'Devolución en cupón (%)', ayuda: '% en Dolarones al devolver (1–200; 100 = igual).', min: 1, max: 200 }),
    campoNumeroConfig({ clave: 'comision_terminal_pct', etiqueta: 'Comisión de terminal (%)', ayuda: 'Estimado sobre cobros con tarjeta (0–20 % con 2 decimales).', modo: 'bp', min: 0, max: 2000, step: '0.01' }),
    desdeDiv,
  );

  const fondosWrap = $('sec-fondos-caja');
  fondosWrap.replaceChildren();
  for (const tienda of catalogo.tiendas) {
    const h = document.createElement('p');
    h.className = 'desc';
    h.style.margin = '10px 0 6px';
    h.innerHTML = `<b>${esc(tienda.nombre)}</b>`;
    const malla = document.createElement('div');
    malla.className = 'malla';
    for (const caja of tienda.cajas) {
      malla.append(campoNumeroConfig({
        clave: caja.clave,
        etiqueta: `${caja.nombre} ($)`,
        ayuda: 'Vacío = usa el fondo centralizado.',
        modo: 'pesos',
        min: 0,
        max: 100_000_000,
        step: '1',
        nullable: true,
        botonLimpiar: 'Usar global',
      }));
    }
    fondosWrap.append(h, malla);
  }

  // 4. Bonos y Retos
  const bonoDesdeDiv = crearCampo({
    seccion: 'config',
    clave: 'bono_tienda_desde',
    etiqueta: 'Inicio del bono por tienda (un lunes)',
    ayuda: 'Vacío = bono semanal apagado.',
    controlHtml: `<div class="fila-input"><input id="${campoId('config', 'bono_tienda_desde')}" type="date" value="${esc(bonoDesdeAFecha(actual.config.bono_tienda_desde))}"><button type="button" class="mini" id="btn-apagar-bono">Apagar</button></div>`,
  });
  const bonoDesdeInput = bonoDesdeDiv.querySelector('input');
  const validarBonoDesde = () => {
    const n = fechaABonoDesde(bonoDesdeInput.value);
    if (n === null) {
      erroresValidacion.set('config:bono_tienda_desde', 'Inicio del bono: fecha inválida.');
    } else if (n !== 0) {
      const d = new Date(`${bonoDesdeInput.value}T12:00:00Z`);
      if (d.getUTCDay() !== 1) erroresValidacion.set('config:bono_tienda_desde', 'Inicio del bono debe caer en lunes.');
      else { erroresValidacion.delete('config:bono_tienda_desde'); actual.config.bono_tienda_desde = String(n); }
    } else {
      erroresValidacion.delete('config:bono_tienda_desde');
      actual.config.bono_tienda_desde = '0';
    }
    marcarSuciedad();
  };
  bonoDesdeInput.addEventListener('input', validarBonoDesde);
  bonoDesdeDiv.querySelector('#btn-apagar-bono').addEventListener('click', () => {
    bonoDesdeInput.value = '';
    validarBonoDesde();
  });

  $('sec-bonos').replaceChildren(
    bonoDesdeDiv,
    ...catalogo.tiendas.map((t) => campoNumeroConfig({ clave: `bono_tienda_linea_${t.clave}`, etiqueta: `Línea semanal ${t.nombre} ($)`, ayuda: '0 = tienda sin bono.', modo: 'pesos', min: 0, max: 1_000_000_000, step: '1' })),
    campoNumeroConfig({ clave: 'bono_tienda_pb', etiqueta: 'Bono arriba de la línea (%)', modo: 'bp', min: 0, max: 10000, step: '0.01' }),
    campoNumeroConfig({ clave: 'bono_tienda_meta_tope', etiqueta: 'Meta tope semanal ($)', ayuda: '0 = todo excedente usa el % normal.', modo: 'pesos', min: 0, max: 1_000_000_000, step: '1' }),
    campoNumeroConfig({ clave: 'bono_tienda_pb_arriba', etiqueta: '% arriba de la meta tope', modo: 'bp', min: 0, max: 10000, step: '0.01' }),
    campoNumeroConfig({ clave: 'bono_d_cada', etiqueta: '1 Dolarón por cada ($ de bono)', modo: 'pesos', min: 0, max: 1_000_000_000, step: '1' }),
    campoNumeroConfig({ clave: 'bono_d_tope', etiqueta: 'Tope Dolarones / persona / semana', min: 0, max: 100_000 }),
    campoNumeroConfig({ clave: 'bono_d_record', etiqueta: 'Premio semana récord (Dolarones)', min: 0, max: 100_000 }),
  );

  $('sec-retos').replaceChildren(
    campoNumeroConfig({ clave: 'reto_dias_viejo', etiqueta: 'Pieza vieja: días mínimos en tienda', min: 0, max: 3650 }),
    campoNumeroConfig({ clave: 'reto_d_viejo', etiqueta: 'Pieza vieja: premio (Dolarones)', ayuda: '0 apaga el reto.', min: 0, max: 100_000 }),
    campoNumeroConfig({ clave: 'reto_stock_alto', etiqueta: 'Desatorar: existencia mínima (pzas)', min: 0, max: 365 }),
    campoNumeroConfig({ clave: 'reto_d_stock', etiqueta: 'Desatorar: premio (Dolarones)', ayuda: '0 apaga el reto.', min: 0, max: 100_000 }),
    campoNumeroConfig({ clave: 'reto_racha_dias', etiqueta: 'Racha: días trabajados seguidos', min: 0, max: 365 }),
    campoNumeroConfig({ clave: 'reto_d_racha', etiqueta: 'Racha: premio (Dolarones)', ayuda: '0 apaga el reto.', min: 0, max: 100_000 }),
    campoNumeroConfig({ clave: 'reto_d_socio', etiqueta: 'Socio nuevo con compra (Dolarones)', min: 0, max: 100_000 }),
    campoNumeroConfig({ clave: 'reto_d_apartado', etiqueta: 'Apartado vendido (Dolarones)', min: 0, max: 100_000 }),
    campoNumeroConfig({ clave: 'reto_d_tope_mes', etiqueta: 'Tope mensual de retos (Dolarones)', min: 0, max: 100_000 }),
  );

  // 5. Mercado Libre
  $('sec-ml').replaceChildren(
    campoNumeroConfig({ clave: 'ml_descuento_referencia', etiqueta: 'Descuento bajo referencia de ML (%)', ayuda: 'Mínimo 20 %, máximo 90 %.', min: 20, max: 90 }),
    campoNumeroConfig({ clave: 'ml_pct', etiqueta: 'Recargo sobre precio de tienda (%)', ayuda: 'Se usa cuando ML no tiene precio de referencia (0–300 %).', min: 0, max: 300 }),
    campoSelectConfig({ clave: 'ml_tipo_publicacion', etiqueta: 'Tipo de publicación', opciones: [['gold_special', 'Clásica (gold_special)'], ['gold_pro', 'Premium (gold_pro)'], ['free', 'Gratuita (free)']] }),
  );

  // 6. Nómina
  const nomCheck = crearCampo({
    seccion: 'nomina',
    clave: 'checador_activo',
    etiqueta: 'Checador de entradas',
    ayuda: 'Habilita el registro de entrada con PIN en caja.',
    controlHtml: `<label class="check-fila"><input id="${campoId('nomina', 'checador_activo')}" type="checkbox" ${actual.nomina.checador_activo ? 'checked' : ''}><span>${actual.nomina.checador_activo ? 'Activado' : 'Apagado'}</span></label>`,
  });
  nomCheck.querySelector('input').addEventListener('change', (e) => {
    actual.nomina.checador_activo = e.target.checked;
    nomCheck.querySelector('.check-fila span').textContent = e.target.checked ? 'Activado' : 'Apagado';
    marcarSuciedad();
  });

  const campoNominaNum = (clave, etiqueta, { min = 0, max, modo = 'entero' }) => {
    const val = modo === 'pesos' ? pesosDeCentavos(actual.nomina[clave]) : actual.nomina[clave];
    const escala = modo === 'pesos' ? 100 : 1;
    const div = crearCampo({
      seccion: 'nomina',
      clave,
      etiqueta,
      controlHtml: `<input id="${campoId('nomina', clave)}" type="number" min="${min / escala}" max="${max / escala}" step="1" value="${esc(val)}">`,
    });
    div.querySelector('input').addEventListener('input', (e) => {
      const t = e.target.value.trim();
      const conv = modo === 'pesos' ? centavosDePesos(t) : (t === '' ? Number.NaN : Number(t));
      if (conv === null || Number.isNaN(conv) || !Number.isInteger(conv) || conv < min || conv > max) {
        erroresValidacion.set(`nomina:${clave}`, `${etiqueta}: valor inválido.`);
      } else {
        erroresValidacion.delete(`nomina:${clave}`);
        actual.nomina[clave] = String(conv);
      }
      marcarSuciedad();
    });
    return div;
  };

  $('sec-nomina').replaceChildren(
    nomCheck,
    campoNominaNum('bono_centavos', 'Bono de puntualidad ($)', { min: 0, max: 10_000_000, modo: 'pesos' }),
    campoNominaNum('tolerancia_minutos', 'Tolerancia de entrada (min)', { min: 0, max: 240 }),
    campoNominaNum('retardos_permitidos', 'Retardos permitidos por periodo', { min: 0, max: 31 }),
    campoNominaNum('faltas_permitidas', 'Faltas permitidas por periodo', { min: 0, max: 31 }),
  );

  // 7. IA y Automatización
  $('sec-ia').replaceChildren(
    campoEnv({ clave: 'MODELO_ANALISIS', etiqueta: 'Proveedor de análisis por foto', tipo: 'select', opciones: [['claude', 'Claude (Haiku)'], ['gemini', 'Gemini']] }),
    campoEnv({ clave: 'BUSQUEDA_WEB', etiqueta: 'Búsqueda web en Gemini', ayuda: 'Solo aplica cuando el proveedor es Gemini.', tipo: 'si_no' }),
    campoCheckboxConfig({ clave: 'ropa_ia_activo', etiqueta: 'Ropa IA (cron cada 15 min)', ayuda: 'Clasifica prenda y marca en capturas de ropa.' }),
    campoCheckboxConfig({ clave: 'recortes_activo', etiqueta: 'Recortes de fondo (cron)', ayuda: 'Genera y revisa recortes WebP de piezas.' }),
    campoCheckboxConfig({ clave: 'portadas_activo', etiqueta: 'Portadas con IA (cron)', ayuda: 'Genera fotos de portada para catálogo/ML.' }),
    campoCheckboxConfig({ clave: 'portadas_aprobacion', etiqueta: 'Exigir aprobación manual de portadas', ayuda: 'Desactivado (0) publica automático las portadas aprobadas por IA.', invertir: true }),
    campoNumeroConfig({ clave: 'portadas_tope_diario', etiqueta: 'Tope diario de portadas', ayuda: 'Límite de generaciones por día de tienda.', min: 0, max: 10_000 }),
    campoSelectConfig({ clave: 'portadas_modelo', etiqueta: 'Modelo de portadas (AI Studio)', opciones: [['gemini-3.1-flash-image', 'gemini-3.1-flash-image'], ['gemini-nano-banana-2.1', 'gemini-nano-banana-2.1']] }),
    campoSelectConfig({ clave: 'portadas_tamano', etiqueta: 'Tamaño de portada (AI Studio)', opciones: [['1K', '1K'], ['2K', '2K']] }),
  );

  // 8. Promos e Interruptores
  $('sec-promos').replaceChildren(
    campoEnv({ clave: 'CONTEO_UMBRAL', etiqueta: 'Umbral de conteo de alto valor ($)', ayuda: 'Piezas desde este precio salen en /conteo.', tipo: 'pesos' }),
    campoEnv({ clave: 'PORTAL_REGISTRO_ABIERTO', etiqueta: 'Registro público en portal Dolarones', tipo: 'si_no' }),
    campoEnv({ clave: 'VALES_ABIERTOS', etiqueta: 'Emisión de vales impresos en caja', tipo: 'si_no' }),
    campoEnv({ clave: 'REFERIDOS_ABIERTO', etiqueta: 'Programa de referidos en portal', tipo: 'si_no' }),
    campoEnv({ clave: 'PREMIOS_APERTURA', etiqueta: 'Premios de apertura (registro y llegada)', tipo: 'si_no' }),
    campoEnv({ clave: 'BUENFIN_DESDE', etiqueta: 'Buen Fin · inicio (hora tienda)', tipo: 'datetime' }),
    campoEnv({ clave: 'BUENFIN_HASTA', etiqueta: 'Buen Fin · fin exclusivo (hora tienda)', tipo: 'datetime' }),
    campoEnv({ clave: 'BUENFIN_TIENDAS', etiqueta: 'Buen Fin · tiendas', ayuda: 'Sin marcar = aplica en todas las tiendas.', tipo: 'tiendas' }),
    campoEnv({ clave: 'PROMO_DESDE', etiqueta: 'Promo inauguración · inicio (hora tienda)', tipo: 'datetime' }),
    campoEnv({ clave: 'PROMO_HASTA', etiqueta: 'Promo inauguración · fin (hora tienda)', tipo: 'datetime' }),
    campoEnv({ clave: 'PROMO_CUPO', etiqueta: 'Promo inauguración · cupo de tickets', ayuda: 'Vacío = sin tope.', tipo: 'entero' }),
    campoEnv({ clave: 'PROMO_META_INICIO', etiqueta: 'Promo meta · inicio (hora tienda)', tipo: 'datetime' }),
    campoEnv({ clave: 'PROMO_META_FIN', etiqueta: 'Promo meta · fin (hora tienda)', tipo: 'datetime' }),
    campoEnv({ clave: 'PROMO_META_VENCE', etiqueta: 'Promo meta · vencimiento del bono', tipo: 'datetime' }),
  );

  // 9. Etiquetera
  $('sec-etiquetera').replaceChildren(
    campoNumeroConfig({ clave: 'etiqueta_corrimiento', etiqueta: 'Corrimiento horizontal (puntos)', ayuda: 'De -200 a 200 puntos.', min: -200, max: 200 }),
    campoNumeroConfig({ clave: 'etiqueta_modulo', etiqueta: 'Ancho de barra Code 128 (puntos)', ayuda: 'De 2 a 8 puntos.', min: 2, max: 8 }),
  );

  // 10. Salud del Sistema
  const formatoAviso = (titulo, av) => av
    ? `<tr><td><b>${esc(titulo)}</b></td><td><span class="pill error">Aviso</span></td><td><code>${esc(av.en ?? '')}</code> · ${esc(av.mensaje ?? av.que ?? JSON.stringify(av))}</td></tr>`
    : `<tr><td><b>${esc(titulo)}</b></td><td><span class="pill ok">Sin errores</span></td><td>—</td></tr>`;
  const ef = salud.entorno_fijo;
  $('sec-salud').innerHTML = `
    <div class="malla" style="margin-bottom:14px">
      <div class="campo"><span class="etq">Portadas hoy (${esc(salud.hoy)})</span><b>${esc(salud.cuotas.portadas_hoy)} / ${esc(salud.cuotas.portadas_tope)}</b></div>
      <div class="campo"><span class="etq">Consultas UPCitemdb hoy</span><b>${esc(salud.cuotas.upcitemdb_hoy)} / ${esc(salud.cuotas.upcitemdb_tope)}</b></div>
      <div class="campo"><span class="etq">Cursor relleno imágenes</span><code>${esc(salud.cursores.imagenes_relleno_hasta || 'sin iniciar')}</code></div>
      <div class="campo"><span class="etq">Cursor ajuste recortes</span><code>${esc(salud.cursores.recortes_ajuste_hasta || 'sin iniciar')}</code></div>
      <div class="campo"><span class="etq">Versión bases legales</span><code>${esc(ef.bases_version || 'no configurada')}</code></div>
      <div class="campo"><span class="etq">Llaves IA presentes</span><span>Claude: ${ef.tiene_claude ? 'sí' : 'no'} · Vertex: ${ef.tiene_vertex ? 'sí' : 'no'} · AI Studio: ${ef.tiene_gemini ? 'sí' : 'no'}</span></div>
    </div>
    <div class="tabla-wrap">
      <table>
        <thead><tr><th>Servicio</th><th>Estado</th><th>Detalle</th></tr></thead>
        <tbody>
          ${formatoAviso('Gemini análisis', salud.avisos.gemini)}
          ${formatoAviso('Portadas IA', salud.avisos.portadas)}
          ${formatoAviso('Visitas Mercado Libre', salud.avisos.ml_visitas)}
        </tbody>
      </table>
    </div>
    <div class="enlaces-fila">
      <a class="btn-enlace" href="/cuentas">Cuentas y roles →</a>
      <a class="btn-enlace" href="/plano">Plano y letreros →</a>
      <a class="btn-enlace" href="/bandas">Familias de bandas →</a>
    </div>
    <p class="desc" style="margin:12px 0 0">Reglas fijas en código y bases legales (no editables en caliente): tasas de Dolarones (10 D / 5 D por $100), referidos (50 D / 25 D, topes 10/50), promo meta ($3,000 → 300 D), envío ($99 / gratis $1,000), comisión revendedoras (10 %) y secreto/hosts.</p>
  `;

  // 11. Historial
  const secHist = $('sec-historial');
  if (!historial_listo) {
    secHist.innerHTML = `<p class="desc">Aún no se ejecuta <code>migracion-092-cm-historial.sql</code> en esta base de datos; el historial se activará en cuanto se aplique.</p>`;
  } else if (!historial.length) {
    secHist.innerHTML = `<p class="desc">Todavía no hay cambios registrados en el historial.</p>`;
  } else {
    secHist.innerHTML = `<div class="tabla-wrap"><table>
      <thead><tr><th>Cuándo</th><th>Origen</th><th>Variable</th><th>Antes</th><th>Después</th><th>Quién</th></tr></thead>
      <tbody>${historial.map((h) => `<tr>
        <td>${esc(new Date(h.cambiado_en).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }))}</td>
        <td><code>${esc(h.origen)}</code></td>
        <td><code>${esc(h.clave)}</code></td>
        <td>${h.antes === null ? '<i>sin valor</i>' : `<code>${esc(h.antes)}</code>`}</td>
        <td>${h.despues === null ? '<i>heredado / borrado</i>' : `<code>${esc(h.despues)}</code>`}</td>
        <td>${esc(h.cambiado_por_nombre || h.cambiado_por)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  aplicarFiltroBusqueda();
  marcarSuciedad();
  actualizarRielActivo();
}

let seccionActivaId = '';
function actualizarRielActivo() {
  const secciones = [...document.querySelectorAll('section.panel[data-seccion]')].filter((s) => !s.hidden);
  if (secciones.length === 0) return;
  let elegida = secciones[0];
  const alFondo = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 24;
  if (alFondo) {
    elegida = secciones[secciones.length - 1];
  } else {
    for (const s of secciones) {
      if (s.getBoundingClientRect().top <= 120) elegida = s;
    }
  }
  const id = elegida.id;
  for (const a of document.querySelectorAll('#riel a')) {
    const es = a.getAttribute('href') === `#${id}`;
    a.classList.toggle('activo', es);
    if (es) a.setAttribute('aria-current', 'location');
    else a.removeAttribute('aria-current');
  }
  if (id !== seccionActivaId) {
    seccionActivaId = id;
    const riel = $('riel');
    const activo = riel.querySelector('a.activo');
    if (activo && riel.scrollWidth > riel.clientWidth) {
      const izq = activo.offsetLeft - (riel.clientWidth - activo.offsetWidth) / 2;
      riel.scrollTo({ left: Math.max(0, izq), behavior: 'smooth' });
    }
  }
}

let rafScroll = 0;
const programarRiel = () => {
  if (rafScroll) return;
  rafScroll = requestAnimationFrame(() => {
    rafScroll = 0;
    actualizarRielActivo();
  });
};
window.addEventListener('scroll', programarRiel, { passive: true });
window.addEventListener('resize', programarRiel, { passive: true });

function aplicarFiltroBusqueda() {
  const q = $('buscar').value;
  for (const seccion of document.querySelectorAll('section[data-seccion]')) {
    const campos = [...seccion.querySelectorAll('.campo[data-busqueda]')];
    if (campos.length === 0) {
      seccion.hidden = Boolean(q.trim()) && !coincideBusqueda(seccion.textContent, q);
      continue;
    }
    let visibles = 0;
    for (const c of campos) {
      const ok = coincideBusqueda(c.dataset.busqueda, q);
      c.hidden = !ok;
      if (ok) visibles += 1;
    }
    seccion.hidden = visibles === 0;
  }
  actualizarRielActivo();
}

$('buscar').addEventListener('input', aplicarFiltroBusqueda);

$('riel').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  for (const x of document.querySelectorAll('#riel a')) {
    const es = x === a;
    x.classList.toggle('activo', es);
    if (es) x.setAttribute('aria-current', 'location');
    else x.removeAttribute('aria-current');
  }
});

$('form-nueva-banda').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('nueva-banda-monto');
  const btn = $('btn-agregar-banda');
  const aviso = $('aviso-nueva-banda');
  const monto = Number(input.value.trim());
  if (!Number.isInteger(monto) || monto < 1 || monto > 999) {
    aviso.className = 'ayuda error';
    aviso.textContent = 'Escribe un entero entre $1 y $999 MXN.';
    return;
  }
  btn.disabled = true;
  aviso.className = 'ayuda';
  aviso.textContent = `Creando banda $${monto}…`;
  try {
    const r = await fetch('/api/cm/bandas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monto }),
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) {
      aviso.className = 'ayuda error';
      aviso.textContent = datos.error || 'No se pudo agregar la banda.';
      return;
    }
    const cambiosPrevios = armarPayloadCambios(inicial, actual);
    estadoServidor = datos;
    inicial = construirEstadoEditable(datos);
    actual = clonar(inicial);
    for (const seccion of ['config', 'nomina', 'env']) {
      if (cambiosPrevios[seccion]) Object.assign(actual[seccion], cambiosPrevios[seccion]);
    }
    pintarTodo();
    input.value = '';
    aviso.className = 'ayuda ok';
    aviso.textContent = `Banda $${datos.monto} agregada para ${datos.familias} familias. Ya está disponible en /bandas, /tarjeta-bandas y la caja.`;
  } catch {
    aviso.className = 'ayuda error';
    aviso.textContent = 'Error de red al agregar la banda. Reintenta.';
  } finally {
    btn.disabled = false;
  }
});

$('btn-descartar').addEventListener('click', () => {
  actual = clonar(inicial);
  $('mensaje-global').hidden = true;
  pintarTodo();
});

$('btn-guardar').addEventListener('click', async () => {
  const payload = armarPayloadCambios(inicial, actual);
  if (contarCambios(payload) === 0 || erroresValidacion.size > 0) return;

  // Normalizar nomina a enteros / booleano antes de enviar
  if (payload.nomina) {
    const n = {};
    for (const [k, v] of Object.entries(payload.nomina)) {
      n[k] = k === 'checador_activo' ? Boolean(v) : Number(v);
    }
    payload.nomina = n;
  }

  const btn = $('btn-guardar');
  const estado = $('estado-guardar');
  const toast = $('mensaje-global');
  btn.disabled = true;
  estado.className = 'estado-guardar';
  estado.textContent = 'Guardando…';

  try {
    const r = await fetch('/api/cm', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) {
      estado.className = 'estado-guardar error';
      estado.textContent = datos.error || 'No se pudieron guardar los cambios.';
      btn.disabled = false;
      return;
    }
    estadoServidor = datos;
    inicial = construirEstadoEditable(datos);
    actual = clonar(inicial);
    pintarTodo();
    toast.className = 'aviso-toast';
    toast.textContent = datos.guardados > 0
      ? `Guardado: ${datos.guardados} ${datos.guardados === 1 ? 'cambio aplicado' : 'cambios aplicados'}.`
      : 'Sin cambios nuevos que guardar.';
    toast.hidden = false;
  } catch {
    estado.className = 'estado-guardar error';
    estado.textContent = 'Error de red al guardar. Reintenta.';
    btn.disabled = false;
  }
});

async function iniciar() {
  const r = await fetch('/api/cm');
  if (!r.ok) {
    const datos = await r.json().catch(() => ({}));
    const toast = $('mensaje-global');
    toast.className = 'aviso-toast error';
    toast.textContent = datos.error || 'No se pudo cargar el Centro de Mando.';
    toast.hidden = false;
    return;
  }
  estadoServidor = await r.json();
  inicial = construirEstadoEditable(estadoServidor);
  actual = clonar(inicial);
  pintarTodo();
}

await iniciar();
