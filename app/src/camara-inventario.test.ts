import test from 'node:test';
import assert from 'node:assert/strict';
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
