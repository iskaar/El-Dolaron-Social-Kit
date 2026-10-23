import { codigoLeido, normalizarUpc } from './upc.js';
import { etiqueteraLista } from './etiquetera.js';
import { ropa, opciones } from './inventario-ropa.js';
import { ESTADOS, nombreEstado } from './estados.js';
import { CATEGORIAS } from './categorias.js';
import { aCentavos } from './ficha.js';
import { stepper, bloquear, cerrarHoja } from './inventario-ui.js';

/** Estado de captura: UUID estable al reintentar; precio y existencia confirmados solo por el servidor. */
export function crearCaptura({ api, imprimir, cambiar=()=>{}, enLinea=()=>navigator.onLine, uuid=()=>crypto.randomUUID(), permiteUpc=true, permiteSumar=true, alDesconocido=()=>{} }) {
  let actual=null, resultados=[], siguiente=null, ajuste=null, fila=Promise.resolve();
  function pintar(){cambiar({actual,resultados,siguiente,ajuste});}
  async function guardar(){
    if(!actual||actual.tipo!=='nueva')return;
    if(!enLinea())throw new Error('Sin red: se suma al volver la señal');
    const abierta=actual;
    const guardada=await api('/api/borradores/upc',{id:abierta.id,upc:abierta.upc,stock:abierta.cantidad,estado_fisico:abierta.estado});
    actual={...abierta,tipo:'guardada',pieza:guardada};pintar();
    const salio=await imprimir(guardada.id,abierta.cantidad);actual.faltaEtiqueta=!salio;pintar();return guardada;
  }
  async function leer(codigo,mas=false){
    if(!enLinea())throw new Error('Sin red · toma foto');
    if(!mas&&actual?.tipo==='nueva'&&normalizarUpc(codigo)===normalizarUpc(actual.upc)){actual.cantidad=Math.min(999,actual.cantidad+1);pintar();return;}
    if(!mas&&actual?.tipo==='existente'&&permiteSumar&&(actual.pieza.codigo?.toUpperCase()===codigo.toUpperCase()||(actual.pieza.upc&&normalizarUpc(actual.pieza.upc)===normalizarUpc(codigo))))return sumar(actual.pieza);
    if(!mas&&actual?.tipo==='sin-registro'&&!actual.buscando)alDesconocido(actual);
    if(!mas&&actual?.tipo==='nueva')await guardar();
    const datos=await api('/api/piezas?'+new URLSearchParams({q:codigo,...(mas&&siguiente?{cursor:siguiente}:{})}));
    resultados=mas?[...resultados,...datos.piezas]:datos.piezas;siguiente=datos.siguiente;
    if(resultados.length||siguiente){actual=resultados.length===1&&!siguiente?{tipo:'existente',pieza:resultados[0]}:null;pintar();return;}
    if(!permiteUpc||!codigoLeido(codigo)){actual=null;pintar();return;}
    try{const ficha=await api('/api/manifiesto/'+codigo);actual={tipo:'nueva',id:uuid(),upc:codigo,ficha,cantidad:1,estado:'nuevo'};}
    catch(e){if(e.status!==404)throw e;actual={tipo:'sin-registro',id:uuid(),upc:codigo,cantidad:1,estado:'nuevo'};}
    pintar();
  }
  async function sumar(p){
    if(!enLinea())throw new Error('Sin red: se suma al volver la señal');
    if(ajuste&&ajuste.pieza.id!==p.id)throw new Error('Resuelve primero el ajuste pendiente');
    ajuste??={pieza:p,cuerpo:{id:uuid(),delta:1,motivo:'entrada'},confirmado:false};
    if(!ajuste.confirmado){const r=await api(`/api/piezas/${p.id}/existencia`,ajuste.cuerpo);ajuste.confirmado=true;ajuste.pieza={...p,stock:r.despues};}
    actual={tipo:'existente',pieza:ajuste.pieza};pintar();
    const salio=await imprimir(p.id,1);actual.faltaEtiqueta=!salio;
    ajuste=null;pintar();return actual;
  }
  const serial=(fn)=>{const resultado=fila.then(fn);fila=resultado.catch(()=>{});return resultado;};
  return { leer:(...args)=>serial(()=>leer(...args)),guardar:()=>serial(guardar),sumar:(p)=>serial(()=>sumar(p)),
    elegir(p){actual={tipo:'existente',pieza:p};pintar();},
    retomar(a){actual=a;pintar();},
    cantidad(n){if(actual&&actual.tipo==='nueva'){actual.cantidad=n;if(n===0)actual=null;pintar();}},
    estado(e){if(actual)actual.estado=e;pintar();},
    limpiar(){actual=null;resultados=[];pintar();}, actual:()=>actual };
}

export async function iniciar(ctx) {
  const {$,nodo,boton,mensaje,hoja,api,pesos,dueno,pc,foco,resultado}=ctx;
  const raiz=$('modo-capturar');raiz.replaceChildren();
  const columnas=nodo('div',undefined,'columnas'),entrada=nodo('div'),derecha=nodo('div');columnas.append(entrada,derecha);raiz.append(columnas);
  const tipo=nodo('div',undefined,'segmentado');tipo.setAttribute('role','group');tipo.setAttribute('aria-label','Tipo de pieza');
  let esRopa=localStorage.getItem('captura-modo')==='ropa',estado='nuevo',cantidad=1,temporizador,pendienteFoto=false,consulta='',movil;
  const mercancia=boton('Mercancía',()=>elegirTipo(false)),prenda=boton('Ropa',()=>elegirTipo(true));tipo.append(mercancia,prenda);
  const tablero=ropa({pc,mensaje,cambiar:()=>actualizarDisparo(true)});
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
  function elegirTipo(ropa,avisar=true){esRopa=ropa;localStorage.setItem('captura-modo',ropa?'ropa':'mercancia');mercancia.setAttribute('aria-pressed',String(!ropa));prenda.setAttribute('aria-pressed',String(ropa));tablero.raiz.hidden=!ropa;actualizarDisparo(avisar);}
  const motivoFalta=()=>esRopa&&!tablero.valores().talla?'Falta talla':esRopa&&!tablero.valores().precio_ropa?'Falta precio':'';
  let faltaAviso=false;
  const neutro=()=>{const f=motivoFalta();if(f)mensaje(f,'aviso');else mensaje(pc()?'Escanea o escribe':'Escanea o toma foto');};
  function actualizarDisparo(avisar=false){const falta=motivoFalta();bloquear(disparo,falta||(pendienteFoto?'Espera la foto':''));if(avisar&&(falta||faltaAviso)){faltaAviso=!!falta;neutro();}}
  async function imprimir(id,n){if(!etiqueteraLista()||ctx.identidad.vendedor)return false;return ctx.imprimir([id],new Map([[id,n]]));}
  const flujo=crearCaptura({api,imprimir,permiteSumar:dueno||ctx.identidad.usuario?.editar_inventario===true,alDesconocido:a=>{void buscarDesconocida(a).catch(e=>mensaje(e.message,'error'));},permiteUpc:!ctx.identidad.usuario?.roles.includes('finanzas'),cambiar:pintar});
  const vacioPieza=()=>{if(pc()&&!pieza.children.length)pieza.append(nodo('p','Escanea un código para empezar','vacio'));};
  function pintar({actual,resultados,siguiente}){
    clearTimeout(temporizador);lista.replaceChildren();
    const varias=resultados.length>1;lista.hidden=encabezadoLista.hidden=!varias;if(!pendienteFoto)remota.replaceChildren();
    for(const p of resultados)lista.append(resultado(p,()=>flujo.elegir(p)));
    if(siguiente){const li=nodo('li');li.append(boton('Buscar más',()=>flujo.leer(consulta,true)));lista.append(li);}
    pieza.replaceChildren();
    if(pc())disparo.classList.toggle('primario',!actual);
    else disparo.hidden=actual?.tipo==='nueva'||actual?.tipo==='sin-registro';
    if(!actual){if(!varias)vacioPieza();return;}
    const p=actual.pieza||actual.ficha;
    const carta=nodo('article',undefined,'tarjeta pieza-actual'),foto=nodo('div',undefined,'foto-pieza'),tarjeta=nodo('div');carta.append(foto,tarjeta);pieza.append(carta);
    const conFoto=actual.pieza&&(p.tiene_foto||p.foto_key);
    if(conFoto){const img=nodo('img');img.src=`/api/foto/${p.id}`;img.alt=`Foto de ${p.nombre||'la pieza'}`;img.onerror=()=>{img.remove();foto.textContent='Sin foto';};foto.append(img);}else foto.textContent=actual.tipo==='nueva'?'Buscando foto…':'Sin foto';
    tarjeta.append(nodo('code',p?.codigo||actual.upc||''),nodo('h2',p?.nombre||'Sin registro'));
    if(p)tarjeta.append(nodo('strong',pesos(p.precios?.[actual.estado]??p.precio),'precio'));
    if(actual.tipo==='existente'){
      tarjeta.append(nodo('p',`Existencia ${p.stock}${!p.tiene_foto?' · sin foto':''}`));
      const sumar=boton('+1 e imprimir 1',async()=>{await flujo.sumar(p);hoy++;textoHoy();mensaje(flujo.actual()?.faltaEtiqueta?'Guardada · falta etiqueta':'Guardada · etiqueta enviada',flujo.actual()?.faltaEtiqueta?'aviso':'etiqueta');if(!p.tiene_foto&&!p.foto_key)await fotoPieza(p);foco();},p.tiene_foto?'primario':'');
      const conPermiso=dueno||ctx.identidad.usuario?.editar_inventario===true;
      if(conPermiso){bloquear(sumar,!navigator.onLine?'Sin red: se suma al volver la señal':'');const fila=nodo('div',undefined,'acciones');fila.append(sumar,boton(p.tiene_foto?'Foto nueva':'Añadir foto',()=>fotoPieza(p),p.tiene_foto?'':'primario'));carta.append(fila);}else tarjeta.append(nodo('p','Solo consulta','solo-consulta'));
    }else if(actual.tipo==='nueva'){
      const fila=nodo('div',undefined,'acciones');tarjeta.append(nodo('p',nombreEstado(actual.estado)));carta.append(fila);fila.append(stepper(actual.cantidad,n=>flujo.cantidad(n),{min:0,max:999,nombre:'Piezas de este código'}),boton(etiqueteraLista()?'Guardar e imprimir':'Guardar',async()=>{await flujo.guardar();hoy+=actual.cantidad;textoHoy();mensaje(flujo.actual()?.faltaEtiqueta?'Guardada · falta etiqueta':'Guardada · etiqueta enviada',flujo.actual()?.faltaEtiqueta?'aviso':'etiqueta');foco();},'primario'));
      const cuenta=nodo('p','Se guarda en 25 s','ayuda');cuenta.setAttribute('aria-hidden','true');carta.append(cuenta);
      temporizador=setTimeout(()=>flujo.guardar().catch(e=>mensaje(e.message,'error')),25000);
      if(!actual.imagenBuscada){actual.imagenBuscada=true;void imagen(actual,foto,tarjeta);}
      else if(actual.imagen)pintarImagen(actual,foto,tarjeta);
    }else if(actual.tipo==='sin-registro'){
      mensaje('Sin registro · toma foto','aviso');const fila=nodo('div',undefined,'acciones');fila.append(boton('Buscar en internet',()=>buscarDesconocida(actual)),boton('Tomar foto',()=>fotoNueva(actual),'primario'));carta.append(fila);
      if(!actual.buscando)temporizador=setTimeout(()=>buscarDesconocida(actual).catch(e=>mensaje(e.message,'error')),25000);
    }else if(actual.tipo==='guardada')tarjeta.append(nodo('p','✓ Guardada'));
    if(actual.faltaEtiqueta)tarjeta.append(boton('Imprimir etiqueta',async()=>{const ok=await ctx.imprimir([p.id],new Map([[p.id,1]]));if(ok){actual.faltaEtiqueta=false;mensaje('Etiqueta enviada','etiqueta');}}));
  }
  function pintarImagen(a,foto,c){if(!a.imagen?.url){foto.textContent='Sin foto';return;}const img=nodo('img');img.src=a.imagen.url;img.alt=a.imagen.nombre||a.ficha.nombre;img.referrerPolicy='no-referrer';img.onerror=()=>{img.remove();foto.textContent='Sin foto';};foto.replaceChildren(img);if(!a.imagen.confirmada)c.append(boton('Es esta',async()=>{const r=await api(`/api/manifiesto/${a.upc}/imagen`,{url:a.imagen.url,tcin:a.imagen.tcin},'PUT');a.imagen=r.imagen;mensaje('Imagen guardada','ok');}));}
  async function imagen(a,foto,c){try{const r=await api(`/api/manifiesto/${a.upc}/imagen`,{},'POST');a.imagen=r.imagen;if(flujo.actual()===a)pintarImagen(a,foto,c);}catch(e){if(flujo.actual()===a){foto.textContent='Sin foto';mensaje(e.message,'aviso');}}}
  async function buscarDesconocida(a){
    if(a.buscando)return;
    const li=nodo('li'),retomar=boton(`Código ${a.upc} · buscando…`,()=>flujo.retomar(a));li.append(retomar);historia.prepend(li);
    a.buscando=true;clearTimeout(temporizador);mensaje('Buscando en internet…');
    await api('/api/borradores/upc/buscar',{id:a.id,upc:a.upc,stock:a.cantidad,estado_fisico:a.estado});
    for(let i=0;i<35;i++){await new Promise(r=>setTimeout(r,4000));const datos=await api(`/api/borradores/upc/${a.id}`);if(datos.estado_analisis==='listo'){retomar.textContent=`✓ ${datos.nombre}`;mensaje('Encontrada · lista para etiqueta','ok');if(flujo.actual()===a)flujo.elegir({...datos,tiene_foto:datos.con_foto});return;}if(datos.estado_analisis==='error'){retomar.textContent=`▲ ${a.upc} · toma foto`;mensaje('Sin resultado · toma foto','aviso');return;}}
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
    pendienteFoto=true;actualizarDisparo();clearTimeout(temporizador);if(!a)pieza.replaceChildren();
    const id=a?.id||crypto.randomUUID(),params={cantidad:a?.cantidad||cantidad,estado_fisico:a?.estado||estado,...(a?.upc?{upc:a.upc}:esRopa?tablero.valores():{upc:''})};
    try{const {pedirFoto}=await import('./camara-pc.js');$('chip-celular').textContent='● Esperando foto';const r=await pedirFoto({tipo:'pieza_nueva',pieza_id:id,params,contenedor:remota});if(['lista','cancelada'].includes(r.estado))remota.replaceChildren();if(r.estado==='lista'){hoy+=params.cantidad;textoHoy();const d=await api(`/api/piezas/${id}`);flujo.elegir(d.pieza);contador.poner(1);$('chip-celular').textContent='● Celular · Listo';mensaje('Foto recibida','ok');}else{$('chip-celular').textContent='■ No responde';mensaje(r.motivo||'El celular no responde','aviso');}}
    finally{pendienteFoto=false;actualizarDisparo();if(!flujo.actual())vacioPieza();foco();}
  }
  function manual(){
    let id=crypto.randomUUID(),enviando=false;const form=nodo('form',undefined,'formulario'),campos={};
    for(const [k,t] of [['nombre','Nombre'],['marca','Marca'],['categoria','Categoría'],['estado_fisico','Estado'],['precio_lista','Precio de lista ($)'],['precio','Precio de venta ($)'],['destino','Destino']]){const l=nodo('label',t),input=nodo(['categoria','estado_fisico','destino'].includes(k)?'select':'input');if(k==='categoria'||k==='estado_fisico'||k==='destino'){const lista=k==='categoria'?CATEGORIAS:k==='estado_fisico'?ESTADOS:[['etiqueta','Etiqueta individual']];for(const [v,t]of lista){const o=nodo('option',t);o.value=v;input.append(o);}}else{input.maxLength=k==='nombre'?120:k==='marca'?60:12;}l.append(input);campos[k]=input;form.append(l);}
    let n=1;form.append(nodo('h3','Existencia inicial'),stepper(n,v=>n=v,{max:999,nombre:'Existencia inicial'}),boton('Guardar pieza',async()=>{if(enviando)return;const datos={id,nombre:campos.nombre.value,marca:campos.marca.value,categoria:campos.categoria.value,estado_fisico:campos.estado_fisico.value,stock:n,destino:campos.destino.value};for(const k of ['precio_lista','precio'])if(campos[k].value){const c=aCentavos(campos[k].value);if(c===null)throw new Error('Precio inválido');datos[k]=c;}enviando=true;try{await api('/api/borradores/manual',datos);cerrarHoja();mensaje('Pieza guardada','ok');}finally{enviando=false;}},'primario'));form.onsubmit=e=>e.preventDefault();hoja('Pieza sin foto',form);
  }
  elegirTipo(esRopa,false);flujo.limpiar();
  addEventListener('offline',()=>{for(const b of pieza.querySelectorAll('button'))if(b.textContent.startsWith('+1'))bloquear(b,'Sin red: se suma al volver la señal');});
  addEventListener('online',()=>{for(const b of pieza.querySelectorAll('button'))if(b.textContent.startsWith('+1'))bloquear(b,'');});
  const interfaz = { abrir(){neutro();foco();void movil?.abrir();},neutro,leer:async(c)=>{consulta=c;await flujo.leer(c);if(flujo.actual()?.tipo==='existente')mensaje(`Ya existe · ×${flujo.actual().pieza.stock}`,'aviso');else if(!flujo.actual()){const n=lista.querySelectorAll('.resultado').length;mensaje(n?`${n} coincidencias`:'Sin coincidencias','aviso');}else if(flujo.actual()?.tipo==='nueva')mensaje(`${flujo.actual().ficha.nombre} ×${flujo.actual().cantidad}`,'ok');},pausar(){movil?.pausar();},flujo,
    // La fase móvil conecta estas entradas al mismo flujo y conserva los registros de la cola.
    entrada,derecha,tipo,grado,escribir,sinFoto,manual,tablero,disparo,remota,lista,pieza,esRopa:()=>esRopa,estado:()=>estado,cantidad:()=>cantidad,contador,fotoNueva,fotoPieza,
  };
  if(!pc()){const {iniciarCelular}=await import('./inventario-celular.js');movil=await iniciarCelular(ctx,interfaz);}
  interfaz.subir=()=>movil?.subir();
  return interfaz;
}
