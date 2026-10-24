import test from 'node:test';
import assert from 'node:assert/strict';
import { crearLector } from '../public/lector.js';

test('ráfagas ED-, dígitos y UPC consumen Enter sobre un botón; caja y edición se distinguen', () => {
  let ahora = 0, timer: Function | undefined, prevenidos = 0, detenidos = 0;
  const lecturas: any[] = [], caja = { value:'', closest() { return this; } };
  const lector = crearLector({ emitir:(d) => lecturas.push(d), caja, ahora:() => ahora,
    esperar:(fn) => { timer = fn; return 1; }, cancelar:() => { timer = undefined; } });
  const boton = { closest:() => null }, editor = { closest() { return this; } };
  const tecla = (key: string, target = boton) => { ahora += 15; lector.tecla({ key, target,
    preventDefault() { prevenidos++; }, stopImmediatePropagation() { detenidos++; } }); };
  for (const codigo of ['ED-002318', '2318', '012345678905']) { for (const c of codigo) tecla(c); tecla('Enter'); }
  assert.deepEqual(lecturas.map((l) => l.codigo), ['ED-002318','2318','012345678905']);
  assert.equal(prevenidos,3); assert.equal(detenidos,3);
  caja.value = 'Chamarra Levi’s'; tecla('Enter', caja);
  assert.equal(lecturas.at(-1).codigo,'Chamarra Levi’s'); assert.equal(caja.value,'');
  for (const c of '45000') tecla(c, editor); tecla('Enter', editor);
  assert.equal(lecturas.length,4); assert.equal(prevenidos,4);
  for (const c of '1234') tecla(c); timer!(); tecla('Enter');
  assert.equal(lecturas.length,5); assert.equal(prevenidos,5); assert.equal(lecturas.at(-1).codigo,'1234');
});

test('una pausa rompe el código y las combinaciones de teclado no son lecturas', () => {
  let t=0; const lecturas:any[]=[];
  const lector=crearLector({ emitir:(d)=>lecturas.push(d), ahora:()=>t, esperar:()=>0, cancelar:()=>{} });
  const target={ closest:()=>null }, key=(key:string)=>lector.tecla({key,target,preventDefault(){},stopImmediatePropagation(){}});
  key('9'); t+=300; for(const c of '2318'){key(c);t+=15;} key('Enter');
  assert.equal(lecturas[0].codigo,'2318');
  lector.tecla({ key:'a',ctrlKey:true,target }); key('Enter'); assert.equal(lecturas.length,1);
});
