import { PRENDAS_ROPA, MARCAS_ROPA, PRECIO_PRENDA, PRECIOS_ROPA } from './ropa.js';
import { TALLAS_ADULTO, EDADES_NINO, TALLAS_NINO, TALLAS_CALZADO_ADULTO, TALLAS_CALZADO_NINO } from './tallas.js';
import { nodo, boton, hoja, cerrarHoja } from './inventario-ui.js';

export function opciones(opciones, valor, cambiar, nombre) {
  const c = nodo('div', undefined, 'chips'); c.setAttribute('role','group');c.setAttribute('aria-label',nombre);
  for(const [clave,texto] of opciones){const b=boton(texto,()=>{for(const otro of c.children)otro.setAttribute('aria-pressed',String(otro===b));cambiar(clave);});b.dataset.valor=clave;b.setAttribute('aria-pressed',String(clave===valor));c.append(b);}
  return c;
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
  raiz.poner=i=>{indice=i;raiz.scrollTo({top:Math.max(0,i)*fila(),behavior:'instant'});pintar();};
  pintar();return raiz;
}

export function talla(ponerValor, inicial = '') {
  // "Niño 15" (calzado, solo numero) no es "Niño 6 años" (ropa, con edad): se distingue por la lista (#543).
  const resto=inicial.startsWith('Niño ')?inicial.slice(5).split(' / ')[0]:'',
    tipo=TALLAS_CALZADO_ADULTO.includes(inicial)?'Calzado':TALLAS_CALZADO_NINO.includes(resto)?'Calzado niño':resto?'Niño':'';
  const raiz=nodo('div',undefined,'tallas-ropa'),adultos=opciones([...TALLAS_ADULTO.map(t=>[t,t]),['Niño','Niño…'],['Calzado','Calzado…'],['Calzado niño','Calzado niño…']],tipo||inicial,elegir,'Talla');
  let elegida=tipo||inicial, edad=tipo==='Niño'?EDADES_NINO.indexOf(resto):edadSesion, infantil=tipo==='Niño'?(inicial.split(' / ')[1]||''):'';
  const calzado={'Calzado':TALLAS_CALZADO_ADULTO.indexOf(tipo==='Calzado'?inicial:'25'),'Calzado niño':TALLAS_CALZADO_NINO.indexOf(tipo==='Calzado niño'?resto:'15')};
  const avisar=()=>ponerValor(elegida==='Niño'?`Niño ${EDADES_NINO[edad]}${infantil?' / '+infantil:''}`:elegida==='Calzado'?TALLAS_CALZADO_ADULTO[calzado[elegida]]:elegida==='Calzado niño'?`Niño ${TALLAS_CALZADO_NINO[calzado[elegida]]}`:elegida);
  function elegir(t){elegida=t;if(t==='Niño')abrirNino();else if(t in calzado)abrirCalzado(t);else avisar();}
  function abrirNino(){
    const c=nodo('div',undefined,'nino'),edades=rodillo(EDADES_NINO,edad,i=>{edad=edadSesion=i;avisar();},'Edad');
    c.append(edades,opciones([['','Sin talla'],...TALLAS_NINO.map(t=>[t,t])],infantil,t=>{infantil=t;avisar();},'Talla de niño'),boton('Usar talla',()=>{avisar();cerrarHoja();},'primario'));
    hoja('Talla de niño',c);edades.poner(edad);avisar();
  }
  function abrirCalzado(t){
    const lista=t==='Calzado'?TALLAS_CALZADO_ADULTO:TALLAS_CALZADO_NINO,c=nodo('div',undefined,'nino'),numeros=rodillo(lista,calzado[t],i=>{calzado[t]=i;avisar();},'Talla de calzado');
    c.append(numeros,boton('Usar talla',()=>{avisar();cerrarHoja();},'primario'));
    hoja(t==='Calzado'?'Talla de calzado (cm MX)':'Talla de calzado de niño (cm MX)',c);numeros.poner(calzado[t]);avisar();
  }
  raiz.append(adultos);return raiz;
}

export function ropa({ pc, mensaje, cambiar=()=>{}, recordar=true, inicial={} }) {
  const raiz=nodo('div',undefined,'tablero-ropa');let valores={prenda:'',marca:'',talla:'',precio_ropa:null,...inicial};
  if(recordar)try{valores.prenda=localStorage.getItem('captura-prenda')||'';valores.marca=localStorage.getItem('captura-marca')||'';const precio=Number(localStorage.getItem('captura-precio_ropa'));valores.precio_ropa=PRECIOS_ROPA.includes(precio)?precio:PRECIO_PRENDA[valores.prenda]||null;}catch{}
  const notificar=()=>{cambiar({...valores});};
  function elegir(campo,valor){valores[campo]=valor;if(campo==='prenda'&&PRECIO_PRENDA[valor])valores.precio_ropa=PRECIO_PRENDA[valor];if(recordar)try{for(const k of ['prenda','marca','precio_ropa'])localStorage.setItem('captura-'+k,valores[k]??'');}catch{}sincronizar(campo);notificar();}
  const grupos=[];
  function grupo(campo,titulo,lista){
    const c=nodo('div'),chips=opciones(lista,valores[campo],v=>elegir(campo,v),titulo);c.append(chips);let input;
    if(campo==='marca'){const l=nodo('label','Otra marca');input=nodo('input');input.maxLength=40;input.value=valores.marca;input.setAttribute('list','marcas-recientes-inventario');
      const dl=nodo('datalist');dl.id='marcas-recientes-inventario';let recientes=[];try{recientes=JSON.parse(localStorage.getItem('captura-marcas-recientes')||'[]');}catch{}
      for(const m of recientes){const o=nodo('option');o.value=m;dl.append(o);}input.onchange=()=>{const m=input.value.trim();elegir('marca',m);if(recordar&&m&&!MARCAS_ROPA.includes(m))try{localStorage.setItem('captura-marcas-recientes',JSON.stringify([m,...recientes.filter(x=>x!==m)].slice(0,10)));}catch{}};l.append(input,dl);c.append(l);}
    if(['prenda','marca'].includes(campo))c.append(boton('Quitar',()=>{elegir(campo,'');if(!pc())cerrarHoja();}));
    if(!pc())grupos.length=0;grupos.push([campo,chips,input]);
    return c;
  }
  const prendas=['',...PRENDAS_ROPA],prenda=pc()?null:rodillo(['Sin prenda',...PRENDAS_ROPA],prendas.indexOf(valores.prenda),i=>elegir('prenda',prendas[i]),'Prenda');
  const precio=pc()?null:rodillo(PRECIOS_ROPA.map(p=>`$${p/100}`),PRECIOS_ROPA.indexOf(valores.precio_ropa),i=>elegir('precio_ropa',PRECIOS_ROPA[i]),'Precio');
  let marcas,otra;
  if(pc()){
    for(const [campo,titulo,lista] of [['prenda','Prenda',PRENDAS_ROPA.map(t=>[t,t])],['marca','Marca',MARCAS_ROPA.map(t=>[t,t])],['precio_ropa','Precio',PRECIOS_ROPA.map(p=>[p,`$${p/100}`])]]){const fila=nodo('div');fila.append(nodo('h3',titulo),grupo(campo,titulo,lista));raiz.append(fila);}
  }else{
    const ruedas=nodo('div',undefined,'rodillos-ropa');
    for(const [titulo,rueda] of [['Prenda',prenda],['Precio',precio]]){const c=nodo('div');c.append(nodo('span',titulo),rueda);ruedas.append(c);}raiz.append(ruedas);
    marcas=opciones([['','Sin marca'],...MARCAS_ROPA.slice(0,4).map(m=>[m,m])],valores.marca,v=>elegir('marca',v),'Marca');marcas.classList.add('marcas-ropa');
    otra=boton('Otra…',()=>hoja('Marca',grupo('marca','Marca',MARCAS_ROPA.map(m=>[m,m]))));marcas.append(otra);raiz.append(marcas);
  }
  const tallas=talla(v=>{valores.talla=v;tallas.classList.remove('falta');notificar();},valores.talla);tallas.setAttribute('aria-label','Talla');raiz.append(tallas);
  function sincronizar(campo){
    if(campo!=='prenda')prenda?.poner(prendas.indexOf(valores.prenda));if(campo!=='precio_ropa')precio?.poner(PRECIOS_ROPA.indexOf(valores.precio_ropa));
    for(const [campo,chips,input] of [...grupos,...(marcas?[['marca',marcas]]:[])]){for(const b of chips.children)if(b.dataset.valor!==undefined)b.setAttribute('aria-pressed',String(b.dataset.valor===String(valores[campo])));if(input)input.value=valores.marca;}
    if(otra){const personalizada=!!valores.marca&&!MARCAS_ROPA.slice(0,4).includes(valores.marca);otra.textContent=personalizada?valores.marca:'Otra…';otra.setAttribute('aria-pressed',String(personalizada));}
    tallas.classList.toggle('falta',!valores.talla);precio?.classList.toggle('falta',!valores.precio_ropa);
  }
  const faltante=()=>!valores.talla?'Falta talla':!valores.precio_ropa?'Falta precio':'';
  return { raiz, sincronizar, faltante, valores:()=>({...valores}), validar(){const motivo=faltante();if(motivo){mensaje(motivo,'aviso');sincronizar();}return !motivo;} };
}
