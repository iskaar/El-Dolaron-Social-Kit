"""Extractor de enlaces Target para el escáner. No recibe sesiones de personal ni escribe inventario."""
from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class SinImagen(ValueError):
    pass


def validar_url(url: str) -> None:
    if not isinstance(url, str) or not re.fullmatch(r"https://www\.target\.com/p/-/A-\d{1,12}", url):
        raise ValueError("Solo se aceptan enlaces de producto Target del manifiesto.")


def codigo(valor: str) -> str:
    if not isinstance(valor, str) or not re.fullmatch(r"\d{6,14}", valor):
        raise ValueError("Código inválido.")
    return valor.lstrip("0")


def productos(datos):
    if isinstance(datos, list):
        for dato in datos:
            yield from productos(dato)
    elif isinstance(datos, dict):
        tipos = datos.get("@type", [])
        if tipos == "Product" or isinstance(tipos, list) and "Product" in tipos:
            yield datos
        yield from productos(datos.get("@graph", []))


def extraer(pagina, esperado: str) -> dict:
    encontrados = []
    for texto in pagina.css('script[type="application/ld+json"]::text').getall():
        try:
            encontrados.extend(productos(json.loads(texto)))
        except (ValueError, TypeError):
            continue
    principal = None
    for producto in encontrados:
        upc = next((str(producto[k]) for k in ("gtin14", "gtin13", "gtin12", "gtin8", "gtin") if producto.get(k)), "")
        if upc and codigo(upc) == codigo(esperado):
            principal = producto
            break
    if principal is None and len(encontrados) == 1:
        principal = encontrados[0]
    principal = principal or {}
    upc = next((str(principal[k]) for k in ("gtin14", "gtin13", "gtin12", "gtin8", "gtin") if principal.get(k)), "")
    # Las especificaciones visibles también funcionan cuando no hay JSON-LD.
    visible = " ".join(pagina.xpath('//text()[not(ancestor::script) and not(ancestor::style)]').getall())
    match = re.search(r"\bUPC\s*:?\s*(\d{6,14})\b", visible)
    if not upc and match:
        upc = match.group(1)
    if upc and codigo(upc) != codigo(esperado):
        raise SinImagen("El código de la página no coincide.")
    titulo = principal.get("name") or pagina.css('#pdp-product-title-id::text, h1::text').get() or pagina.css('meta[property="og:title"]::attr(content)').get()
    imagen = principal.get("image") or pagina.css('meta[property="og:image"]::attr(content)').get() or pagina.css('img[alt*=", 1 of"]::attr(src)').get()
    if isinstance(imagen, list):
        imagen = imagen[0] if imagen else None
    if isinstance(imagen, dict):
        imagen = imagen.get("url") or imagen.get("contentUrl")
    if not isinstance(titulo, str) or not isinstance(imagen, str):
        raise SinImagen("La página no tiene nombre e imagen del producto.")
    url = urlsplit(imagen)
    if url.scheme != "https" or url.netloc != "target.scene7.com" or not url.path.startswith("/is/image/Target/"):
        raise SinImagen("La imagen no pertenece al catálogo de Target.")
    if len(imagen) > 2000:
        raise SinImagen("URL de imagen demasiado larga.")
    return {"title": titulo.strip()[:200], "image_url": imagen, "barcode": upc}


def buscar(url: str, barcode: str) -> dict:
    validar_url(url)
    codigo(barcode)
    from scrapling.fetchers import Fetcher, StealthyFetcher

    pagina = Fetcher.get(url, timeout=8, retries=0, follow_redirects=False)
    if pagina.status == 200:
        try:
            return extraer(pagina, barcode)
        except SinImagen as error:
            if "no coincide" in str(error):
                raise

    def especificaciones(page):
        boton = page.get_by_role("button", name="Specifications", exact=True)
        if boton.count():
            boton.click(timeout=2000)

    def limitar_red(page):
        def filtrar(route):
            destino = urlsplit(route.request.url)
            host = destino.hostname or ""
            if destino.scheme == "https" and (host == "target.com" or host.endswith(".target.com") or host == "target.scene7.com"):
                route.continue_()
            else:
                route.abort()
        page.route("**/*", filtrar)

    # Sin resolver CAPTCHAs ni seguir enlaces: solo renderizar la página suministrada.
    pagina = StealthyFetcher.fetch(url, headless=True, timeout=20_000, retries=1, google_search=False,
                                   solve_cloudflare=False, page_setup=limitar_red, page_action=especificaciones)
    final = urlsplit(str(pagina.url))
    if pagina.status != 200 or final.scheme != "https" or final.netloc != "www.target.com" or not final.path.endswith("/-/A-" + url.rsplit("A-", 1)[1]):
        raise SinImagen("El proveedor no permitió abrir esta página.")
    return extraer(pagina, barcode)


class Servidor(ThreadingHTTPServer):
    daemon_threads = True
    capacidad = threading.BoundedSemaphore(1)


class Peticion(BaseHTTPRequestHandler):
    def responder(self, status: int, datos: dict):
        cuerpo = json.dumps(datos, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_GET(self):
        self.responder(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_POST(self):
        if self.path != "/lookup":
            return self.responder(404, {"error": "Ruta no encontrada."})
        if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.token):
            return self.responder(401, {"error": "Sin autorización."})
        try:
            largo = int(self.headers.get("Content-Length", "0"))
            if not 0 < largo <= 4096:
                return self.responder(413, {"error": "Cuerpo inválido."})
            datos = json.loads(self.rfile.read(largo))
            if not isinstance(datos, dict):
                raise ValueError("Cuerpo inválido.")
            validar_url(datos.get("url"))
            codigo(datos.get("barcode"))
        except (ValueError, TypeError):
            return self.responder(400, {"error": "Enlace o código inválido."})
        if not self.server.capacidad.acquire(blocking=False):
            return self.responder(429, {"error": "Búsqueda ocupada. Reintenta."})
        try:
            self.responder(200, buscar(datos["url"], datos["barcode"]))
        except SinImagen as error:
            self.responder(422, {"error": str(error)})
        except Exception:
            self.responder(502, {"error": "No se pudo consultar al proveedor."})
        finally:
            self.server.capacidad.release()

    def setup(self):
        super().setup()
        self.connection.settimeout(40)

    def log_message(self, *_args):
        pass  # No registrar tokens ni cuerpos de petición.


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    parser.add_argument("--check", help="Enlace Target para una prueba de lectura, sin servidor")
    parser.add_argument("--barcode")
    args = parser.parse_args()
    if args.check:
        print(json.dumps(buscar(args.check, args.barcode), ensure_ascii=False))
    else:
        token = os.environ.get("SCRAPLING_TOKEN", "")
        if len(token) < 32:
            parser.error("SCRAPLING_TOKEN debe tener al menos 32 caracteres.")
        with Servidor(("0.0.0.0", args.port), Peticion) as servidor:
            servidor.token = token
            servidor.serve_forever()
