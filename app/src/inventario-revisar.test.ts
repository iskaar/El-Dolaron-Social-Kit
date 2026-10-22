import test from 'node:test';
import assert from 'node:assert/strict';
import { cuerpoRevision, filtrarRevision, diaTienda } from '../public/inventario-revisar.js';
import worker from './worker.ts';
import { tienda, PRODUCTO } from './prueba-d1.ts';

test('Revisar preserva precio/destino, nunca manda stock y solo dueño recalcula una etiquetada',()=>{
  const p={nombre:'Lámpara',marca:'',talla:'',categoria:'hogar',estado_fisico:'nuevo',precio:24900,precio_lista:50000,destino:'etiqueta',stock:9,codigo:'ED-000001'};
  const campos={...p,precio:'200',precio_lista:'500',stock:99};
  assert.equal(cuerpoRevision(p,campos,false).cuerpo.precio,24900);
  assert.equal(cuerpoRevision(p,campos,false).cuerpo.destino,'etiqueta');
  assert.equal('stock' in cuerpoRevision(p,campos,false).cuerpo,false);
  assert.equal(cuerpoRevision(p,campos,true).cuerpo.precio,20000);
  assert.ok(cuerpoRevision(p,campos,false,true).error);
  assert.equal('precio' in cuerpoRevision(p,campos,true,true).cuerpo,false);
});

test('filtros combinados de revisión usan el día de tienda, estado, precio y sesión',()=>{
  const p={id:'a',nombre:'Lámpara',codigo:'ED-000001',precio:24900,categoria:'hogar',creado_en:'2026-10-23T02:00:00Z',estado_analisis:'error'};
  const piezas=[p,{...p,id:'b',nombre:'Jeans',categoria:'ropa',precio:15000,estado_analisis:'listo'},{...p,id:'c',precio:0,estado_analisis:'listo'}];
  const f={estado:'revisar',busca:'',dia:'',categoria:'',min:'',max:'',sesion:''};
  assert.equal(diaTienda(p.creado_en),'2026-10-22');
  assert.deepEqual(filtrarRevision(piezas,f).map(p=>p.id),['a','c']);
  assert.deepEqual(filtrarRevision(piezas,{...f,estado:'hoy'},new Map(),'2026-10-22').map(p=>p.id),['a','b','c']);
  assert.deepEqual(filtrarRevision(piezas,{...f,busca:'lampara',min:'200',max:'300',categoria:'hogar',sesion:'x'},new Map([['a','x']])).map(p=>p.id),['a']);
  assert.deepEqual(filtrarRevision(piezas,{...f,estado:'error'}).map(p=>p.id),['a']);
});

test('host de captura: Revisar exige casilla para escribir y recortar; foto y stock siguen protegidos',async(t0)=>{
  const t=tienda();t0.after(()=>t.db.close());const correo='captura@prueba.mx';
  t.db.prepare("insert into usuarios(correo,roles,activo,editar_inventario,creado_en,actualizado_en) values(?,'capturista',1,0,'','')").run(correo);t.env.DEV_USUARIO=correo;t.env.HOST_VENDEDOR='caja.prueba';
  for(const[metodo,ruta,cuerpo]of [['PATCH',`/api/borradores/${PRODUCTO}`,{nombre:'Linterna',precio:25000,destino:'etiqueta'}],['POST',`/api/recortes/${PRODUCTO}/original`,{}],['POST',`/api/piezas/${PRODUCTO}/existencia`,{id:crypto.randomUUID(),delta:1,motivo:'entrada'}]] as const){
    assert.equal((await t.pedir(ruta,cuerpo,metodo)).status,403);
  }
  t.db.prepare('update usuarios set editar_inventario=1 where correo=?').run(correo);
  const r=await t.pedir(`/api/borradores/${PRODUCTO}`,{nombre:'Linterna',precio:25000,destino:'etiqueta'},'PATCH');assert.equal(r.status,200);
  assert.equal((await t.pedir(`/api/borradores/${PRODUCTO}`,{precio:1},'PATCH')).status,403);
  for(const ruta of ['/admin','/admin.html','/api/config','/api/cuentas'])assert.equal((await worker.fetch!(new Request('https://caja.prueba'+ruta) as never,t.env,t.ctx as never)).status,404);
});
