/* Todo es práctica: no hay llamadas de red ni WhatsApp. Los textos, chips y fechas salen de vender.js, el mismo código de la app. */
let V = null;
try { V = await import('/vender.js'); } catch { V = null; }

const H = 3_600_000, AHORA = Date.now();
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const PIEZAS = {
  a: { id: 'a', codigo: 'ED-009001', nombre: 'Blusa de algodón floral', talla: 'M', precio: 20000, emoji: '👚', tono: '#f7d6e0' },
  b: { id: 'b', codigo: 'ED-009002', nombre: 'Bolsa tejida color café', precio: 15000, emoji: '👜', tono: '#efe0c9' },
  c: { id: 'c', codigo: 'ED-009003', nombre: 'Playera deportiva azul', talla: 'L', precio: 12000, emoji: '👕', tono: '#d6e4f7' },
};
const CLIENTE = 'Ana Ejemplo';
// Ventas de ejemplo: `horas` es lo que falta para que venza (se usa 30.5 y 3.5 para que el redondeo no cambie en segundos).
const VENTAS = /*ventas*/[
  { folio: 9001, cliente: 'Carla Ejemplo', pieza: 'a', estado: 'apartado', horas: 30.5, entrega: 'tienda' },
  { folio: 9002, cliente: 'Berta Ejemplo', pieza: 'b', estado: 'apartado', horas: 3.5, entrega: 'envio' },
  { folio: 9003, cliente: 'Diana Ejemplo', pieza: 'c', estado: 'vendido', horas: 0, entrega: 'tienda' },
  { folio: 9004, cliente: 'Elena Ejemplo', pieza: 'a', estado: 'cancelado', horas: 0, entrega: 'tienda' },
]/*fin-ventas*/;
const pedido = (v) => {
  const p = PIEZAS[v.pieza];
  return { folio: v.folio, cliente: v.cliente, estado: v.estado, saldo: 0, entrega: v.entrega, subtotal: p.precio, envio: v.entrega === 'envio' ? 9900 : 0,
    vence_en: new Date(AHORA + v.horas * H).toISOString(), lineas: [{ nombre: p.nombre, codigo: p.codigo }] };
};

/* ---------- piezas de la réplica ---------- */
const foto = (p) => `<div class="foto" role="img" aria-label="${esc(p.nombre)}" style="background:${p.tono}">${p.emoji}</div>`;
const nav = (activa = 'piezas') => `<nav aria-label="Vista de ventas">
  <button type="button" aria-pressed="${activa === 'piezas'}"><span class="ico" aria-hidden="true">🛍️</span><span data-etiqueta="Piezas">Piezas</span></button>
  <button type="button" aria-pressed="${activa === 'mias'}" data-acc="mias"><span class="ico" aria-hidden="true">💵</span><span data-etiqueta="Mis ventas">Mis ventas</span></button>
  <button type="button" aria-pressed="false"><span class="ico" aria-hidden="true">💬</span><span data-etiqueta="Preguntaron">Preguntaron</span></button>
</nav>`;
function pieza(p, { botones = true, marca = '', check = '' } = {}) {
  return `<article class="pieza">${foto(p)}<div class="detalle">
    <h2>${esc(p.nombre)}</h2><div class="precio">${V.pesos(p.precio)}</div><div class="codigo">${p.codigo}</div>
    ${p.talla ? `<div class="nota">Talla ${p.talla}</div>` : ''}${marca}${check}
    ${botones ? `<button type="button" class="principal" data-acc="compartir" data-etiqueta="Compartir">Compartir</button>
    <button type="button" data-acc="vendi" data-etiqueta="Ya la vendí">Ya la vendí</button>
    <button type="button" class="texto" data-etiqueta="Anotar a un cliente">Anotar a un cliente</button>` : ''}</div></article>`;
}
const elegir = (p, marcado) => `<label class="check resaltable"><input type="checkbox" data-acc="elegir" data-id="${p.id}" aria-label="Elegir ${esc(p.nombre)} ${p.codigo}"${marcado ? ' checked' : ''}><span data-etiqueta="Elegir">Elegir</span></label>`;
// Después de apartar la pieza A, la lista sigue con las otras de ejemplo (nunca queda vacía).
const otras = () => pieza(PIEZAS.b) + pieza(PIEZAS.c);
const resultado = (html, error = false, boton = '') => `<div class="resultado${error ? ' error' : ''}" role="status"><p>${error ? '⚠ ' : ''}${html}</p>${boton}</div>`;
const etiqueta = (t) => `<span data-etiqueta="${t}">${t}</span>`;
const cuerpo = (base, dialogo = '') => `<div class="base${dialogo ? ' atenuada' : ''}">${base}</div>${dialogo}`;
const bandaEstado = (hora = AHORA) => `<div class="fila barra"><p class="aviso estado"><span data-etiqueta="Actualizado a las">Actualizado a las</span> ${V.horaLegible(hora)}</p><button type="button" data-acc="actualizar" data-etiqueta="Actualizar">Actualizar</button></div>`;
const mensajeEn = (texto) => `<p class="chat-etq">Así lo recibe tu cliente en WhatsApp:</p><div class="chat">${esc(texto)}</div>`;

function tarjetaMia(p, { chip = false, abrir = '', acciones = '' } = {}) {
  const e = V.estadoMia(p, Date.now());
  const marca = chip ? `<button type="button" class="chip ${e.clase}" data-acc="chip" data-clase="${e.clase}">${esc(e.texto)}</button>` : `<span class="chip ${e.clase}">${esc(e.texto)}</span>`;
  return `<article class="mia"><h3>${esc(p.cliente)}</h3><p>${esc(p.lineas.map((l) => l.nombre).join(', '))} · ${V.pesos(p.subtotal + p.envio)}</p>
    <div>${marca}</div>${abrir === e.clase ? `<p class="significa">${SIGNIFICA[e.clase]}</p>` : ''}
    <p class="nota">${p.entrega === 'envio' ? '<span data-etiqueta="Envío a su casa">Envío a su casa</span>' : '<span data-etiqueta="Recoge en la tienda">Recoge en la tienda</span>'}</p>
    <p class="nota">Folio P-${p.folio} · ${p.lineas.map((l) => l.codigo).join(', ')}</p>${acciones}</article>`;
}
const SIGNIFICA = {
  aviso: 'Esperando pago: tu cliente aún no paga en la tienda. Tiene esas horas. Avísale.',
  alerta: 'Se vence pronto: quedan pocas horas. Avísale hoy. Si no paga, la pieza vuelve a la venta.',
  ok: 'Cobrada: la tienda ya recibió el pago de tu cliente.',
  cerrada: 'Cerrada: ya no se cobra. La pieza volvió a la venta.',
};

/* ---------- las tarjetas con práctica ---------- */
const DEFS = {
  compartir: {
    pasos: [
      { acc: 'compartir', texto: 'Toca «Compartir» en la pieza.' },
      { acc: 'enviar', texto: 'Espera la foto. Luego toca «Enviar por WhatsApp».' },
      { acc: 'chat', texto: 'Elige a quién se la mandas. Tú eliges el grupo o el cliente.' },
    ],
    fin: '¡Listo! Tu cliente recibe la foto con precio y código. Toca «Volver».',
    inicio: () => ({ dlg: null, lista: false, compartida: false }),
    final: () => ({ dlg: null, lista: true, compartida: true }),
    vista(est) {
      const p = PIEZAS.a, marca = est.compartida ? '<div><span class="chip ok" data-etiqueta="✓ Ya la compartiste">✓ Ya la compartiste</span></div>' : '';
      const base = nav() + pieza(p, { marca });
      if (est.dlg === 'hoja') return cuerpo(base, `<dialog open class="hoja" aria-labelledby="t-hoja"><h2 id="t-hoja" tabindex="-1">Compartir con...</h2>
        <p class="nota">Así se ve el menú del teléfono. En el tuyo salen tus chats.</p>
        <button type="button" data-acc="chat">💬 Grupo de ejemplo</button><button type="button" data-acc="chat">💬 Cliente Ejemplo</button></dialog>`);
      if (est.dlg !== 'compartir') return cuerpo(base);
      return cuerpo(base, `<dialog open aria-labelledby="t-comp"><h2 id="t-comp" tabindex="-1" data-etiqueta="Compartir en WhatsApp">Compartir en WhatsApp</h2>
        <div class="vista-previa"><div class="tarj">${foto(p)}<div class="banda">${esc(p.nombre)}<b>${V.pesos(p.precio)}</b>${p.codigo}</div></div></div>
        <p class="aviso" role="status">${est.compartida ? '<span data-etiqueta="✓ Listo. Compartiste">✓ Listo. Compartiste</span> 1 pieza.'
          : est.lista ? '<span data-etiqueta="Fotos listas.">Fotos listas.</span> Revisa precio y código antes de enviar.' : '<span data-etiqueta="Preparando foto">Preparando foto</span> 1 de 1…'}</p>
        <div class="acciones columna"><button type="button" class="principal" data-acc="enviar" data-etiqueta="Enviar por WhatsApp"${est.lista && !est.compartida ? '' : ' disabled'}>Enviar por WhatsApp</button>
        <button type="button" class="texto" data-acc="volver" data-etiqueta="Volver">Volver</button></div>
        <details><summary data-etiqueta="¿No se abrió WhatsApp?">¿No se abrió WhatsApp?</summary>
          <label for="txt-wa" data-etiqueta="Texto para WhatsApp">Texto para WhatsApp</label><textarea id="txt-wa" rows="6" readonly>${esc(V.textoWhatsApp([p], true))}</textarea>
          <p class="nota" data-etiqueta="El texto se copia antes de compartir. Si WhatsApp no lo incluye, pégalo. Tú eliges el grupo y envías.">El texto se copia antes de compartir. Si WhatsApp no lo incluye, pégalo. Tú eliges el grupo y envías.</p>
          <div class="acciones columna"><button type="button" data-etiqueta="Guardar las fotos y abrir WhatsApp">Guardar las fotos y abrir WhatsApp</button><button type="button" data-etiqueta="Abrir WhatsApp">Abrir WhatsApp</button></div>
        </details></dialog>`);
    },
    al: {
      compartir(est, el, esperar) {
        Object.assign(est, { dlg: 'compartir', lista: false, compartida: false });
        esperar(1000, (e) => { if (e.dlg === 'compartir') e.lista = true; });
      },
      enviar(est) { est.dlg = 'hoja'; },
      chat(est) { Object.assign(est, { dlg: 'compartir', compartida: true, lista: true }); },
      volver(est) { est.dlg = null; },
    },
  },

  varias: {
    pasos: [
      { acc: 'elegir', sel: ':not(:checked)', texto: 'Toca «Elegir» en la primera pieza.' },
      { acc: 'elegir', sel: ':not(:checked)', texto: 'Elige la segunda pieza.' },
      { acc: 'elegir', sel: ':not(:checked)', texto: 'Elige la tercera. Abajo sale cuántas llevas.' },
    ],
    fin: 'Listo: llevas 3 piezas. Abajo dice «Compartir 3 en WhatsApp». Para empezar de nuevo toca «Quitar elegidas».',
    inicio: () => ({ sel: {} }),
    final: () => ({ sel: { a: true, b: true, c: true } }),
    vista(est) {
      const n = Object.values(est.sel).filter(Boolean).length;
      return cuerpo(nav() + Object.values(PIEZAS).map((p) => pieza(p, { botones: false, check: elegir(p, est.sel[p.id]) })).join('')
        + (n ? `<div class="pie"><button type="button" class="principal"><span data-etiqueta="Compartir">Compartir</span> ${n} en WhatsApp</button><button type="button" class="texto" data-acc="quitar" data-etiqueta="Quitar elegidas">Quitar elegidas</button></div>` : '')
        + '<p class="nota" data-etiqueta="Máximo 10 piezas a la vez.">Máximo 10 piezas a la vez.</p>');
    },
    al: {
      elegir(est, el) { est.sel[el.dataset.id] = el.checked; return el.checked; },
      quitar(est) { est.sel = {}; },
    },
  },

  buscar: {
    pasos: [
      { acc: 'ejemplo', texto: 'Toca «Escribir el ejemplo». Así pegas lo que escribió tu cliente.' },
      { acc: 'buscar', texto: 'Toca «Buscar la pieza». Sale la pieza con su código.' },
    ],
    fin: 'Ya salió la pieza, con sus botones. En la tarjeta 5 la apartas con «Ya la vendí».',
    inicio: () => ({ texto: '', hallada: null, aviso: null }),
    final: () => ({ texto: 'la quiero ED-009001', hallada: 'a', aviso: null }),
    vista(est) {
      const base = (est.aviso ? resultado(etiqueta(est.aviso), true) : '') + nav()
        + '<p class="chat-etq">Tu cliente te escribió por WhatsApp:</p><div class="chat">Hola, la quiero ED-009001</div>'
        + `<details class="panel" open><summary data-etiqueta="Me escribieron con un código">Me escribieron con un código</summary>
          <form data-acc="buscar"><label for="codigo" data-etiqueta="Pega aquí el mensaje de tu cliente">Pega aquí el mensaje de tu cliente</label>
          <div class="fila"><input id="codigo" name="texto" maxlength="160" autocomplete="off" placeholder="Ejemplo: la quiero ED-002335" value="${esc(est.texto)}"><button class="principal" type="submit" data-etiqueta="Buscar la pieza">Buscar la pieza</button></div></form>
          <button type="button" class="ayuda-practica" data-acc="ejemplo">Escribir el ejemplo</button><p class="nota">Solo práctica: aquí no se puede pegar de verdad.</p></details>`
        + (est.hallada ? pieza(PIEZAS[est.hallada]) : '');
      return cuerpo(base);
    },
    al: {
      ejemplo(est) { est.texto = 'la quiero ED-009001'; est.aviso = null; },
      buscar(est) {
        const codigo = V.codigoDeRespuesta(est.texto);
        est.hallada = null;
        if (!codigo) { est.aviso = 'Pega el mensaje de tu cliente. Debe traer el código, por ejemplo ED-002335.'; return false; }
        const p = Object.values(PIEZAS).find((x) => x.codigo === codigo);
        if (!p) { est.aviso = 'Esa pieza ya no está disponible. Puede que otra persona la apartó.'; return false; }
        est.aviso = null; est.hallada = p.id;
      },
    },
  },

  vendi: {
    pasos: [
      { acc: 'vendi', texto: 'Toca «Ya la vendí» en la pieza.' },
      { acc: 'llenar', texto: 'Escribe quién la compró y su WhatsApp. Aquí toca «Llenar con ejemplo».' },
      { acc: 'guardar', texto: 'Toca «Guardar venta».' },
    ],
    fin: '¡Venta guardada! La pieza ya no sale en la lista. Sigue con la tarjeta 6: avisarle a tu cliente.',
    inicio: () => ({ dlg: false, cliente: '', tel: '', entrega: 'tienda', err: '', guardada: false }),
    final: () => ({ dlg: true, cliente: CLIENTE, tel: '444 123 4567', entrega: 'tienda', err: '', guardada: false }),
    vista(est) {
      const p = PIEZAS.a;
      if (est.guardada) return cuerpo(nav() + otras());
      const base = nav() + pieza(p);
      if (!est.dlg) return cuerpo(base);
      return cuerpo(base, `<dialog open aria-labelledby="t-vendi"><h2 id="t-vendi" tabindex="-1" data-etiqueta="Ya la vendí">Ya la vendí</h2><p class="grande">${p.codigo} · ${esc(p.nombre)} · ${V.pesos(p.precio)}</p>
        <form data-acc="guardar">
          <label for="v-cliente" data-etiqueta="¿Quién la compró?">¿Quién la compró?</label><input id="v-cliente" name="cliente" maxlength="80" required autocomplete="off" value="${esc(est.cliente)}">
          <label for="v-tel" data-etiqueta="WhatsApp de quien la compró">WhatsApp de quien la compró</label><input id="v-tel" name="tel" type="tel" inputmode="tel" maxlength="24" required autocomplete="off" value="${esc(est.tel)}">
          <p class="nota" data-etiqueta="10 números. Ejemplo: 444 123 4567">10 números. Ejemplo: 444 123 4567</p>
          <label for="v-entrega" data-etiqueta="¿Cómo la recibe?">¿Cómo la recibe?</label>
          <select id="v-entrega" name="entrega" data-render="1"><option value="tienda"${est.entrega === 'tienda' ? ' selected' : ''}>La recoge en la tienda</option><option value="envio"${est.entrega === 'envio' ? ' selected' : ''}>Se la mandan a su casa (envío)</option></select>
          ${est.entrega === 'envio' ? '<p class="nota"><strong data-etiqueta="Envío $99. Gratis si compra $1,000 o más en piezas.">Envío $99. Gratis si compra $1,000 o más en piezas.</strong></p>' : ''}
          <button type="button" class="ayuda-practica" data-acc="llenar">Llenar con ejemplo</button>
          <ul class="reglas"><li>La pieza queda apartada 48 horas.</li><li>Quien la compró paga en la tienda.</li><li>Si no paga a tiempo, la pieza vuelve a la venta.</li></ul>
          <p class="aviso error" role="status">${est.err ? `<span data-etiqueta="Escribe los 10 números del WhatsApp de quien la compró.">${esc(est.err)}</span>` : ''}</p>
          <div class="acciones"><button class="principal" type="submit" data-etiqueta="Guardar venta">Guardar venta</button><button type="button" data-acc="volver" data-etiqueta="Volver">Volver</button></div>
        </form></dialog>`);
    },
    al: {
      vendi(est) { est.dlg = true; est.err = ''; },
      llenar(est) { Object.assign(est, { cliente: CLIENTE, tel: '444 123 4567', err: '' }); },
      guardar(est) {
        if (!V.telefonoInteresado(est.tel)) { est.err = 'Escribe los 10 números del WhatsApp de quien la compró.'; return false; }
        Object.assign(est, { dlg: false, guardada: true, err: '' });
      },
      volver(est) { est.dlg = false; },
    },
  },

  avisar: {
    pasos: [
      { acc: 'avisar', texto: 'Toca el botón azul «Avisarle a… por WhatsApp» para avisarle a tu cliente.' },
    ],
    fin: 'Listo: así le llega tu aviso. Si no paga en 48 horas, la pieza vuelve a la venta sola. Luego toca «Seguir con otras piezas».',
    inicio: () => ({ dlg: true, aviso: false }),
    final: () => ({ dlg: true, aviso: true }),
    vista(est) {
      const p = PIEZAS.a, vence = new Date(AHORA + 48 * H).toISOString();
      const base = nav() + otras();
      if (!est.dlg) return cuerpo(base);
      return cuerpo('', `<dialog open aria-labelledby="titulo-listo"><div class="listo-icono" aria-hidden="true">✓</div>
        <h2 id="titulo-listo" tabindex="-1" data-etiqueta="¡Venta guardada!">¡Venta guardada!</h2>
        <p class="grande">${p.codigo} · ${esc(p.nombre)} para ${CLIENTE}.</p>
        <p class="grande"><strong><span data-etiqueta="Tienes hasta el">Tienes hasta el</span> ${V.fechaLegible(vence)} para que pague.</strong></p>
        <p class="nota" data-etiqueta="El pago se hace en la tienda. Si no paga a tiempo, la pieza vuelve a la venta.">El pago se hace en la tienda. Si no paga a tiempo, la pieza vuelve a la venta.</p>
        <div class="acciones columna"><button type="button" class="principal" data-acc="avisar"><span><span data-etiqueta="Avisarle a">Avisarle a</span> ${CLIENTE} por WhatsApp</span></button>
        <button type="button" data-acc="seguir" data-etiqueta="Seguir con otras piezas">Seguir con otras piezas</button></div>
        ${est.aviso ? mensajeEn(V.textoAvisoCliente(p, CLIENTE, vence)) + '<p class="nota">En la app de verdad se abre WhatsApp con este mensaje. Tú solo lo envías.</p>' : ''}</dialog>`);
    },
    al: {
      avisar(est) { est.aviso = true; },
      seguir(est) { est.dlg = false; },
    },
  },

  'mis-ventas': {
    pasos: [
      { acc: 'mias', texto: 'Toca «Mis ventas».' },
      { acc: 'chip', sel: '[data-clase="alerta"]', texto: '¿Cuál se vence primero? Toca la roja que dice «Se vence pronto».' },
      { acc: 'chip', sel: '[data-clase="ok"]', texto: '¿Cuál ya pagó? Toca la verde que dice «Cobrada».' },
    ],
    fin: '¡Muy bien! Roja: avísale hoy. Verde: la tienda ya cobró. Toca «Actualizar» para ver cambios.',
    inicio: () => ({ vista: 'piezas', abierto: '', hora: AHORA }),
    final: () => ({ vista: 'mias', abierto: 'alerta', hora: AHORA }),
    vista(est) {
      if (est.vista !== 'mias') return cuerpo(nav() + pieza(PIEZAS.a));
      const pedidos = VENTAS.map(pedido), g = V.agruparMias(pedidos);
      let html = nav('mias') + bandaEstado(est.hora)
        + '<p class="nota" data-etiqueta="Tus ventas de los últimos 60 días. El cliente paga a la tienda: transferencia o en caja al recoger.">Tus ventas de los últimos 60 días. El cliente paga a la tienda: transferencia o en caja al recoger.</p>'
        + `<div class="resumen"><p class="fuerte"><span data-etiqueta="Ventas que la tienda ya cobró:">Ventas que la tienda ya cobró:</span> ${V.pesos(V.cobradoMias(pedidos))}</p><p>${g.esperando.length} <span data-etiqueta="esperando pago">esperando pago</span></p></div>`;
      for (const [titulo, lote] of [['Esperando pago', g.esperando], ['Ya pagadas', g.pagadas], ['Anteriores', g.anteriores]]) {
        if (!lote.length) continue;
        html += `<h2 class="grupo" data-etiqueta="${titulo}">${titulo}</h2>` + lote.map((p) => tarjetaMia(p, { chip: true, abrir: est.abierto })).join('');
      }
      return cuerpo(html);
    },
    al: {
      mias(est) { est.vista = 'mias'; },
      chip(est, el) { est.abierto = el.dataset.clase; },
      actualizar(est) { est.hora = Date.now(); },
    },
  },

  cancelar: {
    pasos: [
      { acc: 'cancelar', texto: 'Toca «Cancelar venta».' },
      { acc: 'si', texto: 'Toca «Sí, cancelar».' },
      { acc: 'entendido', texto: 'Lee el aviso verde y toca «Entendido».' },
    ],
    fin: '¡Listo! La venta pasó a «Anteriores» y la pieza volvió a la venta.',
    inicio: () => ({ dlg: false, cancelada: false, aviso: false }),
    final: () => ({ dlg: false, cancelada: true, aviso: false }),
    vista(est) {
      const v = VENTAS[0], p = pedido(est.cancelada ? { ...v, estado: 'cancelado' } : v);
      const botones = est.cancelada ? '' : `<div class="acciones-mia"><button type="button" class="principal">Avisarle a ${esc(p.cliente)}</button><button type="button" class="peligro" data-acc="cancelar" data-etiqueta="Cancelar venta">Cancelar venta</button></div>`;
      const base = (est.aviso ? resultado(`✓ Venta a ${esc(p.cliente)} ${etiqueta('cancelada. La pieza volvió a la venta.')}`, false, '<button type="button" data-acc="entendido" data-etiqueta="Entendido">Entendido</button>') : '')
        + nav('mias') + `<h2 class="grupo" data-etiqueta="${est.cancelada ? 'Anteriores' : 'Esperando pago'}">${est.cancelada ? 'Anteriores' : 'Esperando pago'}</h2>`
        + tarjetaMia(p, { acciones: botones });
      if (!est.dlg) return cuerpo(base);
      return cuerpo(base, `<dialog open aria-labelledby="t-canc"><h2 id="t-canc" tabindex="-1"><span data-etiqueta="¿Cancelar la venta a">¿Cancelar la venta a</span> ${esc(p.cliente)}?</h2>
        <p data-etiqueta="La pieza vuelve a estar en venta.">La pieza vuelve a estar en venta.</p>
        <div class="acciones"><button type="button" class="peligro" data-acc="si" data-etiqueta="Sí, cancelar">Sí, cancelar</button><button type="button" data-acc="no" data-etiqueta="No, dejarla">No, dejarla</button></div></dialog>`);
    },
    al: {
      cancelar(est) { est.dlg = true; },
      si(est) { Object.assign(est, { dlg: false, cancelada: true, aviso: true }); },
      no(est) { est.dlg = false; },
      entendido(est) { est.aviso = false; },
    },
  },
};

/* ---------- motor: un paso a la vez ---------- */
const motores = [];
function montar(id, def) {
  const sec = document.getElementById(id);
  (sec.querySelector('.nota-tarjeta') ?? sec.querySelector('.objetivo')).insertAdjacentHTML('afterend', `<div class="telefono"><div class="franja">PRÁCTICA: no se manda nada de verdad</div><div class="pantalla"></div></div>
    <p class="paso-texto" role="status" aria-live="polite"></p><ol class="solo-imprimir">${[...def.pasos.map((p) => p.texto), def.fin].map((t) => `<li>${esc(t)}</li>`).join('')}</ol>`);
  sec.insertAdjacentHTML('beforeend', `<div class="ctl-fila"><button type="button" class="ctl repetir">↺ Repetir</button>${sec.nextElementSibling?.id ? `<a class="ctl sig" href="#${sec.nextElementSibling.id}">Siguiente tarea →</a>` : ''}</div>`);
  const marco = sec.querySelector('.pantalla'), pie = sec.querySelector('.paso-texto');
  let est, paso = 0, pista = false, reloj = 0, foco = '';
  const esperar = (ms, fn) => { clearTimeout(reloj); reloj = setTimeout(() => { fn(est); pintar(); }, ms); };
  function pintar() {
    marco.innerHTML = def.vista(est);
    const actual = def.pasos[paso];
    let blanco = actual && marco.querySelector(`[data-acc="${actual.acc}"]${actual.sel ?? ''}`);
    if (blanco?.tagName === 'FORM') blanco = blanco.querySelector('[type=submit]');   // se toca el botón, no todo el formulario
    (blanco?.closest('.resaltable') ?? blanco)?.classList.add('aqui');
    pie.textContent = (pista ? 'Ese botón aquí no hace nada. ' : '') + (actual ? `Paso ${paso + 1} de ${def.pasos.length}: ${actual.texto}` : def.fin);
    const titulo = marco.querySelector('dialog h2');
    if (titulo && titulo.id !== foco) titulo.focus({ preventScroll: true });
    foco = titulo?.id ?? '';
  }
  function actuar(el) {
    pista = false;
    const j = def.pasos.findIndex((s, i) => i >= paso && el.matches(`[data-acc="${s.acc}"]${s.sel ?? ''}`));
    const accion = def.al[el.dataset.acc];
    if (!accion && j < 0) pista = true;
    else if ((accion ? accion(est, el, esperar) : true) !== false && j >= 0) paso = j + 1;
    pintar();
  }
  marco.addEventListener('click', (e) => {
    const el = e.target.closest('[data-acc]');
    if (el && el.tagName !== 'FORM') actuar(el);
    else if (!el && e.target.closest('button, a')) { pista = true; pintar(); }
  });
  marco.addEventListener('submit', (e) => { e.preventDefault(); const f = e.target.closest('[data-acc]'); if (f) actuar(f); });
  marco.addEventListener('input', (e) => { if (e.target.name) est[e.target.name] = e.target.value; });
  marco.addEventListener('change', (e) => { if (e.target.name) est[e.target.name] = e.target.value; if (e.target.dataset.render) pintar(); });
  const poner = (nuevo, n) => { clearTimeout(reloj); est = nuevo; paso = n; pista = false; foco = ''; pintar(); };
  const m = { reiniciar: () => poner(def.inicio(), 0), finalizar: () => poner(def.final(), def.pasos.length) };
  sec.querySelector('.repetir').addEventListener('click', () => { m.reiniciar(); marco.closest('.telefono').scrollIntoView({ block: 'nearest' }); });
  m.reiniciar();
  motores.push(m);
}

if (V) {
  for (const [id, def] of Object.entries(DEFS)) montar(id, def);
  // Al imprimir, cada tarjeta se ve en su estado final y sin botones.
  addEventListener('beforeprint', () => motores.forEach((m) => m.finalizar()));
  addEventListener('afterprint', () => motores.forEach((m) => m.reiniciar()));
} else {
  // Sin vender.js no hay réplica: se muestran los pasos como texto fijo.
  document.getElementById('aviso-modulo').hidden = false;
  document.body.classList.add('sin-practica');
  for (const [id, def] of Object.entries(DEFS)) {
    const sec = document.getElementById(id);
    sec.insertAdjacentHTML('beforeend', `<ol class="solo-imprimir">${[...def.pasos.map((p) => p.texto), def.fin].map((t) => `<li>${esc(t)}</li>`).join('')}</ol>`);
  }
}
