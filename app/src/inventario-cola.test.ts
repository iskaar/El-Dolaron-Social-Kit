import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { registroFoto, crearSubida, formularioPendiente } from '../public/foto-pendiente.js';
import { crearCamara } from '../public/camara-inventario.js';
import { permitidaParaVendedor } from './worker.ts';
import { PRENDAS_ROPA, MARCAS_ROPA, PRECIO_PRENDA, PRECIOS_ROPA } from '../public/ropa.js';
import { TALLAS_ADULTO, EDADES_NINO, TALLAS_NINO } from '../public/tallas.js';

function ropaUI(bloquearAlmacenamiento=false) {
  class Nodo {
    textContent='';className='';dataset:Record<string,string>={};children:Nodo[]=[];atributos:Record<string,string>={};eventos:Record<string,Function>={};
    scrollTop=0;offsetHeight=44;onclick:Function=()=>{};onkeydown:Function=()=>{};
    classList={toggle:(c:string,activa:boolean)=>{const clases=new Set(this.className.split(' ').filter(Boolean));activa?clases.add(c):clases.delete(c);this.className=[...clases].join(' ');},add:(c:string)=>this.classList.toggle(c,true),remove:(c:string)=>this.classList.toggle(c,false)};
    get firstElementChild(){return this.children[0];}
    append(...n:Nodo[]){this.children.push(...n);}
    setAttribute(k:string,v:string){this.atributos[k]=v;}
    getAttribute(k:string){return this.atributos[k];}
    removeAttribute(k:string){delete this.atributos[k];}
    addEventListener(e:string,fn:Function){this.eventos[e]=fn;}
    scrollTo({top}:{top:number}){this.scrollTop=top;}
  }
  const almacen=new Map<string,string>(),hojas:Nodo[]=[];
  const fuente=readFileSync('public/inventario-ropa.js','utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export ','');
  const ui=runInNewContext(fuente+';({ropa,talla,rodillo})',{
    PRENDAS_ROPA,MARCAS_ROPA,PRECIO_PRENDA,PRECIOS_ROPA,TALLAS_ADULTO,EDADES_NINO,TALLAS_NINO,
    nodo:(_tag:string,texto='',clase='')=>Object.assign(new Nodo(),{textContent:texto,className:clase}),
    boton:(texto:string,accion:Function)=>Object.assign(new Nodo(),{textContent:texto,onclick:accion}),
    hoja:(_titulo:string,c:Nodo)=>hojas.push(c),cerrarHoja(){},matchMedia:()=>({matches:true}),
    localStorage:{getItem:(k:string)=>{if(bloquearAlmacenamiento)throw new Error('Sin almacenamiento');return almacen.get(k)??null;},setItem:(k:string,v:string)=>{if(bloquearAlmacenamiento)throw new Error('Sin almacenamiento');almacen.set(k,String(v));}}
  });
  const buscar=(raiz:Nodo,nombre:string):Nodo|undefined=>raiz.getAttribute('aria-label')===nombre?raiz:raiz.children.map(n=>buscar(n,nombre)).find(Boolean);
  const desplazar=(rueda:Nodo,i:number)=>{rueda.scrollTop=i*rueda.children[0].offsetHeight;rueda.eventos.scroll();};
  return {...ui,almacen,hojas,buscar,desplazar};
}

test('rodillos de ropa sugieren precio por prenda y conservan el ajuste manual entre piezas y recargas (#458)',()=>{
  const ui=ropaUI(),tablero=ui.ropa({pc:()=>false,mensaje:()=>{}});tablero.sincronizar();
  const prenda=ui.buscar(tablero.raiz,'Prenda')!,precio=ui.buscar(tablero.raiz,'Precio')!,tallas=ui.buscar(tablero.raiz,'Talla')!;
  assert.equal(prenda.children[0].textContent,'Sin prenda');
  for(const nombre of PRENDAS_ROPA){
    ui.desplazar(prenda,PRENDAS_ROPA.indexOf(nombre)+1);
    assert.equal(tablero.valores().precio_ropa,PRECIO_PRENDA[nombre]);
    assert.equal(precio.children.find(n=>n.getAttribute('aria-selected')==='true')!.textContent,`$${PRECIO_PRENDA[nombre]/100}`);
  }
  ui.desplazar(prenda,PRENDAS_ROPA.indexOf('Chamarra')+1);
  ui.desplazar(precio,PRECIOS_ROPA.indexOf(12000));
  ui.buscar(tablero.raiz,'Marca')!.children[2].onclick();
  tallas.children[0].children.find(n=>n.dataset.valor==='M')!.onclick();
  assert.equal(tablero.valores().precio_ropa,12000);assert.equal(tablero.valores().marca,'Cat & Jack');
  assert.equal(ui.buscar(tablero.raiz,'Talla'),tallas,'Los cambios conservan el control de talla montado');
  const enviado=formularioPendiente(registroFoto(new Blob(['foto']),tablero.valores()));
  assert.equal(enviado.get('precio_ropa'),'12000');assert.equal(enviado.get('prenda'),'Chamarra');assert.equal(enviado.get('marca'),'Cat & Jack');assert.equal(enviado.get('talla'),'M');
  const siguiente=ui.ropa({pc:()=>false,mensaje:()=>{}});siguiente.sincronizar();
  assert.equal(siguiente.valores().prenda,'Chamarra');assert.equal(siguiente.valores().marca,'Cat & Jack');assert.equal(siguiente.valores().precio_ropa,12000);
  assert.equal(siguiente.valores().talla,'','La talla no persiste tras recargar');
  ui.desplazar(ui.buscar(siguiente.raiz,'Prenda')!,0);assert.equal(siguiente.valores().prenda,'');assert.equal(siguiente.valores().precio_ropa,12000);
  const almacenAntes=[...ui.almacen];
  const correccion=ui.ropa({pc:()=>false,mensaje:()=>{},recordar:false,inicial:{prenda:'Playera',marca:'Otra',talla:'S',precio_ropa:8000}});correccion.sincronizar();
  assert.equal(correccion.valores().precio_ropa,8000);ui.desplazar(ui.buscar(correccion.raiz,'Precio')!,0);
  assert.deepEqual([...ui.almacen],almacenAntes,'Corregir una pieza no cambia las preferencias de captura');
});

test('edad conserva teclado, selección accesible y edad de sesión sin reiniciarse al cambiar prenda (#458)',()=>{
  const ui=ropaUI(),tablero=ui.ropa({pc:()=>false,mensaje:()=>{}});tablero.sincronizar();
  const abrir=()=>ui.buscar(tablero.raiz,'Talla')!.children[0].children.find(n=>n.dataset.valor==='Niño')!.onclick();
  abrir();let edad=ui.buscar(ui.hojas.at(-1)!,'Edad')!;
  assert.equal(edad.children.find(n=>n.getAttribute('aria-selected')==='true')!.textContent,'4 años');
  let evitado=false;edad.onkeydown({key:'ArrowDown',preventDefault(){evitado=true;}});assert.ok(evitado);
  assert.equal(tablero.valores().talla,'Niño 5 años');
  ui.desplazar(ui.buscar(tablero.raiz,'Prenda')!,1);abrir();edad=ui.buscar(ui.hojas.at(-1)!,'Edad')!;
  assert.equal(edad.children.find(n=>n.getAttribute('aria-selected')==='true')!.textContent,'5 años');
  const nueva=ui.talla(()=>{});nueva.children[0].children.at(-1)!.onclick();
  assert.equal(ui.buscar(ui.hojas.at(-1)!,'Edad')!.scrollTop,EDADES_NINO.indexOf('5 años')*44);
  const restaurada=ui.talla(()=>{},'Niño 8 años / M');restaurada.children[0].children.at(-1)!.onclick();
  assert.equal(ui.buscar(ui.hojas.at(-1)!,'Edad')!.scrollTop,EDADES_NINO.indexOf('8 años')*44);
  edad.onkeydown({key:'End',preventDefault(){}});assert.equal(edad.getAttribute('role'),'listbox');
  assert.equal(edad.getAttribute('aria-activedescendant'),edad.children.at(-1)!.id);
  edad.onkeydown({key:'Home',preventDefault(){}});assert.equal(edad.scrollTop,0);
});

test('capturar ropa funciona con localStorage bloqueado y permite elegir el primer precio sin desplazar (#458)',()=>{
  const ui=ropaUI(true),tablero=ui.ropa({pc:()=>false,mensaje:()=>{}});tablero.sincronizar();
  const precio=ui.buscar(tablero.raiz,'Precio')!;precio.children[0].onclick();
  assert.equal(tablero.valores().precio_ropa,30000);
  ui.desplazar(ui.buscar(tablero.raiz,'Prenda')!,1);assert.equal(tablero.valores().precio_ropa,10000);
});

test('el disparo pide talla antes que precio y se habilita al completar ambos (#458)',()=>{
  const ui=ropaUI(),avisos:string[]=[],tablero=ui.ropa({pc:()=>false,mensaje:(m:string)=>avisos.push(m)});
  assert.equal(tablero.faltante(),'Falta talla');assert.equal(tablero.validar(),false);
  ui.buscar(tablero.raiz,'Talla')!.children[0].children.find(n=>n.dataset.valor==='M')!.onclick();
  assert.equal(tablero.faltante(),'Falta precio');assert.equal(tablero.validar(),false);
  ui.buscar(tablero.raiz,'Precio')!.children[0].onclick();
  assert.equal(tablero.faltante(),'');assert.equal(tablero.validar(),true);
  assert.deepEqual(avisos,['Falta talla','Falta precio']);
});

test('un registro de Inventario lo sube el código real de /captura, con ropa, talla y centavos intactos',async()=>{
  const registro=registroFoto(new Blob(['foto']),{id:crypto.randomUUID(),precio_ropa:12000,talla:'Niño 6 años / S',prenda:'Chamarra',marca:'Cat & Jack',cantidad:2,estado_fisico:'danado'});
  const cola=new Map([[registro.id,registro]]),sesion=new Map([[registro.id,{...registro,subida:false}]]);let enviado:FormData;
  const html=readFileSync('public/captura.html','utf8');const fuente=html.slice(html.indexOf('async function procesarCola()'),html.indexOf('function actualizarContador()'));
  const subir=runInNewContext(fuente+';procesarCola',{subiendo:false,idSubiendo:null,idActual:null,preciosRopa:[12000],sesion,FormData,
    pendientes:async()=>[...cola.values()],leer:async(id:string)=>cola.get(id),borrar:async(id:string)=>cola.delete(id),
    fetch:async(_ruta:string,o:any)=>{enviado=o.body;return Response.json({id:registro.id,stock:2,talla:registro.talla,precio:12000,estado_analisis:'listo',estado_fisico:'danado'});},
    subidas:0,piezasTotales:2,repintarMiniatura(){},actualizarContador(){},abrirRevision(){},setTimeout(){},document:{getElementById:()=>({textContent:''})}});
  await subir();assert.equal(cola.size,0);
  for(const[k,v]of Object.entries({id:registro.id,precio_ropa:'12000',talla:'Niño 6 años / S',prenda:'Chamarra',marca:'Cat & Jack',cantidad:'2',estado_fisico:'danado'}))assert.equal(enviado!.get(k),v,k);
  assert.equal(enviado!.has('upc'),false);assert.ok(enviado!.get('foto') instanceof File);
});

test('Inventario drena registros de /escanear y /captura; conserva las fotos ante 401, 403, 500 y corte de red',async()=>{
  const originales=[{id:'escaner',foto:new Blob(['foto escaneada']),upc:'0012345678905',desde_escaner:true,cantidad:3,estado_fisico:'liquidacion',creado:Date.now()},
    {id:'captura',foto:new Blob(['prenda']),talla:'M',prenda:'Playera',marca:'Wild Fable',precio_ropa:5000,cantidad:1,estado_fisico:'nuevo',creado:Date.now()}];
  const cola=new Map(originales.map(r=>[r.id,r]));let status=401,red=false;const cuerpos:FormData[]=[];
  const subida=crearSubida({pendientes:async()=>[...cola.values()],leer:async id=>cola.get(id),borrar:async id=>cola.delete(id),enviar:async(_ruta,o)=>{if(red)throw new TypeError('sin red');cuerpos.push(o.body);return Response.json({id:(o.body as FormData).get('id')},{status});}});
  for(status of [401,403,500]){await subida.subir();assert.equal(cola.size,2);}
  status=400;await subida.subir();assert.equal(cola.size,2);assert.equal(cuerpos.length,3+2,'un 400 no bloquea a las demás');
  red=true;await subida.subir();assert.equal(cola.size,2);red=false;status=201;await subida.subir();assert.equal(cola.size,0);
  assert.equal(cuerpos.at(-2)!.get('upc'),'0012345678905');assert.equal(cuerpos.at(-2)!.get('cantidad'),'3');
  assert.equal(cuerpos.at(-1)!.get('precio_ropa'),'5000');assert.equal(cuerpos.at(-1)!.get('marca'),'Wild Fable');
});

test('versión nueva y corrección pendiente no se borran con una respuesta anterior',async()=>{
  const r={...registroFoto(new Blob(['foto']),{id:'ropa',precio_ropa:10000,talla:'M'}),version:0,correccion_ficha:{precio:10000,estado_fisico:'nuevo'}};
  const cola=new Map([[r.id,r]]);let cambiar=true,fallarCorreccion=false;const llamadas:string[]=[];
  const subir=crearSubida({pendientes:async()=>[...cola.values()],leer:async id=>cola.get(id),borrar:async id=>cola.delete(id),enviar:async(ruta,o)=>{
    llamadas.push(ruta);if(ruta.endsWith('/revision'))return Response.json({precio:10000},{status:fallarCorreccion?403:200});
    if(cambiar){cambiar=false;cola.set(r.id,{...r,version:1});}return Response.json({stock:1,precio:10000});
  }});
  assert.equal(await subir.subir(),true);assert.equal(cola.get(r.id)!.version,1);
  fallarCorreccion=true;await subir.subir();assert.equal(cola.size,1);
  fallarCorreccion=false;await subir.subir();assert.equal(cola.size,0);assert.equal(llamadas.filter(r=>r.endsWith('/revision')).length,3);
  const f=formularioPendiente(registroFoto(new Blob(['foto']),{id:'sin-codigo',upc:'',cantidad:2}));assert.equal(f.get('upc'),'');assert.equal(f.get('cantidad'),'2');
});

test('una cámara que termina de abrir tras cambiar de modo detiene todas sus pistas',async(t)=>{
  let resolver:(s:any)=>void=()=>{},paradas=0;const antes=Object.getOwnPropertyDescriptor(globalThis,'navigator'),doc=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>new Promise(r=>resolver=r)}}});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{hidden:false}});
  t.after(()=>{if(antes)Object.defineProperty(globalThis,'navigator',antes);if(doc)Object.defineProperty(globalThis,'document',doc);else delete (globalThis as any).document;});
  const video={srcObject:null,play:async()=>{}};const c=crearCamara({video,alLeer:()=>assert.fail('No debe leer')});const abrir=c.abrir();c.pausar();
  resolver({getTracks:()=>[{stop(){paradas++;}}]});assert.equal(await abrir,false);assert.equal(paradas,1);assert.equal(video.srcObject,null);
});

test('cámara reducida conserva zoom y Code128; pausa el detector y no solapa lecturas al reabrir',async()=>{
  const tareas=new Map<number,Function>(),respuestas:{resolve:Function;reject:Function}[]=[],lecturas:string[]=[],formatos:string[][]=[],solicitudes:any[]=[],ajustes:any[]=[];
  const doc={hidden:false};let hoja=false,id=0,paradas=0,zoomGuardado='1',detecciones=0;
  const video={srcObject:null,play:async()=>{}};
  const fuente=readFileSync('public/camara-inventario.js','utf8').replace('export ','');
  const crear=runInNewContext(fuente+';crearCamara',{
    document:doc,localStorage:{getItem:()=>zoomGuardado},
    navigator:{mediaDevices:{getUserMedia:async(c:any)=>{
      solicitudes.push(c);let zoom=1;
      const pista={stop(){paradas++;},getCapabilities:()=>({zoom:{min:1,max:3}}),getSettings:()=>({zoom}),applyConstraints:async(c:any)=>{ajustes.push(c);zoom=c.advanced[0].zoom;}};
      return {getTracks:()=>[pista],getVideoTracks:()=>[pista]};
    }}},
    BarcodeDetector:class{
      constructor({formats}:{formats:string[]}){formatos.push(formats);}
      detect(v:any){assert.equal(v,video);detecciones++;return new Promise((resolve,reject)=>respuestas.push({resolve,reject}));}
    },
    setTimeout(fn:Function,ms:number){assert.equal(ms,200);tareas.set(++id,fn);return id;},clearTimeout(i:number){tareas.delete(i);},
  });
  const camara=crear({video,puedeLeer:()=>!hoja,alLeer:(codigo:string)=>lecturas.push(codigo)});
  const avanzar=()=>{assert.equal(tareas.size,1);const [i,fn]=[...tareas][0];tareas.delete(i);return fn();};
  const terminar=async(codigos:any[])=>{respuestas.shift()!.resolve(codigos);await new Promise(setImmediate);};
  await camara.abrir();assert.equal(detecciones,1);assert.equal(tareas.size,0,'Espera al detector antes de programar');
  assert.equal(solicitudes[0].video.width.ideal,1280);assert.equal(solicitudes[0].video.width.min,undefined,"Sin min: evita OverconstrainedError");
  assert.equal(solicitudes[0].video.height.ideal,960);assert.equal(solicitudes[0].video.aspectRatio.ideal,4/3);
  assert.equal(solicitudes[0].audio,false);assert.equal(solicitudes[0].video.zoom,true);
  assert.ok(formatos[0].includes('code_128'));assert.equal(ajustes.length,0,'No reaplica el zoom actual');

  zoomGuardado='9';await camara.abrir();assert.equal(detecciones,1,'No solapa el detector anterior');
  assert.equal(ajustes.length,1);assert.equal(ajustes[0].advanced[0].zoom,3,'Respeta el rango del zoom');
  await avanzar();assert.equal(detecciones,1);
  await terminar([{rawValue:'vieja'}]);assert.deepEqual(lecturas,[],'Descarta el stream anterior');
  let pendiente=avanzar();assert.equal(detecciones,2);
  hoja=true;await terminar([{rawValue:'hoja'}]);await pendiente;assert.deepEqual(lecturas,[]);
  await avanzar();assert.equal(detecciones,2,'No detecta con hoja abierta');
  hoja=false;doc.hidden=true;await avanzar();assert.equal(detecciones,2,'No detecta con pestaña oculta');
  doc.hidden=false;pendiente=avanzar();await terminar([{rawValue:'2318'}]);await pendiente;
  assert.deepEqual(lecturas,['2318']);
  pendiente=avanzar();doc.hidden=true;await terminar([{rawValue:'oculta'}]);await pendiente;
  assert.deepEqual(lecturas,['2318'],'Descarta también resultados al ocultarse');
  doc.hidden=false;pendiente=avanzar();respuestas.shift()!.reject(new Error('Fotograma no disponible'));await pendiente;
  pendiente=avanzar();camara.pausar();await terminar([{rawValue:'apagada'}]);await pendiente;
  assert.deepEqual(lecturas,['2318']);assert.equal(tareas.size,0);assert.equal(video.srcObject,null);assert.equal(paradas,2);
});

test('host del capturista sirve las importaciones de Capturar, Buscar y Revisar sin abrir Ajustes ni impresión',()=>{
  for(const archivo of ['inventario.js','inventario-ui.js','inventario-capturar.js','inventario-ropa.js','inventario-celular.js','inventario-revisar.js','inventario-precio.js','foto-pendiente.js','camara-inventario.js','ficha.js','lector.js','foto.js','cola-fotos.js','tallas.js','ropa.js','upc.js','estados.js','sesiones.js','precios-ml.js','compartir.js','envio-etiquetas.js'])assert.equal(permitidaParaVendedor('/'+archivo,'GET'),true,archivo);
  for(const ruta of ['/admin','/api/config','/imprimir-lote.js','/api/etiquetas'])assert.equal(permitidaParaVendedor(ruta,'GET'),false,ruta);
  const fuente=readFileSync('public/cola-fotos.js','utf8');assert.match(fuente,/indexedDB.open\('eldolaron', 1\)/);assert.match(fuente,/createObjectStore\('pendientes', \{ keyPath: 'id' \}\)/);
});
