import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { permitidaParaVendedor } from './worker.ts';
import { tienda, DUENO } from './prueba-d1.ts';
import { permiso, puede, type Rol } from './cuentas.ts';

test('/inventario por rol y host; el portal y Ajustes del host de captura permanecen cerrados', async(t0)=>{
  const t=tienda();t0.after(()=>t.db.close());
  t.env.ASSETS={fetch:async()=>new Response('inventario')} as Fetcher;
  for(const rol of ['dueno','capturista','finanzas','cajero','computadora','auxiliar'] as Rol[]){
    const correo=rol+'@prueba.mx'; if(rol!=='dueno') t.db.prepare("insert into usuarios(correo,nombre,roles,activo,creado_en,actualizado_en) values(?,?,?,1,'','')").run(correo,rol,rol);
    t.env.DEV_USUARIO=rol==='dueno'?DUENO:correo;
    assert.equal(puede({correo,nombre:'',roles:[rol],activo:true,caja:'',editar_inventario:false},permiso('/inventario','GET')),['dueno','capturista','finanzas'].includes(rol));
    const r=await worker.fetch!(new Request('https://caja.prueba/inventario') as never,t.env,t.ctx as never);
    assert.equal(r.status,['dueno','capturista','finanzas'].includes(rol)?200:302);
    t.env.HOST_VENDEDOR='captura.prueba';
    const yo=await worker.fetch!(new Request('https://captura.prueba/api/yo') as never,t.env,t.ctx as never);
    const d=await yo.json() as any; assert.equal(d.vendedor,true);
    // Imprimir desde el celular (#440): dueño, capturista y FEP; el cajero y los demás roles no imprimen.
    assert.deepEqual(d.modos_inventario,rol==='dueno'||rol==='capturista'?['capturar','buscar','revisar','imprimir']:rol==='finanzas'?['capturar','buscar','imprimir']:[]);
    for(const ruta of ['/admin','/api/config','/api/cuentas','/api/etiquetas','/api/etiquetas/enviadas','/etiquetas','/api/catalogo']) assert.equal(permitidaParaVendedor(ruta,'GET'),false,ruta);
  }
  for(const ruta of ['/inventario','/inventario.html','/inventario/','/inventario.js','/lector.js','/api/piezas','/api/piezas/x','/api/foto/x','/api/borradores']) assert.equal(permitidaParaVendedor(ruta,'GET'),true,ruta);
  assert.equal(permitidaParaVendedor('/api/piezas/x/existencia','POST'),true);
  assert.equal(permitidaParaVendedor('/api/piezas/x/existencia','PATCH'),false);
  t.env.DEV_USUARIO=DUENO;t.env.HOST_PORTAL='portal.prueba';
  assert.equal((await worker.fetch!(new Request('https://portal.prueba/inventario') as never,t.env,t.ctx as never)).status,404);
});

test('/pieza es alias de Buscar y conserva la consulta; las cinco rutas previas sirven assets',async(t0)=>{
  const t=tienda();t0.after(()=>t.db.close());t.env.ASSETS={fetch:async()=>new Response('pantalla anterior')} as Fetcher;
  for(const ruta of ['/pieza','/pieza.html','/pieza/']){
    const r=await worker.fetch!(new Request(`https://caja.prueba${ruta}?pieza=ED-002318`) as never,t.env,t.ctx as never);
    assert.equal(r.status,302);assert.equal(r.headers.get('location'),'https://caja.prueba/inventario?pieza=ED-002318#buscar');
  }
  for(const ruta of ['/captura','/escanear','/admin','/etiquetas','/bandas']){
    const r=await worker.fetch!(new Request(`https://caja.prueba${ruta}`) as never,t.env,t.ctx as never);
    // Captura aplica HTMLRewriter solo a respuestas HTML; este doble es texto.
    assert.equal(r.status,200);assert.equal(await r.text(),'pantalla anterior');
  }
});

// Regresión: una acción de ficha sin contenedor quedaba atrapada como mensaje en pantalla.
test('la pantalla única contiene todos los nodos que consumen ficha.js e inventario.js',async()=>{
  const {readFileSync}=await import('node:fs');
  const html=readFileSync('public/inventario.html','utf8');
  const ids=new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
  for(const f of ['ficha.js','inventario.js'])for(const m of readFileSync('public/'+f,'utf8').matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.has(m[1]),f+' necesita '+m[1]);
});

// #459: el host del capturista devuelve 404 a todo lo que no esté en RUTAS_VENDEDOR; un import nuevo sin ruta rompía la pantalla entera.
test('el host del capturista sirve todo el grafo de módulos, hojas y scripts de /inventario y /escanear',async()=>{
  const {readFileSync,existsSync}=await import('node:fs');
  const vistos=new Set<string>(),pend=['/inventario.html','/escanear.html'];
  for(let p;(p=pend.pop());){
    if(vistos.has(p))continue;vistos.add(p);
    // ponytail: cualquier literal './x.js' o '/x.js' (import estático, import(), src, href, constantes); los de vendor/ también.
    for(const m of readFileSync('public'+p,'utf8').matchAll(/['"`](\.{0,2}\/?[\w./-]+\.(?:js|css))['"`]/g)){
      const ruta='/'+m[1].replace(/^\.?\/+/,'');
      // También se recorre /inventario-imprimir.js (#440): el capturista imprime desde su celular.
      if(existsSync('public'+ruta))pend.push(ruta);
    }
  }
  assert.ok(vistos.size>20,'el recorrido debe encontrar el grafo ('+vistos.size+')');
  const bloqueadas=[...vistos].filter(r=>!permitidaParaVendedor(r.replace(/\.html$/,''),'GET'));
  assert.deepEqual(bloqueadas,[],'rutas sin permitir en el host del capturista');
});
