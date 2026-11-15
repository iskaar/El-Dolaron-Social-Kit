/**
 * Capturas en /reportes (Issue #802): cuanto se captura, cuanto tarda y quien lo hace.
 * GET /api/reportes/capturas?desde&hasta|dias&pausa=<minutos 2..30, 10>[&tienda=]
 *
 * LA HORA DE UNA CAPTURA. No hay hora de inicio ni de fin: `productos.creado_en` la pone el SERVIDOR (new Date() en el
 * handler) al recibir la peticion, nunca el cliente (la `creado` que el celular guarda en IndexedDB no viaja en el
 * formulario). Por flujo:
 *  - UPC con ficha (POST /api/borradores/upc, JSON, solo con red): la hora es la de «Guardar» (o la del siguiente
 *    escaneo, que guarda la tarjeta anterior). Sin cola: confiable al segundo.
 *  - UPC desconocido (/upc/buscar) y alta manual sin foto: la hora del toque. Confiable.
 *  - Foto (mercancia general, ropa, foto de respaldo del escaner): la hora en que la foto LLEGA. En linea se sube en
 *    seguida y en orden (retraso de unos segundos); sin red la cola de IndexedDB la guarda y, al volver la senal, sube
 *    todo en rafaga, uno tras otro, con la hora de la subida y no la de la toma. No hay forma de saber el retraso.
 *  - «Sumas» (escanear otra vez un UPC que ya existe): no crean pieza; dejan un renglon en conteo_ajustes
 *    (motivo 'entrada', tienda 'soledad') con la hora del servidor. Se usan como evento de la persona, porque sin ellas
 *    el intervalo de quien mezcla piezas nuevas y repetidas saldria inflado.
 *  - El espejo PC-celular (#775) solo guarda un puntero a la tarjeta: no escribe piezas ni cambia horas.
 * Por eso el tiempo de una captura se infiere del intervalo con la captura anterior de la MISMA persona (cuenta):
 *  - mayor que la pausa  -> inicio de sesion: sin tiempo (la pausa no cuenta);
 *  - menor que 5 s en un evento de cola de fotos (sin UPC) o menor que 1 s en cualquier otro -> rafaga de subida:
 *    la captura cuenta pero queda «sin tiempo medible», para que una cola vaciada de golpe no se vea como velocidad;
 *  - en otro caso -> tiempo medido (el intervalo, en segundos).
 * Sin cuenta (`capturado_por` vacio) no se puede separar a las personas: cuenta como captura, sin tiempo.
 * Limite conocido: con red lenta una rafaga puede tener intervalos de 6 a 10 s que pasan por captura rapida.
 *
 * Todo sale de D1 en el momento (nada se precalcula); las medianas se calculan en JS sobre la lista de intervalos
 * (unos miles de renglones por periodo): D1 no tiene mediana y una consulta por persona costaria mas.
 */
import { esTienda } from './cuentas.ts';
import { lunesDe, sumarDias } from './equipo.ts';
import { rangoDe } from './reportes.ts';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

export const PAUSA_OMISION_MIN = 10, PAUSA_MIN = 2, PAUSA_MAX = 30;
export const RAFAGA_FOTO_S = 5, RAFAGA_OTRO_S = 1;
/** Hasta cuantos dias la serie va por dia; mas largo, por semana de lunes a domingo. */
export const MAX_DIAS_POR_DIA = 35;
/** Una correccion cuenta si llega a lo mas 7 dias despues de que la IA llene la pieza: despues son rebajas, no revision. */
export const VENTANA_CORRECCION_DIAS = 7;
/** Una pieza se mide a 14 dias solo si ya tiene 14 dias de edad. */
export const DIAS_VENDIDA = 14;
const HORA_MS = 3_600_000, DIA_MS = 86_400_000;
/** Limites (segundos, el ultimo es abierto) de la distribucion del tiempo por captura. */
export const CORTES_HISTOGRAMA = [30, 60, 90, 120, 180, 300, 600];

/** `pausa=` en minutos enteros, de 2 a 30; vacio o no numerico vale 10. */
export function pausaDe(url: URL): number {
  const n = Math.round(Number(url.searchParams.get('pausa') ?? PAUSA_OMISION_MIN));
  return Number.isFinite(n) ? Math.min(PAUSA_MAX, Math.max(PAUSA_MIN, n)) : PAUSA_OMISION_MIN;
}

/* ---------- el tiempo de cada captura (pura: se prueba sin base) ---------- */

export interface Evento { correo: string; ms: number; /** viene de la cola de fotos: sin UPC */ foto: boolean }
export type Clase = 'medida' | 'rafaga' | 'inicio' | 'sin_autor';
export type Clasificado<T extends Evento> = T & { clase: Clase; seg: number | null };

/**
 * Clasifica cada evento por su intervalo con el anterior de la misma persona (en el orden de llegada; empate de
 * milisegundos: el orden de entrada). Devuelve la misma lista, en el mismo orden, con `clase` y `seg`.
 * `seg` solo existe en las `medida`: el intervalo en segundos, de `rafaga` (excl.) a `pausaS` (incl.).
 */
export function clasificarTiempos<T extends Evento>(eventos: T[], pausaS: number): Clasificado<T>[] {
  const salida = new Array<Clasificado<T>>(eventos.length);
  const previo = new Map<string, number>();
  const orden = eventos.map((e, i) => ({ e, i })).sort((a, b) => a.e.ms - b.e.ms || a.i - b.i);
  for (const { e, i } of orden) {
    let clase: Clase, seg: number | null = null;
    if (!e.correo) clase = 'sin_autor';
    else if (!previo.has(e.correo)) clase = 'inicio';
    else {
      const gap = (e.ms - previo.get(e.correo)!) / 1000;
      if (gap > pausaS) clase = 'inicio';
      else if (gap < (e.foto ? RAFAGA_FOTO_S : RAFAGA_OTRO_S)) clase = 'rafaga';
      else { clase = 'medida'; seg = gap; }
    }
    if (e.correo) previo.set(e.correo, e.ms);
    salida[i] = { ...e, clase, seg };
  }
  return salida;
}

/** Mediana (promedio de las dos de en medio si son pares), a decimas; null sin datos. */
export function mediana(valores: number[]): number | null {
  if (!valores.length) return null;
  const v = [...valores].sort((a, b) => a - b), m = v.length >> 1;
  return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10;
}

/** El dia, la hora y el dia de la semana (0 = domingo) en la tienda (UTC-6 fijo), de un instante. */
export function horaDeTienda(ms: number) {
  const d = new Date(ms - 6 * HORA_MS);
  return { dia: d.toISOString().slice(0, 10), hora: d.getUTCHours(), dia_semana: d.getUTCDay() };
}

/** Cuantos intervalos caen en cada tramo de CORTES_HISTOGRAMA (el ultimo tramo, de 10 min en adelante, es abierto). */
export function histograma(segundos: number[]): { desde: number; hasta: number | null; n: number }[] {
  const limites = [0, ...CORTES_HISTOGRAMA];
  const tramos = limites.map((desde, i) => ({ desde, hasta: i < CORTES_HISTOGRAMA.length ? CORTES_HISTOGRAMA[i] : null, n: 0 }));
  for (const s of segundos) tramos[limites.filter((l) => s >= l).length - 1].n += 1;
  return tramos;
}

/** La nota «desde el 23 oct» de lo que sale de la bitacora de cambios: la fecha es la del primer renglon, calculada de los datos. */
export const notaBitacora = (desde: string | null, diaDesde: string) => desde === null
  ? { desde, dentro_del_periodo: false, sin_datos: true }
  : { desde, dentro_del_periodo: desde > diaDesde, sin_datos: false };

/* ---------- la consulta ---------- */

// Lista para etiquetar (la misma idea que PIEZA_ETIQUETABLE del worker) y sin renglon en etiquetas_enviadas.
const SIN_ETIQUETA = `(p.estado_analisis = 'listo' and p.destino = 'etiqueta' and p.precio > 0 and p.stock > 0 and p.por_revisar = 0
  and trim(p.nombre) <> '' and p.estado_fisico <> 'caducado' and p.creado_en >= (select strftime('%Y-%m-%dT%H:%M:%fZ', date(min(etiqueta_en), '-6 hours') || ' 06:00:00') from etiquetas_enviadas)
  and not exists (select 1 from etiquetas_enviadas e where e.producto_id = p.id))`;

interface Pieza {
  id: string; correo: string; ms: number; tipo: 'upc' | 'ropa' | 'general'; estado: string; etiqueta_ms: number | null;
}
interface Hecho { ia: number | null; ia_listo: number | null; corregida: boolean }

export async function reporteCapturas(url: URL, env: Env, ahora = Date.now()): Promise<Response> {
  const rango = rangoDe(url, ahora);
  const pausa = pausaDe(url);
  const pedida = url.searchParams.get('tienda') ?? '';
  if (pedida && !esTienda(pedida)) return json({ error: 'Tienda invalida.' }, 400);
  const { desde, hasta, anterior_desde: anteriorDesde } = rango;
  const [msDesde, msHasta] = [Date.parse(desde), Date.parse(hasta)];
  const enPeriodo = (ms: number) => ms >= msDesde && ms < msHasta;
  const propias = `p.propietario = 'dolaron' and p.sin_inventario = 0 and p.creado_en >= ? and p.creado_en < ?`;

  const [piezasQ, sumasQ, descartadasQ, hechosQ, ventasQ, nombresQ, primeraBitacoraQ, primeraEtiquetaQ, pendientesQ] = await Promise.all([
    // Las piezas nuevas de este periodo y del anterior (el anterior solo da sus eventos). Las descartadas no son captura.
    env.DB.prepare(
      `select p.id, p.capturado_por as correo, p.creado_en, p.estado_analisis as estado, e.etiqueta_en,
         case when coalesce(p.upc, '') <> '' then 'upc' when p.categoria = 'ropa' then 'ropa' else 'general' end as tipo
       from productos p left join etiquetas_enviadas e on e.producto_id = p.id
       where ${propias} and p.estado_analisis <> 'descartado'`,
    ).bind(anteriorDesde, hasta).all<{ id: string; correo: string; creado_en: string; estado: string; etiqueta_en: string | null; tipo: Pieza['tipo'] }>(),
    // «Sumas»: escanear un UPC que ya existe deja un renglon de entrada, no una pieza.
    env.DB.prepare(
      `select a.ajustado_por as correo, a.ajustado_en as en from conteo_ajustes a join productos p on p.id = a.producto_id
       where a.motivo = 'entrada' and a.tienda = 'soledad' and a.cantidad > 0 and p.propietario = 'dolaron'
         and a.ajustado_en >= ? and a.ajustado_en < ?`,
    ).bind(anteriorDesde, hasta).all<{ correo: string; en: string }>(),
    env.DB.prepare(
      `select p.capturado_por as correo, count(*) as n from productos p
       where ${propias} and p.estado_analisis = 'descartado' group by p.capturado_por`,
    ).bind(desde, hasta).all<{ correo: string; n: number }>(),
    // Una fila por pieza del periodo con renglones en la bitacora: cuando la IA la lleno/la dejo lista y si una persona la corrigio despues.
    env.DB.prepare(
      `select h.producto_id as id, h.ia, h.ia_listo, max(c.id is not null) as corregida from (
         select b.producto_id, min(case when b.por in ('ia', 'cola') then b.en end) as ia,
           min(case when b.por in ('ia', 'cola') and b.campo = 'estado_analisis' and b.despues = 'listo' then b.en end) as ia_listo
         from productos_cambios b where b.producto_id in (select p.id from productos p where ${propias} and p.estado_analisis <> 'descartado')
         group by b.producto_id) h
       left join productos_cambios c on c.producto_id = h.producto_id and c.por like '%@%' and c.campo in ('nombre', 'marca', 'categoria', 'precio')
         and julianday(c.en) > julianday(h.ia) and julianday(c.en) <= julianday(h.ia) + ${VENTANA_CORRECCION_DIAS}
       group by h.producto_id`,
    ).bind(desde, hasta).all<{ id: string; ia: string | null; ia_listo: string | null; corregida: number }>(),
    // La primera venta de cada pieza del periodo, en UNA consulta que arranca por las ventas desde el inicio del periodo
    // (indice ventas_creado, luego venta_lineas_venta y la llave de productos) y por Mercado Libre. Sin subconsulta por pieza.
    // `cross join` fija ese orden: sin el, SQLite arranca por las piezas del periodo y recorre las ventas una vez por pieza.
    env.DB.prepare(
      `select x.producto_id as id, min(x.en) as primera from (
         select l.producto_id, v.creado_en as en from ventas v cross join venta_lineas l on l.venta_id = v.id cross join productos p on p.id = l.producto_id
         where v.creado_en >= ? and v.cancelada = 0 and l.cantidad > l.cancelada_cantidad and ${propias}
         union all
         select m.producto_id, m.recibido_en from ml_ventas m cross join productos p on p.id = m.producto_id
         where m.recibido_en >= ? and m.estado = 'descontada' and m.descontado > 0 and ${propias}) x
       group by x.producto_id`,
    ).bind(desde, desde, hasta, desde, desde, hasta).all<{ id: string; primera: string }>(),
    env.DB.prepare('select correo, nombre from usuarios').all<{ correo: string; nombre: string }>(),
    // El primer renglon de la bitacora (id ascendente = orden cronologico): sin recorrer la tabla.
    env.DB.prepare('select en from productos_cambios order by id limit 1').first<{ en: string }>(),
    env.DB.prepare('select min(etiqueta_en) as en from etiquetas_enviadas').first<{ en: string | null }>(),
    // Lo pendiente AHORA (no depende del periodo), en una pasada. «Sin etiqueta» solo cuenta lo capturado desde el dia en que existe el registro
    // de etiquetas enviadas (`min(etiqueta_en)`), porque antes no se registraba y todo saldria pendiente.
    env.DB.prepare(
      `select sum(p.por_revisar = 1) as rev_n, min(case when p.por_revisar = 1 then p.creado_en end) as rev_vieja,
         sum(p.estado_analisis = 'error') as err_n, min(case when p.estado_analisis = 'error' then p.creado_en end) as err_vieja,
         sum(${SIN_ETIQUETA}) as sin_n, min(case when ${SIN_ETIQUETA} then p.creado_en end) as sin_vieja
       from productos p where p.propietario = 'dolaron' and p.sin_inventario = 0 and p.estado_analisis <> 'descartado'`,
    ).first<{ rev_n: number | null; rev_vieja: string | null; err_n: number | null; err_vieja: string | null; sin_n: number | null; sin_vieja: string | null }>(),
  ]);

  const nombres = new Map(nombresQ.results.map((u) => [u.correo, u.nombre]));
  const nombreDe = (correo: string) => (correo ? nombres.get(correo) || correo : 'Sin atribuir');
  const hechos = new Map<string, Hecho>(hechosQ.results.map((h) => [h.id, {
    ia: h.ia ? Date.parse(h.ia) : null, ia_listo: h.ia_listo ? Date.parse(h.ia_listo) : null, corregida: !!h.corregida,
  }]));
  const primeras = new Map(ventasQ.results.map((v) => [v.id, Date.parse(v.primera)]));
  const piezas: Pieza[] = piezasQ.results.map((p) => ({
    id: p.id, correo: p.correo ?? '', ms: Date.parse(p.creado_en), tipo: p.tipo, estado: p.estado,
    etiqueta_ms: p.etiqueta_en ? Date.parse(p.etiqueta_en) : null,
  }));

  // Los eventos de las dos ventanas, juntos, para que el primero de este periodo se mida contra el ultimo del anterior.
  type Ev = Evento & { pieza: Pieza | null };
  const eventos: Ev[] = [
    ...piezas.map((p) => ({ correo: p.correo, ms: p.ms, foto: p.tipo !== 'upc', pieza: p })),
    ...sumasQ.results.map((s) => ({ correo: s.correo ?? '', ms: Date.parse(s.en), foto: false, pieza: null })),
  ];
  const clasificados = clasificarTiempos(eventos, pausa * 60);
  const actuales = clasificados.filter((e) => enPeriodo(e.ms));
  const previos = clasificados.filter((e) => e.ms >= Date.parse(anteriorDesde) && e.ms < msDesde);

  // Una persona (o «Sin atribuir») por correo.
  const personas = new Map<string, { correo: string; capturas: number; sumas: number; dias: Set<string>; seg: number[]; rafagas: number; inicios: number;
    sin_autor: number; descartadas: number; corregidas: number; base_ia: number; vendidas_14: number; base_14: number }>();
  const persona = (correo: string) => {
    if (!personas.has(correo)) personas.set(correo, { correo, capturas: 0, sumas: 0, dias: new Set(), seg: [], rafagas: 0, inicios: 0, sin_autor: 0,
      descartadas: 0, corregidas: 0, base_ia: 0, vendidas_14: 0, base_14: 0 });
    return personas.get(correo)!;
  };
  const maduras = ahora - DIAS_VENDIDA * DIA_MS;
  for (const e of actuales) {
    const p = persona(e.correo);
    if (e.pieza) { p.capturas += 1; p.dias.add(horaDeTienda(e.ms).dia); } else p.sumas += 1;
    if (e.clase === 'medida') p.seg.push(e.seg!); else if (e.clase === 'rafaga') p.rafagas += 1; else if (e.clase === 'inicio') p.inicios += 1; else p.sin_autor += 1;
  }
  const porPieza = new Map<string, Pieza>();
  for (const e of actuales) if (e.pieza) porPieza.set(e.pieza.id, e.pieza);
  const segDe = new Map<string, number>();   // intervalo medido de cada pieza (para el tiempo por tipo)
  for (const e of actuales) if (e.pieza && e.clase === 'medida') segDe.set(e.pieza.id, e.seg!);
  for (const f of descartadasQ.results) persona(f.correo ?? '').descartadas += f.n;
  for (const pz of porPieza.values()) {
    const p = persona(pz.correo), h = hechos.get(pz.id);
    if (h?.ia != null) { p.base_ia += 1; if (h.corregida) p.corregidas += 1; }
    if (pz.ms <= maduras) { p.base_14 += 1; const v = primeras.get(pz.id); if (v != null && v - pz.ms <= DIAS_VENDIDA * DIA_MS) p.vendidas_14 += 1; }
  }

  const horas = (seg: number[]) => seg.reduce((s, x) => s + x, 0) / 3600;
  const porHora = (n: number, h: number) => (h > 0 ? Math.round((n / h) * 10) / 10 : null);
  const filas = [...personas.values()].map((p) => {
    const h = horas(p.seg);
    return {
      correo: p.correo, nombre: nombreDe(p.correo), capturas: p.capturas, sumas: p.sumas, dias_activos: p.dias.size,
      horas_activas: Math.round(h * 100) / 100, medidas: p.seg.length, piezas_por_hora: porHora(p.seg.length, h), tiempo_mediano_s: mediana(p.seg),
      sin_tiempo: { rafaga: p.rafagas, inicio: p.inicios, sin_autor: p.sin_autor },
      corregidas: { n: p.corregidas, base: p.base_ia }, descartadas: p.descartadas,
      vendidas_14: { n: p.vendidas_14, base: p.base_14 },
    };
  }).filter((p) => p.capturas || p.sumas || p.descartadas)
    .sort((a, b) => b.capturas - a.capturas || a.nombre.localeCompare(b.nombre));

  const segTodos = actuales.filter((e) => e.clase === 'medida').map((e) => e.seg!);
  const diasConCaptura = new Set(actuales.filter((e) => e.pieza).map((e) => horaDeTienda(e.ms).dia));
  const capturas = actuales.filter((e) => e.pieza).length;
  const resumenDe = (lista: typeof clasificados) => {
    const seg = lista.filter((e) => e.clase === 'medida').map((e) => e.seg!), caps = lista.filter((e) => e.pieza).length;
    const dias = new Set(lista.filter((e) => e.pieza).map((e) => horaDeTienda(e.ms).dia)).size, h = horas(seg);
    return { capturas: caps, dias_con_captura: dias, por_dia: dias ? Math.round((caps / dias) * 10) / 10 : null,
      tiempo_mediano_s: mediana(seg), horas_activas: Math.round(h * 100) / 100, piezas_por_hora: porHora(seg.length, h) };
  };
  const delPeriodo = [...porPieza.values()];
  const etiquetadas = delPeriodo.filter((p) => p.etiqueta_ms !== null);
  const bitacoraDesde = primeraBitacoraQ?.en ? horaDeTienda(Date.parse(primeraBitacoraQ.en)).dia : null;
  const etiquetasDesde = primeraEtiquetaQ?.en ? primeraEtiquetaQ.en : null;
  // El registro de etiquetas enviadas arranca un dia: antes no se guardaba, asi que solo se mide lo capturado desde las 00:00 de ese dia.
  const baseEtiquetas = etiquetasDesde ? delPeriodo.filter((p) => p.ms >= Date.parse(`${horaDeTienda(Date.parse(etiquetasDesde)).dia}T06:00:00.000Z`)) : [];
  const conIa = delPeriodo.filter((p) => hechos.get(p.id)?.ia != null);
  const pct = (n: number, base: number) => (base ? Math.round((n / base) * 1000) / 10 : null);
  const mayorQueCero = (xs: number[]) => xs.filter((x) => x >= 0);

  // Cada paso del embudo: cuantas piezas del periodo llegaron y la mediana (segundos) desde el paso anterior.
  const analisis = delPeriodo.filter((p) => hechos.get(p.id)?.ia_listo != null).map((p) => (hechos.get(p.id)!.ia_listo! - p.ms) / 1000);
  const aEtiqueta = etiquetadas.map((p) => (p.etiqueta_ms! - (hechos.get(p.id)?.ia_listo ?? p.ms)) / 1000);
  const captEtiqueta = mayorQueCero(etiquetadas.map((p) => (p.etiqueta_ms! - p.ms) / 1000));
  const vendidas = delPeriodo.filter((p) => primeras.has(p.id));
  const aVenta = mayorQueCero(vendidas.filter((p) => p.etiqueta_ms !== null).map((p) => (primeras.get(p.id)! - p.etiqueta_ms!) / 1000));
  const embudo = [
    { clave: 'capturada', n: capturas, base: capturas, pct: capturas ? 100 : null, mediana_s: null, n_tiempo: 0 },
    { clave: 'analizada', n: delPeriodo.filter((p) => p.estado === 'listo').length, base: capturas,
      pct: pct(delPeriodo.filter((p) => p.estado === 'listo').length, capturas), mediana_s: mediana(analisis), n_tiempo: analisis.length },
    { clave: 'etiquetada', n: baseEtiquetas.filter((p) => p.etiqueta_ms !== null).length, base: baseEtiquetas.length,
      pct: pct(baseEtiquetas.filter((p) => p.etiqueta_ms !== null).length, baseEtiquetas.length), mediana_s: mediana(mayorQueCero(aEtiqueta)), n_tiempo: mayorQueCero(aEtiqueta).length },
    { clave: 'vendida', n: vendidas.length, base: capturas, pct: pct(vendidas.length, capturas), mediana_s: mediana(aVenta), n_tiempo: aVenta.length },
  ];

  const tipos = (['upc', 'general', 'ropa'] as const).map((tipo) => {
    const deTipo = delPeriodo.filter((p) => p.tipo === tipo), ia = deTipo.filter((p) => hechos.get(p.id)?.ia != null);
    const seg = deTipo.filter((p) => segDe.has(p.id)).map((p) => segDe.get(p.id)!);
    return { clave: tipo, capturas: deTipo.length, medidas: seg.length, tiempo_mediano_s: mediana(seg),
      corregidas: { n: ia.filter((p) => hechos.get(p.id)!.corregida).length, base: ia.length } };
  });

  // Serie por dia (hasta 35 dias) o por semana de lunes a domingo, con una columna por cada una, aunque vaya en cero.
  const grano = rango.dias <= MAX_DIAS_POR_DIA ? 'dia' : 'semana';
  const claveDe = (dia: string) => (grano === 'dia' ? dia : lunesDe(dia));
  const serie: { clave: string; desde: string; hasta: string; parcial: boolean; total: number; dias: number; personas: Record<string, number> }[] = [];
  for (let c = claveDe(rango.dia_desde); c <= rango.dia_hasta; c = sumarDias(c, grano === 'dia' ? 1 : 7)) {
    const fin = grano === 'dia' ? c : sumarDias(c, 6);
    const [d, h] = [c < rango.dia_desde ? rango.dia_desde : c, fin > rango.dia_hasta ? rango.dia_hasta : fin];
    serie.push({ clave: c, desde: d, hasta: h, parcial: d !== c || h !== fin, total: 0, dias: 0, personas: {} });
  }
  const columna = new Map(serie.map((s) => [s.clave, s]));
  const porHoraDia = new Map<string, number>();
  const diasDeColumna = new Map<string, Set<string>>();   // dias con captura de cada columna: la minigrafica de «por dia»
  for (const e of actuales) {
    if (!e.pieza) continue;
    const t = horaDeTienda(e.ms), s = columna.get(claveDe(t.dia))!;
    s.total += 1;
    diasDeColumna.set(s.clave, (diasDeColumna.get(s.clave) ?? new Set()).add(t.dia));
    s.personas[e.correo] = (s.personas[e.correo] ?? 0) + 1;
    porHoraDia.set(`${t.dia_semana}-${t.hora}`, (porHoraDia.get(`${t.dia_semana}-${t.hora}`) ?? 0) + 1);
  }
  for (const [clave, dias] of diasDeColumna) columna.get(clave)!.dias = dias.size;
  const semanas = new Map<string, number[]>();
  for (const e of actuales) if (e.clase === 'medida') {
    const lunes = lunesDe(horaDeTienda(e.ms).dia);
    semanas.set(lunes, [...(semanas.get(lunes) ?? []), e.seg!]);
  }
  const tiempoSemanal: { lunes: string; mediana_s: number | null; n: number; piezas_por_hora: number | null }[] = [];
  for (let l = lunesDe(rango.dia_desde); l <= rango.dia_hasta; l = sumarDias(l, 7)) {
    const seg = semanas.get(l) ?? [];
    tiempoSemanal.push({ lunes: l, mediana_s: mediana(seg), n: seg.length, piezas_por_hora: porHora(seg.length, horas(seg)) });
  }

  const viejas = (n: number | null, vieja: string | null) => ({ n: n ?? 0, mas_vieja: vieja });
  return json({
    dias: rango.dias, dia_desde: rango.dia_desde, dia_hasta: rango.dia_hasta, ahora: new Date(ahora).toISOString(),
    pausa_min: pausa, rafaga_foto_s: RAFAGA_FOTO_S, rafaga_otro_s: RAFAGA_OTRO_S, ventana_correccion_dias: VENTANA_CORRECCION_DIAS,
    // Las capturas son de la tienda central: la tienda elegida no filtra nada y la pantalla lo dice.
    tienda: pedida, tienda_ignorada: pedida !== '',
    bitacora: notaBitacora(bitacoraDesde, rango.dia_desde),
    etiquetas: { desde: etiquetasDesde ? horaDeTienda(Date.parse(etiquetasDesde)).dia : null },
    resumen: {
      capturas, sumas: actuales.filter((e) => !e.pieza).length,
      dias_con_captura: diasConCaptura.size, por_dia: diasConCaptura.size ? Math.round((capturas / diasConCaptura.size) * 10) / 10 : null,
      medidas: segTodos.length, tiempo_mediano_s: mediana(segTodos), horas_activas: Math.round(horas(segTodos) * 100) / 100,
      piezas_por_hora: porHora(segTodos.length, horas(segTodos)),
      sin_tiempo: {
        rafaga: actuales.filter((e) => e.clase === 'rafaga').length, inicio: actuales.filter((e) => e.clase === 'inicio').length,
        sin_autor: actuales.filter((e) => e.clase === 'sin_autor').length,
      },
      captura_a_etiqueta_s: mediana(captEtiqueta), captura_a_etiqueta_n: captEtiqueta.length,
      corregidas: { n: conIa.filter((p) => hechos.get(p.id)!.corregida).length, base: conIa.length },
      descartadas: descartadasQ.results.reduce((s, f) => s + f.n, 0),
      vendidas_14: { n: filas.reduce((s, f) => s + f.vendidas_14.n, 0), base: filas.reduce((s, f) => s + f.vendidas_14.base, 0) },
    },
    anterior: resumenDe(previos),
    grano, serie, tiempo_semanal: tiempoSemanal,
    personas: filas,
    histograma: histograma(segTodos),
    por_hora: [...porHoraDia].map(([k, n]) => { const [dia_semana, hora] = k.split('-').map(Number); return { dia_semana, hora, n }; }),
    embudo, tipos,
    pendientes: {
      por_revisar: viejas(pendientesQ?.rev_n ?? 0, pendientesQ?.rev_vieja ?? null),
      sin_etiqueta: viejas(pendientesQ?.sin_n ?? 0, pendientesQ?.sin_vieja ?? null),
      con_error: viejas(pendientesQ?.err_n ?? 0, pendientesQ?.err_vieja ?? null),
    },
  });
}
