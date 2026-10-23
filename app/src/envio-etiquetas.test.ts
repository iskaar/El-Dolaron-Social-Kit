import test from 'node:test';
import assert from 'node:assert/strict';
import { estadoEnvio } from '../public/envio-etiquetas.js';
import { impresas } from '../public/etiquetera.js';

test('adaptador de Inventario comparte las marcas de /etiquetas y detecta cambio de precio', (t)=>{
  const almacen=new Map<string,string>();
  const anterior=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>almacen.get(k)??null,setItem:(k:string,v:string)=>almacen.set(k,v)}});
  t.after(()=>{if(anterior)Object.defineProperty(globalThis,'localStorage',anterior);else delete (globalThis as any).localStorage;});
  const p={id:'pieza',nombre:'Jeans',talla:'M',precio:12000,precio_lista:0,stock:2};
  assert.equal(estadoEnvio(p).vigente,false);
  assert.equal(estadoEnvio(p,'marcar','2026-10-22T12:00:00Z').vigente,true);
  assert.equal(impresas().pieza.precio,12000);assert.ok(almacen.has('etiqueta-impresas'));
  assert.equal(estadoEnvio({...p,precio:15000}).vigente,false);
  assert.equal(estadoEnvio({...p,talla:'L'}).vigente,false);
  assert.deepEqual([...almacen.keys()],['etiqueta-impresas']);
});
