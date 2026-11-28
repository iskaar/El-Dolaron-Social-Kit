// node --test src/cm.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from './worker.ts';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import { aplicarOverridesEnv } from './cm.ts';
import {
  pesosDeCentavos, centavosDePesos, pctDeBp, bpDePct,
  isoAMxLocal, mxLocalAIso, isoADiaMx, bonoDesdeAFecha, fechaABonoDesde,
  armarPayloadCambios, contarCambios, coincideBusqueda,
} from '../public/cm-logica.js';

function conAssets(t: ReturnType<typeof tienda>) {
  t.env.ASSETS = {
    fetch: async (req: RequestInfo | URL) => new Response(`pantalla:${new URL(typeof req === 'string' ? req : req instanceof URL ? req.url : req.url).pathname}`, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  } as unknown as Fetcher;
}

test('control de acceso, aislamiento de hosts y secretos ocultos', async () => {
  const t = tienda();
  conAssets(t);
  t.env.ANTHROPIC_API_KEY = 'sk-ant-secreto-prueba';
  t.env.ML_CLIENT_SECRET = 'ml-secreto-prueba';
  t.env.VAPID_JWK = '{"kty":"EC","d":"secreto-vapid"}';

  // Dueño activo entra a /cm, /api/cm, /api/cm/historial
  const rPantalla = await worker.fetch!(new Request('https://escaner.prueba/cm') as never, t.env, t.ctx as never);
  assert.equal(rPantalla.status, 200);
  assert.match(await rPantalla.text(), /pantalla:\/cm/);

  const rApi = await t.pedir('/api/cm', undefined, 'GET');
  assert.equal(rApi.status, 200);
  const textoApi = JSON.stringify(rApi.cuerpo);
  assert.ok(!textoApi.includes('sk-ant-secreto-prueba'));
  assert.ok(!textoApi.includes('ml-secreto-prueba'));
  assert.ok(!textoApi.includes('secreto-vapid'));
  assert.equal(rApi.cuerpo.salud.entorno_fijo.tiene_claude, true);

  // Todos los demás roles y cuenta inactiva quedan bloqueados
  const rolesNoDueno = ['cajero', 'capturista', 'computadora', 'finanzas', 'auxiliar', 'revendedora', 'inversionista', 'supervisor'];
  for (const rol of rolesNoDueno) {
    const correo = `${rol}@prueba.mx`;
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values (?, ?, ?, 1, 'soledad', '', '')`)
      .run(correo, rol, rol);
    t.env.DEV_USUARIO = correo;
    const g = await t.pedir('/api/cm', undefined, 'GET');
    assert.equal(g.status, 403, `GET /api/cm ${rol}`);
    const p = await t.pedir('/api/cm', { config: { tipo_cambio: 1900 } }, 'PUT');
    assert.equal(p.status, 403, `PUT /api/cm ${rol}`);
    const h = await t.pedir('/api/cm/historial', undefined, 'GET');
    assert.equal(h.status, 403, `GET /api/cm/historial ${rol}`);
    const html = await worker.fetch!(new Request('https://escaner.prueba/cm') as never, t.env, t.ctx as never);
    assert.equal(html.status, 302, `GET /cm ${rol}`);
  }

  // Dueño inactivo -> 403
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('inactivo@prueba.mx', 'Inactivo', 'dueno', 0, '', '')`).run();
  t.env.DEV_USUARIO = 'inactivo@prueba.mx';
  assert.equal((await t.pedir('/api/cm', undefined, 'GET')).status, 403);

  // Sin sesión -> 401
  t.env.DEV_USUARIO = '';
  assert.equal((await t.pedir('/api/cm', undefined, 'GET')).status, 401);

  // Regresar a dueño
  t.env.DEV_USUARIO = DUENO;

  // HOST_PORTAL y HOST_VENDEDOR responden 404 para /cm y /api/cm
  t.env.HOST_PORTAL = 'portal.prueba';
  t.env.HOST_VENDEDOR = 'vendedor.prueba';
  for (const host of ['portal.prueba', 'vendedor.prueba']) {
    for (const ruta of ['/cm', '/cm.html', '/api/cm', '/api/cm/historial']) {
      const res = await worker.fetch!(new Request(`https://${host}${ruta}`) as never, t.env, t.ctx as never);
      assert.equal(res.status, 404, `${host}${ruta}`);
    }
  }

  // GET /api/config para capturista oculta env_* (además de tope_retiro y bono_*)
  await t.pedir('/api/cm', {
    config: { tope_retiro: 50000, bono_tienda_pb: 150 },
    env: { CONTEO_UMBRAL: '45000' },
  }, 'PUT');
  t.env.DEV_USUARIO = 'capturista@prueba.mx';
  const cfgCapt = await t.pedir('/api/config', undefined, 'GET');
  assert.equal(cfgCapt.status, 200);
  assert.equal(cfgCapt.cuerpo.tope_retiro, undefined);
  assert.equal(cfgCapt.cuerpo.bono_tienda_pb, undefined);
  assert.equal(cfgCapt.cuerpo.env_CONTEO_UMBRAL, undefined);
});

test('validación tipada, persistencia en todos los dominios y atomicidad', async () => {
  const t = tienda();

  // Guardar todos los tipos soportados
  const res = await t.pedir('/api/cm', {
    config: {
      tipo_cambio: 1925,
      pct_ropa: 45,
      banda_100: 11000,
      fondo_caja: 70000,
      fondo_caja_salk_1: 40000,
      tope_retiro: 150000,
      cupon_porcentaje: 120,
      comision_terminal_pct: 325,
      recolecciones_desde: '2026-11-20',
      bono_tienda_desde: 20261116, // lunes real
      reto_dias_viejo: 75,
      reto_d_tope_mes: 800,
      ml_tipo_publicacion: 'gold_pro',
      portadas_modelo: 'gemini-nano-banana-2.1',
      portadas_tamano: '2K',
      etiqueta_corrimiento: -25,
      etiqueta_modulo: 3,
      ropa_ia_activo: true,
      portadas_aprobacion: '0',
    },
    nomina: {
      checador_activo: true,
      bono_centavos: 50000,
      tolerancia_minutos: 10,
      retardos_permitidos: 2,
      faltas_permitidas: 1,
    },
  }, 'PUT');

  assert.equal(res.status, 200);
  assert.equal(res.cuerpo.config.tipo_cambio, '1925');
  assert.equal(res.cuerpo.config.pct_ropa, '45');
  assert.equal(res.cuerpo.config.banda_100, '11000');
  assert.equal(res.cuerpo.config.fondo_caja, '70000');
  assert.equal(res.cuerpo.config.fondo_caja_salk_1, '40000');
  assert.equal(res.cuerpo.config.tope_retiro, '150000');
  assert.equal(res.cuerpo.config.cupon_porcentaje, '120');
  assert.equal(res.cuerpo.config.comision_terminal_pct, '325');
  assert.equal(res.cuerpo.config.recolecciones_desde, '2026-11-20T06:00:00.000Z');
  assert.equal(res.cuerpo.config.bono_tienda_desde, '20261116');
  assert.equal(res.cuerpo.config.reto_dias_viejo, '75');
  assert.equal(res.cuerpo.config.reto_d_tope_mes, '800');
  assert.equal(res.cuerpo.config.ml_tipo_publicacion, 'gold_pro');
  assert.equal(res.cuerpo.config.portadas_modelo, 'gemini-nano-banana-2.1');
  assert.equal(res.cuerpo.config.portadas_tamano, '2K');
  assert.equal(res.cuerpo.config.etiqueta_corrimiento, '-25');
  assert.equal(res.cuerpo.config.etiqueta_modulo, '3');
  assert.equal(res.cuerpo.config.ropa_ia_activo, '1');
  assert.equal(res.cuerpo.config.portadas_aprobacion, '0');
  assert.deepEqual(res.cuerpo.nomina, {
    checador_activo: true,
    bono_centavos: 50000,
    tolerancia_minutos: 10,
    retardos_permitidos: 2,
    faltas_permitidas: 1,
  });

  // Limpiar con null fondo_caja_salk_1 y tope_retiro
  const borrado = await t.pedir('/api/cm', { config: { fondo_caja_salk_1: null, tope_retiro: null } }, 'PUT');
  assert.equal(borrado.status, 200);
  assert.equal(borrado.cuerpo.config.fondo_caja_salk_1, null);
  assert.equal(borrado.cuerpo.config.tope_retiro, null);

  // Rechazos esperados -> 400
  assert.equal((await t.pedir('/api/cm', { config: { cupon_porcentaje: 0 } }, 'PUT')).status, 400);
  assert.equal((await t.pedir('/api/cm', { config: { cupon_porcentaje: 201 } }, 'PUT')).status, 400);
  assert.equal((await t.pedir('/api/cm', { config: { bono_tienda_desde: 20261117 } }, 'PUT')).status, 400); // martes
  assert.equal((await t.pedir('/api/cm', { config: { clave_desconocida: 1 } }, 'PUT')).status, 400);
  assert.equal((await t.pedir('/api/cm', { nomina: { otra: 1 } }, 'PUT')).status, 400);
  assert.equal((await t.pedir('/api/cm', { env: { ACCESS_EQUIPO: 'mal' } }, 'PUT')).status, 400);

  // Atomicidad: un campo válido + uno inválido en el mismo PUT no persiste ninguno
  const atomico = await t.pedir('/api/cm', {
    config: { tipo_cambio: 2500, cupon_porcentaje: 999 },
  }, 'PUT');
  assert.equal(atomico.status, 400);
  const actual = await t.pedir('/api/cm', undefined, 'GET');
  assert.equal(actual.cuerpo.config.tipo_cambio, '1925');
});

test('overrides en vivo de env funcionan de extremo a extremo y no tocan secretos', async () => {
  const t = tienda();
  t.env.VALES_ABIERTOS = 'si';
  t.env.CONTEO_UMBRAL = '30000';
  t.env.ACCESS_EQUIPO = 'local';

  // Pieza de $250: con umbral default $300 no aparece en /api/conteo
  const antesConteo = await t.pedir('/api/conteo', undefined, 'GET');
  assert.equal(antesConteo.status, 200);
  assert.equal((antesConteo.cuerpo as unknown[]).length, 0);

  // Override CONTEO_UMBRAL a $200 (20000) -> aparece de inmediato
  assert.equal((await t.pedir('/api/cm', { env: { CONTEO_UMBRAL: '20000' } }, 'PUT')).status, 200);
  const despuesConteo = await t.pedir('/api/conteo', undefined, 'GET');
  assert.equal((despuesConteo.cuerpo as unknown[]).length, 1);

  // VALES_ABIERTOS: apagar en vivo con '' y luego heredar con null
  assert.equal((await t.pedir('/api/vales/config', undefined, 'GET')).cuerpo.habilitado, true);
  assert.equal((await t.pedir('/api/cm', { env: { VALES_ABIERTOS: '' } }, 'PUT')).status, 200);
  assert.equal((await t.pedir('/api/vales/config', undefined, 'GET')).cuerpo.habilitado, false);
  assert.equal((await t.pedir('/api/cm', { env: { VALES_ABIERTOS: null } }, 'PUT')).status, 200);
  assert.equal((await t.pedir('/api/vales/config', undefined, 'GET')).cuerpo.habilitado, true);

  // BUENFIN_DESDE / HASTA / TIENDAS
  const bf = await t.pedir('/api/cm', {
    env: {
      BUENFIN_DESDE: '2026-11-14T06:00:00Z',
      BUENFIN_HASTA: '2026-11-18T06:00:00Z',
      BUENFIN_TIENDAS: 'soledad',
    },
  }, 'PUT');
  assert.equal(bf.status, 200);
  const valesCfg = await t.pedir('/api/vales/config', undefined, 'GET');
  assert.deepEqual(valesCfg.cuerpo.buenfin, { desde: '2026-11-14T06:00:00.000Z', hasta: '2026-11-18T06:00:00.000Z' });

  // Ventana inválida (inicio >= fin) -> 400
  assert.equal((await t.pedir('/api/cm', {
    env: { BUENFIN_DESDE: '2026-11-18T06:00:00Z', BUENFIN_HASTA: '2026-11-14T06:00:00Z' },
  }, 'PUT')).status, 400);

  // Defensa en profundidad: aunque exista env_ACCESS_EQUIPO directo en D1, aplicarOverridesEnv lo ignora y no muta t.env
  t.db.prepare(`insert into config (clave, valor) values ('env_ACCESS_EQUIPO', 'atacante.cloudflareaccess.com')`).run();
  const clon = await aplicarOverridesEnv(t.env);
  assert.equal(clon.ACCESS_EQUIPO, 'local');
  assert.equal(t.env.CONTEO_UMBRAL, '30000'); // el env original no fue mutado
  assert.equal(clon.CONTEO_UMBRAL, '20000');
});

test('historial de cambios y tolerancia si falta migracion 092', async () => {
  const t = tienda();

  // Primer cambio crea fila en config_historial
  const p1 = await t.pedir('/api/cm', { config: { tipo_cambio: 1950 }, env: { VALES_ABIERTOS: '' } }, 'PUT');
  assert.equal(p1.status, 200);
  assert.equal(p1.cuerpo.guardados, 2);
  assert.equal(p1.cuerpo.historial_listo, true);
  assert.equal(p1.cuerpo.historial.length, 2);

  // Repetir el mismo valor (no-op) no agrega filas
  const p2 = await t.pedir('/api/cm', { config: { tipo_cambio: 1950 } }, 'PUT');
  assert.equal(p2.status, 200);
  assert.equal(p2.cuerpo.guardados, 0);
  assert.equal(p2.cuerpo.historial.length, 2);

  // GET /api/cm/historial con filtro de clave
  const fh = await t.pedir('/api/cm/historial?clave=tipo_cambio', undefined, 'GET');
  assert.equal(fh.status, 200);
  assert.equal(fh.cuerpo.historial.length, 1);
  assert.equal(fh.cuerpo.historial[0].despues, '1950');
  assert.equal(fh.cuerpo.historial[0].cambiado_por, DUENO);

  // Sin tabla config_historial: sigue funcionando sin romper GET ni PUT
  t.db.exec('drop table config_historial');
  const sinTablaGet = await t.pedir('/api/cm', undefined, 'GET');
  assert.equal(sinTablaGet.status, 200);
  assert.equal(sinTablaGet.cuerpo.historial_listo, false);
  assert.deepEqual(sinTablaGet.cuerpo.historial, []);

  const sinTablaPut = await t.pedir('/api/cm', { config: { tipo_cambio: 2000 } }, 'PUT');
  assert.equal(sinTablaPut.status, 200);
  assert.equal(sinTablaPut.cuerpo.config.tipo_cambio, '2000');
});

test('lógica pura de /cm y reglas de higiene en HTML/JS', () => {
  assert.equal(pesosDeCentavos(1850), '18.50');
  assert.equal(pesosDeCentavos(50000), '500');
  assert.equal(centavosDePesos('18.50'), 1850);
  assert.equal(centavosDePesos(''), null);
  assert.ok(Number.isNaN(centavosDePesos('-5')));

  assert.equal(pctDeBp(325), '3.25');
  assert.equal(pctDeBp(100), '1');
  assert.equal(bpDePct('3.25'), 325);
  assert.equal(bpDePct('1,5'), 150);

  assert.equal(isoAMxLocal('2026-11-14T06:00:00.000Z'), '2026-11-14T00:00');
  assert.equal(mxLocalAIso('2026-11-14T00:00'), '2026-11-14T06:00:00.000Z');
  assert.equal(isoADiaMx('2026-11-14T06:00:00.000Z'), '2026-11-14');
  assert.equal(bonoDesdeAFecha(20261116), '2026-11-16');
  assert.equal(fechaABonoDesde('2026-11-16'), 20261116);
  assert.equal(fechaABonoDesde(''), 0);

  const diff = armarPayloadCambios(
    { config: { tipo_cambio: '1850', fondo_caja: '50000' }, nomina: { checador_activo: false }, env: { VALES_ABIERTOS: null } },
    { config: { tipo_cambio: '1900', fondo_caja: '50000' }, nomina: { checador_activo: true }, env: { VALES_ABIERTOS: '' } },
  );
  assert.deepEqual(diff, {
    config: { tipo_cambio: '1900' },
    nomina: { checador_activo: true },
    env: { VALES_ABIERTOS: '' },
  });
  assert.equal(contarCambios(diff), 3);
  assert.equal(coincideBusqueda('Tipo de cambio dólar', 'dolar'), true);

  const html = readFileSync('public/cm.html', 'utf8');
  const js = readFileSync('public/cm.js', 'utf8');
  assert.match(js, /actualizarRielActivo/);
  assert.match(js, /aria-current/);
  assert.match(html, /id="form-nueva-banda"/);
  assert.match(js, /\/api\/cm\/bandas/);
  for (const texto of [html, js]) {
    assert.ok(!/\b(alert|confirm|prompt)\s*\(/.test(texto), 'no usar diálogos nativos');
    assert.ok(!/https?:\/\//i.test(texto), 'sin dependencias externas CDN');
  }
});

test('POST /api/cm/bandas crea banda dinámica en config, familias, productos, caja e historial', async () => {
  const t = tienda();
  // Crear una familia de FEP para comprobar que se respeta propietario
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, editar_inventario, creado_en, actualizado_en)
    values ('fep@prueba.mx', 'FEP', 'finanzas', 1, 1, '', ''), ('caja@prueba.mx', 'Caja', 'cajero', 1, 0, '', '')`).run();
  t.env.DEV_USUARIO = 'fep@prueba.mx';
  const famFep = await t.pedir('/api/familias', { nombre: 'Termos FEP' });
  assert.equal(famFep.status, 201);

  // No-dueno no puede crear bandas
  t.env.DEV_USUARIO = 'caja@prueba.mx';
  assert.equal((await t.pedir('/api/cm/bandas', { monto: 350 })).status, 403);

  t.env.DEV_USUARIO = DUENO;
  // Validaciones 400 / 409
  for (const malo of [0, -10, 1000, 12.5, 'abc']) {
    assert.equal((await t.pedir('/api/cm/bandas', { monto: malo })).status, 400);
  }
  assert.equal((await t.pedir('/api/cm/bandas', { monto: 100 })).status, 409);

  // Agregar $350 -> 201
  const creada = await t.pedir('/api/cm/bandas', { monto: 350 });
  assert.equal(creada.status, 201);
  assert.equal(creada.cuerpo.monto, 350);
  assert.equal(creada.cuerpo.familias, 19); // 18 de tienda + 1 FEP
  assert.equal(creada.cuerpo.config.banda_350, '35000');
  assert.ok(creada.cuerpo.catalogo.montos_banda.includes(350));
  assert.deepEqual(creada.cuerpo.catalogo.montos_extra, [350]);

  // Duplicada -> 409
  assert.equal((await t.pedir('/api/cm/bandas', { monto: 350 })).status, 409);

  // Productos sembrados para todas las familias con su propietario
  const r350 = t.db.prepare(`select id, codigo, precio, destino, sin_inventario, propietario, creado_en from productos where codigo = 'R350'`)
    .get() as Record<string, unknown>;
  assert.equal(r350.precio, 35000);
  assert.equal(r350.destino, 'banda_r350');
  assert.equal(r350.sin_inventario, 1);
  assert.equal(r350.propietario, 'dolaron');
  assert.equal(r350.creado_en, '2026-01-01T00:00:00.000Z');

  const fepCod = `${String(famFep.cuerpo.prefijo).toUpperCase()}350`;
  const fep350 = t.db.prepare(`select propietario from productos where codigo = ?`).get(fepCod) as { propietario: string };
  assert.equal(fep350.propietario, 'fep');

  // Historial registró bandas_extra
  const hist = await t.pedir('/api/cm/historial?clave=bandas_extra', undefined, 'GET');
  assert.equal(hist.status, 200);
  assert.equal(hist.cuerpo.historial.length, 1);
  assert.equal(hist.cuerpo.historial[0].despues, '350');

  // /api/familias la devuelve en montos
  const fams = await t.pedir('/api/familias', undefined, 'GET');
  assert.ok((fams.cuerpo.montos as number[]).includes(350));

  // Nueva familia posterior también recibe el producto $350
  const nuevaFam = await t.pedir('/api/familias', { nombre: 'Mochilas' });
  assert.equal(nuevaFam.status, 201);
  const codNuevo = `${String(nuevaFam.cuerpo.prefijo).toUpperCase()}350`;
  assert.ok(t.db.prepare(`select 1 from productos where codigo = ?`).get(codNuevo));

  // PATCH /api/borradores/:id acepta destino banda_r350 y ajusta su precio a la banda
  const patch = await t.pedir(`/api/borradores/${PRODUCTO}`, { destino: 'banda_r350', precio: 0 }, 'PATCH');
  assert.equal(patch.status, 200);
  assert.equal(patch.cuerpo.destino, 'banda_r350');
  assert.equal(patch.cuerpo.precio, 35000);

  // Se puede editar banda_350 desde PUT /api/cm después
  const edit = await t.pedir('/api/cm', { config: { banda_350: 36000 } }, 'PUT');
  assert.equal(edit.status, 200);
  assert.equal(edit.cuerpo.config.banda_350, '36000');

  // La caja vende R350 sin error
  t.env.DEV_USUARIO = 'caja@prueba.mx';
  const venta = await t.pedir('/api/ventas', {
    id: crypto.randomUUID(),
    caja: 'Caja 1',
    forma_pago: 'efectivo',
    efectivo: 35000,
    lineas: [{ producto_id: r350.id, cantidad: 1 }],
  });
  assert.equal(venta.status, 201);
});
