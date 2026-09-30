import { svgCode128 } from './code128.js';

const $ = (id) => document.getElementById(id);
const d = (c) => (c / 100).toLocaleString('es-MX', { maximumFractionDigits:2 }) + ' D';
const pesos = (c) => (c / 100).toLocaleString('es-MX', { style:'currency', currency:'MXN' });
const fecha = (iso) => new Date(iso).toLocaleDateString('es-MX', { timeZone:'America/Mexico_City' });
let auth, sdk, config, confirmacion, verificador, siguiente = null, venceCodigo = 0, reenviarDesde = 0;

function estado(mensaje = '', error = false) {
  $('estado').textContent = mensaje;
  $('estado').classList.toggle('error', error);
}
async function api(ruta, body, method = body === undefined ? 'GET' : 'POST') {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Vuelve a iniciar sesión.');
  const r = await fetch('/api/portal/' + ruta, { method,
    headers:{ authorization:'Bearer ' + token, 'content-type':'application/json' },
    body:body === undefined ? undefined : JSON.stringify(body), cache:'no-store' });
  const datos = await r.json();
  if (!r.ok) throw Object.assign(new Error(datos.error || 'No se pudo completar. Intenta de nuevo.'), { status:r.status });
  return datos;
}
function ocultarCodigo() {
  venceCodigo = 0;
  $('codigo-panel').hidden = true;
  $('barcode').replaceChildren();
  $('codigo-legible').textContent = '';
}
function errorDeAuth(error) {
  return ({
    'auth/invalid-verification-code':'El código SMS no coincide. Revísalo e intenta otra vez.',
    'auth/code-expired':'El código SMS venció. Solicita otro.',
    'auth/too-many-requests':'Se hicieron demasiados intentos. Espera unos minutos antes de reintentar.',
    'auth/quota-exceeded':'No se pueden enviar códigos en este momento. Intenta más tarde.',
    'auth/invalid-phone-number':'Escribe un número mexicano de 10 dígitos.',
    'auth/captcha-check-failed':'Repite la verificación de seguridad.',
    'auth/network-request-failed':'No hay conexión. Revisa tu red e intenta otra vez.',
  })[error.code] || error.message || 'No se pudo entrar. Intenta de nuevo.';
}
async function cargarCuenta() {
  const uid = auth.currentUser?.uid;
  ocultarCodigo();
  $('recibos').replaceChildren();
  siguiente = null;
  try {
    const yo = await api('yo');
    if (!uid || uid !== auth.currentUser?.uid) return;
    $('acceso').hidden = true;
    $('registro').hidden = true;
    $('monedero').hidden = true;
    $('salir').hidden = false;
    if (yo.bases_version !== config.bases_version) {
      $('registro').hidden = false;
      $('nombre').value = yo.nombre;
      $('registrar').textContent = 'Aceptar bases vigentes';
      estado('Lee y acepta las bases vigentes para continuar.');
      return;
    }
    $('titular').textContent = yo.nombre;
    $('numero').textContent = '#' + yo.numero;
    await actualizarSaldo();
    await recibos();
    if (uid !== auth.currentUser?.uid) return;
    $('monedero').hidden = false;
    estado();
  } catch (e) {
    if (!uid || uid !== auth.currentUser?.uid) return;
    $('monedero').hidden = true;
    $('registro').hidden = e.status !== 404 || !config.registro_abierto;
    $('acceso').hidden = true;
    $('salir').hidden = false;
    estado(e.status === 404 ? (config.registro_abierto ? 'Completa tu membresía para continuar.' : 'Las nuevas membresías todavía no están abiertas.') : errorDeAuth(e), e.status !== 404);
  }
}
async function actualizarSaldo() {
  const s = await api('saldo');
  $('saldo').textContent = d(s.disponible_total);
  $('saldo-compras').textContent = d(s.disponible_compras);
  $('saldo-regalo').textContent = d(s.regalo_sujeto_minimo);
  $('saldo-pendiente').textContent = d(s.por_liberar);
  $('importe').max = String(s.disponible_total / 100);
  $('minimo').hidden = !s.regalo_sujeto_minimo;
  $('vencimientos').replaceChildren(...s.lotes.map((l) => {
    const li = document.createElement('li');
    li.textContent = d(l.restante) + (l.origen === 'regalo' ? ' de apertura' : ' por compras') +
      ' · vence ' + fecha(l.vence_en) + (Date.parse(l.disponible_desde) > Date.now() ? ' · disponible desde ' + fecha(l.disponible_desde) : '');
    return li;
  }));
  if (!s.lotes.length) $('vencimientos').textContent = 'Aún no tienes saldo vigente.';
}
async function recibos() {
  const pagina = await api('recibos?limit=10' + (siguiente ? '&cursor=' + encodeURIComponent(siguiente) : ''));
  if (!siguiente) $('recibos').replaceChildren();
  for (const r of pagina.recibos) {
    const boton = document.createElement('button');
    boton.type = 'button';
    const dia = document.createElement('span'), monto = document.createElement('strong');
    dia.textContent = fecha(r.creado_en) + (r.cancelada ? ' · cancelada' : '');
    monto.textContent = pesos(r.total);
    boton.append(dia, monto);
    boton.addEventListener('click', () => abrirRecibo(r.id));
    $('recibos').append(boton);
  }
  if (!$('recibos').childElementCount) $('recibos').textContent = 'Aquí aparecerán tus compras identificadas en caja.';
  siguiente = pagina.siguiente;
  $('mas-recibos').hidden = !siguiente;
}
async function abrirRecibo(id) {
  const uid = auth.currentUser?.uid;
  try {
    const r = await api('recibos/' + encodeURIComponent(id));
    if (!uid || uid !== auth.currentUser?.uid) return;
    const textos = [fecha(r.creado_en) + (r.cancelada ? ' · Compra cancelada' : ''),
      ...r.lineas.map((l) => l.nombre + ' × ' + l.cantidad + ' · ' + pesos(l.precio * l.cantidad)),
      'Total: ' + pesos(r.total), 'Dolarones usados: ' + d(r.d_usados),
      'Pagado en dinero: ' + pesos(r.pago_monetario), 'Forma de pago: ' + r.forma_pago,
      'Dolarones ganados: ' + d(r.d_ganados) + (r.cancelada ? ' (cancelados)' : '')];
    $('detalle-recibo').replaceChildren(...textos.map((texto) => {
      const p = document.createElement('p'); p.textContent = texto; return p;
    }));
    $('recibo-dialogo').showModal();
  } catch (e) { estado(errorDeAuth(e), true); }
}
async function accion(boton, trabajo) {
  boton.disabled = true; estado('Procesando…');
  try { await trabajo(); } catch (e) { estado(errorDeAuth(e), true); }
  finally { boton.disabled = false; }
}
$('telefono-form').addEventListener('submit', (e) => {
  e.preventDefault();
  accion($('enviar'), async () => {
    if (Date.now() < reenviarDesde) throw new Error('Espera un minuto antes de pedir otro SMS.');
    await sdk.setPersistence(auth, $('recordar').checked ? sdk.browserLocalPersistence : sdk.browserSessionPersistence);
    verificador?.clear();
    verificador = new sdk.RecaptchaVerifier(auth, 'recaptcha', { size:'normal' });
    confirmacion = await sdk.signInWithPhoneNumber(auth, '+52' + $('telefono').value.trim(), verificador);
    reenviarDesde = Date.now() + 60_000;
    $('destino-sms').textContent = 'Enviamos un código al +52 ' + $('telefono').value.trim();
    $('telefono-form').hidden = true; $('sms-form').hidden = false; $('sms').focus();
    estado('Revisa tus mensajes de texto.');
  });
});
$('sms-form').addEventListener('submit', (e) => {
  e.preventDefault();
  accion($('verificar'), async () => {
    await confirmacion.confirm($('sms').value.trim());
    $('sms').value = '';
  });
});
$('cambiar-telefono').addEventListener('click', () => {
  confirmacion = null; $('sms').value = '';
  $('sms-form').hidden = true; $('telefono-form').hidden = false; $('telefono').focus();
  estado('Revisa el número. El reenvío estará disponible un minuto después del último SMS.');
});
$('registro-form').addEventListener('submit', (e) => {
  e.preventDefault();
  accion($('registrar'), async () => {
    await api('registro', { nombre:$('nombre').value, acepta_bases:$('acepta').checked, bases_version:config.bases_version });
    await cargarCuenta();
  });
});
$('codigo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  accion($('mostrar-codigo'), async () => {
    const uid = auth.currentUser?.uid;
    ocultarCodigo();
    const r = await api('codigo', { maximo:Math.round(Number($('importe').value) * 100) });
    if (!uid || uid !== auth.currentUser?.uid) return;
    if (!/^DC-[A-Za-z0-9_-]{16}$/.test(r.codigo)) throw new Error('No se pudo generar el código. Intenta otra vez.');
    $('barcode').innerHTML = svgCode128(r.codigo, { alto:24 });
    $('codigo-legible').textContent = r.codigo;
    $('codigo-importe').textContent = r.maximo ? 'Autorizaste hasta ' + d(r.maximo) + ' para esta compra.' : 'Sólo acumular Dolarones.';
    venceCodigo = Math.min(Date.parse(r.expira_en), Date.now() + 5 * 60_000);
    $('codigo-panel').hidden = false; cuentaRegresiva(); estado('Muestra tu código en caja.');
  });
});
function cuentaRegresiva() {
  if (!venceCodigo) return;
  const segundos = Math.ceil((venceCodigo - Date.now()) / 1000);
  if (segundos <= 0) { ocultarCodigo(); estado('Tu código venció. Genera uno nuevo.'); return; }
  $('codigo-tiempo').textContent = 'Vence en ' + Math.floor(segundos / 60) + ':' + String(segundos % 60).padStart(2, '0');
}
setInterval(cuentaRegresiva, 1000);
$('actualizar').addEventListener('click', () => accion($('actualizar'), cargarCuenta));
$('mas-recibos').addEventListener('click', () => accion($('mas-recibos'), async () => { await recibos(); estado(); }));
$('pedir-vinculo').addEventListener('click', () => accion($('pedir-vinculo'), async () => {
  const r = await api('vinculo', {});
  $('codigo-vinculo').textContent = r.codigo;
  $('vinculo').hidden = false;
  estado('El código de vinculación vence en 5 minutos. No autoriza gastos.');
}));
$('revisar-vinculo').addEventListener('click', () => accion($('revisar-vinculo'), cargarCuenta));
$('salir').addEventListener('click', () => accion($('salir'), async () => {
  try { await api('codigo', undefined, 'DELETE'); } catch { /* El código también vence en 5 minutos. */ }
  await sdk.signOut(auth);
}));

try {
  const r = await fetch('/api/portal/config', { cache:'no-store' });
  if (!r.ok) throw new Error('El monedero no está disponible. Intenta más tarde.');
  config = await r.json();
  $('texto-bases').textContent = config.bases;
  $('texto-aviso').textContent = config.aviso;
  $('legal').hidden = !config.bases || !config.aviso;
  if (!config.firebase) throw new Error('Estamos preparando tu monedero. El acceso aún no está disponible.');
  const app = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js');
  sdk = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js');
  auth = sdk.getAuth(app.initializeApp(config.firebase));
  auth.languageCode = 'es';
  sdk.onAuthStateChanged(auth, (user) => {
    ocultarCodigo();
    if (user) { cargarCuenta(); return; }
    $('monedero').hidden = true; $('registro').hidden = true; $('salir').hidden = true;
    $('acceso').hidden = false; $('telefono-form').hidden = false; $('sms-form').hidden = true;
    $('titular').textContent = ''; $('recibos').replaceChildren(); $('vinculo').hidden = true;
    $('recibo-dialogo').close(); $('detalle-recibo').replaceChildren();
    estado();
  });
} catch (e) { estado(errorDeAuth(e), true); }
