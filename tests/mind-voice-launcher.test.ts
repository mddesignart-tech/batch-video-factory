import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { MIND_PROVIDER } from "@/domain/mind-voice";
import { ensureMindRegistry } from "@/services/mind-voice-catalog";
import { diagnoseMindVoice, ensureMindVoice, portListening } from "@/services/mind-voice-launcher";
import { mindStatusAction } from "@/app/actions/mind-voice";

/**
 * QĐ-153: starting Mind Voice. A fake voice-engine folder (path with a space)
 * whose start_voice_engine.bat runs a tiny Node "Mind Voice" - the real spawn
 * path, no Python, no model, $0.
 */

let dir = "";
let port = 0;
const prevDir = process.env.MIND_VOICE_DIR;

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const p = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return p;
}

const setBaseUrl = (url: string) => prisma.providerConfig.update({ where: { name: MIND_PROVIDER }, data: { baseUrl: url } });
const starts = () => (fs.existsSync(path.join(dir, "starts.txt")) ? fs.readFileSync(path.join(dir, "starts.txt"), "utf8").trim().split("\n").filter(Boolean).length : 0);
const quit = () => fetch(`http://127.0.0.1:${port}/quit`).catch(() => undefined);

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mind voice "));
  fs.mkdirSync(path.join(dir, ".venv", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".venv", "Scripts", "python.exe"), "");
  // A fake Mind Voice: answers /health like the real one; logs every start.
  fs.writeFileSync(
    path.join(dir, "fake.js"),
    `const http = require("http"); const fs = require("fs"); const path = require("path");
const port = Number(process.env.MIND_VOICE_PORT);
const srv = http.createServer((req, res) => {
  if (req.url === "/quit") { res.end("bye"); return srv.close(() => process.exit(0)); }
  res.writeHead(200, { "Content-Type": "application/json" });
  if (req.url === "/voices") return res.end(JSON.stringify({ voices: [{ id: "Thục Đoan", name: "Thục Đoan", engine: "vieneu", languages: ["vi"], installed: true }] }));
  res.end(JSON.stringify({ status: "ok", service: "mind-voice", version: "0.1.0", hardware: { device: "cpu" }, engines: [{ id: "vieneu", label: "VieNeu-TTS v3 Turbo", installed: true, variant: "fp32" }] }));
});
srv.on("error", () => process.exit(2));
srv.listen(port, "127.0.0.1", () => fs.appendFileSync(path.join(__dirname, "starts.txt"), process.pid + "\\n"));
setTimeout(() => process.exit(0), 120000);
`,
  );
  fs.writeFileSync(path.join(dir, "start_voice_engine.bat"), `@echo off\r\ncd /d "%~dp0"\r\nnode fake.js\r\n`);
  process.env.MIND_VOICE_DIR = dir;
  port = await freePort();
  await ensureMindRegistry();
  await setBaseUrl(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  await quit();
  await setBaseUrl("http://127.0.0.1:8011");
  if (prevDir === undefined) delete process.env.MIND_VOICE_DIR;
  else process.env.MIND_VOICE_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Mind Voice launcher (QĐ-153)", () => {
  it.skipIf(process.platform !== "win32")("starts the one launcher when stopped, waits for /health, never twice", async () => {
    const before = await mindStatusAction();
    expect(before.online).toBe(false);
    expect(before.ready).toBe(false);
    expect(before.state).toBe("failed");
    expect(before.canStart).toBe(true);

    // Two clicks at once (and the boot) share one start.
    const [a, b] = await Promise.all([ensureMindVoice(30_000), ensureMindVoice(30_000)]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.state).toBe("started");
    expect(starts()).toBe(1);

    // Already healthy: left alone.
    const again = await ensureMindVoice(30_000);
    expect(again.state).toBe("online");
    expect(starts()).toBe(1);

    const after = await mindStatusAction();
    expect(after.online && after.ready).toBe(true);
    expect(after.message).toContain("1 giọng sẵn sàng");

    // Stopped -> Offline again (the cached voices do not make it Online).
    await quit();
    await new Promise((r) => setTimeout(r, 500));
    const stopped = await mindStatusAction();
    expect(stopped.online).toBe(false);
    expect(stopped.ready).toBe(false);
    expect(stopped.voices.length).toBe(1);
  });

  it("a port held by another program is reported, not started over", async () => {
    const other = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const busy = (other.address() as AddressInfo).port;
    await setBaseUrl(`http://127.0.0.1:${busy}`);
    try {
      expect(await portListening("127.0.0.1", busy)).toBe(true);
      const d = await diagnoseMindVoice();
      expect(d.state).toBe("port_busy");
      const before = starts();
      const r = await ensureMindVoice(3_000);
      expect(r.ok).toBe(false);
      expect(r.state).toBe("port_busy");
      expect(starts()).toBe(before);
      expect((await mindStatusAction()).canStart).toBe(false);
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
      await setBaseUrl(`http://127.0.0.1:${port}`);
    }
  });

  it("not installed / not on this machine: says why, starts nothing", async () => {
    process.env.MIND_VOICE_DIR = path.join(dir, "missing");
    try {
      expect((await diagnoseMindVoice()).state).toBe("not_installed");
      expect((await ensureMindVoice(3_000)).state).toBe("not_installed");
    } finally {
      process.env.MIND_VOICE_DIR = dir;
    }
    expect((await diagnoseMindVoice("http://192.168.1.50:8011")).state).toBe("remote");
  });
});
