// Run: node --test src/marketplace.test.ts
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html = fs.readFileSync(new URL('../public/marketplace.html', import.meta.url), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(html.match(/<script id="catalog-logic">([\s\S]*?)<\/script>/)[1], context);
const logic = context.CatalogLogic;
const product = {id:'test', nombre:'ARNÉS púrpura', codigo:'ED-1', marca:'Marca', categoria:'mascotas', precio:11999, stock:3, estado_fisico:'nuevo', foto_key:'fotos/test.jpg', estado_analisis:'listo', sin_inventario:0, destino:'etiqueta'};
const filters = {search:'arnes purpura', category:'mascotas', priceMin:'119.99', priceMax:'119.99', stockMin:'3', stockMax:'3'};
assert(logic.matches(product, filters));
assert(logic.matches({...product,estado_fisico:'danado'}, filters));
assert(logic.condition({...product,estado_fisico:'danado'}).includes('dañado'));
assert(!logic.condition({...product,estado_fisico:'danado'}).includes('Nuevo'));
for (const [key,value] of [['search','other'],['category','juguetes'],['priceMin','120'],['priceMax','119.98'],['stockMin','4'],['stockMax','2']]) assert(!logic.matches(product, {...filters,[key]:value}));
assert(!logic.matches({...product,stock:0}, {...filters,stockMin:'0'}));
assert(!logic.eligible({...product,id:'87ddd327-2058-435d-98ea-651a6e54c09a'}));
assert(!logic.eligible({...product,precio:0}));
for (const patch of [{nombre:'   '},{destino:'retirado'},{destino:'desconocido'},{foto_key:'   '},{foto_key:'fotos/otro.jpg'}]) assert(!logic.eligible({...product,...patch}));
assert(!logic.eligible({...product,precio:1.5}));
const products=Array.from({length:20},(_,index)=>({...product,id:String(index)}));
assert.equal(logic.batch(products,0).length,9);
assert.equal(logic.batch(products,9)[0].id,'9');
assert.equal(logic.batch(products,18).length,2);
assert.equal(logic.batch([],0).length,0);
assert(!/<img[^>]*\ssrc=/.test(html));
assert(html.includes('img.dataset.src=photo'));
assert(html.includes("rootMargin:'150px'"));
for(const script of html.matchAll(/<script(?: id="[^"]+")?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
console.log('PASS: filters, centavo boundaries, eligibility, damaged condition, nine-item batches, deferred photo source and JS syntax.');

import test from 'node:test';
import worker from './worker.ts';
import { tienda, PRODUCTO } from './prueba-d1.ts';

test('Marketplace: autorización antes de HTML/API/fotos y elegibilidad actual en D1', async () => {
 const t=tienda();
 let fotos=0, pantallas=0;
 t.env.FOTOS={get:async()=>{fotos++;return {body:'foto'};}} as unknown as R2Bucket;
 t.env.ASSETS={fetch:async()=>{pantallas++;return new Response('pantalla');}} as Fetcher;
 const pedir=async(path:string,method='GET',host='escaner.viste.com.mx')=>worker.fetch!(
   new Request(`https://${host}${path}`,{method}) as never,t.env,{waitUntil(){}} as never);
 try {
  t.db.prepare("update productos set estado_analisis='listo', foto_key=? where id=?").run(`fotos/${PRODUCTO}.jpg`,PRODUCTO);
  for(const path of ['/marketplace','/marketplace.html','/marketplace/','/marketplace-redes.png','/api/marketplace',`/api/marketplace/foto/${PRODUCTO}`]) {
   t.env.DEV_USUARIO='';assert.equal((await pedir(path)).status,401);
   for(const roles of ['cajero','computadora','']) {
    t.env.DEV_USUARIO='dueno@prueba.mx';
    t.db.prepare('update usuarios set roles=?').run(roles);
    const result=await pedir(path);
    assert.equal(result.status,path.startsWith('/api/') ? 403 : 302);
   }
  }
  assert.equal(fotos,0);assert.equal(pantallas,0);
  t.db.prepare("update usuarios set roles='capturista', activo=0").run();
  assert.equal((await pedir('/api/marketplace')).status,403);
  t.db.prepare('update usuarios set activo=1').run();
  for(const role of ['capturista','dueno']) {
   t.db.prepare('update usuarios set roles=?').run(role);
   const response=await pedir('/api/marketplace');
   assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
   const body=await response.json() as {products:{id:string}[]};
   assert.deepEqual(body.products.map(p=>p.id),[PRODUCTO]);
   assert.equal((await pedir('/marketplace')).status,200);
   const photo=await pedir(`/api/marketplace/foto/${PRODUCTO}`);
   assert.equal(photo.status,200);assert.equal(photo.headers.get('cache-control'),'no-store');
  }
  const loaded=fotos;
  for(const sql of ["stock=0","sin_inventario=1","precio=0","estado_analisis='pendiente'","estado_analisis='error'","foto_key=''", "nombre='   '", "destino='retirado'", "destino='desconocido'", "foto_key='   '", "foto_key='fotos/otro.jpg'", "id='87ddd327-2058-435d-98ea-651a6e54c09a'"]) {
   t.db.prepare("update productos set id=?,stock=50,sin_inventario=0,precio=25000,estado_analisis='listo',destino='etiqueta',nombre='Ventilador',foto_key=? where codigo='ED-000001'").run(PRODUCTO,`fotos/${PRODUCTO}.jpg`);
   t.db.exec(`update productos set ${sql} where codigo='ED-000001'`);
   assert.equal(((await (await pedir('/api/marketplace')).json()) as {products:unknown[]}).products.length,0,sql);
   const id=sql.startsWith('id=') ? '87ddd327-2058-435d-98ea-651a6e54c09a' : PRODUCTO;
   assert.equal((await pedir(`/api/marketplace/foto/${id}`)).status,404,sql);
  }
  assert.equal(fotos,loaded);
  assert.equal((await pedir('/api/marketplace','POST')).status,405);
  assert.equal((await pedir('/api/marketplace/foto/bad-id')).status,400);
  t.env.HOST_PORTAL='dolarones.eldolaron.com';t.env.HOST_VENDEDOR='captura.viste.com.mx';
  for(const host of [t.env.HOST_PORTAL,t.env.HOST_VENDEDOR]) {
   for(const path of ['/marketplace','/api/marketplace',`/api/marketplace/foto/${PRODUCTO}`])
    assert.equal((await pedir(path,'GET',host)).status,404);
  }
 } finally {t.db.close();}
});


test('Actualizar se vuelve a habilitar; un fallo limpia datos anteriores y permite reintentar', async () => {
 const refresh={disabled:false},snapshot={textContent:''},counter={textContent:''};
 const category={value:'',options:[],replaceChildren(){this.options=[];},append(option){this.options.push(option);}};
 const context={products:[], CatalogLogic:logic, counter, elements:{category}, categoryLabel:x=>x,
  document:{getElementById:id=>id==='refresh' ? refresh : snapshot, createElement:()=>({})},
  Option:function(text,value){this.text=text;this.value=value;}, filter(){}, fetch:null};
 vm.createContext(context);
 const loadSource=html.slice(html.indexOf('async function load()'),html.indexOf("document.getElementById('refresh').addEventListener"));
 vm.runInContext(loadSource,context);
 context.fetch=async()=>({ok:true,json:async()=>({products:[product],updated_at:new Date().toISOString()})});
 await context.load();assert.equal(refresh.disabled,false);assert.equal(context.products.length,1);
 context.fetch=async()=>({ok:false});
 await context.load();assert.equal(refresh.disabled,false);assert.equal(context.products.length,0);
 assert.match(snapshot.textContent,/No se pudo consultar/);
 context.fetch=async()=>({ok:true,json:async()=>({products:[product],updated_at:new Date().toISOString()})});
 await context.load();assert.equal(refresh.disabled,false);assert.equal(context.products.length,1);
});
