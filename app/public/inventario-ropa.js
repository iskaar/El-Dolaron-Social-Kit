import { PRENDAS_ROPA, MARCAS_ROPA, PRECIO_PRENDA, PRECIOS_ROPA, PAQUETES, PAQUETE_MAX, paqueteValido } from './ropa.js';
import { TALLAS_ADULTO, TALLA_NINO_UNICA, EDADES_NINO, TALLAS_NINO, TABLAS_CALZADO, CALZADO_INICIAL, calzadoRenglon, calzadoValor, calzadoGuardado } from './tallas.js';
import { nodo, boton, hoja, cerrarHoja } from './inventario-ui.js';
import { aCentavos } from './ficha.js';

export function opciones(opciones, valor, cambiar, nombre) {
  const c = nodo('div', undefined, 'chips'); c.setAttribute('role','group');c.setAttribute('aria-label',nombre);
  for(const [clave,texto] of opciones){const b=boton(texto,()=>{for(const otro of c.children)otro.setAttribute('aria-pressed',String(otro===b));cambiar(clave);});b.dataset.valor=clave;b.setAttribute('aria-pressed',String(clave===valor));c.append(b);}
  return c;
}

/**
 * Selector secundario (edad, número de calzado, otra marca): en la página abre la hoja; dentro de una hoja (Revisar antes de
 * imprimir) se pinta debajo del `ancla`. Abrir otra hoja reemplazaba la revisión y «Usar talla» la cerraba sin guardar (#705).
 * Devuelve cómo cerrarlo.
 */
function abrirSub(ancla,titulo,contenido){
  if(!ancla.closest?.('dialog')){hoja(titulo,contenido);return cerrarHoja;}
  const panel=nodo('div',undefined,'sub-hoja');panel.append(nodo('h3',titulo),contenido);
  ancla.querySelector(':scope > .sub-hoja')?.remove();ancla.append(panel);return ()=>panel.remove();
}

let numeroRodillo=0, edadSesion=EDADES_NINO.indexOf('4 años');

/** scrollTop/fila elige la opción del centro; poner sincroniza sin emitir cambios. */
export function rodillo(opciones, indice, cambiar, nombre) {
  const raiz=nodo('div',undefined,'rodillo'),id=`rodillo-${++numeroRodillo}`;
  raiz.setAttribute('role','listbox');raiz.setAttribute('aria-label',nombre);raiz.tabIndex=0;
  const fila=()=>raiz.firstElementChild?.offsetHeight||44;
  const pintar=()=>{[...raiz.children].forEach((r,i)=>{r.classList.toggle('elegida',i===indice);r.setAttribute('aria-selected',String(i===indice));});if(indice>=0)raiz.setAttribute('aria-activedescendant',`${id}-${indice}`);else raiz.removeAttribute('aria-activedescendant');};
  const elegir=i=>{if(i!==indice){indice=i;pintar();cambiar(i);}};
  for(const [i,texto] of opciones.entries()){
    const r=nodo('div',texto);r.id=`${id}-${i}`;r.setAttribute('role','option');
    r.onclick=()=>{const top=i*fila();if(raiz.scrollTop===top)elegir(i);else raiz.scrollTo({top,behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});};raiz.append(r);
  }
  raiz.addEventListener('scroll',()=>elegir(Math.min(opciones.length-1,Math.max(0,Math.round(raiz.scrollTop/fila())))),{passive:true});
  raiz.onkeydown=e=>{if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();const i=e.key==='Home'?0:e.key==='End'?opciones.length-1:Math.min(opciones.length-1,Math.max(0,indice+(e.key==='ArrowDown'?1:-1)));elegir(i);raiz.scrollTo({top:i*fila(),behavior:'instant'});}};
  raiz.poner=i=>{indice=i;if(i>=0)raiz.scrollTo({top:i*fila(),behavior:'instant'});pintar();};   // -1 = ninguna (precio libre): no se mueve, o el scroll elegiría la primera
  pintar();return raiz;
}

export function talla(ponerValor, inicial = '') {
  // "Niño 19" (calzado en cm) no es "Niño 6 años" (ropa, con edad): se distingue por las tablas (#543, #546).
  const guardado=calzadoGuardado(inicial.split(' / ')[0]),tipo=guardado?guardado.tipo:inicial.startsWith('Niño ')&&inicial!==TALLA_NINO_UNICA?'Niño':'';
  const raiz=nodo('div',undefined,'tallas-ropa'),adultos=opciones([...TALLAS_ADULTO.map(t=>[t,t]),['Niño','Niño…'],[TALLA_NINO_UNICA,TALLA_NINO_UNICA],...Object.keys(TABLAS_CALZADO).map(t=>[t,t+'…'])],tipo||inicial,elegir,'Talla');
  let elegida=tipo||inicial, edad=tipo==='Niño'?EDADES_NINO.indexOf(inicial.slice(5).split(' / ')[0]):edadSesion, infantil=tipo==='Niño'?(inicial.split(' / ')[1]||''):'';
  const calzado=Object.fromEntries(Object.entries(TABLAS_CALZADO).map(([t,tabla])=>[t,t===tipo?guardado.indice:tabla.findIndex(([us])=>us===CALZADO_INICIAL[t])]));
  const avisar=()=>ponerValor(elegida==='Niño'?`Niño ${EDADES_NINO[edad]}${infantil?' / '+infantil:''}`:elegida in calzado?calzadoValor(elegida,calzado[elegida]):elegida);
  function elegir(t){elegida=t;if(t==='Niño')abrirNino();else if(t in calzado)abrirCalzado(t);else avisar();}
  function abrirNino(){
    const c=nodo('div',undefined,'nino'),edades=rodillo(EDADES_NINO,edad,i=>{edad=edadSesion=i;avisar();},'Edad');let cerrar;
    c.append(edades,opciones([['','Sin talla'],...TALLAS_NINO.map(t=>[t,t])],infantil,t=>{infantil=t;avisar();},'Talla de niño'),boton('Usar talla',()=>{avisar();cerrar();},'primario'));
    cerrar=abrirSub(raiz,'Talla de niño',c);edades.poner(edad);avisar();
  }
  function abrirCalzado(t){
    const c=nodo('div',undefined,'nino'),numeros=rodillo(TABLAS_CALZADO[t].map(calzadoRenglon),calzado[t],i=>{calzado[t]=i;avisar();},'Talla de calzado (US)');let cerrar;
    c.append(numeros,boton('Usar talla',()=>{avisar();cerrar();},'primario'));
    cerrar=abrirSub(raiz,t==='Calzado niño'?'Calzado de niño (US · cm MX)':t==='Calzado M'?'Calzado de mujer (US · cm MX)':'Calzado de hombre (US · cm MX)',c);numeros.poner(calzado[t]);avisar();
  }
  raiz.append(adultos);return raiz;
}

/** `dueno`: solo quien fija precios escribe uno fuera de los escalones (#714); los demás siguen con los escalones. */
export function ropa({ pc, mensaje, cambiar=()=>{}, recordar=true, inicial={}, dueno=false }) {
  const raiz=nodo('div',undefined,'tablero-ropa');let valores={prenda:'',marca:'',talla:'',precio_ropa:null,paquete:0,...inicial};
  if(recordar)try{valores.prenda=localStorage.getItem('captura-prenda')||'';valores.marca=localStorage.getItem('captura-marca')||'';const precio=Number(localStorage.getItem('captura-precio_ropa'));valores.precio_ropa=PRECIOS_ROPA.includes(precio)?precio:PRECIO_PRENDA[valores.prenda]||null;}catch{}
  const notificar=()=>{cambiar({...valores});};
  function elegir(campo,valor){valores[campo]=valor;if(campo==='prenda'&&PRECIO_PRENDA[valor])valores.precio_ropa=PRECIO_PRENDA[valor];if(recordar)try{for(const k of ['prenda','marca','precio_ropa'])localStorage.setItem('captura-'+k,valores[k]??'');}catch{}sincronizar(campo);notificar();}
  const grupos=[];
  function grupo(campo,titulo,lista,cerrar=cerrarHoja){
    const c=nodo('div'),chips=opciones(lista,valores[campo],v=>elegir(campo,v),titulo);c.append(chips);let input;
    if(campo==='marca'){const l=nodo('label','Otra marca');input=nodo('input');input.maxLength=40;input.value=valores.marca;input.setAttribute('list','marcas-recientes-inventario');
      const dl=nodo('datalist');dl.id='marcas-recientes-inventario';let recientes=[];try{recientes=JSON.parse(localStorage.getItem('captura-marcas-recientes')||'[]');}catch{}
      for(const m of recientes){const o=nodo('option');o.value=m;dl.append(o);}input.onchange=()=>{const m=input.value.trim();elegir('marca',m);if(recordar&&m&&!MARCAS_ROPA.includes(m))try{localStorage.setItem('captura-marcas-recientes',JSON.stringify([m,...recientes.filter(x=>x!==m)].slice(0,10)));}catch{}};l.append(input,dl);c.append(l);}
    if(['prenda','marca'].includes(campo))c.append(boton('Quitar',()=>{elegir(campo,'');if(!pc())cerrar();}));
    if(!pc())grupos.length=0;grupos.push([campo,chips,input]);
    return c;
  }
  // Paquete ×N (#714): UNA pieza con UNA etiqueta; vuelve a «Sin paquete» con cada pieza nueva (reiniciarPaquete) y no se recuerda.
  const paquetes=opciones([[0,'Sin paquete'],...PAQUETES.map(n=>[n,`×${n}`]),['otro','Otro…']],valores.paquete,v=>v==='otro'?pedirPaquete():elegir('paquete',v),'Paquete');paquetes.classList.add('paquetes-ropa');
  function pedirPaquete(){
    const c=nodo('div'),l=nodo('label',`Piezas en el paquete (2 a ${PAQUETE_MAX})`),input=nodo('input');input.type='number';input.min='2';input.max=String(PAQUETE_MAX);input.inputMode='numeric';
    if(valores.paquete>PAQUETES[PAQUETES.length-1])input.value=String(valores.paquete);l.append(input);let cerrar;
    c.append(l,boton('Usar paquete',()=>{const n=Number(input.value);if(!paqueteValido(n))return mensaje(`Escribe de 2 a ${PAQUETE_MAX} piezas`,'aviso');elegir('paquete',n);cerrar();},'primario'));
    cerrar=abrirSub(raiz,'Paquete',c);sincronizar('paquete');
  }
  // Precio libre (#714): el servidor solo lo acepta del dueño, igual que el precio de la tarjeta UPC; los demás siguen con los escalones.
  const otroPrecio=dueno?boton('Otro precio',pedirPrecio):null;
  function pedirPrecio(){
    const c=nodo('div'),l=nodo('label','Precio ($)'),input=nodo('input');input.inputMode='decimal';input.maxLength=10;
    if(valores.precio_ropa&&!PRECIOS_ROPA.includes(valores.precio_ropa))input.value=String(valores.precio_ropa/100);l.append(input);let cerrar;
    c.append(l,boton('Usar precio',()=>{const p=aCentavos(input.value);if(!p)return mensaje('Escribe un precio mayor a cero en pesos','aviso');elegir('precio_ropa',p);cerrar();},'primario'));
    cerrar=abrirSub(raiz,'Otro precio',c);
  }
  const prendas=['',...PRENDAS_ROPA],prenda=pc()?null:rodillo(['Sin prenda',...PRENDAS_ROPA],prendas.indexOf(valores.prenda),i=>elegir('prenda',prendas[i]),'Prenda');
  const precio=pc()?null:rodillo(PRECIOS_ROPA.map(p=>`$${p/100}`),PRECIOS_ROPA.indexOf(valores.precio_ropa),i=>elegir('precio_ropa',PRECIOS_ROPA[i]),'Precio');
  let marcas,otra;
  if(pc()){
    for(const [campo,titulo,lista] of [['prenda','Prenda',PRENDAS_ROPA.map(t=>[t,t])],['marca','Marca',MARCAS_ROPA.map(t=>[t,t])],['precio_ropa','Precio',PRECIOS_ROPA.map(p=>[p,`$${p/100}`])]]){const fila=nodo('div');fila.append(nodo('h3',titulo),grupo(campo,titulo,lista));if(campo==='precio_ropa'&&otroPrecio)fila.append(otroPrecio);raiz.append(fila);}
    const filaPaquete=nodo('div');filaPaquete.append(nodo('h3','Paquete'),paquetes);raiz.append(filaPaquete);
  }else{
    const ruedas=nodo('div',undefined,'rodillos-ropa');
    for(const [titulo,rueda] of [['Prenda',prenda],['Precio',precio]]){const c=nodo('div');c.append(nodo('span',titulo),rueda);if(titulo==='Precio'&&otroPrecio)c.append(otroPrecio);ruedas.append(c);}raiz.append(ruedas);
    marcas=opciones([['','Sin marca'],...MARCAS_ROPA.slice(0,4).map(m=>[m,m])],valores.marca,v=>elegir('marca',v),'Marca');marcas.classList.add('marcas-ropa');
    otra=boton('Otra…',()=>{let cerrar;cerrar=abrirSub(raiz,'Marca',grupo('marca','Marca',MARCAS_ROPA.map(m=>[m,m]),()=>cerrar()));});marcas.append(otra);raiz.append(marcas,paquetes);
  }
  const tallas=talla(v=>{valores.talla=v;tallas.classList.remove('falta');notificar();},valores.talla);tallas.setAttribute('aria-label','Talla');raiz.append(tallas);
  function sincronizar(campo){
    if(campo!=='prenda')prenda?.poner(prendas.indexOf(valores.prenda));if(campo!=='precio_ropa')precio?.poner(PRECIOS_ROPA.indexOf(valores.precio_ropa));
    for(const [campo,chips,input] of [...grupos,...(marcas?[['marca',marcas]]:[])]){for(const b of chips.children)if(b.dataset.valor!==undefined)b.setAttribute('aria-pressed',String(b.dataset.valor===String(valores[campo])));if(input)input.value=valores.marca;}
    if(otra){const personalizada=!!valores.marca&&!MARCAS_ROPA.slice(0,4).includes(valores.marca);otra.textContent=personalizada?valores.marca:'Otra…';otra.setAttribute('aria-pressed',String(personalizada));}
    const personalizado=valores.paquete>0&&!PAQUETES.includes(valores.paquete);
    for(const b of paquetes.children){const otro=b.dataset.valor==='otro';b.setAttribute('aria-pressed',String(otro?personalizado:String(b.dataset.valor)===String(valores.paquete)));if(otro)b.textContent=personalizado?`×${valores.paquete}`:'Otro…';}
    if(otroPrecio){const libre=!!valores.precio_ropa&&!PRECIOS_ROPA.includes(valores.precio_ropa);otroPrecio.textContent=libre?`$${valores.precio_ropa/100}`:'Otro precio';otroPrecio.setAttribute('aria-pressed',String(libre));}
    tallas.classList.toggle('falta',!valores.talla);precio?.classList.toggle('falta',!valores.precio_ropa);
  }
  const faltante=()=>!valores.talla?'Falta talla':!valores.precio_ropa?'Falta precio':'';
  return { raiz, sincronizar, faltante, reiniciarPaquete(){if(valores.paquete){valores.paquete=0;sincronizar('paquete');notificar();}}, valores:()=>({...valores}), validar(){const motivo=faltante();if(motivo){mensaje(motivo,'aviso');sincronizar();}return !motivo;} };
}
