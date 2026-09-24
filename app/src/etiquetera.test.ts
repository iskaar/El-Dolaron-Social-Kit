// node --test src/etiquetera.test.ts
// Solo el trabajo TSPL: el envio por BLE necesita la impresora enfrente y no se
// puede probar aqui. Lo que si se puede es que el texto salga dentro de la
// etiqueta, que es donde se rompio todo lo anterior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tsplEtiqueta, tsplBanda, tsplMarco, tsplPruebaCodigo, partirNombre, NOMBRE_MAX, TSPL_REGLA, TSPL_CALIBRAR } from '../public/etiquetera.js';

const PIEZA = {
  nombre: 'Taza de ceramica azul',
  precio: 12000,
  precio_lista: 19900,
  codigo: 'ED-000123',
  semana_ingreso: '2026-S38',
};

test('el trabajo abre con el tamano de la etiqueta y cierra imprimiendo', () => {
  const tspl = tsplEtiqueta(PIEZA);
  assert.ok(tspl.startsWith('SIZE 50.8 mm,25.4 mm\r\n'));
  assert.ok(tspl.includes('\r\nCLS\r\n'));
  assert.ok(tspl.trimEnd().endsWith('PRINT 1,1'));
});

test('las existencias se imprimen como copias, no como trabajos repetidos', () => {
  const tspl = tsplEtiqueta(PIEZA, 5);
  assert.ok(tspl.trimEnd().endsWith('PRINT 5,1'));
  assert.equal(tspl.match(/^PRINT /gm)?.length, 1);
});

test('el precio va en pesos redondeados, no en centavos', () => {
  assert.ok(tsplEtiqueta(PIEZA).includes('"$120"'));
});

test('el precio de lista se tacha con una barra encima', () => {
  const tspl = tsplEtiqueta(PIEZA);
  assert.ok(tspl.includes('"$199"'));
  assert.ok(/^BAR \d+,\d+,\d+,2$/m.test(tspl));
});

test('sin precio de lista mayor no hay tachado', () => {
  const tspl = tsplEtiqueta({ ...PIEZA, precio_lista: 12000 });
  assert.ok(!tspl.includes('BAR '));
});

test('la barra codifica el numero sin "ED-" ni todos los ceros, como lo espera la caja', () => {
  assert.ok(tsplEtiqueta(PIEZA).includes(',"128",56,0,0,4,8,"0123"'));
  assert.ok(tsplEtiqueta(PIEZA).includes('"ED-000123 - 2026-S38"'));
});

test('un codigo bajo no imprime un codigo128 de un digito', () => {
  // ED-000006 sin relleno seria "6": un Code128 de un solo caracter que el
  // lector de la caja no engancha (confirmado en hardware el 2026-09-22).
  const tspl = tsplEtiqueta({ ...PIEZA, codigo: 'ED-000006' });
  assert.ok(tspl.includes(',"128",56,0,0,4,8,"0006"'));
  assert.ok(!tspl.includes('"6"'));
});

test('un codigo de mas de 4 digitos no se recorta', () => {
  const tspl = tsplEtiqueta({ ...PIEZA, codigo: 'ED-012345' });
  assert.ok(tspl.includes(',"128",56,0,0,4,8,"12345"'));
});

test('el ancho de barra por omision es C (4 pts), no el mas angosto que paso', () => {
  // A, B y C sonaron con el lector el 2026-09-22; se deja en C por margen, no
  // porque A o B fallen.
  assert.ok(!tsplEtiqueta(PIEZA).includes(',0,0,2,4,'));
  assert.ok(tsplEtiqueta(PIEZA, 1, 0, 3).includes(',0,0,3,6,'));
});

test('la prueba de codigo saca las cuatro variantes letradas de /prueba-codigo', () => {
  const tspl = tsplPruebaCodigo();
  assert.equal(tspl.match(/^PRINT 1,1$/gm)?.length, 4);
  for (const [letra, barra, numero] of [
    ['A', 2, 'ED-000019'], ['B', 3, '000019'], ['C', 4, '019'], ['D', 5, '0019'],
  ] as const) {
    assert.ok(tspl.includes(`"${letra}: ${barra} pts = ${barra / 8} mm"`));
    assert.ok(tspl.includes(`,0,0,${barra},${barra * 2},"${numero}"`));
  }
});

test('el corrimiento de calibracion baja todo el contenido igual', () => {
  const sin = tsplEtiqueta(PIEZA, 1, 0);
  const con = tsplEtiqueta(PIEZA, 1, 40);
  const ys = (tspl: string) =>
    [...tspl.matchAll(/^(?:TEXT|BAR|BARCODE) \d+,(\d+),/gm)].map(([, y]) => Number(y));
  assert.deepEqual(ys(con), ys(sin).map((y) => y + 40));
});

test('un corrimiento negativo sube el diseno entero sin encimar renglones', () => {
  // Topar cada coordenada por separado aplastaba el nombre contra el precio.
  const tspl = tsplEtiqueta(PIEZA, 1, -500);
  const ys = [...tspl.matchAll(/^(?:TEXT|BAR|BARCODE) \d+,(-?\d+),/gm)].map(([, y]) => Number(y));
  assert.ok(Math.min(...ys) >= 0, `coordenada y negativa: ${Math.min(...ys)}`);
  const sin = [...tsplEtiqueta(PIEZA, 1, 0).matchAll(/^(?:TEXT|BAR|BARCODE) \d+,(\d+),/gm)]
    .map(([, y]) => Number(y));
  assert.deepEqual(ys, sin.map((y) => y - 8), 'el diseno tiene que subir completo');
});

test('sin calibrar, el corrimiento es cero: no hay numero inventado', () => {
  assert.equal(tsplEtiqueta(PIEZA), tsplEtiqueta(PIEZA, 1, 0));
});

test('nada se sale del ancho de la etiqueta', () => {
  const largo = tsplEtiqueta({ ...PIEZA, nombre: 'Palabra '.repeat(20), precio: 999900 });
  for (const [, x] of largo.matchAll(/^(?:TEXT|BAR|BARCODE) (\d+),/gm)) {
    assert.ok(Number(x) < 406, `coordenada x fuera de la etiqueta: ${x}`);
  }
});

test('las comillas del nombre no parten el comando TEXT en dos', () => {
  const tspl = tsplEtiqueta({ ...PIEZA, nombre: 'Playera 24" azul' });
  for (const linea of tspl.split('\r\n').filter((l) => l.startsWith('TEXT'))) {
    assert.equal(linea.match(/"/g)?.length, 4, `comillas desbalanceadas: ${linea}`);
  }
});

test('los acentos se quitan: la fuente de la impresora no los tiene', () => {
  assert.ok(tsplEtiqueta({ ...PIEZA, nombre: 'Muñeca de peluche' }).includes('Muneca'));
});

test('partirNombre usa dos renglones y no rebasa el ancho', () => {
  const renglones = partirNombre('Cobija matrimonial de invierno color gris jaspeado');
  assert.equal(renglones.length, 2);
  for (const r of renglones) assert.ok(r.length <= NOMBRE_MAX);
});

test('partirNombre corta con ".." lo que no cabe en dos renglones', () => {
  const renglones = partirNombre('palabra '.repeat(30));
  assert.equal(renglones.length, 2);
  assert.ok(renglones[1].endsWith('..'));
});

test('partirNombre parte una sola palabra larguisima en vez de dejarla salirse', () => {
  const [primero] = partirNombre('x'.repeat(NOMBRE_MAX + 20));
  assert.equal(primero.length, NOMBRE_MAX);
});

test('partirNombre nunca devuelve vacio: una etiqueta sin nombre sigue siendo imprimible', () => {
  assert.deepEqual(partirNombre('   '), ['El Dolaron']);
});

test('la calibracion le pide a la impresora que mida el rollo', () => {
  assert.ok(TSPL_CALIBRAR.includes('GAPDETECT'));
  assert.ok(TSPL_CALIBRAR.startsWith('SIZE 50.8 mm,25.4 mm'));
});

test('la regla marca cada 2 mm hasta cubrir la etiqueta', () => {
  const rayas = [...TSPL_REGLA.matchAll(/^BAR 0,(\d+),120,2$/gm)].map(([, y]) => Number(y));
  assert.deepEqual(rayas, Array.from({ length: 13 }, (_, i) => i * 16));
  assert.ok(TSPL_REGLA.includes('"24 mm"'));
  // El marco es la referencia: sin el no se sabe donde cree la impresora que
  // esta la etiqueta, que es justo lo que se esta midiendo.
  assert.ok(TSPL_REGLA.includes('BOX 0,0,405,202,2'));
});

test('el marco de prueba lleva su OFFSET y saca dos etiquetas', () => {
  const tspl = tsplMarco(-5);
  assert.ok(tspl.includes('\r\nOFFSET -5 mm\r\n'));
  assert.ok(tspl.includes('"OFFSET -5 mm"'));
  // Dos: la primera todavia sale con la parada anterior, la segunda es la buena.
  assert.ok(tspl.trimEnd().endsWith('PRINT 2,1'));
});

/* ---------- bandas (docs/PLAN-ETIQUETAS-POR-BANDA.md) ---------- */

const BANDA = { familia: 'General', precioPesos: 49, codigo: 'G49', semana: 'S38' };

test('el trabajo de banda abre con el tamano de la etiqueta y cierra imprimiendo el lote', () => {
  const tspl = tsplBanda(BANDA, 20);
  assert.ok(tspl.startsWith('SIZE 50.8 mm,25.4 mm\r\n'));
  assert.ok(tspl.includes('\r\nCLS\r\n'));
  assert.ok(tspl.trimEnd().endsWith('PRINT 20,1'));
  assert.equal(tspl.match(/^PRINT /gm)?.length, 1);
});

test('la familia va en mayusculas y el precio en pesos, sin nombre de pieza', () => {
  const tspl = tsplBanda(BANDA);
  assert.ok(tspl.includes('"GENERAL"'));
  assert.ok(tspl.includes('"$49"'));
  assert.ok(!tspl.includes('BAR ')); // sin precio de lista que tachar
});

test('el codigo de banda se dibuja completo, no se recorta como el de una pieza', () => {
  const tspl = tsplBanda(BANDA);
  assert.ok(tspl.includes(',"128",48,0,0,4,8,"G49"'));
  assert.ok(tspl.includes('"G49 - S38"'));
});

test('el ancho de barra de banda respeta el mismo parametro que las piezas', () => {
  assert.ok(tsplBanda(BANDA, 1, 0, 3).includes(',0,0,3,6,'));
});

test('el corrimiento de calibracion tambien mueve la banda entera', () => {
  const sin = tsplBanda(BANDA, 1, 0);
  const con = tsplBanda(BANDA, 1, 40);
  const ys = (tspl: string) =>
    [...tspl.matchAll(/^(?:TEXT|BARCODE) \d+,(\d+),/gm)].map(([, y]) => Number(y));
  assert.deepEqual(ys(con), ys(sin).map((y) => y + 40));
});

test('nada de la banda se sale del ancho de la etiqueta', () => {
  const tspl = tsplBanda({ ...BANDA, familia: 'Ropa', precioPesos: 199, codigo: 'R199' });
  for (const [, x] of tspl.matchAll(/^(?:TEXT|BARCODE) (\d+),/gm)) {
    assert.ok(Number(x) < 406, `coordenada x fuera de la etiqueta: ${x}`);
  }
});

test('el historial anota lo que se envio, y un corte se ve como corte', async () => {
  const guardado = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => guardado.get(k) ?? null, setItem: (k: string, v: string) => guardado.set(k, v) };
  const { mandarCopias, historialTexto } = await import('../public/etiquetera.js');
  assert.match(historialTexto(), /Todavia no se ha enviado nada/);
  // Sin impresora conectada mandarTspl devuelve false: nada sale, y asi debe quedar anotado.
  assert.equal(await mandarCopias('x', 3, undefined, 'Taza azul'), false);
  assert.match(historialTexto(), /Taza azul: SE CORTO \(0 de 3\)/);
  delete (globalThis as any).localStorage;
});
