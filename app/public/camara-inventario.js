/** Visor único 4:3 de captura; no modifica camara.js, que pertenece también a la caja. */
export function crearCamara({ video, alLeer, alEstado = () => {} }) {
  let generacion=0,timer,pista;
  function pausar(){++generacion;clearTimeout(timer);video.srcObject?.getTracks().forEach(t=>t.stop());video.srcObject=null;pista=null;}
  return { pausar, pista:()=>pista, async abrir(){
    pausar();const turno=generacion;
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},aspectRatio:{ideal:4/3},zoom:true},audio:false});
    if(turno!==generacion||document.hidden){stream.getTracks().forEach(t=>t.stop());return false;}
    video.srcObject=stream;pista=stream.getVideoTracks()[0];await video.play();
    if(turno!==generacion){stream.getTracks().forEach(t=>t.stop());return false;}
    const rango=pista.getCapabilities?.().zoom;
    if(rango&&rango.max>rango.min){const guardado=Number(localStorage.getItem('captura-zoom')??rango.min);await pista.applyConstraints({advanced:[{zoom:Math.min(rango.max,Math.max(rango.min,guardado))}]}).catch(()=>{});}
    alEstado('lista');
    if(!globalThis.BarcodeDetector)return true;
    let detector;try{detector=new BarcodeDetector({formats:['upc_a','ean_13','ean_8']});}catch{return true;}
    const vistos=new Map();
    async function detectar(){
      if(turno!==generacion||video.srcObject!==stream)return;
      const codigos=await detector.detect(video).catch(()=>[]);
      if(turno!==generacion||video.srcObject!==stream)return;
      const ahora=Date.now();for(const {rawValue}of codigos){if(ahora-(vistos.get(rawValue)??0)>700)alLeer(rawValue);vistos.set(rawValue,ahora);}timer=setTimeout(detectar,120);
    }
    void detectar();return true;
  }};
}
