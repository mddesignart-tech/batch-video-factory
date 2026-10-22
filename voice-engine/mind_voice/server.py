"""Mind Voice local HTTP service - LOCALHOST ONLY.

    python -m mind_voice.server            (127.0.0.1:8011)

Endpoints (JSON unless noted):
  GET  /health                    service, version, hardware, engines
  GET  /models[?remote=1]         Model Manager status (remote=1 also asks the Hub for download sizes)
  POST /models/install            {engine, variant?}  start an install the person asked for
  POST /models/verify             {engine, variant?}  re-hash installed files
  GET  /voices[?engine=...]       voices the installed SDK / model really has
  POST /tts                       {engine, voice, text, language?, speed?, keep_punct?} -> audio/wav

Guards: binds 127.0.0.1 only; rejects any Host that is not localhost (DNS
rebinding); every POST must be application/json, which a web page on another
origin cannot send without a CORS pre-flight this server never approves.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import VERSION
from .catalog import ENGINES
from .engines import ENGINE_IMPLS, ModelMissing, VoiceNotFound
from .hardware import detect
from .models import engine_status, install, install_job, installed_variant, verify

HOST = "127.0.0.1"
PORT = int(os.environ.get("MIND_VOICE_PORT", "8011"))
MAX_TEXT = 3000
LOG = logging.getLogger("mind_voice")

HARDWARE = detect()


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _health() -> dict:
    engines = []
    for eid in ENGINES:
        st = engine_status(eid)
        engines.append(
            {
                "id": eid,
                "label": st["label"],
                "languages": st["languages"],
                "installed": st["installed"],
                "variant": st["active_variant"],
                "loaded": ENGINE_IMPLS[eid].loaded_variant is not None,
                "sample_rate": st["sample_rate"],
                "native_speed": st["native_speed"],
                "tags": st["tags"],
                "license": st["license"],
            }
        )
    return {"status": "ok", "service": "mind-voice", "version": VERSION, "hardware": HARDWARE, "engines": engines}


def _voices(engine: str | None) -> list[dict]:
    ids = [engine] if engine else list(ENGINES)
    out: list[dict] = []
    for eid in ids:
        if eid not in ENGINE_IMPLS:
            raise ApiError(400, "UNKNOWN_ENGINE", f"Không có engine \"{eid}\".")
        for v in ENGINE_IMPLS[eid].voices():
            out.append({**v, "installed": installed_variant(eid) is not None})
    return out


def _tts(body: dict) -> tuple[bytes, dict]:
    engine = str(body.get("engine") or "")
    if engine not in ENGINE_IMPLS:
        raise ApiError(400, "UNKNOWN_ENGINE", f"Không có engine \"{engine}\".")
    text = str(body.get("text") or "").strip()
    if not text:
        raise ApiError(400, "EMPTY_TEXT", "Không có nội dung để đọc.")
    if len(text) > MAX_TEXT:
        raise ApiError(400, "TEXT_TOO_LONG", f"Tối đa {MAX_TEXT} ký tự mỗi lần.")
    voice = str(body.get("voice") or "")
    if not voice:
        raise ApiError(400, "NO_VOICE", "Chưa chọn giọng.")
    language = str(body.get("language") or ENGINES[engine].languages[0])
    try:
        speed = float(body.get("speed") or 1.0)
    except (TypeError, ValueError):
        speed = 1.0
    try:
        audio, duration, sr = ENGINE_IMPLS[engine].synthesize(text, voice, language, speed, keep_punct=body.get("keep_punct") is True)
    except ModelMissing as err:
        raise ApiError(409, "MODEL_MISSING", str(err)) from err
    except VoiceNotFound as err:
        raise ApiError(400, "VOICE_NOT_FOUND", str(err)) from err
    headers = {
        "X-Engine": engine,
        "X-Engine-Variant": ENGINE_IMPLS[engine].loaded_variant or "",
        "X-Sample-Rate": str(sr),
        "X-Duration": f"{duration:.3f}",
        "X-Speed-Applied": "1" if ENGINES[engine].native_speed else "0",
        "X-Mind-Voice-Version": VERSION,
    }
    return audio, headers


class Handler(BaseHTTPRequestHandler):
    server_version = f"MindVoice/{VERSION}"

    def log_message(self, fmt: str, *args) -> None:  # quieter, one line per request
        LOG.info("%s %s", self.address_string(), fmt % args)

    def _send(self, status: int, body: bytes, ctype: str, headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data) -> None:
        self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _guard(self) -> None:
        host = (self.headers.get("Host") or "").split(":")[0].strip("[]").lower()
        if host not in ("127.0.0.1", "localhost", "::1"):
            raise ApiError(403, "FORBIDDEN_HOST", "Mind Voice chỉ nhận yêu cầu từ máy này.")

    def _body(self) -> dict:
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            raise ApiError(415, "JSON_ONLY", "Chỉ nhận application/json.")
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
            raise ApiError(413, "TOO_LARGE", "Yêu cầu quá lớn.")
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError as err:
            raise ApiError(400, "BAD_JSON", "JSON không hợp lệ.") from err
        if not isinstance(data, dict):
            raise ApiError(400, "BAD_JSON", "Cần một object JSON.")
        return data

    def _handle(self, method: str) -> None:
        try:
            self._guard()
            url = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            route = (method, url.path.rstrip("/") or "/")
            if route == ("GET", "/health"):
                return self._json(200, _health())
            if route == ("GET", "/models"):
                remote = q.get("remote") == "1"
                return self._json(200, {"engines": [engine_status(e, remote=remote) for e in ENGINES], "hardware": HARDWARE})
            if route == ("GET", "/voices"):
                return self._json(200, {"voices": _voices(q.get("engine") or None)})
            if route == ("POST", "/models/install"):
                body = self._body()
                engine = str(body.get("engine") or "")
                if engine not in ENGINES:
                    raise ApiError(400, "UNKNOWN_ENGINE", f"Không có engine \"{engine}\".")
                job = install_job(engine)
                if job and job.state == "running":
                    raise ApiError(409, "INSTALL_RUNNING", "Đang cài model này.")
                variant = body.get("variant") or None
                threading.Thread(target=install, args=(engine, variant), daemon=True).start()
                return self._json(202, {"started": True, "engine": engine, "variant": variant or ENGINES[engine].default_variant})
            if route == ("POST", "/models/verify"):
                body = self._body()
                engine = str(body.get("engine") or "")
                if engine not in ENGINES:
                    raise ApiError(400, "UNKNOWN_ENGINE", f"Không có engine \"{engine}\".")
                variant = body.get("variant") or installed_variant(engine)
                if not variant:
                    raise ApiError(409, "MODEL_MISSING", "Model chưa cài.")
                return self._json(200, verify(engine, variant))
            if route == ("POST", "/tts"):
                audio, headers = _tts(self._body())
                return self._send(200, audio, "audio/wav", headers)
            raise ApiError(404, "NOT_FOUND", f"Không có {method} {url.path}.")
        except ApiError as err:
            self._json(err.status, {"error": {"code": err.code, "message": err.message}})
        except Exception as err:  # noqa: BLE001
            LOG.error("engine error: %s\n%s", err, traceback.format_exc())
            self._json(500, {"error": {"code": "ENGINE_ERROR", "message": f"Lỗi engine giọng nói: {err}"}})

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    LOG.info("Mind Voice %s listening on http://%s:%d (localhost only)", VERSION, HOST, PORT)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
