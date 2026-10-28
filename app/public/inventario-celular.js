import { guardar, leer, borrar, pendientes } from './cola-fotos.js';
import { registroFoto, crearSubida } from './foto-pendiente.js';
import { crearCamara, crearReposoCamara } from './camara-inventario.js';
import { aJpeg, reducirArchivo } from './foto.js';
import { ESTADOS } from './estados.js';
import { ropa, opciones, talla } from './inventario-ropa.js';
import { stepper, bloquear, cerrarHoja } from './inventario-ui.js';
import { estadoEnvio, sincronizarMarcas, marcaDeLaBase } from './envio-etiquetas.js';
import { esRopa } from './ropa.js';
import { cambiosTarjeta, capturaImpresa, corregirExistencia, etiquetasPorCorreccion, faltaCalzado, piezaSinRegistrar } from './inventario-capturar.js';
import { etiqueteraLista } from './etiquetera.js';

export async function iniciarCelular(ctx,captura) {
  const {$,nodo,boton,mensaje,hoja,api,confirmar}=ctx;
  const visor=nodo('div',undefined,'visor'),video=nodo('video');video.playsInline=true;video.muted=true;video.autoplay=true;video.setAttribute('aria-label','Vista de la cámara');visor.append(video);
  const accionesVisor=nodo('div',undefined,'acciones visor-acciones'),reanudar=boton('Empezar',encender,'primario'),subirArchivo=boton('Subir foto',()=>archivo.click(),'visor-subir'),menu=boton('⋯',opcionesCamara,'visor-menu');menu.setAttribute('aria-label','Opciones de cámara');accionesVisor.append(subirArchivo,menu,reanudar);visor.append(accionesVisor);
  let usarCamara=true,abriendoCamara=false;try{usarCamara=sessionStorage.getItem('inventario-camara')!=='false';}catch{}
  async function cambiarCamara(encendida){usarCamara=encendida;try{sessionStorage.setItem('inventario-camara',String(usarCamara));}catch{}if(usarCamara)await encender();else{camara.pausar();visor.classList.remove('bloqueada');visor.querySelector('.permiso-camara')?.remove();pintarCamara();}}
  const alternar=boton('',()=>cambiarCamara(!camara.pista()),'alternar-camara');
  const icono=document.createElementNS('http://www.w3.org/2000/svg','svg'),uso=document.createElementNS('http://www.w3.org/2000/svg','use'),etiquetaCamara=nodo('span');icono.setAttribute('class','icono');icono.setAttribute('aria-hidden','true');uso.setAttribute('href','#i-camara');icono.append(uso);alternar.replaceChildren(icono,etiquetaCamara);reanudar.before(alternar);
  const apagada=nodo('p','Cámara en pausa · toca para encender','camara-apagada');visor.append(apagada);
  visor.addEventListener('click',e=>{if(!e.target.closest('button')&&!camara.pista())void cambiarCamara(true);});
  const contador=nodo('p',''),carrusel=nodo('div',undefined,'carrusel'),tira=nodo('section',undefined,'tira-capturas');tira.append(contador,carrusel);
  const todas=boton('Ver todas',()=>{const c=nodo('div',undefined,'lista-capturas');for(const r of sesion.values())c.append(miniatura(r));hoja('Capturas de 24 h',c);});const revisarBoton=boton('',()=>{const r=porRevisar()[0];if(r)return corregir(r.id);},'revisar-pendientes');revisarBoton.hidden=true;
  const encabezado=nodo('div',undefined,'cabecera-carrusel');encabezado.append(contador,revisarBoton,todas);tira.prepend(encabezado);
  const archivo=nodo('input');archivo.type='file';archivo.accept='image/*';archivo.setAttribute('capture','environment');archivo.hidden=true;
  async function empezar(){if(inicio.hidden)return;inicio.hidden=true;sonar('ok');if(usarCamara)await encender();}
  const inicio=nodo('div',undefined,'empezar-captura');inicio.append(nodo('h2','Capturar'),boton('Empezar',empezar,'primario'),nodo('p','Cámara y sonido'));
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
    const tonos={ok:[[880,90]],mas:[[1320,60]],existe:[[1320,60],[1320,60]],sin:[[440,120],[330,120]],error:[[220,250],[180,250]],etiqueta:[[1046,80],[1568,120]],revisar:[[660,80],[880,80],[1100,100]]}[tipo]||[];
    if(localStorage.getItem('inventario-sonido')!=='false')try{contextoAudio??=new AudioContext();let t=contextoAudio.currentTime;for(const[f,ms]of tonos){const o=contextoAudio.createOscillator();o.frequency.value=f;o.connect(contextoAudio.destination);o.start(t);o.stop(t+ms/1000);t+=ms/1000+.05;}}catch{}
    if(localStorage.getItem('inventario-vibracion')!=='false')navigator.vibrate?.(tipo==='error'?[200,100,200]:tipo==='etiqueta'?[150,80,150,80,150]:40);
    visor.dataset.destello=tipo;setTimeout(()=>{delete visor.dataset.destello;},tipo==='etiqueta'?1500:350);
  }
  function pintarCamara(){const activa=!!camara.pista();alternar.setAttribute('aria-pressed',String(activa));etiquetaCamara.textContent=activa?'Cámara':'Apagada';apagada.hidden=activa;video.hidden=!activa;reanudar.hidden=!usarCamara||activa;subirArchivo.hidden=activa;sincronizarReposo();}
  const reposo=crearReposoCamara({apagar:()=>cambiarCamara(false)});
  function sincronizarReposo(){reposo.pausar(!camara.pista()||$('hoja').open||document.hidden||$('modo-capturar').hidden);}
  // Mientras el capturista teclea nombre o precio la cámara no lee: un código ajeno no guarda una tarjeta a medias.
  const escribiendoTarjeta=()=>{const e=document.activeElement;return !!e&&e.matches?.('input:not([readonly])')&&captura.pieza.contains(e);};
  const camara=crearCamara({video,puedeLeer:()=>!revisando&&!$('hoja').open&&!escribiendoTarjeta(),alLeer:codigo=>{reposo.actividad();ctx.recibir(codigo,'camara').then(()=>sonar(captura.flujo.actual()?.tipo==='existente'?'existe':captura.flujo.actual()?.tipo==='sin-registro'?'sin':'ok')).catch(e=>{mensaje(e.message,'aviso');sonar('error');});},alEstado:pintarCamara});
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
  // Modo enfocado (#461): lo que el chip de red mostraría, para la línea de alerta. «avance» = último intento de subida o cola vacía.
  let avance=Date.now();
  ctx.problemas.cola=()=>{const sin=[...sesion.values()].filter(r=>!r.subida);if(!sin.length)avance=Date.now();return{sinSubir:sin.length,sinAvanceMs:Date.now()-avance,colaError:sin.some(r=>r.estado==='error'||r.estado==='sesion'),sesion:sin.some(r=>r.estado==='sesion')};};
  const subida=crearSubida({pendientes,leer,borrar,pausada:id=>revisando===id,
    alEstado(estado,r){if(estado==='subiendo')avance=Date.now();const datos=sesion.get(r.id);if(datos)datos.estado=estado;pintar();if(estado==='sesion')mensaje('Tu sesión venció · vuelve a entrar','error');},
    async alSubir(r,d){if(d.existente){sesion.delete(r.id);sesion.set(d.id,{...d,subida:true,cantidad:r.cantidad,estado:d.estado_analisis==='pendiente'?'analizando':'subida'});pintar();await captura.recibirExistente(d,r.id);return;}if(d.estado_analisis==='descartado'){sesion.delete(r.id);pintar();return;}sesion.set(r.id,{...sesion.get(r.id),...r,subida:true,estado:d.estado_analisis==='pendiente'?'analizando':'subida',...d,cantidad:d.stock??r.cantidad});pintar();void prepararRevision(d);}
  });
  /**
   * Una pieza nueva con foto NO imprime sola (#573): al quedar `listo` con precio pasa a «por revisar» (✎ en su miniatura) y
   * la etiqueta sale cuando alguien pulsa «Guardar e imprimir» en su hoja de revisión (nombre, precio, cantidad y grado).
   * Lo que quede en error o sin precio va aparte. La impresión de la revisión va por el mismo reclamo que la PC: nunca sale dos veces.
   */
  // El motivo real: el aviso que dejó el motor (vendida o cambió), o la impresora.
  const razonSinEtiqueta=()=>/ya no se pued/.test($('resumen').textContent||'')?'la pieza ya no se puede imprimir (vendida o cambió)':etiqueteraLista()?'revisa la impresora':'conecta la impresora';
  /**
   * Un solo sondeo para todas las piezas que esperan su análisis (#493): `GET /api/borradores?cambios=` cada 4 s trae lo que
   * cambió desde la pendiente más vieja (con traslape), sin importar cuántas sean. Cada pieza conserva sus 40 intentos (≈160 s).
   * Al quedar sin pendientes el sondeo se apaga solo. Devuelve la pieza con lo último que se supo de ella.
   */
  const esperando=new Map();
  function esperarAnalisis(p){
    let e=esperando.get(p.id);
    if(!e){e={p,desde:Date.now(),intentos:0};e.promesa=new Promise(r=>{e.listo=r;});esperando.set(p.id,e);if(esperando.size===1)setTimeout(sondear,4000);}
    return e.promesa;
  }
  async function sondear(){
    const terminar=(e,cambios)=>{esperando.delete(e.p.id);e.listo({...e.p,...cambios});};
    let filas=null;
    try{filas=new Map((await api('/api/borradores?cambios='+encodeURIComponent(new Date(Math.min(...[...esperando.values()].map(e=>e.desde))-120000).toISOString()))).map(f=>[f.id,f]));}
    catch(e){if(e.status===403||e.status===404){for(const x of [...esperando.values()])terminar(x,{estado_analisis:'sin-seguimiento'});return;}   // no volver a preguntar 40 veces
      /* sin red: se vuelve a preguntar */}
    for(const e of [...esperando.values()]){
      const f=filas?.get(e.p.id);
      if(f&&f.estado_analisis!=='pendiente')terminar(e,f);
      else if(++e.intentos>=40)terminar(e,{});
    }
    if(esperando.size)setTimeout(sondear,4000);
  }
  const porRevisar=()=>[...sesion.values()].filter(r=>r.estado==='revisar');
  async function prepararRevision(d){
    const p=d.estado_analisis==='pendiente'?await esperarAnalisis(d):d;
    const dato=sesion.get(d.id);
    if(p.estado_analisis==='descartado')return;
    if(p.estado_analisis==='sin-seguimiento'){mensaje(`No se pudo seguir el análisis de ${p.nombre||'la pieza'}: revísala en su miniatura.`,'aviso');return;}
    if(p.estado_analisis!=='listo'||!(p.precio>0)){
      if(dato){dato.estado='error';pintar();}
      mensaje(`Aparte, sin etiqueta: ${p.nombre||'pieza sin nombre'}. Ponle precio en la revisión.`,'aviso');sonar('error');return;
    }
    if(dato){dato.estado='revisar';dato.por_revisar=1;pintar();}
    mensaje(`Por revisar: ${p.nombre}. Toca ✎ para ver precio, cantidad y grado, y guarda para imprimir.`,'aviso');sonar('revisar');
  }
  /** «Guardar e imprimir» de la revisión: la etiqueta de la cantidad confirmada, una sola vez por captura (`capturaImpresa`). */
  async function imprimirRevisada(id,n,nombre){
    const ok=await captura.imprimirCaptura(id,id,Math.min(99,n),{}),dato=sesion.get(id);
    if(dato){dato.estado='subida';dato.por_revisar=0;dato.faltaEtiqueta=!ok;}
    if(ok){mensaje(`Sale la etiqueta: ${nombre} ×${Math.min(99,n)}`,'etiqueta');sonar('etiqueta');}
    else mensaje(`Guardada · falta etiqueta: ${razonSinEtiqueta()}`,'aviso');
    pintar();return ok;
  }
  /**
   * Si la etiqueta de las unidades anteriores ya salió (en este teléfono, otro dispositivo o la base) y la cantidad sube, salen las que faltan (como +1).
   * La marca de esta pantalla puede estar vieja (la PC imprimió la original después de la última carga, #468): se pregunta a la base.
   * Sin poder saberlo no se imprime a ciegas (si la original aún no sale, la cola de la PC la saca completa y esto la repetiría): se avisa.
   */
  async function etiquetarCorreccion(id,datos,actual,cantidad){
    const remota=await marcaDeLaBase(api,id);
    const faltan=etiquetasPorCorreccion({antes:actual.stock,despues:cantidad,estado_analisis:actual.estado_analisis,marca:estadoEnvio({...actual,id}).marca,etiqueta_en:remota?remota.etiqueta_en:datos.etiqueta_en,impresa:capturaImpresa(id)});
    if(faltan)void captura.imprimirPieza(id,faltan,{reimprimir:true});
    else if(!remota&&cantidad>actual.stock&&actual.estado_analisis==='listo')mensaje('No se pudo comprobar la etiqueta: si la original ya salió, reimprime las que faltan desde Buscar','aviso');
  }
  async function subir(){
    if(enviando||!navigator.onLine)return;pintarRed();enviando=true;
    const drenar=async()=>{const otra=await subida.subir();if(otra)setTimeout(subir,1000);};
    try{if(navigator.locks)await navigator.locks.request('inventario-fotos',{ifAvailable:true},lock=>lock?drenar():undefined);else await drenar();}
    finally{enviando=false;pintar();}
  }
  function pintarRed(){const n=[...sesion.values()].filter(r=>!r.subida).length;$('chip-red').textContent=navigator.onLine?(n?`▲ ${n} sin subir`:'● Red'):`▲ Sin red · ${n}`;$('chip-red').classList.toggle('aviso',!navigator.onLine||n>0);ctx.enfocado?.pintar();}
  function miniatura(r){
    const b=boton('',()=>corregir(r.id),'miniatura '+(!r.subida?'local':'subida')+(r.estado==='revisar'?' por-revisar':''));const img=nodo('img');img.alt='';img.src=r.url||`/api/foto/${r.id}`;img.onerror=()=>{img.hidden=true;};
    const estado=r.estado==='subiendo'?'↑':r.estado==='analizando'?'⏳':r.estado==='error'||r.estado==='sesion'?'■':r.estado==='revisar'?'✎':r.subida?'✓':'☁';
    b.append(img,nodo('span',r.talla||'','mini-talla'),nodo('span',`${estado} ×${r.cantidad??r.stock??1}`,'mini-estado'));
    b.setAttribute('aria-label',`${r.nombre||r.prenda||'Pieza'} ${r.talla||''}, ${r.cantidad??1} piezas, ${r.estado==='revisar'?'por revisar':r.subida?'subida':'en el teléfono'}`);return b;
  }
  function pintar(){
    carrusel.replaceChildren();const ahora=Date.now();const registros=[...sesion.values()].filter(r=>!r.subida||ahora-(r.creado??Date.parse(r.creado_en))<86400000).sort((a,b)=>(b.creado??Date.parse(b.creado_en))-(a.creado??Date.parse(a.creado_en)));
    for(const r of registros.slice(0,24))carrusel.append(miniatura(r));
    const piezas=registros.reduce((n,r)=>n+(r.cantidad??1),0),subidas=registros.filter(r=>r.subida).length;contador.textContent=`Hoy · ${piezas} ${piezas===1?'pieza':'piezas'} · ${subidas} ${subidas===1?'subida':'subidas'}`;tira.hidden=!registros.length;const porRev=porRevisar().length;revisarBoton.hidden=!porRev;revisarBoton.textContent=`✎ Revisar ${porRev}`;pintarRed();
  }
  async function conservar(foto,a){
    reposo.actividad();ctx.problemas.cola();
    const upc=a?.upc;const ropaSinCodigo=captura.esRopa()&&!upc;
    if(faltaCalzado(a))throw new Error('Elige el número de calzado');
    if(ropaSinCodigo&&!captura.tablero.validar())throw new Error('Completa talla y precio');
    const edicion=a?.tipo==='nueva'?cambiosTarjeta(a):{};
    const r=registroFoto(foto,{id:a?.id||crypto.randomUUID(),estado_fisico:ropaSinCodigo?'nuevo':a?.estado||captura.estado(),cantidad:a?.cantidad||captura.cantidad(),...(ropaSinCodigo?captura.tablero.valores():{upc:upc??'',...(a?.talla?{talla:a.talla}:{}),nombre_edit:edicion.nombre,precio_edit:edicion.precio})});
    await guardar(r);sesion.set(r.id,{...r,url:URL.createObjectURL(foto),subida:false});captura.flujo.limpiar();captura.contador.poner(1);pintar();mensaje(navigator.onLine?'Foto guardada en el teléfono':'Sin red · foto en el teléfono',navigator.onLine?'ok':'aviso');
    if(localStorage.getItem('inventario-vibracion')!=='false')navigator.vibrate?.(30);void subir();return r;
  }
  // El obturador nunca toca una pieza ya registrada (#549): con el topper guardado en pantalla, la foto de la playera era
  // del topper (mismo id y UPC: el Worker la tomaba por reintento y pisaba su imagen). Reemplazar es «Foto nueva» en la tarjeta.
  async function tomar(a=piezaSinRegistrar(captura.flujo.actual())){
    if(disparando)return;
    if(captura.esRopa()&&!a?.upc&&!captura.tablero.validar()){sonar('error');return;}
    if(faltaCalzado(a)){sonar('error');mensaje('Elige el número de calzado','aviso');return;}
    if(!camara.pista()||!video.videoWidth){archivoPara=a;archivo.click();return;}
    disparando=true;try{const foto=await aJpeg(video,video.videoWidth,video.videoHeight);if(!foto)throw new Error('No se pudo tomar foto');await conservar(foto,a);}finally{disparando=false;}
  }
  archivo.onchange=async()=>{const f=archivo.files?.[0];if(!f)return;try{const foto=await reducirArchivo(f);if(archivoPara?.existente){await reemplazarFoto(archivoPara.existente,foto);cerrarHoja();}else if(archivoPara?.local)await retomarLocal(archivoPara.local,foto);else await conservar(foto,piezaSinRegistrar(archivoPara||captura.flujo.actual()));}catch(e){mensaje(e.message,'error');}finally{archivo.value='';archivoPara=null;}};
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
    const datos=sesion.get(id);if(!datos)return;
    // Una captura que se sumó a una pieza existente no tiene existencia propia que corregir: su suma quedó auditada.
    if(datos.existente)return mensaje('Ya existía: la suma quedó auditada. Ajusta la existencia desde Buscar.','aviso');
    revisando=id;
    let local,actual;
    try{local=await leer(id);actual=local?{...local,precio:local.precio_ropa,stock:local.cantidad}:await api(`/api/borradores/${id}/revision`);}
    catch(e){revisando=null;throw e;}
    if(actual.estado_analisis==='descartado'){sesion.delete(id);revisando=null;pintar();return;}
    // #573: una pieza nueva `por_revisar` abre su hoja como tarjeta de revisión (nombre, precio, cantidad, grado) y «Guardar e imprimir» la libera.
    const revisar=!local&&!!actual.por_revisar&&actual.estado_analisis==='listo';
    if(!revisar&&datos.estado==='revisar'){datos.estado='subida';pintar();}   // otro dispositivo ya la confirmó
    const c=nodo('div',undefined,'corregir-captura'),img=nodo('img');img.src=datos.url||`/api/foto/${id}`;img.alt='Foto de '+(datos.nombre||datos.prenda||'la pieza');c.append(img);
    const folioExistencia=crypto.randomUUID();
    let cambios={estado_fisico:actual.estado_fisico},cantidad=actual.stock,tallaActual=actual.talla||'',cambiado=false;
    const actualizar=()=>{cambiado=true;bloquear(guardarBoton,'');};
    let nombre=actual.nombre,tocoPrecio=false,campoPrecio=null;
    if(revisar&&!esRopa(actual)){
      const ln=nodo('label','Nombre / descripción'),cn=nodo('input'),lp=nodo('label','Precio ($)');campoPrecio=nodo('input');
      cn.value=nombre??'';cn.maxLength=120;cn.readOnly=!(ctx.dueno||ctx.identidad.usuario?.editar_inventario===true);cn.oninput=()=>{nombre=cn.value;actualizar();};
      campoPrecio.value=String(actual.precio/100);campoPrecio.inputMode='decimal';campoPrecio.readOnly=!ctx.dueno;campoPrecio.oninput=()=>{tocoPrecio=true;actualizar();};
      ln.append(cn);lp.append(campoPrecio);c.append(ln,lp);
    }else if(revisar)c.append(nodo('p',actual.nombre??''));
    if(!esRopa(actual))c.append(opciones(ESTADOS,actual.estado_fisico,v=>{cambios.estado_fisico=v;if(campoPrecio&&!tocoPrecio&&actual.precios?.[v])campoPrecio.value=String(actual.precios[v]/100);actualizar();},'Grado'));
    c.append(stepper(cantidad,n=>{cantidad=n;actualizar();},{max:999,nombre:'Piezas'}));
    const tablero=esRopa(actual)?ropa({pc:()=>false,mensaje,recordar:false,inicial:{talla:tallaActual,prenda:actual.prenda||'',marca:actual.marca||'',precio_ropa:actual.precio},cambiar:()=>actualizar()}):null;
    if(tablero)c.append(tablero.raiz);else if(tallaActual)c.append(talla(v=>{tallaActual=v;actualizar();},tallaActual));
    const marca=estadoEnvio({...actual,id}).marca;if(marca)c.append(nodo('p',`La etiqueta pegada dice $${marca.precio/100}`,'aviso'));
    const guardarBoton=boton(revisar?(etiqueteraLista()?'Guardar e imprimir':'Guardar'):'Guardar cambios',async()=>{
      if(!cambiado&&!revisar)return mensaje('Sin cambios','aviso');
      let avisoPrecio='';
      if(!navigator.onLine&&(revisar||!local||cantidad!==actual.stock))return mensaje(revisar?'Sin red: se guarda al volver la señal':'Sin red: se suma al volver la señal','aviso');
      if(tablero&&!tablero.validar())return;
      const r=tablero?.valores();if(r){cambios={...cambios,prenda:r.prenda,marca:r.marca,precio:r.precio_ropa};tallaActual=r.talla;}
      if(revisar){
        // La existencia y la talla primero: si fallan no se confirma nada. Una pieza sin etiqueta previa imprime todo junto (sin etiquetarCorreccion).
        const ed=campoPrecio||(nombre!==actual.nombre)?cambiosTarjeta({nombre:nombre!==actual.nombre?nombre:undefined,precio:tocoPrecio?campoPrecio.value:undefined,ficha:{precio_lista:actual.precio_lista}}):{};
        if(cantidad!==actual.stock){await corregirExistencia(api,actual,id,cantidad,folioExistencia);actual.stock=cantidad;}
        if(tallaActual&&tallaActual!==actual.talla){await api(`/api/borradores/${id}/talla`,{talla:tallaActual},'PATCH');actual.talla=tallaActual;}
        const guardada=await api(`/api/borradores/${id}/revision`,{confirmar:true,...(cambios.estado_fisico!==actual.estado_fisico?{estado_fisico:cambios.estado_fisico}:{}),...(r?{prenda:r.prenda,marca:r.marca,precio:r.precio_ropa}:{}),...ed},'PATCH');
        Object.assign(datos,{cantidad,talla:tallaActual,estado_fisico:guardada.estado_fisico,nombre:guardada.nombre,precio:guardada.precio,por_revisar:0});
        cerrarHoja();await imprimirRevisada(id,cantidad,guardada.nombre);
        if(guardada.aviso)mensaje(guardada.aviso,'aviso');
        return;
      }
      if(local){
        // Un alta pudo llegar aunque su respuesta se perdiera: corregirla por sus rutas de 24 h.
        if(cantidad!==actual.stock||tallaActual!==actual.talla){
          try{const remota=await api(`/api/borradores/${id}/revision`);
            if(cantidad!==remota.stock)await api(`/api/borradores/${id}/existencia`,{stock:cantidad,esperado:remota.stock},'PATCH');
            if(tallaActual&&tallaActual!==remota.talla)await api(`/api/borradores/${id}/talla`,{talla:tallaActual},'PATCH');
          }catch(e){if(e.status!==404)throw e;}
        }
        local={...local,cantidad,talla:tallaActual||null,estado_fisico:cambios.estado_fisico,...(r?{prenda:r.prenda,marca:r.marca,precio_ropa:r.precio_ropa,correccion_ficha:{...local.correccion_ficha,...cambios}}:{}),version:(local.version??0)+1};await guardar(local);Object.assign(datos,local);sesion.set(id,datos);
      }else{
        // La corrección propia conserva la ventana y validaciones de /captura; nunca se encola.
        if(cantidad!==actual.stock){
          await corregirExistencia(api,actual,id,cantidad,folioExistencia);
          void etiquetarCorreccion(id,datos,actual,cantidad);
        }
        if(tallaActual&&tallaActual!==actual.talla)await api(`/api/borradores/${id}/talla`,{talla:tallaActual},'PATCH');
        // #479: con etiqueta el precio no lo cambia el capturista: se pide al dueño y se sigue mostrando el precio actual.
        const guardada=r||cambios.estado_fisico!==actual.estado_fisico?await api(`/api/borradores/${id}/revision`,cambios,'PATCH'):null;
        if(guardada?.aviso)avisoPrecio=guardada.aviso;
        Object.assign(datos,{cantidad,talla:tallaActual,estado_fisico:cambios.estado_fisico,...(r?{precio_ropa:guardada?.solicitud_precio||guardada?.aviso?guardada.precio:r.precio_ropa,prenda:r.prenda,marca:r.marca}:{})});
      }
      cerrarHoja();mensaje(avisoPrecio||'Cambios guardados',avisoPrecio?'aviso':'ok');pintar();
    },'primario');if(!revisar)bloquear(guardarBoton,'Sin cambios');c.append(guardarBoton);
    c.append(boton('Retomar foto',async()=>{if(local){if(camara.pista()&&video.videoWidth)await retomarLocal(local,await aJpeg(video,video.videoWidth,video.videoHeight));else{archivoPara={local};archivo.click();}}else{await fotoPieza({...datos,id});}if(local)cerrarHoja();}));
    const descartar=boton('Descartar',async b=>{
      if(b.dataset.confirmar!=='true'){b.dataset.confirmar='true';b.textContent='¿Descartar esta pieza?';b.classList.add('confirmando');mensaje('Se descarta la captura completa','aviso');setTimeout(()=>{b.dataset.confirmar='false';b.textContent='Descartar';b.classList.remove('confirmando');},4000);return;}
      if(!navigator.onLine)return mensaje('Sin red · vuelve a intentar','aviso');await api(`/api/borradores/${id}/revision`,{},'DELETE');await borrar(id);if(datos.url)URL.revokeObjectURL(datos.url);sesion.delete(id);cerrarHoja();pintar();mensaje('Captura descartada','ok');
    },'peligro');c.append(descartar);
    hoja(revisar?'Revisar antes de imprimir':'Corregir',c);tablero?.sincronizar();$('hoja').addEventListener('close',()=>{revisando=null;void subir();},{once:true});
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
    if(navigator.onLine)try{const desde=new Date(Date.now()-86400000).toISOString(),d=await api('/api/borradores?'+new URLSearchParams({desde}));for(const p of d){if(p.capturado_por!==(ctx.identidad.correo||ctx.identidad.usuario?.correo)||sesion.has(p.id))continue;sesion.set(p.id,{...p,cantidad:p.stock,creado:Date.parse(p.creado_en),subida:true,estado:p.estado_analisis==='pendiente'?'analizando':p.por_revisar&&p.estado_analisis==='listo'&&p.precio>0?'revisar':'subida'});if(p.estado_analisis==='pendiente')void prepararRevision(p);}sincronizarMarcas(d.filter(p=>p.capturado_por===(ctx.identidad.correo||ctx.identidad.usuario?.correo)));pintar();}catch{}
    void subir();
  }
  addEventListener('online',()=>{pintar();void subir();});addEventListener('offline',pintar);setInterval(subir,20000);
  await recuperar();
  if(ctx.enfocado?.encendido())void empezar();
  return {empezar,tomar,fotoPieza,subir,sonar,actividad:()=>reposo.actividad(),async abrir(){pintar();pintarCamara();if(!inicio.hidden)return;reanudar.textContent='Reanudar';},pausar(){camara.pausar();pintarCamara();reanudar.textContent='Reanudar';},camara,corregir};
}
