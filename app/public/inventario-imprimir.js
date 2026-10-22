import { iniciarEtiquetas } from './imprimir-lote.js';
import { estadoEnvio } from './envio-etiquetas.js';
import { conectarEtiquetera, etiqueteraLista, imprimirBanda, detenerEnvio, historialTexto, desmarcarDesde } from './etiquetera.js';
import { semanaIngreso } from './semana.js';
import { stepper, bloquear, cerrarHoja } from './inventario-ui.js';

export async function iniciar(ctx) {
  const { $, nodo, boton, mensaje, hoja, api, pesos, dueno, foco } = ctx;
  const raiz = $('modo-imprimir'); raiz.replaceChildren();
  const pestanas = nodo('div', undefined, 'segmentado'); pestanas.setAttribute('role','tablist'); pestanas.setAttribute('aria-label','Tipo de impresión');
  const etiquetas = nodo('section'), bandas = nodo('section'); etiquetas.id = 'panel-etiquetas'; bandas.id = 'panel-bandas'; bandas.hidden = true;
  const et = boton('Etiquetas', () => elegir(false)), ba = boton('Bandas', () => elegir(true));
  for (const [b,id,panel] of [[et,'tab-etiquetas',etiquetas],[ba,'tab-bandas',bandas]]) { b.id=id;b.setAttribute('role','tab');b.setAttribute('aria-controls',panel.id);panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',id); }
  function elegir(b) { etiquetas.hidden=b;bandas.hidden=!b;et.setAttribute('aria-selected',String(!b));ba.setAttribute('aria-selected',String(b));et.tabIndex=b?-1:0;ba.tabIndex=b?0:-1; }
  elegir(false); pestanas.append(et,ba); if(ctx.identidad.usuario?.roles.includes('finanzas')) ba.hidden=true;
  pestanas.onkeydown=(e)=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();elegir(bandas.hidden);}};
  const conectar = boton('Conectar impresora', async()=>{await motor.conexion(false);actualizarConexion();},'primario'); conectar.id='conectar-impresora';
  const avisoConexion=nodo('div',undefined,'tarjeta conexion-aviso');avisoConexion.append(conectar);
  const lista=nodo('ul',undefined,'lista');lista.id='lista';
  const barra=nodo('div',undefined,'acciones-fijas');const seleccion=nodo('span','');
  const imprimir=nodo('button','Imprimir seleccionadas'); imprimir.type='button'; imprimir.id='imprimir';imprimir.className='primario';
  // Los botones que opera el motor comparten su contrato con la página anterior.
  const operaciones=nodo('div');operaciones.hidden=true;
  for(const id of ['automatica','nueva-sesion','todas','ninguna','marcar','ver-impresas','otra','detener']){const b=boton(id,()=>{});b.id=id;operaciones.append(b);}
  const resumen=nodo('span');resumen.id='resumen';resumen.hidden=true;
  const historial=nodo('pre');historial.id='historial';historial.hidden=true;
  const estado=nodo('span');estado.id='impresora-estado';estado.hidden=true;
  const ayuda=nodo('span');ayuda.id='ayuda-automatica';ayuda.hidden=true;
  const filtro=nodo('input');filtro.id='buscar-codigo';filtro.type='search';filtro.hidden=true;
  const mostrar=boton('Mostrar impresas',()=>motorBoton('ver-impresas').click());mostrar.setAttribute('role','switch');mostrar.setAttribute('aria-checked','false');
  const todas=boton('Todas',()=>{motorBoton('todas').click();contar();});
  const menu=boton('⋯',()=>{
    const c=nodo('div',undefined,'formulario');
    c.append(boton('Marcar como impresas',()=>{motorBoton('marcar').click();cerrarHoja();}),boton('Historial de envíos',()=>hoja('Historial de envíos',nodo('pre',historialTexto()))));
    hoja('Etiquetas',c);
  });menu.setAttribute('aria-label','Acciones de etiquetas');
  const controles=nodo('div',undefined,'acciones');controles.append(todas,mostrar,menu);
  barra.append(seleccion,imprimir,boton('Detener',()=>motorBoton('detener').click(),'peligro'));
  etiquetas.append(avisoConexion,controles,lista,barra,operaciones,resumen,historial,estado,ayuda,filtro);raiz.append(pestanas,etiquetas,bandas);
  const motorBoton=(id)=>raiz.querySelector('#'+id);
  // Solo el nodo visual de estado anuncia: el motor conserva sus mensajes y sus controles.
  Object.defineProperty(resumen,'textContent',{get(){return this._texto||'';},set(t){this._texto=t;mensaje(t,/fall|error|cort|detuvo|incierto|desconect/i.test(t)?'aviso':/enviad/i.test(t)?'etiqueta':'neutro');}});
  let elegidas=[];
  function contar(){elegidas=[...lista.querySelectorAll('input[type=checkbox]:checked')];const n=elegidas.reduce((n,c)=>n+Number(lista.querySelector(`.copias[data-id="${c.value}"]`)?.value||1),0);seleccion.textContent=`${elegidas.length} elegidas · ${n} etiquetas`;imprimir.textContent=`Imprimir ${n} etiquetas`;bloquear(imprimir,!etiqueteraLista()?'Conecta la impresora':!n?'Elige piezas':'');}
  const vista={pintar({ piezas, hechas, pendientes, visibles, filtroCodigo, desmarcadas, idDudoso, copiasDe }){
    mostrar.setAttribute('aria-checked',String(visibles.length>pendientes.length));lista.replaceChildren();
    const filtro=filtroCodigo.trim().toUpperCase();
    const filtradas=visibles.filter(p=>!filtro||(p.codigo||'').toUpperCase().startsWith(filtro)||(/^\d+$/.test(filtro)&&Number(p.codigo?.slice(3))===Number(filtro)));
    for(const p of filtradas){
      const li=nodo('li',undefined,'fila-etiqueta'); const marca=hechas[p.id], vigente=estadoEnvio(p).vigente;
      li.classList.toggle('impresa',vigente);
      const label=nodo('label',undefined,'casilla'),check=nodo('input');check.type='checkbox';check.value=p.id;check.checked=!vigente&&!desmarcadas.has(p.id);check.setAttribute('aria-label',`Elegir ${p.nombre}`);label.append(check);
      const imagen=nodo('img');imagen.src=`/api/foto/${p.id}`;imagen.alt='';imagen.loading='lazy';imagen.onerror=()=>{imagen.hidden=true;};
      const texto=nodo('div');texto.append(nodo('b',p.nombre),nodo('div',p.codigo||'Sin código','codigo'),nodo('strong',pesos(p.precio),'precio'));
      const estado=nodo('small',p.id===idDudoso?'▲ Envío incierto':vigente?'✓ Salió':marca?`↻ La pegada dice ${pesos(marca.precio)}`:'Nueva');texto.append(estado);
      if(vigente)texto.append(boton('No salió desde aquí',()=>{desmarcarDesde(p.id);motor.pintar();}));
      const copia=stepper(copiasDe(p),contar,{nombre:'Copias'});const output=copia.querySelector('output');output.className='copias';output.dataset.id=p.id;output.value=String(copiasDe(p));
      li.append(label,imagen,texto,copia);lista.append(li);
    }
    if(!filtradas.length)lista.append(nodo('li','Nada por imprimir','vacio'));
    contar();actualizarConexion();
  }};
  // En el host de captura no hay lista general ni automática; las fichas ofrecen consulta.
  const motor=ctx.identidad.vendedor?null:await iniciarEtiquetas(raiz,vista);
  lista.addEventListener('change',contar);lista.addEventListener('click',()=>queueMicrotask(contar));
  async function conexion(){
    const c=nodo('div',undefined,'formulario');
    if(!navigator.bluetooth)c.append(nodo('p','Este navegador no imprime. Usa Chrome o Edge.'));
    else c.append(boton('Conectar impresora',async()=>{await motor.conexion(false);actualizarConexion();cerrarHoja();},'primario'),boton('¿No aparece?',async()=>{await motor.conexion(true);actualizarConexion();cerrarHoja();}));
    if(motor){const auto=boton('Automática',async()=>{await motor.iniciarAutomatica();auto.setAttribute('aria-checked',String(motor.activa()));});auto.setAttribute('role','switch');auto.setAttribute('aria-checked',String(motor.activa()));c.append(auto,boton('Nueva sesión',()=>motorBoton('nueva-sesion').click()));}
    c.append(boton('Detener',()=>{motor?.pausarAutomatica();detenerEnvio();},'peligro'));hoja('Impresora',c);
  }
  function actualizarConexion(){const lista=etiqueteraLista();$('chip-impresora').textContent=lista?'● Impresora · Lista':'▲ Sin conectar';$('chip-impresora').classList.toggle('aviso',!lista);avisoConexion.hidden=lista;}
  setInterval(actualizarConexion,2000);
  let familiaElegida, cantidad=20;
  async function cargarBandas(elegir){
    const {familias,montos}=await api('/api/familias');bandas.replaceChildren();
    const chips=nodo('div',undefined,'chips');familiaElegida=familias.find(f=>f.prefijo===(elegir||localStorage.getItem('bandas-familia')))||familias[0];
    const rejilla=nodo('div',undefined,'rejilla-bandas');
    function pintarFamilia(f){familiaElegida=f;localStorage.setItem('bandas-familia',f.prefijo);for(const b of chips.children)b.setAttribute('aria-pressed',String(b.dataset.prefijo===f.prefijo));rejilla.replaceChildren();for(const monto of montos){const codigo=f.prefijo.toUpperCase()+monto;const b=boton('',async()=>{if(!etiqueteraLista())return conexion();detenerEnvio(false);const n=cantidad;mensaje(`Enviando ${n} de ${codigo}`);const ok=await imprimirBanda({familia:f.nombre,precioPesos:monto,codigo,semana:semanaIngreso(new Date())},n,(hechas)=>mensaje(`Enviando ${hechas}/${n}`),(s)=>mensaje(`Pausa de ${s} s`,'aviso'));if(ok){b.append(nodo('small',`✓ ${n}`));mensaje(`Enviadas ${n} etiquetas`,'etiqueta');}else mensaje('Se cortó la impresora','error');});b.append(nodo('strong',`$${monto}`,'precio'),nodo('code',codigo));rejilla.append(b);}}
    for(const f of familias){const b=boton(f.nombre,()=>pintarFamilia(f));b.dataset.prefijo=f.prefijo;chips.append(b);}
    bandas.append(chips,nodo('h3','Cantidad por banda'),stepper(cantidad,n=>cantidad=n,{max:200,nombre:'Cantidad por banda'}),rejilla);
    if(familiaElegida)pintarFamilia(familiaElegida);else bandas.append(nodo('p','Aún no hay familias'));
    if(dueno)bandas.append(boton('Crear familia',()=>{const c=nodo('form'),l=nodo('label','Nombre de familia'),input=nodo('input');input.maxLength=24;l.append(input);c.append(l,boton('Crear familia',async()=>{const f=await api('/api/familias',{nombre:input.value});await cargarBandas(f.prefijo);cerrarHoja();},'primario'));c.onsubmit=e=>e.preventDefault();hoja('Crear familia',c);}));
  }
  if(!ctx.identidad.vendedor&&!ctx.identidad.usuario?.roles.includes('finanzas'))await cargarBandas();
  async function imprimirPiezas(ids,copias=new Map()){
    if(!motor)return mensaje('Imprime desde la computadora','aviso');
    const ok=await motor.imprimir(ids,copias);contar();actualizarConexion();foco();return ok;
  }
  return { conexion, imprimir:imprimirPiezas, abrir:()=>motor?.cargar(), leer:codigo=>{elegir(false);motor?.filtrar(codigo);}, pausar(){} };
}
