/** Visor único 4:3 de captura; no modifica camara.js, que pertenece también a la caja. */
export function crearCamara({ video, alLeer, alEstado = () => {}, puedeLeer = () => true }) {
  let generacion=0,timer,pista,detectando=false;
  function pausar(){++generacion;clearTimeout(timer);video.srcObject?.getTracks().forEach(t=>t.stop());video.srcObject=null;pista=null;}
  return { pausar, pista:()=>pista, async abrir(){
    pausar();const turno=generacion;
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:960},aspectRatio:{ideal:4/3},zoom:true},audio:false});
    if(turno!==generacion||document.hidden){stream.getTracks().forEach(t=>t.stop());return false;}
    video.srcObject=stream;pista=stream.getVideoTracks()[0];await video.play();
    if(turno!==generacion){stream.getTracks().forEach(t=>t.stop());return false;}
    const rango=pista.getCapabilities?.().zoom;
    if(rango&&rango.max>rango.min){const guardado=Number(localStorage.getItem('captura-zoom')??rango.min),zoom=Math.min(rango.max,Math.max(rango.min,guardado));if(pista.getSettings().zoom!==zoom)await pista.applyConstraints({advanced:[{zoom}]}).catch(()=>{});}
    if(turno!==generacion)return false;
    if(document.hidden){pausar();return false;}
    alEstado('lista');
    if(!globalThis.BarcodeDetector)return true;
    let detector;try{detector=new BarcodeDetector({formats:['upc_a','ean_13','ean_8','code_128']});}catch{return true;}
    const vistos=new Map();
    const vigente=()=>turno===generacion&&video.srcObject===stream;
    async function detectar(){
      if(!vigente())return;
      if(!document.hidden&&puedeLeer()&&!detectando){
        detectando=true;
        try{
          const codigos=await detector.detect(video).catch(()=>[]);
          const ahora=Date.now();for(const {rawValue}of codigos){if(!vigente()||document.hidden||!puedeLeer())break;if(ahora-(vistos.get(rawValue)??0)>700)alLeer(rawValue);vistos.set(rawValue,ahora);}
        }finally{detectando=false;}
      }
      if(vigente())timer=setTimeout(detectar,200);
    }
    void detectar();return true;
  }};
}
