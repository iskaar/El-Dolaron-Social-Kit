import { guardar, leer, borrar, pendientes } from './cola-fotos.js';
import { registroFoto, crearSubida } from './foto-pendiente.js';
import { crearCamara, crearReposoCamara } from './camara-inventario.js';
import { aJpeg, reducirArchivo } from './foto.js';
import { ESTADOS } from './estados.js';
import { ropa, opciones, talla } from './inventario-ropa.js';
import { stepper, bloquear, cerrarHoja } from './inventario-ui.js';
import { estadoEnvio } from './envio-etiquetas.js';
import { esRopa } from './ropa.js';

export async function iniciarCelular(ctx,captura) {
  const {$,nodo,boton,mensaje,hoja,api,confirmar}=ctx;
  const visor=nodo('div',undefined,'visor'),video=nodo('video');video.playsInline=true;video.muted=true;video.autoplay=true;video.setAttribute('aria-label','Vista de la cámara');visor.append(video);
  const accionesVisor=nodo('div',undefined,'acciones visor-acciones'),reanudar=boton('Empezar',encender,'primario'),subirArchivo=boton('Subir foto',()=>archivo.click()),menu=boton('⋯',opcionesCamara);menu.setAttribute('aria-label','Opciones de cámara');accionesVisor.append(reanudar,subirArchivo,menu);visor.append(accionesVisor);
  let usarCamara=true,abriendoCamara=false;try{usarCamara=sessionStorage.getItem('inventario-camara')!=='false';}catch{}
  async function cambiarCamara(encendida){usarCamara=encendida;try{sessionStorage.setItem('inventario-camara',String(usarCamara));}catch{}if(usarCamara)await encender();else{camara.pausar();visor.classList.remove('bloqueada');visor.querySelector('.permiso-camara')?.remove();pintarCamara();}}
  const alternar=boton('',()=>cambiarCamara(!camara.pista()),'alternar-camara');
  const icono=document.createElementNS('http://www.w3.org/2000/svg','svg'),uso=document.createElementNS('http://www.w3.org/2000/svg','use'),etiquetaCamara=nodo('span');icono.setAttribute('class','icono');icono.setAttribute('aria-hidden','true');uso.setAttribute('href','#i-camara');icono.append(uso);alternar.replaceChildren(icono,etiquetaCamara);visor.append(alternar);
  const apagada=nodo('p','Cámara en pausa · toca para encender','camara-apagada');visor.append(apagada);
  visor.addEventListener('click',e=>{if(!e.target.closest('button')&&!camara.pista())void cambiarCamara(true);});
  const contador=nodo('p',''),carrusel=nodo('div',undefined,'carrusel'),tira=nodo('section',undefined,'tira-capturas');tira.append(contador,carrusel);
  const todas=boton('Ver todas',()=>{const c=nodo('div',undefined,'lista-capturas');for(const r of sesion.values())c.append(miniatura(r));hoja('Capturas de 24 h',c);});const encabezado=nodo('div',undefined,'cabecera-carrusel');encabezado.append(contador,todas);tira.prepend(encabezado);
  const archivo=nodo('input');archivo.type='file';archivo.accept='image/*';archivo.setAttribute('capture','environment');archivo.hidden=true;
  const inicio=nodo('div',undefined,'empezar-captura');inicio.append(nodo('h2','Capturar'),boton('Empezar',async()=>{inicio.hidden=true;sonar('ok');if(usarCamara)await encender();},'primario'),nodo('p','Cámara y sonido'));
  captura.entrada.prepend(visor,tira);captura.entrada.append(archivo);$('modo-capturar').append(inicio);
  captura.disparo.className='disparo';
  captura.sinFoto.hidden=true;
  captura.entrada.classList.add('captura-movil');captura.entrada.append(captura.pieza);captura.pieza.className='pieza-movil';
  captura.tipo.classList.add('tipo-cabecera');$('menu').before(captura.tipo);captura.escribir.hidden=true;
  const barra=nodo('div',undefined,'barra-captura');barra.setAttribute('role','group');barra.setAttribute('aria-label','Controles de captura');barra.append(captura.grado,captura.disparo,captura.contador);captura.entrada.append(barra);
  for(const b of captura.grado.querySelectorAll('button')){const t=b.textContent;b.setAttribute('aria-label',t);b.textContent=({nuevo:'A\nNuevo',danado:'B\nDañado',liquidacion:'C\nLiq.'})[b.dataset.valor];}
  visor.after(captura.tablero.raiz);
  captura.tablero.sincronizar();
  const sesion=new Map();let revisando=null,disparando=false,tomandoPara=null,enviando=false,despierto=null,archivoPara=null,revisionFoto=null;
  let contextoAudio;
  function sonar(tipo){
    const tonos={ok:[[880,90]],mas:[[1320,60]],existe:[[1320,60],[1320,60]],sin:[[440,120],[330,120]],error:[[220,250],[180,250]],etiqueta:[[1046,80],[1568,120]]}[tipo]||[];
    if(localStorage.getItem('inventario-sonido')!=='false')try{contextoAudio??=new AudioContext();let t=contextoAudio.currentTime;for(const[f,ms]of tonos){const o=contextoAudio.createOscillator();o.frequency.value=f;o.connect(contextoAudio.destination);o.start(t);o.stop(t+ms/1000);t+=ms/1000+.05;}}catch{}
    if(localStorage.getItem('inventario-vibracion')!=='false')navigator.vibrate?.(tipo==='error'?[200,100,200]:tipo==='etiqueta'?[150,80,150,80,150]:40);
    visor.dataset.destello=tipo;setTimeout(()=>{delete visor.dataset.destello;},tipo==='etiqueta'?1500:350);
  }
  function pintarCamara(){const activa=!!camara.pista();alternar.setAttribute('aria-pressed',String(activa));etiquetaCamara.textContent=activa?'Cámara':'Apagada';apagada.hidden=activa;video.hidden=!activa;reanudar.hidden=!usarCamara||activa;subirArchivo.hidden=activa;sincronizarReposo();}
  const reposo=crearReposoCamara({apagar:()=>cambiarCamara(false)});
  function sincronizarReposo(){reposo.pausar(!camara.pista()||$('hoja').open||document.hidden||$('modo-capturar').hidden);}
  const camara=crearCamara({video,puedeLeer:()=>!revisando&&!$('hoja').open,alLeer:codigo=>{reposo.actividad();ctx.recibir(codigo,'camara').then(()=>sonar(captura.flujo.actual()?.tipo==='existente'?'existe':captura.flujo.actual()?.tipo==='sin-registro'?'sin':'ok')).catch(e=>{mensaje(e.message,'aviso');sonar('error');});},alEstado:pintarCamara});
  for(const evento of ['pointerdown','input','keydown','scroll'])document.addEventListener(evento,()=>{if(!$('modo-capturar').hidden)reposo.actividad();},{capture:true,passive:true});
  document.addEventListener('visibilitychange',sincronizarReposo);
  new MutationObserver(sincronizarReposo).observe($('hoja'),{attributes:true,attributeFilter:['open']});
  setInterval(()=>{sincronizarReposo();reposo.comprobar();},1000);
  pintarCamara();
  async function encender(){
    if(!usarCamara||abriendoCamara)return;
    reposo.actividad();
    abriendoCamara=true;bloquear(alternar,'Espera la cámara');video.hidden=false;
    try{if(await camara.abrir()){reanudar.hidden=true;visor.classList.remove('bloqueada');visor.querySelector('.permiso-camara')?.remove();captura.neutro();}}
    catch(e){camara.pausar();pintarCamara();reanudar.textContent='Reintentar';visor.classList.add('bloqueada');mensaje(e.name==='NotAllowedError'?'Cámara bloqueada · revisa permisos':'Otra app usa la cámara','error');const instrucciones=nodo('ol',undefined,'permiso-camara');instrucciones.append(nodo('li','Toca el candado de la barra de direcciones.'),nodo('li','Permisos › Cámara › Permitir.'));visor.querySelector('.permiso-camara')?.remove();visor.append(instrucciones);}
    finally{abriendoCamara=false;bloquear(alternar,'');pintarCamara();}
  }
  const subida=crearSubida({pendientes,leer,borrar,pausada:id=>revisando===id,
    alEstado(estado,r){const datos=sesion.get(r.id);if(datos)datos.estado=estado;pintar();if(estado==='sesion')mensaje('Tu sesión venció · vuelve a entrar','error');},
    async alSubir(r,d){if(d.existente){sesion.delete(r.id);sesion.set(d.id,{...d,subida:true,cantidad:r.cantidad,estado:d.estado_analisis==='pendiente'?'analizando':'subida'});pintar();await captura.recibirExistente(d);return;}if(d.estado_analisis==='descartado'){sesion.delete(r.id);pintar();return;}sesion.set(r.id,{...sesion.get(r.id),...r,subida:true,estado:d.estado_analisis==='pendiente'?'analizando':'subida',...d,cantidad:d.stock??r.cantidad});pintar();}
  });
  async function subir(){
    if(enviando||!navigator.onLine)return;pintarRed();enviando=true;
    const drenar=async()=>{const otra=await subida.subir();if(otra)setTimeout(subir,1000);};
    try{if(navigator.locks)await navigator.locks.request('inventario-fotos',{ifAvailable:true},lock=>lock?drenar():undefined);else await drenar();}
    finally{enviando=false;pintar();}
  }
  function pintarRed(){const n=[...sesion.values()].filter(r=>!r.subida).length;$('chip-red').textContent=navigator.onLine?(n?`▲ ${n} sin subir`:'● Red'):`▲ Sin red · ${n}`;$('chip-red').classList.toggle('aviso',!navigator.onLine||n>0);}
  function miniatura(r){
    const b=boton('',()=>corregir(r.id),'miniatura '+(!r.subida?'local':'subida'));const img=nodo('img');img.alt='';img.src=r.url||`/api/foto/${r.id}`;img.onerror=()=>{img.hidden=true;};
    const estado=r.estado==='subiendo'?'↑':r.estado==='analizando'?'⏳':r.estado==='error'||r.estado==='sesion'?'■':r.subida?'✓':'☁';
    b.append(img,nodo('span',r.talla||'','mini-talla'),nodo('span',`${estado} ×${r.cantidad??r.stock??1}`,'mini-estado'));
    b.setAttribute('aria-label',`${r.nombre||r.prenda||'Pieza'} ${r.talla||''}, ${r.cantidad??1} piezas, ${r.subida?'subida':'en el teléfono'}`);return b;
  }
  function pintar(){
    carrusel.replaceChildren();const ahora=Date.now();const registros=[...sesion.values()].filter(r=>!r.subida||ahora-(r.creado??Date.parse(r.creado_en))<86400000).sort((a,b)=>(b.creado??Date.parse(b.creado_en))-(a.creado??Date.parse(a.creado_en)));
    for(const r of registros.slice(0,24))carrusel.append(miniatura(r));
    const piezas=registros.reduce((n,r)=>n+(r.cantidad??1),0),subidas=registros.filter(r=>r.subida).length;contador.textContent=`Hoy · ${piezas} ${piezas===1?'pieza':'piezas'} · ${subidas} ${subidas===1?'subida':'subidas'}`;tira.hidden=!registros.length;pintarRed();
  }
  async function conservar(foto,a){
    reposo.actividad();
    const upc=a?.upc;const ropaSinCodigo=captura.esRopa()&&!upc;
    if(ropaSinCodigo&&!captura.tablero.validar())throw new Error('Completa talla y precio');
    const r=registroFoto(foto,{id:a?.id||crypto.randomUUID(),estado_fisico:ropaSinCodigo?'nuevo':a?.estado||captura.estado(),cantidad:a?.cantidad||captura.cantidad(),...(ropaSinCodigo?captura.tablero.valores():{upc:upc??''})});
    await guardar(r);sesion.set(r.id,{...r,url:URL.createObjectURL(foto),subida:false});captura.flujo.limpiar();captura.contador.poner(1);pintar();mensaje(navigator.onLine?'Foto guardada en el teléfono':'Sin red · foto en el teléfono',navigator.onLine?'ok':'aviso');
    if(localStorage.getItem('inventario-vibracion')!=='false')navigator.vibrate?.(30);void subir();return r;
  }
  async function tomar(a=captura.flujo.actual()){
    if(disparando)return;
    if(a?.tipo==='existente')return fotoPieza(a.pieza);
    if(captura.esRopa()&&!a?.upc&&!captura.tablero.validar()){sonar('error');return;}
    if(!camara.pista()||!video.videoWidth){archivoPara=a;archivo.click();return;}
    disparando=true;try{const foto=await aJpeg(video,video.videoWidth,video.videoHeight);if(!foto)throw new Error('No se pudo tomar foto');await conservar(foto,a?.tipo==='existente'?null:a);}finally{disparando=false;}
  }
  archivo.onchange=async()=>{const f=archivo.files?.[0];if(!f)return;try{const foto=await reducirArchivo(f);if(archivoPara?.existente){await reemplazarFoto(archivoPara.existente,foto);cerrarHoja();}else if(archivoPara?.local)await retomarLocal(archivoPara.local,foto);else await conservar(foto,archivoPara||captura.flujo.actual());}catch(e){mensaje(e.message,'error');}finally{archivo.value='';archivoPara=null;}};
  archivo.oncancel=()=>{archivoPara=null;};
  async function reemplazarFoto(p,foto){
    reposo.actividad();
    if(!navigator.onLine)throw new Error('Sin red · conserva la foto');
    revisionFoto=foto;const f=new FormData();f.set('id',p.id);f.set('solo_foto','1');f.set('estado_fisico',p.estado_fisico||'nuevo');f.set('foto',foto,`${p.id}.jpg`);
    const r=await fetch('/api/borradores',{method:'POST',body:f});if(!r.ok)throw new Error((await r.json()).error||'No se subió la foto');revisionFoto=null;mensaje('Foto reemplazada','ok');
  }
  async function fotoPieza(p){
    return new Promise(resolve=>{
    const c=nodo('div');c.append(nodo('p','Tomar foto de la pieza'),boton('Tomar foto',async()=>{if(!camara.pista()||!video.videoWidth){archivoPara={existente:p};archivo.click();return;}await reemplazarFoto(p,await aJpeg(video,video.videoWidth,video.videoHeight));cerrarHoja();},'primario'),boton('Subir foto',()=>{archivoPara={existente:p};archivo.click();}));hoja('Foto nueva',c);$('hoja').addEventListener('close',resolve,{once:true});
    });
  }
  async function retomarLocal(r,foto){reposo.actividad();r={...r,foto,version:(r.version??0)+1};await guardar(r);const anterior=sesion.get(r.id)?.url;if(anterior)URL.revokeObjectURL(anterior);sesion.set(r.id,{...sesion.get(r.id),...r,url:URL.createObjectURL(foto)});pintar();}
  async function corregir(id){
    if(subida.id()===id)return mensaje('Espera a que suba','aviso');
    const datos=sesion.get(id);if(!datos)return;revisando=id;
    let local,actual;
    try{local=await leer(id);actual=local?{...local,precio:local.precio_ropa,stock:local.cantidad}:await api(`/api/borradores/${id}/revision`);}
    catch(e){revisando=null;throw e;}
    if(actual.estado_analisis==='descartado'){sesion.delete(id);revisando=null;pintar();return;}
    const c=nodo('div',undefined,'corregir-captura'),img=nodo('img');img.src=datos.url||`/api/foto/${id}`;img.alt='Foto de '+(datos.nombre||datos.prenda||'la pieza');c.append(img);
    let cambios={estado_fisico:actual.estado_fisico},cantidad=actual.stock,tallaActual=actual.talla||'',cambiado=false;
    const actualizar=()=>{cambiado=true;bloquear(guardarBoton,'');};
    if(!esRopa(actual))c.append(opciones(ESTADOS,actual.estado_fisico,v=>{cambios.estado_fisico=v;actualizar();},'Grado'));
    c.append(stepper(cantidad,n=>{cantidad=n;actualizar();},{max:999,nombre:'Piezas'}));
    const tablero=esRopa(actual)?ropa({pc:()=>false,mensaje,recordar:false,inicial:{talla:tallaActual,prenda:actual.prenda||'',marca:actual.marca||'',precio_ropa:actual.precio},cambiar:()=>actualizar()}):null;
    if(tablero)c.append(tablero.raiz);else if(tallaActual)c.append(talla(v=>{tallaActual=v;actualizar();},tallaActual));
    const marca=estadoEnvio({...actual,id}).marca;if(marca)c.append(nodo('p',`La etiqueta pegada dice $${marca.precio/100}`,'aviso'));
    const guardarBoton=boton('Guardar cambios',async()=>{
      if(!cambiado)return mensaje('Sin cambios','aviso');
      if(!navigator.onLine&&(!local||cantidad!==actual.stock))return mensaje('Sin red: se suma al volver la señal','aviso');
      if(tablero&&!tablero.validar())return;
      const r=tablero?.valores();if(r){cambios={...cambios,prenda:r.prenda,marca:r.marca,precio:r.precio_ropa};tallaActual=r.talla;}
      if(local){
        // Un alta pudo llegar aunque su respuesta se perdiera: corregirla por sus rutas de 24 h.
        if(cantidad!==actual.stock||tallaActual!==actual.talla){
          try{const remota=await api(`/api/borradores/${id}/revision`);
            if(cantidad!==remota.stock)await api(`/api/borradores/${id}/existencia`,{stock:cantidad},'PATCH');
            if(tallaActual&&tallaActual!==remota.talla)await api(`/api/borradores/${id}/talla`,{talla:tallaActual},'PATCH');
          }catch(e){if(e.status!==404)throw e;}
        }
        local={...local,cantidad,talla:tallaActual||null,estado_fisico:cambios.estado_fisico,...(r?{prenda:r.prenda,marca:r.marca,precio_ropa:r.precio_ropa,correccion_ficha:{...local.correccion_ficha,...cambios}}:{}),version:(local.version??0)+1};await guardar(local);Object.assign(datos,local);sesion.set(id,datos);
      }else{
        // La corrección propia conserva la ventana y validaciones de /captura; nunca se encola.
        if(cantidad!==actual.stock)await api(`/api/borradores/${id}/existencia`,{stock:cantidad},'PATCH');
        if(tallaActual&&tallaActual!==actual.talla)await api(`/api/borradores/${id}/talla`,{talla:tallaActual},'PATCH');
        if(r||cambios.estado_fisico!==actual.estado_fisico)await api(`/api/borradores/${id}/revision`,cambios,'PATCH');
        Object.assign(datos,{cantidad,talla:tallaActual,estado_fisico:cambios.estado_fisico,...(r?{precio_ropa:r.precio_ropa,prenda:r.prenda,marca:r.marca}:{})});
      }
      cerrarHoja();mensaje('Cambios guardados','ok');pintar();
    },'primario');bloquear(guardarBoton,'Sin cambios');c.append(guardarBoton);
    c.append(boton('Retomar foto',async()=>{if(local){if(camara.pista()&&video.videoWidth)await retomarLocal(local,await aJpeg(video,video.videoWidth,video.videoHeight));else{archivoPara={local};archivo.click();}}else{await fotoPieza({...datos,id});}if(local)cerrarHoja();}));
    const descartar=boton('Descartar',async b=>{
      if(b.dataset.confirmar!=='true'){b.dataset.confirmar='true';b.textContent='¿Descartar esta pieza?';b.classList.add('confirmando');mensaje('Se descarta la captura completa','aviso');setTimeout(()=>{b.dataset.confirmar='false';b.textContent='Descartar';b.classList.remove('confirmando');},4000);return;}
      if(!navigator.onLine)return mensaje('Sin red · vuelve a intentar','aviso');await api(`/api/borradores/${id}/revision`,{},'DELETE');await borrar(id);if(datos.url)URL.revokeObjectURL(datos.url);sesion.delete(id);cerrarHoja();pintar();mensaje('Captura descartada','ok');
    },'peligro');c.append(descartar);
    hoja('Corregir',c);tablero?.sincronizar();$('hoja').addEventListener('close',()=>{revisando=null;void subir();},{once:true});
  }
  function opcionesCamara(){
    const c=nodo('div',undefined,'formulario');
    c.append(boton('Subir foto',()=>{archivoPara=null;archivo.click();}));
    if(ctx.dueno)c.append(boton('Pieza sin foto',()=>captura.manual()));const pista=camara.pista(),rango=pista?.getCapabilities?.().zoom;
    if(rango&&rango.max>rango.min){const l=nodo('label','Zoom'),input=nodo('input');input.type='range';Object.assign(input,{min:rango.min,max:rango.max,step:rango.step||.1,value:pista.getSettings().zoom||rango.min});input.oninput=()=>{const zoom=Number(input.value);if(pista.getSettings().zoom!==zoom)pista.applyConstraints({advanced:[{zoom}]}).catch(()=>{});localStorage.setItem('captura-zoom',input.value);};l.append(input);c.append(l);}
    c.append(boton('Producto sin código',()=>{captura.flujo.limpiar();cerrarHoja();}),boton('Reanudar cámara',async()=>{cerrarHoja();await cambiarCamara(true);}),boton('Escribir código',()=>{cerrarHoja();$('busqueda').hidden=false;$('consulta').inputMode='numeric';$('consulta').focus();}));hoja('Cámara',c);
  }
  async function recuperar(){
    for(const r of await pendientes())if(!sesion.has(r.id))sesion.set(r.id,{...r,url:URL.createObjectURL(r.foto),subida:false});pintar();
    if(navigator.onLine)try{const desde=new Date(Date.now()-86400000).toISOString(),d=await api('/api/borradores?'+new URLSearchParams({desde}));for(const p of d){if(p.capturado_por!==(ctx.identidad.correo||ctx.identidad.usuario?.correo)||sesion.has(p.id))continue;sesion.set(p.id,{...p,cantidad:p.stock,creado:Date.parse(p.creado_en),subida:true,estado:p.estado_analisis==='pendiente'?'analizando':'subida'});}pintar();}catch{}
    void subir();
  }
  addEventListener('online',()=>{pintar();void subir();});addEventListener('offline',pintar);setInterval(subir,20000);
  await recuperar();
  return {tomar,fotoPieza,subir,sonar,actividad:()=>reposo.actividad(),async abrir(){pintar();pintarCamara();if(!inicio.hidden)return;reanudar.textContent='Reanudar';},pausar(){camara.pausar();pintarCamara();reanudar.textContent='Reanudar';},camara,corregir};
}
