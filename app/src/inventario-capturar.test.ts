import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { crearCaptura, cambiosTarjeta, vigilarLectorEnCampo, piezaSinRegistrar, faltaCalzado, numeroCalzado } from '../public/inventario-capturar.js';
import { registroFoto, formularioPendiente } from '../public/foto-pendiente.js';
import worker, { permitidaParaVendedor } from './worker.ts';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { crearLector } from '../public/lector.js';
import { tsplEtiqueta } from '../public/etiquetera.js';

function manifiesto() {
  const t=tienda();
  t.db.prepare("insert into manifiesto(upc,descripcion,nombre,precio_usd,tcin,actualizado_en) values('191907910414','Lámpara','Lámpara',1000,'','')").run();
  t.db.prepare("insert or replace into config(clave,valor) values('tipo_cambio','2000'),('pct_otros','50')").run();
  t.db.prepare("insert into usuarios(correo,roles,activo,editar_inventario,creado_en,actualizado_en) values('cap@prueba.mx','capturista',1,0,'','')").run();
  return t;
}
const alta=()=>({id:crypto.randomUUID(),upc:'0191907910414',stock:2,estado_fisico:'nuevo'});

test('tarjeta de manifiesto: servidor exige dueño para precio y casilla para nombre, sin escribir al denegar',async t0=>{
  const t=manifiesto();t0.after(async()=>{await t.esperar();t.db.close();});
  t.env.DEV_USUARIO='cap@prueba.mx';
  const ficha=(await t.pedir('/api/manifiesto/0191907910414')).cuerpo;
  for(const casilla of [0,1]){
    t.db.prepare("update usuarios set editar_inventario=? where correo='cap@prueba.mx'").run(casilla);
    assert.equal((await t.pedir('/api/borradores/upc',{...alta(),precio:ficha.precio+100})).status,403);
  }
  t.db.prepare("update usuarios set editar_inventario=0 where correo='cap@prueba.mx'").run();
  assert.equal((await t.pedir('/api/borradores/upc',{...alta(),nombre:'Otro nombre'})).status,403);
  assert.equal(t.db.prepare('select count(*) n from productos where upc is not null').get()!.n,0);
  const a=alta(),igual={...a,nombre:'  '+ficha.nombre+'  ',precio:ficha.precio};
  assert.equal((await t.pedir('/api/borradores/upc',igual)).status,201,'Datos idénticos se aceptan sin casilla');
  assert.equal((await t.pedir('/api/borradores/upc',{...igual,precio:ficha.precio+100})).status,403,'El reintento también autoriza');
  assert.equal((await t.pedir('/api/borradores/upc',{...alta(),nombre:'Distinto'})).status,403,'La suma tampoco evita el permiso');
  assert.equal(t.db.prepare('select stock from productos where id=?').get(a.id)!.stock,2);
  assert.equal(t.db.prepare('select count(*) n from conteo_ajustes').get()!.n,0);
});

test('dueño edita nombre/precio; el UUID conserva el resultado y la impresión toma los valores de D1',async t0=>{
  const t=manifiesto();t0.after(async()=>{await t.esperar();t.db.close();});
  const api=async(ruta,cuerpo)=>{const r=await t.pedir(ruta,cuerpo);assert.ok(r.status<400,JSON.stringify(r));return r.cuerpo;};
  const impresas:string[]=[];
  const flujo=crearCaptura({api,enLinea:()=>true,imprimir:async(id,n)=>{
    const etiquetas=await api('/api/etiquetas',{ids:[id]});
    assert.equal(etiquetas[0].nombre,'Termo & tapa');assert.equal(etiquetas[0].precio,8700);
    impresas.push(tsplEtiqueta(etiquetas[0],n,0,2));return true;
  }});
  await flujo.leer('0191907910414');
  flujo.actual().nombre='  Termo &amp; tapa  ';flujo.actual().precio='87.00';flujo.cantidad(3);
  const id=flujo.actual().id;await flujo.guardar();
  assert.equal(impresas.length,1);assert.match(impresas[0],/Termo & tapa/);assert.match(impresas[0],/87/);
  const reintento=await api('/api/borradores/upc',{...alta(),id,nombre:'No reemplazar',precio:9900});
  assert.deepEqual([reintento.nombre,reintento.precio,reintento.stock],['Termo & tapa',8700,3]);
  const suma=await api('/api/borradores/upc',{...alta(),nombre:'Tampoco reemplazar',precio:9900});
  assert.deepEqual([suma.id,suma.nombre,suma.precio,suma.stock],[id,'Termo & tapa',8700,5]);
  await flujo.leer('0191907910414');await flujo.leer('0191907910414');
  assert.equal(impresas.length,2,'Reescanear también imprime los valores editados');
  assert.equal(t.db.prepare('select stock from productos where id=?').get(id)!.stock,6);
  assert.equal(t.db.prepare('select count(*) n from productos where upc is not null').get()!.n,1);
});

test('capturista con casilla edita solo nombre; límites de nombre y centavos se validan antes del alta',async t0=>{
  const t=manifiesto();t0.after(async()=>{await t.esperar();t.db.close();});
  for(const campos of [{nombre:''},{nombre:'   '},{nombre:null},{nombre:42},{precio:0},{precio:-1},{precio:1.5},{precio:'100'},{precio:null},{precio:Number.MAX_SAFE_INTEGER+1},{precio:20001}]){
    assert.equal((await t.pedir('/api/borradores/upc',{...alta(),...campos})).status,400,JSON.stringify(campos));
  }
  assert.equal(t.db.prepare('select count(*) n from productos where upc is not null').get()!.n,0);
  t.env.DEV_USUARIO='cap@prueba.mx';t.db.prepare("update usuarios set editar_inventario=1 where correo='cap@prueba.mx'").run();
  const nombre='Á'.repeat(125),r=await t.pedir('/api/borradores/upc',{...alta(),nombre:'  '+nombre+'  '});
  assert.equal(r.status,201);assert.equal(r.cuerpo.nombre,'Á'.repeat(120));
});

test('campos opcionales no revelan piezas ajenas ni evitan conflictos de UUID/UPC',async t0=>{
  const t=manifiesto();t0.after(async()=>{await t.esperar();t.db.close();});
  const a=alta();await t.pedir('/api/borradores/upc',a);
  t.env.DEV_USUARIO='cap@prueba.mx';
  assert.equal((await t.pedir('/api/borradores/upc',{...a,upc:'999999999999',nombre:'Otro',precio:1})).status,409);
  t.db.prepare("update productos set propietario='fep' where id=?").run(a.id);
  assert.equal((await t.pedir('/api/borradores/upc',{...a,nombre:'Otro',precio:1})).status,404);
});

test('ediciones inválidas de la tarjeta conservan el trabajo y no guardan ni imprimen',async()=>{
  const flujo=crearCaptura({api:async()=>assert.fail('No debe llamar la API'),enLinea:()=>true,imprimir:async()=>assert.fail('No debe imprimir')});
  const a={tipo:'nueva',id:'estable',nombre:'   ',cantidad:1};flujo.retomar(a);
  await assert.rejects(flujo.guardar(),/nombre/);assert.equal(flujo.actual(),a);
  a.nombre='Lámpara';a.precio='0';await assert.rejects(flujo.guardar(),/precio/);assert.equal(flujo.actual(),a);
});

test('UPC de Ropa ignora el grado de MG y conserva el estado interno al sumar; MG sigue filtrada por grado', async () => {
  const ropa = { id: 'ropa', upc: '012345678905', categoria: 'ropa', estado_fisico: 'danado', stock: 1, estado_analisis: 'listo' };
  const mg = { ...ropa, id: 'mg', categoria: 'hogar' };
  const cuerpos: any[] = [];
  const flujo = crearCaptura({ enLinea: () => true, imprimir: async () => true, api: async (ruta, cuerpo) => {
    if (ruta.endsWith('/existencia')) { cuerpos.push(cuerpo); return { despues: 2 }; }
    return { piezas: [ropa, mg], siguiente: null };
  } });
  await flujo.leer(ropa.upc);
  assert.equal(flujo.actual()?.pieza.id, ropa.id);
  flujo.estado('liquidacion');
  assert.equal(flujo.actual()?.pieza.id, ropa.id);
  await flujo.leer(ropa.upc);
  assert.equal(flujo.actual()?.pieza.stock, 2);
  assert.equal(flujo.actual()?.pieza.estado_fisico, 'danado');
  assert.deepEqual(Object.keys(cuerpos[0]).sort(), ['delta', 'id', 'motivo']);
});

test('un UPC nuevo identificado como Ropa usa nuevo aunque MG tenga B o C seleccionado', async () => {
  let enviada: any;
  const flujo = crearCaptura({ enLinea: () => true, imprimir: async () => true, api: async (ruta, cuerpo) => {
    if (ruta.startsWith('/api/piezas/resolver?')) return { ficha: { nombre: 'Playera', categoria: 'ropa', precio: 12000 } };
    enviada = cuerpo; return { id: cuerpo.id, estado_analisis: 'listo' };
  } });
  flujo.estado('danado'); await flujo.leer('012345678905');
  assert.equal(flujo.actual()?.estado, 'nuevo');
  flujo.estado('liquidacion'); await flujo.guardar();
  assert.equal(enviada.estado_fisico, 'nuevo');
});

test('Capturar +1 usa rastro D1, un UUID por operación y exactamente una etiqueta; sin red no escribe',async(t0)=>{
  const t=tienda();t0.after(()=>t.db.close());
  t.db.prepare("update productos set estado_analisis='listo' where id=?").run(PRODUCTO);
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
    llamadas.push({ruta,cuerpo});
    if(ruta.startsWith('/api/piezas/resolver?')){if(/q=\d{12}$/.test(ruta))return {ficha:{nombre:'Lámpara',precio:24900}};throw Object.assign(new Error('Sin coincidencias.'),{status:404});}
    if(falla)throw new TypeError('Sin red');return {id:cuerpo.id,nombre:'Lámpara',stock:cuerpo.stock,precio:24900};
  };
  const flujo=crearCaptura({api,imprimir:async(id,n)=>{impresas.push({id,n});return true;},enLinea:()=>true,uuid:()=>`uuid-${++id}`});
  await flujo.leer('ED-002318');assert.equal(flujo.actual(),null);
  await flujo.leer('chamarra');assert.equal(flujo.actual(),null);
  assert.equal(llamadas.some(l=>l.ruta.startsWith('/api/manifiesto')),false);
  await flujo.leer('012345678905');await flujo.leer('12345678905');assert.equal(flujo.actual()!.cantidad,2);
  assert.equal(llamadas.filter(l=>l.ruta.startsWith('/api/piezas')).length,3,'un viaje por lectura que llega al servidor; el reescaneo no pregunta');
  assert.equal(llamadas.some(l=>l.ruta.startsWith('/api/manifiesto')),false,'la ficha viaja en el resolver');
  await assert.rejects(flujo.guardar(),/Sin red/);const uuid=flujo.actual()!.id;
  falla=false;await flujo.guardar();const guardados=llamadas.filter(l=>l.ruta==='/api/borradores/upc');
  assert.equal(guardados.length,2);assert.equal(guardados[0].cuerpo.id,uuid);assert.equal(guardados[1].cuerpo.id,uuid);
  assert.deepEqual(Object.keys(guardados[0].cuerpo).sort(),['estado_fisico','id','stock','upc']);
  assert.deepEqual(impresas,[{id:uuid,n:2}]);
});

test('una búsqueda paginada no crea una captura ni consulta el manifiesto prematuramente',async()=>{
  const rutas:string[]=[];let pagina=0;
  const flujo=crearCaptura({api:async ruta=>{rutas.push(ruta);return ++pagina===1?{piezas:[],siguiente:'cursor'}:{piezas:[{id:'vieja',stock:2,estado_fisico:'nuevo'}],siguiente:null};},imprimir:async()=>true,enLinea:()=>true});
  await flujo.leer('012345678905');assert.equal(flujo.actual(),null);
  await flujo.leer('012345678905',true);assert.equal(flujo.actual()!.pieza.id,'vieja');
  assert.match(rutas[0],/^\/api\/piezas\/resolver\?/);assert.match(rutas[1],/^\/api\/piezas\?.*cursor=cursor/);assert.equal(rutas.length,2);
});

test('cámara y USB priorizan la etiqueta numérica ED- frente a UPC y grado; otros UPC conservan su ruta',async(t0)=>{
  const t=tienda();t0.after(()=>t.db.close());const rutas:string[]=[];
  const stock=t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock;
  const api=async(ruta:string)=>{rutas.push(ruta);const r=await t.pedir(ruta);assert.equal(r.status,200);return r.cuerpo;};
  t.db.prepare("update productos set estado_fisico='danado',estado_analisis='listo' where id=?").run(PRODUCTO);
  t.db.prepare(`insert into productos(id,codigo,nombre,upc,stock,estado_analisis,semana_ingreso,creado_en,actualizado_en)
    values('otra','ED-999999','UPC coincidente','123456',2,'listo','S43','','')`).run();
  const flujo=crearCaptura({api,imprimir:async()=>assert.fail('Leer no imprime'),enLinea:()=>true,permiteSumar:false});
  const lector=crearLector({emitir:({codigo})=>flujo.leer(codigo)});
  for(const codigo of ['000006','002318','012345','123456']){
    const ed=`ED-${codigo}`;t.db.prepare('update productos set codigo=? where id=?').run(ed,PRODUCTO);
    for(const origen of ['camara','usb']){
      flujo.limpiar();await lector.recibir(String(Number(codigo)).padStart(4,'0'),origen);
      assert.equal(flujo.actual()?.tipo,'existente');assert.equal(flujo.actual()?.pieza.id,PRODUCTO);
      assert.equal(flujo.actual()?.pieza.estado_fisico,'danado');
    }
  }
  assert.ok(rutas.every(r=>r.startsWith('/api/piezas/resolver?')));
  assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock,stock);

  // Un UPC pendiente igual se guarda con su cantidad original antes de abrir la etiqueta.
  let guardada:any;
  const pendiente=crearCaptura({api:async(ruta,cuerpo)=>{
    if(ruta==='/api/borradores/upc'){guardada=cuerpo;return {id:'upc-pendiente',estado_analisis:'pendiente'};}
    return api(ruta);
  },imprimir:async()=>assert.fail('No imprime una pieza pendiente'),enLinea:()=>true});
  pendiente.retomar({tipo:'nueva',id:'upc-pendiente',upc:'123456',cantidad:1,estado:'nuevo'});
  await pendiente.leer('123456');assert.equal(pendiente.actual()?.pieza.id,PRODUCTO);assert.equal(guardada.stock,1);

  // Sin esa etiqueta, los seis dígitos vuelven a buscar el UPC existente.
  t.db.prepare("update productos set codigo='ED-002318' where id=?").run(PRODUCTO);
  flujo.limpiar();await lector.recibir('123456','camara');assert.equal(flujo.actual()?.pieza.id,'otra');
  const consultas:string[]=[];
  const nuevo=crearCaptura({api:async ruta=>{consultas.push(ruta);return {ficha:{nombre:'Lámpara',precio:24900}};},imprimir:async()=>true,enLinea:()=>true});
  await crearLector({emitir:({codigo})=>nuevo.leer(codigo)}).recibir('012345678905','camara');
  assert.equal(nuevo.actual()?.tipo,'nueva');assert.equal(nuevo.actual()?.upc,'012345678905');
  assert.deepEqual(consultas,['/api/piezas/resolver?q=012345678905']);
});

test('GET /api/piezas/resolver (#491): piezas, ficha del manifiesto o 404 en un viaje, con la imagen en segundo plano',async t0=>{
  const t=manifiesto();t0.after(async()=>{await t.esperar();t.db.close();});
  t.env.DEV_USUARIO='cap@prueba.mx';
  const objetivo:string[]=[];let liberar=()=>{};const abierta=new Promise<void>(f=>liberar=f);
  t0.mock.method(globalThis,'fetch',async(u:any)=>{objetivo.push(String(u));await abierta;return new Response('',{status:404});});
  t.db.prepare("update manifiesto set tcin='12345678' where upc='191907910414'").run();
  // Ficha: con ceros de más se normaliza; la búsqueda de la imagen no bloquea la respuesta (termina en waitUntil).
  const f=await t.pedir('/api/piezas/resolver?q=0191907910414');
  assert.equal(f.status,200);assert.equal(f.cuerpo.piezas,undefined);assert.equal(f.cuerpo.ficha.upc,'191907910414');
  assert.deepEqual(f.cuerpo.ficha,(await t.pedir('/api/manifiesto/191907910414')).cuerpo,'es la ficha de /api/manifiesto');
  assert.equal(objetivo.length,1,'Target sigue pendiente y la respuesta ya salió: no está en el camino crítico');liberar();
  await t.esperar();assert.match(objetivo[0],/target\.com.*12345678/);
  // Con la imagen ya guardada no vuelve a Target.
  t.db.prepare("insert into imagenes_upc(upc,tcin,url,nombre,upc_fuente) values('191907910414','12345678','https://target.scene7.com/is/image/Target/GUEST_1','Lámpara','')").run();
  objetivo.length=0;
  const g=await t.pedir('/api/piezas/resolver?q=191907910414');await t.esperar();
  assert.equal(g.cuerpo.ficha.imagen.url,'https://target.scene7.com/is/image/Target/GUEST_1');assert.equal(objetivo.length,0);
  // Si hay piezas, solo piezas y nada de manifiesto.
  t.db.prepare(`insert into productos(id,codigo,nombre,upc,stock,estado_analisis,semana_ingreso,creado_en,actualizado_en)
    values('con-upc','ED-000777','Lámpara','191907910414',2,'listo','S43','','')`).run();
  const p=await t.pedir('/api/piezas/resolver?q=191907910414');
  assert.deepEqual(p.cuerpo.piezas.map((x:any)=>x.id),['con-upc']);assert.equal(p.cuerpo.ficha,undefined);
  assert.deepEqual(p.cuerpo,(await t.pedir('/api/piezas?q=191907910414')).cuerpo,'mismo resultado que /api/piezas');
  assert.deepEqual((await t.pedir('/api/piezas/resolver?q=777')).cuerpo.piezas.map((x:any)=>x.id),['con-upc'],'ED- corto');
  // Ninguno: 404 (UPC desconocido, texto, ED- corto inexistente); q inválido sigue siendo 400 como /api/piezas.
  for(const q of ['190000000009','chamarra','12']) assert.equal((await t.pedir('/api/piezas/resolver?q='+q)).status,404,q);
  assert.equal((await t.pedir('/api/piezas/resolver?q=ab')).status,400);
  assert.equal((await t.pedir('/api/piezas/resolver',{},'POST')).status,403,'solo GET');
});

test('GET /api/piezas/resolver (#491): FEP solo ve lo suyo y no recibe fichas; sin rol de inventario se niega',async t0=>{
  const t=manifiesto();t0.after(async()=>{await t.esperar();t.db.close();});
  const usuario=(correo:string,rol:string,activo=1)=>t.db.prepare("insert into usuarios(correo,roles,activo,editar_inventario,creado_en,actualizado_en) values(?,?,?,0,'','')").run(correo,rol,activo);
  usuario('fep@prueba.mx','finanzas');usuario('caja@prueba.mx','cajero');usuario('baja@prueba.mx','capturista',0);
  const pieza=(id:string,codigo:string,upc:string,propietario:string)=>t.db.prepare(`insert into productos(id,codigo,nombre,upc,stock,estado_analisis,semana_ingreso,propietario,creado_en,actualizado_en)
    values(?,?,?,?,1,'listo','S43',?,'','')`).run(id,codigo,id,upc,propietario);
  pieza('dolaron-1','ED-000801','900000000001','dolaron');pieza('fep-1','ED-000802','900000000002','fep');
  const resolver=async(correo:string,q:string)=>{t.env.DEV_USUARIO=correo;return t.pedir('/api/piezas/resolver?q='+q);};
  const ids=(r:any)=>r.cuerpo.piezas?.map((x:any)=>x.id);
  assert.deepEqual(ids(await resolver('cap@prueba.mx','900000000001')),['dolaron-1']);
  assert.equal((await resolver('cap@prueba.mx','900000000002')).status,404,'la tienda no ve la pieza de FEP');
  assert.deepEqual(ids(await resolver('fep@prueba.mx','900000000002')),['fep-1']);
  assert.deepEqual(ids(await resolver('fep@prueba.mx','802')),['fep-1']);
  assert.equal((await resolver('fep@prueba.mx','900000000001')).status,404,'FEP no ve la pieza de la tienda');
  assert.equal((await resolver('fep@prueba.mx','801')).status,404);
  const ficha=await resolver('fep@prueba.mx','191907910414');
  assert.equal(ficha.status,404,'FEP no tiene manifiesto');assert.equal(ficha.cuerpo.ficha,undefined);
  assert.equal((await resolver('cap@prueba.mx','191907910414')).status,200,'la tienda sí');
  assert.equal((await resolver('caja@prueba.mx','900000000001')).status,403,'cajero');
  assert.equal((await resolver('baja@prueba.mx','900000000001')).status,403,'cuenta inactiva');
  assert.equal((await resolver('nadie@prueba.mx','900000000001')).status,403,'sin cuenta');
  assert.equal(permitidaParaVendedor('/api/piezas/resolver','GET'),true);assert.equal(permitidaParaVendedor('/api/piezas/resolver','POST'),false);
});

test('P2-1: leer otro código nunca guarda una tarjeta editada; sin edición guarda como siempre',async()=>{
  const llamadas:string[]=[];
  const api=async(ruta:string,cuerpo?:any)=>{llamadas.push(ruta);
    if(ruta.startsWith('/api/piezas/resolver?'))return {ficha:{nombre:'Lámpara',precio:24900}};
    return {id:cuerpo.id,estado_analisis:'listo'};};
  const flujo=crearCaptura({api,enLinea:()=>true,imprimir:async()=>true});
  await flujo.leer('012345678905');
  flujo.actual()!.precio='1';
  await assert.rejects(flujo.leer('012345678906'),/Guarda la tarjeta/);
  assert.equal(llamadas.includes('/api/borradores/upc'),false);assert.equal(flujo.actual()!.upc,'012345678905');
  flujo.actual()!.precio='249';flujo.actual()!.nombre=' Lámpara ';
  await flujo.leer('012345678906');
  assert.equal(llamadas.filter(r=>r==='/api/borradores/upc').length,1,'Valores idénticos a lo mostrado se guardan como antes');
  assert.equal(flujo.actual()!.upc,'012345678906');
});

test('P2-2: la foto de una tarjeta editada lleva nombre y precio; registros viejos y clientes viejos usan el manifiesto',()=>{
  const nueva={tipo:'nueva',nombre:'  Termo  ',precio:'87.50'};
  const edicion=cambiosTarjeta(nueva);assert.deepEqual(edicion,{nombre:'Termo',precio:8750});
  const r=registroFoto(new Blob(['f']),{upc:'0191907910414',nombre_edit:edicion.nombre,precio_edit:edicion.precio});
  const f=formularioPendiente(r);assert.equal(f.get('nombre'),'Termo');assert.equal(f.get('precio'),'8750');
  const vieja=formularioPendiente({id:'x',estado_fisico:'nuevo',cantidad:1,upc:'0191907910414',foto:new Blob(['f'])});
  assert.equal(vieja.has('nombre'),false);assert.equal(vieja.has('precio'),false);
  assert.throws(()=>cambiosTarjeta({nombre:'  '}),/nombre/);assert.throws(()=>cambiosTarjeta({precio:'0'}),/precio/);
});

test('P2-2/P3-a: la foto en cola con edición no autorizada se guarda con el manifiesto; dueño conserva nombre y precio',async t0=>{
  const t=manifiesto();t0.after(async()=>{await t.esperar();t.db.close();});
  const ficha=(await t.pedir('/api/manifiesto/0191907910414')).cuerpo;
  const subir=(extra:Record<string,string>,id=crypto.randomUUID())=>{
    const f=formularioPendiente(registroFoto(new Blob(['foto'],{type:'image/jpeg'}),{id,upc:'0191907910414',cantidad:2}));
    for(const [k,v] of Object.entries(extra))f.set(k,v);
    return worker.fetch!(new Request('https://caja.prueba/api/borradores',{method:'POST',body:f}) as never,t.env,t.ctx as never);
  };
  t.env.DEV_USUARIO='cap@prueba.mx';
  for(const casilla of [0,1]){
    t.db.prepare("update usuarios set editar_inventario=? where correo='cap@prueba.mx'").run(casilla);
    const id=crypto.randomUUID();
    assert.equal((await subir({precio:String(ficha.precio+100)},id)).status,201,'La edición no autorizada se descarta, la cola no se detiene');
    assert.equal(t.db.prepare('select precio from productos where id=?').get(id)!.precio,ficha.precio);
    t.db.prepare('delete from productos where id=?').run(id);
  }
  t.db.prepare("update usuarios set editar_inventario=0 where correo='cap@prueba.mx'").run();
  const otro=crypto.randomUUID();
  assert.equal((await subir({nombre:'Otro nombre'},otro)).status,201);
  assert.equal(t.db.prepare('select nombre from productos where id=?').get(otro)!.nombre,ficha.nombre,'El nombre no autorizado nunca se escribe');
  t.db.prepare('delete from productos where id=?').run(otro);
  assert.equal(t.db.prepare('select count(*) n from productos where upc is not null').get()!.n,0);
  assert.equal((await t.pedir('/api/borradores/upc',{...alta(),precio:ficha.precio+100})).status,403,'El POST directo conserva su 403');
  const sin=crypto.randomUUID();assert.equal((await subir({},sin)).status,201,'Sin campos: valores del manifiesto');
  assert.equal(t.db.prepare('select precio from productos where id=?').get(sin)!.precio,ficha.precio);
  t.env.DEV_USUARIO=DUENO;t.db.prepare('delete from productos where id=?').run(sin);
  const id=crypto.randomUUID();
  assert.equal((await subir({nombre:'Termo &amp; tapa',precio:'8700'},id)).status,201);
  const fila=t.db.prepare('select nombre,precio,stock,foto_key from productos where id=?').get(id)!;
  assert.deepEqual([fila.nombre,fila.precio,fila.stock,fila.foto_key],['Termo & tapa',8700,2,`fotos/${id}.jpg`]);
});

test('P3-1: Enter en un campo de la tarjeta devuelve el foco al lector; una ráfaga de lector no se queda en el campo',()=>{
  const campo=Object.assign(new EventTarget(),{value:'Lámpara'}) as any;
  let reloj=0;const leidos:string[]=[];let salidas=0;
  vigilarLectorEnCampo(campo,{ahora:()=>reloj,salir:()=>{salidas++;},alLeer:c=>leidos.push(c)});
  const tecla=(key:string,ms:number)=>{reloj+=ms;const e=Object.assign(new Event('keydown',{cancelable:true}),{key});campo.dispatchEvent(e);if(key.length===1)campo.value+=key;return e;};
  for(const k of '1234567890')tecla(k,k==='1'?400:10);
  const enter=tecla('Enter',10);
  assert.equal(enter.defaultPrevented,true);assert.equal(campo.value,'Lámpara');assert.deepEqual(leidos,['1234567890']);assert.equal(salidas,1);
  for(const k of '1234')tecla(k,k==='1'?400:200);campo.value+='';
  tecla('Enter',200);
  assert.deepEqual(leidos,['1234567890'],'Tecleo humano no es un código');assert.equal(campo.value,'Lámpara1234');assert.equal(salidas,2);
});

test('P3-b: un precio mayor al de lista se rechaza antes de encolar o guardar',()=>{
  const ficha={precio_lista:50000};
  assert.throws(()=>cambiosTarjeta({ficha,precio:'500.01'}),/precio de lista/);
  assert.deepEqual(cambiosTarjeta({ficha,precio:'500'}),{precio:50000});
  assert.deepEqual(cambiosTarjeta({ficha:{precio_lista:0},precio:'900'}),{precio:90000},'Sin precio de lista no hay tope');
});

test('P3-c: UPC solo en catálogo y sin foto: la foto con edición del dueño sí llega a capturarPorUpc',async t0=>{
  const t=manifiesto();t0.after(async()=>{await t.esperar();t.db.close();});
  t.db.prepare("delete from manifiesto").run();
  t.db.prepare(`insert into productos(id,upc,nombre,categoria,precio_lista,precio,estado_fisico,stock,estado_analisis,propietario,destino,semana_ingreso,creado_en,actualizado_en)
    values('catalogo','0191907910414','Lámpara catálogo','otros',10000,8000,'danado',1,'listo','dolaron','etiqueta','S43','','')`).run();
  const id=crypto.randomUUID();
  const f=formularioPendiente(registroFoto(new Blob(['foto'],{type:'image/jpeg'}),{id,upc:'0191907910414',cantidad:2,estado_fisico:'nuevo',nombre_edit:'Lámpara editada',precio_edit:9000}));
  const r=await worker.fetch!(new Request('https://caja.prueba/api/borradores',{method:'POST',body:f}) as never,t.env,t.ctx as never);
  assert.equal(r.status,201);
  const fila=t.db.prepare('select nombre,precio,stock,foto_key from productos where id=?').get(id)!;
  assert.deepEqual([fila.nombre,fila.precio,fila.stock,fila.foto_key],['Lámpara editada',9000,2,`fotos/${id}.jpg`]);
});

// ---- Sumar varias piezas (#474) ----
test('Sumar N a una pieza existente es un ajuste auditado de N, con N etiquetas, folio estable y tope 999',async(t0)=>{
  const t=tienda();t0.after(()=>t.db.close());
  t.db.prepare("update productos set estado_analisis='listo',stock=10 where id=?").run(PRODUCTO);
  const impresiones:any[]=[],llamadas:any[]=[];let perder=true;
  const api=async(ruta:string,cuerpo?:any)=>{llamadas.push({ruta,cuerpo});const r=await t.pedir(ruta,cuerpo);if(r.status>=400)throw Object.assign(new Error(r.cuerpo.error),{status:r.status});
    if(ruta.endsWith('/existencia')&&perder){perder=false;throw new TypeError('Respuesta perdida');}return r.cuerpo;};
  const flujo=crearCaptura({api,imprimir:async(id,n)=>{impresiones.push({id,n});return true;},enLinea:()=>true});
  const stock=()=>t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock as number;
  const p=(await t.pedir(`/api/piezas/${PRODUCTO}`)).cuerpo.pieza;
  // La respuesta se pierde después de aplicar: el reintento reutiliza el folio y no duplica.
  await assert.rejects(flujo.sumar(p,12),/Respuesta perdida/);assert.equal(stock(),22);
  await assert.rejects(flujo.sumar(p,5),/pendiente de 12/);assert.equal(stock(),22);
  await flujo.sumar(p,12);assert.equal(stock(),22);
  assert.equal(llamadas[0].cuerpo.id,llamadas[1].cuerpo.id);assert.equal(llamadas[0].cuerpo.delta,12);
  assert.deepEqual(impresiones,[{id:PRODUCTO,n:12}]);assert.equal(flujo.actual()!.impresas,12);
  const filas=t.db.prepare("select cantidad,antes,despues,motivo from conteo_ajustes where producto_id=?").all(PRODUCTO);
  assert.deepEqual(filas.map((f:any)=>({...f})),[{cantidad:12,antes:10,despues:22,motivo:'entrada'}]);
  // Pasarse de 999 se rechaza completo (409), no deja rastro y libera el ajuste para elegir otra cantidad.
  const llena=(await t.pedir(`/api/piezas/${PRODUCTO}`)).cuerpo.pieza;
  await assert.rejects(flujo.sumar(llena,978),(e:any)=>e.status===409);assert.equal(stock(),22);
  assert.equal(t.db.prepare("select count(*) n from conteo_ajustes where producto_id=?").get(PRODUCTO)!.n,1);
  await flujo.sumar(llena,977);assert.equal(stock(),999);assert.equal(impresiones.length,2);
  await t.esperar();
});

test('«N*código»: N piezas en la lectura (nueva, repetida o existente) con el parser de la caja; sin prefijo sigue siendo 1',async()=>{
  const llamadas:string[]=[];let existente=false;
  const pieza={id:'p1',codigo:'ED-000007',upc:'012345678905',stock:4,estado_fisico:'nuevo',estado_analisis:'listo'};
  const api=async(ruta:string,cuerpo?:any)=>{llamadas.push(ruta);
    if(ruta.startsWith('/api/piezas/resolver?'))return existente?{piezas:[pieza],siguiente:null}:{ficha:{nombre:'Lámpara',precio:24900}};
    return {despues:pieza.stock+cuerpo.delta};};
  const impresas:number[]=[];
  const flujo=crearCaptura({api,imprimir:async(_id,n)=>{impresas.push(n);return true;},enLinea:()=>true});
  await flujo.leer('12*012345678905');assert.equal(flujo.actual()!.tipo,'nueva');assert.equal(flujo.actual()!.cantidad,12);
  await flujo.leer('012345678905');assert.equal(flujo.actual()!.cantidad,13,'sin prefijo, volver a escanear suma 1');
  await flujo.leer(' 3 * 012345678905');assert.equal(flujo.actual()!.cantidad,16);
  existente=true;flujo.limpiar();
  await flujo.leer('12*012345678905');assert.equal(flujo.actual()!.tipo,'existente');assert.equal(flujo.actual()!.cantidad,12,'abre la tarjeta con 12; no suma sola');
  assert.ok(!llamadas.some(r=>r.endsWith('/existencia')));
  await flujo.leer('5*012345678905');assert.ok(llamadas.at(-1)!.endsWith('/existencia'),'repetir el código con prefijo suma ese N');assert.deepEqual(impresas,[5]);
  await flujo.leer('012345678905');assert.deepEqual(impresas,[5,1]);
  for(const mal of ['0*1','100*1','12*','12*  ']) await assert.rejects(flujo.leer(mal));
});

test('el stepper deja escribir la cantidad en su lugar y la acota a min/max',()=>{
  class Nodo{
    tagName='';textContent='';className='';hidden=false;value='';inputMode='';tabIndex=0;padre:Nodo|null=null;hijos:Nodo[]=[];attrs:Record<string,string>={};eventos:Record<string,Function[]>={};enfocado=false;
    onclick:Function|null=null;onkeydown:Function|null=null;
    setAttribute(k:string,v:string){this.attrs[k]=v;}getAttribute(k:string){return this.attrs[k];}
    append(...n:Nodo[]){for(const x of n){x.padre=this;this.hijos.push(x);}}
    after(n:Nodo){n.padre=this.padre;this.padre!.hijos.splice(this.padre!.hijos.indexOf(this)+1,0,n);}
    remove(){this.padre!.hijos.splice(this.padre!.hijos.indexOf(this),1);this.padre=null;}
    addEventListener(e:string,fn:Function){(this.eventos[e]??=[]).push(fn);}
    focus(){this.enfocado=true;}select(){}
    emitir(e:string,datos:any={}){for(const fn of this.eventos[e]??[])fn({preventDefault(){},stopPropagation(){},...datos});}
  }
  const fuente=readFileSync('public/inventario-ui.js','utf8').replaceAll('export ','');
  const { stepper }=runInNewContext(fuente+';({stepper})',{document:{createElement:(tag:string)=>Object.assign(new Nodo(),{tagName:tag}),getElementById:()=>null},clearTimeout,setTimeout,setInterval,clearInterval});
  const valores:number[]=[];
  const raiz=stepper(1,(n:number)=>valores.push(n),{min:1,max:50,nombre:'Piezas a sumar'});
  const salida=raiz.hijos[1];
  const escribir=(texto:string,tecla='Enter')=>{salida.onclick();const input=raiz.hijos.find((h:Nodo)=>h.tagName==='input')!;assert.ok(salida.hidden);assert.equal(input.inputMode,'numeric');assert.equal(input.attrs['aria-label'],'Piezas a sumar');
    input.value=texto;input.emitir('keydown',{key:tecla});return input;};
  escribir('12');assert.equal(salida.value,'12');assert.equal(valores.at(-1),12);assert.ok(!salida.hidden);assert.ok(salida.enfocado);
  assert.equal(raiz.hijos.length,3,'el campo se retira al terminar');
  escribir('5000');assert.equal(valores.at(-1),50,'acota al máximo');
  escribir('0');assert.equal(valores.at(-1),1,'acota al mínimo');
  const antes=valores.length;escribir('abc');escribir('12',  'Escape');escribir('');assert.equal(valores.length,antes,'texto no numérico, vacío o Escape no cambian nada');
  salida.onclick();raiz.hijos.find((h:Nodo)=>h.tagName==='input')!.value='7';raiz.hijos.find((h:Nodo)=>h.tagName==='input')!.emitir('blur');assert.equal(valores.at(-1),7,'al salir del campo también aplica');
  raiz.hijos[2].emitir('click');assert.equal(valores.at(-1),8,'los botones ± siguen funcionando');
});

test('#549: el obturador del celular solo entrega la foto a una tarjeta sin registrar; guardada o existente = pieza nueva',()=>{
  const nueva={tipo:'nueva',id:'n',upc:'1'},sinRegistro={tipo:'sin-registro',id:'s',upc:'2'};
  assert.equal(piezaSinRegistrar(nueva),nueva);
  assert.equal(piezaSinRegistrar(sinRegistro),sinRegistro);
  assert.equal(piezaSinRegistrar({...nueva,tipo:'guardada',pieza:{id:'n'}}),null);   // el topper recién guardado no recibe la playera
  assert.equal(piezaSinRegistrar({tipo:'existente',pieza:{id:'e'}}),null);
  assert.equal(piezaSinRegistrar(null),null);
});

// Calzado con UPC (#552): el número de la caja viaja desde la tarjeta hasta la fila y la etiqueta.
function calzado() {
  const t = manifiesto();
  t.db.prepare(`insert into manifiesto(upc,descripcion,nombre,departamento,precio_usd,tcin,actualizado_en) values('191907910421',?,'Tenis de mujer','SHOES',2000,'','')`).run("Women's Running Shoes");
  return t;
}
const altaCalzado = (extra: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), upc: '0191907910421', stock: 1, estado_fisico: 'nuevo', ...extra });

test('#552: la ficha del manifiesto dice si es calzado; la lámpara no', async t0 => {
  const t = calzado(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const zapato = (await t.pedir('/api/manifiesto/0191907910421')).cuerpo;
  assert.equal(zapato.calzado, true); assert.equal(zapato.departamento, 'SHOES');
  assert.equal((await t.pedir('/api/manifiesto/0191907910414')).cuerpo.calzado, false);
  // Una pieza ya identificada sin manifiesto (la ficha «propia») también se reconoce por su nombre.
  t.db.prepare("insert into productos (id, upc, nombre, categoria, precio_lista, precio, estado_fisico, stock, estado_analisis, destino, propietario, semana_ingreso, creado_en, actualizado_en) values (?, '555555555552', 'Tenis Nike Court', 'ropa', 50000, 40000, 'nuevo', 1, 'listo', 'etiqueta', 'dolaron', 'S44', '', '')").run(crypto.randomUUID());
  assert.equal((await t.pedir('/api/manifiesto/555555555552')).cuerpo.calzado, true);
});

test('#552: POST /api/borradores/upc guarda la talla, la etiqueta la imprime y un reintento no duplica', async t0 => {
  const t = calzado(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const a = altaCalzado({ talla: '27' });
  const r = await t.pedir('/api/borradores/upc', a);
  assert.equal(r.status, 201);
  assert.equal(t.db.prepare('select talla from productos where id=?').get(a.id)!.talla, '27');
  const etiqueta = (await t.pedir('/api/etiquetas', { ids: [a.id] })).cuerpo[0];
  assert.match(tsplEtiqueta(etiqueta, 1, 0, 2), /\/ 27/);
  assert.equal((await t.pedir('/api/borradores/upc', a)).status, 201, 'El reintento con el mismo id responde la misma pieza');
  assert.equal(t.db.prepare('select count(*) n from productos where upc is not null').get()!.n, 1);
  assert.equal(t.db.prepare('select stock from productos where id=?').get(a.id)!.stock, 1);
  // Talla de niño en cm; sin talla la pieza sigue naciendo como antes (la obligatoriedad vive en la tarjeta).
  const nino = altaCalzado({ talla: 'Niño 17', upc: '0191907910414' });
  assert.equal((await t.pedir('/api/borradores/upc', nino)).status, 201);
  assert.equal(t.db.prepare('select talla from productos where id=?').get(nino.id)!.talla, 'Niño 17');
  const sin = altaCalzado({ estado_fisico: 'liquidacion' });
  assert.equal((await t.pedir('/api/borradores/upc', sin)).status, 201);
  assert.equal(t.db.prepare('select talla from productos where id=?').get(sin.id)!.talla, null);
});

test('#552: una talla que no existe es 400 y no deja fila; una talla nueva no cambia una pieza ya registrada', async t0 => {
  const t = calzado(); t0.after(async () => { await t.esperar(); t.db.close(); });
  for (const mala of ['99', 'Niño 9', 'm', 27, ['27']]) {
    assert.equal((await t.pedir('/api/borradores/upc', altaCalzado({ talla: mala }))).status, 400, JSON.stringify(mala));
  }
  assert.equal(t.db.prepare('select count(*) n from productos where upc is not null').get()!.n, 0);
  const primera = altaCalzado({ talla: '27' });
  await t.pedir('/api/borradores/upc', primera);
  const suma = await t.pedir('/api/borradores/upc', altaCalzado({ talla: '28' }));
  assert.equal(suma.status, 201);
  assert.equal(t.db.prepare('select talla from productos where id=?').get(primera.id)!.talla, '27', 'sumar no cambia la talla');
  assert.equal(t.db.prepare('select stock from productos where id=?').get(primera.id)!.stock, 2);
});

test('#552: la foto con UPC y talla (cola del celular) llega al alta con la talla', async t0 => {
  const t = calzado(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const id = crypto.randomUUID();
  const f = formularioPendiente(registroFoto(new Blob(['foto'], { type: 'image/jpeg' }), { id, upc: '0191907910421', talla: '27' }));
  assert.equal(f.get('talla'), '27');
  const r = await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: f }) as never, t.env, t.ctx as never);
  assert.equal(r.status, 201);
  const fila = t.db.prepare('select talla, upc, foto_key from productos where id=?').get(id)!;
  assert.deepEqual([fila.talla, fila.upc, fila.foto_key], ['27', '0191907910421', `fotos/${id}.jpg`]);
  const mala = formularioPendiente(registroFoto(new Blob(['foto'], { type: 'image/jpeg' }), { id: crypto.randomUUID(), upc: '0191907910421', talla: '99' }));
  assert.equal((await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: mala }) as never, t.env, t.ctx as never)).status, 400);
});

test('#552: sin el número del calzado la tarjeta no guarda; con él lo manda', async () => {
  const llamadas: any[] = [];
  const flujo = crearCaptura({ enLinea: () => true, imprimir: async () => true, api: async (ruta, cuerpo) => { llamadas.push([ruta, cuerpo]); return { id: 'x', estado_analisis: 'listo' }; } });
  const a: any = { tipo: 'nueva', id: 'estable', upc: '0191907910421', ficha: { calzado: true, nombre: 'Tenis' }, cantidad: 1, estado: 'nuevo' };
  flujo.retomar(a);
  assert.equal(faltaCalzado(a), 'Falta número de calzado');
  await assert.rejects(flujo.guardar(), /Falta el número del calzado/);
  assert.equal(llamadas.length, 0); assert.equal(flujo.actual(), a);
  a.talla = '27';
  assert.equal(faltaCalzado(a), '');
  await flujo.guardar();
  assert.equal(llamadas[0][0], '/api/borradores/upc'); assert.equal(llamadas[0][1].talla, '27');
  // Lo que no es calzado no manda talla y la guardia no lo toca.
  llamadas.length = 0;
  flujo.retomar({ tipo: 'nueva', id: 'otro', upc: '0191907910414', ficha: { calzado: false }, cantidad: 1, estado: 'nuevo' });
  await flujo.guardar();
  assert.equal('talla' in llamadas[0][1], false);
  assert.equal(faltaCalzado({ tipo: 'sin-registro', ficha: { calzado: true } }), '');
});

test('#552: el campo «Número de la caja» ofrece los renglones, ordena por el nombre y elige con un toque o con Enter', () => {
  class Nodo {
    textContent = ''; className = ''; children: Nodo[] = []; dataset: Record<string, string> = {}; atributos: Record<string, string> = {}; value = ''; onclick: Function = () => {}; oninput: Function = () => {};
    append(...n: Nodo[]) { this.children.push(...n); } replaceChildren(...n: Nodo[]) { this.children = n; }
    setAttribute(k: string, v: string) { this.atributos[k] = v; }
  }
  const nodo = (_tag: string, texto = '', clase = '') => Object.assign(new Nodo(), { textContent: texto, className: clase });
  const boton = (texto: string, accion: Function) => Object.assign(new Nodo(), { textContent: texto, onclick: accion });
  const a: any = { tipo: 'nueva', upc: '1', ficha: { calzado: true } }; let cambios = 0;
  const n = numeroCalzado({ nodo, boton } as any, a, { nombre: 'Tenis de mujer', descripcion: "Women's Running Shoes" }, () => cambios++);
  const chips = () => (n.raiz.children[1] as Nodo).children;
  const escribir = (texto: string) => { (n.campo as any).value = texto; (n.campo as any).oninput(); };
  assert.equal(chips().length, 0);
  escribir('9');
  assert.deepEqual(chips().slice(0, 2).map(c => c.textContent), ['US 9 M · 26', 'US 9 H · 27'], "Women's: mujer primero");
  assert.ok(chips().length <= 8);
  chips()[1].onclick();
  assert.equal(a.talla, '27'); assert.equal(chips()[1].atributos['aria-pressed'], 'true'); assert.equal(chips()[0].atributos['aria-pressed'], 'false'); assert.equal(cambios, 1);
  escribir('28');
  assert.equal(a.talla, undefined, 'Escribir otro número quita el anterior: no se guarda uno viejo'); assert.equal(faltaCalzado(a), 'Falta número de calzado');
  n.elegirPrimero();
  assert.ok(a.talla); assert.equal(a.tallaRotulo, chips()[0].textContent);
  escribir('99'); assert.equal(chips().length, 0); n.elegirPrimero(); assert.equal(a.talla, undefined);
  // Repintado de la tarjeta: el texto y la elección se conservan.
  escribir('11c'); n.elegirPrimero();
  const otra = numeroCalzado({ nodo, boton } as any, a, { nombre: 'Tenis', descripcion: '' }, () => {});
  assert.equal((otra.campo as any).value, '11c'); assert.equal((otra.raiz.children[1] as Nodo).children[0].atributos['aria-pressed'], 'true');
});

test('#552: vigilarLectorEnCampo avisa a salir si lo que terminó en Enter fue un lector (no elegir el primer chip)', () => {
  const campo = Object.assign(new EventTarget(), { value: '' }) as any;
  let reloj = 0; const salidas: boolean[] = [];
  vigilarLectorEnCampo(campo, { ahora: () => reloj, salir: (lector?: boolean) => { salidas.push(!!lector); }, alLeer: () => {} });
  const tecla = (key: string, ms: number) => { reloj += ms; campo.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key })); if (key.length === 1) campo.value += key; };
  for (const k of '1234567890') tecla(k, k === '1' ? 400 : 10);
  tecla('Enter', 10);
  campo.value = '';
  for (const k of '28') tecla(k, k === '2' ? 400 : 200);
  tecla('Enter', 200);
  assert.deepEqual(salidas, [true, false]);
});
