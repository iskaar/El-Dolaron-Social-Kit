// node --test src/reportes-capturas.test.ts
// Vista Capturas de /reportes (#802): el tiempo de cada captura (pausa, rafagas, personas, dia de la tienda), los totales por
// persona contra los de las tarjetas, periodo vacio, rango pasado cerrado y la nota «desde» de la bitacora. Datos inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tienda } from './prueba-d1.ts';
import {
  clasificarTiempos, mediana, histograma, horaDeTienda, pausaDe, notaBitacora, RAFAGA_FOTO_S, type Evento,
} from './reportes-capturas.ts';
import { permiso } from './cuentas.ts';
import {
  duracion, duracionLarga, edad, promedioMovil, agruparPersonas, datosSerie, datosHistograma, datosTiempo, notaDesde, tarjetasCapturas, htmlVista,
  tablaPersonas, graficaDe,
} from '../public/reportes-capturas.js';

const z = (dia: string, hms: string) => `${dia}T${hms}Z`;
const ev = (correo: string, iso: string, foto = true): Evento => ({ correo, ms: Date.parse(iso), foto });

/* ---------- el tiempo de cada captura (pura) ---------- */

test('la pausa corta el tiempo: hasta la pausa cuenta (inclusive), mas es un descanso', () => {
  const e = [ev('a', z('2026-10-27', '16:00:00.000')), ev('a', z('2026-10-27', '16:01:00.000')), ev('a', z('2026-10-27', '16:11:00.000')), ev('a', z('2026-10-27', '16:21:01.000'))];
  const r = clasificarTiempos(e, 600);
  assert.deepEqual(r.map((x) => x.clase), ['inicio', 'medida', 'medida', 'inicio']);   // 60 s y 600 s (justo la pausa) cuentan; 601 s no
  assert.deepEqual(r.map((x) => x.seg), [null, 60, 600, null]);
  assert.deepEqual(clasificarTiempos(e, 120).map((x) => x.clase), ['inicio', 'medida', 'inicio', 'inicio']);
});

test('las ráfagas de subida no se miden: fotos a menos de 5 s, el resto a menos de 1 s; un UPC a 3 s sí cuenta', () => {
  const e = [ev('a', z('2026-10-27', '16:00:00.000')), ev('a', z('2026-10-27', '16:00:04.000')), ev('a', z('2026-10-27', '16:00:09.000')),
    ev('a', z('2026-10-27', '16:00:12.000'), false), ev('a', z('2026-10-27', '16:00:12.400'), false)];
  assert.equal(RAFAGA_FOTO_S, 5);
  assert.deepEqual(clasificarTiempos(e, 600).map((x) => [x.clase, x.seg]),
    [['inicio', null], ['rafaga', null], ['medida', 5], ['medida', 3], ['rafaga', null]]);   // 5 s justos ya no es ráfaga; el UPC a 3 s es captura real
});

test('cada persona tiene su propio hilo: las capturas de otra no cortan ni acortan el intervalo', () => {
  const e = [ev('ana', z('2026-10-27', '16:00:00.000')), ev('beto', z('2026-10-27', '16:00:10.000')), ev('ana', z('2026-10-27', '16:01:00.000')),
    ev('beto', z('2026-10-27', '16:00:50.000')), ev('', z('2026-10-27', '16:00:55.000'))];
  const r = clasificarTiempos(e, 600);
  assert.deepEqual(r.map((x) => [x.correo, x.clase, x.seg]),
    [['ana', 'inicio', null], ['beto', 'inicio', null], ['ana', 'medida', 60], ['beto', 'medida', 40], ['', 'sin_autor', null]]);   // la lista sale en el mismo orden que entró
});

test('llegar desordenado no cambia el resultado: se ordena por hora, y un empate conserva el orden de entrada', () => {
  const a = ev('ana', z('2026-10-27', '16:01:00.000')), b = ev('ana', z('2026-10-27', '16:00:00.000'));
  assert.deepEqual(clasificarTiempos([a, b], 600).map((x) => x.clase), ['medida', 'inicio']);
  assert.equal(clasificarTiempos([ev('x', z('2026-10-27', '16:00:00.000')), ev('x', z('2026-10-27', '16:00:00.000'))], 600)[1].clase, 'rafaga');
});

test('mediana, histograma, pausa y dia de la tienda', () => {
  assert.equal(mediana([]), null);
  assert.equal(mediana([5]), 5);
  assert.equal(mediana([30, 10, 20]), 20);
  assert.equal(mediana([10, 20, 30, 41]), 25);
  assert.deepEqual(histograma([29.9, 30, 59, 60, 119, 600, 1700]).map((t) => t.n), [1, 2, 1, 1, 0, 0, 0, 2]);
  assert.equal(pausaDe(new URL('https://x/?pausa=15')), 15);
  assert.equal(pausaDe(new URL('https://x/?pausa=99')), 30);
  assert.equal(pausaDe(new URL('https://x/?pausa=1')), 2);
  assert.equal(pausaDe(new URL('https://x/?pausa=abc')), 10);
  assert.equal(pausaDe(new URL('https://x/')), 10);
  // 23:59:50 de la tienda ya es el dia siguiente en UTC; las 00:00:00 de la tienda son las 06:00 UTC.
  assert.deepEqual(horaDeTienda(Date.parse(z('2026-10-28', '05:59:59.000'))), { dia: '2026-10-27', hora: 23, dia_semana: 2 });
  assert.deepEqual(horaDeTienda(Date.parse(z('2026-10-28', '06:00:00.000'))), { dia: '2026-10-28', hora: 0, dia_semana: 3 });
  assert.deepEqual(notaBitacora('2026-10-23', '2026-10-01'), { desde: '2026-10-23', dentro_del_periodo: true, sin_datos: false });
  assert.deepEqual(notaBitacora('2026-10-23', '2026-10-23'), { desde: '2026-10-23', dentro_del_periodo: false, sin_datos: false });
  assert.deepEqual(notaBitacora(null, '2026-10-01'), { desde: null, dentro_del_periodo: false, sin_datos: true });
});

/* ---------- el endpoint contra la base de prueba ---------- */

type Datos = { id?: string; por: string; en: string; upc?: string; categoria?: string; estado?: string; codigo?: string; precio?: number; stock?: number;
  nombre?: string; revisar?: number };
function sembrar(db: DatabaseSync, o: Datos) {
  const id = o.id ?? crypto.randomUUID();
  db.prepare(`insert into productos (id, codigo, nombre, categoria, precio, estado_analisis, destino, stock, semana_ingreso, creado_en, actualizado_en,
      capturado_por, upc, por_revisar, propietario) values (?, ?, ?, ?, ?, ?, 'etiqueta', ?, 'S43', ?, ?, ?, ?, ?, 'dolaron')`)
    .run(id, o.codigo ?? null, o.nombre ?? 'Pieza', o.categoria ?? '', o.precio ?? 0, o.estado ?? 'listo', o.stock ?? 1, o.en, o.en, o.por, o.upc ?? '', o.revisar ?? 0);
  return id;
}
const suma = (db: DatabaseSync, por: string, en: string, producto: string) => db.prepare(
  `insert into conteo_ajustes (id, producto_id, motivo, cantidad, antes, despues, ajustado_por, ajustado_en) values (?, ?, 'entrada', 2, 1, 3, ?, ?)`)
  .run(crypto.randomUUID(), producto, por, en);
const bitacora = (db: DatabaseSync, producto: string, campo: string, antes: string, despues: string, por: string, en: string) => db.prepare(
  'insert into productos_cambios (producto_id, campo, antes, despues, por, en) values (?, ?, ?, ?, ?, ?)').run(producto, campo, antes, despues, por, en);

const ANA = 'ana@prueba.mx', BETO = 'beto@prueba.mx';
const D1 = '2026-10-27', D2 = '2026-10-28';   // martes y miercoles
const RANGO = `desde=${D1}&hasta=${D2}`;

/** Dos dias de captura de ana y beto, mas lo que no debe contar: otro periodo, descartes y una pieza sin cuenta. */
function escenario() {
  const t = tienda();
  for (const [correo, nombre] of [[ANA, 'Ana'], [BETO, 'Beto']]) {
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, 'capturista', 1, '', '')`).run(correo, nombre);
  }
  const A = (hms: string, dia = D1, extra: Partial<Datos> = {}) => sembrar(t.db, { por: ANA, en: z(dia, hms), ...extra });
  const a1 = A('16:00:00.000');
  A('16:01:30.000');          // 90 s
  A('16:01:32.000');          // 2 s despues: ráfaga de fotos
  A('16:04:02.000');          // 150 s
  A('16:20:00.000');          // 958 s despues: otra sesion con pausa de 10 min
  suma(t.db, ANA, z(D1, '16:21:00.000'), a1);          // 60 s: una suma a una pieza que ya existia
  A('16:21:30.000', D1, { upc: '0123456789012' });     // 30 s
  A('16:21:30.500', D1, { upc: '0123456789012' });     // 0.5 s: ráfaga
  A('05:59:50.000', D2);                               // 23:59:50 del 27 en la tienda
  A('06:00:20.000', D2);                               // 00:00:20 del 28 en la tienda: 30 s
  sembrar(t.db, { por: BETO, en: z(D1, '17:00:00.000'), categoria: 'ropa' });
  sembrar(t.db, { por: BETO, en: z(D1, '17:00:40.000'), categoria: 'ropa' });   // 40 s
  sembrar(t.db, { por: '', en: z(D1, '16:00:10.000') });                         // sin cuenta
  sembrar(t.db, { por: ANA, en: z(D1, '16:05:00.000'), estado: 'descartado' });  // se canceló: no es captura
  // El periodo anterior (25 y 26): dos capturas de ana con 60 s de por medio.
  A('16:00:00.000', '2026-10-26');
  A('16:01:00.000', '2026-10-26');
  // Despues del rango: no deben entrar.
  A('16:00:00.000', '2026-10-29');
  A('16:00:00.000', '2026-11-05');
  return t;
}
const pedir = async (t: ReturnType<typeof tienda>, consulta: string) => {
  const r = await t.pedir(`/api/reportes/capturas?${consulta}`);
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  return r.cuerpo;
};

test('capturas: tiempo por captura, personas, rafagas y sesiones del rango pasado', async () => {
  const t = escenario();
  const r = await pedir(t, RANGO);
  const x = r.resumen;
  assert.equal(r.pausa_min, 10);
  assert.equal(r.grano, 'dia');
  assert.equal(x.capturas, 12);   // 9 de ana, 2 de beto y 1 sin cuenta; el descartado, lo anterior y lo posterior no cuentan
  assert.equal(x.sumas, 1);
  assert.equal(x.medidas, 6);     // ana 90, 150, 60 (suma), 30, 30; beto 40
  assert.deepEqual(x.sin_tiempo, { rafaga: 2, inicio: 4, sin_autor: 1 });
  assert.equal(x.medidas + x.sin_tiempo.rafaga + x.sin_tiempo.inicio + x.sin_tiempo.sin_autor, x.capturas + x.sumas);   // todo evento cae en una sola clase
  assert.equal(x.tiempo_mediano_s, 50);   // [30, 30, 40, 60, 90, 150]
  assert.equal(x.horas_activas, 0.11);    // 400 s
  assert.equal(x.piezas_por_hora, 54);    // 6 intervalos en 400 s
  assert.equal(x.dias_con_captura, 2);
  assert.equal(x.por_dia, 6);
  assert.equal(x.descartadas, 1);
  assert.deepEqual(r.anterior, { capturas: 2, dias_con_captura: 1, por_dia: 2, tiempo_mediano_s: 60, horas_activas: 0.02, piezas_por_hora: 60 });
  assert.deepEqual(r.histograma.map((h: { n: number }) => h.n), [0, 3, 1, 1, 1, 0, 0, 0]);

  // La captura de las 23:59:50 es del 27 y la de las 00:00:20 es del 28 (dia de la tienda, no UTC).
  assert.deepEqual(r.serie.map((s: { clave: string; total: number }) => [s.clave, s.total]), [[D1, 11], [D2, 1]]);
  assert.deepEqual(r.serie.map((c: { dias: number }) => c.dias), [1, 1]);   // dias con captura de cada columna
  assert.deepEqual(r.serie[0].personas, { [ANA]: 8, [BETO]: 2, '': 1 });
  assert.deepEqual(r.serie[1].personas, { [ANA]: 1 });
  assert.deepEqual(r.tiempo_semanal, [{ lunes: '2026-10-26', mediana_s: 50, n: 6, piezas_por_hora: 54 }]);
  const horario = (dia: number, hora: number) => r.por_hora.find((h: { dia_semana: number; hora: number }) => h.dia_semana === dia && h.hora === hora)?.n;
  assert.equal(horario(2, 10), 8);   // martes 10:00 hora de la tienda
  assert.equal(horario(2, 23), 1);
  assert.equal(horario(3, 0), 1);
  assert.equal(r.por_hora.reduce((s: number, h: { n: number }) => s + h.n, 0), x.capturas);

  // Por tipo: UPC 2, ropa 2, general 8; el tiempo de cada tipo sale de sus propios intervalos.
  const tipo = (c: string) => r.tipos.find((f: { clave: string }) => f.clave === c);
  assert.deepEqual([tipo('upc').capturas, tipo('ropa').capturas, tipo('general').capturas], [2, 2, 8]);
  assert.deepEqual([tipo('upc').tiempo_mediano_s, tipo('ropa').tiempo_mediano_s, tipo('general').tiempo_mediano_s], [30, 40, 90]);
  assert.equal(tipo('upc').capturas + tipo('ropa').capturas + tipo('general').capturas, x.capturas);

  // Cada persona: los totales de la tabla son los de las tarjetas.
  const ana = r.personas.find((p: { correo: string }) => p.correo === ANA), beto = r.personas.find((p: { correo: string }) => p.correo === BETO);
  const sin = r.personas.find((p: { correo: string }) => p.correo === '');
  assert.equal(ana.nombre, 'Ana');
  assert.equal(sin.nombre, 'Sin atribuir');
  assert.deepEqual([ana.capturas, ana.sumas, ana.dias_activos, ana.medidas, ana.tiempo_mediano_s, ana.descartadas], [9, 1, 2, 5, 60, 1]);
  assert.deepEqual(ana.sin_tiempo, { rafaga: 2, inicio: 3, sin_autor: 0 });
  assert.deepEqual([beto.capturas, beto.medidas, beto.tiempo_mediano_s], [2, 1, 40]);
  assert.deepEqual([sin.capturas, sin.medidas, sin.horas_activas, sin.piezas_por_hora], [1, 0, 0, null]);
  const suma = (campo: string, f: (p: any) => number = (p) => p[campo]) => r.personas.reduce((s: number, p: unknown) => s + f(p), 0);
  assert.equal(suma('capturas'), x.capturas);
  assert.equal(suma('sumas'), x.sumas);
  assert.equal(suma('medidas'), x.medidas);
  assert.equal(suma('descartadas'), x.descartadas);
  assert.equal(suma('rafaga', (p) => p.sin_tiempo.rafaga), x.sin_tiempo.rafaga);
  assert.equal(suma('inicio', (p) => p.sin_tiempo.inicio), x.sin_tiempo.inicio);
  assert.equal(suma('sin_autor', (p) => p.sin_tiempo.sin_autor), x.sin_tiempo.sin_autor);
  assert.ok(Math.abs(suma('horas_activas') - x.horas_activas) < 0.011 * r.personas.length);
  assert.equal(r.serie.reduce((s: number, c: { total: number }) => s + c.total, 0), x.capturas);

  // El mismo resultado con otras piezas despues del rango (rango pasado cerrado): lo agregado hoy no mueve lo de ayer.
  sembrar(t.db, { por: ANA, en: z('2026-11-10', '16:00:00.000') });
  assert.equal((await pedir(t, RANGO)).resumen.capturas, 12);
});

test('capturas: la pausa cambia lo que cuenta y se acota de 2 a 30 minutos', async () => {
  const t = escenario();
  const corta = (await pedir(t, `${RANGO}&pausa=2`)).resumen;
  assert.equal(corta.medidas, 5);                  // el intervalo de 150 s ya es descanso
  assert.equal(corta.sin_tiempo.inicio, 5);
  const larga = await pedir(t, `${RANGO}&pausa=30`);
  assert.equal(larga.pausa_min, 30);
  assert.equal(larga.resumen.medidas, 7);          // los 958 s ya cuentan
  assert.equal((await pedir(t, `${RANGO}&pausa=1`)).pausa_min, 2);
  assert.equal((await pedir(t, `${RANGO}&pausa=500`)).pausa_min, 30);
  assert.equal((await pedir(t, `${RANGO}&pausa=x`)).pausa_min, 10);
});

test('capturas: periodo largo va por semana (lunes a domingo) y la tienda elegida no filtra', async () => {
  const t = escenario();
  const r = await pedir(t, 'desde=2026-09-14&hasta=2026-10-28');   // 46 dias
  assert.equal(r.grano, 'semana');
  assert.equal(r.serie[0].clave, '2026-09-14');
  assert.equal(r.serie[0].parcial, false);
  assert.deepEqual([r.serie.at(-1).clave, r.serie.at(-1).desde, r.serie.at(-1).hasta, r.serie.at(-1).parcial], ['2026-10-26', '2026-10-26', '2026-10-28', true]);
  assert.equal(r.serie.at(-1).total, 12 + 2);   // la semana del 26 trae lo del 26 (dos de ana) y lo del 27 y 28
  const conTienda = await pedir(t, `${RANGO}&tienda=salk`);
  assert.equal(conTienda.tienda_ignorada, true);
  assert.equal(conTienda.resumen.capturas, 12);
  assert.equal((await t.pedir(`/api/reportes/capturas?${RANGO}&tienda=nada`)).status, 400);
  assert.equal((await t.pedir('/api/reportes/capturas?desde=2026-10-29&hasta=2026-10-28')).status, 400);
});

test('capturas: un periodo sin capturas responde ceros y huecos, no inventa nada', async () => {
  const t = tienda();
  const r = await pedir(t, 'desde=2026-01-05&hasta=2026-01-11');
  assert.equal(r.resumen.capturas, 0);
  assert.equal(r.resumen.tiempo_mediano_s, null);
  assert.equal(r.resumen.por_dia, null);
  assert.equal(r.resumen.piezas_por_hora, null);
  assert.deepEqual(r.personas, []);
  assert.deepEqual(r.serie.map((s: { total: number }) => s.total), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(r.por_hora, []);
  assert.equal(r.anterior.capturas, 0);
  assert.deepEqual(r.embudo.map((p: { n: number }) => p.n), [0, 0, 0, 0]);
  assert.equal(r.embudo[1].mediana_s, null);
  assert.deepEqual(Object.values(r.pendientes).map((p: any) => [p.n, p.mas_vieja]), [[0, null], [0, null], [0, null]]);
  assert.deepEqual(r.bitacora, { desde: null, dentro_del_periodo: false, sin_datos: true });
  assert.equal(r.etiquetas.desde, null);
  // La pantalla tampoco se rompe sin datos.
  assert.match(tarjetasCapturas(r), /Sin datos en el periodo comparado/);
  assert.match(htmlVista(r), /Sin capturas en este periodo/);
  assert.match(graficaDe('serie', r, 600), /<svg/);
  assert.match(graficaDe('tiempo', r, 600), /<svg/);
  assert.match(graficaDe('histograma', r, 600), /<svg/);
});

test('capturas: embudo, correcciones tras la IA, bitacora con su fecha y pendientes', async () => {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, 'Ana', 'capturista', 1, '', '')`).run(ANA);
  const pieza = (hms: string, extra: Partial<Datos>, dia = D1) => sembrar(t.db, { por: ANA, en: z(dia, hms), nombre: 'Pieza', precio: 10000, stock: 3, ...extra });
  const f1 = pieza('16:00:00.000', { codigo: 'ED-F00001', stock: 5 });
  const f2 = pieza('16:10:00.000', { codigo: 'ED-F00002' });
  const f3 = pieza('18:00:00.000', { codigo: 'ED-F00003' });
  pieza('18:30:00.000', { estado: 'error' });
  pieza('18:40:00.000', { codigo: 'ED-F00006', revisar: 1 });
  pieza('15:00:00.000', { codigo: 'ED-F00004' }, '2026-10-26');   // de antes del registro de etiquetas: no cuenta como pendiente
  // La bitacora empieza el 27 (dentro del periodo): la IA lleno f1..f3; ana corrigio f1 al rato y f3 ocho dias despues.
  for (const [id, seg] of [[f1, 20], [f2, 30], [f3, 40]] as const) {
    const base = Date.parse(t.db.prepare('select creado_en from productos where id = ?').get(id)!.creado_en as string);
    bitacora(t.db, id, 'nombre', '', 'Pieza', 'ia', new Date(base + 5000).toISOString());
    bitacora(t.db, id, 'estado_analisis', 'pendiente', 'listo', 'ia', new Date(base + seg * 1000).toISOString());
  }
  bitacora(t.db, f1, 'precio', '10000', '12000', ANA, z(D1, '17:00:00.000'));
  bitacora(t.db, f3, 'precio', '10000', '9000', ANA, z('2026-11-04', '18:00:00.000'));
  bitacora(t.db, f2, 'precio', '10000', '9000', 'cron', z(D1, '17:00:00.000'));   // lo que no hizo una persona no cuenta
  // Etiquetas enviadas de f1 (30 min despues de capturar) y f2 (una hora).
  for (const [id, en] of [[f1, z(D1, '16:30:00.000')], [f2, z(D1, '17:10:00.000')]]) {
    t.db.prepare(`insert into etiquetas_enviadas (producto_id, etiqueta_en, etiqueta_precio, etiqueta_precio_lista, etiqueta_nombre, etiqueta_talla, etiqueta_origen)
      values (?, ?, 10000, 0, 'Pieza', '', 'pc')`).run(id, en);
  }
  // f1 se vende el 29 (un ticket real; se le mueve la fecha) y un ticket cancelado de f2 no cuenta.
  const vender = async (id: string, cuando: string, cancelar = false) => {
    const venta = crypto.randomUUID();
    assert.equal((await t.pedir('/api/ventas', { id: venta, lineas: [{ producto_id: id, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 10000 })).status, 201);
    t.db.prepare('update ventas set creado_en = ?, cancelada = ? where id = ?').run(cuando, cancelar ? 1 : 0, venta);
  };
  await vender(f1, z('2026-10-29', '16:00:00.000'));
  await vender(f2, z('2026-10-29', '17:00:00.000'), true);

  const r = await pedir(t, RANGO);
  assert.equal(r.resumen.capturas, 5);   // f1, f2, f3, f5, f6
  assert.deepEqual(r.bitacora, { desde: D1, dentro_del_periodo: false, sin_datos: false });
  assert.equal((await pedir(t, 'desde=2026-10-20&hasta=2026-10-28')).bitacora.dentro_del_periodo, true);   // la nota «desde» avisa que el periodo empieza antes
  assert.equal(r.etiquetas.desde, D1);
  assert.deepEqual(r.resumen.corregidas, { n: 1, base: 3 });   // f1 si; f2 solo toco el cron; f3 llego fuera de los 7 dias
  const [capturada, analizada, etiquetada, vendida] = r.embudo;
  assert.deepEqual([capturada.n, analizada.n, etiquetada.n, etiquetada.base, vendida.n], [5, 4, 2, 5, 1]);
  assert.deepEqual([analizada.mediana_s, analizada.n_tiempo], [30, 3]);
  assert.deepEqual([etiquetada.mediana_s, etiquetada.n_tiempo], [2675, 2]);   // (1800 - 20 s y 3600 - 30 s)
  assert.equal(r.resumen.captura_a_etiqueta_s, 2700);
  assert.equal(r.resumen.captura_a_etiqueta_n, 2);
  assert.deepEqual([vendida.mediana_s, vendida.n_tiempo], [171000, 1]);   // del 27 16:30 al 29 16:00
  assert.deepEqual(r.resumen.vendidas_14, { n: 1, base: 5 });
  assert.deepEqual(r.tipos.find((f: { clave: string }) => f.clave === 'general').corregidas, { n: 1, base: 3 });

  const pend = r.pendientes;
  assert.deepEqual([pend.por_revisar.n, pend.por_revisar.mas_vieja], [1, z(D1, '18:40:00.000')]);
  assert.deepEqual([pend.con_error.n, pend.con_error.mas_vieja], [1, z(D1, '18:30:00.000')]);
  assert.deepEqual([pend.sin_etiqueta.n, pend.sin_etiqueta.mas_vieja], [1, z(D1, '18:00:00.000')]);   // solo f3

  // La pantalla: la nota «desde» sale de los datos y los porcentajes se escriben con su base.
  assert.match(notaDesde(r), /^desde el 27 oct/);
  assert.match(notaDesde({ ...r, bitacora: { desde: '2026-10-23', dentro_del_periodo: true, sin_datos: false } }), /el periodo empieza antes/);
  assert.match(tarjetasCapturas(r), /33\.3 %|33,3 %/);
  assert.match(tarjetasCapturas(r), /1 de 3 piezas que llenó la IA/);
  assert.match(htmlVista(r), /desde el 27 oct/);
});

test('capturas: solo el dueno la consulta y su codigo es el de cualquier pantalla', () => {
  assert.deepEqual(permiso('/api/reportes/capturas', 'GET'), []);
  assert.equal(permiso('/reportes-capturas.js', 'GET'), 'cuenta');
});

/* ---------- la pantalla (funciones puras) ---------- */

test('duraciones, edades y promedio de 7 dias', () => {
  assert.equal(duracion(null), '—');
  assert.equal(duracion(48), '48 s');
  assert.equal(duracion(94), '1:34 min');
  assert.equal(duracion(600), '10:00 min');
  assert.equal(duracionLarga(1500), '25 min');
  assert.match(duracionLarga(11520), /^3[.,]2 h$/);
  assert.match(duracionLarga(259200), /^3[.,]0 días$/);
  assert.equal(edad('2026-11-10T00:00:00.000Z', '2026-11-13T00:00:00.000Z'), '3 días');
  assert.equal(edad('2026-11-13T00:00:00.000Z', '2026-11-13T05:00:00.000Z'), '5 h');
  assert.equal(edad(null, '2026-11-13T05:00:00.000Z'), '—');
  assert.deepEqual(promedioMovil([7, 7, 7, 7, 7, 7, 14, 0], 7), [null, null, null, null, null, null, 8, 7]);   // sin rampa falsa los primeros 6 dias
});

const personas = (n: number) => Array.from({ length: n }, (_, i) => ({ correo: `p${i}@x`, nombre: `P${i}`, capturas: 100 - i }));
test('las series: cuatro personas con color; mas de cuatro, tres y un resto; sin atribuir aparte en gris', () => {
  assert.deepEqual(agruparPersonas(personas(3)).map((g) => g.nombre), ['P0', 'P1', 'P2']);
  const seis = agruparPersonas([...personas(6), { correo: '', nombre: 'Sin atribuir', capturas: 4 }]);
  assert.deepEqual(seis.map((g) => g.nombre), ['P0', 'P1', 'P2', 'Resto (3 personas)', 'Sin atribuir']);
  assert.deepEqual(seis.at(-2)!.correos, ['p3@x', 'p4@x', 'p5@x']);
  assert.equal(seis.at(-1)!.color, 'var(--apagado)');
  assert.equal(new Set(seis.map((g) => g.color)).size, seis.length);
  const r = {
    grano: 'dia', personas: personas(2), serie: Array.from({ length: 8 }, (_, i) => ({ clave: `2026-10-${String(20 + i)}`, desde: '', hasta: '', parcial: false, total: 10, personas: { 'p0@x': 6, 'p1@x': 4 } })),
  };
  const d = datosSerie(r);
  assert.deepEqual(d.series.map((s: { valores: number[] }) => s.valores[0]), [6, 4]);
  assert.deepEqual(d.linea.valores.slice(5, 8), [null, 10, 10]);   // el promedio arranca al juntar 7 dias
  assert.equal(datosSerie({ ...r, grano: 'semana' }).linea, undefined);
});

test('el histograma pierde el tramo abierto de 10 minutos si la pausa no lo deja existir; la linea semanal deja huecos', () => {
  const r = { pausa_min: 10, histograma: histograma([5, 700]) };
  assert.equal(datosHistograma(r).etiquetas.at(-1), '5–10 min');
  assert.equal(datosHistograma({ ...r, pausa_min: 20 }).etiquetas.at(-1), '10 min o más');
  const t = datosTiempo({ tiempo_semanal: [{ lunes: '2026-10-26', mediana_s: 50, n: 6 }, { lunes: '2026-11-02', mediana_s: null, n: 0 }] });
  assert.deepEqual(t.map((p: { valor: number | null }) => p.valor), [50, null]);
  assert.match(t[1].detalle[0], /Sin intervalos/);
});

test('la tabla por persona trae el total del servidor y el nombre escapado', async () => {
  const t = escenario();
  const r = await pedir(t, RANGO);
  const html = tablaPersonas(r);
  assert.match(html, /<b>Total<\/b>/);
  assert.match(html, /<b>12<\/b>/);
  assert.match(html, /Sin atribuir/);
  assert.doesNotMatch(tablaPersonas({ ...r, personas: [{ ...r.personas[0], nombre: '<img src=x>' }, ...r.personas.slice(1)] }), /<img/);
  for (const g of ['serie', 'tiempo', 'histograma']) assert.match(graficaDe(g, r, 640), /data-tip/);
});
