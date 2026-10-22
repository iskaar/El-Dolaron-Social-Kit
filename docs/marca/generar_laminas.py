"""Genera las láminas del manual de marca (#433) en docs/marca/laminas/.

Cómo correrlo (desde la raíz del repo, a mano; no forma parte de CI ni de tools/):

    python docs/marca/generar_laminas.py

Requiere Pillow y haber corrido antes docs/marca/generar_variantes.py.
Los fondos «foto» son sintéticos (no hay foto de producto con derechos en el kit).
El logo retirado se lee del historial de git (commit 9051021^) solo para mostrarlo
tachado; no se guarda en el repo. Las etiquetas usan fuentes de Windows si existen.
"""

import random
import subprocess
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
LOGOS, OUT = ROOT / '01-Logos', Path(__file__).resolve().parent / 'laminas'
NAVY, RED, YELLOW, WHITE, BLACK = '#16366B', '#D72B32', '#FFD447', '#FFFFFF', '#000000'


def fuente(tam, negrita=True):
    for f in ('arialbd.ttf' if negrita else 'arial.ttf', 'DejaVuSans-Bold.ttf'):
        try:
            return ImageFont.truetype(f, tam)
        except OSError:
            pass
    return ImageFont.load_default(size=tam)


def logo(nombre):
    return Image.open(LOGOS / nombre).convert('RGBA')


def rgb(h):
    return tuple(int(h[k:k + 2], 16) for k in (1, 3, 5))


def lum(c):
    def f(v):
        v /= 255
        return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4
    r, g, b = (f(v) for v in c)
    return .2126 * r + .7152 * g + .0722 * b


def contraste(a, b):
    hi, lo = sorted((lum(a), lum(b)), reverse=True)
    return (hi + .05) / (lo + .05)


def foto(tam, oscura, semilla):
    """Fondo sintético tipo foto: manchas de color desenfocadas y grano."""
    rnd = random.Random(semilla)
    base = (70, 60, 55) if oscura else (205, 190, 165)
    im = Image.new('RGB', tam, base)
    d = ImageDraw.Draw(im)
    for _ in range(26):
        x, y, r = rnd.randrange(tam[0]), rnd.randrange(tam[1]), rnd.randrange(20, 90)
        delta = rnd.randrange(-45, 45)
        c = tuple(max(0, min(255, v + delta + rnd.randrange(-20, 20))) for v in base)
        d.ellipse((x - r, y - r, x + r, y + r), fill=c)
    im = im.filter(ImageFilter.GaussianBlur(14))
    ruido = Image.effect_noise(tam, 10).convert('RGB')
    return Image.blend(im, ImageChops.add(im, ruido, 1, -128), .6)


def poner(fondo, img, caja):
    x0, y0, x1, y1 = caja
    s = min((x1 - x0) / img.width, (y1 - y0) / img.height)
    im = img.resize((round(img.width * s), round(img.height * s)), Image.Resampling.LANCZOS)
    fondo.paste(im, (x0 + (x1 - x0 - im.width) // 2, y0 + (y1 - y0 - im.height) // 2), im)


def marca(d, xy, bien):
    x, y = xy
    if bien:
        d.ellipse((x - 14, y - 14, x + 14, y + 14), fill='#1B7F3B')
        d.line((x - 7, y, x - 2, y + 6, x + 8, y - 6), fill=WHITE, width=4)
    else:
        d.ellipse((x - 14, y - 14, x + 14, y + 14), fill=RED)
        d.line((x - 6, y - 6, x + 6, y + 6), fill=WHITE, width=4)
        d.line((x - 6, y + 6, x + 6, y - 6), fill=WHITE, width=4)


def laminas_variantes():
    filas = [
        ('Horizontal negro', 'el-dolaron-logo-horizontal-negro.png', BLACK),
        ('Horizontal blanco', 'el-dolaron-logo-horizontal-blanco.png', WHITE),
        ('Horizontal azul', 'el-dolaron-logo-horizontal-azul.png', NAVY),
        ('Vertical negro', 'el-dolaron-logo-vertical-negro.png', BLACK),
        ('Vertical blanco', 'el-dolaron-logo-vertical-blanco.png', WHITE),
        ('Ícono EL negro', 'el-dolaron-icono-el-negro.png', BLACK),
        ('Ícono EL blanco', 'el-dolaron-icono-el-blanco.png', WHITE),
    ]
    TW, TH, L = 380, 190, 190
    fondos = [('Claro', WHITE), ('Azul', NAVY), ('Negro', BLACK), ('Foto clara', 'foto-c'), ('Foto oscura', 'foto-o')]
    hoja = Image.new('RGB', (L + TW * 5, 60 + TH * len(filas)), '#EEF1F6')
    d = ImageDraw.Draw(hoja)
    for j, (n, _) in enumerate(fondos):
        d.text((L + j * TW + 12, 28), n, font=fuente(24), fill=NAVY)
    d.text((12, 8), 'Verde: contraste de la tinta sobre el fondo >= 4.5:1. Rojo: no usar. Fotos simuladas.',
           font=fuente(14, False), fill=NAVY)
    for i, (nombre, archivo, tinta) in enumerate(filas):
        y = 60 + i * TH
        d.text((12, y + TH // 2 - 12), nombre, font=fuente(19), fill=NAVY)
        img = logo(archivo)
        for j, (_, f) in enumerate(fondos):
            x = L + j * TW
            if f in ('foto-c', 'foto-o'):
                bg = foto((TW, TH), f == 'foto-o', 7 + i)
                medio = bg.resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))
            else:
                bg, medio = Image.new('RGB', (TW, TH), f), rgb(f)
            hoja.paste(bg, (x, y))
            poner(hoja, img, (x + 40, y + 24, x + TW - 40, y + TH - 24))
            d.rectangle((x, y, x + TW - 1, y + TH - 1), outline='#C9D1DF')
            marca(d, (x + TW - 24, y + 24), contraste(rgb(tinta), medio) >= 4.5)
    hoja.save(OUT / 'variantes-sobre-fondos.jpg', quality=90)


def tile(dibujo):
    t = Image.new('RGB', (800, 450), WHITE)
    dibujo(t)
    d = ImageDraw.Draw(t)
    marca(d, (770, 30), False)
    d.rectangle((0, 0, 799, 449), outline='#C9D1DF', width=2)
    return t


def incorrectos():
    h = logo('el-dolaron-logo.png')

    def estirar(t):
        poner(t, h.resize((h.width // 2, int(h.height * 1.9))), (100, 20, 700, 430))

    def recolorear(t):
        r, g, b, a = h.split()
        poner(t, Image.merge('RGBA', (b, r, g, a)), (60, 90, 740, 360))

    def sin_etiqueta(t):
        im = h.copy()
        ImageDraw.Draw(im).rectangle((0, 0, 355, 537), fill=(0, 0, 0, 0))
        px = im.load()  # esquina amarilla de la etiqueta que asoma sobre la D
        for x in range(340, 440):
            for y in range(0, 140 if x > 375 else 537):
                r, g, b, a = px[x, y]
                if r > 180 and g > 120 and b < 140:
                    px[x, y] = (0, 0, 0, 0)
        poner(t, im.crop(im.getbbox()), (60, 90, 740, 360))

    def sombra(t):
        a = h.getchannel('A').filter(ImageFilter.GaussianBlur(14))
        sh = Image.new('RGBA', h.size, (0, 0, 0, 255))
        sh.putalpha(a.point(lambda p: p * 2 // 3))
        base = Image.new('RGBA', (h.width + 80, h.height + 80), (0, 0, 0, 0))
        base.alpha_composite(sh, (40, 40))
        base.alpha_composite(h, (0, 0))
        poner(t, base, (60, 90, 740, 360))

    def sin_contraste(t):
        d = ImageDraw.Draw(t)
        d.rectangle((0, 0, 399, 449), fill=NAVY)
        d.rectangle((400, 0, 799, 449), fill=YELLOW)
        poner(t, logo('el-dolaron-logo-horizontal-azul.png'), (30, 150, 370, 300))
        poner(t, logo('el-dolaron-logo-horizontal-blanco.png'), (430, 150, 770, 300))

    def tipografia(t):
        ImageDraw.Draw(t).text((400, 225), 'El Dolarón', font=fuente(120), fill=NAVY, anchor='mm')

    def girar(t):
        poner(t, h.rotate(14, expand=True, resample=Image.Resampling.BICUBIC), (110, 20, 690, 430))

    def retirado(t):
        try:
            png = subprocess.run(['git', 'show', '9051021^:01-Logos/el-dolaron-logo-horizontal-fondo-blanco.png'],
                                 cwd=ROOT, capture_output=True, check=True).stdout
            poner(t, Image.open(BytesIO(png)).convert('RGBA'), (60, 90, 740, 360))
        except Exception:
            ImageDraw.Draw(t).text((400, 225), 'Logo anterior (D)', font=fuente(48), fill=NAVY, anchor='mm')
        ImageDraw.Draw(t).line((60, 400, 740, 50), fill=RED, width=12)

    lista = [('1-estirar', estirar), ('2-recolorear', recolorear), ('3-sin-etiqueta', sin_etiqueta),
             ('4-sombras', sombra), ('5-sin-contraste', sin_contraste), ('6-tipografia', tipografia),
             ('7-girar', girar), ('8-logo-retirado', retirado)]
    for nombre, f in lista:
        tile(f).save(OUT / f'incorrecto-{nombre}.png', optimize=True)


if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    laminas_variantes()
    incorrectos()
    print('Láminas listas en', OUT.relative_to(ROOT))
