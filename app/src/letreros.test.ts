// node --test src/letreros.test.ts
// Letrero del plano (#737): una prueba por renglon de la tabla del Issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { letrero } from '../public/letreros.js';

const casos = (categoria: string, filas: [number, string[]][]) =>
  filas.flatMap(([esperado, nombres]) => nombres.map((nombre) => ({ categoria, nombre, esperado })));

const TABLA = [
  // ropa: calzado, interior, ninos, caballero y dama; colgada contra doblada
  ...casos('ropa', [
    [21, ['Tenis Nike', 'Zapatos de vestir', 'Botas vaqueras', 'Sandalias Havaianas', 'Pantuflas']],
    [8, ['Brasier Auden', 'Bra deportivo', 'Calzones', 'Panty', 'Boxer Hanes', 'Trusa', 'Calcetines Hanes', 'Calcetas']],
    [23, ['Playera niño', 'Vestido niña', 'Conjunto bebé', 'Pants Boys']],
    // Todo lo de caballero va al rack 4, colgado o doblado (#762: el 22 ya es solo cabello).
    [4, ['Camisa caballero', 'Chamarra hombre', 'Saco Goodfellow & Co', 'Playera caballero', 'Pantalón hombre', 'Jeans Original Use']],
    [3, ['Blusa Universal Thread', 'Camisa', 'Vestido', 'Falda', 'Chamarra', 'Saco', 'Abrigo']],
    [15, ['Playera Wild Fable', 'Jeans', 'Sudadera', 'Short', 'Ropa']],
  ]),
  ...casos('accesorios', [[7, ['Collar', 'Aretes', 'Pulsera', 'Anillo', 'Joyería']], [14, ['Bolsa', 'Cartera', '']]]),
  ...casos('belleza', [[5, ['Labial', 'Rímel', 'Base líquida', 'Sombras', 'Delineador', 'Rubor', 'Maquillaje']], [8, ['Esmalte', 'Uñas postizas']],
    [22, ['Cabello', 'Shampoo', 'Champú', 'Acondicionador', 'Tinte', 'Cepillo', 'Peine', 'Plancha', 'Secadora', 'Rizador', 'Tenazas', 'Spray para el pelo']],
    [10, ['Crema', 'Perfume', '']]]),
  ...casos('hogar', [
    [35, ['Toalla de playa Mickey']], [33, ['Toalla', 'Cobija']], [34, ['Almohada', 'Funda']],
    [19, ['Sábana', 'Edredón', 'Colcha', 'Cortina']], [12, ['Cuadro', 'Vela', 'Florero', 'Adorno', 'Marco', 'Decoración']],
    [20, ['Organizador', 'Contenedor', 'Cesto', 'Canasta']], [28, ['Asador', 'Parrilla']],
    [31, ['Silla', 'Mesa', 'Buró', 'Librero', 'Mueble']], [32, ['Colchón']], [11, ['Taza', 'Olla']],
  ]),
  ...casos('jardin', [[30, ['Maceta', '']]]),
  ...casos('electronica', [[36, ['Letrero de neón']], [29, ['Herramienta', 'Taladro', 'Desarmador', 'Auto', 'Carro de control']], [13, ['Bocina']]]),
  ...casos('juguetes', [[7, ['Peluche']], [16, ['Manualidades', 'Burbujas', 'Pistola de agua']], [18, ['Fiesta', 'Globo', 'Piñata']], [24, ['Muñeca']]]),
  ...casos('mascotas', [[29, ['Correa', '']]]),
  ...casos('papeleria', [[36, ['Pizarrón']], [17, ['Cuaderno']]]),
  ...casos('despensa', [
    [20, ['Detergente', 'Limpiador', 'Cloro', 'Desinfectante', 'Jabón para trastes']],
    [27, ['Desechable', 'Servilletas', 'Bolsa de basura', 'Aluminio', 'Popotes']], [26, ['Galletas']],
  ]),
  ...casos('deportes', [[25, ['Balón', '']]]),
  ...casos('otros', [[25, ['Cosa', '']]]),
];

test('cada renglon de la tabla del Issue da su letrero', () => {
  for (const { categoria, nombre, esperado } of TABLA) assert.equal(letrero({ categoria, nombre }), esperado, `${categoria}: «${nombre}»`);
});

test('sin acentos, sin mayusculas y con plural da lo mismo', () => {
  assert.equal(letrero({ categoria: 'ropa', nombre: 'BRASIER' }), 8);
  assert.equal(letrero({ categoria: 'hogar', nombre: 'SABANA' }), letrero({ categoria: 'hogar', nombre: 'sábana' }));
  assert.equal(letrero({ categoria: 'HOGAR', nombre: 'Cobijas' }), 33);
  assert.equal(letrero({ categoria: 'belleza', nombre: 'Uñas' }), 8);
});

test('lo mas especifico gana: toalla de playa antes que toalla, calzado antes que ninos', () => {
  assert.equal(letrero({ categoria: 'hogar', nombre: 'Toalla de playa grande' }), 35);
  assert.equal(letrero({ categoria: 'hogar', nombre: 'Toalla de baño' }), 33);
  assert.equal(letrero({ categoria: 'ropa', nombre: 'Tenis niño', talla: 'Niño 15' }), 21);
  assert.equal(letrero({ categoria: 'ropa', nombre: 'Calcetines niña' }), 8);
});

test('ropa: la marca y la talla tambien deciden', () => {
  assert.equal(letrero({ categoria: 'ropa', nombre: 'Playera', marca: 'Cat & Jack' }), 23);
  assert.equal(letrero({ categoria: 'ropa', nombre: 'Playera Cat & Jack' }), 23);
  assert.equal(letrero({ categoria: 'ropa', nombre: 'Blusa', marca: 'Art Class' }), 23);
  assert.equal(letrero({ categoria: 'ropa', nombre: 'Playera', talla: 'Niño 6 años / S' }), 23);
  assert.equal(letrero({ categoria: 'ropa', nombre: 'Camisa', marca: 'Goodfellow & Co' }), 4);
  assert.equal(letrero({ categoria: 'ropa', nombre: 'Playera', marca: 'Original Use' }), 4);
  assert.equal(letrero({ categoria: 'ropa', nombre: 'Playera', marca: 'Universal Thread', talla: 'M' }), 15);
  // «mens» no es «womens»
  assert.equal(letrero({ categoria: 'ropa', nombre: "Women's Blusa" }), 3);
});

test('cabello va al 22 pero maquillaje y uñas ganan; caballero doblada va al 4; calzado sigue en el 21', () => {
  assert.equal(letrero({ categoria: 'belleza', nombre: 'Cepillo de maquillaje' }), 5);
  assert.equal(letrero({ categoria: 'belleza', nombre: 'Cepillo para uñas' }), 8);
  assert.equal(letrero({ categoria: 'belleza', nombre: 'Peluche' }), 10);   // «pelo» no es «peluche»
  assert.equal(letrero({ categoria: 'ropa', nombre: 'Pantalón caballero doblado' }), 4);
  assert.equal(letrero({ categoria: 'ropa', nombre: 'Zapatos caballero' }), 21);
});

test('la ropa capturada con precio de ropa tambien es ropa aunque no traiga categoria', () => {
  assert.equal(letrero({ precio_ropa: 10000, nombre: 'Vestido' } as never), 3);
});

test('palabra completa: «bra» no es «brazalete» ni «mesa» es «mesadas»', () => {
  assert.equal(letrero({ categoria: 'ropa', nombre: 'Brazalete' }), 15);
  assert.equal(letrero({ categoria: 'hogar', nombre: 'Mesadas' }), 11);
});

test('siempre devuelve un entero de 1 a 36, con o sin datos', () => {
  for (const pieza of [undefined, null, {}, { categoria: 'nada', nombre: 'x' }, { categoria: null, nombre: null, marca: null, talla: null }, ...TABLA]) {
    const n = letrero(pieza as never);
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 36, String(n));
  }
  assert.equal(letrero(undefined as never), 25);
  assert.equal(letrero({}), 25);
});
