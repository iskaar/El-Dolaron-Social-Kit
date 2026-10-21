import json
import unittest
import threading
import urllib.request
import urllib.error
from unittest.mock import patch
from scrapling.parser import Selector
from servidor import SinImagen, codigo, extraer, validar_url, Peticion, Servidor

UPC = "8438051051054"
IMAGEN = "https://target.scene7.com/is/image/Target/GUEST_ejemplo?wid=626"


class Extraccion(unittest.TestCase):
    def test_producto_y_ceros(self):
        producto = {"@type": "Product", "name": "Yoobi pouch", "gtin13": UPC, "image": [IMAGEN]}
        pagina = Selector('<script type="application/ld+json">' + json.dumps({"@graph": [producto]}) + '</script>')
        self.assertEqual(extraer(pagina, UPC), {"title": "Yoobi pouch", "image_url": IMAGEN, "barcode": UPC})
        self.assertEqual(codigo("0191907910414"), codigo("191907910414"))

    def test_metadatos_y_especificaciones(self):
        pagina = Selector(f'<h1>Estuche Yoobi</h1><meta property="og:image" content="{IMAGEN}"><div>UPC : {UPC}</div>')
        self.assertEqual(extraer(pagina, UPC)["barcode"], UPC)
        with self.assertRaises(SinImagen):
            extraer(pagina, "123456789012")

    def test_codigo_ausente_requiere_revision_humana(self):
        pagina = Selector(f'<h1>Estuche</h1><meta property="og:image" content="{IMAGEN}">')
        self.assertEqual(extraer(pagina, UPC)["barcode"], "")

    def test_sin_imagen_y_fuentes_ajenas(self):
        for html in ['<h1>Estuche</h1>', '<h1>Estuche</h1><meta property="og:image" content="http://127.0.0.1/secreto">']:
            with self.assertRaises(SinImagen):
                extraer(Selector(html), UPC)
        for url in ["http://127.0.0.1", "https://www.target.com.evil/p/-/A-94882460", "https://www.target.com/p/-/A-1?url=http://localhost"]:
            with self.assertRaises(ValueError):
                validar_url(url)
        validar_url("https://www.target.com/p/-/A-94882460")

    def test_endpoint_autenticado_y_fuentes_permitidas(self):
        with Servidor(("127.0.0.1", 0), Peticion) as servidor:
            servidor.token = "token-sintetico-de-prueba-no-es-secreto"
            hilo = threading.Thread(target=servidor.serve_forever, daemon=True)
            hilo.start()
            url = f"http://127.0.0.1:{servidor.server_port}/lookup"
            def pedir(datos, autorizado=True):
                headers = {"Content-Type": "application/json"}
                if autorizado:
                    headers["Authorization"] = "Bearer " + servidor.token
                req = urllib.request.Request(url, data=json.dumps(datos).encode(), headers=headers)
                try:
                    # Sin proxies del equipo: la prueba solo habla con su propio servidor local.
                    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=3) as r:
                        return r.status, json.load(r)
                except urllib.error.HTTPError as error:
                    with error:
                        return error.code, json.load(error)
            try:
                with patch("servidor.buscar", return_value={"title": "Estuche", "image_url": IMAGEN, "barcode": UPC}) as consulta:
                    cuerpo = {"url": "https://www.target.com/p/-/A-94882460", "barcode": UPC}
                    self.assertEqual(pedir(cuerpo, False)[0], 401)
                    self.assertEqual(pedir({"url": "http://127.0.0.1", "barcode": UPC})[0], 400)
                    self.assertEqual(pedir(cuerpo)[0], 200)
                    consulta.assert_called_once_with(cuerpo["url"], UPC)
                    servidor.capacidad.acquire()
                    try:
                        self.assertEqual(pedir(cuerpo)[0], 429)
                    finally:
                        servidor.capacidad.release()
            finally:
                servidor.shutdown()
                hilo.join()


if __name__ == "__main__":
    unittest.main()
