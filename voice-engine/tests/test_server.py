"""Mind Voice service checks that need NO model and NO network.

    voice-engine\\.venv\\Scripts\\python.exe -m unittest discover -s voice-engine\\tests -t voice-engine
"""

import http.client
import json
import os
import tempfile
import threading
import unittest

# An empty models folder: every engine is "not installed".
os.environ["MIND_VOICE_MODELS_DIR"] = tempfile.mkdtemp(prefix="mind-voice-test-")

from http.server import ThreadingHTTPServer  # noqa: E402

from mind_voice import server  # noqa: E402
from mind_voice.engines import _keep_short_line_endings, vieneu_voices  # noqa: E402


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def call(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": f"127.0.0.1:{self.port}", **(headers or {})}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        raw = r.read()
        conn.close()
        try:
            return r.status, json.loads(raw)
        except ValueError:
            return r.status, raw

    def test_health_reports_engines_not_installed(self):
        status, body = self.call("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["service"], "mind-voice")
        self.assertEqual({e["id"]: e["installed"] for e in body["engines"]}, {"vieneu": False, "supertonic": False})

    def test_vieneu_voices_come_from_the_sdk(self):
        voices = vieneu_voices()
        self.assertEqual(len(voices), 25)
        self.assertTrue(any(v["default"] for v in voices))
        regions = {v["region"] for v in voices}
        self.assertTrue(regions <= {"north", "central", "south", None})
        status, body = self.call("GET", "/voices?engine=vieneu")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["voices"]), 25)
        self.assertFalse(body["voices"][0]["installed"])

    def test_tts_without_model_is_409_model_missing(self):
        status, body = self.call("POST", "/tts", {"engine": "vieneu", "voice": "Hải Đăng", "text": "Xin chào"})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "MODEL_MISSING")

    def test_bad_requests(self):
        self.assertEqual(self.call("POST", "/tts", {"engine": "x", "voice": "a", "text": "b"})[1]["error"]["code"], "UNKNOWN_ENGINE")
        self.assertEqual(self.call("POST", "/tts", {"engine": "vieneu", "voice": "a", "text": " "})[1]["error"]["code"], "EMPTY_TEXT")
        self.assertEqual(self.call("GET", "/nope")[0], 404)

    def test_foreign_host_is_refused(self):
        status, body = self.call("GET", "/health", headers={"Host": "evil.example"})
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "FORBIDDEN_HOST")

    def test_post_must_be_json(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/models/install", body=b"engine=vieneu", headers={"Content-Type": "application/x-www-form-urlencoded"})
        r = conn.getresponse()
        self.assertEqual(r.status, 415)
        conn.close()

    def test_refused_posts_always_get_their_answer(self):
        # QĐ-157: a refused POST used to be closed with its body unread, and on
        # Windows the client then raced a TCP reset (WinError 10054). Repeated so
        # the race would show: every one must read its status.
        for _ in range(25):
            for path, ctype, want in (("/models/install", "application/x-www-form-urlencoded", 415), ("/nope", "application/json", 404)):
                conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
                conn.request("POST", path, body=b"engine=vieneu&x=" + b"y" * 2048, headers={"Content-Type": ctype})
                self.assertEqual(conn.getresponse().status, want)
                conn.close()

    def test_tts_takes_keep_punct(self):
        status, body = self.call("POST", "/tts", {"engine": "vieneu", "voice": "x", "text": "Thật á?", "keep_punct": True})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "MODEL_MISSING")

    def test_binds_localhost_only(self):
        self.assertEqual(server.HOST, "127.0.0.1")


class KeepPunctTest(unittest.TestCase):
    """QĐ-147: keep_punct keeps a short line's own ? / ! and nothing else."""

    def test_short_line_keeps_its_mark_only_while_asked(self):
        from vieneu_utils import phonemize_text as pt

        def chunks(t):
            return pt.normalize_to_chunks_v3_with_gaps(t)[0]

        self.assertEqual(chunks("Bạn ăn sáng chưa?"), ["bạn ăn sáng chưa."])  # the SDK's own rule
        with _keep_short_line_endings():
            self.assertEqual(chunks("Bạn ăn sáng chưa?"), ["bạn ăn sáng chưa?"])
            self.assertEqual(chunks("Đi thôi!"), ["đi thôi!"])
            self.assertTrue(pt.phonemize_text_with_emotions("thật á?").endswith("?"))
            # Nothing is added: a line without ? / ! is as before; a long line too.
            self.assertEqual(chunks("Vậy đi"), ["vậy đi."])
            self.assertEqual(chunks("Mình ăn rồi, cảm ơn nhé. Hôm nay trời đẹp quá!"), ["mình ăn rồi, cảm ơn nhé. hôm nay trời đẹp quá!"])
        self.assertEqual(chunks("Bạn ăn sáng chưa?"), ["bạn ăn sáng chưa."])  # restored
        self.assertEqual(pt.punc_norm.__name__, "punc_norm")


if __name__ == "__main__":
    unittest.main()
