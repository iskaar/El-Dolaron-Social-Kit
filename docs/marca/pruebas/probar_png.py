"""Experimento #433, no generador de assets oficiales. Usa Pillow ya instalado.

Ejecutar desde la raíz: python docs/marca/pruebas/probar_png.py
No lee secretos, no escribe fuera de esta carpeta, no modifica los originales.
"""

from collections import Counter
from hashlib import sha256
from itertools import combinations
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
NAVY = (22, 54, 107)
WHITE = (255, 255, 255)
# Modas medidas en los píxeles de color del horizontal, no colores objetivo.
COLORS = [(1, 40, 92), (231, 1, 18), (253, 202, 1)]


def components(alpha):
    """Islas con conectividad de cuatro vecinos, a alfa >=128."""
    w, h = alpha.size
    remaining = bytearray(alpha.point(lambda v: 1 if v >= 128 else 0).tobytes())
    areas = []
    for start, active in enumerate(remaining):
        if not active:
            continue
        remaining[start] = 0
        stack, area = [start], 0
        while stack:
            i = stack.pop()
            area += 1
            x = i % w
            neighbors = []
            if x: neighbors.append(i - 1)
            if x + 1 < w: neighbors.append(i + 1)
            if i >= w: neighbors.append(i - w)
            if i + w < w * h: neighbors.append(i + w)
            for j in neighbors:
                if remaining[j]:
                    remaining[j] = 0
                    stack.append(j)
        areas.append(area)
    return {'count': len(areas), 'largest_areas': sorted(areas, reverse=True)[:5],
            'islands_le_16px': sum(n <= 16 for n in areas),
            'pixels_in_islands_le_16px': sum(n for n in areas if n <= 16)}


def analyze(path):
    im = Image.open(path).convert('RGBA')
    px = list(im.get_flattened_data())
    a = Counter(p[3] for p in px)
    visible = Counter(p[:3] for p in px if p[3] >= 128)
    families = {
        'azul': lambda r, g, b: b > r + 20 and b > g + 15,
        'rojo': lambda r, g, b: r > g + 60 and r > b + 50,
        'amarillo': lambda r, g, b: r > 150 and g > 100 and b < 100,
        'blanco': lambda r, g, b: min(r, g, b) > 220,
    }
    return {
        'sha256': sha256(path.read_bytes()).hexdigest(),
        'size': im.size, 'alpha_bbox': im.getchannel('A').getbbox(),
        'alpha_zero': a[0], 'alpha_full': a[255],
        'alpha_partial': sum(n for v, n in a.items() if 0 < v < 255),
        'alpha_modes': a.most_common(5), 'rgb_modes_alpha_ge_128': visible.most_common(5),
        'components_alpha_ge_128': components(im.getchannel('A')),
        'exact_palette_alpha_ge_128': {
            str(c): visible[c] for c in [NAVY, (215, 43, 50), (255, 212, 71), WHITE]
        },
        'families_alpha_ge_128': {
            name: {'pixels': sum(n for c, n in visible.items() if fn(*c)),
                   'mode': next(((c, n) for c, n in visible.most_common() if fn(*c)), None)}
            for name, fn in families.items()
        },
    }


def ink_mask(im):
    """Desmezcla cada RGB como color + blanco; blanco no imprime.

    La asignación de capas es inferida, no hay capas nativas. En ESTE horizontal
    el azul de EL termina antes de x=350 y la D empieza después: esos píxeles
    azules son hueco. No cambia posiciones, proporciones ni añade trazos.
    No aplica limpieza morfológica: conserva defectos de la fuente.
    """
    directions = [tuple(255 - c for c in color) for color in COLORS]
    norms = [sum(c * c for c in direction) for direction in directions]
    output = []
    for i, (r, g, b, a) in enumerate(im.get_flattened_data()):
        if not a:
            output.append(0)
            continue
        delta = (255 - r, 255 - g, 255 - b)
        fits = []
        for direction, norm in zip(directions, norms):
            t = max(0, min(1, sum(x * y for x, y in zip(delta, direction)) / norm))
            residual = sum((x - t * y) ** 2 for x, y in zip(delta, direction))
            fits.append((residual, t))
        layer = min(range(3), key=lambda j: fits[j][0])
        coverage = fits[layer][1]
        output.append(0 if layer == 0 and i % im.width < 350 else round(a * coverage))
    mask = Image.new('L', im.size)
    mask.putdata(output)
    return mask


def tinted(mask, color):
    result = Image.new('RGBA', mask.size, color)
    result.putalpha(mask)
    return result


def luminance(hex_color):
    channels = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in channels]
    return sum(w * v for w, v in zip((.2126, .7152, .0722), linear))


def main():
    sources = sorted((ROOT / '01-Logos').glob('*.png'))
    data = {p.name: analyze(p) for p in sources}
    palette = json.loads((ROOT / '05-Guia-y-textos/Paleta.json').read_text(encoding='utf-8'))
    data['contrast'] = []
    for a, b in combinations(('navy', 'red', 'yellow', 'white'), 2):
        light, dark = sorted((luminance(palette[a]), luminance(palette[b])), reverse=True)
        ratio = (light + .05) / (dark + .05)
        data['contrast'].append({'pair': [a, b], 'ratio': ratio, 'AA_normal': ratio >= 4.5, 'AA_large': ratio >= 3})

    original = Image.open(ROOT / '01-Logos/el-dolaron-logo.png').convert('RGBA')
    mask = ink_mask(original)
    black, white = tinted(mask, (0, 0, 0)), tinted(mask, WHITE)
    black.save(OUT / 'prueba-horizontal-negra.png')
    white.save(OUT / 'prueba-horizontal-blanca.png')
    # Muestras interiores: EL hueco; etiqueta, D, subrayado: tinta; fondo: hueco.
    assert mask.getpixel((100, 250)) == 0
    assert mask.getpixel((30, 250)) > 240
    assert mask.getpixel((400, 250)) > 240
    assert mask.getpixel((1000, 460)) > 240
    assert mask.getpixel((1000, 0)) == 0
    assert black.getchannel('A').tobytes() == white.getchannel('A').tobytes()
    assert original.size == black.size == white.size
    assert luminance('#FFFFFF') == 1 and luminance('#000000') == 0

    font = ImageFont.load_default(size=20)
    board = Image.new('RGB', (1200, 800), '#eeeeee')
    draw = ImageDraw.Draw(board)
    for y, bg, img, label in [
        (0, NAVY, original, 'Original sobre azul: contorno blanco y residuos'),
        (250, NAVY, white, 'Prueba blanca: etiqueta en tinta / EL en hueco'),
        (500, WHITE, black, 'Prueba negra: misma mascara, sin blanco impreso'),
    ]:
        draw.rectangle((0, y, 1200, y + 240), fill=bg)
        draw.text((25, y + 12), label, font=font, fill=WHITE if bg == NAVY else NAVY)
        small = img.resize((780, 204), Image.Resampling.LANCZOS)
        board.paste(small, (25, y + 36), small)
        small = img.resize((290, 76), Image.Resampling.LANCZOS)
        board.paste(small, (870, y + 120), small)
    draw.text((25, 764), 'SOLO INVESTIGACION #433. No son artes finales.', fill=NAVY, font=font)
    board.save(OUT / 'comparacion-sobre-fondos.png')

    # Tamaño real en píxeles, sin dithering: no simula calor, papel ni mecánica.
    thermal = Image.new('RGB', (1340, 900), WHITE)
    d = ImageDraw.Draw(thermal)
    d.text((20, 10), '203 dpi: muestras 1 bit; cada pixel de muestra = un punto del cabezal', font=font, fill=0)
    for y, width in [(65, 406), (340, 320), (615, 240)]:
        resized = mask.resize((width, round(mask.height * width / mask.width)), Image.Resampling.LANCZOS)
        bit = resized.point(lambda v: 255 if v >= 128 else 0)
        assert set(bit.get_flattened_data()) <= {0, 255}
        tile = Image.new('RGB', bit.size, 'white')
        tile.paste('black', (0, 0, *bit.size), bit)
        thermal.paste(tile, (20, y + 30))
        d.text((20, y), f'{width} puntos = {width / 203 * 25.4:.2f} mm de ancho', font=font, fill=0)
        thermal.paste(tile.resize((width * 2, tile.height * 2), Image.Resampling.NEAREST), (460, y + 30))
    thermal.save(OUT / 'escalas-termicas-203dpi.png')
    (OUT / 'mediciones.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for p in sources:
        assert sha256(p.read_bytes()).hexdigest() == data[p.name]['sha256']
    print('Pruebas y mediciones listas; originales intactos; comprobaciones internas correctas.')
    print(json.dumps(data['contrast'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
