// QA headless de la solicitud de precio (#451): capturista pide, dueño resuelve. Sin dependencias.
// node tools/qa_precio.mjs   (QA_SALIDA=carpeta para las capturas; CHROME=ruta si no es la de Windows)
// Simula /api/* con fixtures: no toca D1 ni red. Mide desborde horizontal y objetivos < 44 px.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const ahora = () => new Date().toISOString();
const pieza = { id:'11111111-1111-4111-8111-111111111111', codigo:'ED-002318', nombre:'Chamarra Levi’s', marca:'Levi’s', talla:'M', categoria:'ropa',
  precio:45000, precio_lista:60000, stock:3, destino:'etiqueta', estado_fisico:'nuevo', estado_analisis:'listo', upc:'012345678905',
  tiene_foto:1, foto_key:'foto', creado_en:ahora(), actualizado_en:ahora() };
const otra = { ...pieza, id:'22222222-2222-4222-8222-222222222222', codigo:'ED-002319', nombre:'Lámpara de escritorio con brazo articulado y pantalla de tela', marca:'', talla:null, precio:24900, precio_lista:0, tiene_foto:0, foto_key:'' };
let rol = 'capturista', sol = null, enviados = [], aplicados = [];
const pendientes = () => [
  { id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', producto_id:pieza.id, sentido:'bajar', precio_actual:45000, precio_sugerido:35000, nota:'Otra tienda la vende en $300, se ve usada',
    pedido_por:'ana.lopez@gmail.com', pedido_en:new Date(Date.now() - 3600_000).toISOString(), estado:'pendiente', codigo:pieza.codigo, nombre:pieza.nombre,
    marca:pieza.marca, talla:pieza.talla, precio:pieza.precio, precio_lista:pieza.precio_lista, destino:'etiqueta', tiene_foto:1 },
  { id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', producto_id:otra.id, sentido:'subir', precio_actual:24900, precio_sugerido:null, nota:'',
    pedido_por:'luis@gmail.com', pedido_en:new Date(Date.now() - 30 * 3600_000).toISOString(), estado:'pendiente', codigo:otra.codigo, nombre:otra.nombre,
    marca:'', talla:null, precio:otra.precio, precio_lista:0, destino:'etiqueta', tiene_foto:0 },
].filter((s) => !aplicados.includes(s.id));
const cuerpoDe = async (req) => { const c = []; for await (const ch of req) c.push(ch); return c.length ? JSON.parse(Buffer.concat(c)) : {}; };

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost'); let datos;
    const dueno = rol === 'dueno';
    if (u.pathname === '/api/yo') datos = { correo:'prueba@local.mx', usuario:{ correo:'prueba@local.mx', roles:[rol], activo:true, editar_inventario:dueno }, vendedor:false, modos_inventario:['capturar', 'buscar', 'revisar', 'imprimir'] };
    else if (u.pathname === '/api/config') datos = {};
    else if (u.pathname === '/api/salud') datos = { ambiente:'sandbox', ahora:ahora() };
    else if (u.pathname === '/api/familias') datos = { familias:[], montos:[] };
    else if (u.pathname === '/api/piezas') datos = { piezas:/chamarra|012345678905/i.test(u.searchParams.get('q')) ? [pieza] : [], siguiente:null };
    else if (/\/solicitud-precio$/.test(u.pathname) && req.method === 'POST') {
      const c = await cuerpoDe(req);
      if (sol) { res.statusCode = 409; datos = { error:'Esta pieza ya tiene una solicitud de precio pendiente.', solicitud:sol }; }
      else { enviados.push(c); sol = { ...c, producto_id:pieza.id, precio_actual:pieza.precio, precio_sugerido:c.precio_sugerido ?? null, nota:c.nota ?? '', pedido_por:'prueba@local.mx', pedido_en:ahora(), estado:'pendiente' }; res.statusCode = 201; datos = { solicitud:sol }; }
    }
    else if (u.pathname === '/api/solicitudes-precio' && req.method === 'GET') { if (!dueno) { res.statusCode = 403; datos = { error:'Solo el dueño' }; } else { const l = pendientes(); datos = { solicitudes:l, conteo:l.length }; } }
    else if (u.pathname.startsWith('/api/solicitudes-precio/') && req.method === 'POST') {
      const c = await cuerpoDe(req), id = u.pathname.split('/').pop(); aplicados.push(id);
      if (c.accion === 'aplicar') { pieza.precio = c.precio; sol = null; datos = { solicitud:{ id, estado:'aplicada', precio_nuevo:c.precio }, precio:c.precio }; }
      else { sol = null; datos = { solicitud:{ id, estado:'rechazada' } }; }
    }
    else if (u.pathname.startsWith('/api/piezas/')) datos = { pieza, puede_editar:dueno, puede_precio:dueno, historial:[], solicitud_precio:sol };
    else if (u.pathname === '/api/borradores') datos = [pieza, otra];
    else if (u.pathname === '/api/recortes') datos = [];
    else if (u.pathname.startsWith('/api/foto/')) { res.setHeader('content-type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#F2F5FA"/><path d="M140 70l-70 70 45 45 25-25v180h120V160l25 25 45-45-70-70-40 30h-40z" fill="#16366B" stroke="#FFD447" stroke-width="8"/></svg>'); return; }
    else if (u.pathname.startsWith('/api/')) datos = [];
    if (datos !== undefined) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(datos)); return; }
    const file = path.join(process.cwd(), 'app/public', u.pathname === '/' ? 'inventario.html' : u.pathname.slice(1) + (path.extname(u.pathname) ? '' : '.html'));
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end('no'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
const perfil = await mkdtemp(path.join(os.tmpdir(), 'precio-qa-'));
const chrome = spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--disable-background-networking', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--user-data-dir=${perfil}`, 'about:blank'], { windowsHide:true, stdio:'ignore' });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let debug; for (let i = 0; i < 100; i++) { try { debug = (await readFile(path.join(perfil, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; if (debug) break; } catch {} await dormir(100); }
assert.ok(debug, 'Chrome no abrió CDP');
const target = await (await fetch(`http://127.0.0.1:${debug}/json/new?about:blank`, { method:'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r, { once:true }));
let id = 0; const esperando = new Map(), errores = [];
ws.addEventListener('message', (e) => { const d = JSON.parse(e.data); if (d.id) { const p = esperando.get(d.id); esperando.delete(d.id); d.error ? p?.reject(d.error) : p?.resolve(d.result); } else if (d.method === 'Runtime.exceptionThrown') errores.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); });
const cdp = (method, params = {}) => new Promise((resolve, reject) => { esperando.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expression) => { const r = await cdp('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
await cdp('Runtime.enable'); await cdp('Page.enable');
const salida = process.env.QA_SALIDA || path.join(os.tmpdir(), 'precio-qa'); await mkdir(salida, { recursive:true });
const medidas = [];
async function capturar(nombre, width, { hoja = false } = {}) {
  await dormir(200);
  const d = await js(`(()=>{const raiz=${hoja ? "document.getElementById('hoja')" : 'document'};const visibles=[...raiz.querySelectorAll('button,a[href],summary,input:not([type=checkbox]):not([type=radio]),select,textarea,label.sp-opcion')].filter(b=>{const r=b.getBoundingClientRect();return r.width&&r.height&&r.left>=0&&!b.closest('[hidden]')&&(${hoja} || (r.top>=0&&r.top<innerHeight))});return {ancho:document.documentElement.scrollWidth,pequenos:visibles.map(b=>({texto:(b.getAttribute('aria-label')||b.innerText||b.id||'').slice(0,40),w:Math.round(b.getBoundingClientRect().width),h:Math.round(b.getBoundingClientRect().height)})).filter(b=>b.w<43.9||b.h<43.9),estado:document.querySelector('#estado:not([hidden]),#error:not([hidden])')?.innerText}})()`);
  medidas.push({ nombre, width, ...d });
  assert.ok(d.ancho <= width, `Desborde horizontal en ${nombre}: ${d.ancho} > ${width}`);
  const png = await cdp('Page.captureScreenshot', { format:'png' }); await writeFile(path.join(salida, `${nombre}-${width}.png`), Buffer.from(png.data, 'base64'));
}
const modo = async (m) => { await js(`document.getElementById('tab-${m}').click()`); await dormir(500); };
const buscar = async (q) => { await js(`document.getElementById('consulta').value=${JSON.stringify(q)};document.getElementById('busqueda').requestSubmit()`); await dormir(500); };
const escribir = (selector, texto) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.value=${JSON.stringify(texto)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const clic = (textoBoton, raiz = 'document') => js(`(()=>{const b=[...${raiz}.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(textoBoton)}));if(!b)throw new Error('Sin botón '+${JSON.stringify(textoBoton)});b.click();})()`);
const texto = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`);
async function abrirPagina(width, hash, extra = '') {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height:width === 390 ? 844 : 800, deviceScaleFactor:2, mobile:width === 390 });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled:width === 390 });
  await cdp('Page.navigate', { url:`http://127.0.0.1:${port}/inventario?qa=${Date.now()}${extra}#${hash}` }); await dormir(900);
}
try {
  for (const width of [390, 1280]) {
    // ---- Capturista: pedir el cambio ----
    rol = 'capturista'; sol = null; enviados = []; aplicados = []; pieza.precio = 45000;
    await abrirPagina(width, 'buscar'); await js('localStorage.setItem("captura-modo","mercancia")');
    await modo('buscar'); await buscar('chamarra');
    await capturar('01-ficha-capturista', width);
    assert.equal(await js("[...document.querySelectorAll('#bloque-precio button')].map(b=>b.textContent).join()"), 'Pedir cambio de precio');
    await clic('Pedir cambio de precio', "document.getElementById('bloque-precio')");
    await dormir(300); await capturar('02-hoja-vacia', width, { hoja:true });
    assert.equal(await js("document.querySelector('#hoja .primario').getAttribute('aria-disabled')"), 'true', 'Enviar bloqueado hasta elegir sentido');
    await clic('Enviar al dueño', "document.getElementById('hoja')"); await dormir(150);
    assert.match(await texto('#estado'), /Elige si está barato o caro/);
    assert.match(await texto('#estado'), /Elige si está barato o caro/);
    await js("document.querySelector('#hoja input[value=subir]').click()");
    assert.doesNotMatch(await texto('#estado'), /Elige si está barato o caro/, 'el aviso viejo se quita al elegir');
    await escribir('#hoja .campo-precio input', '300'); await escribir('#hoja textarea', 'Se vende a $600 en otra tienda');
    await capturar('03-hoja-llena', width, { hoja:true });
    await escribir('#hoja .campo-precio input', '300'); await clic('Enviar al dueño', "document.getElementById('hoja')"); await dormir(150);
    assert.match(await js("document.querySelector('#hoja .error-hoja').innerText"), /■ Para subirlo, escribe más de \$450\.00/);
    await capturar('04-hoja-error', width, { hoja:true });
    await escribir('#hoja .campo-precio input', '550'); await clic('Enviar al dueño', "document.getElementById('hoja')"); await dormir(500);
    assert.equal(await js("document.getElementById('hoja').open"), false);
    assert.equal(enviados.length, 1); assert.deepEqual([enviados[0].sentido, enviados[0].precio_sugerido, enviados[0].nota], ['subir', 55000, 'Se vende a $600 en otra tienda']);
    assert.match(await texto('#estado'), /✓ Solicitud enviada al dueño/);
    assert.equal((await texto('#bloque-precio')).replace(/\s+/g, ' '), '▲ Pediste subir el precio · pendiente Sugeriste $550.00');
    await capturar('05-ficha-pendiente', width);
    // Capturar: la tarjeta de pieza existente
    await modo('capturar'); await js("document.querySelector('.empezar-captura button')?.click()"); await dormir(500); await js('document.getElementById("consulta").value="012345678905";document.getElementById("busqueda").hidden=false;document.getElementById("busqueda").requestSubmit()'); await dormir(700);
    await capturar('06-capturar-tarjeta-pendiente', width);
    sol = null; await js('localStorage.clear()');

    // ---- Dueño: resolver ----
    rol = 'dueno'; sol = { id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', producto_id:pieza.id, sentido:'bajar', precio_actual:45000, precio_sugerido:35000, nota:'Se ve usada', pedido_por:'ana.lopez@gmail.com', pedido_en:ahora(), estado:'pendiente' };
    await abrirPagina(width, 'revisar'); await dormir(600);
    assert.match(await js("document.getElementById('tab-revisar').getAttribute('aria-label')"), /Revisar, 2 precios por revisar/);
    await capturar('10-revisar-dueno', width);
    await js("document.querySelector('#modo-revisar [data-estado=precios]').click()"); await dormir(300);
    await capturar('11-precios-por-revisar', width);
    assert.equal(await js("document.querySelector('#modo-revisar [data-estado=precios]').textContent"), 'Precios por revisar · 2');
    assert.equal(await js("document.querySelector('.solicitud-precio .sp-formulario input').value"), '350.00', 'prellenado con el sugerido');
    assert.equal(await js("document.querySelector('.solicitud-precio .primario').textContent"), 'Cambiar a $350.00');
    assert.equal(await js("document.querySelectorAll('.solicitud-precio')[1].querySelector('input').value"), '249.00', 'sin sugerido, el precio actual');
    assert.equal(await js("document.querySelectorAll('.solicitud-precio')[1].querySelector('.primario').getAttribute('aria-disabled')"), 'true', 'igual al actual: bloqueado');
    // Foto y nombre abren la ficha de la pieza (botón de al menos 44 px)
    assert.ok(await js("(()=>{const r=document.querySelector('.solicitud-precio .sp-abrir').getBoundingClientRect();return r.width>=44&&r.height>=44})()"));
    await js("document.querySelector('.solicitud-precio .sp-abrir').click()"); await dormir(600);
    assert.equal(await js("document.getElementById('ficha').hidden"), false); assert.equal(await js("document.getElementById('codigo').textContent"), 'ED-002318');
    await capturar('11b-ficha-desde-solicitud', width);
    if (width === 390) await js("document.getElementById('volver').click()"); await dormir(300);
    assert.equal(await js("document.querySelectorAll('.fila-precio .solicitud-precio').length"), 2, 'la lista de precios sigue ahí');
    // Cambio grande: pide confirmar
    await escribir('.solicitud-precio .sp-formulario input', '100'); assert.equal(await js("document.querySelector('.solicitud-precio .primario').textContent"), 'Cambiar a $100.00');
    await clic('Cambiar a $100.00', "document.querySelector('.solicitud-precio')"); await dormir(300);
    await capturar('12-confirmar-cambio-grande', width, { hoja:true });
    assert.match(await js("document.getElementById('hoja-cuerpo').innerText"), /\$450\.00 a \$100\.00 \(-78 %\)/);
    await js("document.getElementById('cerrar-hoja').click()"); await dormir(200);
    assert.equal(aplicados.length, 0, 'cerrar no aplica');
    await escribir('.solicitud-precio .sp-formulario input', '350'); await clic('Cambiar a $350.00', "document.querySelector('.solicitud-precio')"); await dormir(500);
    assert.equal(aplicados.length, 1); assert.equal(pieza.precio, 35000);
    assert.match(await texto('.solicitud-precio .sp-hecho'), /✓ Ahora \$350\.00/);
    assert.match(await texto('.solicitud-precio .sp-hecho'), /La etiqueta pegada dice \$450\.00/);
    assert.equal(await js("document.querySelector('#modo-revisar [data-estado=precios]').textContent"), 'Precios por revisar · 1');
    assert.equal(await js("document.getElementById('tab-revisar').getAttribute('aria-label')"), 'Revisar, 1 precio por revisar');
    await capturar('13-precio-cambiado', width);
    await clic('Dejar igual', "document.querySelectorAll('.solicitud-precio')[1]"); await dormir(400);
    assert.match(await texto('#estado'), /✓ Dejaste el precio igual/);
    assert.equal(await js("document.getElementById('tab-revisar').hasAttribute('aria-label')"), false);
    await capturar('14-todo-resuelto', width);
    // Ficha del dueño con una pendiente
    pieza.precio = 45000; aplicados = []; sol = { id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', producto_id:pieza.id, sentido:'subir', precio_actual:45000, precio_sugerido:50000, nota:'', pedido_por:'ana.lopez@gmail.com', pedido_en:ahora(), estado:'pendiente' };
    await abrirPagina(width, 'buscar'); await modo('buscar'); await buscar('chamarra');
    await capturar('15-ficha-dueno-pendiente', width);
    assert.equal(await js("document.querySelector('#bloque-precio .sp-formulario input').value"), '500.00');
  }
  await writeFile(path.join(salida, 'medidas.json'), JSON.stringify({ errores, medidas }, null, 2));
  assert.deepEqual(errores, [], 'Errores de JavaScript');
  const chicos = medidas.flatMap((d) => d.pequenos.map((p) => ({ ...p, pantalla:d.nombre, width:d.width })));
  console.log(chicos.length ? `Objetivos < 44 px:\n${chicos.map((c) => `  ${c.pantalla} ${c.width}: ${c.texto} ${c.w}x${c.h}`).join('\n')}` : 'Objetivos >= 44 px');
  console.log(`QA precio: ${medidas.length} capturas en ${salida}; sin desborde horizontal ni errores de JavaScript`);
} catch (e) { console.error('Errores de página:', errores); throw e; }
finally { await cdp('Browser.close').catch(() => {}); ws.close(); server.close(); chrome.kill(); await dormir(400); await rm(perfil, { recursive:true, force:true, maxRetries:5, retryDelay:200 }); }
