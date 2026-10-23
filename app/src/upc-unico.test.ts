import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO } from './prueba-d1.ts';
import worker from './worker.ts';
import { MISMO_UPC } from './upc-inventario.ts';
import { resolverRepetida } from '../public/ficha.js';
import { crearCaptura } from '../public/inventario-capturar.js';
import { crearSubida, registroFoto } from '../public/foto-pendiente.js';

const UPC = '0012345678905';
type Tienda = ReturnType<typeof tienda>;
function preparar() {
  const t = tienda();
  t.db.prepare(`insert into manifiesto (upc, descripcion, precio_usd, tcin, nombre, actualizado_en)
    values ('12345678905', 'Termo', 10, '', 'Termo', '')`).run();
  t.db.prepare("insert or replace into config (clave, valor) values ('tipo_cambio','2000'), ('pct_otros','50')").run();
  Object.assign(t.env, { BUSQUEDAS:{ send:async () => {} } });
  return t;
}
const cuerpo = (extra = {}) => ({ id:crypto.randomUUID(), upc:UPC, stock:2, estado_fisico:'nuevo', ...extra });
const filas = (t: Tienda) => t.db.prepare("select * from productos where ltrim(upc,'0')='12345678905'").all();
const ajustes = (t: Tienda) => t.db.prepare('select * from conteo_ajustes').all();

test('mismo UPC y grado suma con rastro; ceros y reintentos de alta y suma no duplican', async () => {
  const t = preparar(), a = cuerpo(), b = cuerpo({ upc:'012345678905', stock:3 });
  const primera = await t.pedir('/api/borradores/upc', a);
  assert.equal(primera.status, 201);
  assert.ok(primera.cuerpo.codigo);
  assert.equal((await t.pedir('/api/borradores/upc', a)).cuerpo.stock, 2);
  const segunda = await t.pedir('/api/borradores/upc', b);
  assert.equal(segunda.status, 201);
  assert.deepEqual([segunda.cuerpo.id, segunda.cuerpo.existente, segunda.cuerpo.sumadas, segunda.cuerpo.stock], [a.id,true,3,5]);
  assert.equal((await t.pedir('/api/borradores/upc', b)).cuerpo.stock, 5);
  assert.equal(filas(t).length, 1);
  assert.deepEqual(ajustes(t).map(a => [a.id,a.motivo,a.antes,a.despues,a.cantidad]), [[b.id,'entrada',2,5,3]]);
  t.db.close();
});

test('distinto grado permite pieza distinta; dos capturas simultáneas sólo insertan una por grado', async () => {
  const t = preparar();
  const respuestas = await Promise.all([t.pedir('/api/borradores/upc', cuerpo()),t.pedir('/api/borradores/upc', cuerpo())]);
  assert.deepEqual(respuestas.map(r => r.status), [201,201]);
  assert.equal(filas(t).length, 1); assert.equal(filas(t)[0].stock, 4); assert.equal(ajustes(t).length, 1);
  await t.pedir('/api/borradores/upc', cuerpo({ estado_fisico:'danado' }));
  await t.pedir('/api/borradores/upc', cuerpo({ estado_fisico:'liquidacion' }));
  assert.equal(filas(t).length, 3); t.db.close();
});

test('desconocido pendiente/error también suma y su UUID original sigue consultable por quien capturó', async () => {
  const t = preparar(); t.db.prepare('delete from manifiesto').run();
  const a = cuerpo(), b = cuerpo();
  assert.equal((await t.pedir('/api/borradores/upc/buscar', a)).status, 202);
  const r = await t.pedir('/api/borradores/upc/buscar', b);
  assert.equal(r.cuerpo.id, a.id); assert.equal(r.cuerpo.existente, true);
  assert.equal((await t.pedir('/api/borradores/upc/buscar', b)).cuerpo.stock, 4);
  assert.equal((await t.pedir(`/api/borradores/upc/${b.id}`)).cuerpo.id, a.id);
  t.db.prepare("update productos set estado_analisis='error' where id=?").run(a.id);
  assert.equal((await t.pedir('/api/borradores/upc', cuerpo())).cuerpo.stock, 6);
  assert.equal(filas(t).length, 1); t.db.close();
});

test('suma que pasa 999 falla sin rastro ni producto nuevo; el folio simultáneo sólo suma una vez', async () => {
  const t = preparar(); const a = cuerpo({stock:998});
  await t.pedir('/api/borradores/upc', a);
  const r = await t.pedir('/api/borradores/upc', cuerpo());
  assert.equal(r.status, 409); assert.match(r.cuerpo.error, /999/);
  assert.equal(filas(t)[0].stock, 998); assert.equal(ajustes(t).length, 0);
  const b = cuerpo({stock:1});
  await Promise.all([t.pedir('/api/borradores/upc', b),t.pedir('/api/borradores/upc', b)]);
  assert.equal(filas(t)[0].stock, 999); assert.equal(ajustes(t).length, 1); t.db.close();
});

test('foto y captura manual con UPC reutilizan identidad y conservan reintentos de la cola', async () => {
  const t = preparar(); const a = cuerpo(); await t.pedir('/api/borradores/upc', a);
  const f = new FormData(); f.set('id',crypto.randomUUID()); f.set('upc',UPC); f.set('cantidad','3');
  f.set('foto',new File(['foto'],'foto.jpg',{type:'image/jpeg'}));
  const enviar = () => worker.fetch!(new Request('https://caja.prueba/api/borradores',{method:'POST',body:f}) as never,t.env,t.ctx as never);
  assert.equal((await (await enviar()).json() as any).sumadas, 3);
  assert.equal((await (await enviar()).json() as any).id, a.id);
  t.db.prepare('delete from manifiesto').run();
  const b = cuerpo({nombre:'Manual',precio:9900,categoria:'otros'});
  assert.equal((await t.pedir('/api/borradores/upc/manual', b)).cuerpo.id, a.id);
  assert.equal((await t.pedir('/api/borradores/upc/manual', b)).cuerpo.id, a.id);
  assert.equal(filas(t).length, 1); assert.equal(filas(t)[0].stock, 7); assert.equal(ajustes(t).length, 2);
  t.db.close();
});

test('la consulta de igualdad usa el índice por propietario, UPC normalizado y grado', () => {
  const t = preparar();
  const plan = t.db.prepare(`explain query plan select id from productos where ${MISMO_UPC} limit 1`).all('dolaron','12345678905','nuevo');
  assert.match(JSON.stringify(plan), /SEARCH productos USING INDEX productos_upc_grado/);
  t.db.close();
});

function pieza(t: Tienda, extra = {}) {
  const p = { id:crypto.randomUUID(), nombre:'Termo', codigo:null, stock:3, precio:9900, estado_analisis:'listo',
    propietario:'dolaron', estado_fisico:'nuevo', upc:null, semana_ingreso:'S43', creado_en:new Date().toISOString(), actualizado_en:'', ...extra };
  t.db.prepare(`insert into productos (${Object.keys(p).join(',')}) values (${Object.keys(p).map(() => '?').join(',')})`).run(...Object.values(p) as never[]);
  return p;
}

test('PATCH UPC guarda y quita sin alterar precio/stock; 409 describe la otra pieza del mismo grado', async () => {
  const t = preparar(), a = pieza(t,{upc:UPC,codigo:'ED-000123'}), b = pieza(t);
  const r = await t.pedir(`/api/borradores/${b.id}`, {upc:'12345678905'}, 'PATCH');
  assert.equal(r.status, 409);
  assert.deepEqual(r.cuerpo.existente,{id:a.id,codigo:a.codigo,nombre:a.nombre,stock:3,tiene_etiqueta:true,estado_fisico:'nuevo',upc:UPC});
  assert.equal((await t.pedir(`/api/borradores/${b.id}`, {upc:'999999999999'}, 'PATCH')).status,200);
  const despues = t.db.prepare('select precio, stock, upc from productos where id=?').get(b.id)!;
  assert.deepEqual({...despues},{precio:9900,stock:3,upc:'999999999999'});
  assert.equal((await t.pedir(`/api/borradores/${b.id}`, {upc:''}, 'PATCH')).status,200);
  for (const upc of ['00000','x',1234,null]) assert.equal((await t.pedir(`/api/borradores/${b.id}`, {upc}, 'PATCH')).status,400);
  const c = pieza(t,{estado_fisico:'danado'});
  assert.equal((await t.pedir(`/api/borradores/${c.id}`, {upc:UPC}, 'PATCH')).status,200);
  assert.equal((await t.pedir(`/api/borradores/${c.id}`, {estado_fisico:'nuevo'}, 'PATCH')).status,409);
  t.db.close();
});

test('dos PATCH UPC simultáneos sólo asignan el mismo código a una pieza', async () => {
  const t = preparar(), a = pieza(t), b = pieza(t);
  const r = await Promise.all([a,b].map(p=>t.pedir(`/api/borradores/${p.id}`, {upc:UPC}, 'PATCH')));
  assert.deepEqual(r.map(r=>r.status).sort(),[200,409]); assert.equal(filas(t).length,1); t.db.close();
});

test('juntar mueve todo con dos rastros, conserva códigos e historial y reintenta sin repetir', async () => {
  const t = preparar(), a = pieza(t,{upc:UPC,codigo:'ED-000123'}), b = pieza(t,{upc:UPC,codigo:'ED-000124',stock:4});
  const c = {id:crypto.randomUUID(),destino_id:b.id};
  const r = await t.pedir(`/api/piezas/${a.id}/juntar`,c);
  assert.equal(r.status,200); assert.equal(r.cuerpo.movidas,3); assert.equal(r.cuerpo.stock,7);
  const guardadas = t.db.prepare('select id,stock,codigo,upc,estado_analisis from productos where id in (?,?) order by codigo').all(a.id,b.id);
  assert.deepEqual(guardadas.map(p=>[p.stock,p.codigo,p.upc,p.estado_analisis]),[[0,a.codigo,null,'listo'],[7,b.codigo,UPC,'listo']]);
  assert.deepEqual(ajustes(t).map(a=>[a.producto_id,a.motivo,a.antes,a.despues]),[[a.id,'correccion',3,0],[b.id,'correccion',4,7]]);
  assert.deepEqual((await t.pedir(`/api/piezas/${a.id}/juntar`,c)).cuerpo,r.cuerpo);
  assert.equal(ajustes(t).length,2);
  assert.equal((await t.pedir(`/api/piezas/${a.id}`)).status,200);
  await t.esperar(); t.db.close();
});

test('juntar falla sin efectos si la origen cambió entre lectura y batch; límite y grado también se verifican', async (tt) => {
  const t = preparar(), a = pieza(t,{upc:UPC,codigo:'ED-000123'}), b = pieza(t,{upc:UPC,codigo:'ED-000124'});
  const batch = t.env.DB.batch.bind(t.env.DB);
  tt.mock.method(t.env.DB,'batch',async sentencias=>{
    t.db.prepare('update productos set stock=2 where id=?').run(a.id);
    return batch(sentencias);
  });
  const r = await t.pedir(`/api/piezas/${a.id}/juntar`,{id:crypto.randomUUID(),destino_id:b.id});
  assert.equal(r.status,409); assert.equal(ajustes(t).length,0);
  assert.equal(t.db.prepare('select stock from productos where id=?').get(b.id)!.stock,3);
  assert.equal(t.db.prepare('select upc from productos where id=?').get(a.id)!.upc,UPC);
  tt.mock.restoreAll();
  t.db.prepare('update productos set stock=999 where id=?').run(b.id);
  assert.equal((await t.pedir(`/api/piezas/${a.id}/juntar`,{id:crypto.randomUUID(),destino_id:b.id})).status,409);
  t.db.prepare("update productos set stock=3,estado_fisico='danado' where id=?").run(b.id);
  assert.equal((await t.pedir(`/api/piezas/${a.id}/juntar`,{id:crypto.randomUUID(),destino_id:b.id})).status,409);
  assert.equal(ajustes(t).length,0); t.db.close();
});

test('juntar simultáneo por folio conserva la cantidad y rechaza reutilizarlo para otro destino', async () => {
  const t = preparar(), a = pieza(t,{codigo:'ED-000123'}), b = pieza(t,{codigo:'ED-000124'}), c = pieza(t,{codigo:'ED-000125'});
  const cuerpo = {id:crypto.randomUUID(),destino_id:b.id};
  const r = await Promise.all([t.pedir(`/api/piezas/${a.id}/juntar`,cuerpo),t.pedir(`/api/piezas/${a.id}/juntar`,cuerpo)]);
  assert.deepEqual(r.map(r=>r.status),[200,200]); assert.equal(ajustes(t).length,2);
  assert.equal((await t.pedir(`/api/piezas/${a.id}/juntar`,{...cuerpo,destino_id:c.id})).status,409);
  await t.esperar();t.db.close();
});

test('UPC y juntar exigen casilla y respetan propietario incluso en el host vendedor', async () => {
  const t = preparar(), a = pieza(t,{codigo:'ED-000123'}), b = pieza(t,{codigo:'ED-000124'}), fep = pieza(t,{propietario:'fep',codigo:'ED-000125'});
  t.db.prepare("insert into usuarios (correo,roles,activo,editar_inventario,creado_en,actualizado_en) values ('cap@prueba.mx','capturista',1,0,'','')").run();
  t.env.DEV_USUARIO = 'cap@prueba.mx';
  assert.equal((await t.pedir(`/api/borradores/${a.id}`,{upc:UPC},'PATCH')).status,403);
  assert.equal((await t.pedir(`/api/piezas/${a.id}/juntar`,{id:crypto.randomUUID(),destino_id:b.id})).status,403);
  t.db.prepare("update usuarios set editar_inventario=1 where correo='cap@prueba.mx'").run();
  assert.equal((await t.pedir(`/api/borradores/${fep.id}`,{upc:UPC},'PATCH')).status,404);
  assert.equal((await t.pedir(`/api/piezas/${a.id}/juntar`,{id:crypto.randomUUID(),destino_id:fep.id})).status,404);
  t.env.HOST_VENDEDOR = 'caja.prueba';
  assert.equal((await t.pedir(`/api/borradores/${a.id}`,{upc:UPC},'PATCH')).status,200);
  assert.equal((await t.pedir(`/api/piezas/${a.id}/juntar`,{id:crypto.randomUUID(),destino_id:b.id})).status,200);
  await t.esperar(); t.db.close();
});

test('hoja de coincidencia usa fusión si falta etiqueta y reintenta UPC sin repetir un traspaso confirmado', async () => {
  for (const etiqueta of [false,true]) {
    const llamadas:any[] = [], acciones = new Map<string,() => Promise<void>>(); let fallar=true;
    const nodo = (_:string,texto?:string) => ({textContent:texto,append(){},setAttribute(){}});
    const boton = (texto:string,accion:any) => { acciones.set(texto,()=>accion({setAttribute(){}})); return nodo('button',texto); };
    resolverRepetida({id:'origen',nombre:'Origen',stock:2,codigo:etiqueta?'ED-000002':null},{id:'destino',nombre:'Destino',stock:3,codigo:'ED-000001',upc:UPC},{
      nodo,boton,hoja(){},mensaje(){},cerrar(){},imprimir:async()=>true,upc:'999999999999',
      api:async(ruta:string,cuerpo:any)=>{llamadas.push({ruta,cuerpo});if(ruta.includes('borradores/destino')&&fallar){fallar=false;throw new TypeError('Sin red');}return {movidas:2};},
    });
    await acciones.get('Juntar en ED-000001')!(); await acciones.get('Juntar en ED-000001')!();
    assert.equal(llamadas.filter(c=>c.ruta.endsWith(etiqueta?'/juntar':'/fusionar')).length,1);
    assert.equal(llamadas.filter(c=>c.ruta.endsWith('/destino')).length,2);
    assert.equal(acciones.has('Imprimir 2 etiquetas de ED-000001'),etiqueta);
  }
});

test('Repetidas agrupa UPC normalizado+grado, excluye otras piezas y elige la etiqueta más antigua', async () => {
  const t = preparar();
  pieza(t,{upc:UPC});
  const nueva = pieza(t,{upc:'012345678905',codigo:'ED-000125'});
  const vieja = pieza(t,{upc:'12345678905',codigo:'ED-000123'});
  pieza(t,{upc:UPC,estado_fisico:'danado'});
  pieza(t,{upc:UPC,propietario:'fep'});
  pieza(t,{upc:UPC,estado_analisis:'descartado'});
  pieza(t,{upc:UPC,sin_inventario:1});
  const r = await t.pedir('/api/piezas/repetidas');
  assert.equal(r.status,200); assert.equal(r.cuerpo.siguiente,null);
  assert.equal(r.cuerpo.grupos.length,1);
  assert.deepEqual([r.cuerpo.grupos[0].upc,r.cuerpo.grupos[0].estado_fisico,r.cuerpo.grupos[0].destino_id],['12345678905','nuevo',vieja.id]);
  assert.equal(r.cuerpo.grupos[0].piezas.length,3);
  assert.ok(r.cuerpo.grupos[0].piezas.some(p=>p.id===nueva.id)); t.db.close();
});

test('Repetidas pagina aun sin coincidencias y conserva grupos que cruzan la página', async () => {
  const t = preparar();
  for(let i=0;i<85;i++)pieza(t,{upc:String(100000000000+i)});
  for(let i=0;i<85;i++)pieza(t,{upc:UPC});
  const vistas=new Set<string>(); let cursor:string|null=null, paginas=0;
  do {
    const r=await t.pedir('/api/piezas/repetidas'+(cursor?'?'+new URLSearchParams({cursor}):''));
    assert.equal(r.status,200);
    for(const g of r.cuerpo.grupos)for(const p of g.piezas)vistas.add(p.id);
    cursor=r.cuerpo.siguiente; paginas++;
  }while(cursor&&paginas<10);
  assert.equal(cursor,null); assert.equal(paginas,3); assert.equal(vistas.size,85);
  for(const cursor of ['x','[]','["a","nuevo","",0]']) assert.equal((await t.pedir('/api/piezas/repetidas?'+new URLSearchParams({cursor}))).status,400);
  t.db.close();
});

test('Repetidas exige casilla; FEP con casilla revisa sólo sus grupos', async () => {
  const t = preparar(); pieza(t,{upc:UPC});pieza(t,{upc:UPC});
  const a = pieza(t,{upc:UPC,propietario:'fep'});pieza(t,{upc:UPC,propietario:'fep'});
  t.db.prepare("insert into usuarios (correo,roles,activo,editar_inventario,creado_en,actualizado_en) values ('fep@prueba.mx','finanzas',1,0,'','')").run();
  t.env.DEV_USUARIO='fep@prueba.mx';
  assert.equal((await t.pedir('/api/piezas/repetidas')).status,403);
  t.db.prepare("update usuarios set editar_inventario=1 where correo='fep@prueba.mx'").run();
  const r=await t.pedir('/api/piezas/repetidas');
  assert.equal(r.status,200);assert.equal(r.cuerpo.grupos[0].piezas.length,2);
  assert.ok(r.cuerpo.grupos[0].piezas.some(p=>p.id===a.id));
  assert.ok((await t.pedir('/api/yo')).cuerpo.modos_inventario.includes('revisar'));
  t.db.close();
});

test('juntar una repetida histórica en cero retira su UPC conservando su código', async () => {
  const t=preparar(),a=pieza(t,{stock:0,upc:UPC,codigo:'ED-000123'}),b=pieza(t,{upc:UPC,codigo:'ED-000124'});
  assert.equal((await t.pedir(`/api/piezas/${a.id}/juntar`,{id:crypto.randomUUID(),destino_id:b.id})).status,200);
  assert.equal(t.db.prepare('select upc from productos where id=?').get(a.id)!.upc,null);
  assert.equal((await t.pedir('/api/piezas/repetidas')).cuerpo.grupos.length,0);
  await t.esperar();t.db.close();
});

test('juntar dentro de un grupo de tres no intenta reasignar el UPC ya correcto del destino', async () => {
  const acciones=new Map<string,() => Promise<void>>(),llamadas:string[]=[];
  const nodo=()=>({append(){},setAttribute(){}});
  resolverRepetida({id:'a',codigo:'ED-000002',stock:1,upc:UPC},{id:'b',codigo:'ED-000001',stock:2,upc:UPC},{
    nodo,boton:(texto,accion)=>{acciones.set(texto,accion);return nodo();},hoja(){},mensaje(){},cerrar(){},
    api:async ruta=>{llamadas.push(ruta);return {movidas:1};},imprimir:async()=>true,
  });
  await acciones.get('Juntar en ED-000001')!();
  assert.deepEqual(llamadas,['/api/piezas/a/juntar']);
});

test('cambiar de grado en Capturar retira el +1 de otro grado y da de alta el grado elegido', async () => {
  const enviadas:any[]=[];
  const flujo=crearCaptura({enLinea:()=>true,imprimir:async()=>true,api:async(ruta,cuerpo)=>{
    if(ruta.startsWith('/api/piezas'))return {piezas:[{id:'a',estado_fisico:'nuevo',upc:UPC,stock:1}],siguiente:null};
    if(ruta.startsWith('/api/manifiesto'))return {nombre:'Termo',precio:9900};
    enviadas.push(cuerpo);return {id:cuerpo.id,estado_fisico:cuerpo.estado_fisico};
  }});
  await flujo.leer(UPC);assert.equal(flujo.actual().tipo,'existente');
  flujo.estado('danado');assert.equal(flujo.actual(),null);
  await flujo.leer(UPC);await flujo.guardar();
  assert.equal(enviadas[0].estado_fisico,'danado');
});

test('captura manual general que envía UPC también rechaza la coincidencia y retira el borrador vacío', async () => {
  const t=preparar(),a=pieza(t,{upc:UPC}),id=crypto.randomUUID();
  const r=await t.pedir('/api/borradores/manual',{id,upc:UPC,nombre:'Manual',precio:9900,categoria:'otros',stock:2});
  assert.equal(r.status,409);assert.equal(r.cuerpo.existente.id,a.id);
  assert.equal(t.db.prepare('select id from productos where id=?').get(id),undefined);
  assert.equal(filas(t).length,1);t.db.close();
});

test('+1 sobre una existente pendiente no imprime una etiqueta sin precio', async () => {
  const impresas:string[]=[];
  const flujo=crearCaptura({enLinea:()=>true,api:async()=>({despues:3}),imprimir:async id=>{impresas.push(id);return true;}});
  await flujo.sumar({id:'pendiente',stock:2,estado_analisis:'pendiente'});
  assert.deepEqual(impresas,[]);assert.equal(flujo.actual().pieza.stock,3);
});

test('cola de fotos: perder la respuesta de una suma conserva UUID/foto y el reintento borra sólo el registro local', async () => {
  const t=preparar(),a=cuerpo();await t.pedir('/api/borradores/upc',a);
  const registro=registroFoto(new Blob(['foto'],{type:'image/jpeg'}),{upc:UPC,cantidad:3});
  const locales=new Map([[registro.id,registro]]),subidas:any[]=[];let perder=true;
  const subida=crearSubida({pendientes:async()=>[...locales.values()],leer:async id=>locales.get(id),borrar:async id=>{locales.delete(id);},
    enviar:async(ruta,opciones)=>{const r=await worker.fetch!(new Request('https://caja.prueba'+ruta,opciones) as never,t.env,t.ctx as never);if(perder){perder=false;throw new TypeError('Respuesta perdida');}return r;},
    alSubir:(r,d)=>subidas.push({r,d}),
  });
  await subida.subir();assert.equal(locales.size,1);assert.equal(filas(t)[0].stock,5);
  await subida.subir();assert.equal(locales.size,0);assert.equal(filas(t)[0].stock,5);assert.equal(ajustes(t).length,1);
  assert.deepEqual([subidas[0].r.id,subidas[0].d.id,subidas[0].d.existente,subidas[0].d.sumadas],[registro.id,a.id,true,3]);
  t.db.close();
});
