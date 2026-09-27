"""Codigos genericos de WinCaja como bandas de la caja.

    python tools/importar_wincaja.py C:\\Users\\isaac\\Downloads\\COMPRAA.xlsx
    python tools/importar_wincaja.py COMPRAA.xlsx --produccion

WinCaja pega etiquetas genericas: un codigo por subfamilia y precio de cada
compra (40020260910 = MERCA GENERAL 20). Aqui cada codigo se vuelve un
producto sin inventario, igual que una banda (G49): la caja lo cobra al
escanearlo, al precio de la columna "Precio", sin contar piezas.

Reimportar el mismo archivo o uno nuevo actualiza nombre y precio por codigo;
el id no cambia, asi que las ventas ya hechas siguen ligadas. Por omision va al
sandbox; --produccion escribe en la base de la tienda.

Requiere openpyxl (pip install openpyxl).
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
CODIGO = re.compile(r"^\d{11}$")


def leer(archivo: Path) -> tuple[list[tuple[str, str, int]], list[str]]:
    """(codigo, nombre, centavos) de todas las hojas, y los renglones que no se pudieron leer."""
    import openpyxl

    libro = openpyxl.load_workbook(archivo, data_only=True)
    filas: dict[str, tuple[str, str, int]] = {}
    omitidas: list[str] = []
    for hoja in libro.worksheets:
        renglones = list(hoja.iter_rows(values_only=True))
        if not renglones:
            continue
        # La columna del precio se mueve entre hojas: se busca por encabezado.
        encabezado = [str(c).strip().lower() if c is not None else "" for c in renglones[0]]
        if "precio" not in encabezado:
            continue
        col_precio = encabezado.index("precio")
        for renglon in renglones[1:]:
            if len(renglon) < 3 or renglon[1] is None:
                continue
            codigo = str(renglon[1]).strip()
            if not CODIGO.match(codigo):
                continue
            # WinCaja exporta la Ñ rota; es la unica letra fuera de ASCII en sus subfamilias.
            nombre = str(renglon[2] or "").replace("\ufffd", "Ñ").strip()
            precio = renglon[col_precio] if col_precio < len(renglon) else None
            if not isinstance(precio, (int, float)) or precio <= 0:
                omitidas.append(f"{hoja.title}: {codigo} {nombre} (sin precio)")
                continue
            filas[codigo] = (codigo, nombre, round(precio * 100))
    return sorted(filas.values(), key=lambda f: (f[1], f[0])), omitidas


def sql(filas: list[tuple[str, str, int]]) -> str:
    ahora = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    texto = lambda s: "'" + s.replace("'", "''") + "'"
    valores = ",\n".join(
        f"  ({texto(str(uuid.uuid4()))}, {texto(codigo)}, {texto(nombre)}, {centavos}, {texto(ahora)})"
        for codigo, nombre, centavos in filas
    )
    return f"""insert into productos (id, codigo, nombre, categoria, precio_lista, precio, estado_fisico,
                       estado_analisis, destino, stock, sin_inventario, semana_ingreso,
                       foto_key, creado_en, actualizado_en)
select column1, column2, column3, 'otros', 0, column4, 'nuevo', 'listo', 'wincaja', 0, 1, 'S00', '',
       column5, column5
from (values
{valores}
)
where true
on conflict (codigo) do update set nombre = excluded.nombre, precio = excluded.precio,
  sin_inventario = 1, actualizado_en = excluded.actualizado_en;
"""


def main() -> None:
    argumentos = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(argumentos) != 1:
        sys.exit(__doc__)
    produccion = "--produccion" in sys.argv
    filas, omitidas = leer(Path(argumentos[0]))
    if not filas:
        sys.exit("No encontre codigos de 11 digitos con precio.")

    for codigo, nombre, centavos in filas:
        print(f"  {codigo}  {nombre:<22} ${centavos / 100:,.2f}")
    for o in omitidas:
        print(f"  OMITIDO  {o}")

    base, config = ("el-dolaron", []) if produccion else ("el-dolaron-sandbox", ["--config", "wrangler.sandbox.jsonc"])
    with tempfile.TemporaryDirectory() as tmp:
        archivo = Path(tmp) / "wincaja.sql"
        archivo.write_text(sql(filas), encoding="utf-8")
        npx = shutil.which("npx") or "npx"
        r = subprocess.run([npx, "wrangler", "d1", "execute", base, "--remote", "--file", str(archivo), *config],
                           cwd=APP, capture_output=True, text=True, encoding="utf-8")
        if r.returncode != 0:
            sys.exit(f"wrangler fallo:\n{r.stdout}\n{r.stderr}")
    print(f"{len(filas)} codigos en {base}. Abre /caja de nuevo para que baje el catalogo.")


if __name__ == "__main__":
    main()
