import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { registroFoto, crearSubida, formularioPendiente } from '../public/foto-pendiente.js';
import { crearCamara } from '../public/camara-inventario.js';
import { permitidaParaVendedor } from './worker.ts';

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

test('host del capturista sirve las importaciones de Capturar, Buscar y Revisar sin abrir Ajustes ni impresión',()=>{
  for(const archivo of ['inventario.js','inventario-ui.js','inventario-capturar.js','inventario-ropa.js','inventario-celular.js','inventario-revisar.js','foto-pendiente.js','camara-inventario.js','ficha.js','lector.js','foto.js','cola-fotos.js','tallas.js','ropa.js','upc.js','estados.js','sesiones.js','precios-ml.js','compartir.js','envio-etiquetas.js'])assert.equal(permitidaParaVendedor('/'+archivo,'GET'),true,archivo);
  for(const ruta of ['/admin','/api/config','/imprimir-lote.js','/api/etiquetas'])assert.equal(permitidaParaVendedor(ruta,'GET'),false,ruta);
  const fuente=readFileSync('public/cola-fotos.js','utf8');assert.match(fuente,/indexedDB.open\('eldolaron', 1\)/);assert.match(fuente,/createObjectStore\('pendientes', \{ keyPath: 'id' \}\)/);
});
