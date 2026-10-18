// Lineas netas de cada venta (Issue #298). Lo usan los reportes y el corte de caja.

/**
 * CTE `netas`: cada pieza vendida (no cancelada) con lo que de verdad aporta a
 * `resumen.total`. Cada ticket cuenta `total - devuelto - dolarones_devueltos`
 * (ya con descuento y promo restados); ese neto se reparte entre sus lineas en
 * proporcion a su importe, y los centavos que sobran del redondeo hacia abajo
 * van uno a uno a las lineas con mayor resto, asi cada ticket suma exacto.
 * `filtro` es la condicion sobre `v` (ventas) y trae sus propios `?`.
 */
export const lineasNetas = (filtro: string, canceladas = false) => `with base as (
    select v.id as venta, l.id, l.producto_id, l.codigo, l.nombre, l.cantidad - l.cancelada_cantidad as cant,
      l.precio * (l.cantidad - l.cancelada_cantidad) as importe, v.total - v.devuelto - v.dolarones_devueltos as neto,
      l.propietario, v.forma_pago, v.creado_en, v.total - v.dolarones - v.anticipo - v.devuelto as pago, v.anticipo as antic
    from venta_lineas l join ventas v on v.id = l.venta_id where v.cancelada = ${canceladas ? 1 : 0} and ${filtro}),
  piso as (
    select *, sum(importe) over (partition by venta) as suma,
      case when sum(importe) over (partition by venta) > 0 then neto * importe / sum(importe) over (partition by venta) else 0 end as base_neta,
      case when sum(importe) over (partition by venta) > 0 then neto * importe % sum(importe) over (partition by venta) else 0 end as resto
    from base),
  netas as (
    select *, base_neta + case when resto > 0 and row_number() over (partition by venta order by resto desc, id)
        <= neto - sum(base_neta) over (partition by venta) then 1 else 0 end as neta
    from piso),
  -- Lo cobrado en efectivo, tarjeta o transferencia (sin Dolarones ni anticipo de pedido), repartido por pieza
  -- igual que el neto: asi lo cobrado, el anticipo y los Dolarones de cada pieza suman exacto su neta.
  -- El anticipo de un pedido entro el dia que se aparto (pedidos.creado_en), no en la venta (Issue #269).
  cobro as (
    select *, sum(importe) over (partition by venta) as suma_c,
      case when sum(importe) over (partition by venta) > 0 then pago * importe / sum(importe) over (partition by venta) else 0 end as base_c,
      case when sum(importe) over (partition by venta) > 0 then pago * importe % sum(importe) over (partition by venta) else 0 end as resto_c,
      case when sum(importe) over (partition by venta) > 0 then antic * importe / sum(importe) over (partition by venta) else 0 end as base_a,
      case when sum(importe) over (partition by venta) > 0 then antic * importe % sum(importe) over (partition by venta) else 0 end as resto_a
    from netas),
  cobros as (
    select *, base_c + case when resto_c > 0 and row_number() over (partition by venta order by resto_c desc, id)
        <= pago - sum(base_c) over (partition by venta) then 1 else 0 end as cobrado,
      base_a + case when resto_a > 0 and row_number() over (partition by venta order by resto_a desc, id)
        <= antic - sum(base_a) over (partition by venta) then 1 else 0 end as anticipo_linea
    from cobro)`;
