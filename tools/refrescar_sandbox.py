"""Copia produccion al sandbox (Issue #83). Produccion solo se LEE.

    python tools/refrescar_sandbox.py

Borra todo lo del sandbox y lo reemplaza con el esquema completo de produccion
y los datos de sus tablas, MENOS socios y Dolarones: son datos personales y no
salen de produccion. Las ventas copiadas quedan sin socio.

Las fotos (R2) no se copian: en el sandbox las piezas viejas salen sin foto.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
ORIGEN = "el-dolaron"
DESTINO = "el-dolaron-sandbox"
CONFIG_DESTINO = "wrangler.sandbox.jsonc"
# Nunca se copian: datos personales de clientes. Las internas de D1/SQLite tampoco.
PRIVADAS = {"clientes", "dolarones_lotes", "dolarones_movimientos"}
INTERNAS = ("sqlite_", "_cf_", "d1_")


def wrangler(*args: str) -> str:
    npx = shutil.which("npx") or "npx"
    resultado = subprocess.run([npx, "wrangler", *args], cwd=APP, capture_output=True, text=True, encoding="utf-8")
    if resultado.returncode != 0:
        sys.exit(f"wrangler {' '.join(args)} fallo:\n{resultado.stdout}\n{resultado.stderr}")
    return resultado.stdout


def consultar(base: str, sql: str, *config: str) -> list[dict]:
    salida = wrangler("d1", "execute", base, "--remote", "--json", "--command", sql, *config)
    return json.loads(salida)[0]["results"]


def main() -> None:
    assert DESTINO != ORIGEN, "el destino nunca puede ser produccion"
    config = ("--config", CONFIG_DESTINO)

    tablas = [f["name"] for f in consultar(ORIGEN, "select name from sqlite_master where type = 'table'")
              if not f["name"].startswith(INTERNAS)]
    copiar = [t for t in tablas if t not in PRIVADAS]

    with tempfile.TemporaryDirectory() as tmp:
        esquema = Path(tmp) / "esquema.sql"
        datos = Path(tmp) / "datos.sql"
        borrar = Path(tmp) / "borrar.sql"

        print("Leyendo produccion...")
        wrangler("d1", "export", ORIGEN, "--remote", "--no-data", "--output", str(esquema))
        tablas_args = [a for t in copiar for a in ("--table", t)]
        wrangler("d1", "export", ORIGEN, "--remote", "--no-schema", *tablas_args, "--output", str(datos))

        print("Vaciando el sandbox...")
        objetos = consultar(DESTINO, "select type, name from sqlite_master where type in ('table', 'trigger')", *config)
        sentencias = ["PRAGMA defer_foreign_keys = TRUE;"]
        sentencias += [f'DROP TRIGGER IF EXISTS "{o["name"]}";' for o in objetos if o["type"] == "trigger"]
        sentencias += [f'DROP TABLE IF EXISTS "{o["name"]}";' for o in objetos
                       if o["type"] == "table" and not o["name"].startswith(INTERNAS)]
        borrar.write_text("\n".join(sentencias) + "\n", encoding="utf-8")
        if len(sentencias) > 1:
            wrangler("d1", "execute", DESTINO, "--remote", "--file", str(borrar), *config)

        print("Cargando esquema y datos...")
        wrangler("d1", "execute", DESTINO, "--remote", "--file", str(esquema), *config)
        if datos.stat().st_size > 0:
            wrangler("d1", "execute", DESTINO, "--remote", "--file", str(datos), *config)
        # Sin socios en el sandbox, ninguna venta apunta a uno.
        wrangler("d1", "execute", DESTINO, "--remote", "--command", "update ventas set cliente_id = null", *config)

    # Un solo renglon: D1 limita cuantos SELECT se pueden unir con UNION.
    conteo = "select " + ", ".join(f'(select count(*) from "{t}") as "{t}"' for t in tablas)
    for tabla, n in consultar(DESTINO, conteo, *config)[0].items():
        print(f"  {tabla:<24} {n}")
    print("Listo. Sandbox: https://sandbox.viste.com.mx")


if __name__ == "__main__":
    main()
