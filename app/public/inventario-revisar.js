import { CATEGORIAS } from './categorias.js';
import { ESTADOS, nombreEstado } from './estados.js';
import { agruparSesiones } from './sesiones.js';
import { cuerpoCorreccion, resolverRepetida } from './ficha.js';
import { enlacePreciosML } from './precios-ml.js';
import { copiarParaMarketplace } from './compartir.js';
import { cerrarHoja, bloquear } from './inventario-ui.js';
import { filaSolicitud, precios, refrescarPrecios } from './inventario-precio.js';
import { normalizarUpc } from './upc.js';
import { esRopa } from './ropa.js';

const normalizar = t => String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
export const diaTienda = iso => new Date(iso).toLocaleDateString('en-CA',{timeZone:'America/Mexico_City'});
export function filtrarRevision(piezas, filtro, sesionDe = new Map(), hoy = diaTienda(new Date())) {
  return piezas.filter(p=>{
    if(filtro.estado==='revisar'&&p.estado_analisis==='listo'&&p.precio>0)return false;
    if(filtro.estado==='hoy'&&diaTienda(p.creado_en)!==hoy)return false;
    if(filtro.estado==='error'&&p.estado_analisis!=='error')return false;
    if(filtro.busca&&!normalizar([p.nombre,p.codigo,p.upc].join(' ')).includes(normalizar(filtro.busca)))return false;
    if(filtro.dia&&diaTienda(p.creado_en)!==filtro.dia)return false;
    if(filtro.categoria&&p.categoria!==filtro.categoria)return false;
    if(filtro.min!==''&&p.precio<Number(filtro.min)*100)return false;
    if(filtro.max!==''&&p.precio>Number(filtro.max)*100)return false;
    return !filtro.sesion||sesionDe.get(p.id)===filtro.sesion;
  });
}

/** Existencia que el usuario tocó (la caja pudo vender desde que se abrió el formulario); null si no. `stock_visto` es la que se mostró. */
export function existenciaNueva(p,campos){
  const visto=campos.stock_visto??String(p.stock),t=String(campos.stock??'').trim();
  if(campos.stock===undefined||t===visto)return null;
  const n=Number(t);
  return t!==''&&Number.isInteger(n)&&n>=0&&n<=999?{valor:n,esperado:Number(visto)}:{error:'La existencia debe ser un entero de 0 a 999.'};
}

/** En una pieza `listo` la ficha compartida ya edita nombre, marca, talla y precios; aquí solo quedan categoría, estado, destino y existencia (#469). */
export const ocultoEnListo=(p,k)=>p.estado_analisis==='listo'&&['nombre','marca','talla','precio_lista','precio'].includes(k);

/** El PATCH de revisión lleva stock solo si se tocó y la pieza no es `listo` (esa va por el ajuste auditado, ver guardar); solo Recalcular omite precio deliberadamente. */
export function cuerpoRevision(p, campos, dueno, recalcular=false) {
  const puedePrecio=dueno||!p.codigo;
  const destino=campos.destino||p.destino;
  const r=cuerpoCorreccion({...p,destino},campos,puedePrecio);
  if(r.error)return r;
  const e=existenciaNueva(p,campos);if(e?.error)return e;
  const cuerpo={...r.cuerpo,...(e&&p.estado_analisis!=='listo'?{stock:e.valor}:{}),categoria:campos.categoria||p.categoria,estado_fisico:campos.estado_fisico||p.estado_fisico};
  if(recalcular){if(p.codigo&&!dueno)return {error:'El precio lo cambia el dueño'};delete cuerpo.precio;}
  return {cuerpo};
}

export async function iniciar(ctx) {
  const {$,nodo,boton,mensaje,hoja,api,dueno,confirmar,ficha,resultado,pc}=ctx;
  const puedeEditar=dueno||ctx.identidad.usuario?.editar_inventario===true;
  const raiz=$('modo-revisar'),columnas=nodo('div',undefined,'columnas'),izquierda=nodo('div'),derecha=nodo('div');izquierda.id='revision-entrada';derecha.id='detalle-revisar';columnas.append(izquierda,derecha);raiz.replaceChildren(columnas);
  const chips=nodo('div',undefined,'chips filtros-estado'),controles=nodo('div',undefined,'acciones barra-lista'),placeholder=nodo('p','Elige una pieza de la lista','vacio solo-pc'),activos=nodo('div',undefined,'chips'),lista=nodo('ul',undefined,'lista'),barra=nodo('div',undefined,'acciones-fijas'),nota=nodo('p',undefined,'ayuda');
  derecha.append(placeholder);
  let piezas=[],visibles=[],familias=[],montos=[],sesiones,abierta=null,generacion=0,ocupada=false,temporizador;
  let repetidas = new Map(), siguienteRepetidas = null, cargandoRepetidas = false;
  const seleccion=new Set(),borradores=new Map();
  const filtro={estado:'revisar',busca:'',dia:'',categoria:'',min:'',max:'',sesion:''};
  const estadoTexto=p=>p.estado_analisis==='error'?'■ Con error':p.estado_analisis==='pendiente'?'⏳ Analizando':p.precio<=0?'▲ Sin precio':'✓ Lista';
  const normalizarNombre=p=>normalizar(p.nombre);
  const gemela=p=>piezas.find(o=>o.id!==p.id&&o.estado_fisico===p.estado_fisico&&o.estado_analisis==='listo'&&normalizarNombre(o)===normalizarNombre(p)&&!(p.codigo&&o.codigo));
  for(const [v,t]of [...(dueno?[['precios','Precios por revisar']]:[]),['revisar','Por revisar'],['hoy','Hoy'],['error','Error'],['todas','Todas']]){const b=boton(t,()=>{filtro.estado=v;pintar();});b.dataset.estado=v;chips.append(b);}
  if(puedeEditar){const b=boton('Repetidas · 0',()=>{filtro.estado='repetidas';abierta=null;ficha.cerrar();document.body.classList.remove('con-ficha');pintar();b.scrollIntoView({block:'nearest',inline:'nearest'});});b.dataset.estado='repetidas';chips.append(b);}
  const botonFiltros=boton('Filtros',filtros),guardarTodo=boton('Guardar todo',()=>masiva('guardar',visibles),'guardar-todo'),mas=boton('⋯',()=>{
    const c=nodo('div',undefined,'formulario'),errores=piezas.filter(p=>p.estado_analisis==='error');
    c.append(boton('Actualizar',()=>{cerrarHoja();return cargar();}));
    if(puedeEditar){const r=boton(`Reintentar con error (${errores.length})`,()=>{cerrarHoja();return masiva('analizar',errores);});bloquear(r,errores.length?'':'Sin piezas con error');c.append(r);}
    hoja('Más acciones',c);});
  mas.setAttribute('aria-label','Más acciones');guardarTodo.hidden=true;
  controles.append(botonFiltros);
  if(puedeEditar)controles.append(guardarTodo);
  else controles.append(boton('Solo consulta',()=>hoja('Solo consulta',nodo('p','Tu cuenta no puede editar. Pídelo al dueño.')),'solo-consulta'));
  controles.append(mas);
  izquierda.append(chips,controles,activos,nota,lista,barra);
  const vacio=(texto,accion)=>{const li=nodo('li',undefined,'vacio');li.append(nodo('p',texto));if(accion)li.append(accion);return li;};
  async function cargar(){
    if(!navigator.onLine){placeholder.hidden=true;lista.replaceChildren(vacio('Este modo necesita red',boton('Ir a Capturar',()=>ctx.cambiarModo('capturar'))));mensaje('Este modo necesita red','aviso');return;}
    const turno=++generacion;mensaje('Cargando piezas…');
    const avisos=dueno?refrescarPrecios().catch(()=>{}):null;
    try{const [datos,grupos]=await Promise.all([api('/api/borradores'),puedeEditar?api('/api/piezas/repetidas').catch(()=>null):null]);await avisos;if(turno!==generacion)return;piezas=datos.reverse();repetidas=new Map();siguienteRepetidas=grupos?.siguiente||null;if(grupos)agregarRepetidas(grupos.grupos);sesiones=agruparSesiones(piezas);for(const id of seleccion)if(!piezas.some(p=>p.id===id))seleccion.delete(id);pintar();}
    catch(e){if(turno!==generacion)return;mensaje(e.message,'error');placeholder.hidden=true;lista.replaceChildren(vacio('Sin conexión',boton('Reintentar',cargar,'primario')));}
  }
  function pintar(){
    visibles=filtrarRevision(piezas,filtro,sesiones?.porPieza);
    const pendientes=piezas.filter(p=>p.estado_analisis!=='listo'||p.precio<=0).length,errores=piezas.filter(p=>p.estado_analisis==='error').length;
    etiquetasFiltro(pendientes,errores);
    controles.hidden=activos.hidden=filtro.estado==='precios';
    botonFiltros.hidden=filtro.estado==='repetidas';
    if(filtro.estado==='precios')return pintarPrecios();
    if(filtro.estado==='repetidas'){pintarRepetidas();return;}
    const nFiltros=['dia','categoria','min','max','sesion'].filter(k=>filtro[k]).length;botonFiltros.textContent=nFiltros?`Filtros (${nFiltros})`:'Filtros';guardarTodo.hidden=!visibles.length;
    nota.hidden=piezas.length!==2000;nota.textContent='Mostrando las 2000 más recientes';
    activos.replaceChildren();for(const[k,t]of [['dia','Día'],['categoria','Categoría'],['min','Desde'],['max','Hasta'],['sesion','Sesión']])if(filtro[k])activos.append(boton(`${t}: ${filtro[k]} ✕`,()=>{filtro[k]='';pintar();}));
    lista.replaceChildren();
    if(puedeEditar&&visibles.length){const li=nodo('li'),l=nodo('label',undefined,'casilla'),c=nodo('input');c.type='checkbox';c.checked=visibles.every(p=>seleccion.has(p.id));c.indeterminate=!c.checked&&visibles.some(p=>seleccion.has(p.id));c.onchange=()=>{for(const p of visibles)c.checked?seleccion.add(p.id):seleccion.delete(p.id);pintar();};l.append(c,nodo('span',`Todas (${visibles.length})`));li.append(l);lista.append(li);}
    for(const p of visibles){const li=resultado(p,()=>abrir(p));li.className='fila-revision';
      if(puedeEditar){const l=nodo('label',undefined,'casilla'),c=nodo('input');c.type='checkbox';c.setAttribute('aria-label',`Elegir ${p.nombre||'pieza'}`);c.checked=seleccion.has(p.id);c.onchange=()=>{c.checked?seleccion.add(p.id):seleccion.delete(p.id);pintarBarra();};l.append(c);li.prepend(l);}
      li.append(nodo('small',`${estadoTexto(p)}${esRopa(p)?'':` · ${nombreEstado(p.estado_fisico)}`}`));
      if(puedeEditar){if(p.estado_analisis==='error')li.append(boton('Reintentar',()=>accion(p,'analizar')));else if(gemela(p))li.append(boton('Sumar a la existente',()=>fusionar(p,gemela(p))));}
      lista.append(li);
    }
    if(!visibles.length){const todoAlDia=filtro.estado==='revisar'&&!filtro.busca;lista.append(vacio(todoAlDia?'✓ Todo revisado':!piezas.length?'Aún no hay piezas':'Sin resultados',todoAlDia?boton('Ver todas',()=>{filtro.estado='todas';pintar();}):null));}
    pintarBarra();estadoLista();placeholder.hidden=!visibles.length;
    if(pc()&&!abierta&&visibles[0]){const primera=visibles[0];void abrir(primera).then(()=>{if(abierta===primera)estadoLista();},e=>mensaje(e.message,'error'));}
  }
  function etiquetasFiltro(pendientes=piezas.filter(p=>p.estado_analisis!=='listo'||p.precio<=0).length,errores=piezas.filter(p=>p.estado_analisis==='error').length){
    for(const b of chips.children){b.setAttribute('aria-pressed',String(b.dataset.estado===filtro.estado));b.textContent=({precios:`Precios por revisar · ${precios.n}`,revisar:`Por revisar ${pendientes}`,hoy:'Hoy',error:`Error ${errores}`,todas:'Todas',repetidas:`Repetidas · ${repetidas.size}${siguienteRepetidas?'+':''}`})[b.dataset.estado];}
    chips.querySelector('[data-estado=precios]')?.classList.toggle('con-pendientes',precios.n>0&&filtro.estado!=='precios');
  }
  // Solicitudes de precio (#451): el dueño decide aquí mismo; la fila se queda con «✓ Ahora $X» hasta recargar.
  function pintarPrecios(){
    lista.replaceChildren();placeholder.hidden=true;barra.hidden=true;nota.hidden=true;
    const n=precios.lista.length;
    const encabezado=nodo('li',undefined,'acciones');cuentaPrecios=nodo('b');encabezado.append(cuentaPrecios,boton('Actualizar',cargar));lista.append(encabezado);textoCuenta();
    for(const s of precios.lista){const li=nodo('li',undefined,'fila-precio');li.append(filaSolicitud(ctx,s,{alAbrir:()=>verPieza(s),alResolver:r=>{const p=piezas.find(o=>o.id===s.producto_id);if(p&&r.precio)p.precio=r.precio;}}));lista.append(li);}
    if(!n)lista.append(vacio('✓ Sin precios por revisar',boton('Ver por revisar',()=>{filtro.estado='revisar';pintar();})));
    mensaje(n?`${n} ${n===1?'precio por revisar':'precios por revisar'}`:'Sin precios por revisar');
  }
  let cuentaPrecios;
  const textoCuenta=()=>{if(cuentaPrecios?.isConnected)cuentaPrecios.textContent=precios.n?`${precios.n} ${precios.n===1?'precio por revisar':'precios por revisar'}`:'Nadie ha pedido cambios';};
  // La ficha de Revisar; si la pieza no está en la cola cargada, la ficha de Buscar con el mismo flujo del lector.
  async function verPieza(s){const p=piezas.find(o=>o.id===s.producto_id);if(p)return abrir(p);await ctx.cambiarModo('buscar');$('consulta').value=s.codigo||s.nombre;$('busqueda').requestSubmit();}
  document.addEventListener('precios',()=>{etiquetasFiltro();textoCuenta();});
  function agregarRepetidas(grupos){
    for(const g of grupos){const key=`${g.upc}~${g.estado_fisico}`,previo=repetidas.get(key);if(previo){for(const p of g.piezas)if(!previo.piezas.some(o=>o.id===p.id))previo.piezas.push(p);}else repetidas.set(key,g);}
  }
  async function cargarMasRepetidas(){
    if(cargandoRepetidas||!siguienteRepetidas)return;
    cargandoRepetidas=true;const turno=generacion;
    try{const d=await api('/api/piezas/repetidas?'+new URLSearchParams({cursor:siguienteRepetidas}));if(turno!==generacion)return;agregarRepetidas(d.grupos);siguienteRepetidas=d.siguiente;pintar();}
    finally{cargandoRepetidas=false;}
  }
  function pintarRepetidas(){
    visibles=[];guardarTodo.hidden=true;activos.replaceChildren();barra.hidden=true;placeholder.hidden=true;nota.hidden=true;lista.replaceChildren();
    for(const g of repetidas.values()){
      if(filtro.busca&&!normalizar([g.upc,...g.piezas.flatMap(p=>[p.codigo,p.nombre])].join(' ')).includes(normalizar(/^\d+$/.test(filtro.busca)?normalizarUpc(filtro.busca):filtro.busca)))continue;
      const li=nodo('li',undefined,'grupo-repetidas'),titulo=nodo('h3',`UPC ${g.upc}${g.piezas.every(esRopa)?'':` · ${nombreEstado(g.estado_fisico)}`}`);
      const label=nodo('label','Conservar'),select=nodo('select');
      for(const p of g.piezas){const o=nodo('option',`${p.codigo||'Sin etiqueta'} · ${p.nombre||'Sin nombre'} · ×${p.stock}`);o.value=p.id;select.append(o);}
      select.id=`conservar-${g.upc}-${g.estado_fisico}`;select.value=g.destino_id;select.onchange=()=>{g.destino_id=select.value;pintar();$(select.id)?.focus();};label.append(select);li.append(titulo,label);
      const miembros=nodo('ul',undefined,'lista');
      const destino=g.piezas.find(p=>p.id===g.destino_id)||g.piezas[0];
      for(const p of g.piezas){const fila=resultado(p,()=>abrir(p));
        if(p.id!==destino.id)fila.append(boton(`Juntar en ${destino.codigo||destino.nombre}`,()=>resolverRepetida(p,destino,{...ctx,cerrar:cerrarHoja,upc:g.upc,alTerminar:async()=>{abierta=null;ficha.cerrar();document.body.classList.remove('con-ficha');await cargar();}})));
        miembros.append(fila);
      }
      li.append(miembros);lista.append(li);
    }
    if(!lista.children.length)lista.append(vacio(siguienteRepetidas?'Sigue buscando repetidas':'Sin piezas repetidas'));
    if(siguienteRepetidas){const li=nodo('li');li.append(boton('Cargar más',cargarMasRepetidas));lista.append(li);}
    mensaje(`${repetidas.size}${siguienteRepetidas?'+':''} ${repetidas.size===1&&!siguienteRepetidas?'grupo repetido':'grupos repetidos'}`);
  }
  function estadoLista(){
    const pendientes=piezas.filter(p=>p.estado_analisis!=='listo'||p.precio<=0).length,n=visibles.length,pl=(k,s,p)=>`${k} ${k===1?s:p}`;
    mensaje(!piezas.length?'Aún no hay piezas':filtro.estado==='revisar'?(pendientes?`${pendientes} por revisar`:'Todo revisado'):filtro.estado==='hoy'?`${pl(n,'pieza de hoy','piezas de hoy')}`:filtro.estado==='error'?`${n} con error`:`${pl(n,'pieza','piezas')} · ${pendientes} por revisar`);
  }
  function pintarBarra(){barra.replaceChildren();barra.hidden=!puedeEditar||!seleccion.size;if(barra.hidden)return;barra.append(nodo('span',`${seleccion.size} elegidas`),boton('Guardar',()=>masiva('guardar',piezas.filter(p=>seleccion.has(p.id))),'primario'),boton('Descartar',()=>masiva('descartar',piezas.filter(p=>seleccion.has(p.id))),'peligro'),boton('⋯',()=>{const c=nodo('div',undefined,'formulario');for(const[accion,t]of [['analizar','Reanalizar'],['categoria','Cambiar categoría'],['destino','Cambiar destino'],['fusion','Sumar a existente']])c.append(boton(t,()=>{cerrarHoja();void masiva(accion,piezas.filter(p=>seleccion.has(p.id)));}));hoja('Piezas elegidas',c);}));}
  function filtros(){
    const c=nodo('div',undefined,'formulario');
    for(const[k,tipo,t]of [['dia','date','Día'],['categoria','select','Categoría'],['min','text','Precio desde ($)'],['max','text','Precio hasta ($)'],['sesion','select','Sesión']]){
      const l=nodo('label',t),input=nodo(tipo==='select'?'select':'input');
      if(tipo==='select'){const todas=nodo('option','Todas');todas.value='';input.append(todas);const opciones=k==='categoria'?CATEGORIAS:(sesiones?.sesiones||[]).map(s=>[s.clave,`${diaTienda(s.inicio)} · ${s.quien.split('@')[0]} · ${s.piezas} fotos`]);for(const[v,t]of opciones){const o=nodo('option',t);o.value=v;input.append(o);}}
      else{input.type=tipo;if(k!=='dia')input.inputMode='decimal';}input.value=filtro[k];input.onchange=()=>filtro[k]=input.value;l.append(input);c.append(l);
    }
    c.append(boton('Aplicar filtros',()=>{cerrarHoja();pintar();},'primario'),boton('Quitar filtros',()=>{for(const k of ['dia','categoria','min','max','sesion'])filtro[k]='';cerrarHoja();pintar();}));hoja('Filtros',c);
  }
  async function abrir(p){
    abierta=p;derecha.replaceChildren($('ficha'));await ficha.abrir(p.id);if(abierta!==p)return;
    const pie=nodo('div',undefined,'acciones');pie.append(boton('Compartir',async()=>{await copiarParaMarketplace({img:$('foto'),nombre:p.nombre,precio:p.precio/100});mensaje('Copiado para Marketplace','ok');}));
    if(dueno){const a=nodo('a','Ver precios en Mercado Libre');a.href=enlacePreciosML(p.nombre,p.marca);a.target='_blank';a.rel='noopener noreferrer';pie.append(a);}derecha.append(pie);
    if(puedeEditar)avanzado(p);
  }
  async function destinos(){if(!familias.length){const d=await api('/api/familias');familias=d.familias;montos=d.montos;}return [['etiqueta','Etiqueta individual'],...familias.flatMap(f=>montos.map(p=>[`banda_${f.prefijo}${p}`,`${f.nombre} $${p}`]))];}
  function camposDe(p){return borradores.get(p.id)||{nombre:p.nombre,marca:p.marca||'',talla:p.talla||'',categoria:p.categoria,estado_fisico:p.estado_fisico,precio:String(p.precio/100),precio_lista:p.precio_lista?String(p.precio_lista/100):'',destino:p.destino,stock:String(p.stock),stock_visto:String(p.stock)};}
  function avanzado(p){
    const seccion=nodo('section'),form=nodo('form',undefined,'formulario'),campos=camposDe(p);seccion.append(nodo('h3','Corregir datos'),form);derecha.append(seccion);
    for(const[k,t]of [['nombre','Nombre'],['marca','Marca'],['talla','Talla'],['categoria','Categoría'],['estado_fisico','Estado'],['destino','Destino'],['precio_lista','Precio de lista ($)'],['precio','Precio de venta ($)'],['stock','Existencia']]){
      if((k==='precio'||k==='precio_lista')&&p.codigo&&!dueno)continue;
      if(ocultoEnListo(p,k))continue;
      const l=nodo('label',t),input=nodo(['categoria','estado_fisico','destino'].includes(k)?'select':'input');
      const poner=opciones=>{for(const[v,t]of opciones){const o=nodo('option',t);o.value=v;input.append(o);}input.value=campos[k];};
      if(k==='categoria')poner(CATEGORIAS);else if(k==='estado_fisico')poner(ESTADOS);else if(k==='destino'){poner([[p.destino,p.destino==='etiqueta'?'Etiqueta individual':p.destino]]);void destinos().then(d=>{input.replaceChildren();poner(d);}).catch(e=>mensaje(e.message,'error'));}
      else if(k==='stock'){input.type='number';input.min=0;input.max=999;input.step=1;input.inputMode='numeric';input.value=campos[k];}
      else{input.value=campos[k];input.maxLength=k==='nombre'?120:k==='marca'?60:k==='talla'?30:12;}
      input.oninput=()=>{campos[k]=input.value;borradores.set(p.id,campos);if(k==='categoria')actualizarGrado();};input.onchange=input.oninput;l.append(input);form.append(l);
      if(k==='estado_fisico')l.dataset.grado='';
    }
    function actualizarGrado(){form.querySelector('[data-grado]').hidden=esRopa(campos);}
    actualizarGrado();
    form.onsubmit=e=>e.preventDefault();
    form.append(boton('Guardar cambios',()=>guardar(p,campos),'primario'));
    const acciones=nodo('div',undefined,'acciones');
    if(dueno||!p.codigo)acciones.append(boton('Recalcular precio',async()=>{if(await confirmar('Recalcular con la configuración vigente'))await guardar(p,campos,true);}));
    acciones.append(boton('Reintentar análisis',()=>accion(p,'analizar')),boton('Sumar a existente',()=>elegirFusion(p)),boton('Descartar',()=>accion(p,'descartar'),'peligro'),boton('Buscar imagen',()=>buscarImagen(p)));
    form.append(acciones);void recorte(p,form);
  }
  async function guardar(p,campos=camposDe(p),recalcular=false){
    const r=cuerpoRevision(p,campos,dueno,recalcular);if(r.error)throw new Error(r.error);
    const e=existenciaNueva(p,campos),audita=e&&p.estado_analisis==='listo';
    const datos=await api(`/api/borradores/${p.id}`,r.cuerpo,'PATCH');Object.assign(p,datos,{estado_analisis:'listo'});borradores.delete(p.id);
    // Una pieza `listo` ya es vendible: su existencia se fija por el ajuste auditado con la que se vio (`esperado`), igual que en la ficha.
    let aviso;if(audita)try{p.stock=(await api(`/api/piezas/${p.id}/existencia`,{id:crypto.randomUUID(),fijar_a:e.valor,esperado:e.esperado,motivo:'correccion'})).despues;}catch(x){aviso=x.status===409?'Datos guardados, pero la existencia cambió desde que abriste la pieza (venta, apartado o ajuste). Revísala y corrígela de nuevo.':x.status===403?'Datos guardados, pero tu cuenta no puede ajustar la existencia.':`Datos guardados, pero la existencia no cambió: ${x.message}`;}
    if(aviso){if(abierta?.id===p.id)await abrir(p);throw new Error(aviso);}
    mensaje('Cambios guardados','ok');if(abierta?.id===p.id)await abrir(p);return datos;
  }
  async function accion(p,accion,confirmada=false){
    if(!puedeEditar)return;
    if(accion==='descartar'&&!confirmada&&!await confirmar('¿Descartar esta pieza? No se deshace.'))return;
    await api(`/api/borradores/${p.id}${accion==='analizar'?'/analizar':''}`,{},accion==='analizar'?'POST':'DELETE');
    if(accion==='analizar'){p.estado_analisis='pendiente';clearTimeout(temporizador);temporizador=setTimeout(cargar,6000);}else{piezas=piezas.filter(o=>o.id!==p.id);seleccion.delete(p.id);if(abierta?.id===p.id){ficha.cerrar();derecha.replaceChildren($('ficha'),placeholder);abierta=null;document.body.classList.remove('con-ficha');}}
    pintar();
  }
  async function fusionar(p,destino){
    if(!puedeEditar||!await confirmar(`Sumar ${p.stock} piezas a ${destino.nombre} (${destino.stock})`))return;
    const datos=await api(`/api/borradores/${p.id}/fusionar`,{destino_id:destino.id});destino.stock=datos.stock;seleccion.delete(p.id);if(abierta?.id===p.id){ficha.cerrar();abierta=null;document.body.classList.remove('con-ficha');}await cargar();
  }
  function elegirFusion(p){
    const c=nodo('form'),l=nodo('label','Código o nombre existente'),input=nodo('input'),lista=nodo('ul',undefined,'lista');l.append(input);c.append(l,boton('Buscar',async()=>{const d=await api('/api/piezas?'+new URLSearchParams({q:input.value}));lista.replaceChildren(...d.piezas.filter(o=>o.id!==p.id).map(o=>resultado(o,async()=>{cerrarHoja();await fusionar(p,o);})));}),lista);c.onsubmit=e=>e.preventDefault();hoja('Sumar a existente',c);
  }
  async function masiva(accion,elegidas){
    if(!puedeEditar||ocupada||!elegidas.length)return;
    if(accion==='fusion'){if(elegidas.length!==1)return mensaje('Elige una pieza para sumar','aviso');return elegirFusion(elegidas[0]);}
    let campo,valor;
    if(accion==='categoria'||accion==='destino'){
      campo=accion;const opciones=accion==='categoria'?CATEGORIAS:await destinos();
      valor=await new Promise(resolve=>{const c=nodo('div',undefined,'formulario'),select=nodo('select');select.setAttribute('aria-label',accion==='categoria'?'Categoría':'Destino');for(const[v,t]of opciones){const o=nodo('option',t);o.value=v;select.append(o);}c.append(select,boton('Aplicar',()=>{resolve(select.value);cerrarHoja();},'primario'));hoja('Cambiar '+accion,c);$('hoja').addEventListener('close',()=>resolve(null),{once:true});});if(valor===null)return;
    }
    if(!await confirmar(`${accion==='descartar'?'¿Descartar':accion==='analizar'?'Reanalizar':'Guardar'} ${elegidas.length} piezas${accion==='descartar'?'? No se deshace.':'.'}`))return;
    ocupada=true;let hechas=0;const fallidas=[];
    try{for(const p of elegidas){try{mensaje(`Guardando ${hechas+1}/${elegidas.length}…`);if(accion==='analizar'||accion==='descartar')await accionIndividual(p,accion);else await guardar(p,{...camposDe(p),...(campo?{[campo]:valor}:{})});hechas++;seleccion.delete(p.id);}catch(e){fallidas.push(p.id);mensaje(e.message,'error');}}await cargar();for(const id of fallidas)seleccion.add(id);pintarBarra();mensaje(fallidas.length?`Guardadas ${hechas} · fallaron ${fallidas.length}`:`Guardadas ${hechas}`,fallidas.length?'aviso':'ok');}finally{ocupada=false;}
  }
  const accionIndividual=(p,a)=>accion(p,a,true);
  async function buscarImagen(p){
    const d=await api(`/api/borradores/${p.id}/imagen/buscar`,{});const c=nodo('div',undefined,'formulario');
    for(const candidata of d.candidatas){const img=nodo('img');img.src=candidata.imagen;img.alt=candidata.titulo;img.referrerPolicy='no-referrer';const a=nodo('a',candidata.titulo);a.href=candidata.pagina;a.target='_blank';a.rel='noopener noreferrer';c.append(img,a,boton('Usar esta',async()=>{await api(`/api/borradores/${p.id}/imagen`,{imagen:candidata.imagen},'PUT');cerrarHoja();await abrir(p);mensaje('Foto guardada','ok');},'primario'));}if(!d.candidatas.length)c.append(nodo('p','Sin imágenes · toma foto'));hoja('Confirmar imagen',c);
  }
  async function recorte(p,contenedor){
    try{const d=await api('/api/recortes');if(abierta!==p)return;const r=d.find(x=>x.id===p.id);if(!r)return;
      const c=nodo('div'),par=nodo('div',undefined,'recorte-par');for(const[src,t]of [[`/api/foto/${p.id}`,'Foto original'],[`/api/recortes/${p.id}/imagen`,'Recorte']]){const img=nodo('img');img.src=src;img.alt=t;par.append(img);}c.append(nodo('h3','Recorte'),par,nodo('p',r.recorte_estado==='error'?'■ Con error':r.recorte_revision==='ok'?'✓ Aprobado':'▲ Revisa el recorte'));
      if(puedeEditar)for(const[accion,t]of [['aprobar','El recorte está bien'],['reintentar','Reintentar recorte'],['original','Usar foto original']])c.append(boton(t,async()=>{await api(`/api/recortes/${p.id}/${accion}`,{});await abrir(p);mensaje('Recorte actualizado','ok');}));contenedor.append(c);
    }catch(e){if(e.status!==403&&e.status!==404)mensaje(e.message,'aviso');}
  }
  lista.addEventListener('keydown',e=>{if(e.target.closest('input,textarea,select'))return;const botones=[...lista.querySelectorAll('.resultado')],i=botones.indexOf(document.activeElement);if(e.ctrlKey&&e.key.toLowerCase()==='a'&&puedeEditar){e.preventDefault();for(const p of visibles)seleccion.add(p.id);pintar();}else if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();botones[Math.min(botones.length-1,Math.max(0,i+(e.key==='ArrowDown'?1:-1)))]?.focus();}else if(e.key===' '&&i>=0&&puedeEditar){e.preventDefault();const p=visibles[i];seleccion.has(p.id)?seleccion.delete(p.id):seleccion.add(p.id);pintarBarra();}});
  return {cerrar(){abierta=null;derecha.replaceChildren($('ficha'),placeholder);},abrir:async()=>{abierta=null;derecha.replaceChildren($('ficha'),placeholder);await cargar();},leer:async codigo=>{filtro.busca=codigo;pintar();const p=(filtro.estado==='repetidas'?[...repetidas.values()].flatMap(g=>g.piezas):visibles).find(p=>p.codigo?.toUpperCase()===codigo.toUpperCase()||Number(p.codigo?.slice(3))===Number(codigo)||(p.upc&&normalizarUpc(p.upc)===normalizarUpc(codigo)));if(p)await abrir(p);else if(!visibles.length){mensaje('Fuera de la cola','aviso');lista.append(boton('Abrir en Buscar',async()=>{await ctx.cambiarModo('buscar');$('consulta').value=codigo;$('busqueda').requestSubmit();}));}},pausar(){++generacion;clearTimeout(temporizador);}};
}
