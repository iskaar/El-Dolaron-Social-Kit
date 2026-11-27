// node --test src/ayuda.test.ts: la guía «¿Cómo se hace?» de la caja (#818) no se desfasa de la caja.
// Todo texto entre «» en la guía tiene que existir tal cual en el archivo de su pantalla (mismo principio que manual.test.ts):
// si alguien cambia un botón o un mensaje y no la guía, esta prueba falla.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { CATEGORIAS, ESCENARIOS, FUENTES } from '../public/ayuda-contenido.js';
import { buscar, palabrasDe, partesDe, sinAcentos, FINAL, REGLA } from '../public/ayuda.js';
import { permiso, puede, esDeCaja, type Rol } from './cuentas.ts';
import worker, { permitidaParaVendedor } from './worker.ts';
import { tienda } from './prueba-d1.ts';

type Texto = string | [string, string];
interface Escenario {
  id: string; categoria: string; titulo: string; palabras?: string[]; pasos: string[]; ojo?: string; si_no?: string;
  ver?: string[]; pantalla: string; textos: Texto[]; pendiente?: string;
}
const escenarios = ESCENARIOS as unknown as Escenario[];
const fuentes = FUENTES as Record<string, string>;

const leer = (ruta: string) => readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
const cache = new Map<string, string>();
const fuente = (clave: string) => {
  assert.ok(fuentes[clave], `fuente desconocida: ${clave}`);
  if (!cache.has(clave)) cache.set(clave, leer(fuentes[clave]));
  return cache.get(clave)!;
};

/** Textos declarados de un escenario como [clave de fuente, texto]. */
const declarados = (e: Escenario): [string, string][] => e.textos.map((t) => (Array.isArray(t) ? [t[0], t[1]] : [e.pantalla, t]));
/** Todo lo que el escenario cita entre «». */
const citas = (e: Escenario) => [e.titulo, ...e.pasos, e.ojo ?? '', e.si_no ?? ''].flatMap((t) => [...t.matchAll(/«([^«»]+)»/g)].map((m) => m[1]));
/** Lo que falla: textos declarados que ya no están en su archivo, y citas entre «» que no se declararon. */
function problemas(e: Escenario, leerFuente: (clave: string) => string = fuente): string[] {
  const malos: string[] = [];
  const hechos = new Set(declarados(e).map(([, t]) => t));
  for (const [clave, texto] of declarados(e)) {
    if (!leerFuente(clave).includes(texto)) malos.push(`${e.id}: «${texto}» ya no está en ${fuentes[clave]}`);
  }
  for (const cita of citas(e)) if (!hechos.has(cita)) malos.push(`${e.id}: «${cita}» se cita pero no está en textos`);
  return malos;
}

test('hay un escenario para cada cosa que la guía prometió, repartidos en los diez temas', () => {
  assert.equal(CATEGORIAS.length, 10);
  assert.ok(escenarios.length >= 80, `solo ${escenarios.length} escenarios`);
  for (const c of CATEGORIAS) assert.ok(escenarios.some((e) => e.categoria === c.id), `el tema «${c.titulo}» está vacío`);
  // Lo mínimo del Issue #818: cada uno con su ancla estable.
  for (const id of ['entrar-con-pin', 'elegir-caja', 'marcar-entrada', 'impresora-no-conectada', 'reloj-mal', 'cobrar-efectivo', 'cobrar-tarjeta', 'transferencia-menos-300',
    'transferencia-desde-300', 'etiqueta-no-escanea', 'codigo-no-encontrado', 'pieza-sin-etiqueta', 'varias-iguales', 'bandas-de-precio', 'ya-se-vendio', 'etiqueta-de-mas', 'pieza-caducada', 'es-un-bulto',
    'pago-mixto', 'buscar-socio', 'cliente-es-socio', 'alta-de-socio', 'pagar-con-dolarones', 'codigo-socio-usado', 'pagar-con-vale', 'socio-y-vale', 'reimprimir-vale', 'ya-uso-la-promo',
    'pedir-descuento', 'dueno-no-contesta', 'ticket-cambio-descuento', 'precio-no-coincide', 'cupon-de-dolarones', 'devolver-una-pieza', 'devolver-sin-ticket', 'cancelar-venta-reciente',
    'cancelar-despues-de-5-minutos', 'como-se-regresa-el-dinero', 'dolarones-ya-usados', 'ticket-con-vale-o-anticipo', 'apartar-una-pieza', 'recibir-abono', 'entregar-pedido',
    'pedido-sin-saldo', 'pedido-de-revendedora', 'avisos-de-apartados', 'venta-mercado-libre', 'abrir-cajon', 'gasto-del-cajon', 'retiro-a-caja-fuerte', 'entra-pago-de-terminal',
    'cambio-mal-dado', 'billete-falso', 'falta-cambio', 'hacer-el-corte', 'corte-ventas-sin-sincronizar', 'ventas-rechazadas', 'sobrante-o-faltante', 'reimprimir-el-corte', 'sin-red',
    'ventas-sin-enviar', 'impresora-no-imprime', 'cajon-no-abre', 'lector-no-lee', 'terminal-cobro-no-registro', 'folio-de-otra-venta', 'pide-iniciar-sesion', 'recargue-la-pagina',
    'dos-cajas-misma-pieza', 'pide-factura', 'ticket-por-whatsapp', 'pieza-de-otra-tienda', 'cliente-molesto', 'cuando-llamar-al-encargado'])
    assert.ok(escenarios.some((e) => e.id === id), `falta el escenario ${id}`);
});

test('estructura: ids únicos y estables, de 2 a 6 pasos, ver apunta a escenarios que existen', () => {
  const ids = escenarios.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'hay ids repetidos');
  assert.equal(new Set(CATEGORIAS.map((c) => c.id)).size, CATEGORIAS.length);
  for (const e of escenarios) {
    assert.match(e.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${e.id} no es kebab`);
    assert.ok(CATEGORIAS.some((c) => c.id === e.categoria), `${e.id}: tema desconocido ${e.categoria}`);
    assert.ok(e.titulo.trim().length > 5, `${e.id}: sin título`);
    assert.ok(Array.isArray(e.pasos) && e.pasos.length >= 2 && e.pasos.length <= 6, `${e.id}: ${e.pasos?.length} pasos (van de 2 a 6)`);
    for (const paso of e.pasos) assert.ok(typeof paso === 'string' && paso.trim().length > 5, `${e.id}: paso vacío`);
    for (const otro of e.ver ?? []) {
      assert.ok(ids.includes(otro), `${e.id}: ver apunta a ${otro}, que no existe`);
      assert.notEqual(otro, e.id, `${e.id} se apunta a sí mismo`);
    }
    assert.ok(fuentes[e.pantalla], `${e.id}: pantalla desconocida ${e.pantalla}`);
    assert.ok(Array.isArray(e.textos), `${e.id}: falta textos`);
    for (const t of e.textos) assert.ok(typeof t === 'string' ? t : (fuentes[t[0]] && t[1]), `${e.id}: texto mal declarado ${JSON.stringify(t)}`);
    if (e.pendiente !== undefined) assert.match(e.pendiente, /^(?:¿.{15,}\?|Falta en la caja: .{15,}\.)$/, `${e.id}: la pendiente es una pregunta para gerencia o «Falta en la caja: …»`);
  }
  for (const [, ruta] of Object.entries(fuentes)) assert.ok(existsSync(ruta), `${ruta} no existe`);
});

test('todo texto entre «» existe tal cual en el archivo de su pantalla (si cambia un botón o un mensaje, esto falla)', () => {
  const malos = escenarios.flatMap((e) => problemas(e));
  assert.deepEqual(malos, [], malos.join('\n'));
  // Sin «» anidadas ni sueltas: cada « cierra con su ».
  for (const e of escenarios) for (const t of [e.titulo, ...e.pasos, e.ojo ?? '', e.si_no ?? '']) {
    assert.equal(t.replace(/«[^«»]+»/g, '').match(/[«»]/g), null, `${e.id}: «» mal cerradas en «${t}»`);
  }
});

test('la prueba sí falla: un texto que ya no existe en la pantalla, o una cita sin declarar, se detectan', () => {
  const e = escenarios.find((x) => x.id === 'cobrar-efectivo')!;
  assert.deepEqual(problemas(e), []);
  // La pantalla ya no trae los textos: todos los declarados quedan como faltantes.
  const faltan = problemas(e, () => 'una caja sin esos botones');
  assert.equal(faltan.length, declarados(e).length);
  // Una cita nueva en un paso sin declararla en textos.
  const cita = problemas({ ...e, pasos: [...e.pasos, 'Toca «Botón que no existe».'] });
  assert.equal(cita.length, 1);
  assert.match(cita[0], /se cita pero no está en textos/);
  // Un texto declarado pero que no está en el archivo.
  const falso = problemas({ ...e, textos: [...e.textos, 'Botón que no existe'] });
  assert.equal(falso.length, 1);
  assert.match(falso[0], /ya no está en public\/caja\.html/);
});

test('el final de cada tarjeta manda a «Ayuda» y la regla pendiente se muestra como pregunta al encargado', () => {
  assert.equal(FINAL, '¿No se resolvió? Toca «Ayuda» y viene el encargado.');
  assert.equal(REGLA, 'Regla de la tienda: pregunta al encargado.');
  assert.ok(leer('public/caja.html').includes('>Ayuda</button>'), 'el botón rojo «Ayuda» sigue en la caja');
});

test('el repositorio es público: sin nombres, teléfonos, correos ni enlaces; solo datos de ejemplo evidentes', () => {
  const texto = JSON.stringify(escenarios);
  assert.ok(!/@/.test(texto), 'hay un @ (correo)');
  assert.ok(!/https?:\/\//i.test(texto), 'hay un enlace');
  assert.ok(!/(?<!\d)(?:\d[ -]?){9}\d(?!\d)/.test(texto.replace(/\$[\d,]+/g, '')), 'hay una secuencia de 10 dígitos (teléfono)');
  assert.ok(!/\d{12,}/.test(texto), 'hay una secuencia larga de dígitos');
  for (const nombre of ['Isaac', 'Grecia', 'Soledad Jardín', 'CLABE']) assert.ok(!texto.includes(nombre), `aparece «${nombre}»`);
  // Los ejemplos de folios y códigos son los de siempre.
  for (const ejemplo of texto.match(/\b(?:ED|P)-\d+\b/g) ?? []) assert.ok(['ED-009001', 'P-17'].includes(ejemplo), `ejemplo inesperado ${ejemplo}`);
  // No se describe cómo saltarse un control.
  for (const prohibido of [/saltar/i, /evitar el límite/i, /sin que se note/i, /truco/i]) assert.ok(!prohibido.test(texto), String(prohibido));
});

test('buscar: sin acentos ni mayúsculas, todas las palabras, el título primero', () => {
  assert.equal(sinAcentos('DEVOLUCIÓN Ñandú'), 'devolucion nandu');
  assert.deepEqual(palabrasDe('Devoluciones de piezas'), ['devolucion', 'de', 'pieza']);
  const ids = (texto: string, categoria = '') => buscar(escenarios, texto, categoria).map((e) => e.id);
  // Sin texto: todo, en su orden.
  assert.equal(ids('').length, escenarios.length);
  assert.deepEqual(ids(''), escenarios.map((e) => e.id));
  // Sin acentos y sin mayúsculas encuentra lo mismo.
  assert.deepEqual(ids('DEVOLUCION'), ids('devolución'));
  assert.equal(ids('devolucion')[0], 'devolver-una-pieza');
  // Por sinónimo y por palabra del paso.
  assert.ok(ids('pistola').includes('lector-no-lee'));
  assert.ok(ids('escaner').includes('lector-no-lee'));
  assert.ok(ids('efectivo recibido').includes('cobrar-efectivo'));
  // Plural y singular son lo mismo.
  assert.deepEqual(ids('tarjetas'), ids('tarjeta'));
  // Todas las palabras tienen que estar (en cualquier orden).
  assert.ok(ids('tarjeta terminal').includes('cobrar-tarjeta'));
  assert.deepEqual(ids('terminal tarjeta'), ids('tarjeta terminal'));
  assert.equal(ids('xyzzy').length, 0);
  assert.ok(ids('tarjeta xyzzy').length === 0);
  // Los temas filtran.
  assert.ok(ids('', 'corte').every((id) => escenarios.find((e) => e.id === id)!.categoria === 'corte'));
  assert.equal(ids('tarjeta', 'corte').includes('cobrar-tarjeta'), false);
  // Los símbolos de las pantallas también se buscan.
  assert.ok(ids('$300').includes('transferencia-desde-300'));
  assert.ok(ids('p-17').includes('entregar-pedido'));
  // La búsqueda no altera la lista original.
  assert.equal(escenarios[0].id, 'entrar-con-pin');
});

test('partesDe separa lo que dice la pantalla (entre «») del resto, sin perder ni un carácter', () => {
  assert.deepEqual(partesDe('Toca «Cobrar» y espera.'), [
    { texto: 'Toca ', ui: false }, { texto: '«Cobrar»', ui: true }, { texto: ' y espera.', ui: false }]);
  assert.deepEqual(partesDe('Sin comillas'), [{ texto: 'Sin comillas', ui: false }]);
  assert.deepEqual(partesDe(''), []);
  for (const e of escenarios) for (const t of e.pasos) assert.equal(partesDe(t).map((p) => p.texto).join(''), t);
  // Un texto raro nunca es HTML: el render usa textContent, así que esto solo se comprueba como dato.
  assert.deepEqual(partesDe('<b>«x»</b>').map((p) => p.texto), ['<b>', '«x»', '</b>']);
});

test('ayuda.js: sin red, sin HTML armado a mano, accesible y sin tocar la venta', () => {
  const js = leer('public/ayuda.js') + leer('public/ayuda-contenido.js');
  for (const prohibido of ['fetch(', '/api/', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'XMLHttpRequest', 'sendBeacon', 'localStorage', 'indexedDB']) {
    assert.ok(!js.includes(prohibido), `ayuda no debe contener ${prohibido}`);
  }
  assert.ok(!/(?:src|href)=["']https?:/.test(js) && !/url\(\s*['"]?https?:/.test(js));
  const render = leer('public/ayuda.js');
  assert.match(render, /<style|createElement\('style'\)|doc\.createElement\('style'\)/);
  assert.match(render, /focus-visible/, 'foco visible');
  assert.match(render, /aria-live/);
  assert.match(render, /type: 'search'/);
  // Enter en el buscador no hace nada destructivo: solo lleva a la primera respuesta.
  assert.match(render, /ev\.key !== 'Enter'[\s\S]*?preventDefault\(\)[\s\S]*?focus\(\)/);
  // El renderer pinta títulos de verdad (h2/h3/h4) y botones, no solo divs.
  assert.match(render, /h\$\{nivel\}/);
  assert.match(render, /h\$\{nivel \+ 1\}/);
  assert.match(render, /'details'/);
});

test('/ayuda.html: página sola, con la misma guía, sin API ni dependencias', () => {
  const html = leer('public/ayuda.html');
  assert.match(html, /<h1>¿Cómo se hace\?<\/h1>/);
  assert.match(html, /import\('\/ayuda\.js'\)/);
  assert.match(html, /name="viewport"/);
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'hay un manejador en línea (onclick, etc.)');
  assert.ok(!/(?:src|href)="https?:/.test(html));
  assert.ok(!html.includes('fetch(') && !html.includes('/api/'));
  // Sin dependencias nuevas.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies ?? {}), ['@anthropic-ai/sdk']);
});

test('/caja: un botón «¿Cómo se hace?», un cuadro modal con F1 y el foco regresa al código', () => {
  const caja = leer('public/caja.html');
  assert.match(caja, /<button id="abrir-guia" type="button"[^>]*>¿Cómo se hace\?<\/button>/);
  assert.match(caja, /<dialog id="dialogo-guia"/);
  assert.match(caja, /import\('\/ayuda\.js'\)\)\.montarAyuda\(/);   // se baja la primera vez
  assert.match(caja, /guia\.showModal\(\)/);                          // modal: lo que se escanea no llega a la venta
  assert.match(caja, /e\.key !== 'F1'/);
  assert.match(caja, /guia\.addEventListener\('close', \(\) => document\.getElementById\('codigo'\)\.focus\(\)\)/);
  // Los apartados se alcanzan desde el encabezado de la caja (la computadora de caja no ve el menú de inicio) y la guía lo dice.
  assert.match(caja, /<a href="\/pedidos">Apartados<\/a>/);
  for (const e of escenarios) assert.ok(!JSON.stringify(e).includes('/pedidos)') && !JSON.stringify(e).includes('dirección es'), `${e.id} manda a escribir la dirección /pedidos`);
  for (const rol of ['cajero', 'computadora', 'dueno'] as Rol[]) assert.equal(puede(cuenta(rol), permiso('/pedidos', 'GET')), true, `/pedidos ${rol}`);
  assert.equal(esDeCaja(permiso('/pedidos', 'GET')), true);
  // La caja no importa la guía de forma estática: sin ella, la caja abre igual.
  assert.ok(!/from '\/ayuda/.test(caja));
});

test('sin red: la guía va en el service worker de la caja', () => {
  const sw = leer('public/sw-caja.js');
  const rutas: string[] = JSON.parse(sw.match(/const RUTAS = (\[[^\]]*\])/)![1].replace(/'/g, '"'));
  assert.ok(rutas.includes('/ayuda.js') && rutas.includes('/ayuda-contenido.js'));
  // Cada módulo que importa la guía también tiene copia.
  for (const [, modulo] of leer('public/ayuda.js').matchAll(/from '(\.?\/[^']+\.js)'/g)) assert.ok(rutas.includes(modulo.replace(/^\./, '')), `${modulo} falta en RUTAS`);
  assert.match(sw, /const CACHE = 'caja-v4'/);
});

const cuenta = (...roles: Rol[]) => ({ correo: 'x@prueba.mx', nombre: '', caja: '', activo: true, editar_inventario: false, roles });

test('/ayuda abre para la caja, la computadora de caja, el capturista y gerencia; cierra para el resto', () => {
  for (const ruta of ['/ayuda', '/ayuda.html']) {
    const regla = permiso(ruta, 'GET');
    for (const rol of ['cajero', 'computadora', 'capturista', 'dueno'] as Rol[]) assert.equal(puede(cuenta(rol), regla), true, `${ruta} ${rol}`);
    for (const rol of ['finanzas', 'auxiliar', 'revendedora', 'inversionista'] as Rol[]) assert.equal(puede(cuenta(rol), regla), false, `${ruta} ${rol}`);
    assert.equal(puede(null, regla), false);
    assert.equal(puede({ ...cuenta('cajero'), activo: false }, regla), false);
    // Como el resto de la caja: la regla se compara por identidad, así que la computadora sigue necesitando el PIN en la API.
    assert.equal(esDeCaja(regla), true);
  }
  // La guía no tiene API propia: sus módulos son código sin datos.
  assert.equal(permiso('/ayuda.js', 'GET'), 'cuenta');
  assert.equal(permiso('/ayuda-contenido.js', 'GET'), 'cuenta');
});

test('el host del portal público y el del capturista en el celular no sirven /ayuda', async () => {
  const { env, ctx } = tienda();
  env.HOST_PORTAL = 'portal.prueba';
  let leidos = 0;
  (env as any).ASSETS = { fetch: async () => { leidos++; return new Response('x'); } };
  for (const ruta of ['/ayuda', '/ayuda.html', '/ayuda/', '/ayuda.js', '/ayuda-contenido.js', '/ayuda#entrar-con-pin']) {
    const r = await worker.fetch!(new Request('https://portal.prueba' + ruta) as never, env, ctx as never);
    assert.equal(r.status, 404, ruta);
  }
  assert.equal(leidos, 0, 'el portal no debe leer assets de la guía');
  // Host del capturista (celular): lo que no está en su lista de rutas da 404; por omisión la guía no está.
  for (const ruta of ['/ayuda', '/ayuda.html', '/ayuda.js', '/ayuda-contenido.js']) assert.equal(permitidaParaVendedor(ruta, 'GET'), false, ruta);
});

test('#956 el escenario del pago mixto enseña el botón «Mixto» y ya no manda a cobrar en dos tickets', () => {
  const ids = (texto: string) => buscar(escenarios, texto, '').map((e) => e.id);
  const e = escenarios.find((x) => x.id === 'pago-mixto')!;
  const dicho = [e.titulo, ...e.pasos, e.ojo ?? ''].join(' ');
  assert.ok(e.pasos.some((p) => p.includes('«Mixto»')), 'un paso toca «Mixto»');
  assert.ok(e.pasos.some((p) => p.includes('«Efectivo recibido»')), 'un paso dice dónde escribir el efectivo');
  assert.ok(e.textos.includes('Mixto'), '«Mixto» se comprueba contra la pantalla de la caja');
  assert.match(dicho, /terminal/);
  assert.match(e.ojo ?? '', /no se corrige: cancélalo y vuelve a cobrar/);
  assert.match(e.ojo ?? '', /siempre en efectivo/);
  assert.doesNotMatch(dicho, /solo lleva una forma de pago|otro ticket|dos tickets/i);
  assert.ok(ids('mixto').includes('pago-mixto'));
  assert.ok(ids('parte en efectivo').includes('pago-mixto'));
  // Nadie más en la guía dice que un ticket lleva una sola forma de pago.
  for (const x of escenarios) assert.doesNotMatch([...x.pasos, x.ojo ?? ''].join(' '), /solo lleva una forma de pago/, x.id);
  // Quien corrige formas de pago sabe que un mixto no se corrige.
  assert.match(escenarios.find((x) => x.id === 'corregir-forma-de-pago')!.ojo!, /Un ticket mixto/);
});
