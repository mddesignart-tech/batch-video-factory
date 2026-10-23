import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { mindHealth } from "@/providers/mindvoice/mind-voice-client";
import { mindBaseUrl } from "./mind-voice-catalog";

/**
 * Starting Mind Voice (QĐ-153). ONE launcher: voice-engine\start_voice_engine.bat,
 * the same script START_TOOL.bat used to open. The app calls it when it boots
 * and when the person clicks "Khởi động Mind Voice"; START_TOOL only waits.
 *
 * Never two services: a healthy service is left alone, a port that answers
 * but is not Mind Voice is reported (not fought over), one start at a time in
 * this process (shared promise) and across processes (lock file), and the
 * Python server takes its port exclusively. Never a paid fallback: this only
 * starts or reports the local service.
 */

export type MindLaunchState = "online" | "started" | "starting" | "not_installed" | "port_busy" | "remote" | "failed";

export interface MindLaunchResult {
  state: MindLaunchState;
  ok: boolean;
  message: string;
}

export const MIND_START_TIMEOUT_MS = 60_000;
const LOCK_STALE_MS = 90_000;
const POLL_MS = 500;

const ROOT = process.cwd();
export const mindEngineDir = (): string => process.env.MIND_VOICE_DIR || path.join(ROOT, "voice-engine");
const launcher = (): string => path.join(mindEngineDir(), "start_voice_engine.bat");
const pythonExe = (): string => path.join(mindEngineDir(), ".venv", "Scripts", "python.exe");
const lockFile = (): string => path.join(ROOT, "logs", "mind-voice.starting");

export function mindInstalled(): boolean {
  return fs.existsSync(launcher()) && fs.existsSync(pythonExe());
}

function localTarget(baseUrl: string): { host: string; port: number } | null {
  try {
    const u = new URL(baseUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
    return { host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || 80) };
  } catch {
    return null;
  }
}

/** Something accepts TCP on the port (not necessarily Mind Voice). */
export function portListening(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

async function healthy(baseUrl: string): Promise<boolean> {
  try {
    await mindHealth(baseUrl);
    return true;
  } catch {
    return false;
  }
}

async function waitHealthy(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await healthy(baseUrl)) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

/** Cross-process: only one starter. A lock older than LOCK_STALE_MS is a crashed start. */
function takeLock(): boolean {
  const file = lockFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(file, { force: true });
        fs.writeFileSync(file, String(process.pid), { flag: "wx" });
        return true;
      }
    } catch {
      // another starter won the race
    }
    return false;
  }
}

function releaseLock(): void {
  fs.rmSync(lockFile(), { force: true });
}

/**
 * The existing launcher in its own minimised "Mind Voice" window (closing it
 * stops Mind Voice, as before). Detached: it outlives this server.
 */
function spawnLauncher(port: number): void {
  const child = spawn("cmd.exe", ["/d", "/c", `start "Mind Voice" /min cmd /c ""${launcher()}""`], {
    cwd: mindEngineDir(),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
    env: { ...process.env, MIND_VOICE_PORT: String(port) },
  });
  child.unref();
}

/** Why Mind Voice is not answering, without starting anything. */
export async function diagnoseMindVoice(baseUrl?: string): Promise<MindLaunchResult> {
  const url = baseUrl ?? (await mindBaseUrl());
  if (await healthy(url)) return { state: "online", ok: true, message: "Mind Voice đang chạy." };
  const target = localTarget(url);
  if (!target) return { state: "remote", ok: false, message: `Mind Voice được cấu hình ở ${url} (không phải máy này) - app không tự khởi động được.` };
  if (!mindInstalled()) {
    return { state: "not_installed", ok: false, message: "Chưa cài Mind Voice trên máy này (thiếu voice-engine\\.venv). Chạy voice-engine\\setup_voice_engine.bat một lần." };
  }
  if (fs.existsSync(lockFile()) && Date.now() - fs.statSync(lockFile()).mtimeMs < LOCK_STALE_MS) {
    return { state: "starting", ok: false, message: "Mind Voice đang khởi động…" };
  }
  if (await portListening(target.host, target.port)) {
    return { state: "port_busy", ok: false, message: `Cổng ${target.port} đang bị một chương trình khác chiếm (không phải Mind Voice). Đóng chương trình đó rồi bấm Kiểm tra lại.` };
  }
  return { state: "failed", ok: false, message: `Mind Voice chưa chạy (không có dịch vụ ở cổng ${target.port}).` };
}

async function start(timeoutMs: number): Promise<MindLaunchResult> {
  const url = await mindBaseUrl();
  if (await healthy(url)) return { state: "online", ok: true, message: "Mind Voice đang chạy." };
  const target = localTarget(url);
  if (!target) return diagnoseMindVoice(url);
  if (!mindInstalled()) return diagnoseMindVoice(url);
  if (await portListening(target.host, target.port)) {
    // Already starting (or another program): give it the time, never a second service.
    if (await waitHealthy(url, Math.min(timeoutMs, 15_000))) return { state: "online", ok: true, message: "Mind Voice đang chạy." };
    return diagnoseMindVoice(url);
  }
  if (!takeLock()) {
    // Another process is starting it right now.
    if (await waitHealthy(url, timeoutMs)) return { state: "online", ok: true, message: "Mind Voice đang chạy." };
    return { state: "failed", ok: false, message: "Mind Voice không phản hồi sau khi khởi động. Xem logs\\mind-voice.log." };
  }
  try {
    spawnLauncher(target.port);
    if (await waitHealthy(url, timeoutMs)) return { state: "started", ok: true, message: "Đã khởi động Mind Voice (cửa sổ thu nhỏ \"Mind Voice\")." };
    return { state: "failed", ok: false, message: `Đã chạy voice-engine\\start_voice_engine.bat nhưng Mind Voice không phản hồi sau ${Math.round(timeoutMs / 1000)} s. Xem logs\\mind-voice.log.` };
  } finally {
    releaseLock();
  }
}

const g = globalThis as unknown as { __mindVoiceStart?: Promise<MindLaunchResult> };

/** Start Mind Voice if it is installed here and not running; wait until /health answers. */
export function ensureMindVoice(timeoutMs = MIND_START_TIMEOUT_MS): Promise<MindLaunchResult> {
  g.__mindVoiceStart ??= start(timeoutMs).finally(() => {
    g.__mindVoiceStart = undefined;
  });
  return g.__mindVoiceStart;
}
