"""Validate the static asset contract with Python's standard library only."""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / "05-Guia-y-textos" / "Inventario-de-archivos.json"


def png_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as file:
        if file.read(8) != b"\x89PNG\r\n\x1a\n":
            raise ValueError("invalid PNG signature")
        if struct.unpack(">I", file.read(4))[0] < 8 or file.read(4) != b"IHDR":
            raise ValueError("missing PNG IHDR")
        return struct.unpack(">II", file.read(8))


def main() -> int:
    errors: list[str] = []
    try:
        inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"Inventory error: {error}")
        return 1

    assets = inventory.get("assets")
    if not isinstance(assets, list) or not assets:
        print("Inventory error: assets must be a non-empty list")
        return 1

    seen: set[str] = set()
    root = ROOT.resolve()
    for asset in assets:
        relative = asset.get("file") if isinstance(asset, dict) else None
        if not isinstance(relative, str) or not relative:
            errors.append("asset without a file path")
            continue
        if relative in seen:
            errors.append(f"duplicate inventory path: {relative}")
            continue
        seen.add(relative)

        path = (ROOT / relative).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            errors.append(f"asset escapes repository: {relative}")
            continue
        if not path.is_file():
            errors.append(f"missing asset: {relative}")
            continue

        if asset.get("format") == "PNG":
            try:
                width, height = png_dimensions(path)
            except (OSError, ValueError) as error:
                errors.append(f"{relative}: {error}")
                continue
            expected = (asset.get("width"), asset.get("height"))
            if expected != (width, height):
                errors.append(
                    f"{relative}: inventory says {expected}, file is {(width, height)}"
                )
        elif asset.get("format") == "SVG" and path.suffix.lower() != ".svg":
            errors.append(f"{relative}: SVG inventory entry is not an SVG file")

    if errors:
        print("\n".join(f"- {error}" for error in errors))
        return 1

    print(f"Validated {len(assets)} assets against {INVENTORY.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
