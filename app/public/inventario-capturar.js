import { codigoLeido, normalizarUpc } from './upc.js';
import { etiqueteraLista } from './etiquetera.js';
import { ropa, opciones } from './inventario-ropa.js';
import { ESTADOS } from './estados.js';
import { CATEGORIAS } from './categorias.js';
import { aCentavos } from './ficha.js';
import { stepper, bloquear, cerrarHoja } from './inventario-ui.js';
import { montarPrecio } from './inventario-precio.js';
import { esRopa as piezaRopa } from './ropa.js';
import { buscarCalzado, tipoCalzadoDeNombre, tallaUs } from './tallas.js';
import { HUECO_LECTOR } from './lector.js';
import { leerMultiplicador } from './venta.js';

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
/**
 * Cuerpo del «Guardar» de la revisión de una pieza que ya existe como `por_revisar` (#573): solo lo que cambió respecto de lo que
 * se mostró, más `confirmar`, que la libera para imprimir. Sin cambio de precio el servidor recalcula el de un nuevo grado.
 */
export function cuerpoRevision(a){
  const {nombre,precio}=cambiosTarjeta(a),f=a.ficha,c={confirmar:true};
  if(nombre!==undefined&&nombre!==(f.nombre??'').trim())c.nombre=nombre;
  if(precio!==undefined&&precio!==(f.precios?.[a.estado]??f.precio))c.precio=precio;
  if(a.estado!==a.estadoInicial)c.estado_fisico=a.estado;
  return c;
}
/** Calzado del manifiesto sin su número de la caja (#552): no se guarda, imprime ni fotografía hasta elegirlo. */
export const faltaCalzado=a=>a?.tipo==='nueva'&&a.ficha?.calzado&&!a.talla?'Falta número de calzado':'';
/**
 * La pieza actual que todavía recibe la foto del obturador: una tarjeta del manifiesto o un código sin registro (su foto la crea).
 * Una pieza ya registrada (`guardada`/`existente`) no: la foto es de una pieza nueva; reemplazar la suya es «Foto nueva» (#549).
 */
export function piezaSinRegistrar(a){return a&&(a.tipo==='nueva'||a.tipo==='sin-registro')?a:null;}
/** Capturas cuya etiqueta ya salió desde este teléfono: una subida repetida (se perdió la respuesta, recarga) no la reimprime. */
const CLAVE_AUTOIMPRESAS='inventario-autoimpresas';
export function capturaImpresa(id){try{return JSON.parse(localStorage.getItem(CLAVE_AUTOIMPRESAS)||'[]').includes(id);}catch{return false;}}
function anotarCapturaImpresa(id){try{localStorage.setItem(CLAVE_AUTOIMPRESAS,JSON.stringify([...JSON.parse(localStorage.getItem(CLAVE_AUTOIMPRESAS)||'[]'),id].slice(-300)));}catch{}}
/**
 * Corrige la existencia de una captura. Una pieza `listo` con UPC ya es vendible (apartados, ventas, ajustes): no se le escribe un
 * número absoluto; va por el ajuste auditado con la existencia que se vio (`esperado`) y un 409 pide revisarla en Buscar (#464).
 * Lo que aún se identifica o espera foto conserva la corrección de captura de siempre.
 */
export async function corregirExistencia(api,actual,id,cantidad,folio=crypto.randomUUID()){
  if(!(actual.estado_analisis==='listo'&&actual.upc)){
    // Una `listo` sin UPC también exige la existencia vista (`esperado`): el servidor responde 409 con la actual si cambió (#468).
    try{return await api(`/api/borradores/${id}/existencia`,{stock:cantidad,esperado:actual.stock},'PATCH');}
    catch(e){if(e.status===409&&e.datos?.stock!==undefined)actual.stock=e.datos.stock;throw e;}
  }
  try{return await api(`/api/piezas/${id}/existencia`,{id:folio,fijar_a:cantidad,esperado:actual.stock,motivo:'correccion'});}
  catch(e){
    if(e.status===409)throw new Error('La existencia cambió desde que la abriste (venta, apartado o ajuste). Revísala en Buscar.');
    if(e.status===403)throw new Error('Tu cuenta no puede ajustar la existencia de una pieza con etiqueta. Pídelo a quien edita el inventario.');
    throw e;
  }
}
/** Etiquetas que faltan tras subir la existencia: solo si ya salió la de las unidades anteriores (marca local, adoptada o de la base). */
export function etiquetasPorCorreccion({antes,despues,estado_analisis,marca,etiqueta_en,impresa}){
  return despues>antes&&estado_analisis==='listo'&&(marca||etiqueta_en||impresa)?despues-antes:0;
}
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
      salir(!!codigo);if(codigo)alLeer(codigo);return;
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
    if(faltaCalzado(abierta))throw new Error('Falta el número del calzado');
    if(abierta.revision){
      // Pieza ya creada (UPC buscado en internet): se ajusta la existencia vista y luego «Guardar» la confirma y libera su etiqueta (#573).
      const cuerpo=cuerpoRevision(abierta),vista=abierta.ficha.stock;
      if(abierta.cantidad!==vista){await corregirExistencia(api,{estado_analisis:'listo',upc:abierta.upc,stock:vista},abierta.id,abierta.cantidad);abierta.ficha.stock=abierta.cantidad;}
      const confirmada=await api(`/api/borradores/${abierta.id}/revision`,cuerpo,'PATCH');
      actual={...abierta,tipo:'guardada',pieza:{...confirmada,id:abierta.id}};pintar();
      actual.faltaEtiqueta=!await imprimir(abierta.id,abierta.cantidad,{});pintar();return confirmada;
    }
    const guardada=await api('/api/borradores/upc',{id:abierta.id,upc:abierta.upc,stock:abierta.cantidad,estado_fisico:abierta.estado,...(abierta.talla?{talla:abierta.talla}:{}),...cambiosTarjeta(abierta)});
    actual={...abierta,tipo:'guardada',pieza:guardada};pintar();
    const salio=guardada.estado_analisis&&guardada.estado_analisis!=='listo'?false:await imprimir(guardada.id,abierta.cantidad,{reimprimir:!!guardada.existente});actual.faltaEtiqueta=!salio;pintar();return guardada;
  }
  async function leer(texto,mas=false){
    if(!enLinea())throw new Error('Sin red · toma foto');
    // «12*código» (como la caja, #358): 12 piezas en esta lectura; sin prefijo, 1. El escaneo repetido sigue sumando 1.
    const multiplicado=leerMultiplicador(texto);if(!multiplicado)throw new Error('La cantidad antes del * va de 1 a 99.');
    const n=multiplicado.cantidad;let codigo=multiplicado.codigo.trim();if(!codigo)throw new Error('Escribe o escanea el código después del *');
    // Un solo viaje por lectura (#491): piezas del propietario o, si no hay, la ficha del manifiesto; 404 = ninguna de las dos.
    const resolver=async c=>{try{return await api('/api/piezas/resolver?'+new URLSearchParams({q:c}));}catch(e){if(e.status!==404)throw e;return {};}};
    // La API da prioridad a ED- sobre UPC en números cortos; conservarla antes de acumular o filtrar por grado.
    const etiqueta=!mas&&/^\d{1,6}$/.test(codigo)?await resolver(codigo):null;
    const ed=`ED-${codigo.padStart(6,'0')}`;
    if(etiqueta?.piezas?.some(p=>p.codigo===ed))codigo=ed;
    if(!mas&&actual?.tipo==='nueva'&&normalizarUpc(codigo)===normalizarUpc(actual.upc)){actual.cantidad=Math.min(999,actual.cantidad+n);pintar();return;}
    if(!mas&&actual?.tipo==='existente'&&(piezaRopa(actual.pieza)||actual.pieza.estado_fisico===grado)&&permiteSumar&&(actual.pieza.codigo?.toUpperCase()===codigo.toUpperCase()||(actual.pieza.upc&&normalizarUpc(actual.pieza.upc)===normalizarUpc(codigo))))return sumar(actual.pieza,n);
    if(!mas&&actual?.tipo==='nueva'){if(tarjetaEditada(actual))throw new Error('Guarda la tarjeta editada antes de leer otro código');await guardar();}
    const datos=mas?await api('/api/piezas?'+new URLSearchParams({q:codigo,...(siguiente?{cursor:siguiente}:{})})):etiqueta??await resolver(codigo);
    const piezas=codigoLeido(codigo)?(datos.piezas??[]).filter(p=>piezaRopa(p)||p.estado_fisico===grado):datos.piezas??[];
    resultados=mas?[...resultados,...piezas]:piezas;siguiente=datos.siguiente;
    if(resultados.length||siguiente){actual=resultados.length===1&&!siguiente?{tipo:'existente',pieza:resultados[0],cantidad:n}:null;pintar();return;}
    if(!permiteUpc||!codigoLeido(codigo)){actual=null;pintar();return;}
    try{const ficha=datos.ficha??await api('/api/manifiesto/'+codigo);actual={tipo:'nueva',id:uuid(),upc:codigo,ficha,enCamino:!!datos.ficha,cantidad:n,estado:piezaRopa(ficha)?'nuevo':grado};actual.estadoInicial=actual.estado;}
    catch(e){if(e.status!==404)throw e;actual={tipo:'sin-registro',id:uuid(),upc:codigo,cantidad:n,estado:grado};}
    pintar();
  }
  // Sumar `n` es un solo ajuste auditado (delta n, mismo folio al reintentar) y n etiquetas; el servidor lo topa en 999.
  async function sumar(p,n=1){
    if(!enLinea())throw new Error('Sin red: se suma al volver la señal');
    if(ajuste&&ajuste.pieza.id!==p.id)throw new Error('Resuelve primero el ajuste pendiente');
    if(ajuste&&ajuste.cuerpo.delta!==n)throw new Error(`Hay un ajuste pendiente de ${ajuste.cuerpo.delta}: reintenta con esa cantidad`);
    ajuste??={pieza:p,cuerpo:{id:uuid(),delta:n,motivo:'entrada'},confirmado:false};
    if(!ajuste.confirmado){
      try{const r=await api(`/api/piezas/${p.id}/existencia`,ajuste.cuerpo);ajuste.confirmado=true;ajuste.pieza={...p,stock:r.despues};}
      catch(e){if(e.status===409)ajuste=null;throw e;} // 409: no se aplicó (supera 999 o cambió la existencia); se puede elegir otra cantidad
    }
    actual={tipo:'existente',pieza:ajuste.pieza,cantidad:1,impresas:n};pintar();
    const salio=ajuste.pieza.estado_analisis&&ajuste.pieza.estado_analisis!=='listo'?false:await imprimir(p.id,n,{reimprimir:true});actual.faltaEtiqueta=!salio;
    ajuste=null;pintar();return actual;
  }
  const serial=(fn)=>{const resultado=fila.then(fn);fila=resultado.catch(()=>{});return resultado;};
  return { leer:(...args)=>serial(()=>leer(...args)),guardar:()=>serial(guardar),sumar:(p,n)=>serial(()=>sumar(p,n)),
    elegir(p){actual={tipo:'existente',pieza:p};pintar();},
    retomar(a){actual=a;pintar();},
    // Grado de la tarjeta (#573): cambia el precio mostrado al de ese grado, salvo que el dueño ya hubiera escrito otro.
    gradoNueva(e){
      if(actual?.tipo!=='nueva'||piezaRopa(actual.ficha||{}))return;
      const f=actual.ficha,previo=f.precios?.[actual.estado]??f.precio;actual.estado=e;
      if(actual.precio!==undefined&&aCentavos(actual.precio)===previo)delete actual.precio;pintar();
    },
    cantidad(n){if(actual&&actual.tipo==='nueva'){actual.cantidad=n;if(n===0)actual=null;pintar();}},
    estado(e){grado=e;if(actual?.pieza&&!piezaRopa(actual.pieza)&&actual.pieza.estado_fisico!==grado){actual=null;resultados=[];}else if(actual)actual.estado=piezaRopa(actual.ficha||{})?'nuevo':e;pintar();},
    limpiar(){actual=null;resultados=[];pintar();}, actual:()=>actual };
}

/**
 * «Número de la caja» del calzado con UPC (#552): se escribe lo que dice la caja (US, C/Y, EU o cm) y los renglones que
 * coinciden salen como chips; el nombre del manifiesto solo los ordena. Elegir fija `actual.talla` (el cm que se guarda);
 * escribir otra cosa la quita para no guardar un número viejo. Enter elige el primero.
 */
export function numeroCalzado({nodo,boton},actual,ficha,cambiar){
  const raiz=nodo('div',undefined,'numero-calzado'),etiqueta=nodo('label','Número de la caja'),campo=nodo('input'),
    chips=nodo('div',undefined,'chips'),elegida=nodo('small',undefined,'ayuda');
  campo.inputMode='decimal';campo.autocomplete='off';campo.enterKeyHint='done';campo.maxLength=8;etiqueta.append(campo);
  chips.setAttribute('role','group');chips.setAttribute('aria-label','Números que coinciden');elegida.setAttribute('role','status');
  const preferido=tipoCalzadoDeNombre(`${ficha.nombre??''} ${ficha.descripcion??''}`);let filas=[];
  const clave=f=>`${f.tipo}:${f.indice}`;
  const rotular=()=>{elegida.textContent=actual.talla?`Elegido: ${actual.tallaRotulo||tallaUs(actual.talla)} · se imprime ${actual.talla}`:'Escribe el número de la caja y elige';};
  const marcar=()=>{for(const b of chips.children)b.setAttribute('aria-pressed',String(b.dataset.clave===actual.tallaClave));rotular();};
  const fijar=f=>{actual.talla=f.valor;actual.tallaClave=clave(f);actual.tallaRotulo=f.rotulo;marcar();cambiar();};
  const buscar=()=>{
    filas=buscarCalzado(campo.value,preferido).slice(0,8);chips.replaceChildren();
    for(const f of filas){const b=boton(f.rotulo,()=>fijar(f));b.dataset.clave=clave(f);chips.append(b);}
    marcar();
  };
  campo.value=actual.textoNumero??'';
  campo.oninput=()=>{actual.textoNumero=campo.value;if(actual.talla){delete actual.talla;delete actual.tallaClave;delete actual.tallaRotulo;cambiar();}buscar();};
  buscar();raiz.append(etiqueta,chips,elegida);
  return {raiz,campo,elegirPrimero:()=>{if(filas[0]&&!actual.talla)fijar(filas[0]);}};
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
    const actual=flujo.actual(),falta=esRopa&&!piezaSinRegistrar(actual)?tablero.faltante():'';
    const motivo=falta||faltaCalzado(actual)||(pendienteFoto?'Espera la foto':'');bloquear(disparo,motivo);ayudaDisparo.textContent=motivo;
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
    let botonGuardar;
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
      if(p.calzado){
        const numero=numeroCalzado({nodo,boton},actual,p,()=>{actualizarDisparo();bloquear(botonGuardar,faltaCalzado(actual));});tarjeta.append(numero.raiz);
        vigilarLectorEnCampo(numero.campo,{salir:lector=>{if(!lector)numero.elegirPrimero();numero.campo.blur();foco();},alLeer:codigo=>ctx.recibir(codigo,'usb').catch(e=>mensaje(e.message,'error'))});
      }
    }else{
      tarjeta.append(nodo('h2',p?.nombre||'Sin registro'));
      if(p)tarjeta.append(nodo('strong',pesos(p.precios?.[actual.estado]??p.precio),'precio'));
    }
    if(actual.tipo==='existente'){
      tarjeta.append(nodo('p',`Existencia ${p.stock}${!p.tiene_foto?' · sin foto':''}`));
      const maximo=Math.max(1,999-p.stock),rotulo=k=>p.estado_analisis==='listo'?`Sumar ${k} e imprimir ${k}`:`Sumar ${k}`;let n=Math.min(actual.cantidad||1,maximo);
      const sumar=boton(rotulo(n),async()=>{await flujo.sumar(p,n);hoy+=n;textoHoy();mensaje(flujo.actual()?.faltaEtiqueta?'Guardada · falta etiqueta':'Guardada · etiqueta enviada',flujo.actual()?.faltaEtiqueta?'aviso':'etiqueta');if(!p.tiene_foto&&!p.foto_key)await fotoPieza(p);foco();},p.tiene_foto?'primario':'');
      const conPermiso=dueno||ctx.identidad.usuario?.editar_inventario===true;
      if(conPermiso){bloquear(sumar,!navigator.onLine?'Sin red: se suma al volver la señal':'');const fila=nodo('div',undefined,'acciones');fila.append(stepper(n,v=>{n=v;sumar.textContent=rotulo(n);},{min:1,max:maximo,nombre:'Piezas a sumar'}),sumar,boton(p.tiene_foto?'Foto nueva':'Añadir foto',()=>fotoPieza(p),p.tiene_foto?'':'primario'));carta.append(fila);}else tarjeta.append(nodo('p','Solo consulta','solo-consulta'));
      const precioPedido=nodo('div',undefined,'bloque-precio');carta.append(precioPedido);montarPrecio(ctx,precioPedido,p);
    }else if(actual.tipo==='nueva'){
      const fila=nodo('div',undefined,'acciones');if(!piezaRopa(p))tarjeta.append(opciones(ESTADOS,actual.estado,e=>flujo.gradoNueva(e),'Grado de esta pieza'));carta.append(fila);
      botonGuardar=boton(etiqueteraLista()?'Guardar e imprimir':'Guardar',async()=>{await flujo.guardar();hoy+=actual.cantidad;textoHoy();const p=flujo.actual()?.pieza;mensaje(p?.existente?`Ya existía · +${p.sumadas}${p.codigo?` a ${p.codigo}`:''}`:flujo.actual()?.faltaEtiqueta?'Guardada · falta etiqueta':'Guardada · etiqueta enviada',p?.existente?'aviso':flujo.actual()?.faltaEtiqueta?'aviso':'etiqueta');foco();},'primario');
      bloquear(botonGuardar,faltaCalzado(actual));fila.append(stepper(actual.cantidad,n=>flujo.cantidad(n),{min:0,max:999,nombre:'Piezas de este código'}),botonGuardar);
      if(!actual.imagenBuscada){actual.imagenBuscada=true;void imagen(actual,foto);}
      else if(actual.imagen)pintarImagen(actual,foto);
    }else if(actual.tipo==='sin-registro'){
      mensaje('Sin registro · toma foto','aviso');const fila=nodo('div',undefined,'acciones');fila.append(boton('Buscar en internet',()=>buscarDesconocida(actual),'buscar-internet'),boton('Tomar foto',()=>fotoNueva(actual),'primario'));carta.append(fila);
    }else if(actual.tipo==='guardada')tarjeta.append(nodo('p','✓ Guardada'));
    const k=actual.impresas||actual.cantidad||1; // lo que se acaba de sumar (existente) o guardar
    if(actual.faltaEtiqueta&&p.estado_analisis==='listo')tarjeta.append(boton(`Imprimir ${k} ${k===1?'etiqueta':'etiquetas'}`,async()=>{const ok=await ctx.imprimir([p.id],new Map([[p.id,k]]));if(ok){actual.faltaEtiqueta=false;mensaje('Etiqueta enviada','etiqueta');}}));
  }
  function pintarImagen(a,foto){if(!a.imagen?.url){foto.textContent='Sin foto';return;}const img=nodo('img');img.src=a.imagen.url;img.alt=a.imagen.nombre||a.ficha.nombre;img.referrerPolicy='no-referrer';img.onerror=()=>{img.remove();foto.textContent='Sin foto';};foto.replaceChildren(img);}
  async function imagen(a,foto){try{
    // La ficha trae la imagen guardada; si no, el resolver ya la busca en segundo plano (#491): se consulta sin repetir la búsqueda en Target y solo al final se pide (con su error).
    let r={imagen:a.ficha.imagen};
    for(const espera of r.imagen||!a.enCamino?[]:[2000,2000]){await new Promise(f=>setTimeout(f,espera));if(flujo.actual()!==a)return;r=await api(`/api/manifiesto/${a.upc}/imagen`);if(r.imagen)break;}
    if(!r.imagen)r=await api(`/api/manifiesto/${a.upc}/imagen`,{},'POST');a.imagen=r.imagen;if(flujo.actual()===a)pintarImagen(a,foto);}catch(e){if(flujo.actual()===a){foto.textContent='Sin foto';mensaje(e.message,'aviso');}}}
  async function buscarDesconocida(a){
    if(a.buscando)return;
    let abrir=()=>flujo.retomar(a);
    const li=nodo('li'),retomar=boton(`Código ${a.upc} · buscando…`,()=>abrir());li.append(retomar);historia.prepend(li);
    a.buscando=true;mensaje('Buscando en internet…');
    const guardada=await api('/api/borradores/upc/buscar',{id:a.id,upc:a.upc,stock:a.cantidad,estado_fisico:a.estado});
    if(guardada.existente){a.tipo='existente';a.pieza=guardada;await recibirExistente(guardada,a.id);if(guardada.estado_analisis==='listo'){retomar.textContent=guardada.nombre;return;}}
    for(let i=0;i<35;i++){await new Promise(r=>setTimeout(r,4000));const datos=await api(`/api/borradores/upc/${a.id}`);if(datos.estado_analisis==='listo'){retomar.textContent=`✓ ${datos.nombre}`;if(guardada.existente){mensaje('Encontrada · lista para etiqueta','ok');a.pieza=datos;await recibirExistente({...datos,existente:true,sumadas:guardada.sumadas},a.id);}else{mensaje('Encontrada · revisa y guarda','ok');abrir=()=>revisarEncontrada(a,datos);if(flujo.actual()===a)await abrir();}return;}if(datos.estado_analisis==='error'){retomar.textContent=`▲ ${a.upc} · toma foto`;mensaje('Sin resultado · toma foto','aviso');return;}}
  }
  // Una pieza nueva hallada en internet no imprime sola (#573): su tarjeta muestra nombre, precio, cantidad y grado, y «Guardar» la confirma.
  async function revisarEncontrada(a,datos){
    const r=await api(`/api/borradores/${a.id}/revision`);
    if(!r.por_revisar)return flujo.elegir({...datos,tiene_foto:datos.con_foto});   // otro dispositivo ya la confirmó
    flujo.retomar({tipo:'nueva',revision:true,imagenBuscada:true,id:a.id,upc:a.upc,cantidad:r.stock,estado:r.estado_fisico,estadoInicial:r.estado_fisico,
      ficha:{nombre:r.nombre,precio:r.precio,precios:r.precios,precio_lista:r.precio_lista,stock:r.stock},imagen:datos.con_foto?{url:`/api/foto/${a.id}`,nombre:r.nombre}:{}});
  }
  async function fotoPieza(p){
    if(!pc())return movil.fotoPieza(p);
    if(pendienteFoto)return;pendienteFoto=true;actualizarDisparo();
    try{const {pedirFoto}=await import('./camara-pc.js');$('chip-celular').textContent='● Esperando foto';const r=await pedirFoto({tipo:'foto_pieza',pieza_id:p.id,contenedor:remota});if(['lista','cancelada'].includes(r.estado))remota.replaceChildren();if(r.estado==='lista'){const d=await api(`/api/piezas/${p.id}`);flujo.elegir(d.pieza);$('chip-celular').textContent='● Celular · Listo';mensaje('Foto recibida','ok');}else mensaje(r.motivo||'No se recibió foto','aviso');}
    finally{pendienteFoto=false;actualizarDisparo();foco();}
  }
  async function fotoNueva(a=null){
    if(!pc())return movil.tomar(piezaSinRegistrar(a||flujo.actual()));
    if(esRopa&&!a&&!tablero.validar())return;
    if(faltaCalzado(a))throw new Error(faltaCalzado(a));
    if(pendienteFoto)return;
    pendienteFoto=true;actualizarDisparo();if(!a)pieza.replaceChildren();
    const id=a?.id||crypto.randomUUID(),params={cantidad:a?.cantidad||cantidad,estado_fisico:esRopa&&!a?.upc?'nuevo':a?.estado||estado,...(a?.upc?{upc:a.upc,...(a.talla?{talla:a.talla}:{})}:esRopa?tablero.valores():{upc:''})};
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
  addEventListener('offline',()=>{for(const b of pieza.querySelectorAll('button'))if(b.textContent.startsWith('Sumar'))bloquear(b,'Sin red: se suma al volver la señal');});
  addEventListener('online',()=>{for(const b of pieza.querySelectorAll('button'))if(b.textContent.startsWith('Sumar'))bloquear(b,'');});
  const interfaz = { empezar:()=>movil?.empezar?.(),abrir(){neutro();foco();void movil?.abrir();},neutro,leer:async(c)=>{movil?.actividad();consulta=c;await flujo.leer(c);if(flujo.actual()?.tipo==='existente')mensaje(`Ya existe · ×${flujo.actual().pieza.stock}${flujo.actual().cantidad>1?` · sumar ${flujo.actual().cantidad}`:''}`,'aviso');else if(!flujo.actual()){const n=lista.querySelectorAll('.resultado').length;mensaje(n?`${n} coincidencias`:'Sin coincidencias','aviso');}else if(flujo.actual()?.tipo==='nueva')mensaje(`${flujo.actual().ficha.nombre} ×${flujo.actual().cantidad}`,'ok');},pausar(){movil?.pausar();},flujo,
    // La fase móvil conecta estas entradas al mismo flujo y conserva los registros de la cola.
    entrada,derecha,tipo,grado,escribir,sinFoto,manual,tablero,recibirExistente,imprimirCaptura,imprimirPieza:imprimir,disparo,remota,lista,pieza,esRopa:()=>esRopa,estado:()=>estado,cantidad:()=>cantidad,contador,fotoNueva,fotoPieza,
  };
  if(!pc()){const {iniciarCelular}=await import('./inventario-celular.js');movil=await iniciarCelular(ctx,interfaz);}
  interfaz.subir=()=>movil?.subir();
  return interfaz;
}
