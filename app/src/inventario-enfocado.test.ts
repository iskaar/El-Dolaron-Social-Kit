import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { permitidaParaVendedor } from './worker.ts';
import { alertasCriticas, crearEnfocado, SIN_AVANCE_MS } from '../public/inventario-enfocado.js';

test('modo enfocado: sin problemas no hay línea de alerta',()=>{
  assert.deepEqual(alertasCriticas(),[]);
  assert.deepEqual(alertasCriticas({enLinea:true,sinSubir:2,sinAvanceMs:SIN_AVANCE_MS-1}),[],'Subir con red y avance no alerta');
  assert.deepEqual(alertasCriticas({enLinea:false,sinSubir:0}),[],'Sin red y sin pendientes lo cubre el aviso de la línea de estado');
});

test('modo enfocado: cada problema crítico que quedaba oculto produce su alerta',()=>{
  assert.deepEqual(alertasCriticas({enLinea:false,sinSubir:3}),['▲ Sin red · 3 sin subir']);
  assert.deepEqual(alertasCriticas({sinSubir:2,sinAvanceMs:SIN_AVANCE_MS}),['▲ 2 sin subir · la cola no avanza']);
  assert.deepEqual(alertasCriticas({sinSubir:1,colaError:true}),['■ 1 sin subir · error de envío']);
  assert.deepEqual(alertasCriticas({sinSubir:1,colaError:true,sesion:true}),['■ Tu sesión venció · vuelve a entrar'],'La sesión vencida manda sobre el error genérico');
  assert.deepEqual(alertasCriticas({impresoraFalta:true}),['▲ Impresora sin conectar · falta etiqueta']);
  assert.deepEqual(alertasCriticas({errorGuardado:'■ Sin red: se suma al volver la señal'}),['■ Sin red: se suma al volver la señal']);
});

test('modo enfocado: junta varios problemas en una línea y no repite el error que ya dio la cola',()=>{
  const l=alertasCriticas({enLinea:false,sinSubir:2,impresoraFalta:true,errorGuardado:'■ No se guardó'});
  assert.deepEqual(l,['■ No se guardó','▲ Sin red · 2 sin subir','▲ Impresora sin conectar · falta etiqueta']);
  assert.deepEqual(alertasCriticas({sesion:true,sinSubir:1,errorGuardado:'■ Tu sesión venció · vuelve a entrar'}),['■ Tu sesión venció · vuelve a entrar']);
});

// Doble mínimo del DOM: solo lo que crearEnfocado toca.
function entorno(){
  const nodos:Record<string,any>={};
  for(const id of ['alerta-enfocado','error','salir-enfocado','menu','modos'])nodos[id]={hidden:true,textContent:'',focus(){this.enfocado=true;}};
  const clases=new Set<string>(),almacen=new Map<string,string>(),g=globalThis as any;
  g.document={body:{classList:{toggle:(c:string,on:boolean)=>on?clases.add(c):clases.delete(c)}}};
  g.sessionStorage={getItem:(k:string)=>almacen.get(k)??null,setItem:(k:string,v:string)=>{almacen.set(k,v);}};
  g.MutationObserver=class{observe(){}};g.addEventListener=()=>{};g.setInterval=()=>0;
  Object.defineProperty(g,'navigator',{value:{onLine:true},configurable:true});
  return {$:(id:string)=>nodos[id],nodos,clases,almacen};
}

test('modo enfocado: la elección dura la sesión, solo aplica en Capturar del celular y la alerta nace y muere con el problema',()=>{
  const e=entorno();let aplica=true,cambios:boolean[]=[];const problemas:any={};
  const m=crearEnfocado({$:e.$,problemas,aplica:()=>aplica,alCambiar:on=>cambios.push(on)});
  assert.equal(m.activo(),false);assert.equal(e.clases.has('enfocado'),false);
  m.poner(true);
  assert.equal(e.clases.has('enfocado'),true);assert.equal(e.nodos['salir-enfocado'].hidden,false,'La salida se ve');assert.equal(e.almacen.get('inventario-enfocado'),'true');assert.deepEqual(cambios,[true]);
  assert.equal(e.nodos['alerta-enfocado'].hidden,true);
  problemas.cola=()=>({sinSubir:2,sinAvanceMs:0,colaError:true,sesion:false});m.pintar();
  assert.equal(e.nodos['alerta-enfocado'].hidden,false);assert.equal(e.nodos['alerta-enfocado'].textContent,'■ 2 sin subir · error de envío');
  problemas.cola=()=>({sinSubir:0,sinAvanceMs:0,colaError:false,sesion:false});e.nodos.error.hidden=false;e.nodos.error.textContent='■ No se guardó';m.pintar();
  assert.equal(e.nodos['alerta-enfocado'].textContent,'■ No se guardó','El error de guardado se refleja en la línea única');
  e.nodos.error.hidden=true;m.pintar();assert.equal(e.nodos['alerta-enfocado'].hidden,true,'Sin problema no hay línea');
  aplica=false;m.aplicar();
  assert.equal(e.clases.has('enfocado'),false,'Fuera de Capturar el modo no se aplica');assert.equal(m.activo(),true,'pero la elección de la sesión se conserva');
  aplica=true;m.aplicar();assert.equal(e.clases.has('enfocado'),true);
  m.poner(false);
  assert.equal(e.clases.has('enfocado'),false);assert.equal(e.nodos['salir-enfocado'].hidden,true);assert.equal(e.almacen.get('inventario-enfocado'),'false');assert.equal(e.nodos.menu.enfocado,true,'El foco vuelve al menú');
  aplica=false;m.poner(true);assert.equal(m.activo(),false,'En PC no se puede encender');
});

test('modo enfocado: sessionStorage bloqueado no rompe y la sesión recuerda la elección',()=>{
  const e=entorno();(globalThis as any).sessionStorage={getItem(){throw new Error('bloqueado');},setItem(){throw new Error('bloqueado');}};
  const m=crearEnfocado({$:e.$,problemas:{},aplica:()=>true,alCambiar(){}});
  m.poner(true);assert.equal(m.activo(),true);
  const e2=entorno();e2.almacen.set('inventario-enfocado','true');
  assert.equal(crearEnfocado({$:e2.$,problemas:{},aplica:()=>true,alCambiar(){}}).activo(),true);
});

test('modo enfocado: el host del capturista sirve el módulo y este no toca el almacenamiento de datos',()=>{
  assert.equal(permitidaParaVendedor('/inventario-enfocado.js','GET'),true);
  const fuente=readFileSync('public/inventario-enfocado.js','utf8');
  assert.doesNotMatch(fuente,/localStorage|indexedDB/);
});

test('modo enfocado (#464): el host del capturista también imprime, así que una etiqueta sin impresora conectada también alerta', async()=>{
  const { readFileSync }=await import('node:fs'),{ runInNewContext }=await import('node:vm');
  const fuente=readFileSync('public/inventario-capturar.js','utf8');
  const trozo=fuente.slice(fuente.indexOf('let impresionPedida=false;'),fuente.indexOf('const flujo=crearCaptura'));
  for(const vendedor of [true,false]){
    let lista=false;const envios:any[]=[];
    const ctx:any={identidad:{vendedor},problemas:{},etiqueteraLista:()=>lista,imprimir:async(...a:any[])=>{envios.push(a);return true;}};
    ctx.ctx=ctx;
    const imprimir=runInNewContext(`${trozo};imprimir`,{ctx,etiqueteraLista:()=>lista,Map});
    assert.equal(await imprimir('a',1),false,'sin impresora no sale');
    assert.equal(ctx.problemas.impresora(),true,`alerta pedida (vendedor=${vendedor})`);
    lista=true;
    assert.equal(await imprimir('a',2,{reimprimir:true}),true,'con impresora sale también en el host del capturista');
    assert.equal(envios.length,1);assert.equal(ctx.problemas.impresora(),false);
  }
});
