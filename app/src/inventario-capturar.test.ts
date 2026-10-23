import test from 'node:test';
import assert from 'node:assert/strict';
import { crearCaptura } from '../public/inventario-capturar.js';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { crearLector } from '../public/lector.js';

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
