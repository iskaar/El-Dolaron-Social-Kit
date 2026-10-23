import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const p={id:'11111111-1111-4111-8111-111111111111',codigo:'ED-002318',nombre:'Chamarra Levi’s',marca:'Levi’s',talla:'M',categoria:'ropa',precio:45000,precio_lista:60000,stock:3,destino:'etiqueta',estado_fisico:'nuevo',estado_analisis:'listo',upc:'012345678905',tiene_foto:1,foto_key:'foto',creado_en:new Date().toISOString(),actualizado_en:new Date().toISOString()};
const upcQA=process.env.QA_UPC==='1';
const destinoUpc={...p,id:'22222222-2222-4222-8222-222222222222',codigo:'ED-002319',stock:4,upc:'12345678901'};
let consultaSolo=false, capturista=false, editarInventario=false, listaVacia=false, falloLista=false;const registros=[];
const inventario=[p,...Array.from({length:60},(_,i)=>({...p,id:`pieza-${i}`,codigo:`ED-${String(2319+i).padStart(6,'0')}`,nombre:i%2?'Lámpara de escritorio':'Chamarra de mezclilla',tiene_foto:i%3?1:0,foto_key:i%3?'foto':'',stock:i%5}))];
const consultas=[];
const server=createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://localhost');let datos;
  if(u.pathname==='/api/yo')datos={correo:'prueba@local.mx',usuario:{correo:'prueba@local.mx',roles:consultaSolo||capturista?['capturista']:['dueno'],activo:true,editar_inventario:capturista?editarInventario:!consultaSolo},vendedor:false,modos_inventario:['capturar','buscar','revisar','imprimir']};
  else if(u.pathname==='/api/config')datos={};
  else if(u.pathname==='/api/salud')datos={ambiente:'sandbox',ahora:new Date().toISOString()};
  else if(u.pathname==='/api/familias')datos={familias:[{prefijo:'r',nombre:'Ropa'},{prefijo:'g',nombre:'Hogar'}],montos:[19,29,49,79,99,119,129,149,199]};
  else if(u.pathname==='/api/piezas'){
    const q=u.searchParams.get('q')||'';consultas.push(q);
    if(q==='vieja')await new Promise(r=>setTimeout(r,700));
    const piezas=q==='vieja'?inventario.slice(0,2):q==='lámpara'?inventario.filter(p=>p.nombre.startsWith('Lámpara')):q?(/^(0191907910414|999999999999)$/.test(q)?[]:[p]):inventario;
    const inicio=Number(u.searchParams.get('cursor')||0),fin=inicio+25;datos={piezas:piezas.slice(inicio,fin),siguiente:fin<piezas.length?String(fin):null};
  }
  else if(u.pathname.endsWith('/existencia')&&req.method==='POST'){const chunks=[];for await(const ch of req)chunks.push(ch);const c=JSON.parse(Buffer.concat(chunks));const antes=p.stock;p.stock+=c.delta;datos={id:c.id,antes,despues:p.stock};}
  else if(u.pathname==='/api/piezas/repetidas')datos={grupos:upcQA?[{upc:'12345678901',estado_fisico:'nuevo',piezas:[{...p,upc:'12345678901'},destinoUpc],destino_id:p.id}]:[],siguiente:null};
  else if(u.pathname.endsWith('/juntar'))datos={id:p.id,destino_id:destinoUpc.id,movidas:3,stock:7};
  else if(u.pathname.startsWith('/api/piezas/'))datos={pieza:u.pathname.endsWith(destinoUpc.id)?destinoUpc:p,puede_editar:!consultaSolo,puede_precio:!consultaSolo,historial:[]};
  else if(u.pathname==='/api/borradores'&&req.method==='POST'){const chunks=[];for await(const ch of req)chunks.push(ch);const r=new Request('http://local/foto',{method:'POST',headers:req.headers,body:Buffer.concat(chunks),duplex:'half'});const f=await r.formData();const nuevo={...p,id:f.get('id'),nombre:f.get('prenda')||'Foto de prueba',talla:f.get('talla'),precio:Number(f.get('precio_ropa'))||24900,stock:Number(f.get('cantidad'))||1,capturado_por:'prueba@local.mx'};registros.push(nuevo);datos=nuevo;}
  else if(u.pathname==='/api/borradores'&&falloLista){res.statusCode=503;datos={error:'Sin conexión'};}
  else if(u.pathname==='/api/borradores'&&listaVacia)datos=[];
  else if(u.pathname==='/api/borradores')datos=[...registros,p,{...p,id:'22222222-2222-4222-8222-222222222222',codigo:'ED-002319',nombre:'Lámpara de escritorio',categoria:'hogar',precio:24900,stock:6}];
  else if(upcQA&&u.pathname.startsWith('/api/borradores/')&&req.method==='PATCH'){
    const chunks=[];for await(const ch of req)chunks.push(ch);const c=JSON.parse(Buffer.concat(chunks));
    if(u.pathname.endsWith(p.id)&&c.upc==='12345678901'){res.statusCode=409;datos={error:'Ese UPC ya existe con este grado.',existente:{...destinoUpc,tiene_etiqueta:true}};}
    else{const pieza=u.pathname.endsWith(destinoUpc.id)?destinoUpc:p;pieza.upc=c.upc??pieza.upc;datos={...pieza,...c};}
  }
  else if(u.pathname==='/api/borradores/upc'){
    const chunks=[];for await(const ch of req)chunks.push(ch);const c=JSON.parse(Buffer.concat(chunks));
    datos=upcQA?{...p,existente:true,sumadas:2,stock:5}:{...p,id:c.id,nombre:c.nombre??'Lámpara',precio:c.precio??24900,categoria:'hogar',stock:c.stock};
    if(!upcQA)registros.push(datos);
  }
  else if(u.pathname==='/api/etiquetas'){
    const chunks=[];for await(const ch of req)chunks.push(ch);const {ids}=JSON.parse(Buffer.concat(chunks));
    datos=[...registros,p,{...p,id:'22222222-2222-4222-8222-222222222222',nombre:'Lámpara de escritorio',categoria:'hogar',stock:6}].filter(p=>ids.includes(p.id));
  }
  else if(u.pathname.startsWith('/api/manifiesto/')){if(u.pathname.includes('999999999999')){res.statusCode=404;datos={error:'Sin registro'};}else datos={nombre:'Lámpara de escritorio',categoria:'hogar',precio:24900,precio_lista:60000,precios:{nuevo:24900,danado:14900,liquidacion:9900},imagen:null};}
  else if(u.pathname.includes('/revision'))datos={...p,categoria:'ropa',prenda:'Chamarra'};
  else if(u.pathname==='/api/camara/solicitud'){const ahora=new Date().toISOString();const chunks=[];for await(const ch of req)chunks.push(ch);if(chunks.length)globalThis.solicitud={...JSON.parse(Buffer.concat(chunks)),estado:'pendiente',vence_en:new Date(Date.now()+120000).toISOString()};datos={ahora,solicitud:globalThis.solicitud};}
  else if(u.pathname.startsWith('/api/foto/')){res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#F2F5FA"/><path d="M140 70l-70 70 45 45 25-25v180h120V160l25 25 45-45-70-70-40 30h-40z" fill="#16366B" stroke="#FFD447" stroke-width="8"/></svg>');return;}
  else if(u.pathname==='/api/solicitudes-precio')datos={solicitudes:[],conteo:0};
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
window.blePrueba={enviadas:0,fallarDesde:Infinity,buffer:'',trabajos:[]};
const caracteristica={properties:{writeWithoutResponse:true},async writeValueWithoutResponse(bytes){if(blePrueba.enviadas>=blePrueba.fallarDesde)throw new Error('GATT desconectada simulada');blePrueba.buffer+=new TextDecoder().decode(bytes);if(blePrueba.buffer.includes('PRINT 1,1\\r\\n')){blePrueba.enviadas++;blePrueba.trabajos.push(blePrueba.buffer);blePrueba.buffer='';}}};
const aparato={addEventListener(){},gatt:{connected:true,async connect(){return{getPrimaryService:async()=>({getCharacteristic:async()=>caracteristica})};},disconnect(){}}};
Object.defineProperty(navigator,'bluetooth',{configurable:true,value:{requestDevice:async()=>{if(blePrueba.cancelar)throw new DOMException('Cancelada','NotFoundError');return aparato;}}});
`.replace(/^\+/gm,'')});
const medidas=[];
async function capturar(nombre,width){
  await dormir(120);
  const d=await js(`(()=>{const visibles=[...document.querySelectorAll('button,a[href],summary,input:not([type=checkbox]),select')].filter(b=>{const r=b.getBoundingClientRect();return r.width&&r.height&&r.top>=0&&r.top<innerHeight&&r.left>=0&&!b.closest('[hidden]')});return {ancho:document.documentElement.scrollWidth,ventana:innerWidth,pequenos:visibles.map(b=>({texto:b.getAttribute('aria-label')||b.innerText||b.id,w:b.getBoundingClientRect().width,h:b.getBoundingClientRect().height})).filter(b=>b.w<43.9||b.h<43.9),tabs:[...document.querySelectorAll('#modos button')].map(b=>({texto:b.innerText,hidden:b.hidden,w:b.getBoundingClientRect().width})),estado:document.querySelector('#estado:not([hidden]),#error:not([hidden])')?.innerText,primariosBajos:visibles.filter(b=>b.classList.contains('primario')&&innerWidth<1000&&b.getBoundingClientRect().height<55.9).map(b=>b.innerText),chicos48:visibles.filter(b=>b.tagName==='BUTTON'&&!b.closest('header,#modos')&&b.getBoundingClientRect().height<47.9).map(b=>b.innerText.trim()||b.getAttribute('aria-label'))}})()`);
  medidas.push({nombre,width,...d});assert.ok(!/Cannot|undefined|is not a function/.test(d.estado),`Error en pantalla ${nombre}: ${d.estado}`);assert.ok(d.ancho<=width,`Desborde ${nombre}: ${d.ancho}`);
  const png=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(salida,`${nombre}-${width}.png`),Buffer.from(png.data,'base64'));
}
async function esperar(expression,intentos=100){for(let i=0;i<intentos;i++){if(await js(expression))return;await dormir(50);}throw new Error('No llegó el estado: '+expression+'; '+await js("document.querySelector('#error:not([hidden]),#estado:not([hidden])')?.textContent"));}
async function rodar(nombre,texto){
  await js(`(()=>{const r=document.querySelector('.tablero-ropa .rodillo[aria-label="${nombre}"]'),i=[...r.children].findIndex(n=>n.textContent===${JSON.stringify(texto)});if(i<0)throw new Error('Falta opcion');r.children[i].click()})()`);
  await esperar(`document.querySelector('.tablero-ropa .rodillo[aria-label="${nombre}"] .elegida')?.textContent===${JSON.stringify(texto)}`);
  await dormir(400);
}
async function modo(m){await js(`document.getElementById('tab-${m}').click()`);await dormir(350);}
async function buscar(q){await js(`document.getElementById('consulta').value=${JSON.stringify(q)};document.getElementById('busqueda').requestSubmit()`);await dormir(250);}
try{
if(!upcQA)for(const [width,height] of [[360,640],[412,740],[390,844]]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:2.625,mobile:true});
  await cdp('Emulation.setTouchEmulationEnabled',{enabled:true});
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/inventario#capturar`});
  await esperar("!!document.querySelector('.empezar-captura button')");
  await js("localStorage.clear();sessionStorage.clear()");await cdp('Page.reload');
  await esperar("!!document.querySelector('.empezar-captura button')");
  await js("document.querySelector('.empezar-captura button').click()");
  await esperar("document.querySelector('.alternar-camara').getAttribute('aria-pressed')==='true'");
  for(const tipo of ['Mercancía','Ropa']){
    await js(`[...document.querySelectorAll('.tipo-cabecera button')].find(b=>b.textContent==='${tipo}').click()`);
    assert.equal(await js("!!document.querySelector('.barra-captura [aria-label=Grado]:not([hidden])')"),tipo==='Mercancía','Solo MG muestra el selector de grado');
    if(tipo==='Mercancía')await js("document.querySelector('.barra-captura [data-valor=danado]').click()");
    assert.equal(await js('scrollY'),0,'La captura se mide sin desplazar la página');
    const medir=()=>js(`(()=>{const b=document.querySelector('.disparo'),r=b.getBoundingClientRect(),n=document.getElementById('modos').getBoundingClientRect();return {tipo:'${tipo}',width:innerWidth,height:innerHeight,y:r.y,bottom:r.bottom,left:r.left,right:r.right,navY:n.top,visible:!!r.width&&!!r.height,cubierto:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)!==b}})()`);
    const comprobar=g=>{assert.ok(g.visible&&g.y>=0&&g.bottom<=height&&g.left>=0&&g.right<=width,`Disparo dentro del viewport: ${JSON.stringify(g)}`);assert.ok(g.bottom<=g.navY&&!g.cubierto,`Disparo libre de navegación: ${JSON.stringify(g)}`);};
    const geo=await medir();comprobar(geo);medidas.push({nombre:'geometria-captura',pequenos:[],...geo});console.log('Disparo',JSON.stringify(geo));
    await capturar(`458-${tipo.toLowerCase()}-${height}`,width);
    if(tipo==='Ropa'){
      assert.equal(await js("document.querySelector('.disparo').textContent"),'Elige talla');
      assert.equal(await js("document.querySelector('.disparo').getAttribute('aria-disabled')"),'true');
      assert.equal(await js("document.getElementById(document.querySelector('.disparo').getAttribute('aria-describedby')).getAttribute('role')"),'status');
      assert.doesNotMatch(await js("document.getElementById('estado').textContent"),/Falta talla/,'Sin banner de talla');
      await rodar('Precio','$120');
      assert.equal(await js("document.querySelector('.disparo').textContent"),'Elige talla','Elegir precio no omite la talla');
      await js("document.querySelector('.tallas-ropa [data-valor=M]').click()");
      assert.equal(await js("document.querySelector('.disparo').textContent"),'');
      assert.equal(await js("document.querySelector('.disparo').getAttribute('aria-disabled')"),'false');
      await capturar(`458-ropa-lista-${height}`,width);
    }
    await js("window.scrollTo(0,document.documentElement.scrollHeight)");comprobar(await medir());
    assert.ok(await js("document.querySelector('.captura-movil').getBoundingClientRect().bottom<=document.querySelector('.barra-captura').getBoundingClientRect().top"),'El contenido final queda por encima de la barra al desplazar');
    await js('window.scrollTo(0,0)');
  }
  await js("window.pistasQA=document.querySelector('.visor video').srcObject.getTracks();document.querySelector('.alternar-camara').click()");
  assert.equal(await js("pistasQA.every(t=>t.readyState==='ended')"),true,'Apagar detiene todos los tracks');
  assert.equal(await js("document.querySelector('.alternar-camara').getAttribute('aria-pressed')"),'false');
  assert.equal(await js("document.querySelector('.visor video').srcObject"),null);
  assert.equal(await js("document.querySelector('.disparo').getAttribute('aria-disabled')"),'false','Sin cámara permite subir foto');
  await cdp('Page.setInterceptFileChooserDialog',{enabled:true});
  await js("window.archivoQA=0;document.querySelector('input[type=file]').addEventListener('click',()=>archivoQA++);document.querySelector('.disparo').click()");
  assert.equal(await js('archivoQA'),1,'Sin stream usa el archivo, aunque videoWidth conserve el último fotograma');
  await cdp('Page.setInterceptFileChooserDialog',{enabled:false});
  await modo('buscar');await modo('capturar');
  assert.equal(await js("document.querySelector('.visor video').srcObject"),null,'Cambiar de modo conserva apagada');
  await cdp('Page.reload');await esperar("!!document.querySelector('.empezar-captura button')");
  await js("document.querySelector('.empezar-captura button').click()");
  assert.equal(await js("document.querySelector('.visor video').srcObject"),null,'Recargar respeta la elección de sesión');
  await capturar(`458-camara-apagada-${height}`,width);
  await js("document.querySelector('.alternar-camara').click()");
  await esperar("document.querySelector('.alternar-camara').getAttribute('aria-pressed')==='true'");
  await modo('buscar');await modo('capturar');
  await js("document.querySelector('.alternar-camara').click()");
  await esperar("document.querySelector('.alternar-camara').getAttribute('aria-pressed')==='true'");
  if(width===360){
    await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{bottom:24}});
    assert.equal(await js("getComputedStyle(document.getElementById('modos')).paddingBottom"),'24px');
    assert.ok(await js("document.querySelector('.disparo').getBoundingClientRect().bottom<=document.getElementById('modos').getBoundingClientRect().top"),'El área segura no superpone el disparo con la navegación');
    await js("document.getElementById('modos').hidden=true;window.scrollTo(0,document.documentElement.scrollHeight)");
    assert.ok(await js("document.querySelector('.captura-movil').getBoundingClientRect().bottom<=document.querySelector('.barra-captura').getBoundingClientRect().top"),'Con un único modo, el padding incluye el área segura');
    assert.ok(await js('document.querySelector(".disparo").getBoundingClientRect().bottom<=innerHeight-24'));
    await js("document.getElementById('modos').hidden=false;window.scrollTo(0,0)");
    await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{}});
  }
  await js("document.getElementById('menu').click()");
  await js("[...document.querySelectorAll('#hoja button')].find(b=>b.textContent==='⌨ Escribir').click()");
  assert.equal(await js("document.activeElement.id"),'consulta','Escribir sigue accesible desde la cabecera');
}
if(!upcQA){
  await cdp('Emulation.setDeviceMetricsOverride',{width:412,height:740,deviceScaleFactor:2.625,mobile:true});
  for(const rol of ['dueno','capturista','capturista-editor']){
    capturista=rol!=='dueno';editarInventario=rol==='capturista-editor';
    await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/inventario?tarjeta=${rol}#capturar`});
    await esperar("!!document.querySelector('.empezar-captura button')");
    await js("document.querySelector('.empezar-captura button').click();document.querySelector('.tipo-cabecera button').click()");
    await buscar('0191907910414');
    const campos="document.querySelectorAll('.pieza-actual input')";
    assert.deepEqual(await js(`[...${campos}].map(i=>i.value)`),['Lámpara de escritorio','249']);
    assert.deepEqual(await js(`[...${campos}].map(i=>i.readOnly)`),[rol==='capturista',rol!=='dueno'],'Permisos de nombre/precio: '+rol);
    await js("document.querySelector('.pieza-actual').scrollIntoView({block:'start'})");
    await capturar('461-tarjeta-'+rol,412);
    assert.ok(await js("(()=>{const b=document.querySelector('.disparo'),r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=document.getElementById('modos').getBoundingClientRect().top&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b})()"),'Disparo visible con tarjeta: '+rol);
    if(rol==='dueno'){
      await js(`{const [n,p]=${campos};n.value='Termo corregido';n.dispatchEvent(new Event('input'));p.value='187';p.dispatchEvent(new Event('input'));document.querySelector('.pieza-actual .stepper button:last-child').click()}`);
      assert.deepEqual(await js(`[...${campos}].map(i=>i.value)`),['Termo corregido','187'],'Repintar conserva ediciones');
      await js("import('/etiquetera.js').then(m=>m.conectarEtiquetera())");
      await js("[...document.querySelectorAll('.pieza-actual button')].find(b=>/^Guardar/.test(b.textContent)).click()");
      await esperar("blePrueba.enviadas===2");
      const trabajos=await js('blePrueba.trabajos.join("\\n")');assert.match(trabajos,/Termo corregido/);assert.match(trabajos,/"\$187"/);
      assert.deepEqual([registros.at(-1).nombre,registros.at(-1).precio,registros.at(-1).stock],['Termo corregido',18700,2]);
      await js("window.relojQA=Date.now;window.avanceQA=0;Date.now=()=>relojQA()+avanceQA;document.querySelector('.alternar-camara').click()");
      await esperar("!document.querySelector('.visor video').srcObject");
      await js("document.querySelector('.visor').click()");
      await esperar("document.querySelector('.alternar-camara').getAttribute('aria-pressed')==='true'");
      await js("document.getElementById('menu').click()");
      await js("import('/camara-inventario.js').then(m=>{window.minutoQA=m.INACTIVIDAD_CAMARA_MS;avanceQA+=minutoQA*2})");
      await dormir(1200);
      assert.equal(await js("document.querySelector('.alternar-camara').getAttribute('aria-pressed')"),'true','Una hoja suspende el reloj');
      await js("document.getElementById('cerrar-hoja').click()");await dormir(50);
      await js("window.pistasReposoQA=document.querySelector('.visor video').srcObject.getTracks();avanceQA+=minutoQA+1");
      await esperar("document.querySelector('.alternar-camara').getAttribute('aria-pressed')==='false'");
      assert.equal(await js("pistasReposoQA.every(t=>t.readyState==='ended')"),true,'Reposo usa el mismo apagado de tracks');
      assert.match(await js("document.querySelector('.camara-apagada').textContent"),/toca para encender/);
      await capturar('461-camara-en-pausa',412);
      await js("document.querySelector('.visor').click()");
      await esperar("document.querySelector('.alternar-camara').getAttribute('aria-pressed')==='true'");
      await js("document.querySelector('.alternar-camara').click();avanceQA+=minutoQA*2");await dormir(1200);
      assert.equal(await js("document.querySelector('.visor video').srcObject"),null,'El temporizador respeta el apagado manual');
      await js('Date.now=relojQA');
    }
  }
  capturista=false;editarInventario=false;
  await js("sessionStorage.removeItem('inventario-camara')");
}
if(!upcQA){
  // #461 PR B: modo enfocado. Se enciende desde ⋯, dura la sesión y deja a la vista solo lo de la captura en serie.
  const OCULTOS=['#chip-impresora','#chip-celular','#chip-red','#modos','.tira-capturas','.empezar-captura','.captura-movil > ul.lista','.captura-movil > h3','#estado[data-tipo=neutro]'];
  const visible=sel=>js(`[...document.querySelectorAll(${JSON.stringify(sel)})].some(n=>n.getClientRects().length>0&&getComputedStyle(n).visibility!=='hidden')`);
  const enPantalla=sel=>js(`(()=>{const n=document.querySelector(${JSON.stringify(sel)});if(!n)return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth})()`);
  const tecla=async(key,modifiers=0)=>{const code='Digit'+key;await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers,windowsVirtualKeyCode:key.charCodeAt(0)});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers,windowsVirtualKeyCode:key.charCodeAt(0)});};
  const encender=async()=>{await js("document.getElementById('menu').click()");await js("[...document.querySelectorAll('#hoja button')].find(b=>b.textContent==='Modo enfocado').click()");await esperar("document.body.classList.contains('enfocado')");};
  for(const [width,height] of [[360,640],[412,740],[390,844]]){
    await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:2.625,mobile:true});
    await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/inventario?enfocado=${width}#capturar`});
    await esperar("!!document.querySelector('.empezar-captura button')");
    await js("localStorage.clear();sessionStorage.clear()");await cdp('Page.reload');
    await esperar("!!document.querySelector('.empezar-captura button')");
    await js("document.querySelector('.empezar-captura button').click()");
    await esperar("document.querySelector('.alternar-camara').getAttribute('aria-pressed')==='true'");
    assert.equal(await js("document.body.classList.contains('enfocado')"),false,'Empieza apagado');
    assert.equal(await visible('#modos'),true);
    await encender();
    assert.equal(await js("sessionStorage.getItem('inventario-enfocado')"),'true','La elección vive en la sesión');
    assert.equal(await js("document.getElementById('hoja').open"),false,'La hoja del menú se cierra');
    for(const tipo of ['Mercancía','Ropa']){
      await js(`[...document.querySelectorAll('.tipo-cabecera button')].find(b=>b.textContent==='${tipo}').click()`);await dormir(250);
      for(const sel of OCULTOS)assert.equal(await visible(sel),false,`${tipo} ${width}×${height}: «${sel}» sigue a la vista`);
      assert.equal(await js("document.getElementById('estado').textContent.includes('Escanea')&&document.getElementById('estado').getClientRects().length>0"),false,'La línea «Escanea o toma foto» se oculta');
      const salir=await js("(()=>{const b=document.getElementById('salir-enfocado'),r=b.getBoundingClientRect();return {w:r.width,h:r.height,dentro:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,texto:b.textContent.trim()}})()");
      assert.ok(salir.w>=44&&salir.h>=44&&salir.dentro&&salir.texto==='Salir del modo enfocado',`Salida visible y de 44 px: ${JSON.stringify(salir)}`);
      assert.equal(await enPantalla('.disparo'),true,`${tipo} ${width}×${height}: el disparo cabe sin desplazar`);
      assert.equal(await js("(()=>{const b=document.querySelector('.disparo'),r=b.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b&&scrollY===0})()"),true,'Disparo libre de otras capas y sin desplazamiento');
      assert.equal(await enPantalla('.alternar-camara'),true,'El interruptor de la cámara sigue a la vista');
      assert.equal(await enPantalla('.barra-captura .stepper'),true,'La cantidad sigue a la vista');
      assert.equal(await visible('.barra-captura [aria-label=Grado]'),tipo==='Mercancía','El grado A/B/C solo en Mercancía');
      assert.equal(await visible('.tablero-ropa'),tipo==='Ropa');
      if(tipo==='Ropa')for(const sel of ['.rodillo[aria-label=Prenda]','.rodillo[aria-label=Precio]','.marcas-ropa','.tallas-ropa'])assert.equal(await visible(sel),true,`Ropa conserva ${sel}`);
      await capturar(`461-enfocado-${tipo==='Ropa'?'ropa':'mercancia'}-${height}`,width);
    }
    // Mercancía con la tarjeta del manifiesto y la pieza registrada sin foto.
    await js("[...document.querySelectorAll('.tipo-cabecera button')].find(b=>b.textContent==='Mercancía').click()");
    await buscar('0191907910414');
    assert.deepEqual(await js("[...document.querySelectorAll('.pieza-actual input')].map(i=>i.getClientRects().length>0)"),[true,true],'Nombre y precio de la tarjeta siguen a la vista');
    assert.equal(await enPantalla('.disparo'),true,'Con la tarjeta, el disparo sigue a la vista');
    await capturar(`461-enfocado-tarjeta-${height}`,width);
    p.tiene_foto=0;p.foto_key='';
    await buscar('ED-002318');
    assert.equal(await js("[...document.querySelectorAll('.pieza-actual button')].some(b=>b.textContent==='Añadir foto'&&b.getClientRects().length>0)"),true,'«Añadir foto» a la vista para una pieza sin foto');
    await capturar(`461-enfocado-existente-${height}`,width);
    p.tiene_foto=1;p.foto_key='foto';
    await buscar('999999999999');
    assert.equal(await visible('.buscar-internet'),false,'«Buscar en internet» oculto');
    assert.equal(await js("[...document.querySelectorAll('.pieza-actual button')].some(b=>b.textContent==='Tomar foto'&&b.getClientRects().length>0)"),true);
    if(width===412){
      // Línea de alerta: nace con el problema, es role=alert y se va al resolverlo.
      const alerta=async texto=>{await esperar(`!document.getElementById('alerta-enfocado').hidden&&document.getElementById('alerta-enfocado').textContent.includes(${JSON.stringify(texto)})`);
        assert.equal(await js("document.getElementById('alerta-enfocado').getAttribute('role')"),'alert');
        assert.equal(await js("(()=>{const r=document.getElementById('alerta-enfocado').getBoundingClientRect();return r.top>=0&&r.top<120&&r.height>0&&r.height<=64})()"),true,'Línea compacta arriba');};
      const sinAlerta=()=>esperar("document.getElementById('alerta-enfocado').hidden");
      // Las lecturas de arriba guardaron una pieza nueva con la impresora sin conectar: la etiqueta pedida queda como alerta hasta conectarla.
      await alerta('Impresora sin conectar · falta etiqueta');await capturar('461-enfocado-alerta-impresora-412',412);
      await js("import('/etiquetera.js').then(m=>m.conectarEtiquetera())");
      await sinAlerta();
      await js("import('/inventario-ui.js').then(m=>m.mensaje('No se guardó la pieza','error'))");
      await alerta('No se guardó la pieza');assert.equal(await visible('#error'),false,'No hay dos líneas de alerta');await capturar('461-enfocado-alerta-guardado-412',412);
      await js("import('/inventario-ui.js').then(m=>m.mensaje('Listo','ok'))");await sinAlerta();
      // Sin red con fotos por subir.
      await js("Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>false});dispatchEvent(new Event('offline'))");
      await js("document.querySelector('.disparo').click()");
      await alerta('Sin red · 1 sin subir');await capturar('461-enfocado-alerta-sin-red-412',412);
      await js("delete navigator.onLine;dispatchEvent(new Event('online'))");
      await sinAlerta();
    }
    // Salida: botón, teclado y persistencia por sesión.
    await js("document.getElementById('salir-enfocado').click()");
    assert.equal(await js("document.body.classList.contains('enfocado')"),false);
    assert.equal(await visible('#modos'),true,'Sale con la navegación a la vista');
    assert.equal(await js("sessionStorage.getItem('inventario-enfocado')"),'false');
    assert.equal(await js("document.activeElement.id"),'menu');
    assert.equal(await enPantalla('.disparo'),true,`Modo normal ${width}×${height}: el disparo cabe`);
    await tecla('0',1);await esperar("document.body.classList.contains('enfocado')");
    await cdp('Page.reload');await esperar("document.body.classList.contains('enfocado')");
    await esperar("document.querySelector('.alternar-camara')?.getAttribute('aria-pressed')==='true'");
    assert.equal(await visible('.empezar-captura'),false,'Recargar en modo enfocado no vuelve a mostrar la intro y arranca la cámara');
    await tecla('2',1);await esperar("document.getElementById('modo-buscar').hidden===false");
    assert.equal(await js("document.body.classList.contains('enfocado')"),false,'Fuera de Capturar no se aplica');
    assert.equal(await visible('#modos'),true);
    await tecla('1',1);await esperar("document.body.classList.contains('enfocado')");
    await tecla('0',1);await esperar("!document.body.classList.contains('enfocado')");
  }
  await js("sessionStorage.removeItem('inventario-enfocado');sessionStorage.removeItem('inventario-camara')");
}
for(const width of [390,1280]){
  consultaSolo=false;listaVacia=false;falloLista=false;
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:800,deviceScaleFactor:2,mobile:width===390});
  await cdp('Emulation.setTouchEmulationEnabled',{enabled:width===390});
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/inventario?qa=${width}#capturar`});await dormir(600);await js("localStorage.clear()");await cdp('Page.reload');await dormir(1300);
  if(width===390){await capturar('00-empezar',width);await js("document.querySelector('.empezar-captura button').click()");await dormir(600);}
  if(upcQA){
    await buscar('0191907910414');
    await js("document.querySelector('.pieza-actual .stepper button:last-child').click()");
    await js("[...document.querySelectorAll('#modo-capturar button')].find(b=>/^Guardar/.test(b.textContent)).click()");
    await esperar("document.getElementById('estado').textContent.includes('Ya existía · +2 a ED-002318')");
    await capturar('452-01-ya-existia',width);
    await modo('buscar');await buscar('chamarra');await js("document.getElementById('editar').click()");
    await js("window.lecturasUPC=0;document.addEventListener('lectura',()=>lecturasUPC++);document.getElementById('e-upc').value='';document.getElementById('e-upc').focus()");
    for(const key of '12345678901'){await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,text:key});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key});await dormir(15);}
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    assert.equal(await js('lecturasUPC'),0,'El campo UPC no dispara búsqueda');
    assert.equal(await js("document.getElementById('e-upc').value"),'12345678901');
    assert.equal(await js("document.getElementById('hoja').open"),false,'Enter del lector no guarda');
    await js("document.getElementById('e-upc').scrollIntoView({block:'center'})");await capturar('452-02-corregir-upc',width);
    await js("document.getElementById('corregir').requestSubmit()");await esperar("document.getElementById('hoja').open");
    await js("document.querySelector('#hoja .primario').click()");
    await esperar("document.getElementById('hoja-titulo').textContent.startsWith('Ya existe como ED-002319')");
    await capturar('452-03-upc-repetido',width);
    await js("document.querySelector('#hoja .primario').click()");
    await esperar("document.getElementById('hoja-titulo').textContent==='Reetiquetar'");await capturar('452-04-reetiquetar',width);
    await js("document.getElementById('cerrar-hoja').click()");
    await modo('revisar');
    await esperar("!!document.querySelector('[data-estado=repetidas]')");
    await js("document.querySelector('[data-estado=repetidas]').click()");
    assert.equal(await js("document.querySelector('.grupo-repetidas select').value"),p.id);
    await capturar('452-05-repetidas',width);
    await js(`const s=document.querySelector('.grupo-repetidas select');s.value='${destinoUpc.id}';s.dispatchEvent(new Event('change'))`);
    assert.ok(await js("[...document.querySelectorAll('.grupo-repetidas button')].some(b=>b.textContent==='Juntar en ED-002319')"));
    await js("[...document.querySelectorAll('.grupo-repetidas button')].find(b=>b.textContent==='Juntar en ED-002319').click()");
    await capturar('452-06-repetidas-juntar',width);await js("[...document.querySelectorAll('#hoja button')].find(b=>b.textContent==='Cancelar').click()");
    consultaSolo=true;await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/inventario?solo=${width}#revisar`});await dormir(600);
    assert.equal(await js("document.querySelector('[data-estado=repetidas]')"),null,'Sin casilla no se ofrece juntar');
    continue;
  }
  await capturar('01-listo',width);
  if(width===390){
    await js("document.querySelector('.barra-captura [data-valor=liquidacion]').click()");
    await js("[...document.querySelectorAll('[aria-label=\"Tipo de pieza\"] button')].find(b=>b.textContent==='Ropa').click()");
    await capturar('06-ropa-sin-talla',width);
    await js("document.querySelector('.tablero-ropa [data-valor=Niño]').click()");await esperar("!!document.querySelector('#hoja .rodillo .elegida')");
    assert.equal(await js("document.querySelector('#hoja .rodillo .elegida').textContent"),'4 años','Niño abre el rodillo de edades, no una rejilla');
    await capturar('06b-ropa-nino-rodillo',width);
    await js("document.querySelector('#hoja .rodillo').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));document.getElementById('cerrar-hoja').click();document.querySelector('.tablero-ropa [data-valor=Niño]').click()");
    assert.equal(await js("document.querySelector('#hoja .rodillo .elegida').textContent"),'5 años','La edad no vuelve a 4 al reabrir');
    await js("document.getElementById('cerrar-hoja').click()");
    await js("document.querySelector('.tablero-ropa [data-valor=M]').click()");
    await rodar('Prenda','Chamarra');
    assert.equal(await js("document.querySelector('.rodillo[aria-label=Precio] .elegida').textContent"),'$300');
    await rodar('Precio','$120');
    await js("document.querySelector('.marcas-ropa [data-valor=\"Cat & Jack\"]').click()");
    assert.equal(await js("document.querySelector('.rodillo[aria-label=Precio] .elegida').textContent"),'$120','Cambiar marca no borra el precio manual');
    const ropaGeo=await js(`(()=>{const ruedas=[...document.querySelectorAll('.rodillos-ropa .rodillo')].map(r=>r.getBoundingClientRect()),foto=document.querySelector('.visor').getBoundingClientRect(),disparo=document.querySelector('.disparo').getBoundingClientRect();return {alineados:ruedas[0].top===ruedas[1].top,fotoVisible:foto.bottom<=ruedas[0].top,disparo:disparo.bottom,limite:document.getElementById('modos').getBoundingClientRect().top}})()`);
    assert.ok(ropaGeo.alineados&&ropaGeo.fotoVisible,'Rodillos juntos, foto visible');
    assert.ok(ropaGeo.disparo<=ropaGeo.limite,`El disparo no cabe: ${JSON.stringify(ropaGeo)}`);
    await capturar('05-ropa-completa',width);
    await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'},{name:'prefers-reduced-motion',value:'reduce'}]});
    await rodar('Precio','$100');await rodar('Precio','$120');await capturar('05b-ropa-oscuro',width);
    await cdp('Emulation.setEmulatedMedia',{features:[]});
    await cdp('Network.enable');await cdp('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await js("document.querySelector('.disparo').click()");await esperar("!!document.querySelector('.miniatura.local')");await capturar('07-sin-red',width);
    await js("document.querySelector('.disparo').click()");await esperar("document.querySelectorAll('.miniatura.local').length===2",300);
    const locales=await js("import('/cola-fotos.js').then(m=>m.pendientes()).then(rs=>rs.map(r=>({prenda:r.prenda,marca:r.marca,talla:r.talla,precio:r.precio_ropa,estado:r.estado_fisico})))");
    assert.deepEqual(locales,Array.from({length:2},()=>({prenda:'Chamarra',marca:'Cat & Jack',talla:'M',precio:12000,estado:'nuevo'})), 'Dos piezas conservan el precio manual y los campos enviados');
    await js("document.querySelector('.miniatura.local').click()");assert.equal(await js("document.querySelector('#hoja [aria-label=Grado]')"),null,'Corregir Ropa local no ofrece grado');await capturar('08-corregir',width);await js("document.getElementById('cerrar-hoja').click()");
    await cdp('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await esperar('navigator.onLine');await dormir(350);
    await cdp('Page.reload');await esperar("!!document.querySelector('.empezar-captura button')");
    await js("document.querySelector('.empezar-captura button').click()");
    await esperar("document.querySelector('.rodillo[aria-label=Precio] .elegida')?.textContent==='$120'");
    assert.equal(await js("document.querySelector('.rodillo[aria-label=Prenda] .elegida').textContent"),'Chamarra');
    assert.equal(await js("document.querySelector('.marcas-ropa [aria-pressed=true]').textContent"),'Cat & Jack');
    assert.equal(await js("document.querySelector('.tallas-ropa [aria-pressed=true]')"),null,'La talla no se guarda al recargar');
    await capturar('05c-ropa-recordada',width);
    await esperar("!!document.querySelector('.miniatura.subida')");
    await js("document.querySelector('.miniatura.subida').click()");await esperar("document.getElementById('hoja').open");
    assert.equal(await js("document.querySelector('#hoja [aria-label=Grado]')"),null,'Corregir Ropa subida no ofrece grado');
    await js("document.getElementById('cerrar-hoja').click()");
  }
  if(width===1280){
    await js("document.querySelector('#modo-capturar [aria-label=Grado] [data-valor=danado]').click();[...document.querySelectorAll('#modo-capturar [aria-label=\"Tipo de pieza\"] button')].find(b=>b.textContent==='Ropa').click()");
    assert.equal(await js("document.querySelector('#modo-capturar [aria-label=Grado]').hidden"),true,'PC: Ropa oculta grado');
    await js("document.querySelector('.tablero-ropa [data-valor=M]').click();document.querySelector('.tablero-ropa [aria-label=Precio] [data-valor=\"12000\"]').click()");
    await js("[...document.querySelectorAll('#modo-capturar button')].find(b=>b.textContent==='Producto sin código: foto con celular').click()");
    await esperar("document.querySelector('.panel-celular')?.textContent.includes('Esperando al celular')");
    assert.equal(globalThis.solicitud.params.estado_fisico,'nuevo','PC: la foto remota de Ropa usa nuevo');
    await js("document.querySelector('.panel-celular button').click()");
    await esperar("!document.querySelector('.panel-celular')");
    await js("[...document.querySelectorAll('#modo-capturar button')].find(b=>b.textContent==='Mercancía').click()");await js("[...document.querySelectorAll('#modo-capturar button')].find(b=>b.textContent==='Producto sin código: foto con celular').click()");await capturar('10-esperando-celular',width);await dormir(8500);await capturar('10-celular-no-responde',width);await js("document.querySelector('.panel-celular button').click()");
  }
  await buscar('0191907910414');await capturar('02-codigo-nuevo',width);
  await buscar('012345678905');await capturar('03-ya-existe',width);
  await buscar('999999999999');await capturar('04-sin-registro',width);
  await modo('buscar');await esperar("document.querySelectorAll('#resultados .resultado').length===25");
  assert.equal(await js("document.getElementById('consulta').inputMode"),'search');
  assert.equal(await js("document.getElementById('consulta').placeholder"),'ED-, nombre o UPC');
  assert.match(await js("document.getElementById('resumen').textContent"),/Todo el inventario/);
  assert.equal(await js("document.getElementById('mas').hidden"),false);
  assert.match(await js("document.getElementById('estado').textContent"),/Busca por código o nombre/,'El resumen es la única fuente tras cargar');
  assert.doesNotMatch(await js("document.getElementById('estado').textContent"),/Resultados listos/);
  const geo=await js(`(()=>{const tope=document.getElementById('modos').getBoundingClientRect().top,f=[...document.querySelectorAll('#resultados>li')].map(l=>l.getBoundingClientRect());const i=document.getElementById('consulta'),c=document.createElement('canvas').getContext('2d'),e=getComputedStyle(i,'::placeholder');c.font=e.fontWeight+' '+e.fontSize+' '+e.fontFamily;const cs=getComputedStyle(i);return {visibles:innerWidth<1000?f.filter(r=>r.top>=0&&r.bottom<=tope).length:f.filter(r=>r.bottom<=innerHeight).length,alto:f[0].height,columnas:new Set(f.filter(r=>r.top===f[0].top).map(r=>Math.round(r.left))).size,anchoLista:Math.round(f[0].width),placeholder:c.measureText(i.placeholder).width,libre:i.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)-20,fuente:parseFloat(cs.fontSize)}})()`);
  medidas.push({nombre:'geometria-buscar',width,pequenos:[],...geo});
  assert.ok(geo.alto>=64&&geo.alto<=88,`Fila compacta: ${geo.alto}`);assert.ok(geo.fuente>=16);
  if(width===390)assert.ok(geo.visibles>=6,`Piezas visibles en 390: ${geo.visibles}`);
  if(width===1280)assert.ok(geo.columnas>=3,`Rejilla en PC: ${geo.columnas} columnas`);
  if(width>=390)assert.ok(geo.placeholder<=geo.libre,`El placeholder no cabe: ${geo.placeholder} > ${geo.libre}`);
  const bajos=await js(`(()=>{const lum=c=>{const [r,g,b]=c.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4});return .2126*r+.7152*g+.0722*b};const fondo=el=>{for(;el;el=el.parentElement){const c=getComputedStyle(el).backgroundColor;if(!/rgba\\(0, 0, 0, 0\\)|transparent/.test(c))return c}return 'rgb(255,255,255)'};const mala=[];for(const el of document.querySelectorAll('#resumen,#resultados code,#resultados b,#resultados small,#resultados .insignia,#consulta,.txt-reimprimir')){const a=lum(getComputedStyle(el).color),b=lum(fondo(el)),r=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);if(r<4.5)mala.push(el.className+el.tagName+r.toFixed(2))}const i=document.getElementById('consulta');const ph=lum(getComputedStyle(i,'::placeholder').color),bf=lum(fondo(i)),rp=(Math.max(ph,bf)+.05)/(Math.min(ph,bf)+.05);if(rp<4.5)mala.push('placeholder'+rp.toFixed(2));return mala})()`);
  assert.deepEqual(bajos,[],'Contraste menor de 4.5');
  await capturar('19-buscar-lista-completa',width);
  const antesCorto=consultas.length;
  await js("const input=document.getElementById('consulta');input.value='ab';input.dispatchEvent(new Event('input'))");await dormir(350);
  assert.equal(consultas.length,antesCorto,'Una o dos letras no consultan');
  assert.match(await js("document.getElementById('estado').textContent"),/Escribe 3 letras o un código/);
  await js("document.getElementById('mas').scrollIntoView({block:'center'})");await esperar("document.querySelectorAll('#resultados .resultado').length===50");
  await js("document.getElementById('mas').click()");await esperar("document.querySelectorAll('#resultados .resultado').length===61");
  assert.equal(await js("new Set([...document.querySelectorAll('#resultados .resultado')].map(b=>b.dataset.id)).size"),61);
  assert.equal(await js("document.getElementById('mas').hidden"),true);
  await js("window.scrollTo(0,0);document.getElementById('consulta').value='chamarra';document.getElementById('consulta').dispatchEvent(new Event('input'))");
  const antesDebounce=consultas.length;await dormir(100);assert.equal(consultas.length,antesDebounce);
  await esperar("document.getElementById('resumen').textContent.includes('1 resultado')");
  assert.equal(await js("document.getElementById('ficha').hidden"),true,'El filtro escrito no abre la ficha');
  await capturar('20-buscar-filtrado',width);
  assert.equal(await js("document.querySelector('#resultados .resultado code').textContent"),'ED-002318');
  assert.equal(await js("document.querySelectorAll('#resultados .resultado button').length"),0);
  await js("blePrueba.cancelar=true;document.querySelector('#resultados .reimprimir-pieza').click()");
  await esperar("document.querySelector('#resultados .reimprimir-pieza').getAttribute('aria-disabled')==='false'");
  assert.equal(await js('blePrueba.enviadas'),0,'Cancelar la conexión no imprime ni anuncia envío');
  assert.doesNotMatch(await js("document.getElementById('estado').textContent"),/Etiqueta enviada/);
  await js("blePrueba.cancelar=false;{const b=document.querySelector('#resultados .reimprimir-pieza');b.click();b.click();window.bloqueadaQA=b.getAttribute('aria-disabled')}");
  assert.equal(await js('bloqueadaQA'),'true');
  await esperar("document.getElementById('estado').textContent.includes('Etiqueta enviada · ED-002318')");
  assert.equal(await js('blePrueba.enviadas'),1,'Un doble toque envía una sola copia');
  assert.doesNotMatch(await js('blePrueba.trabajos[0]'),/^BOX |,"4",0,1,1,"[ABC]"/m,'Reimprimir desde Buscar omite grado en Ropa');
  assert.equal(await js("document.getElementById('ficha').hidden"),true,'Reimprimir no abre ficha');
  await capturar('21-tarjeta-reimprimir',width);
  await js("document.querySelector('#resultados .resultado').focus()");
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await js("document.activeElement.classList.contains('reimprimir-pieza')"),true);
  assert.ok(await js("parseFloat(getComputedStyle(document.activeElement).outlineWidth)>=3"),'Foco visible de al menos 3 px');
  assert.match(await js("document.activeElement.getAttribute('aria-label')"),/^Reimprimir etiqueta ED-002318$/);
  await capturar('22-reimprimir-foco',width);
  await js("document.querySelector('#resultados .resultado').focus()");
  assert.ok(await js("parseFloat(getComputedStyle(document.activeElement).outlineWidth)>=3"),'Foco visible en el botón principal');
  await capturar('23-ficha-foco',width);
  await js("document.getElementById('consulta').value='lámpara';document.getElementById('consulta').dispatchEvent(new Event('input'))");
  await esperar("document.getElementById('resumen').textContent.includes('25+ resultados')");
  await js("document.getElementById('consulta').value='vieja';document.getElementById('consulta').dispatchEvent(new Event('input'))");await dormir(300);
  await js("document.getElementById('consulta').value='chamarra';document.getElementById('consulta').dispatchEvent(new Event('input'))");await dormir(900);
  assert.match(await js("document.getElementById('resumen').textContent"),/1 resultado para «chamarra»/);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await esperar("document.getElementById('resumen').textContent.includes('Todo el inventario')");
  await buscar('chamarra');assert.doesNotMatch(await js("document.getElementById('detalles').textContent"),/[ABC] ·|grado/,'Ficha de Ropa sin grado');await capturar('11-ficha',width);
  await js("window.lecturasQA=[];window.clicksQA=0;document.addEventListener('lectura',e=>lecturasQA.push(e.detail));const b=document.getElementById('editar');b.addEventListener('click',()=>clicksQA++);b.focus()");
  for(const key of '012345678905'){await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,text:key});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key});await dormir(15);}
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await dormir(200);
  assert.equal(await js('lecturasQA.length'),1);assert.equal(await js('clicksQA'),0);assert.equal(await js('lecturasQA[0].codigo'),'012345678905');

  await js("document.getElementById('chip-red').click()");await capturar('17-red',width);await js("document.getElementById('cerrar-hoja').click()");
  await js("document.getElementById('menu').click()");await capturar('18-menu',width);await js("document.getElementById('cerrar-hoja').click()");
  await modo('revisar');await js("document.querySelector('#modo-revisar [data-estado=todas]').click()");
  assert.doesNotMatch(await js("[...document.querySelectorAll('.fila-revision')].find(l=>l.querySelector('.resultado')?.dataset.id==='11111111-1111-4111-8111-111111111111').textContent"),/[ABC] ·/,'Revisar: Ropa sin grado');
  assert.match(await js("[...document.querySelectorAll('.fila-revision')].find(l=>l.querySelector('.resultado')?.dataset.id==='22222222-2222-4222-8222-222222222222').textContent"),/A · Nuevo/,'Revisar: MG conserva grado');
  await js("[...document.querySelectorAll('.fila-revision .resultado')].find(b=>b.dataset.id==='11111111-1111-4111-8111-111111111111').click()");
  await esperar("!!document.querySelector('#detalle-revisar [data-grado]')");
  assert.equal(await js("document.querySelector('#detalle-revisar [data-grado]').hidden"),true,'Avanzado oculta grado para Ropa');
  await js("const s=[...document.querySelectorAll('#detalle-revisar select')].find(s=>[...s.options].some(o=>o.value==='hogar'));s.value='hogar';s.dispatchEvent(new Event('change'))");
  assert.equal(await js("document.querySelector('#detalle-revisar [data-grado]').hidden"),false,'Cambiar a MG recupera grado');
  if(width===390)await js("document.getElementById('volver').click()");
  await js("document.querySelector('#modo-revisar .fila-revision input[type=checkbox]').click()");await capturar('12-revisar-seleccion',width);
  listaVacia=true;await modo('buscar');await modo('revisar');await capturar('13-revisar-vacio',width);
  falloLista=true;listaVacia=false;await modo('buscar');await modo('revisar');await capturar('13-revisar-error',width);falloLista=false;
  await modo('imprimir');await capturar('14-impresora-desconectada',width);
  await js("document.getElementById('chip-impresora').click()");await capturar('17-impresora',width);await js("document.getElementById('cerrar-hoja').click()");
  await js("document.getElementById('conectar-impresora').click()");await dormir(100);await js("window.inicioTandaQA=blePrueba.enviadas;blePrueba.fallarDesde=inicioTandaQA+4;document.querySelector('#modo-imprimir #imprimir').click()");await dormir(200);await capturar('15-enviando',width);await dormir(6000);await capturar('15-corte-parcial',width);assert.equal(await js('blePrueba.enviadas-inicioTandaQA'),4,'El corte simulado debe ocurrir tras cuatro etiquetas');
  await js("document.getElementById('tab-bandas').click()");await capturar('16-bandas',width);
  if(width===390){await cdp('Browser.setPermission',{permission:{name:'camera'},setting:'denied',origin:`http://127.0.0.1:${port}`});await modo('capturar');await js("navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denegada','NotAllowedError')};[...document.querySelectorAll('.visor button')].find(b=>b.textContent==='Reanudar').click()");await dormir(200);await capturar('09-camara-bloqueada',width);assert.match(await js("document.getElementById('error').innerText"),/Cámara bloqueada/);await cdp('Browser.resetPermissions');}
  consultaSolo=true;
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/inventario?consulta=${width}#buscar`});await dormir(600);await buscar('chamarra');await capturar('11-solo-consulta',width);
  assert.equal(await js("document.getElementById('menos').hidden&&document.getElementById('edicion').hidden"),true);
  await modo('revisar');await js("document.querySelector('#modo-revisar [data-estado=todas]').click()");await capturar('12-solo-consulta',width);assert.equal(await js("document.querySelectorAll('#modo-revisar input[type=checkbox]').length"),0);
}
if(!upcQA){
await cdp('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:2,mobile:true});
await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/inventario?reflujo=320#buscar`});await dormir(500);await capturar('19-reflujo-lista',320);
await js("document.getElementById('consulta').value='chamarra';document.getElementById('consulta').dispatchEvent(new Event('input'))");
await esperar("document.getElementById('resumen').textContent.includes('1 resultado')");await capturar('20-reflujo-filtrado',320);
await buscar('chamarra');await capturar('11-reflujo',320);
consultaSolo=false;
await js("import('/etiquetera.js').then(m=>m.marcarImpresa('11111111-1111-4111-8111-111111111111',new Date().toISOString(),{precio:45000,precio_lista:60000,nombre:'Nombre anterior',talla:'M',estado_fisico:'danado'}))");
for(const ruta of ['/inventario#imprimir','/etiquetas']){
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}${ruta}`});
  await esperar("document.body.textContent.includes('La pegada dice')||document.body.textContent.includes('La etiqueta pegada dice')");
  const aviso=await js("[...document.querySelectorAll('small,.marca.aviso')].find(n=>/La (etiqueta )?pegada dice/.test(n.textContent)).textContent");
  assert.match(aviso,/Nombre anterior/);assert.doesNotMatch(aviso,/grado|[ABC] ·/,'Avisos de Imprimir y /etiquetas sin grado en Ropa');
}
}
await writeFile(path.join(salida,'medidas.json'),JSON.stringify({errores,medidas},null,2));
assert.deepEqual(errores,[]);const pequenos=medidas.flatMap(d=>d.pequenos.map(p=>({...p,estado:d.nombre,width:d.width})));assert.deepEqual(pequenos,[],'Objetivos menores de 44 px');console.log(`QA: ${medidas.length} capturas; sin desborde, objetivos >=44 px, sin errores de JavaScript`);
}catch(e){console.error('Errores de página:',errores);throw e;}finally{await cdp('Browser.close').catch(()=>{});ws.close();server.close();chrome.kill();await dormir(400);await rm(perfil,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
