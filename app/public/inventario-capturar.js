import { codigoLeido, normalizarUpc } from './upc.js';
import { etiqueteraLista } from './etiquetera.js';
import { ropa, opciones } from './inventario-ropa.js';
import { ESTADOS, nombreEstado } from './estados.js';
import { CATEGORIAS } from './categorias.js';
import { aCentavos } from './ficha.js';
import { stepper, bloquear, cerrarHoja } from './inventario-ui.js';
import { montarPrecio } from './inventario-precio.js';
import { esRopa as piezaRopa } from './ropa.js';
import { HUECO_LECTOR } from './lector.js';

/** Nombre y precio (centavos) que el capturista editó en la tarjeta; el servidor los autoriza. Lanza si son inválidos. */
export function cambiosTarjeta(a){
  const cambios={};
  if(a.nombre!==undefined){cambios.nombre=a.nombre.trim();if(!cambios.nombre)throw new Error('El nombre no puede quedar vacío.');}
  if(a.precio!==undefined){cambios.precio=aCentavos(a.precio);if(cambios.precio===null||cambios.precio<=0)throw new Error('Escribe un precio mayor a cero en pesos.');
    const lista=a.ficha?.precio_lista;if(lista>0&&cambios.precio>lista)throw new Error(`El precio no puede ser mayor al precio de lista ($${(lista/100).toFixed(2)}).`);}
  return cambios;
}
/** ¿Los campos de la tarjeta difieren de lo que se mostró? Entonces solo «Guardar» la guarda. */
export function tarjetaEditada(a){
  return (a.nombre!==undefined&&a.nombre.trim()!==(a.ficha?.nombre??'').trim())
    ||(a.precio!==undefined&&aCentavos(a.precio)!==(a.ficha?.precios?.[a.estado]??a.ficha?.precio));
}
/** Capturas cuya etiqueta ya salió desde este teléfono: una subida repetida (se perdió la respuesta, recarga) no la reimprime. */
const CLAVE_AUTOIMPRESAS='inventario-autoimpresas';
export function capturaImpresa(id){try{return JSON.parse(localStorage.getItem(CLAVE_AUTOIMPRESAS)||'[]').includes(id);}catch{return false;}}
function anotarCapturaImpresa(id){try{localStorage.setItem(CLAVE_AUTOIMPRESAS,JSON.stringify([...JSON.parse(localStorage.getItem(CLAVE_AUTOIMPRESAS)||'[]'),id].slice(-300)));}catch{}}
/**
 * Un lector USB cuyo cursor quedó en un campo de la tarjeta teclea el código ahí. Enter saca el foco del campo;
 * si lo precedió una ráfaga a velocidad de lector, se devuelve el valor anterior y el código va al lector.
 */
export function vigilarLectorEnCampo(campo,{alLeer,salir,ahora=()=>performance.now()}){
  let texto='',previo='',ultima=-Infinity,rapido=true;
  const reiniciar=()=>{texto='';rapido=true;};
  campo.addEventListener('keydown',e=>{
    if(e.ctrlKey||e.altKey||e.metaKey||e.isComposing)return;
    if(e.key==='Enter'){
      e.preventDefault();const codigo=rapido&&texto.length>=4?texto:'';reiniciar();
      if(codigo){campo.value=previo;campo.dispatchEvent(new Event('input'));}
      salir();if(codigo)alLeer(codigo);return;
    }
    if(!/^[\da-z-]$/i.test(e.key)){if(e.key!=='Shift'&&e.key!=='CapsLock')reiniciar();return;}
    const t=ahora(),hueco=t-ultima;
    if(hueco>250)reiniciar();
    if(!texto)previo=campo.value;else if(hueco>HUECO_LECTOR)rapido=false;
    texto+=e.key;ultima=t;
  });
}

/** Estado de captura: UUID estable al reintentar; precio y existencia confirmados solo por el servidor. */
export function crearCaptura({ api, imprimir, cambiar=()=>{}, enLinea=()=>navigator.onLine, uuid=()=>crypto.randomUUID(), permiteUpc=true, permiteSumar=true }) {
  let actual=null, resultados=[], siguiente=null, ajuste=null, fila=Promise.resolve(), grado='nuevo';
  function pintar(){cambiar({actual,resultados,siguiente,ajuste});}
  async function guardar(){
    if(!actual||actual.tipo!=='nueva')return;
    if(!enLinea())throw new Error('Sin red: se suma al volver la señal');
    const abierta=actual;
    const guardada=await api('/api/borradores/upc',{id:abierta.id,upc:abierta.upc,stock:abierta.cantidad,estado_fisico:abierta.estado,...cambiosTarjeta(abierta)});
    actual={...abierta,tipo:'guardada',pieza:guardada};pintar();
    const salio=guardada.estado_analisis&&guardada.estado_analisis!=='listo'?false:await imprimir(guardada.id,abierta.cantidad,{reimprimir:!!guardada.existente});actual.faltaEtiqueta=!salio;pintar();return guardada;
  }
  async function leer(codigo,mas=false){
    if(!enLinea())throw new Error('Sin red · toma foto');
    const ruta='/api/piezas?'+new URLSearchParams({q:codigo,...(mas&&siguiente?{cursor:siguiente}:{})});
    // La API da prioridad a ED- sobre UPC en números cortos; conservarla antes de acumular o filtrar por grado.
    const etiqueta=!mas&&/^\d{1,6}$/.test(codigo)?await api(ruta):null;
    const ed=`ED-${codigo.padStart(6,'0')}`;
    if(etiqueta?.piezas.some(p=>p.codigo===ed))codigo=ed;
    if(!mas&&actual?.tipo==='nueva'&&normalizarUpc(codigo)===normalizarUpc(actual.upc)){actual.cantidad=Math.min(999,actual.cantidad+1);pintar();return;}
    if(!mas&&actual?.tipo==='existente'&&(piezaRopa(actual.pieza)||actual.pieza.estado_fisico===grado)&&permiteSumar&&(actual.pieza.codigo?.toUpperCase()===codigo.toUpperCase()||(actual.pieza.upc&&normalizarUpc(actual.pieza.upc)===normalizarUpc(codigo))))return sumar(actual.pieza);
    if(!mas&&actual?.tipo==='nueva'){if(tarjetaEditada(actual))throw new Error('Guarda la tarjeta editada antes de leer otro código');await guardar();}
    const datos=etiqueta??await api(ruta);
    const piezas=codigoLeido(codigo)?datos.piezas.filter(p=>piezaRopa(p)||p.estado_fisico===grado):datos.piezas;
    resultados=mas?[...resultados,...piezas]:piezas;siguiente=datos.siguiente;
    if(resultados.length||siguiente){actual=resultados.length===1&&!siguiente?{tipo:'existente',pieza:resultados[0]}:null;pintar();return;}
    if(!permiteUpc||!codigoLeido(codigo)){actual=null;pintar();return;}
    try{const ficha=await api('/api/manifiesto/'+codigo);actual={tipo:'nueva',id:uuid(),upc:codigo,ficha,cantidad:1,estado:piezaRopa(ficha)?'nuevo':grado};}
    catch(e){if(e.status!==404)throw e;actual={tipo:'sin-registro',id:uuid(),upc:codigo,cantidad:1,estado:grado};}
    pintar();
  }
  async function sumar(p){
    if(!enLinea())throw new Error('Sin red: se suma al volver la señal');
    if(ajuste&&ajuste.pieza.id!==p.id)throw new Error('Resuelve primero el ajuste pendiente');
    ajuste??={pieza:p,cuerpo:{id:uuid(),delta:1,motivo:'entrada'},confirmado:false};
    if(!ajuste.confirmado){const r=await api(`/api/piezas/${p.id}/existencia`,ajuste.cuerpo);ajuste.confirmado=true;ajuste.pieza={...p,stock:r.despues};}
    actual={tipo:'existente',pieza:ajuste.pieza};pintar();
    const salio=ajuste.pieza.estado_analisis&&ajuste.pieza.estado_analisis!=='listo'?false:await imprimir(p.id,1,{reimprimir:true});actual.faltaEtiqueta=!salio;
    ajuste=null;pintar();return actual;
  }
  const serial=(fn)=>{const resultado=fila.then(fn);fila=resultado.catch(()=>{});return resultado;};
  return { leer:(...args)=>serial(()=>leer(...args)),guardar:()=>serial(guardar),sumar:(p)=>serial(()=>sumar(p)),
    elegir(p){actual={tipo:'existente',pieza:p};pintar();},
    retomar(a){actual=a;pintar();},
    cantidad(n){if(actual&&actual.tipo==='nueva'){actual.cantidad=n;if(n===0)actual=null;pintar();}},
    estado(e){grado=e;if(actual?.pieza&&!piezaRopa(actual.pieza)&&actual.pieza.estado_fisico!==grado){actual=null;resultados=[];}else if(actual)actual.estado=piezaRopa(actual.ficha||{})?'nuevo':e;pintar();},
    limpiar(){actual=null;resultados=[];pintar();}, actual:()=>actual };
}

export async function iniciar(ctx) {
  const {$,nodo,boton,mensaje,hoja,api,pesos,dueno,pc,foco,resultado}=ctx;
  const raiz=$('modo-capturar');raiz.replaceChildren();
  const columnas=nodo('div',undefined,'columnas'),entrada=nodo('div'),derecha=nodo('div');columnas.append(entrada,derecha);raiz.append(columnas);
  const tipo=nodo('div',undefined,'segmentado');tipo.setAttribute('role','group');tipo.setAttribute('aria-label','Tipo de pieza');
  let esRopa=localStorage.getItem('captura-modo')==='ropa',estado='nuevo',cantidad=1,pendienteFoto=false,consulta='',movil;
  const mercancia=boton('Mercancía',()=>elegirTipo(false)),prenda=boton('Ropa',()=>elegirTipo(true));tipo.append(mercancia,prenda);
  const tablero=ropa({pc,mensaje,cambiar:()=>actualizarDisparo()});
  const grado=opciones(ESTADOS,estado,e=>{estado=e;flujo.estado(e);},'Grado');
  const contador=stepper(1,n=>cantidad=n,{nombre:'Piezas'});
  const lista=nodo('ul',undefined,'lista'),pieza=nodo('div'),remota=nodo('div',undefined,'solicitud-celular');
  const disparo=boton('Producto sin código: foto con celular',()=>fotoNueva(),'primario');
  const sinFoto=boton('Pieza sin foto',()=>manual());sinFoto.hidden=!dueno;
  const escribir=boton('⌨ Escribir',()=>{$('busqueda').hidden=false;$('consulta').inputMode='numeric';$('consulta').focus();},'movil');
  const encabezadoLista=nodo('h3','Coincidencias');encabezadoLista.hidden=true;lista.hidden=true;
  entrada.append(tipo,tablero.raiz,grado,nodo('h3','Cantidad'),contador,escribir,encabezadoLista,lista,sinFoto);
  const historia=nodo('ul',undefined,'lista');
  derecha.append(pieza,disparo,remota,historia);
  const pie=nodo('p','Hoy: 0 piezas', 'ayuda pc');raiz.append(pie);
  let hoy=0;const textoHoy=()=>{pie.textContent=`Hoy: ${hoy} ${hoy===1?'pieza':'piezas'}`;};
  function elegirTipo(ropa){esRopa=ropa;localStorage.setItem('captura-modo',ropa?'ropa':'mercancia');mercancia.setAttribute('aria-pressed',String(!ropa));prenda.setAttribute('aria-pressed',String(ropa));tablero.raiz.hidden=!ropa;grado.hidden=ropa;if(ropa)tablero.sincronizar();actualizarDisparo();}
  const ayudaDisparo=nodo('span','','solo-lector');ayudaDisparo.id='ayuda-disparo';ayudaDisparo.setAttribute('role','status');disparo.after(ayudaDisparo);disparo.setAttribute('aria-describedby',ayudaDisparo.id);
  const neutro=()=>mensaje(pc()?'Escanea o escribe':'Escanea o toma foto');
  function actualizarDisparo(){
    const actual=flujo.actual(),falta=esRopa&&!actual?.upc&&actual?.tipo!=='existente'?tablero.faltante():'';
    const motivo=falta||(pendienteFoto?'Espera la foto':'');bloquear(disparo,motivo);ayudaDisparo.textContent=motivo;
    if(!pc()){disparo.textContent=falta?falta.replace('Falta ','Elige '):'';disparo.setAttribute('aria-label',falta?disparo.textContent:'Tomar foto');}
  }
  // Modo enfocado (#461): una etiqueta pedida sin impresora conectada queda como alerta hasta que se conecte.
  let impresionPedida=false;ctx.problemas.impresora=()=>{if(impresionPedida&&etiqueteraLista())impresionPedida=false;return impresionPedida;};
  async function imprimir(id,n,opciones){if(!etiqueteraLista()){impresionPedida=true;return false;}impresionPedida=false;return ctx.imprimir([id],new Map([[id,n]]),opciones);}
  // Etiqueta automática de una captura con foto (#464): una a la vez, y nunca dos veces para la misma captura (`llave` = su id de subida).
  let turnoImpresion=Promise.resolve();
  function imprimirCaptura(llave,id,n,opciones){
    const r=turnoImpresion.then(async()=>{if(capturaImpresa(llave))return true;const ok=await imprimir(id,n,opciones);if(ok)anotarCapturaImpresa(llave);return ok;});
    turnoImpresion=r.catch(()=>{});return r;
  }
  const flujo=crearCaptura({api,imprimir,permiteSumar:dueno||ctx.identidad.usuario?.editar_inventario===true,permiteUpc:!ctx.identidad.usuario?.roles.includes('finanzas'),cambiar:pintar});
  async function recibirExistente(p,llave){
    const a={tipo:'guardada',pieza:p,cantidad:p.sumadas,faltaEtiqueta:true};flujo.retomar(a);
    // Sin impresora conectada igual se pide: queda «falta etiqueta» y la alerta del modo enfocado.
    if(p.estado_analisis==='listo'){a.faltaEtiqueta=!await(llave?imprimirCaptura(llave,p.id,p.sumadas,{reimprimir:true}):imprimir(p.id,p.sumadas,{reimprimir:true}));flujo.retomar(a);}
    mensaje(`Ya existía · +${p.sumadas}${p.codigo?` a ${p.codigo}`:''}${p.estado_analisis==='listo'?(a.faltaEtiqueta?' · falta etiqueta':' · etiqueta enviada'):''}`,'aviso');
  }

  const vacioPieza=()=>{if(pc()&&!pieza.children.length)pieza.append(nodo('p','Escanea un código para empezar','vacio'));};
  function pintar({actual,resultados,siguiente}){
    lista.replaceChildren();
    const varias=resultados.length>1;lista.hidden=encabezadoLista.hidden=!varias;if(!pendienteFoto)remota.replaceChildren();
    for(const p of resultados)lista.append(resultado(p,()=>flujo.elegir(p)));
    if(siguiente){const li=nodo('li');li.append(boton('Buscar más',()=>flujo.leer(consulta,true)));lista.append(li);}
    pieza.replaceChildren();
    if(pc())disparo.classList.toggle('primario',!actual);
    else disparo.hidden=false;
    actualizarDisparo();
    if(!actual){if(!varias)vacioPieza();return;}
    const p=actual.pieza||actual.ficha;
    const carta=nodo('article',undefined,'tarjeta pieza-actual'),foto=nodo('div',undefined,'foto-pieza'),tarjeta=nodo('div');carta.append(foto,tarjeta);pieza.append(carta);
    const conFoto=actual.pieza&&(p.tiene_foto||p.foto_key);
    if(conFoto){const img=nodo('img');img.src=`/api/foto/${p.id}`;img.alt=`Foto de ${p.nombre||'la pieza'}`;img.onerror=()=>{img.remove();foto.textContent='Sin foto';};foto.append(img);}else foto.textContent=actual.tipo==='nueva'?'Buscando foto…':'Sin foto';
    tarjeta.append(nodo('code',p?.codigo||actual.upc||''));
    if(actual.tipo==='nueva'){
      const nombre=nodo('label','Nombre / descripción'),campoNombre=nodo('input'),precio=nodo('label','Precio ($)'),campoPrecio=nodo('input');
      campoNombre.value=actual.nombre??p.nombre;campoNombre.maxLength=120;campoNombre.readOnly=!(dueno||ctx.identidad.usuario?.editar_inventario===true);
      campoNombre.oninput=()=>{actual.nombre=campoNombre.value;};nombre.append(campoNombre);
      campoPrecio.value=actual.precio??String((p.precios?.[actual.estado]??p.precio)/100);campoPrecio.inputMode='decimal';campoPrecio.readOnly=!dueno;
      campoPrecio.oninput=()=>{actual.precio=campoPrecio.value;};precio.append(campoPrecio);tarjeta.append(nombre,precio);
      for(const campo of [campoNombre,campoPrecio])vigilarLectorEnCampo(campo,{salir:()=>{campo.blur();foco();},alLeer:codigo=>ctx.recibir(codigo,'usb').catch(e=>mensaje(e.message,'error'))});
    }else{
      tarjeta.append(nodo('h2',p?.nombre||'Sin registro'));
      if(p)tarjeta.append(nodo('strong',pesos(p.precios?.[actual.estado]??p.precio),'precio'));
    }
    if(actual.tipo==='existente'){
      tarjeta.append(nodo('p',`Existencia ${p.stock}${!p.tiene_foto?' · sin foto':''}`));
      const sumar=boton(p.estado_analisis==='listo'?'+1 e imprimir 1':'+1',async()=>{await flujo.sumar(p);hoy++;textoHoy();mensaje(flujo.actual()?.faltaEtiqueta?'Guardada · falta etiqueta':'Guardada · etiqueta enviada',flujo.actual()?.faltaEtiqueta?'aviso':'etiqueta');if(!p.tiene_foto&&!p.foto_key)await fotoPieza(p);foco();},p.tiene_foto?'primario':'');
      const conPermiso=dueno||ctx.identidad.usuario?.editar_inventario===true;
      if(conPermiso){bloquear(sumar,!navigator.onLine?'Sin red: se suma al volver la señal':'');const fila=nodo('div',undefined,'acciones');fila.append(sumar,boton(p.tiene_foto?'Foto nueva':'Añadir foto',()=>fotoPieza(p),p.tiene_foto?'':'primario'));carta.append(fila);}else tarjeta.append(nodo('p','Solo consulta','solo-consulta'));
      const precioPedido=nodo('div',undefined,'bloque-precio');carta.append(precioPedido);montarPrecio(ctx,precioPedido,p);
    }else if(actual.tipo==='nueva'){
      const fila=nodo('div',undefined,'acciones');if(!piezaRopa(p))tarjeta.append(nodo('p',nombreEstado(actual.estado)));carta.append(fila);fila.append(stepper(actual.cantidad,n=>flujo.cantidad(n),{min:0,max:999,nombre:'Piezas de este código'}),boton(etiqueteraLista()?'Guardar e imprimir':'Guardar',async()=>{await flujo.guardar();hoy+=actual.cantidad;textoHoy();const p=flujo.actual()?.pieza;mensaje(p?.existente?`Ya existía · +${p.sumadas}${p.codigo?` a ${p.codigo}`:''}`:flujo.actual()?.faltaEtiqueta?'Guardada · falta etiqueta':'Guardada · etiqueta enviada',p?.existente?'aviso':flujo.actual()?.faltaEtiqueta?'aviso':'etiqueta');foco();},'primario'));
      if(!actual.imagenBuscada){actual.imagenBuscada=true;void imagen(actual,foto,tarjeta);}
      else if(actual.imagen)pintarImagen(actual,foto,tarjeta);
    }else if(actual.tipo==='sin-registro'){
      mensaje('Sin registro · toma foto','aviso');const fila=nodo('div',undefined,'acciones');fila.append(boton('Buscar en internet',()=>buscarDesconocida(actual),'buscar-internet'),boton('Tomar foto',()=>fotoNueva(actual),'primario'));carta.append(fila);
    }else if(actual.tipo==='guardada')tarjeta.append(nodo('p','✓ Guardada'));
    if(actual.faltaEtiqueta&&p.estado_analisis==='listo')tarjeta.append(boton(`Imprimir ${actual.cantidad||1} ${(actual.cantidad||1)===1?'etiqueta':'etiquetas'}`,async()=>{const ok=await ctx.imprimir([p.id],new Map([[p.id,actual.cantidad||1]]));if(ok){actual.faltaEtiqueta=false;mensaje('Etiqueta enviada','etiqueta');}}));
  }
  function pintarImagen(a,foto,c){if(!a.imagen?.url){foto.textContent='Sin foto';return;}const img=nodo('img');img.src=a.imagen.url;img.alt=a.imagen.nombre||a.ficha.nombre;img.referrerPolicy='no-referrer';img.onerror=()=>{img.remove();foto.textContent='Sin foto';};foto.replaceChildren(img);if(!a.imagen.confirmada)c.append(boton('Es esta',async()=>{const r=await api(`/api/manifiesto/${a.upc}/imagen`,{url:a.imagen.url,tcin:a.imagen.tcin},'PUT');a.imagen=r.imagen;mensaje('Imagen guardada','ok');}));}
  async function imagen(a,foto,c){try{const r=await api(`/api/manifiesto/${a.upc}/imagen`,{},'POST');a.imagen=r.imagen;if(flujo.actual()===a)pintarImagen(a,foto,c);}catch(e){if(flujo.actual()===a){foto.textContent='Sin foto';mensaje(e.message,'aviso');}}}
  async function buscarDesconocida(a){
    if(a.buscando)return;
    const li=nodo('li'),retomar=boton(`Código ${a.upc} · buscando…`,()=>flujo.retomar(a));li.append(retomar);historia.prepend(li);
    a.buscando=true;mensaje('Buscando en internet…');
    const guardada=await api('/api/borradores/upc/buscar',{id:a.id,upc:a.upc,stock:a.cantidad,estado_fisico:a.estado});
    if(guardada.existente){a.tipo='existente';a.pieza=guardada;await recibirExistente(guardada,a.id);if(guardada.estado_analisis==='listo'){retomar.textContent=guardada.nombre;return;}}
    for(let i=0;i<35;i++){await new Promise(r=>setTimeout(r,4000));const datos=await api(`/api/borradores/upc/${a.id}`);if(datos.estado_analisis==='listo'){retomar.textContent=`✓ ${datos.nombre}`;mensaje('Encontrada · lista para etiqueta','ok');if(guardada.existente){a.pieza=datos;await recibirExistente({...datos,existente:true,sumadas:guardada.sumadas},a.id);}else if(flujo.actual()===a)flujo.elegir({...datos,tiene_foto:datos.con_foto});return;}if(datos.estado_analisis==='error'){retomar.textContent=`▲ ${a.upc} · toma foto`;mensaje('Sin resultado · toma foto','aviso');return;}}
  }
  async function fotoPieza(p){
    if(!pc())return movil.fotoPieza(p);
    if(pendienteFoto)return;pendienteFoto=true;actualizarDisparo();
    try{const {pedirFoto}=await import('./camara-pc.js');$('chip-celular').textContent='● Esperando foto';const r=await pedirFoto({tipo:'foto_pieza',pieza_id:p.id,contenedor:remota});if(['lista','cancelada'].includes(r.estado))remota.replaceChildren();if(r.estado==='lista'){const d=await api(`/api/piezas/${p.id}`);flujo.elegir(d.pieza);$('chip-celular').textContent='● Celular · Listo';mensaje('Foto recibida','ok');}else mensaje(r.motivo||'No se recibió foto','aviso');}
    finally{pendienteFoto=false;actualizarDisparo();foco();}
  }
  async function fotoNueva(a=null){
    if(!pc())return movil.tomar(a||flujo.actual());
    if(esRopa&&!a&&!tablero.validar())return;
    if(pendienteFoto)return;
    pendienteFoto=true;actualizarDisparo();if(!a)pieza.replaceChildren();
    const id=a?.id||crypto.randomUUID(),params={cantidad:a?.cantidad||cantidad,estado_fisico:esRopa&&!a?.upc?'nuevo':a?.estado||estado,...(a?.upc?{upc:a.upc}:esRopa?tablero.valores():{upc:''})};
    try{const {pedirFoto}=await import('./camara-pc.js');$('chip-celular').textContent='● Esperando foto';const r=await pedirFoto({tipo:'pieza_nueva',pieza_id:id,params,contenedor:remota});if(['lista','cancelada'].includes(r.estado))remota.replaceChildren();if(r.estado==='lista'){hoy+=params.cantidad;textoHoy();const d=await api(`/api/piezas/${id}`);flujo.elegir(d.pieza);contador.poner(1);$('chip-celular').textContent='● Celular · Listo';mensaje('Foto recibida','ok');}else{$('chip-celular').textContent='■ No responde';mensaje(r.motivo||'El celular no responde','aviso');}}
    finally{pendienteFoto=false;actualizarDisparo();if(!flujo.actual())vacioPieza();foco();}
  }
  function manual(){
    let id=crypto.randomUUID(),enviando=false;const form=nodo('form',undefined,'formulario'),campos={};
    for(const [k,t] of [['nombre','Nombre'],['marca','Marca'],['categoria','Categoría'],['estado_fisico','Estado'],['precio_lista','Precio de lista ($)'],['precio','Precio de venta ($)'],['destino','Destino']]){const l=nodo('label',t),input=nodo(['categoria','estado_fisico','destino'].includes(k)?'select':'input');if(k==='categoria'||k==='estado_fisico'||k==='destino'){const lista=k==='categoria'?CATEGORIAS:k==='estado_fisico'?ESTADOS:[['etiqueta','Etiqueta individual']];for(const [v,t]of lista){const o=nodo('option',t);o.value=v;input.append(o);}}else{input.maxLength=k==='nombre'?120:k==='marca'?60:12;}l.append(input);campos[k]=input;form.append(l);}
    campos.categoria.value=esRopa?'ropa':campos.categoria.value;
    const actualizarGrado=()=>{campos.estado_fisico.parentElement.hidden=piezaRopa({categoria:campos.categoria.value});};campos.categoria.onchange=actualizarGrado;actualizarGrado();
    let n=1;form.append(nodo('h3','Existencia inicial'),stepper(n,v=>n=v,{max:999,nombre:'Existencia inicial'}),boton('Guardar pieza',async()=>{if(enviando)return;const datos={id,nombre:campos.nombre.value,marca:campos.marca.value,categoria:campos.categoria.value,estado_fisico:piezaRopa({categoria:campos.categoria.value})?'nuevo':campos.estado_fisico.value,stock:n,destino:campos.destino.value};for(const k of ['precio_lista','precio'])if(campos[k].value){const c=aCentavos(campos[k].value);if(c===null)throw new Error('Precio inválido');datos[k]=c;}enviando=true;try{await api('/api/borradores/manual',datos);cerrarHoja();mensaje('Pieza guardada','ok');}finally{enviando=false;}},'primario'));form.onsubmit=e=>e.preventDefault();hoja('Pieza sin foto',form);
  }
  elegirTipo(esRopa);flujo.limpiar();
  addEventListener('offline',()=>{for(const b of pieza.querySelectorAll('button'))if(b.textContent.startsWith('+1'))bloquear(b,'Sin red: se suma al volver la señal');});
  addEventListener('online',()=>{for(const b of pieza.querySelectorAll('button'))if(b.textContent.startsWith('+1'))bloquear(b,'');});
  const interfaz = { empezar:()=>movil?.empezar?.(),abrir(){neutro();foco();void movil?.abrir();},neutro,leer:async(c)=>{movil?.actividad();consulta=c;await flujo.leer(c);if(flujo.actual()?.tipo==='existente')mensaje(`Ya existe · ×${flujo.actual().pieza.stock}`,'aviso');else if(!flujo.actual()){const n=lista.querySelectorAll('.resultado').length;mensaje(n?`${n} coincidencias`:'Sin coincidencias','aviso');}else if(flujo.actual()?.tipo==='nueva')mensaje(`${flujo.actual().ficha.nombre} ×${flujo.actual().cantidad}`,'ok');},pausar(){movil?.pausar();},flujo,
    // La fase móvil conecta estas entradas al mismo flujo y conserva los registros de la cola.
    entrada,derecha,tipo,grado,escribir,sinFoto,manual,tablero,recibirExistente,imprimirCaptura,imprimirPieza:imprimir,disparo,remota,lista,pieza,esRopa:()=>esRopa,estado:()=>estado,cantidad:()=>cantidad,contador,fotoNueva,fotoPieza,
  };
  if(!pc()){const {iniciarCelular}=await import('./inventario-celular.js');movil=await iniciarCelular(ctx,interfaz);}
  interfaz.subir=()=>movil?.subir();
  return interfaz;
}
