// PIN del cajero (Issue #112), para /caja y /socios. Script clasico en <head>:
// envuelve fetch antes de que la pantalla haga su primera llamada.
//
// Si la cuenta de Access es la de la computadora de caja, la pantalla se
// bloquea hasta que un cajero elige su nombre y escribe su PIN; cada llamada a
// /api/ lleva su token en `x-cajero`. Una hora sin tocar teclado ni pantalla
// (el lector de codigos cuenta como teclado) la vuelve a bloquear.
(() => {
  const LLAVE = 'cajero-en-turno';
  const ACTIVIDAD = 'cajero-actividad';   // compartida entre pestañas: usar /socios mantiene viva /caja
  const INACTIVIDAD = 60 * 60_000;        // Isaac, 28/09: una hora

  const leer = () => { try { return JSON.parse(localStorage.getItem(LLAVE)); } catch { return null; } };
  const guardar = (s) => { try { s ? localStorage.setItem(LLAVE, JSON.stringify(s)) : localStorage.removeItem(LLAVE); } catch { /* sin memoria */ } };
  const tocar = () => { try { localStorage.setItem(ACTIVIDAD, String(Date.now())); } catch { /* idem */ } };
  const ultima = () => { try { return Number(localStorage.getItem(ACTIVIDAD)) || Date.now(); } catch { return Date.now(); } };
  const escapar = (t) => String(t ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  let requiere = false;
  const original = window.fetch.bind(window);
  window.fetch = async (recurso, opciones = {}) => {
    const s = leer();
    if (s?.token && String(recurso).startsWith('/api/')) {
      const headers = new Headers(opciones.headers);
      headers.set('x-cajero', s.token);
      opciones = { ...opciones, headers };
    }
    const r = await original(recurso, opciones);
    if (r.status === 401 && (await r.clone().json().catch(() => ({}))).pin) { requiere = true; bloquear(); }
    return r;
  };

  let dialogo;
  function armar() {
    if (dialogo) return;
    const estilo = document.createElement('style');
    estilo.textContent = `
      #dialogo-cajero { border: 0; border-radius: 14px; padding: 18px 20px; width: min(520px, 94vw); }
      #dialogo-cajero::backdrop { background: #16366b; }
      #dialogo-cajero h2 { margin: 0 0 12px; color: #16366B; }
      #cajero-lista { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
      #cajero-lista button { padding: 18px 10px; font-size: 18px; font-weight: 700; border-radius: 12px; border: 2px solid #16366B;
        background: #fff; color: #16366B; cursor: pointer; }
      #cajero-pin { width: 100%; box-sizing: border-box; padding: 14px; font-size: 28px; letter-spacing: 8px; text-align: center;
        border: 1px solid #d5dbe5; border-radius: 10px; }
      #cajero-otro { margin-top: 10px; background: none; border: 0; color: #16366B; text-decoration: underline; cursor: pointer; font-size: 15px; }
      #cajero-aviso { min-height: 20px; color: #D72B32; margin-top: 8px; font-size: 15px; }
      .cajero-turno { border: 1px solid #FFD447; background: transparent; color: #FFD447; border-radius: 8px; padding: 5px 12px;
        font-size: 13px; cursor: pointer; }`;
    document.head.append(estilo);
    dialogo = document.createElement('dialog');
    dialogo.id = 'dialogo-cajero';
    dialogo.innerHTML = `<h2 id="cajero-titulo">¿Quién cobra?</h2>
      <div id="cajero-lista"></div>
      <form id="cajero-form" hidden>
        <input id="cajero-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" aria-label="PIN de 6 dígitos">
        <button type="button" id="cajero-otro">← Otro cajero</button>
      </form>
      <div id="cajero-aviso" role="alert"></div>`;
    dialogo.addEventListener('cancel', (e) => e.preventDefault());   // Esc no la quita
    document.body.append(dialogo);

    let elegido = null;
    const $ = (id) => dialogo.querySelector(`#${id}`);
    const lista = () => {
      elegido = null;
      $('cajero-titulo').textContent = '¿Quién cobra?';
      $('cajero-form').hidden = true;
      $('cajero-lista').hidden = false;
    };
    $('cajero-otro').addEventListener('click', lista);
    $('cajero-lista').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-correo]');
      if (!b) return;
      elegido = b.dataset.correo;
      $('cajero-titulo').textContent = `${b.textContent}: tu PIN`;
      $('cajero-lista').hidden = true;
      $('cajero-form').hidden = false;
      $('cajero-aviso').textContent = '';
      $('cajero-pin').value = '';
      $('cajero-pin').focus();
    });
    // Al sexto digito entra solo: nada de buscar el boton.
    $('cajero-pin').addEventListener('input', async () => {
      const pin = $('cajero-pin').value.replace(/\D/g, '');
      $('cajero-pin').value = pin;
      if (pin.length !== 6 || !elegido) return;
      $('cajero-pin').disabled = true;
      try {
        const r = await original('/api/cajeros/entrar', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ correo: elegido, pin }),
        });
        const datos = await r.json();
        if (!r.ok) throw new Error(datos.error);
        guardar(datos);
        tocar();
        location.reload();   // la pantalla arranca de cero a nombre de quien entro (su caja, sus datos)
      } catch (error) {
        $('cajero-aviso').textContent = error.message || 'Sin conexión.';
        $('cajero-pin').value = '';
      } finally {
        $('cajero-pin').disabled = false;
        $('cajero-pin').focus();
      }
    });
    dialogo.mostrarLista = async () => {
      lista();
      $('cajero-aviso').textContent = '';
      try {
        const cajeros = await (await original('/api/cajeros')).json();
        $('cajero-lista').innerHTML = cajeros.length
          ? cajeros.map((c) => `<button type="button" data-correo="${escapar(c.correo)}">${escapar(c.nombre || c.correo)}</button>`).join('')
          : '<p>Nadie tiene PIN todavía. El dueño lo pone en Cuentas.</p>';
      } catch {
        $('cajero-aviso').textContent = 'Sin conexión: no se puede entrar.';
      }
    };
  }

  function bloquear() {
    guardar(null);
    armar();
    if (!dialogo.open) { dialogo.showModal(); dialogo.mostrarLista(); }
  }

  async function salir() {
    const s = leer();
    if (s?.token) original('/api/cajeros/salir', { method: 'POST', headers: { 'x-cajero': s.token } }).catch(() => {});
    bloquear();
  }

  const listo = document.readyState === 'loading'
    ? new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }))
    : Promise.resolve();

  Promise.all([window.fetch('/api/yo').then((r) => r.json()), listo]).then(([{ usuario, cajero }]) => {
    const roles = usuario?.roles ?? [];
    requiere = roles.includes('computadora') && !roles.includes('cajero') && !roles.includes('dueno');
    if (!requiere) return;
    if (!cajero) return bloquear();
    guardar({ ...leer(), ...cajero });
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'cajero-turno';
    boton.textContent = `${cajero.nombre} · Cambiar cajero`;
    boton.addEventListener('click', salir);
    document.querySelector('header')?.append(boton);
  }).catch(() => { /* sin red: sigue quien estaba; al volver la red, un 401 bloquea */ });

  for (const evento of ['keydown', 'pointerdown']) addEventListener(evento, tocar, true);
  tocar();
  setInterval(() => { if (requiere && leer() && Date.now() - ultima() > INACTIVIDAD) salir(); }, 60_000);
})();
