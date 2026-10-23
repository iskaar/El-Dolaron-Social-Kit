import test from 'node:test';
import assert from 'node:assert/strict';
import { crearCaptura } from '../public/inventario-capturar.js';
import { tienda, PRODUCTO } from './prueba-d1.ts';
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
    if (ruta.startsWith('/api/piezas?')) return { piezas: [], siguiente: null };
    if (ruta.startsWith('/api/manifiesto/')) return { nombre: 'Playera', categoria: 'ropa', precio: 12000 };
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
  const flujo=crearCaptura({api:async ruta=>{rutas.push(ruta);return ++pagina===1?{piezas:[],siguiente:'cursor'}:{piezas:[{id:'vieja',stock:2,estado_fisico:'nuevo'}],siguiente:null};},imprimir:async()=>true,enLinea:()=>true});
  await flujo.leer('012345678905');assert.equal(flujo.actual(),null);
  await flujo.leer('012345678905',true);assert.equal(flujo.actual()!.pieza.id,'vieja');
  assert.ok(rutas.every(r=>r.startsWith('/api/piezas?')));assert.match(rutas[1],/cursor=cursor/);
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
  assert.ok(rutas.every(r=>r.startsWith('/api/piezas?')));
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
  const nuevo=crearCaptura({api:async ruta=>{consultas.push(ruta);return ruta.startsWith('/api/piezas?')?{piezas:[],siguiente:null}:{nombre:'Lámpara',precio:24900};},imprimir:async()=>true,enLinea:()=>true});
  await crearLector({emitir:({codigo})=>nuevo.leer(codigo)}).recibir('012345678905','camara');
  assert.equal(nuevo.actual()?.tipo,'nueva');assert.equal(nuevo.actual()?.upc,'012345678905');
  assert.deepEqual(consultas,['/api/piezas?q=012345678905','/api/manifiesto/012345678905']);
});
