"""Genera las variantes de una tinta del logo de El Dolarón (#433).

Cómo correrlo (desde la raíz del repo, a mano; no forma parte de CI ni de tools/):

    python docs/marca/generar_variantes.py

Requiere Pillow. Lee los tres PNG a color de 01-Logos/, que NO se modifican
(sus hashes se comprueban antes y después), y escribe en 01-Logos/ las siete
variantes monocromáticas. Método: recolor de los píxeles originales, misma
geometría y resolución. La tinta es etiqueta amarilla, azul, rojo; el hueco
(transparente) son las letras «EL», el contorno blanco y el exterior.
No hay capas nativas: las máscaras se infieren por color y la separación de
«EL» es específica de cada archivo (ver HUECO_EL).
"""

from hashlib import sha256
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
LOGOS = ROOT / '01-Logos'
BLACK, WHITE, BLUE = (0, 0, 0), (255, 255, 255), (22, 54, 107)  # azul de Paleta.json
# Modas de color medidas en el horizontal (docs/marca/pruebas/mediciones.json).
COLORS = [(1, 40, 92), (231, 1, 18), (253, 202, 1)]  # azul, rojo, amarillo
# Debajo de esta cobertura el píxel es residuo gris del contorno blanco: no es tinta.
RUIDO = 0.12
# Islas de menos píxeles (alfa >= 32) son trazos sueltos del original (puntos del
# contorno antiguo): no son parte del logo. Las formas reales miden miles.
MIN_ISLA = 300

# Región donde el azul son las letras «EL» (hueco). Cada archivo tiene la suya.
HUECO_EL = {
    'el-dolaron-logo.png': lambda x, y, w, h: x < 350,
    'el-dolaron-logo-vertical.png': lambda x, y, w, h: x < 560 and y < 530,
    'el-dolaron-icono-el.png': lambda x, y, w, h: True,  # todo el azul es «EL»
}
# original -> (base del nombre de salida, {sufijo: color})
VARIANTES = {
    'el-dolaron-logo.png': ('el-dolaron-logo-horizontal', {'negro': BLACK, 'blanco': WHITE, 'azul': BLUE}),
    'el-dolaron-logo-vertical.png': ('el-dolaron-logo-vertical', {'negro': BLACK, 'blanco': WHITE}),
    'el-dolaron-icono-el.png': ('el-dolaron-icono-el', {'negro': BLACK, 'blanco': WHITE}),
}


def mascara(im, es_hueco):
    """Cobertura de tinta 0-255. Desmezcla cada RGB como color + blanco."""
    w, h = im.size
    dirs = [tuple(255 - c for c in col) for col in COLORS]
    norms = [sum(c * c for c in d) for d in dirs]
    out = []
    for i, (r, g, b, a) in enumerate(im.get_flattened_data()):
        if not a:
            out.append(0)
            continue
        delta = (255 - r, 255 - g, 255 - b)
        fits = []
        for d, n in zip(dirs, norms):
            t = max(0, min(1, sum(x * y for x, y in zip(delta, d)) / n))
            fits.append((sum((x - t * y) ** 2 for x, y in zip(delta, d)), t))
        capa = min(range(3), key=lambda j: fits[j][0])
        t = fits[capa][1]
        if capa == 0 and es_hueco(i % w, i // w, w, h):
            out.append(0)
            continue
        t = 0 if t < RUIDO else (t - RUIDO) / (1 - RUIDO)
        out.append(round(a * t))
    m = Image.new('L', im.size)
    m.putdata(out)
    return m


def sin_islas(m):
    """Quita islas pequeñas y el alfa tenue que las rodea; no toca las formas reales."""
    w, h = m.size
    activo = bytearray(m.point(lambda v: 1 if v >= 32 else 0).tobytes())
    mantener = bytearray(w * h)
    for inicio in range(w * h):
        if not activo[inicio]:
            continue
        activo[inicio] = 0
        pila, comp = [inicio], []
        while pila:
            i = pila.pop()
            comp.append(i)
            x = i % w
            for j in (i - 1 if x else -1, i + 1 if x + 1 < w else -1, i - w, i + w):
                if 0 <= j < w * h and activo[j]:
                    activo[j] = 0
                    pila.append(j)
        if len(comp) >= MIN_ISLA:
            for i in comp:
                mantener[i] = 255
    zona = Image.frombytes('L', m.size, bytes(mantener)).filter(ImageFilter.MaxFilter(5))
    return ImageChops.multiply(m, zona.point(lambda v: 255 if v else 0))


def teñir(m, color):
    r = Image.new('RGBA', m.size, color)
    r.putalpha(m)
    return r


def main():
    hashes = {n: sha256((LOGOS / n).read_bytes()).hexdigest() for n in VARIANTES}
    for nombre, (base, variantes) in VARIANTES.items():
        im = Image.open(LOGOS / nombre).convert('RGBA')
        m = sin_islas(mascara(im, HUECO_EL[nombre]))
        alfa = m.tobytes()
        assert any(alfa) and not all(alfa), 'sin tinta o sin hueco'
        for sufijo, color in variantes.items():
            v = teñir(m, color)
            assert v.size == im.size, 'dimensiones distintas al original'
            assert all(p[:3] == color for p in v.get_flattened_data() if p[3]), 'más de una tinta'
            assert v.getchannel('A').tobytes() == alfa, 'máscara distinta entre variantes'
            destino = LOGOS / f'{base}-{sufijo}.png'
            v.save(destino, optimize=True)
            print('ok', destino.relative_to(ROOT), v.size)
    for n, hx in hashes.items():
        assert sha256((LOGOS / n).read_bytes()).hexdigest() == hx, f'original modificado: {n}'
    print('Originales intactos; una tinta + transparencia; dimensiones iguales.')


if __name__ == '__main__':
    main()
