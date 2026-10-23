import test from 'node:test';
import assert from 'node:assert/strict';
import { crearCaptura } from '../public/inventario-capturar.js';
import { tienda, PRODUCTO } from './prueba-d1.ts';

test('Capturar +1 usa rastro D1, un UUID por operación y exactamente una etiqueta; sin red no escribe',async(t0)=>{
  const t=tienda();t0.after(()=>t.db.close());
  const impresiones:any[]=[],llamadas:any[]=[];let sinRed=false,perderRespuesta=true;
  const api=async(ruta:string,cuerpo?:any)=>{llamadas.push({ruta,cuerpo});const r=await t.pedir(ruta,cuerpo);if(r.status>=400)throw Object.assign(new Error(r.cuerpo.error),{status:r.status});
    if(ruta.endsWith('/existencia')&&perderRespuesta){perderRespuesta=false;throw new TypeError('Respuesta perdida');}return r.cuerpo;};
  const flujo=crearCaptura({api,imprimir:async(id,n)=>{impresiones.push({id,n});return true;},enLinea:()=>!sinRed});
  const p=(await t.pedir(`/api/piezas/${PRODUCTO}`)).cuerpo.pieza; const antes=p.stock;
  sinRed=true;await assert.rejects(flujo.sumar(p),/Sin red/);assert.equal(llamadas.length,0);sinRed=false;
  await assert.rejects(flujo.sumar(p),/Respuesta perdida/);
  assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock,antes+1);
  await flujo.sumar(p);
  assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock,antes+1);
  assert.equal(llamadas[0].cuerpo.id,llamadas[1].cuerpo.id);
  assert.deepEqual(impresiones,[{id:PRODUCTO,n:1}]);
  await flujo.sumar(p);assert.notEqual(llamadas[2].cuerpo.id,llamadas[1].cuerpo.id);
  assert.equal(t.db.prepare('select count(*) n from conteo_ajustes where producto_id=?').get(PRODUCTO)!.n,2);
  await t.esperar();
});

test('ED- y nombre no crean; UPC nuevo acumula alias, guarda con UUID estable y el precio lo da el servidor',async()=>{
  let id=0,falla=true;const llamadas:any[]=[],impresas:any[]=[];
  const api=async(ruta:string,cuerpo?:any)=>{
    llamadas.push({ruta,cuerpo});if(ruta.startsWith('/api/piezas?'))return {piezas:[],siguiente:null};
    if(ruta.startsWith('/api/manifiesto/'))return {nombre:'Lámpara',precio:24900};
    if(falla)throw new TypeError('Sin red');return {id:cuerpo.id,nombre:'Lámpara',stock:cuerpo.stock,precio:24900};
  };
  const flujo=crearCaptura({api,imprimir:async(id,n)=>{impresas.push({id,n});return true;},enLinea:()=>true,uuid:()=>`uuid-${++id}`});
  await flujo.leer('ED-002318');assert.equal(flujo.actual(),null);
  await flujo.leer('chamarra');assert.equal(flujo.actual(),null);
  assert.equal(llamadas.some(l=>l.ruta.startsWith('/api/manifiesto')),false);
  await flujo.leer('012345678905');await flujo.leer('12345678905');assert.equal(flujo.actual()!.cantidad,2);
  await assert.rejects(flujo.guardar(),/Sin red/);const uuid=flujo.actual()!.id;
  falla=false;await flujo.guardar();const guardados=llamadas.filter(l=>l.ruta==='/api/borradores/upc');
  assert.equal(guardados.length,2);assert.equal(guardados[0].cuerpo.id,uuid);assert.equal(guardados[1].cuerpo.id,uuid);
  assert.deepEqual(Object.keys(guardados[0].cuerpo).sort(),['estado_fisico','id','stock','upc']);
  assert.deepEqual(impresas,[{id:uuid,n:2}]);
});

test('una búsqueda paginada no crea una captura ni consulta el manifiesto prematuramente',async()=>{
  const rutas:string[]=[];let pagina=0;
  const flujo=crearCaptura({api:async ruta=>{rutas.push(ruta);return ++pagina===1?{piezas:[],siguiente:'cursor'}:{piezas:[{id:'vieja',stock:2}],siguiente:null};},imprimir:async()=>true,enLinea:()=>true});
  await flujo.leer('012345678905');assert.equal(flujo.actual(),null);
  await flujo.leer('012345678905',true);assert.equal(flujo.actual()!.pieza.id,'vieja');
  assert.ok(rutas.every(r=>r.startsWith('/api/piezas?')));assert.match(rutas[1],/cursor=cursor/);
});
