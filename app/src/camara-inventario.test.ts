import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { crearReposoCamara, INACTIVIDAD_CAMARA_MS } from '../public/camara-inventario.js';

test('cámara: apaga a 60 s, actividad reinicia y una pausa conserva el tiempo restante',()=>{
  let tiempo=0,apagados=0;
  const reposo=crearReposoCamara({apagar:()=>apagados++,ahora:()=>tiempo});
  const avanzar=ms=>{tiempo+=ms;reposo.comprobar();};
  reposo.pausar(false);avanzar(INACTIVIDAD_CAMARA_MS-1);assert.equal(apagados,0);
  reposo.actividad();avanzar(INACTIVIDAD_CAMARA_MS-1);assert.equal(apagados,0);
  avanzar(1);assert.equal(apagados,1);avanzar(INACTIVIDAD_CAMARA_MS*2);assert.equal(apagados,1);
  reposo.actividad();reposo.pausar(false);avanzar(20_000);
  reposo.pausar(true);avanzar(INACTIVIDAD_CAMARA_MS*3);assert.equal(apagados,1,'Hoja o página oculta no consume tiempo');
  reposo.pausar(true);reposo.pausar(false);avanzar(39_999);assert.equal(apagados,1);
  avanzar(1);assert.equal(apagados,2);
});

test('cámara manualmente apagada: interacciones y comprobaciones no la encienden ni vuelven a apagarla',()=>{
  let tiempo=0,apagados=0;
  const reposo=crearReposoCamara({apagar:()=>apagados++,ahora:()=>tiempo});
  reposo.pausar(false);tiempo=10_000;reposo.pausar(true);
  reposo.actividad();tiempo+=INACTIVIDAD_CAMARA_MS*2;reposo.comprobar();assert.equal(apagados,0);
  reposo.actividad();reposo.pausar(false);tiempo+=INACTIVIDAD_CAMARA_MS;reposo.comprobar();assert.equal(apagados,1);
});

// #707: toda foto sale de la cámara nativa (flash); el video solo lee códigos.
test('celular: con la cámara de códigos activa, el obturador abre la cámara nativa y no toma un cuadro del video (#707)',()=>{
  const celular=readFileSync('public/inventario-celular.js','utf8');
  const tomar=celular.slice(celular.indexOf('async function tomar('),celular.indexOf('async function alElegir('));
  assert.ok(tomar.includes('abrirNativa'),'tomar() debe usar abrirNativa');
  assert.doesNotMatch(celular,/aJpeg/,'el celular no toma cuadros del video');
  const clics:string[]=[];let valida=true;
  const c:any={usarCamara:true,archivo:{click:()=>clics.push('nativa')},camara:{pista:()=>({})},video:{videoWidth:640},
    captura:{esRopa:()=>true,flujo:{actual:()=>null},tablero:{validar:()=>valida}},piezaSinRegistrar:(a:unknown)=>a,faltaCalzado:()=>'',sonar(){},mensaje(){},
    aJpeg:()=>{throw new Error('no debe leer el video');}};
  runInNewContext(`let archivoPara=null,nativa=false,reanudarNativa=false;${tomar}\nglobalThis.tomar=tomar;globalThis.estado=()=>[archivoPara,nativa,reanudarNativa];`,c);
  valida=false;c.tomar();assert.equal(clics.length,0,'ropa sin datos: la validación va ANTES de abrir la cámara');
  valida=true;const a={upc:'123'};c.tomar(a);
  assert.equal(clics.length,1);assert.deepEqual(JSON.parse(JSON.stringify(c.estado())),[a,true,true],'recuerda la pieza, bloquea el lector y pide reanudarlo al volver');
});
