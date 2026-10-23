import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const p={id:'11111111-1111-4111-8111-111111111111',codigo:'ED-002318',nombre:'Chamarra Levi’s',marca:'Levi’s',talla:'M',categoria:'ropa',precio:45000,precio_lista:60000,stock:3,destino:'etiqueta',estado_fisico:'nuevo',estado_analisis:'listo',upc:'012345678905',tiene_foto:1,foto_key:'foto',creado_en:new Date().toISOString(),actualizado_en:new Date().toISOString()};
let consultaSolo=false, listaVacia=false, falloLista=false;const registros=[];
const server=createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://localhost');let datos;
  if(u.pathname==='/api/yo')datos={correo:'prueba@local.mx',usuario:{correo:'prueba@local.mx',roles:consultaSolo?['capturista']:['dueno'],activo:true,editar_inventario:!consultaSolo},vendedor:false,modos_inventario:['capturar','buscar','revisar','imprimir']};
  else if(u.pathname==='/api/config')datos={};
  else if(u.pathname==='/api/salud')datos={ambiente:'sandbox',ahora:new Date().toISOString()};
  else if(u.pathname==='/api/familias')datos={familias:[{prefijo:'r',nombre:'Ropa'},{prefijo:'g',nombre:'Hogar'}],montos:[19,29,49,79,99,119,129,149,199]};
  else if(u.pathname==='/api/piezas')datos={piezas:/^(0191907910414|999999999999)$/.test(u.searchParams.get('q'))?[]:[p],siguiente:null};
  else if(u.pathname.endsWith('/existencia')&&req.method==='POST'){const chunks=[];for await(const ch of req)chunks.push(ch);const c=JSON.parse(Buffer.concat(chunks));const antes=p.stock;p.stock+=c.delta;datos={id:c.id,antes,despues:p.stock};}
  else if(u.pathname.startsWith('/api/piezas/'))datos={pieza:p,puede_editar:!consultaSolo,puede_precio:!consultaSolo,historial:[]};
  else if(u.pathname==='/api/borradores'&&req.method==='POST'){const chunks=[];for await(const ch of req)chunks.push(ch);const r=new Request('http://local/foto',{method:'POST',headers:req.headers,body:Buffer.concat(chunks),duplex:'half'});const f=await r.formData();const nuevo={...p,id:f.get('id'),nombre:f.get('prenda')||'Foto de prueba',talla:f.get('talla'),precio:Number(f.get('precio_ropa'))||24900,stock:Number(f.get('cantidad'))||1,capturado_por:'prueba@local.mx'};registros.push(nuevo);datos=nuevo;}
  else if(u.pathname==='/api/borradores'&&falloLista){res.statusCode=503;datos={error:'Sin conexión'};}
  else if(u.pathname==='/api/borradores'&&listaVacia)datos=[];
  else if(u.pathname==='/api/borradores')datos=[...registros,p,{...p,id:'22222222-2222-4222-8222-222222222222',codigo:'ED-002319',nombre:'Lámpara de escritorio',categoria:'hogar',precio:24900,stock:2}];
  else if(u.pathname==='/api/borradores/upc')datos={...p,id:'33333333-3333-4333-8333-333333333333',nombre:'Lámpara',stock:1};
  else if(u.pathname==='/api/etiquetas')datos=[p,{...p,id:'22222222-2222-4222-8222-222222222222',nombre:'Lámpara de escritorio',stock:2}];
  else if(u.pathname.startsWith('/api/manifiesto/')){if(u.pathname.includes('999999999999')){res.statusCode=404;datos={error:'Sin registro'};}else datos={nombre:'Lámpara de escritorio',categoria:'hogar',precio:24900,precios:{nuevo:24900,danado:14900,liquidacion:9900},imagen:null};}
  else if(u.pathname.includes('/revision'))datos={...p,categoria:'ropa',prenda:'Chamarra'};
  else if(u.pathname==='/api/camara/solicitud'){const ahora=new Date().toISOString();const chunks=[];for await(const ch of req)chunks.push(ch);if(chunks.length)globalThis.solicitud={...JSON.parse(Buffer.concat(chunks)),estado:'pendiente',vence_en:new Date(Date.now()+120000).toISOString()};datos={ahora,solicitud:globalThis.solicitud};}
  else if(u.pathname.startsWith('/api/foto/')){res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#F2F5FA"/><path d="M140 70l-70 70 45 45 25-25v180h120V160l25 25 45-45-70-70-40 30h-40z" fill="#16366B" stroke="#FFD447" stroke-width="8"/></svg>');return;}
  else if(u.pathname.startsWith('/api/'))datos=[];
  if(datos!==undefined){res.setHeader('content-type','application/json');res.end(JSON.stringify(datos));return;}
  const file=path.join(process.cwd(),'app/public',u.pathname==='/'?'inventario.html':u.pathname.slice(1)+(path.extname(u.pathname)?'':'.html'));
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(file));
}catch{res.statusCode=404;res.end('no');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const perfil=await mkdtemp(path.join(os.tmpdir(),'inventario-qa-'));
const chrome=spawn(process.env.CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--remote-debugging-port=0','--no-first-run','--disable-background-networking','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--user-data-dir=${perfil}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const dormir=ms=>new Promise(r=>setTimeout(r,ms));
let debug;for(let i=0;i<100;i++){try{debug=(await readFile(path.join(perfil,'DevToolsActivePort'),'utf8')).split('\n')[0];if(debug)break;}catch{}await dormir(100);}
assert.ok(debug,'Chrome no abrió CDP');
const target=await(await fetch(`http://127.0.0.1:${debug}/json/new?about:blank`,{method:'PUT'})).json();
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let id=0;const pendientes=new Map(),errores=[];
ws.addEventListener('message',e=>{const d=JSON.parse(e.data);if(d.id){const p=pendientes.get(d.id);pendientes.delete(d.id);d.error?p?.reject(d.error):p?.resolve(d.result);}else if(d.method==='Runtime.exceptionThrown')errores.push(d.params.exceptionDetails.exception?.description||d.params.exceptionDetails.text);});
const cdp=(method,params={})=>new Promise((resolve,reject)=>{pendientes.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const js=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description);return r.result.value;};
await cdp('Runtime.enable');await cdp('Page.enable');const salida=process.env.QA_SALIDA||path.join(os.tmpdir(),'inventario-qa-capturas');await mkdir(salida,{recursive:true});
await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
window.blePrueba={enviadas:0,fallarDesde:Infinity,buffer:''};
const caracteristica={properties:{writeWithoutResponse:true},async writeValueWithoutResponse(bytes){if(blePrueba.enviadas>=blePrueba.fallarDesde)throw new Error('GATT desconectada simulada');blePrueba.buffer+=new TextDecoder().decode(bytes);if(blePrueba.buffer.includes('PRINT 1,1\\r\\n')){blePrueba.enviadas++;blePrueba.buffer='';}}};
const aparato={addEventListener(){},gatt:{connected:true,async connect(){return{getPrimaryService:async()=>({getCharacteristic:async()=>caracteristica})};},disconnect(){}}};
Object.defineProperty(navigator,'bluetooth',{configurable:true,value:{requestDevice:async()=>aparato}});
`.replace(/^\+/gm,'')});
const medidas=[];
async function capturar(nombre,width){
  await dormir(120);
  const d=await js(`(()=>{const visibles=[...document.querySelectorAll('button,a[href],summary,input:not([type=checkbox]),select')].filter(b=>{const r=b.getBoundingClientRect();return r.width&&r.height&&r.top>=0&&r.top<innerHeight&&r.left>=0&&!b.closest('[hidden]')});return {ancho:document.documentElement.scrollWidth,ventana:innerWidth,pequenos:visibles.map(b=>({texto:b.getAttribute('aria-label')||b.innerText||b.id,w:b.getBoundingClientRect().width,h:b.getBoundingClientRect().height})).filter(b=>b.w<43.9||b.h<43.9),tabs:[...document.querySelectorAll('#modos button')].map(b=>({texto:b.innerText,hidden:b.hidden,w:b.getBoundingClientRect().width})),estado:document.querySelector('#estado:not([hidden]),#error:not([hidden])')?.innerText}})()`);
  medidas.push({nombre,width,...d});assert.ok(!/Cannot|undefined|is not a function/.test(d.estado),`Error en pantalla ${nombre}: ${d.estado}`);assert.ok(d.ancho<=width,`Desborde ${nombre}: ${d.ancho}`);
  const png=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(salida,`${nombre}-${width}.png`),Buffer.from(png.data,'base64'));
}
async function esperar(expression){for(let i=0;i<100;i++){if(await js(expression))return;await dormir(50);}throw new Error('No llegó el estado: '+expression);}
async function modo(m){await js(`document.getElementById('tab-${m}').click()`);await dormir(350);}
async function buscar(q){await js(`document.getElementById('consulta').value=${JSON.stringify(q)};document.getElementById('busqueda').requestSubmit()`);await dormir(250);}
try{
for(const width of [390,1280]){
  consultaSolo=false;listaVacia=false;falloLista=false;
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:800,deviceScaleFactor:2,mobile:width===390});
  await cdp('Emulation.setTouchEmulationEnabled',{enabled:width===390});
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/inventario?qa=${width}#capturar`});await dormir(1300);
  if(width===390){await js("document.querySelector('.empezar-captura button').click()");await dormir(600);}
  await capturar('01-listo',width);
  if(width===390){
    await js("[...document.querySelectorAll('#modo-capturar button')].find(b=>b.textContent==='Ropa').click()");
    await capturar('06-ropa-sin-talla',width);
    await js("document.querySelector('.tablero-ropa [data-valor=M]').click();[...document.querySelectorAll('.resumen-ropa button')].at(-1).click()");
    await js("[...document.querySelectorAll('#hoja button')].find(b=>b.textContent==='$120').click()");
    await capturar('05-ropa-completa',width);
    await cdp('Network.enable');await cdp('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await js("document.querySelector('.disparo').click()");await esperar("!!document.querySelector('.miniatura.local')");await capturar('07-sin-red',width);
    await js("document.querySelector('.miniatura.local').click()");await capturar('08-corregir',width);await js("document.getElementById('cerrar-hoja').click()");
    await cdp('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await esperar('navigator.onLine');await dormir(350);
  }
  if(width===1280){await js("[...document.querySelectorAll('#modo-capturar button')].find(b=>b.textContent==='Mercancía').click()");await js("[...document.querySelectorAll('#modo-capturar button')].find(b=>b.textContent==='Producto sin código: foto con celular').click()");await capturar('10-esperando-celular',width);await dormir(8500);await capturar('10-celular-no-responde',width);await js("document.querySelector('.panel-celular button').click()");}
  await buscar('0191907910414');await capturar('02-codigo-nuevo',width);
  await buscar('012345678905');await capturar('03-ya-existe',width);
  await buscar('999999999999');await capturar('04-sin-registro',width);
  await modo('buscar');await buscar('chamarra');await capturar('11-ficha',width);
  await js("window.lecturasQA=[];window.clicksQA=0;document.addEventListener('lectura',e=>lecturasQA.push(e.detail));const b=document.getElementById('editar');b.addEventListener('click',()=>clicksQA++);b.focus()");
  for(const key of '012345678905'){await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,text:key});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key});await dormir(15);}
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await dormir(200);
  assert.equal(await js('lecturasQA.length'),1);assert.equal(await js('clicksQA'),0);assert.equal(await js('lecturasQA[0].codigo'),'012345678905');

  await js("document.getElementById('chip-red').click()");await capturar('17-red',width);await js("document.getElementById('cerrar-hoja').click()");
  await js("document.getElementById('menu').click()");await capturar('18-menu',width);await js("document.getElementById('cerrar-hoja').click()");
  await modo('revisar');await js("document.querySelector('#modo-revisar [data-estado=todas]').click()");
  await js("document.querySelector('#modo-revisar .fila-revision input[type=checkbox]').click()");await capturar('12-revisar-seleccion',width);
  listaVacia=true;await modo('buscar');await modo('revisar');await capturar('13-revisar-vacio',width);
  falloLista=true;listaVacia=false;await modo('buscar');await modo('revisar');await capturar('13-revisar-error',width);falloLista=false;
  await modo('imprimir');await capturar('14-impresora-desconectada',width);
  await js("document.getElementById('chip-impresora').click()");await capturar('17-impresora',width);await js("document.getElementById('cerrar-hoja').click()");
  await js("document.getElementById('conectar-impresora').click()");await dormir(100);await js("blePrueba.fallarDesde=4;document.querySelector('#modo-imprimir #imprimir').click()");await dormir(200);await capturar('15-enviando',width);await dormir(6000);await capturar('15-corte-parcial',width);assert.equal(await js('blePrueba.enviadas'),4,'El corte simulado debe ocurrir tras cuatro etiquetas');
  await js("document.getElementById('tab-bandas').click()");await capturar('16-bandas',width);
  if(width===390){await cdp('Browser.setPermission',{permission:{name:'camera'},setting:'denied',origin:`http://127.0.0.1:${port}`});await modo('capturar');await js("navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denegada','NotAllowedError')};[...document.querySelectorAll('.visor button')].find(b=>b.textContent==='Reanudar').click()");await dormir(200);await capturar('09-camara-bloqueada',width);assert.match(await js("document.getElementById('error').innerText"),/Cámara bloqueada/);await cdp('Browser.resetPermissions');}
  consultaSolo=true;
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/inventario?consulta=${width}#buscar`});await dormir(600);await buscar('chamarra');await capturar('11-solo-consulta',width);
  assert.equal(await js("document.getElementById('menos').hidden&&document.getElementById('edicion').hidden"),true);
  await modo('revisar');await js("document.querySelector('#modo-revisar [data-estado=todas]').click()");await capturar('12-solo-consulta',width);assert.equal(await js("document.querySelectorAll('#modo-revisar input[type=checkbox]').length"),0);
}
await cdp('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:2,mobile:true});
await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/inventario?reflujo=320#buscar`});await dormir(500);await buscar('chamarra');await capturar('11-reflujo',320);
await writeFile(path.join(salida,'medidas.json'),JSON.stringify({errores,medidas},null,2));
assert.deepEqual(errores,[]);const pequenos=medidas.flatMap(d=>d.pequenos.map(p=>({...p,estado:d.nombre,width:d.width})));assert.deepEqual(pequenos,[],'Objetivos menores de 44 px');console.log(`QA: ${medidas.length} capturas; sin desborde, objetivos >=44 px, sin errores de JavaScript`);
}finally{await cdp('Browser.close').catch(()=>{});ws.close();server.close();chrome.kill();await dormir(400);await rm(perfil,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
