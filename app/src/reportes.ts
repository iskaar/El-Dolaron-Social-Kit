// Consultas de /reportes y los helpers de fecha de la tienda. /tablero (Issue #610) reutiliza lo exportado.
import { lineasNetas } from './netas.ts';
import { tramoDeDias, TRAMOS_ANTIGUEDAD, sumarDias } from '../public/graficas.js';
import { TIENDAS, TIENDA_CENTRAL, cajasDe, esTienda, type Tienda } from './cuentas.ts';
import { sucursales, enCaminoSql, enTiendaSql, existenciaTotalSql } from './existencias.ts';
import { CLAVES_DE_PARTE, PARTES_REPORTE } from '../public/reportes-partes.js';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

// La tienda esta en America/Mexico_City: UTC-6 fijo desde 2022, sin horario de
// verano. Las ventas se guardan en UTC, asi que despues de las 18:00 locales ya
// son "manana" en UTC; el dia de la tienda se saca restando 6 horas. Sin esto,
// el corte de las 20:00 solo veia lo vendido de 18:00 a 20:00 (Issue #93).
export const diaTienda = (columna: string) => `substr(datetime(${columna}, '-6 hours'), 1, 10)`;
export const hoyTienda = (ahora = Date.now()) => new Date(ahora - 6 * 3_600_000).toISOString().slice(0, 10);
export const DIA = /^\d{4}-\d{2}-\d{2}$/;
/**
 * [00:00, 24:00) de un dia de la tienda, en UTC. Para filtrar se compara la columna
 * tal cual: diaTienda() en el WHERE obliga a D1 a leer toda la tabla en cada
 * consulta, y la caja pide el corte del dia seguido (agoto la cuota diaria, 15/10).
 */
export const delDia = (dia: string) => {
  const apertura = (d: string) => `${d}T06:00:00.000Z`;
  return [apertura(dia), apertura(new Date(Date.parse(`${dia}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10))];
};

/** Un `desde`/`hasta` que no se puede atender (#802): el worker lo responde con 400. */
export class RangoInvalido extends Error {}

/**
 * Los dias completos de la tienda de `primero` a `ultimo`, ambos inclusive (Issue #166): el primero empieza a las
 * 00:00 de la tienda, no «hace N x 24 h», para que un dia nunca salga a medias. `desde` abre el rango y `hasta` lo
 * cierra (exclusivo: las 00:00 del dia siguiente), asi un rango pasado no arrastra las ventas de despues.
 * `anterior_desde` abre el periodo de igual largo justo antes, para comparar.
 */
export function rangoEntre(primero: string, ultimo: string) {
  const apertura = (dia: string) => `${dia}T06:00:00.000Z`;   // 00:00 en UTC-6
  const dias = Math.round((Date.parse(`${ultimo}T12:00:00Z`) - Date.parse(`${primero}T12:00:00Z`)) / 86_400_000) + 1;
  return {
    dias, dia_desde: primero, dia_hasta: ultimo, desde: apertura(primero), hasta: apertura(sumarDias(ultimo, 1)),
    anterior_desde: apertura(sumarDias(primero, -dias)),
  };
}
/** Los `dias` dias completos de la tienda que terminan hoy. */
export const rangoDias = (dias: number, ahora = Date.now()) => rangoEntre(hoyTienda(ahora - (dias - 1) * 86_400_000), hoyTienda(ahora));

export const MAX_DIAS_RANGO = 366;
const diaReal = (dia: string) => DIA.test(dia) && !Number.isNaN(Date.parse(`${dia}T00:00:00Z`)) && new Date(`${dia}T00:00:00Z`).toISOString().slice(0, 10) === dia;
/**
 * El rango de la peticion. `?desde=YYYY-MM-DD&hasta=YYYY-MM-DD` (dias de la tienda, ambos inclusive, `hasta` no pasa de hoy,
 * `desde` <= `hasta`, hasta 366 dias) o, como siempre, `?dias=N`. Con `desde`/`hasta` se piden los dos; un rango que no se
 * puede atender lanza RangoInvalido. `dias=abc` daba NaN y tumbaba el reporte con 500: un valor que no es numero vale el de omision.
 */
export const rangoDe = (url: URL, ahora = Date.now()) => {
  const q = url.searchParams;
  if (q.has('desde') || q.has('hasta')) {
    const desde = q.get('desde') ?? '', hasta = q.get('hasta') ?? '';
    if (!diaReal(desde) || !diaReal(hasta)) throw new RangoInvalido('Fechas invalidas: usa desde y hasta con el formato AAAA-MM-DD.');
    if (hasta > hoyTienda(ahora)) throw new RangoInvalido('La fecha final no puede ser futura.');
    if (desde > hasta) throw new RangoInvalido('La fecha inicial es posterior a la final.');
    const rango = rangoEntre(desde, hasta);
    if (rango.dias > MAX_DIAS_RANGO) throw new RangoInvalido(`El periodo no puede pasar de ${MAX_DIAS_RANGO} dias.`);
    return rango;
  }
  const dias = Math.round(Number(q.get('dias') ?? 30));
  return rangoDias(Number.isFinite(dias) ? Math.min(365, Math.max(1, dias)) : 30, ahora);
};

/**
 * Lo cobrado por forma de pago (y los Dolarones como una forma mas), con los 3 pares desde/hasta de `bind` (ventas, pedidos, abonos).
 * Cobrado en el ticket (netas.ts ya descuenta el anticipo) mas el anticipo de los pedidos recibidos en el periodo: el dinero entra
 * el dia del apartado, no el de la venta. Los Dolarones usados (neta - cobrado - anticipo) van en su propia fila. Con `porDia` cada
 * fila trae ademas el dia de la tienda en que entro el dinero (#802, vista Ventas): sumadas dan lo mismo que sin dia.
 * D1 admite 5 terminos por compound SELECT: son 4.
 */
export function consultaFormaPago(deTienda: string, deCajas: (columna: string) => string, porDia = false) {
  const dia = (columna: string) => (porDia ? `${diaTienda(columna)} as dia, ` : '');
  const g = porDia ? 'dia, ' : '';
  return `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
     select ${g}forma_pago, sum(tickets) as tickets, sum(total) as total from (
       select ${dia('creado_en')}forma_pago, count(distinct venta) as tickets, coalesce(sum(cobrado), 0) as total
       from cobros where propietario = 'dolaron' group by ${g}forma_pago
       union all
       select ${dia('creado_en')}forma_pago, 0, coalesce(sum(anticipo), 0) from pedidos where creado_en >= ? and creado_en < ?${deCajas('caja')} group by ${g}forma_pago
       union all
       select ${dia('creado_en')}forma_pago, 0, coalesce(sum(importe), 0) from pedido_movimientos
       where tipo = 'abono' and creado_en >= ? and creado_en < ?${deCajas('caja')} group by ${g}forma_pago
       union all
       select ${dia('creado_en')}'dolarones', count(distinct case when neta - cobrado - anticipo_linea <> 0 then venta end),
         coalesce(sum(neta - cobrado - anticipo_linea), 0)
       from cobros where propietario = 'dolaron'${porDia ? ' group by dia' : ''}
     ) group by ${g}forma_pago`;
}

/** Unidades y valor por dónde están: Soledad, cada sucursal y en camino. Las claves van siempre (en 0 si no hay nada). */
function desgloseDeInventario(filas: ({ precio: number; soledad: number; en_camino: number } & Record<string, number>)[]) {
  const lugar = () => ({ unidades: 0, valor: 0 });
  const por: Record<string, { unidades: number; valor: number }> = { [TIENDA_CENTRAL]: lugar(), ...Object.fromEntries(sucursales().map((t) => [t, lugar()])), en_camino: lugar() };
  for (const f of filas) {
    const suma = (clave: string, unidades: number) => { por[clave].unidades += unidades; por[clave].valor += f.precio * unidades; };
    suma(TIENDA_CENTRAL, f.soledad);
    for (const t of sucursales()) suma(t, f[`t_${t}`]);
    suma('en_camino', f.en_camino);
  }
  return por;
}

/**
 * Foto de lo que hay en piso AHORA (Issue #174), sin importar el periodo del reporte: piezas individuales
 * ya etiquetadas (con codigo) y con existencia. Quedan fuera las bandas (no tienen fecha de captura propia),
 * lo agotado y lo que aun esta en la cola de revision sin etiqueta. Las danadas SI cuentan: estan en piso.
 * Las de grado D (caducidad, #733) NO: es merma que nunca se vende y no entra al inventario vendible ni a su valor.
 * Antiguedad = dias de la tienda (UTC-6) desde `creado_en`, y los tramos van por semanas completas.
 * Una fecha vacia o invalida no se adivina: va aparte, en `sin_fecha`.
 */
export async function inventarioEnPiso(env: Env, ahora = Date.now()) {
  // ponytail: se trae toda la lista y se suma en JS; con decenas de miles de piezas en piso conviene agrupar en SQL.
  // #798: la existencia de una pieza es Soledad + sucursales + en camino (bulto abierto o cerrado), para que la mercancía no
  // «desaparezca» del valor al meterla a un bulto. `stock` de cada fila es esa existencia total; el desglose viaja en `soledad`,
  // `en_camino` y `t_<tienda>`. Sin sucursales ni bultos el total es exactamente `productos.stock`, como antes.
  const { results } = await env.DB.prepare(
    `select id, codigo, nombre, coalesce(nullif(categoria, ''), 'sin categoria') as categoria, precio,
       ${existenciaTotalSql('stock', 'productos.id')} as stock, stock as soledad, ${enCaminoSql('productos.id')} as en_camino,
       ${sucursales().map((t) => `${enTiendaSql('productos.id', t)} as t_${t}`).join(', ')}, creado_en,
       case when julianday(creado_en) is null then null
            else max(0, cast(julianday(?) - julianday(substr(datetime(creado_en, '-6 hours'), 1, 10)) as integer)) end as dias
     from productos
     where sin_inventario = 0 and ${existenciaTotalSql('stock', 'productos.id')} > 0 and destino = 'etiqueta' and codigo is not null and codigo != ''
       and propietario = 'dolaron' and estado_fisico <> 'caducado'`,
  )
    .bind(hoyTienda(ahora))
    .all<{ id: string; codigo: string; nombre: string; categoria: string; precio: number; stock: number; soledad: number; en_camino: number;
      creado_en: string; dias: number | null } & Record<string, number>>();

  const valorDe = (f: { precio: number; stock: number }) => f.precio * f.stock;
  const tramos = new Map(TRAMOS_ANTIGUEDAD.map(([clave]) => [clave, { tramo: clave, piezas: 0, unidades: 0, valor: 0 }]));
  const sinFecha = { piezas: 0, valor: 0 };
  const categorias = new Map<string, { categoria: string; piezas: number; unidades: number; valor: number; sumaDias: number; fechadas: number }>();
  for (const f of results) {
    const tramo = f.dias === null ? null : tramos.get(tramoDeDias(f.dias))!;
    const grupo = tramo ?? sinFecha;
    grupo.piezas += 1;
    if (tramo) tramo.unidades += f.stock;   // `piezas` cuenta etiquetas; `unidades`, la existencia (tablero #610)
    grupo.valor += valorDe(f);
    const c = categorias.get(f.categoria) ?? { categoria: f.categoria, piezas: 0, unidades: 0, valor: 0, sumaDias: 0, fechadas: 0 };
    c.piezas += 1;
    c.unidades += f.stock;
    c.valor += valorDe(f);
    if (f.dias !== null) { c.sumaDias += f.dias; c.fechadas += 1; }
    categorias.set(f.categoria, c);
  }
  return {
    piezas: results.length,
    unidades: results.reduce((suma, f) => suma + f.stock, 0),
    valor: results.reduce((suma, f) => suma + valorDe(f), 0),
    // #798: desglose de las mismas unidades y su valor por dónde están (Soledad, cada sucursal, en camino). Suma = unidades y valor de arriba.
    por_tienda: desgloseDeInventario(results),
    por_antiguedad: [...tramos.values()],
    sin_fecha: sinFecha,
    por_categoria: [...categorias.values()]
      .map(({ sumaDias, fechadas, ...c }) => ({ ...c, dias_promedio: fechadas ? sumaDias / fechadas : null }))
      .sort((a, b) => b.valor - a.valor || a.categoria.localeCompare(b.categoria)),
    mas_viejas: results.filter((f) => f.dias !== null)
      .sort((a, b) => b.dias! - a.dias! || valorDe(b) - valorDe(a) || a.codigo.localeCompare(b.codigo))
      .slice(0, 15)
      .map(({ id, codigo, nombre, categoria, precio, stock, creado_en, dias }) => ({ id, codigo, nombre, categoria, precio, stock, creado_en, dias })),
  };
}

/**
 * Merma por caducidad (#733): piezas de grado D capturadas en el periodo (`creado_en` entre `desde` y `hasta`, el mismo filtro de las ventas).
 * No es inventario vendible ni se cobra. Sin costo propio en el sistema: el valor es el precio de lista (el de la hoja del
 * manifiesto o el de la captura) x existencia; una pieza sin precio de lista suma 0 y se cuenta en `sin_valor`.
 * ponytail: se trae la lista completa y se suma en JS; el detalle se corta a 100.
 */
export async function mermaCaducidad(env: Env, desde: string, hasta: string) {
  const { results } = await env.DB.prepare(
    `select id, codigo, nombre, coalesce(nullif(categoria, ''), 'sin categoria') as categoria, precio_lista,
       ${existenciaTotalSql('stock', 'productos.id')} as stock, creado_en
     from productos
     where estado_fisico = 'caducado' and estado_analisis <> 'descartado' and sin_inventario = 0
       and propietario = 'dolaron' and creado_en >= ? and creado_en < ?
     order by creado_en desc, rowid desc`,
  )
    .bind(desde, hasta)
    .all<{ id: string; codigo: string | null; nombre: string; categoria: string; precio_lista: number; stock: number; creado_en: string }>();
  return {
    piezas: results.length,
    unidades: results.reduce((suma, f) => suma + f.stock, 0),
    valor_lista: results.reduce((suma, f) => suma + f.precio_lista * f.stock, 0),
    sin_valor: results.filter((f) => f.precio_lista <= 0).length,
    detalle: results.slice(0, 100),
  };
}

/** Dias promedio entre capturar una pieza y venderla, por categoria (de siempre, solo El Dolaron). Lo reusa /api/tablero (#610). */
export async function diasEnVentaPorCategoria(env: Env) {
  // Diferido a proposito en CONTRATO-ESCANER.md hasta que hubiera ventas reales.
  const { results } = await env.DB.prepare(
    `select coalesce(nullif(p.categoria, ''), 'sin categoria') as categoria,
       avg(julianday(substr(v.creado_en, 1, 10)) - julianday(substr(p.creado_en, 1, 10))) as dias_promedio,
       count(*) as n
     from venta_lineas l join ventas v on v.id = l.venta_id join productos p on p.id = l.producto_id
     where v.cancelada = 0 and p.sin_inventario = 0 and l.cantidad > l.cancelada_cantidad and l.propietario = 'dolaron'
     group by categoria order by dias_promedio desc`,
  ).all<{ categoria: string; dias_promedio: number; n: number }>();
  return results;
}

type Parte = string;
// El orden de las claves de la respuesta completa (el de siempre): una respuesta parcial las deja en el mismo orden.
const CLAVES_REPORTE = Object.values(CLAVES_DE_PARTE).flat().filter((clave) => clave !== 'primera_venta');

/**
 * Reportes: todo sale de consultas contra D1 en el momento, nada se precalcula
 * ni vive en otra tabla. `dias` acota lo que tiene sentido por rango (ventas del
 * dia, categoria, top de piezas); precio sugerido y dias en venta son de
 * siempre, porque son pocos datos y la pregunta que responden no es "esta
 * semana" sino "en general". `inventario` es la foto de ahora: tampoco depende de `dias`.
 *
 * `?partes=a,b` (#802, A6): calcula solo esas secciones (ver PARTES_REPORTE) y devuelve la cabecera (`dias`, `dia_desde`, `dia_hasta`,
 * `tienda`, `tiendas`) mas lo que pidio; sin el parametro devuelve TODO, el mismo JSON de siempre. Cada vista de /reportes pide solo lo
 * que pinta: antes cada cambio de periodo corria las 21 consultas, la foto de inventario incluida.
 */
export async function reportes(url: URL, env: Env): Promise<Response> {
  const rango = rangoDe(url);
  const { dias, desde, hasta } = rango;
  // #798: `?tienda=` acota las VENTAS a una tienda (ventas.tienda, congelada al cobrar); sin él, el negocio completo. La clave se valida contra
  // TIENDAS, así que es seguro ponerla en el SQL. El inventario es una foto del negocio y no se filtra: trae su propio desglose por tienda.
  const pedida = url.searchParams.get('tienda') ?? '';
  if (pedida && !esTienda(pedida)) return json({ error: 'Tienda invalida.' }, 400);
  const tienda: Tienda | null = esTienda(pedida) ? pedida : null;
  const deTienda = tienda ? ` and v.tienda = '${tienda}'` : '';          // sobre ventas con alias v
  const deTiendaSola = tienda ? ` and tienda = '${tienda}'` : '';        // sobre ventas sin alias
  const deCajas = (columna: string) => tienda ? ` and ${columna} in (${cajasDe(tienda).map((c) => `'${c}'`).join(', ')})` : '';
  const pedidas: string[] = url.searchParams.has('partes') ? (url.searchParams.get('partes') ?? '').split(',').filter(Boolean) : [...PARTES_REPORTE];
  const mala = pedidas.find((x) => !PARTES_REPORTE.includes(x));
  if (mala) return json({ error: `Parte invalida: ${mala.slice(0, 40)}.` }, 400);
  const pide = (parte: Parte) => pedidas.includes(parte);
  const datos: Record<string, unknown> = {};   // lo calculado, por clave de la respuesta
  const tareas: Promise<void>[] = [];
  const correr = (parte: Parte, calcular: () => Promise<Record<string, unknown>>) => { if (pide(parte)) tareas.push(calcular().then((r) => { Object.assign(datos, r); })); };

  // Cada seccion es una `correr(parte, ...)`: solo se calcula lo pedido y todas corren a la vez (son lecturas independientes).
  // Solo lo de la tienda (propietario 'dolaron', Issue #298): el neto de cada ticket va repartido por pieza.
  const netoDelPeriodo = (nombre: 'resumen' | 'anterior', desdeQ: string, hastaQ: string) => correr(nombre, async () => {
    const fila = await env.DB.prepare(
      `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
       select count(distinct venta) as ventas, coalesce(sum(neta), 0) as total, coalesce(sum(cant), 0) as piezas
       from netas where propietario = 'dolaron'`,
    )
      .bind(desdeQ, hastaQ)
      .first<{ ventas: number; total: number; piezas: number }>();
    return { [nombre]: {
      ventas: fila?.ventas ?? 0,
      total: fila?.total ?? 0,
      piezas: fila?.piezas ?? 0,
      ticket_promedio: fila?.ventas ? Math.round((fila.total ?? 0) / fila.ventas) : 0,
    } };
  });
  netoDelPeriodo('resumen', desde, hasta);
  // El periodo de igual largo justo antes, para las flechas de «vs periodo anterior».
  netoDelPeriodo('anterior', rango.anterior_desde, desde);

  // De bruto a vendido, sin que sobre ni falte un centavo: lo cobrado en todos los
  // tickets, menos lo devuelto por piezas, menos lo que valian los cancelados completos.
  correr('cuadre', async () => {
    const cuadre = await env.DB.prepare(
      `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
       select (select coalesce(sum(total), 0) from ventas where creado_en >= ? and creado_en < ?${deTiendaSola}) as bruto,
         (select coalesce(sum(devuelto + dolarones_devueltos), 0) from ventas where creado_en >= ? and creado_en < ?${deTiendaSola}) as devoluciones_pieza,
         (select coalesce(sum(case when cancelada = 1 then total - devuelto - dolarones_devueltos end), 0) from ventas where creado_en >= ? and creado_en < ?${deTiendaSola}) as cancelados,
         (select coalesce(sum(neta), 0) from netas where propietario = 'fep') as fep`,
    )
      .bind(desde, hasta, desde, hasta, desde, hasta, desde, hasta)
      .first<{ bruto: number; devoluciones_pieza: number; cancelados: number; fep: number }>();
    return { cuadre: {
      bruto: cuadre?.bruto ?? 0,
      devoluciones_pieza: cuadre?.devoluciones_pieza ?? 0,
      cancelados: cuadre?.cancelados ?? 0,
      fep: cuadre?.fep ?? 0,
      vendido: (cuadre?.bruto ?? 0) - (cuadre?.devoluciones_pieza ?? 0) - (cuadre?.cancelados ?? 0) - (cuadre?.fep ?? 0),
    } };
  });

  // Lo cobrado en dinero por forma de pago, y lo pagado con Dolarones como una forma mas.
  correr('forma_pago', async () => {
    const { results } = await env.DB.prepare(consultaFormaPago(deTienda, deCajas))
      .bind(desde, hasta, desde, hasta, desde, hasta)
      .all<{ forma_pago: string; tickets: number; total: number }>();
    return { por_forma_pago: results };
  });

  correr('por_dia', async () => {
    const [{ results: ventasPorDia }, { results: piezasPorDia }] = await Promise.all([
      env.DB.prepare(
        `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
         select ${diaTienda('creado_en')} as dia, count(distinct venta) as tickets, sum(neta) as total
         from netas where propietario = 'dolaron' group by dia order by dia`,
      )
        .bind(desde, hasta)
        .all<{ dia: string; tickets: number; total: number }>(),
      env.DB.prepare(
        `select ${diaTienda('v.creado_en')} as dia, coalesce(sum(l.cantidad - l.cancelada_cantidad), 0) as piezas
         from venta_lineas l join ventas v on v.id = l.venta_id
         where v.cancelada = 0 and v.creado_en >= ? and v.creado_en < ?${deTienda} and l.propietario = 'dolaron' group by dia`,
      )
        .bind(desde, hasta)
        .all<{ dia: string; piezas: number }>(),
    ]);
    const piezasPorDiaMapa = new Map(piezasPorDia.map((f) => [f.dia, f.piezas]));
    return { por_dia: ventasPorDia.map((f) => ({ ...f, piezas: piezasPorDiaMapa.get(f.dia) ?? 0 })) };
  });

  // Mapa de calor de /reportes: dia de la semana (0 = domingo, como %w) y hora, ambos de la tienda (UTC-6).
  correr('por_hora', async () => {
    const { results } = await env.DB.prepare(
      `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
       select cast(strftime('%w', datetime(creado_en, '-6 hours')) as integer) as dia_semana,
         cast(strftime('%H', datetime(creado_en, '-6 hours')) as integer) as hora,
         count(distinct venta) as tickets, sum(neta) as total
       from netas where propietario = 'dolaron' group by dia_semana, hora order by dia_semana, hora`,
    )
      .bind(desde, hasta)
      .all<{ dia_semana: number; hora: number; tickets: number; total: number }>();
    return { por_hora: results };
  });

  // Lo vendido por categoria (las bandas juntas), del periodo y del anterior de igual largo: mismas reglas en los dos.
  correr('categorias', async () => {
    const ventasPorCategoria = (anteriorAlPeriodo: boolean) => env.DB.prepare(
      `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
       select case when p.sin_inventario = 1 then 'bandas' else coalesce(nullif(p.categoria, ''), 'sin categoria') end as categoria,
         coalesce(sum(n.neta), 0) as total, coalesce(sum(n.cant), 0) as piezas
       from netas n left join productos p on p.id = n.producto_id
       where n.propietario = 'dolaron'
       group by 1 order by total desc`,   // por posicion: `group by categoria` agrupaba por la columna p.categoria y mezclaba las bandas con la ropa (#802)
    )
      .bind(...(anteriorAlPeriodo ? [rango.anterior_desde, desde] : [desde, hasta]))
      .all<{ categoria: string; total: number; piezas: number }>();
    const [{ results: porCategoria }, { results: porCategoriaAnterior }] = await Promise.all([ventasPorCategoria(false), ventasPorCategoria(true)]);
    return { por_categoria: porCategoria, por_categoria_anterior: porCategoriaAnterior };
  });

  correr('top_productos', async () => {
    const { results } = await env.DB.prepare(
      `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
       select codigo, nombre, sum(cant) as cantidad, sum(neta) as total
       from netas where producto_id is not null and cant > 0 and propietario = 'dolaron'
       group by codigo, nombre order by cantidad desc, total desc limit 10`,
    )
      .bind(desde, hasta)
      .all<{ codigo: string; nombre: string; cantidad: number; total: number }>();
    return { top_productos: results };
  });

  // Cuanto se aleja lo que de verdad se cobra de lo que propuso la IA: la razon
  // por la que existe precio_sugerido (migracion 002) es poder responder esto
  // con datos en vez de ajustar los porcentajes a ojo.
  correr('precio_sugerido', async () => {
    const fila = await env.DB.prepare(
      `select count(*) as n, avg((precio - precio_sugerido) * 100.0 / precio_sugerido) as promedio_pct
       from productos where precio_sugerido > 0 and precio > 0 and propietario = 'dolaron'`,
    ).first<{ n: number; promedio_pct: number | null }>();
    return { precio_sugerido: { n: fila?.n ?? 0, promedio_pct: fila?.promedio_pct ?? null } };
  });

  correr('dias_en_venta', async () => ({ dias_en_venta_por_categoria: await diasEnVentaPorCategoria(env) }));

  // Devoluciones, de ticket completo o de piezas sueltas (Issue #138): el motivo y quien cancelo son la unica huella de una
  // cancelacion que no fue legitima (cobrar de verdad y "cancelar" para
  // quedarse el efectivo). Se listan una por una, no solo el total.
  correr('cancelaciones', async () => {
    const { results } = await env.DB.prepare(
      `select v.id, v.total - v.dolarones - v.devuelto as total, v.dolarones - v.dolarones_devueltos as dolarones,
         v.forma_pago, v.cancelada_en, v.cancelada_por, v.motivo_cancelacion,
         (select group_concat(nombre, ' · ') from venta_lineas
          where venta_id = v.id and cantidad > cancelada_cantidad) as piezas, 'ticket' as tipo
       from ventas v where v.cancelada = 1 and v.creado_en >= ? and v.creado_en < ?${deTienda}
       union all
       select d.venta_id, d.importe, d.dolarones, d.forma_pago, d.creado_en, d.autor, d.motivo,
         d.cantidad || ' × ' || l.nombre, 'pieza'
       from devoluciones d join venta_lineas l on l.id = d.linea_id join ventas v on v.id = d.venta_id
       where v.creado_en >= ? and v.creado_en < ?${deTienda}
       order by 5 desc`,
    )
      .bind(desde, hasta, desde, hasta)
      .all<{
        id: string; total: number; dolarones: number; forma_pago: string; cancelada_en: string;
        cancelada_por: string; motivo_cancelacion: string; piezas: string; tipo: string;
      }>();
    return { cancelaciones: {
      n: results.length,
      total: results.reduce((suma, c) => suma + c.total, 0),
      dolarones: results.reduce((suma, c) => suma + c.dolarones, 0),
      detalle: results,
    } };
  });

  correr('aperturas', async () => {
    const { results } = await env.DB.prepare(
      `select abierto_en, abierto_por, caja from cajon_aperturas where abierto_en >= ? and abierto_en < ?${deCajas('caja')} order by abierto_en desc`,
    )
      .bind(desde, hasta)
      .all<{ abierto_en: string; abierto_por: string; caja: string }>();
    return { aperturas_cajon: results };
  });

  correr('cortes', async () => {
    const { results } = await env.DB.prepare(
      `select id, caja, cajero, desde, hasta, tickets, fondo_inicial, efectivo_ventas, efectivo_devoluciones, retiros,
              gastos, nomina, efectivo_esperado, efectivo_contado, diferencia, tarjeta_sistema, tarjeta_terminal, transferencias,
              dolarones, fondo_siguiente, entregado, notas
       from cortes where hasta >= ? and hasta < ?${deCajas('caja')} order by hasta desc`,
    )
      .bind(desde, hasta)
      .all();
    return { cortes: results };
  });

  correr('retiros', async () => {
    const { results } = await env.DB.prepare(
      `select creado_en, tipo, caja, cajero, importe, motivo from retiros where creado_en >= ? and creado_en < ?${deCajas('caja')} order by creado_en desc`,
    )
      .bind(desde, hasta)
      .all();
    return { retiros: results };
  });

  // Lo regalado en descuentos por dia (Isaac, 24/10): la promo de inauguracion aparte de los aprobados
  // (descuento ya trae la promo sumada). Un ticket cancelado no regalo nada.
  correr('descuentos', async () => {
    const { results: descuentosPorDia } = await env.DB.prepare(
      `select ${diaTienda('creado_en')} as dia,
         sum(case when coalesce(promo, 0) > 0 then 1 else 0 end) as promo_tickets, coalesce(sum(promo), 0) as promo,
         sum(case when coalesce(descuento, 0) - coalesce(promo, 0) > 0 then 1 else 0 end) as otros_tickets,
         coalesce(sum(coalesce(descuento, 0) - coalesce(promo, 0)), 0) as otros
       from ventas where cancelada = 0 and coalesce(descuento, 0) > 0 and creado_en >= ? and creado_en < ?${deTiendaSola} group by dia order by dia`,
    )
      .bind(desde, hasta)
      .all<{ dia: string; promo_tickets: number; promo: number; otros_tickets: number; otros: number }>();
    const sumaDescuentos = (campo: 'promo_tickets' | 'promo' | 'otros_tickets' | 'otros') =>
      descuentosPorDia.reduce((suma, d) => suma + d[campo], 0);
    return { descuentos: {
      promo_tickets: sumaDescuentos('promo_tickets'), promo: sumaDescuentos('promo'),
      otros_tickets: sumaDescuentos('otros_tickets'), otros: sumaDescuentos('otros'),
      por_dia: descuentosPorDia,
    } };
  });

  // Revendedoras (#575): lo que cerro en caja cada una, por el pedido que apartó. Un ticket cancelado no cuenta
  // y lo devuelto se resta (mismo neto que el resumen). Entra por ventas_creado (el rango) y une por llave primaria.
  // ponytail: importe = el ticket completo; si el cliente agrego otras piezas al cobrar, tambien suman.
  correr('revendedoras', async () => {
    const { results } = await env.DB.prepare(
      `select p.vendedora, coalesce(nullif(u.nombre, ''), p.vendedora) as nombre, count(*) as pedidos,
         coalesce(sum((select coalesce(sum(l.cantidad - l.cancelada_cantidad), 0) from venta_lineas l
           where l.venta_id = v.id and l.codigo != 'ENVIO')), 0) as piezas,
         coalesce(sum(v.total - v.devuelto - v.dolarones_devueltos), 0) as importe
       from ventas v join pedidos p on p.id = v.pedido_id join usuarios u on u.correo = p.vendedora
       where v.cancelada = 0 and v.creado_en >= ? and v.creado_en < ?${deTienda} and v.pedido_id is not null
         and (',' || u.roles || ',') like '%,revendedora,%'
       group by p.vendedora order by importe desc`,
    )
      .bind(desde, hasta)
      .all<{ vendedora: string; nombre: string; pedidos: number; piezas: number; importe: number }>();
    return { revendedoras: results };
  });

  // «Desde la apertura» (#802): el dia de la tienda de la primera venta, de todo el negocio. min() sobre el indice de creado_en: no lee la tabla.
  correr('primera_venta', async () => {
    const primera = await env.DB.prepare('select min(creado_en) as primera from ventas').first<{ primera: string | null }>();
    return { primera_venta: primera?.primera ? new Date(Date.parse(primera.primera) - 6 * 3_600_000).toISOString().slice(0, 10) : null };
  });

  correr('inventario', async () => ({ inventario: await inventarioEnPiso(env) }));
  correr('merma', async () => ({ merma_caducidad: await mermaCaducidad(env, desde, hasta) }));

  await Promise.all(tareas);
  return json({
    dias, dia_desde: rango.dia_desde, dia_hasta: rango.dia_hasta,
    ...(pide('primera_venta') ? { primera_venta: datos.primera_venta } : {}),
    tienda: tienda ?? '', tiendas: Object.entries(TIENDAS).map(([clave, { nombre }]) => ({ clave, nombre })),
    ...Object.fromEntries(CLAVES_REPORTE.filter((clave) => clave in datos).map((clave) => [clave, datos[clave]])),
  });
}
