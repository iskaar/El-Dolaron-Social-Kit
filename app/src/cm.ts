/**
 * Centro de Mando (/cm): punto único de gerencia para leer y modificar variables operativas
 * (config, nomina_config, overrides de env), consultar salud del sistema y revisar el historial.
 */
import { TIENDAS, CAJAS, esTienda, type Usuario, type Tienda } from './cuentas.ts';
import { MONTOS_BANDA, MONTOS_BANDA_ANTERIORES, montosBandaActivos, parsearMontosExtra } from './precio.ts';
import { CLAVE_BONO_DESDE, claveLinea, fechaBono } from './equipo.ts';
import { CLAVE_TOPE_RETIRO } from './corte.ts';
import { hoyTienda } from './reportes.ts';
import { CATEGORIAS, CLAVES_CATEGORIA } from '../public/categorias.js';
import { claveFondo } from '../public/fondos.js';
import { CLAVE_COMISION, LIMITE_COMISION_BP } from '../public/reportes-finanzas.js';

const json = (cuerpo: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

const FONDOS_CAJA_CLAVES = new Set(CAJAS.map((c) => claveFondo(c)));
const LINEAS_BONO_CLAVES = new Set((Object.keys(TIENDAS) as Tienda[]).map((t) => claveLinea(t)));
const TODOS_MONTOS_BANDA: readonly number[] = [...MONTOS_BANDA, ...MONTOS_BANDA_ANTERIORES];

export const ENV_OVERRIDE_CLAVES = [
  'MODELO_ANALISIS',
  'BUSQUEDA_WEB',
  'CONTEO_UMBRAL',
  'PORTAL_REGISTRO_ABIERTO',
  'VALES_ABIERTOS',
  'REFERIDOS_ABIERTO',
  'PREMIOS_APERTURA',
  'PROMO_DESDE',
  'PROMO_HASTA',
  'PROMO_CUPO',
  'BUENFIN_DESDE',
  'BUENFIN_HASTA',
  'BUENFIN_TIENDAS',
  'PROMO_META_INICIO',
  'PROMO_META_FIN',
  'PROMO_META_VENCE',
] as const;

export type ClaveEnvOverride = (typeof ENV_OVERRIDE_CLAVES)[number];
const ENV_OVERRIDE_SET = new Set<string>(ENV_OVERRIDE_CLAVES);

const DEFAULTS_CONFIG: Record<string, string> = {
  tipo_cambio: '1850',
  pct_danado: '60',
  pct_liquidacion: '20',
  limite_banda: '20000',
  meta_ventas_mes: '0',
  fondo_caja: '50000',
  cupon_porcentaje: '100',
  comision_terminal_pct: '0',
  bono_tienda_desde: '0',
  bono_tienda_pb: '100',
  bono_tienda_pb_arriba: '0',
  bono_tienda_meta_tope: '0',
  bono_d_cada: '0',
  bono_d_tope: '0',
  bono_d_record: '0',
  reto_dias_viejo: '90',
  reto_d_viejo: '50',
  reto_stock_alto: '5',
  reto_d_stock: '30',
  reto_racha_dias: '5',
  reto_d_racha: '100',
  reto_d_socio: '30',
  reto_d_apartado: '30',
  reto_d_tope_mes: '500',
  ml_pct: '20',
  ml_descuento_referencia: '20',
  ml_tipo_publicacion: 'gold_special',
  ropa_ia_activo: '0',
  recortes_activo: '0',
  portadas_activo: '0',
  portadas_aprobacion: '1',
  portadas_tope_diario: '100',
  portadas_modelo: 'gemini-3.1-flash-image',
  portadas_tamano: '1K',
  etiqueta_corrimiento: '0',
  etiqueta_modulo: '4',
};
for (const c of CLAVES_CATEGORIA) DEFAULTS_CONFIG[`pct_${c}`] = '50';
for (const m of TODOS_MONTOS_BANDA) DEFAULTS_CONFIG[`banda_${m}`] = String(m * 100);
for (const clave of LINEAS_BONO_CLAVES) DEFAULTS_CONFIG[clave] = '0';

/**
 * Aplica overrides guardados en D1 (`config.env_<CLAVE>`) sobre una copia superficial de `env`.
 * Nunca muta `env` ni permite sobrescribir secretos, hostnames o configuración de Access.
 */
export async function aplicarOverridesEnv(env: Env): Promise<Env> {
  if (!env?.DB) return env;
  let filas: { clave: string; valor: string }[];
  try {
    const res = await env.DB.prepare(`select clave, valor from config where clave like 'env\\_%' escape '\\'`)
      .all<{ clave: string; valor: string }>();
    filas = res.results;
  } catch {
    return env;
  }
  if (!filas.length) return env;
  let efectivo: Record<string, unknown> | null = null;
  for (const { clave, valor } of filas) {
    const nombre = clave.slice(4);
    if (!ENV_OVERRIDE_SET.has(nombre)) continue;
    efectivo ??= { ...env } as Record<string, unknown>;
    efectivo[nombre] = valor === '' ? undefined : valor;
  }
  return (efectivo as unknown as Env) ?? env;
}

/* ---------- Validación tipada ---------- */

function enteroEnRango(valor: unknown, min: number, max: number): number | null {
  if (valor === '' || valor === null || valor === undefined || typeof valor === 'boolean') return null;
  const n = typeof valor === 'number' ? valor : Number(String(valor).trim());
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function bandera01(valor: unknown): '0' | '1' | null {
  if (valor === true || valor === 1 || valor === '1') return '1';
  if (valor === false || valor === 0 || valor === '0') return '0';
  return null;
}

function normalizarFechaDesde(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim();
  const crudo = /^\d{4}-\d{2}-\d{2}$/.test(limpio) ? `${limpio}T06:00:00.000Z` : limpio;
  const fecha = new Date(crudo);
  if (!limpio || Number.isNaN(fecha.valueOf())) return null;
  return fecha.toISOString();
}

function normalizarIsoOpcional(valor: unknown): string | null {
  if (valor === '') return '';
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim();
  if (!limpio) return '';
  const fecha = new Date(limpio);
  if (Number.isNaN(fecha.valueOf())) return null;
  return fecha.toISOString();
}

function validarConfigClave(clave: string, valor: unknown, extrasBanda: readonly number[] = []): { ok: true; valor: string | null } | { ok: false; error: string } {
  if (clave === 'tipo_cambio') {
    const n = enteroEnRango(valor, 100, 20000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'tipo_cambio debe estar entre 100 y 20000 centavos.' };
  }
  if ((CLAVES_CATEGORIA as readonly string[]).some((c) => `pct_${c}` === clave) || clave === 'pct_danado' || clave === 'pct_liquidacion') {
    const n = enteroEnRango(valor, 0, 500);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: `${clave} debe ser un entero entre 0 y 500.` };
  }
  if (/^banda_(\d+)$/.test(clave)) {
    const monto = Number(clave.slice(6));
    if (TODOS_MONTOS_BANDA.includes(monto) || extrasBanda.includes(monto)) {
      const n = enteroEnRango(valor, 0, 10_000_000);
      return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: `${clave} debe ser un entero entre 0 y 10000000 centavos.` };
    }
  }
  if (clave === 'limite_banda') {
    const n = enteroEnRango(valor, 0, 10_000_000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'limite_banda inválido.' };
  }
  if (clave === 'meta_ventas_mes') {
    const n = enteroEnRango(valor, 0, 1_000_000_000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'meta_ventas_mes inválido.' };
  }
  if (clave === 'fondo_caja') {
    const n = enteroEnRango(valor, 0, 100_000_000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'fondo_caja debe ser un entero entre 0 y 100000000 centavos.' };
  }
  if (FONDOS_CAJA_CLAVES.has(clave)) {
    if (valor === null) return { ok: true, valor: null };
    const n = enteroEnRango(valor, 0, 100_000_000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: `${clave} debe ser un entero entre 0 y 100000000 centavos o null.` };
  }
  if (clave === CLAVE_TOPE_RETIRO) {
    if (valor === null) return { ok: true, valor: null };
    const n = enteroEnRango(valor, 0, 100_000_000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'tope_retiro debe ser un entero entre 0 y 100000000 centavos o null.' };
  }
  if (clave === 'cupon_porcentaje') {
    const n = enteroEnRango(valor, 1, 200);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'cupon_porcentaje debe estar entre 1 y 200.' };
  }
  if (clave === CLAVE_COMISION) {
    const n = enteroEnRango(valor, 0, LIMITE_COMISION_BP);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: `comision_terminal_pct debe estar entre 0 y ${LIMITE_COMISION_BP} pb.` };
  }
  if (clave === 'recolecciones_desde') {
    const iso = normalizarFechaDesde(valor);
    return iso ? { ok: true, valor: iso } : { ok: false, error: 'recolecciones_desde debe ser una fecha válida.' };
  }
  if (clave === CLAVE_BONO_DESDE) {
    const n = enteroEnRango(valor, 0, 99991231);
    if (n === null || (n !== 0 && !fechaBono(n))) {
      return { ok: false, error: 'bono_tienda_desde debe ser 0 o un lunes real en formato AAAAMMDD.' };
    }
    return { ok: true, valor: String(n) };
  }
  if (LINEAS_BONO_CLAVES.has(clave)) {
    const n = enteroEnRango(valor, 0, 1_000_000_000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: `${clave} debe ser un entero en centavos >= 0.` };
  }
  if (clave === 'bono_tienda_pb' || clave === 'bono_tienda_pb_arriba') {
    const n = enteroEnRango(valor, 0, 10000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: `${clave} debe estar entre 0 y 10000 pb.` };
  }
  if (clave === 'bono_tienda_meta_tope' || clave === 'bono_d_cada') {
    const n = enteroEnRango(valor, 0, 1_000_000_000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: `${clave} inválido.` };
  }
  if (clave === 'bono_d_tope' || clave === 'bono_d_record') {
    const n = enteroEnRango(valor, 0, 100_000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: `${clave} debe estar entre 0 y 100000.` };
  }
  if (clave === 'reto_dias_viejo') {
    const n = enteroEnRango(valor, 0, 3650);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'reto_dias_viejo debe estar entre 0 y 3650 días.' };
  }
  if (clave === 'reto_stock_alto' || clave === 'reto_racha_dias') {
    const n = enteroEnRango(valor, 0, 365);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: `${clave} debe estar entre 0 y 365.` };
  }
  if (['reto_d_viejo', 'reto_d_stock', 'reto_d_racha', 'reto_d_socio', 'reto_d_apartado', 'reto_d_tope_mes'].includes(clave)) {
    const n = enteroEnRango(valor, 0, 100_000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: `${clave} debe estar entre 0 y 100000 Dolarones.` };
  }
  if (clave === 'ml_pct') {
    const n = enteroEnRango(valor, 0, 300);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'ml_pct debe estar entre 0 y 300.' };
  }
  if (clave === 'ml_descuento_referencia') {
    const n = enteroEnRango(valor, 20, 90);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'ml_descuento_referencia debe estar entre 20 y 90.' };
  }
  if (clave === 'ml_tipo_publicacion') {
    return typeof valor === 'string' && ['gold_special', 'gold_pro', 'free'].includes(valor)
      ? { ok: true, valor }
      : { ok: false, error: 'ml_tipo_publicacion inválido.' };
  }
  if (['ropa_ia_activo', 'recortes_activo', 'portadas_activo', 'portadas_aprobacion'].includes(clave)) {
    const b = bandera01(valor);
    return b ? { ok: true, valor: b } : { ok: false, error: `${clave} debe ser 0 o 1.` };
  }
  if (clave === 'portadas_tope_diario') {
    const n = enteroEnRango(valor, 0, 10_000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'portadas_tope_diario debe estar entre 0 y 10000.' };
  }
  if (clave === 'portadas_modelo') {
    return typeof valor === 'string' && ['gemini-3.1-flash-image', 'gemini-nano-banana-2.1'].includes(valor)
      ? { ok: true, valor }
      : { ok: false, error: 'portadas_modelo inválido.' };
  }
  if (clave === 'portadas_tamano') {
    return typeof valor === 'string' && ['1K', '2K'].includes(valor)
      ? { ok: true, valor }
      : { ok: false, error: 'portadas_tamano debe ser 1K o 2K.' };
  }
  if (clave === 'etiqueta_corrimiento') {
    const n = enteroEnRango(valor, -200, 200);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'etiqueta_corrimiento debe estar entre -200 y 200.' };
  }
  if (clave === 'etiqueta_modulo') {
    const n = enteroEnRango(valor, 2, 8);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'etiqueta_modulo debe estar entre 2 y 8.' };
  }
  return { ok: false, error: `Clave de configuración no reconocida: ${clave}.` };
}

function validarEnvClave(clave: string, valor: unknown): { ok: true; valor: string | null } | { ok: false; error: string } {
  if (!ENV_OVERRIDE_SET.has(clave)) {
    return { ok: false, error: `Variable de entorno no editable desde /cm: ${clave}.` };
  }
  if (valor === null) return { ok: true, valor: null };
  if (clave === 'MODELO_ANALISIS') {
    return valor === 'claude' || valor === 'gemini'
      ? { ok: true, valor }
      : { ok: false, error: 'MODELO_ANALISIS debe ser claude o gemini.' };
  }
  if (['BUSQUEDA_WEB', 'PORTAL_REGISTRO_ABIERTO', 'VALES_ABIERTOS', 'REFERIDOS_ABIERTO', 'PREMIOS_APERTURA'].includes(clave)) {
    if (valor === 'si' || valor === true) return { ok: true, valor: 'si' };
    if (valor === '' || valor === false) return { ok: true, valor: '' };
    return { ok: false, error: `${clave} debe ser "si" o "".` };
  }
  if (clave === 'CONTEO_UMBRAL') {
    if (valor === '') return { ok: true, valor: '' };
    const n = enteroEnRango(valor, 0, 10_000_000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'CONTEO_UMBRAL debe estar entre 0 y 10000000 centavos.' };
  }
  if (clave === 'PROMO_CUPO') {
    if (valor === '') return { ok: true, valor: '' };
    const n = enteroEnRango(valor, 0, 1_000_000);
    return n !== null ? { ok: true, valor: String(n) } : { ok: false, error: 'PROMO_CUPO debe estar entre 0 y 1000000.' };
  }
  if (['PROMO_DESDE', 'PROMO_HASTA', 'BUENFIN_DESDE', 'BUENFIN_HASTA', 'PROMO_META_INICIO', 'PROMO_META_FIN', 'PROMO_META_VENCE'].includes(clave)) {
    const iso = normalizarIsoOpcional(valor);
    return iso !== null ? { ok: true, valor: iso } : { ok: false, error: `${clave} debe ser una fecha/hora ISO válida o vacía.` };
  }
  if (clave === 'BUENFIN_TIENDAS') {
    if (typeof valor !== 'string') return { ok: false, error: 'BUENFIN_TIENDAS debe ser texto.' };
    const partes = valor.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!partes.every((p) => esTienda(p))) {
      return { ok: false, error: `BUENFIN_TIENDAS solo acepta claves de tienda válidas (${Object.keys(TIENDAS).join(', ')}).` };
    }
    return { ok: true, valor: [...new Set(partes)].join(',') };
  }
  return { ok: false, error: `Variable no soportada: ${clave}.` };
}

/* ---------- Lectura ---------- */

interface FilaNominaConfig {
  checador_activo: number;
  bono_centavos: number;
  tolerancia_minutos: number;
  retardos_permitidos: number;
  faltas_permitidas: number;
}

const parseJson = (crudo: string | undefined): Record<string, unknown> | null => {
  if (!crudo) return null;
  try { return JSON.parse(crudo) as Record<string, unknown>; } catch { return null; }
};

const valorBaseEnv = (envBase: Env, clave: ClaveEnvOverride): string | null => {
  const crudo = (envBase as unknown as Record<string, unknown>)[clave];
  return typeof crudo === 'string' && crudo !== '' ? crudo : null;
};

async function leerEstadoCm(env: Env, envBase: Env) {
  const { results: filasConfig } = await env.DB.prepare('select clave, valor from config').all<{ clave: string; valor: string }>();
  const mapaConfig = new Map(filasConfig.map((f) => [f.clave, f.valor]));

  const nominaFila = await env.DB.prepare('select * from nomina_config where id = 1').first<FilaNominaConfig>() ?? {
    checador_activo: 0, bono_centavos: 0, tolerancia_minutos: 0, retardos_permitidos: 0, faltas_permitidas: 0,
  };

  const montosExtra = parsearMontosExtra(mapaConfig.get('bandas_extra'));
  const montosActivos = montosBandaActivos(mapaConfig);
  const montosAnteriores = MONTOS_BANDA_ANTERIORES.filter((m) => !montosActivos.includes(m));
  const omisiones: Record<string, string> = { ...DEFAULTS_CONFIG };
  for (const m of montosExtra) omisiones[`banda_${m}`] = String(m * 100);

  const configSalida: Record<string, string | null> = {};
  for (const clave of Object.keys(omisiones)) {
    configSalida[clave] = mapaConfig.get(clave) ?? null;
  }
  configSalida[CLAVE_TOPE_RETIRO] = mapaConfig.get(CLAVE_TOPE_RETIRO) ?? null;
  configSalida.recolecciones_desde = mapaConfig.get('recolecciones_desde') ?? null;
  for (const clave of FONDOS_CAJA_CLAVES) {
    configSalida[clave] = mapaConfig.get(clave) ?? null;
  }

  const envOverrides = ENV_OVERRIDE_CLAVES.map((clave) => {
    const wrangler = valorBaseEnv(envBase, clave);
    const override = mapaConfig.has(`env_${clave}`) ? mapaConfig.get(`env_${clave}`)! : null;
    const efectivo = override !== null ? (override === '' ? null : override) : wrangler;
    const fuente = override !== null ? 'override' : wrangler !== null ? 'wrangler' : 'sin_valor';
    return { clave, efectivo, wrangler, override, fuente };
  });

  const hoy = hoyTienda();
  const historialListo = await env.DB.prepare('select 1 from config_historial limit 0').first().then(() => true, () => false);
  const historial = historialListo
    ? (await env.DB.prepare(
        `select h.id, h.clave, h.origen, h.antes, h.despues, h.cambiado_por,
                u.nombre as cambiado_por_nombre, h.cambiado_en
           from config_historial h
           left join usuarios u on u.correo = h.cambiado_por
          order by h.cambiado_en desc, h.rowid desc limit 50`,
      ).all()).results
    : [];

  return {
    ambiente: envBase.AMBIENTE || 'produccion',
    config: configSalida,
    omisiones,
    nomina: {
      checador_activo: nominaFila.checador_activo === 1,
      bono_centavos: nominaFila.bono_centavos,
      tolerancia_minutos: nominaFila.tolerancia_minutos,
      retardos_permitidos: nominaFila.retardos_permitidos,
      faltas_permitidas: nominaFila.faltas_permitidas,
    },
    env_overrides: envOverrides,
    catalogo: {
      categorias: CATEGORIAS,
      montos_banda: montosActivos,
      montos_anteriores: montosAnteriores,
      montos_extra: montosExtra,
      tiendas: (Object.keys(TIENDAS) as Tienda[]).map((clave) => ({
        clave,
        nombre: TIENDAS[clave].nombre,
        cajas: TIENDAS[clave].cajas.map((c) => ({ nombre: c, clave: claveFondo(c) })),
      })),
    },
    salud: {
      hoy,
      avisos: {
        gemini: parseJson(mapaConfig.get('gemini_ultimo_aviso')),
        portadas: parseJson(mapaConfig.get('portadas_ultimo_aviso')),
        ml_visitas: parseJson(mapaConfig.get('ml_visitas_ultimo_aviso')),
      },
      cuotas: {
        portadas_hoy: Number(mapaConfig.get(`portadas_generadas_${hoy}`) ?? 0),
        portadas_tope: Number(mapaConfig.get('portadas_tope_diario') ?? DEFAULTS_CONFIG.portadas_tope_diario),
        upcitemdb_hoy: Number(mapaConfig.get(`upcitemdb_consultas_${hoy}`) ?? 0),
        upcitemdb_tope: 80,
      },
      cursores: {
        imagenes_relleno_hasta: mapaConfig.get('imagenes_relleno_hasta') ?? null,
        recortes_ajuste_hasta: mapaConfig.get('recortes_ajuste_hasta') ?? null,
      },
      entorno_fijo: {
        bases_version: envBase.BASES_APROBADAS_VERSION ?? null,
        promocion_inicio: envBase.PROMOCION_INICIO ?? null,
        host_portal: envBase.HOST_PORTAL ?? null,
        host_vendedor: envBase.HOST_VENDEDOR ?? null,
        portal_datos_pago_configurado: Boolean(envBase.PORTAL_DATOS_PAGO?.trim()),
        tiene_claude: Boolean(envBase.ANTHROPIC_API_KEY),
        tiene_vertex: Boolean(envBase.VERTEX_API_KEY),
        tiene_gemini: Boolean(envBase.GEMINI_API_KEY || envBase.GEMINI2_API_KEY),
      },
    },
    historial_listo: historialListo,
    historial,
  };
}

/* ---------- Escritura ---------- */

async function guardarCm(request: Request, env: Env, envBase: Env, correo: string): Promise<Response> {
  const cuerpo = await request.json().catch(() => null);
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
    return json({ error: 'Cuerpo JSON inválido.' }, 400);
  }
  const obj = cuerpo as Record<string, unknown>;
  for (const seccion of Object.keys(obj)) {
    if (!['config', 'nomina', 'env'].includes(seccion)) {
      return json({ error: `Sección no válida: ${seccion}.` }, 400);
    }
  }

  const configIn = (obj.config ?? {}) as Record<string, unknown>;
  const nominaIn = (obj.nomina ?? {}) as Record<string, unknown>;
  const envIn = (obj.env ?? {}) as Record<string, unknown>;
  if (typeof configIn !== 'object' || Array.isArray(configIn)
      || typeof nominaIn !== 'object' || Array.isArray(nominaIn)
      || typeof envIn !== 'object' || Array.isArray(envIn)) {
    return json({ error: 'Formato de cambios inválido.' }, 400);
  }

  // 1. Leer estado actual (incluyendo bandas_extra) y validar todo antes de tocar D1.
  const { results: filasActuales } = await env.DB.prepare('select clave, valor from config').all<{ clave: string; valor: string }>();
  const mapaActual = new Map(filasActuales.map((f) => [f.clave, f.valor]));
  const extrasBanda = parsearMontosExtra(mapaActual.get('bandas_extra'));

  const configValidado: [string, string | null][] = [];
  for (const [clave, valor] of Object.entries(configIn)) {
    const r = validarConfigClave(clave, valor, extrasBanda);
    if (!r.ok) return json({ error: r.error }, 400);
    configValidado.push([clave, r.valor]);
  }

  const envValidado: [ClaveEnvOverride, string | null][] = [];
  for (const [clave, valor] of Object.entries(envIn)) {
    const r = validarEnvClave(clave, valor);
    if (!r.ok) return json({ error: r.error }, 400);
    envValidado.push([clave as ClaveEnvOverride, r.valor]);
  }

  const NOMINA_CLAVES = new Set(['checador_activo', 'bono_centavos', 'tolerancia_minutos', 'retardos_permitidos', 'faltas_permitidas']);
  for (const clave of Object.keys(nominaIn)) {
    if (!NOMINA_CLAVES.has(clave)) return json({ error: `Clave de nómina no reconocida: ${clave}.` }, 400);
  }
  if ('checador_activo' in nominaIn && typeof nominaIn.checador_activo !== 'boolean') {
    return json({ error: 'checador_activo debe ser booleano.' }, 400);
  }
  if ('bono_centavos' in nominaIn && enteroEnRango(nominaIn.bono_centavos, 0, 10_000_000) === null) {
    return json({ error: 'bono_centavos debe ser un entero entre 0 y 10000000.' }, 400);
  }
  if ('tolerancia_minutos' in nominaIn && enteroEnRango(nominaIn.tolerancia_minutos, 0, 240) === null) {
    return json({ error: 'tolerancia_minutos debe estar entre 0 y 240.' }, 400);
  }
  if ('retardos_permitidos' in nominaIn && enteroEnRango(nominaIn.retardos_permitidos, 0, 31) === null) {
    return json({ error: 'retardos_permitidos debe estar entre 0 y 31.' }, 400);
  }
  if ('faltas_permitidas' in nominaIn && enteroEnRango(nominaIn.faltas_permitidas, 0, 31) === null) {
    return json({ error: 'faltas_permitidas debe estar entre 0 y 31.' }, 400);
  }

  // 2. Validar ventanas emparejadas y registrar solo diffs reales.

  const efectivoEnvDespues = (clave: ClaveEnvOverride): string | null => {
    const cambio = envValidado.find(([k]) => k === clave);
    if (cambio) {
      return cambio[1] === null ? valorBaseEnv(envBase, clave) : (cambio[1] === '' ? null : cambio[1]);
    }
    if (mapaActual.has(`env_${clave}`)) {
      const v = mapaActual.get(`env_${clave}`)!;
      return v === '' ? null : v;
    }
    return valorBaseEnv(envBase, clave);
  };
  for (const [desdeClave, hastaClave, etiqueta] of [
    ['PROMO_DESDE', 'PROMO_HASTA', 'la promo de inauguración'],
    ['BUENFIN_DESDE', 'BUENFIN_HASTA', 'Buen Fin'],
    ['PROMO_META_INICIO', 'PROMO_META_FIN', 'la promo de meta'],
  ] as [ClaveEnvOverride, ClaveEnvOverride, string][]) {
    const d = efectivoEnvDespues(desdeClave);
    const h = efectivoEnvDespues(hastaClave);
    if (d && h && Date.parse(d) >= Date.parse(h)) {
      return json({ error: `En ${etiqueta}, la fecha de inicio debe ser anterior a la de fin.` }, 400);
    }
  }

  const historialListo = await env.DB.prepare('select 1 from config_historial limit 0').first().then(() => true, () => false);
  const ahora = new Date().toISOString();
  const sentencias: D1PreparedStatement[] = [];
  let guardados = 0;

  const registrarHistorial = (clave: string, origen: 'config' | 'nomina_config' | 'env_override', antes: string | null, despues: string | null) => {
    guardados += 1;
    if (!historialListo) return;
    sentencias.push(
      env.DB.prepare(
        `insert into config_historial (id, clave, origen, antes, despues, cambiado_por, cambiado_en)
         values (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), clave, origen, antes, despues, correo, ahora),
    );
  };

  for (const [clave, valor] of configValidado) {
    const antes = mapaActual.get(clave) ?? null;
    if (valor === null) {
      if (antes === null) continue;
      sentencias.push(env.DB.prepare('delete from config where clave = ?').bind(clave));
      registrarHistorial(clave, 'config', antes, null);
    } else {
      if (antes === valor) continue;
      sentencias.push(
        env.DB.prepare('insert into config (clave, valor) values (?, ?) on conflict (clave) do update set valor = excluded.valor')
          .bind(clave, valor),
      );
      registrarHistorial(clave, 'config', antes, valor);
    }
  }

  for (const [clave, valor] of envValidado) {
    const dbClave = `env_${clave}`;
    const antes = mapaActual.has(dbClave) ? mapaActual.get(dbClave)! : null;
    if (valor === null) {
      if (antes === null) continue;
      sentencias.push(env.DB.prepare('delete from config where clave = ?').bind(dbClave));
      registrarHistorial(clave, 'env_override', antes, null);
    } else {
      if (antes === valor) continue;
      sentencias.push(
        env.DB.prepare('insert into config (clave, valor) values (?, ?) on conflict (clave) do update set valor = excluded.valor')
          .bind(dbClave, valor),
      );
      registrarHistorial(clave, 'env_override', antes, valor);
    }
  }

  if (Object.keys(nominaIn).length > 0) {
    const actual = await env.DB.prepare('select * from nomina_config where id = 1').first<FilaNominaConfig>() ?? {
      checador_activo: 0, bono_centavos: 0, tolerancia_minutos: 0, retardos_permitidos: 0, faltas_permitidas: 0,
    };
    const siguiente: FilaNominaConfig = {
      checador_activo: 'checador_activo' in nominaIn ? (nominaIn.checador_activo ? 1 : 0) : actual.checador_activo,
      bono_centavos: 'bono_centavos' in nominaIn ? Number(nominaIn.bono_centavos) : actual.bono_centavos,
      tolerancia_minutos: 'tolerancia_minutos' in nominaIn ? Number(nominaIn.tolerancia_minutos) : actual.tolerancia_minutos,
      retardos_permitidos: 'retardos_permitidos' in nominaIn ? Number(nominaIn.retardos_permitidos) : actual.retardos_permitidos,
      faltas_permitidas: 'faltas_permitidas' in nominaIn ? Number(nominaIn.faltas_permitidas) : actual.faltas_permitidas,
    };
    const cambiosNomina: [keyof FilaNominaConfig, string, string][] = [];
    for (const k of ['checador_activo', 'bono_centavos', 'tolerancia_minutos', 'retardos_permitidos', 'faltas_permitidas'] as const) {
      if (actual[k] !== siguiente[k]) cambiosNomina.push([k, String(actual[k]), String(siguiente[k])]);
    }
    if (cambiosNomina.length > 0) {
      sentencias.push(
        env.DB.prepare(
          `insert into nomina_config (id, checador_activo, bono_centavos, tolerancia_minutos, retardos_permitidos, faltas_permitidas)
           values (1, ?, ?, ?, ?, ?) on conflict(id) do update set checador_activo=excluded.checador_activo,
             bono_centavos=excluded.bono_centavos, tolerancia_minutos=excluded.tolerancia_minutos,
             retardos_permitidos=excluded.retardos_permitidos, faltas_permitidas=excluded.faltas_permitidas`,
        ).bind(
          siguiente.checador_activo, siguiente.bono_centavos, siguiente.tolerancia_minutos,
          siguiente.retardos_permitidos, siguiente.faltas_permitidas,
        ),
      );
      for (const [k, antes, despues] of cambiosNomina) {
        registrarHistorial(k, 'nomina_config', antes, despues);
      }
    }
  }

  if (sentencias.length > 0) {
    await env.DB.batch(sentencias);
  }

  return json({ ...await leerEstadoCm(env, envBase), guardados });
}

/* ---------- Bandas dinámicas ---------- */

async function agregarBanda(request: Request, env: Env, envBase: Env, correo: string): Promise<Response> {
  const cuerpo = await request.json().catch(() => ({})) as { monto?: unknown };
  const monto = enteroEnRango(cuerpo.monto, 1, 999);
  if (monto === null) {
    return json({ error: 'El monto de la banda debe ser un entero entre $1 y $999 MXN.' }, 400);
  }

  const filaExtra = await env.DB.prepare(`select valor from config where clave = 'bandas_extra'`).first<{ valor: string }>();
  const antesExtra = filaExtra?.valor ?? null;
  const activos = montosBandaActivos({ bandas_extra: antesExtra });
  if (activos.includes(monto)) {
    return json({ error: `Ya existe la banda de $${monto}.` }, 409);
  }

  const { results: familias } = await env.DB.prepare(
    'select clave, nombre, prefijo, propietario from familias order by rowid',
  ).all<{ clave: string; nombre: string; prefijo: string; propietario: string }>();

  const nuevosExtra = [...new Set([...parsearMontosExtra(antesExtra), monto])]
    .filter((m) => !(MONTOS_BANDA as readonly number[]).includes(m))
    .sort((a, b) => a - b);
  const despuesExtra = nuevosExtra.join(',');
  const ahora = new Date().toISOString();
  const clavePrecio = `banda_${monto}`;
  const precioDefecto = monto * 100;
  const historialListo = await env.DB.prepare('select 1 from config_historial limit 0').first().then(() => true, () => false);

  await env.DB.batch([
    env.DB.prepare('insert into config (clave, valor) values (?, ?) on conflict (clave) do update set valor = excluded.valor')
      .bind('bandas_extra', despuesExtra),
    env.DB.prepare('insert into config (clave, valor) values (?, ?) on conflict (clave) do nothing')
      .bind(clavePrecio, String(precioDefecto)),
    ...familias.map((f) => {
      const codigo = `${f.prefijo.toUpperCase()}${monto}`;
      return env.DB.prepare(
        `insert into productos (id, codigo, nombre, categoria, precio_lista, precio, estado_fisico,
                                estado_analisis, destino, stock, sin_inventario, semana_ingreso,
                                foto_key, creado_en, actualizado_en, propietario)
         select ?, ?, ?, 'otros', 0,
                coalesce((select cast(valor as integer) from config where clave = ?), ?),
                'nuevo', 'listo', ?, 0, 1, 'S00', '', '2026-01-01T00:00:00.000Z', ?, ?
         where not exists (select 1 from productos p where p.codigo = ?)`,
      ).bind(
        crypto.randomUUID(), codigo, `${f.nombre} $${monto}`,
        clavePrecio, precioDefecto, `banda_${f.prefijo}${monto}`, ahora, f.propietario, codigo,
      );
    }),
    ...(historialListo ? [
      env.DB.prepare(
        `insert into config_historial (id, clave, origen, antes, despues, cambiado_por, cambiado_en)
         values (?, 'bandas_extra', 'config', ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), antesExtra, despuesExtra, correo, ahora),
    ] : []),
  ]);

  return json({ ...await leerEstadoCm(env, envBase), monto, familias: familias.length }, 201);
}

/* ---------- Enrutador ---------- */

export async function rutaCm(
  request: Request,
  env: Env,
  envBase: Env,
  url: URL,
  correo: string,
  usuario: Usuario | null,
): Promise<Response> {
  if (!usuario?.activo || !usuario.roles.includes('dueno')) {
    return json({ error: 'Solo gerencia puede usar el Centro de Mando.' }, 403);
  }
  if (url.pathname === '/api/cm' && request.method === 'GET') {
    return json(await leerEstadoCm(env, envBase));
  }
  if (url.pathname === '/api/cm' && request.method === 'PUT') {
    return await guardarCm(request, env, envBase, correo);
  }
  if (url.pathname === '/api/cm/bandas' && request.method === 'POST') {
    return await agregarBanda(request, env, envBase, correo);
  }
  if (url.pathname === '/api/cm/historial' && request.method === 'GET') {
    const historialListo = await env.DB.prepare('select 1 from config_historial limit 0').first().then(() => true, () => false);
    if (!historialListo) return json({ historial_listo: false, historial: [] });
    const clave = (url.searchParams.get('clave') ?? '').trim();
    const rawLimit = Number(url.searchParams.get('limit') ?? 50);
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 200 ? rawLimit : 50;
    const { results } = clave
      ? await env.DB.prepare(
          `select h.id, h.clave, h.origen, h.antes, h.despues, h.cambiado_por,
                  u.nombre as cambiado_por_nombre, h.cambiado_en
             from config_historial h
             left join usuarios u on u.correo = h.cambiado_por
            where h.clave = ?
            order by h.cambiado_en desc, h.rowid desc limit ?`,
        ).bind(clave, limit).all()
      : await env.DB.prepare(
          `select h.id, h.clave, h.origen, h.antes, h.despues, h.cambiado_por,
                  u.nombre as cambiado_por_nombre, h.cambiado_en
             from config_historial h
             left join usuarios u on u.correo = h.cambiado_por
            order by h.cambiado_en desc, h.rowid desc limit ?`,
        ).bind(limit).all();
    return json({ historial_listo: true, historial: results });
  }
  return json({ error: 'Método no permitido.' }, 405);
}
