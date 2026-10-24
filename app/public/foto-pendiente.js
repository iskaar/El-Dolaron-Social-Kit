/** Registros de eldolaron v1/pendientes: los mismos campos que /captura y /escanear. */
export function registroFoto(foto, { id = crypto.randomUUID(), estado_fisico = 'nuevo', cantidad = 1, upc, talla = null, prenda = '', marca = '', precio_ropa = null, nombre_edit, precio_edit }, creado = Date.now()) {
  return { id, foto, estado_fisico, cantidad, creado, talla, prenda, marca, precio_ropa,
    ...(upc != null ? { upc, desde_escaner:true } : {}),
    // Edición de la tarjeta del manifiesto (#461): ausente = valores del manifiesto; el servidor la autoriza.
    ...(nombre_edit != null ? { nombre_edit } : {}), ...(precio_edit != null ? { precio_edit } : {}) };
}
export function formularioPendiente(registro) {
  const f = new FormData();
  f.set('id',registro.id);f.set('estado_fisico',registro.estado_fisico);f.set('cantidad',String(registro.cantidad??1));
  for(const campo of ['upc','talla','prenda','marca','precio_ropa'])if(registro[campo]!=null&&(campo==='upc'||campo==='precio_ropa'||registro[campo]))f.set(campo,String(registro[campo]));
  if(registro.nombre_edit!=null)f.set('nombre',String(registro.nombre_edit));if(registro.precio_edit!=null)f.set('precio',String(registro.precio_edit));
  f.set('foto',registro.foto,`${registro.id}.jpg`);return f;
}

/** Conserva foto y corrección ante cualquier fallo; una versión en vuelo nunca borra la más nueva. */
export function crearSubida({ pendientes, leer, borrar, enviar = fetch, pausada = () => false, alSubir = () => {}, alEstado = () => {} }) {
  let ocupada=false,idSubiendo=null;
  return { id:()=>idSubiendo, async subir(){
    if(ocupada)return;ocupada=true;let cambiada=false;
    try{for(const entrada of await pendientes()){
      const r=await leer(entrada.id);if(!r||pausada(r.id))continue;idSubiendo=r.id;alEstado('subiendo',r);
      try{
        const respuesta=await enviar('/api/borradores',{method:'POST',body:formularioPendiente(r)});
        if(!respuesta.ok){const sesion=respuesta.status===401||respuesta.status===403;alEstado(sesion?'sesion':'error',r);if(sesion||respuesta.status>=500||respuesta.status===408||respuesta.status===429)break;continue;} // ponytail: otro 4xx deja la foto en la cola sin bloquear a las demás
        const guardada=await respuesta.json();
        if(r.correccion_ficha&&guardada.estado_analisis!=='descartado'){
          const correccion=await enviar(`/api/borradores/${r.id}/revision`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(r.correccion_ficha)});
          if(!correccion.ok){alEstado('error',r);break;}Object.assign(guardada,await correccion.json());
        }
        const actual=await leer(r.id);if(actual&&(actual.version??0)!==(r.version??0)){cambiada=true;continue;}
        await borrar(r.id);await alSubir(r,guardada);
      }catch{alEstado('error',r);break;}
    }}finally{ocupada=false;idSubiendo=null;}
    return cambiada;
  }};
}
