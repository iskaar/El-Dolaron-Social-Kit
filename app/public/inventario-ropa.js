import { PRENDAS_ROPA, MARCAS_ROPA, PRECIO_PRENDA, PRECIOS_ROPA } from './ropa.js';
import { TALLAS_ADULTO, EDADES_NINO, TALLAS_NINO } from './tallas.js';
import { nodo, boton, hoja, cerrarHoja } from './inventario-ui.js';

export function opciones(opciones, valor, cambiar, nombre) {
  const c = nodo('div', undefined, 'chips'); c.setAttribute('role','group');c.setAttribute('aria-label',nombre);
  for(const [clave,texto] of opciones){const b=boton(texto,()=>{for(const otro of c.children)otro.setAttribute('aria-pressed',String(otro===b));cambiar(clave);});b.dataset.valor=clave;b.setAttribute('aria-pressed',String(clave===valor));c.append(b);}
  return c;
}

/** El mismo rodillo de /captura: scrollTop/fila elige la edad del centro. */
export function talla(ponerValor, inicial = '') {
  const raiz=nodo('div'),adultos=opciones([...TALLAS_ADULTO.map(t=>[t,t]),['Niño','Niño…']],inicial,elegir,'Talla');
  let elegida=inicial, edad=EDADES_NINO.indexOf('4 años'), infantil='';
  const avisar=()=>ponerValor(elegida==='Niño'?`Niño ${EDADES_NINO[edad]}${infantil?' / '+infantil:''}`:elegida);
  function elegir(t){elegida=t;if(t==='Niño')abrirNino();else avisar();}
  function abrirNino(){
    const c=nodo('div',undefined,'nino'),rodillo=nodo('div',undefined,'rodillo');rodillo.setAttribute('role','listbox');rodillo.setAttribute('aria-label','Edad');rodillo.tabIndex=0;
    const fila=()=>rodillo.firstElementChild?.offsetHeight||48;
    const pintar=()=>[...rodillo.children].forEach((r,i)=>{r.classList.toggle('elegida',i===edad);r.setAttribute('aria-selected',String(i===edad));});
    for(const [i,texto] of EDADES_NINO.entries()){const r=nodo('div',texto);r.setAttribute('role','option');r.onclick=()=>rodillo.scrollTo({top:i*fila(),behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});rodillo.append(r);}
    rodillo.addEventListener('scroll',()=>{const i=Math.min(EDADES_NINO.length-1,Math.max(0,Math.round(rodillo.scrollTop/fila())));if(i!==edad){edad=i;pintar();avisar();}},{passive:true});
    rodillo.onkeydown=e=>{if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();edad=e.key==='Home'?0:e.key==='End'?EDADES_NINO.length-1:Math.min(EDADES_NINO.length-1,Math.max(0,edad+(e.key==='ArrowDown'?1:-1)));rodillo.scrollTop=edad*fila();pintar();avisar();}};
    c.append(rodillo,opciones([['','Sin talla'],...TALLAS_NINO.map(t=>[t,t])],infantil,t=>{infantil=t;avisar();},'Talla de niño'),boton('Usar talla',()=>{avisar();cerrarHoja();},'primario'));
    hoja('Talla de niño',c);rodillo.scrollTop=edad*fila();pintar();avisar();
  }
  raiz.append(adultos);return raiz;
}

export function ropa({ pc, mensaje, cambiar=()=>{}, recordar=true, inicial={} }) {
  const raiz=nodo('div',undefined,'tablero-ropa');let valores={prenda:'',marca:'',talla:'',precio_ropa:null,...inicial};
  if(recordar){valores.prenda=localStorage.getItem('captura-prenda')||'';valores.marca=localStorage.getItem('captura-marca')||'';if(PRECIO_PRENDA[valores.prenda])valores.precio_ropa=PRECIO_PRENDA[valores.prenda];}
  const notificar=()=>{cambiar({...valores});};
  function elegir(campo,valor){valores[campo]=valor;if(recordar&&['prenda','marca'].includes(campo))localStorage.setItem('captura-'+campo,valor);if(campo==='prenda'&&PRECIO_PRENDA[valor])valores.precio_ropa=PRECIO_PRENDA[valor];pintar();notificar();}
  function grupo(campo,titulo,lista){
    const c=nodo('div');c.append(opciones(lista,valores[campo],v=>{elegir(campo,v);if(!pc()&&campo!=='marca')cerrarHoja();},titulo));
    if(campo==='marca'){const l=nodo('label','Otra marca'),input=nodo('input');input.maxLength=40;input.value=valores.marca;input.setAttribute('list','marcas-recientes-inventario');
      const dl=nodo('datalist');dl.id='marcas-recientes-inventario';let recientes=[];try{recientes=JSON.parse(localStorage.getItem('captura-marcas-recientes')||'[]');}catch{}
      for(const m of recientes){const o=nodo('option');o.value=m;dl.append(o);}input.onchange=()=>{const m=input.value.trim();elegir('marca',m);if(recordar&&m&&!MARCAS_ROPA.includes(m))localStorage.setItem('captura-marcas-recientes',JSON.stringify([m,...recientes.filter(x=>x!==m)].slice(0,10)));};l.append(input,dl);c.append(l);}
    if(['prenda','marca'].includes(campo))c.append(boton('Quitar',()=>{elegir(campo,'');if(!pc())cerrarHoja();}));
    return c;
  }
  function pintar(){
    raiz.replaceChildren();
    const resumen=nodo('div',undefined,'resumen-ropa');
    for(const [campo,titulo,lista] of [['prenda','Prenda',PRENDAS_ROPA.map(t=>[t,t])],['marca','Marca',MARCAS_ROPA.map(t=>[t,t])],['precio_ropa','Precio',PRECIOS_ROPA.map(p=>[p,`$${p/100}`])]]){
      if(pc()){const fila=nodo('div');fila.append(nodo('h3',titulo),grupo(campo,titulo,lista));raiz.append(fila);}
      else resumen.append(boton(valores[campo]?(campo==='precio_ropa'?`$${valores[campo]/100}`:valores[campo]):`? ${titulo}`,()=>hoja(titulo,grupo(campo,titulo,lista))));
    }
    if(!pc())raiz.append(resumen);
    const tallaActual=nodo('p',valores.talla?`Talla ${valores.talla}`:'? Talla');tallaActual.className=valores.talla?'':'falta';
    raiz.append(tallaActual,talla(v=>{valores.talla=v;tallaActual.textContent=`Talla ${v}`;tallaActual.classList.remove('falta');notificar();},valores.talla));
  }
  pintar();
  return { raiz, valores:()=>({...valores}), validar(){const motivo=!valores.talla?'Falta talla':!valores.precio_ropa?'Falta precio':'';if(motivo){mensaje(motivo,'aviso');raiz.classList.add('falta');}return !motivo;} };
}
