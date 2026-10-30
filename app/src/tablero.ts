// GET /api/tablero (Issue #610): el tablero de solo lectura de los inversionistas.
// SOLO agregados del mes de la tienda. Nunca nombres, telefonos, correos, tickets, codigos de pieza, motivos de
// cancelacion, sueldos ni una fila por persona. Un grupo de menos de 5 personas no se cuenta (MIN_PERSONAS).
import { lineasNetas } from './netas.ts';
import { GASTOS_DEL_MES } from './gastos.ts';
import { diasEnVentaPorCategoria, hoyTienda, inventarioEnPiso } from './reportes.ts';
import { gananciaDe } from '../public/vender.js';
import { sumarDias } from '../public/graficas.js';

const MIN_PERSONAS = 5;
const MIN_VENTAS_COMPARACION = 10;   // con menos tickets en la semana anterior no se muestra porcentaje
const CACHE_SEGUNDOS = 300;

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// Las ventas se guardan en UTC; el dia de la tienda abre a las 06:00Z. Se filtra con la columna tal cual (indice).
const apertura = (dia: string) => `${dia}T06:00:00.000Z`;
const lunesDe = (dia: string) => sumarDias(dia, -((new Date(`${dia}T00:00:00Z`).getUTCDay() + 6) % 7));
const entre = (dia: string, desde: string, hasta: string) => dia >= desde && dia <= hasta;
const personasVisibles = (n: number) => (n >= MIN_PERSONAS ? n : null);

/** Nomina, renta, publicidad y el resto: la nomina es lo pagado en el mes (pagos y adelantos), sin desglose por persona. */
function agruparGastos(porCategoria: Map<string, number>) {
  const grupos = { nomina: 0, renta: 0, publicidad: 0, otros: 0 };
  for (const [categoria, importe] of porCategoria) {
    if (categoria === 'nomina' || categoria === 'renta' || categoria === 'publicidad') grupos[categoria] += importe;
    else grupos.otros += importe;
  }
  return grupos;
}

export async function calcularTablero(env: Env, ahora = Date.now()) {
  const hoy = hoyTienda(ahora);
  const mes = hoy.slice(0, 7);
  const primero = `${mes}-01`;
  const [anio, numMes] = mes.split('-').map(Number);
  const diasMes = new Date(Date.UTC(anio, numMes, 0)).getUTCDate();
  const siguiente = new Date(Date.UTC(anio, numMes, 1)).toISOString().slice(0, 10);
  const transcurridos = Number(hoy.slice(8));

  // Esta semana (lunes a hoy) contra la anterior al mismo punto: mismo numero de dias, sin comparar media semana con una entera.
  const lunes = lunesDe(hoy);
  const dias = Math.round((Date.parse(hoy) - Date.parse(lunes)) / 86_400_000) + 1;
  const lunesAnterior = sumarDias(lunes, -7);
  const finAnterior = sumarDias(lunesAnterior, dias - 1);
  const desdeDia = lunesAnterior < primero ? lunesAnterior : primero;
  const rango = [apertura(desdeDia), apertura(siguiente)];

  const [porDia, canales, filasRevendedora, ml, gastosFilas, nomina, config, inventario, diasEnVenta, clientes] = await Promise.all([
    env.DB.prepare(
      `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
       select substr(datetime(creado_en, '-6 hours'), 1, 10) as dia, count(distinct venta) as tickets, coalesce(sum(neta), 0) as total
       from netas where propietario = 'dolaron' group by dia`,
    ).bind(...rango).all<{ dia: string; tickets: number; total: number }>(),
    env.DB.prepare(
      `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
       select case when v.pedido_id is null then 'tienda' when u.correo is not null then 'revendedoras' else 'whatsapp' end as canal,
         count(distinct n.venta) as tickets, coalesce(sum(n.neta), 0) as total,
         count(distinct case when u.correo is not null then p.vendedora end) as personas
       from netas n join ventas v on v.id = n.venta
         left join pedidos p on p.id = v.pedido_id
         left join usuarios u on u.correo = p.vendedora and (',' || u.roles || ',') like '%,revendedora,%'
       where n.propietario = 'dolaron' group by canal`,
    ).bind(apertura(primero), apertura(siguiente)).all<{ canal: string; tickets: number; total: number; personas: number }>(),
    // Un renglon por ticket de revendedora (solo el subtotal sin envio, sin id): la comision se redondea por ticket como en vender.js.
    env.DB.prepare(
      `select coalesce(sum(l.precio * (l.cantidad - l.cancelada_cantidad)), 0) as subtotal
       from ventas v join pedidos p on p.id = v.pedido_id
         join usuarios u on u.correo = p.vendedora and (',' || u.roles || ',') like '%,revendedora,%'
         left join venta_lineas l on l.venta_id = v.id and l.codigo != 'ENVIO'
       where v.cancelada = 0 and v.creado_en >= ? and v.creado_en < ? group by v.id`,
    ).bind(apertura(primero), apertura(siguiente)).all<{ subtotal: number }>(),
    // Mercado Libre no guarda precio de la orden: estimado con el precio publicado. No entra en `ventas`.
    env.DB.prepare(
      `select coalesce(sum(m.cantidad), 0) as piezas, coalesce(sum(m.cantidad * coalesce(pub.precio_ml, 0)), 0) as total
       from ml_ventas m join productos p on p.id = m.producto_id
         left join ml_publicaciones pub on pub.producto_id = m.producto_id
       where m.estado != 'cancelada' and p.propietario = 'dolaron' and m.recibido_en >= ? and m.recibido_en < ?`,
    ).bind(apertura(primero), apertura(siguiente)).first<{ piezas: number; total: number }>(),
    env.DB.prepare(`select categoria, sum(importe) as importe from (${GASTOS_DEL_MES}) group by categoria`)
      .bind(primero, siguiente, `${primero}T00:00:00`, `${siguiente}T00:00:00`)
      .all<{ categoria: string; importe: number }>(),
    env.DB.prepare(
      `select coalesce(sum(case tipo when 'adelanto' then importe when 'pago' then -importe else 0 end), 0) as importe
       from nomina_movimientos where fecha >= ? and fecha < ?`,
    ).bind(primero, siguiente).first<{ importe: number }>(),
    env.DB.prepare("select valor from config where clave = 'meta_ventas_mes'").first<{ valor: string }>(),
    inventarioEnPiso(env, ahora),
    diasEnVentaPorCategoria(env),
    env.DB.prepare(
      `select (select count(*) from clientes) as socios,
         (select count(*) from (select cliente_id from ventas where cliente_id is not null and cancelada = 0
            group by cliente_id having count(*) >= 2)) as regresaron`,
    ).first<{ socios: number; regresaron: number }>(),
  ]);

  // --- ventas: mes, semanas y comparacion
  const suma = (desde: string, hasta: string) => porDia.results
    .filter((f) => entre(f.dia, desde, hasta))
    .reduce((s, f) => ({ total: s.total + f.total, tickets: s.tickets + f.tickets }), { total: 0, tickets: 0 });
  const delMes = suma(primero, sumarDias(siguiente, -1));
  const semanas: { desde: string; hasta: string; total: number; tickets: number; actual: boolean }[] = [];
  for (let inicio = lunesDe(primero); inicio <= hoy; inicio = sumarDias(inicio, 7)) {
    const fin = sumarDias(inicio, 6);
    const recorte = { desde: inicio < primero ? primero : inicio, hasta: fin > hoy ? hoy : fin };
    semanas.push({ ...recorte, ...suma(recorte.desde, recorte.hasta), actual: inicio === lunes });
  }
  const semanaActual = suma(lunes, hoy);
  const semanaAnterior = suma(lunesAnterior, finAnterior);

  // --- meta y ritmo (null sin meta o con 0)
  const metaCruda = Number(config?.valor);
  const meta = Number.isSafeInteger(metaCruda) && metaCruda > 0 ? metaCruda : null;
  const ritmo = meta === null ? null : Math.round(meta * transcurridos / diasMes);

  // --- gastos del mes (una sola vez cada gasto de caja) + nomina
  const porCategoria = new Map(gastosFilas.results.map((f) => [f.categoria, f.importe]));
  if (nomina?.importe) porCategoria.set('nomina', (porCategoria.get('nomina') ?? 0) + nomina.importe);
  const gastosTotal = [...porCategoria.values()].reduce((s, v) => s + v, 0);
  const grupos = agruparGastos(porCategoria);

  // --- canales
  const canal = (clave: string) => canales.results.find((f) => f.canal === clave);
  const comision = filasRevendedora.results.reduce((s, f) => s + gananciaDe({ estado: 'vendido', subtotal: f.subtotal }), 0);
  const revendedoras = canal('revendedoras');
  const revendedorasVisibles = personasVisibles(revendedoras?.personas ?? 0) !== null;

  // --- inventario: solo agregados (sin la lista de piezas mas viejas)
  const semanasDeInventario = transcurridos >= 7 && delMes.total > 0
    ? Math.round(inventario.valor / (delMes.total / (transcurridos / 7))) : null;

  const socios = clientes?.socios ?? 0;
  return {
    generado_en: new Date(ahora).toISOString(),
    mes: { clave: mes, dias: diasMes, transcurridos, hoy },
    ventas: {
      total: delMes.total,
      tickets: delMes.tickets,
      ticket_promedio: delMes.tickets ? Math.round(delMes.total / delMes.tickets) : 0,
      semanas,
      semana: {
        actual: semanaActual, anterior: semanaAnterior, dias,
        poca_historia: semanaAnterior.tickets < MIN_VENTAS_COMPARACION,
      },
    },
    meta: meta === null ? null : {
      monto: meta,
      avance_pct: Math.round(delMes.total * 100 / meta),
      ritmo_monto: ritmo,
      ritmo_pct: Math.round(transcurridos * 100 / diasMes),
      estado: delMes.total >= ritmo! ? 'arriba' : 'abajo',
    },
    gastos: {
      total: gastosTotal,
      por_categoria: [
        { categoria: 'nomina', importe: grupos.nomina }, { categoria: 'renta', importe: grupos.renta },
        { categoria: 'otros', importe: grupos.otros }, { categoria: 'publicidad', importe: grupos.publicidad },
      ],
    },
    ventas_menos_gastos: delMes.total - gastosTotal,
    inventario: {
      piezas: inventario.unidades,
      valor: inventario.valor,
      semanas_de_inventario: semanasDeInventario,
      por_antiguedad: inventario.por_antiguedad,
      sin_fecha: inventario.sin_fecha,
      por_categoria: inventario.por_categoria,
    },
    dias_en_venta: diasEnVenta.map(({ categoria, dias_promedio, n }) => ({ categoria, dias_promedio, n })),
    canales: {
      tienda: { total: canal('tienda')?.total ?? 0, tickets: canal('tienda')?.tickets ?? 0 },
      // Con menos de 5 revendedoras su venta y comision son casi el pago de una persona: van sumadas a WhatsApp.
      whatsapp: {
        total: (canal('whatsapp')?.total ?? 0) + (revendedorasVisibles ? 0 : revendedoras?.total ?? 0),
        tickets: (canal('whatsapp')?.tickets ?? 0) + (revendedorasVisibles ? 0 : revendedoras?.tickets ?? 0),
        incluye_revendedoras: !revendedorasVisibles,
      },
      revendedoras: revendedorasVisibles
        ? { total: revendedoras?.total ?? 0, tickets: revendedoras?.tickets ?? 0, comision, personas: revendedoras!.personas }
        : null,
      mercado_libre: { estimado: true, total: ml?.total ?? 0, piezas: ml?.piezas ?? 0 },
    },
    clientes: {
      socios: personasVisibles(socios),
      regresaron_pct: socios >= MIN_PERSONAS ? Math.round((clientes?.regresaron ?? 0) * 100 / socios) : null,
    },
    publicidad: {
      gasto: grupos.publicidad,
      ventas_por_peso: grupos.publicidad > 0 ? Math.round(delMes.total / grupos.publicidad) : null,
    },
  };
}

/** GET /api/tablero: el JSON se calcula a lo mas cada 5 min por centro de datos; el navegador nunca lo guarda. */
export async function rutaTablero(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Metodo no permitido.' }, 405);
  // Sin `caches` (pruebas locales) se calcula siempre.
  const cache = typeof caches === 'undefined' ? null : (caches as unknown as { default: Cache }).default;
  // La cache es de la zona: sandbox y prod comparten viste.com.mx, asi que la llave lleva el host.
  const llave = new Request(`${new URL(request.url).origin}/api/tablero/cache-v1`);
  const guardado = await cache?.match(llave).catch(() => undefined);
  if (guardado) return json(await guardado.json());
  const cuerpo = await calcularTablero(env);
  if (cache) {
    ctx.waitUntil(cache.put(llave, new Response(JSON.stringify(cuerpo), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CACHE_SEGUNDOS}` },
    })).catch(() => undefined));
  }
  return json(cuerpo);
}
