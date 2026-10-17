import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { profileFromPlatform } from "@/domain/platform-profile";
import { checkSourceUrl, isPublicAddress } from "@/domain/url-safety";
import { fetchPage, makeSafeLookup, nodeTransport, setUrlTransport, URL_FETCH_LIMITS, type UrlTransport } from "@/services/url-fetch";
import { cleanupText, MAX_EXTRACT_CHARS } from "@/services/url-extract";
import {
  acceptedSnapshot,
  applyProjectUrlSource,
  readUrlSource,
  refetchProjectUrlSource,
  storedUrlSourceOf,
  urlSourceRule,
} from "@/services/url-source";
import { approveContentScript, createContentProject, generateContentProjectScript } from "@/services/content-service";
import { startMediaGeneration } from "@/services/project-service";
import { approveAndRun } from "@/services/batch-executor";
import { continueVideo } from "@/services/video-resume";
import { setSpendCap, spendStatus } from "@/services/spend-guard";
import { seedMock } from "./phase5-helpers";

/**
 * QĐ-138 URL CONTENT EXTRACTION. No test touches the internet: pages come from
 * tests/fixtures/url through an in-memory transport, and the one test of the
 * real socket transport points a public-looking name at a local server to show
 * the connection is REFUSED. Mock Mode, $0.
 */

const FIX = path.join(__dirname, "fixtures", "url");
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), "utf8");

interface Spec {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer | (() => AsyncIterable<Uint8Array>);
  hang?: boolean;
}

function mockTransport(routes: Record<string, Spec>): UrlTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "mock",
    calls,
    request: async (url, init) => {
      calls.push(url.href);
      const spec = routes[url.href] ?? { status: 404, body: "not found" };
      if (spec.hang) {
        return new Promise((_, reject) =>
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
        );
      }
      const body = spec.body ?? "";
      const iter =
        typeof body === "function"
          ? body()
          : (async function* () {
              yield typeof body === "string" ? Buffer.from(body, "utf8") : body;
            })();
      return {
        status: spec.status ?? 200,
        headers: { "content-type": "text/html; charset=utf-8", ...(spec.headers ?? {}) },
        body: iter,
        close: () => undefined,
      };
    },
  };
}

const html = (name: string): Spec => ({ body: fixture(name) });

/** A transport that fails the test if anything opens a link. */
function forbiddenTransport(): UrlTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "forbidden",
    calls,
    request: async (url) => {
      calls.push(url.href);
      throw new Error(`network must not be used: ${url.href}`);
    },
  };
}

afterEach(() => setUrlTransport(null));

// ================================================================ checks ===

describe("QĐ-138 kiểm tra link (validation / SSRF)", () => {
  it("chỉ http / https; chuẩn hoá link không có scheme", () => {
    const ok = checkSourceUrl("  example.com/bai-viet#phan-2 ");
    expect(ok.ok && ok.url.href).toBe("https://example.com/bai-viet");
    for (const bad of ["javascript:alert(1)", "file:///C:/Windows/win.ini", "ftp://example.com/a", "data:text/html,<b>x</b>", "mailto:a@b.com"]) {
      expect(checkSourceUrl(bad)).toMatchObject({ ok: false, code: "UNSUPPORTED_SCHEME" });
    }
    expect(checkSourceUrl("https://user:pass@example.com/")).toMatchObject({ ok: false, code: "CREDENTIALS_IN_URL" });
    expect(checkSourceUrl("https://example.com:8443/")).toMatchObject({ ok: false, code: "UNSUPPORTED_PORT" });
    expect(checkSourceUrl("")).toMatchObject({ ok: false, code: "INVALID_URL" });
    expect(checkSourceUrl("https://exa mple.com")).toMatchObject({ ok: false, code: "INVALID_URL" });
  });

  it("chặn localhost, loopback, IP riêng, link-local, metadata, tên nội bộ (kể cả dạng số viết khác)", () => {
    const blocked = [
      "http://localhost/",
      "http://LOCALHOST./admin",
      "http://app.localhost/",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://0177.0.0.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://10.0.0.5/",
      "http://172.16.3.4/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://metadata.google.internal/",
      "http://router/",
      "http://printer.local/",
      "http://nas.lan/",
    ];
    for (const u of blocked) expect(checkSourceUrl(u), u).toMatchObject({ ok: false, code: "PRIVATE_ADDRESS" });
    expect(checkSourceUrl("http://8.8.8.8/").ok).toBe(true);
    expect(checkSourceUrl("https://[2606:4700:4700::1111]/").ok).toBe(true);
  });

  it("isPublicAddress: v4 / v6 / mapped / NAT64", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700::6810:84e5")).toBe(true);
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.31.0.1", "192.168.0.1", "169.254.1.1", "224.0.0.1", "::1", "::", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "not-an-ip"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("URL mạng xã hội / video: báo chưa hỗ trợ", () => {
    for (const u of ["https://www.facebook.com/somepage/posts/1", "https://fb.watch/abc", "https://www.tiktok.com/@a/video/1", "https://www.instagram.com/p/x", "https://youtu.be/abc", "https://m.youtube.com/watch?v=1"]) {
      expect(checkSourceUrl(u), u).toMatchObject({ ok: false, code: "SOCIAL_UNSUPPORTED" });
    }
  });

  it("J/K/L/N: link bị chặn không bao giờ chạm tới transport", async () => {
    const t = forbiddenTransport();
    for (const u of ["http://localhost:3000/api", "http://127.0.0.1/", "http://192.168.0.10/", "javascript:alert(1)", "https://www.tiktok.com/@x"]) {
      await expect(fetchPage(u, { transport: t })).rejects.toHaveProperty("code");
    }
    expect(t.calls).toEqual([]);
  });
});

describe("QĐ-138 DNS: tên công khai trỏ vào trong bị từ chối lúc kết nối", () => {
  it("lookup an toàn: mọi địa chỉ phải công khai", async () => {
    const lookup = (addrs: string[]) =>
      new Promise<{ err: NodeJS.ErrnoException | null; addr: unknown }>((resolve) =>
        makeSafeLookup(async () => addrs.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 })))("x.example", { all: true }, (err, addr) =>
          resolve({ err, addr }),
        ),
      );
    expect((await lookup(["93.184.216.34"])).err).toBeNull();
    expect((await lookup(["93.184.216.34", "10.0.0.1"])).err?.code).toBe("URL_PRIVATE_ADDRESS");
    expect((await lookup(["::1"])).err?.code).toBe("URL_PRIVATE_ADDRESS");
  });

  it("transport thật: tên miền 'công khai' phân giải về 127.0.0.1 → không có request nào tới server", async () => {
    let hits = 0;
    const server = http.createServer((_, res) => {
      hits += 1;
      res.end("<html><body><p>secret admin page</p></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      expect(port).toBeGreaterThan(0);
      // DNS rebinding in miniature: the name passes the URL check, the address does not.
      const transport = nodeTransport(async () => [{ address: "127.0.0.1", family: 4 }]);
      await expect(fetchPage("http://intranet-looks-public.example.com/", { transport })).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
      expect(hits).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ================================================================= fetch ===

describe("QĐ-138 đọc trang (mock HTTP)", () => {
  it("E/F/403/429: lỗi HTTP → câu dễ hiểu, không stack trace", async () => {
    const t = mockTransport({
      "https://site.example.com/404": { status: 404 },
      "https://site.example.com/500": { status: 500 },
      "https://site.example.com/403": { status: 403 },
      "https://site.example.com/429": { status: 429 },
    });
    const errOf = async (u: string) => {
      try {
        await readUrlSource(u, { transport: t });
        return null;
      } catch (e) {
        return e as { code: string; message: string };
      }
    };
    expect(await errOf("https://site.example.com/404")).toMatchObject({ code: "NOT_FOUND" });
    expect(await errOf("https://site.example.com/500")).toMatchObject({ code: "SERVER_ERROR" });
    expect(await errOf("https://site.example.com/403")).toMatchObject({ code: "BLOCKED" });
    expect(await errOf("https://site.example.com/429")).toMatchObject({ code: "RATE_LIMITED" });
    for (const u of ["404", "500", "403"]) expect((await errOf(`https://site.example.com/${u}`))!.message).not.toMatch(/at \w+ \(|Error:/);
  });

  it("G: quá thời gian → TIMEOUT", async () => {
    const t = mockTransport({ "https://slow.example.com/": { hang: true } });
    await expect(fetchPage("https://slow.example.com/", { transport: t, timeoutMs: 150 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("G2: body nhỏ giọt quá lâu cũng bị cắt bởi cùng một hạn", async () => {
    const t = mockTransport({
      "https://drip.example.com/": {
        body: () =>
          (async function* () {
            yield Buffer.from("<html><body>");
            await new Promise((r) => setTimeout(r, 400));
            yield Buffer.from("</body></html>");
          })(),
      },
    });
    // The mock body ignores the signal, so the read is cut when it next yields.
    await expect(fetchPage("https://drip.example.com/", { transport: t, timeoutMs: 100 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("H: trang quá lớn → dừng ở giới hạn (stream, content-length, gzip bomb)", async () => {
    const mb = Buffer.alloc(1024 * 1024, 0x61);
    const t = mockTransport({
      "https://big.example.com/stream": {
        body: () =>
          (async function* () {
            for (let i = 0; i < 10; i += 1) yield mb;
          })(),
      },
      "https://big.example.com/declared": { headers: { "content-length": String(50 * 1024 * 1024) }, body: "<html></html>" },
      "https://big.example.com/bomb": {
        headers: { "content-encoding": "gzip" },
        body: zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x20)),
      },
    });
    for (const p of ["stream", "declared", "bomb"]) {
      await expect(fetchPage(`https://big.example.com/${p}`, { transport: t }), p).rejects.toMatchObject({ code: "TOO_LARGE" });
    }
    expect(URL_FETCH_LIMITS.maxBytes).toBe(3 * 1024 * 1024);
  });

  it("I: PDF / ảnh / zip / không rõ loại → từ chối", async () => {
    const t = mockTransport({
      "https://f.example.com/a.pdf": { headers: { "content-type": "application/pdf" }, body: "%PDF-1.7" },
      "https://f.example.com/a.png": { headers: { "content-type": "image/png" }, body: Buffer.from([0x89, 0x50]) },
      "https://f.example.com/a.zip": { headers: { "content-type": "application/zip" }, body: "PK" },
      "https://f.example.com/bin": { headers: { "content-type": "" }, body: Buffer.from([0, 1, 2, 3]) },
    });
    for (const p of ["a.pdf", "a.png", "a.zip", "bin"]) {
      await expect(fetchPage(`https://f.example.com/${p}`, { transport: t }), p).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT_TYPE" });
    }
  });

  it("M: chuyển hướng công khai → nội bộ bị chặn; công khai → công khai được; quá nhiều lần bị chặn", async () => {
    const t = mockTransport({
      "https://short.example.com/a": { status: 302, headers: { location: "http://10.0.0.5/admin" } },
      "https://short.example.com/b": { status: 301, headers: { location: "http://localhost/" } },
      "https://short.example.com/c": { status: 307, headers: { location: "file:///etc/passwd" } },
      "https://short.example.com/d": { status: 302, headers: { location: "/final" } },
      "https://short.example.com/final": html("article-en.html"),
      ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`https://loop.example.com/${i}`, { status: 302, headers: { location: `/${i + 1}` } }])),
    });
    await expect(fetchPage("https://short.example.com/a", { transport: t })).rejects.toMatchObject({ code: "UNSAFE_REDIRECT" });
    await expect(fetchPage("https://short.example.com/b", { transport: t })).rejects.toMatchObject({ code: "UNSAFE_REDIRECT" });
    await expect(fetchPage("https://short.example.com/c", { transport: t })).rejects.toMatchObject({ code: "UNSAFE_REDIRECT" });
    expect(t.calls.some((c) => c.includes("10.0.0.5") || c.includes("localhost") || c.startsWith("file:"))).toBe(false);
    const ok = await fetchPage("https://short.example.com/d", { transport: t });
    expect(ok.finalUrl).toBe("https://short.example.com/final");
    await expect(fetchPage("https://loop.example.com/0", { transport: t })).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
  });

  it("gzip + text/plain đọc được", async () => {
    const t = mockTransport({
      "https://z.example.com/": { headers: { "content-encoding": "gzip" }, body: zlib.gzipSync(Buffer.from(fixture("article-en.html"))) },
      "https://z.example.com/notes.txt": {
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "Release notes\n\nVersion 2 adds offline mode and a faster sync engine for large libraries.\n\nVersion 2 adds offline mode and a faster sync engine for large libraries.\nBug fixes for login and export.\nSettings now sync between the desktop and mobile apps within a few seconds.",
      },
    });
    expect((await readUrlSource("https://z.example.com/", { transport: t })).meta.pageTitle).toContain("NoteGenie");
    const txt = await readUrlSource("https://z.example.com/notes.txt", { transport: t });
    expect(txt.meta.contentType).toBe("text/plain");
    expect(txt.text.match(/offline mode/g)).toHaveLength(1);
  });
});

// ============================================================ extraction ===

describe("QĐ-138 trích nội dung", () => {
  const t = () =>
    mockTransport({
      "https://techdesk.example.com/notegenie": html("article-en.html"),
      "https://amthuc.example.vn/ca-phe-phin": html("article-vi.html"),
      "https://mindstore.example.vn/binh-500": html("product-jsonld.html"),
      "https://app.example.com/": html("js-shell.html"),
      "https://wellness.example.com/sleep": html("cluttered.html"),
    });

  it("A/D: bài HTTPS tiếng Anh → tiêu đề + thân bài, giữ tiếng Anh, bỏ menu / cookie / footer / sidebar", async () => {
    const p = await readUrlSource("https://techdesk.example.com/notegenie", { transport: t() });
    expect(p.meta.pageTitle).toBe("NoteGenie review: an AI note taker for busy teams");
    expect(p.meta.kind).toBe("ARTICLE");
    expect(p.meta.language).toBe("en");
    expect(p.meta.siteName).toBe("TechDesk");
    expect(p.meta.domain).toBe("techdesk.example.com");
    expect(p.meta.imageUrl).toBe("https://techdesk.example.com/img/notegenie.jpg");
    expect(p.text).toContain("NoteGenie joins your video calls");
    expect(p.text).toContain("## Limitations");
    expect(p.text).toContain("- Live transcription in 12 languages");
    expect(p.text).toContain("Verdict: a solid choice");
    for (const noise of ["cookies", "Accept all", "All rights reserved", "Best AI tools", "Tweet", "window.dataLayer", "color:red", "Reviews"]) {
      expect(p.text, noise).not.toContain(noise);
    }
  });

  it("C: bài tiếng Việt → giữ nguyên tiếng Việt, tác giả + ngày, bỏ quảng cáo / bình luận / dòng lặp", async () => {
    const p = await readUrlSource("https://amthuc.example.vn/ca-phe-phin", { transport: t() });
    expect(p.meta.language).toBe("vi");
    expect(p.meta.pageTitle).toBe("Cách pha cà phê phin ngon tại nhà");
    expect(p.meta.author).toBe("Nguyễn Thị Hoa");
    expect(p.meta.publishedAt).toBe("2026-09-20");
    expect(p.text).toContain("Cho 20 gam cà phê vào phin, rót khoảng 20 ml nước sôi");
    expect(p.text).toContain("## Bước 3: Chiết xuất");
    for (const noise of ["Quảng cáo", "giảm giá 50%", "Đăng nhập để bình luận", "Đọc thêm", "Du lịch"]) expect(p.text, noise).not.toContain(noise);
  });

  it("B: trang sản phẩm JSON-LD → tên, thương hiệu, thông số, giá (đánh dấu có thể thay đổi), không bịa thuộc tính", async () => {
    const p = await readUrlSource("https://mindstore.example.vn/binh-500", { transport: t() });
    expect(p.meta.kind).toBe("PRODUCT");
    expect(p.meta.hasPrice).toBe(true);
    expect(p.meta.extractionMethod).toMatch(/^jsonld\+/);
    expect(p.product).toMatchObject({ name: "Bình giữ nhiệt Mind 500ml", brand: "Mind", price: "289000 VND", availability: "Còn hàng" });
    const spec = Object.fromEntries(p.product!.specs.map((s) => [s.name, s.value]));
    expect(spec).toMatchObject({ "Dung tích": "500 ml", "Giữ nóng": "12 giờ", "Giữ lạnh": "24 giờ", "Chất liệu": "Inox 304", "Màu": "Đen nhám", "Khối lượng": "350 g", "Mã": "MD-500-BLK" });
    // Only what the page states.
    expect(Object.keys(spec).sort()).toEqual(["Chất liệu", "Dung tích", "Giữ lạnh", "Giữ nóng", "Khối lượng", "Màu", "Mã"].sort());
    expect(p.text).toContain("Giá trên trang lúc đọc (có thể thay đổi): 289000 VND");
    expect(p.text).toContain("- Kích thước: 7 x 7 x 24 cm");
    expect(p.text).toContain("- Bảo hành: 12 tháng");
    expect(p.warnings.join(" ")).toMatch(/Giá là dữ liệu trên trang/);
    for (const noise of ["Thêm vào giỏ", "Bình 750ml", "Cốc giữ nhiệt"]) expect(p.text, noise).not.toContain(noise);
  });

  it("O: trang chỉ là vỏ JavaScript → báo cần trình duyệt, chưa hỗ trợ", async () => {
    await expect(readUrlSource("https://app.example.com/", { transport: t() })).rejects.toMatchObject({
      code: "NEEDS_BROWSER",
      message: expect.stringContaining("cần trình duyệt"),
    });
  });

  it("dọn trang nhiều rác: ẩn / quảng cáo / consent / chia sẻ / dòng trùng biến mất, danh sách giữ nguyên", async () => {
    const p = await readUrlSource("https://wellness.example.com/sleep", { transport: t() });
    expect(p.text).toContain("# Five tips for better sleep");
    expect(p.text).toContain("- Get daylight within an hour of waking up.");
    expect(p.text.match(/Keep the same wake-up time/g)).toHaveLength(1);
    for (const noise of ["Hidden promo", "Another hidden", "SleepMax", "cookies", "newsletter", "Trending", "User1", "Privacy", "Sign in"]) {
      expect(p.text, noise).not.toContain(noise);
    }
    expect(p.text).not.toMatch(/\n{3,}/);
  });

  it("nội dung dài → giới hạn, ưu tiên tiêu đề + thông số, báo đã cắt", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i}: ${"lorem ipsum dolor sit amet ".repeat(6)}</p>`).join("");
    const page = fixture("product-jsonld.html").replace("<table", `${long}<table`);
    const p = await readUrlSource("https://long.example.vn/p", { transport: mockTransport({ "https://long.example.vn/p": { body: page } }) });
    expect(p.meta.truncated).toBe(true);
    expect(p.text.length).toBeLessThanOrEqual(MAX_EXTRACT_CHARS);
    expect(p.text.indexOf("Dung tích")).toBeLessThan(p.text.indexOf("Paragraph 0"));
    expect(p.text).toContain("Paragraph 0");
    expect(p.text).not.toContain("Paragraph 399");
    expect(p.warnings.join(" ")).toMatch(/Trang dài/);
  });

  it("cleanup: khoảng trắng, dòng trùng, dòng trống liên tiếp - không đổi chữ", () => {
    expect(cleanupText("A  b\u00a0c\n\n\n\nA b c\nShare\nD\u200be")).toBe("A b c\n\nDe");
  });
});

// ============================================================ project ===

describe("QĐ-138 dự án từ URL: snapshot, đọc lại, an toàn media", () => {
  let capBefore = 0;
  let projectId = "";

  beforeAll(async () => {
    await seedMock();
    const s = await spendStatus();
    capBefore = s.cap;
    await setSpendCap(Math.round((s.spent + 50) * 1e6) / 1e6);
  });
  afterAll(async () => {
    if (capBefore > 0) await setSpendCap(capBefore);
  });

  const pages = () =>
    mockTransport({
      "https://mindstore.example.vn/binh-500": html("product-jsonld.html"),
      "https://techdesk.example.com/notegenie": html("article-en.html"),
    });

  it("đọc → xem trước → chấp nhận (có chỉnh sửa) → tạo kịch bản; snapshot + metadata được lưu", async () => {
    const preview = await readUrlSource("https://mindstore.example.vn/binh-500", { transport: pages() });
    const edited = `${preview.text}\n- Ghi chú của tôi: dùng cho văn phòng`;
    const snap = acceptedSnapshot(edited, JSON.parse(JSON.stringify(preview.meta)));
    expect(snap.stored.edited).toBe(true);

    setUrlTransport(forbiddenTransport());
    const project = await createContentProject({
      contentType: "PRODUCT_REVIEW",
      sourceType: "URL",
      sourceUrl: snap.stored.url,
      sourceText: snap.text,
      urlSource: snap.stored,
      language: "vi",
      creativeStyle: { preset: "TIKTOK_FUNNY" },
      outputProfile: profileFromPlatform("TIKTOK"),
      durationSeconds: 20,
    });
    projectId = project.id;
    expect(project.contentSourceType).toBe("URL");
    expect(project.sourceText).toBe(snap.text);
    expect(project.creativeStyleJson).toContain("TIKTOK_FUNNY");
    const stored = storedUrlSourceOf(project)!;
    expect(stored).toMatchObject({ url: "https://mindstore.example.vn/binh-500", domain: "mindstore.example.vn", kind: "PRODUCT", hasPrice: true, edited: true });
    // The script is written from the page: its facts, no AI-made specs.
    const script = JSON.parse(project.scriptJson!) as { scenes: { narration: string }[]; facts?: { origin: string }[]; needsFactReview?: boolean };
    expect(script.scenes.map((s) => s.narration).join(" ")).toMatch(/inox|Inox|500|giữ/);
    expect(script.facts?.some((f) => f.origin === "AI_GENERATED") ?? false).toBe(false);
    // The snapshot's markdown markers are structure, never spoken or shown (smoke finding).
    expect(project.title).toBe("Bình giữ nhiệt Mind 500ml");
    for (const s of script.scenes) expect(s.narration).not.toMatch(/(^|\s)#{1,6}\s|(^|\s)-\s/);
  });

  it("bộ viết nhận quy tắc SOURCE MATERIAL (không thêm sự thật, giá có thể thay đổi, phong cách không đổi sự thật)", () => {
    const rule = urlSourceRule({ url: "https://mindstore.example.vn/binh-500", finalUrl: "", extractedAt: "2026-10-17T00:00:00Z" } as never, null);
    expect(rule).toContain("SOURCE MATERIAL");
    expect(rule).toContain("https://mindstore.example.vn/binh-500");
    expect(rule).toMatch(/ONLY source of facts/);
    expect(rule).toMatch(/price .* may change/i);
    expect(rule).toMatch(/never WHAT is true/);
  });

  it("P/Q: mở lại, viết lại kịch bản, duyệt, chạy media, render, tiếp tục → không mở lại link", async () => {
    const t = forbiddenTransport();
    setUrlTransport(t);
    await generateContentProjectScript(projectId);
    await approveContentScript(projectId);
    const started = await startMediaGeneration(projectId);
    await approveAndRun({ batchId: started.batchId!, maxBatch: 5, lowAutoApproved: true, wait: true });
    const done = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(done.status).toBe("completed");
    // A finished video resumes to NOOP or a $0 re-check - either way, no link opened.
    expect(["COMPLETED", "NOOP"]).toContain((await continueVideo(projectId, { wait: true })).status);
    expect(t.calls).toEqual([]);
  }, 600_000);

  it("R/S: ĐỌC LẠI TỪ WEB chỉ là xem trước; THAY NGUỒN cần xác nhận, chỉ đổi nguồn; Image / Video / Voice POST = 0", async () => {
    const before = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { scenes: { orderBy: { sceneNumber: "asc" } } } });
    const jobsBefore = {
      image: await prisma.providerJob.count({ where: { kind: "image" } }),
      video: await prisma.providerJob.count({ where: { kind: "video" } }),
      voice: await prisma.providerJob.count({ where: { kind: "voice" } }),
      text: await prisma.costEntry.count({ where: { category: "text" } }),
    };
    // The page changed since it was read.
    const changedPage = fixture("product-jsonld.html").replace("12 tháng", "24 tháng");
    setUrlTransport(mockTransport({ "https://mindstore.example.vn/binh-500": { body: changedPage } }));

    const r = await refetchProjectUrlSource(projectId);
    expect(r.changed).toBe(true);
    expect(r.scriptExists).toBe(true);
    expect(r.mediaExists).toBe(true);
    expect(r.preview.text).toContain("24 tháng");
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).sourceText).toBe(before.sourceText);

    const ask = await applyProjectUrlSource(projectId, { text: r.preview.text, meta: r.preview.meta });
    expect(ask.status).toBe("NEEDS_CONFIRMATION");
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).sourceText).toBe(before.sourceText);

    const done = await applyProjectUrlSource(projectId, { text: r.preview.text, meta: r.preview.meta, confirmReplace: true });
    expect(done.status).toBe("UPDATED");
    const after = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { scenes: { orderBy: { sceneNumber: "asc" } } } });
    expect(after.sourceText).toContain("24 tháng");
    expect(storedUrlSourceOf(after)?.edited).toBe(false);
    // Source only: script, status, media untouched; nothing bought, no text call.
    expect(after.scriptJson).toBe(before.scriptJson);
    expect(after.status).toBe("completed");
    expect(after.finalVideoPath).toBe(before.finalVideoPath);
    expect(after.scenes.map((s) => [s.imagePath, s.videoPath, s.audioPath])).toEqual(before.scenes.map((s) => [s.imagePath, s.videoPath, s.audioPath]));
    expect({
      image: await prisma.providerJob.count({ where: { kind: "image" } }),
      video: await prisma.providerJob.count({ where: { kind: "video" } }),
      voice: await prisma.providerJob.count({ where: { kind: "voice" } }),
      text: await prisma.costEntry.count({ where: { category: "text" } }),
    }).toEqual(jobsBefore);
  });

  it("ngôn ngữ: trang tiếng Anh + dự án tiếng Việt → không dịch nguồn, dự án vẫn tiếng Việt", async () => {
    const preview = await readUrlSource("https://techdesk.example.com/notegenie", { transport: pages() });
    const snap = acceptedSnapshot(preview.text, preview.meta);
    const project = await createContentProject({
      contentType: "AI_REVIEW",
      sourceType: "URL",
      sourceUrl: snap.stored.url,
      sourceText: snap.text,
      urlSource: snap.stored,
      language: "vi",
      outputProfile: profileFromPlatform("TIKTOK"),
      durationSeconds: 20,
    });
    expect(project.language).toBe("vi");
    expect(project.sourceText).toContain("NoteGenie joins your video calls");
  });

  it("URL dùng được cho AI Review / Product Review / Knowledge / Quảng cáo / Câu chuyện / Tùy chỉnh", async () => {
    const { templateOf } = await import("@/domain/content-templates");
    for (const id of ["AI_REVIEW", "PRODUCT_REVIEW", "KNOWLEDGE", "ADVERTISEMENT", "STORY", "CUSTOM"]) {
      expect(templateOf(id as never).sources, id).toContain("URL");
    }
  });

  it("an toàn đầu vào: metadata giả mạo / link nội bộ trong metadata / snapshot rỗng → từ chối", () => {
    expect(() => acceptedSnapshot("text", { url: "http://127.0.0.1/" })).toThrow(/nội bộ|máy này/);
    expect(() => acceptedSnapshot("text", { nope: 1 })).toThrow(/không hợp lệ/);
    expect(() => acceptedSnapshot("   ", { url: "https://example.com/" })).toThrow(/trống/);
  });

  it("T: dự án cũ (TEXT / không có URL) không bị ảnh hưởng", async () => {
    const project = await createContentProject({
      contentType: "KNOWLEDGE",
      sourceType: "TEXT",
      sourceText: "Nước sôi ở 100 độ C ở mực nước biển. Trên núi cao nước sôi ở nhiệt độ thấp hơn.",
      outputProfile: profileFromPlatform("TIKTOK"),
      durationSeconds: 15,
    });
    expect(storedUrlSourceOf(project)).toBeNull();
    await expect(refetchProjectUrlSource(project.id)).rejects.toMatchObject({ code: "NOT_URL_SOURCE" });
  });
});
