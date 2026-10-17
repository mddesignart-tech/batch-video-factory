import fs from "node:fs";
import path from "node:path";
import type { UrlTransport } from "./url-fetch";

/**
 * A folder that answers like websites - for a DEVELOPMENT smoke run only
 * (URL_FETCH_FIXTURE_DIR, refused when NODE_ENV=production). No socket is
 * opened: "https://blog.example.com/review.html" is read from
 * <dir>/blog.example.com/review.html. The URL safety checks run before this,
 * unchanged, so the fixture links must look like public sites.
 *
 * A file "<page>.meta.json" next to a page can set { status, headers }, e.g. a
 * redirect: { "status": 302, "headers": { "location": "…" } }.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".zip": "application/zip",
};

export function fixtureTransport(dir: string): UrlTransport {
  const root = path.resolve(dir);
  return {
    name: "fixture",
    request: async (url) => {
      const rel = `${url.hostname}${url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname}`;
      const file = path.resolve(root, decodeURIComponent(rel));
      if (!file.startsWith(root + path.sep)) return { status: 404, headers: {}, body: (async function* () {})(), close: () => undefined };
      const meta = fs.existsSync(`${file}.meta.json`)
        ? (JSON.parse(fs.readFileSync(`${file}.meta.json`, "utf8")) as { status?: number; headers?: Record<string, string> })
        : {};
      const exists = fs.existsSync(file) && fs.statSync(file).isFile();
      const status = meta.status ?? (exists ? 200 : 404);
      const bytes = exists ? fs.readFileSync(file) : Buffer.alloc(0);
      const headers = { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", ...(meta.headers ?? {}) };
      return { status, headers, body: (async function* () { yield bytes; })(), close: () => undefined };
    },
  };
}
