import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * FFmpeg process handling.
 *
 * Windows notes that drive the design here:
 *  - Arguments are always passed as an array and spawned with `shell: false`.
 *    Nothing is ever string-concatenated into a command line, so paths with
 *    spaces (like "F:\Tool Video Youtube") need no quoting and cannot be used
 *    for injection.
 *  - The `subtitles=` filter has its own escaping grammar in which a Windows
 *    drive letter (`C:`) is ambiguous. Rather than fight it, subtitle burns run
 *    with `cwd` set to the folder holding the file and reference it by bare
 *    filename.
 */

export interface FfmpegResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly args: string[],
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

let ffmpegPathCache: string | null | undefined;
let ffprobePathCache: string | null | undefined;

function unwrapBinaryPath(mod: unknown): string | null {
  if (typeof mod === "string") return mod;
  if (mod && typeof mod === "object" && "path" in mod) {
    const p = (mod as { path?: unknown }).path;
    if (typeof p === "string") return p;
  }
  return null;
}

/**
 * The bundled binaries, loaded with literal specifiers so the bundler can trace
 * them statically. A dynamic `require(variable)` here produces a "critical
 * dependency" warning and an untraceable asset.
 */
function bundledFfmpeg(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return unwrapBinaryPath(require("ffmpeg-static"));
  } catch {
    return null;
  }
}

function bundledFfprobe(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return unwrapBinaryPath(require("ffprobe-static"));
  } catch {
    return null;
  }
}

function onPath(binary: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        /* unreadable PATH entry - keep looking */
      }
    }
  }
  return null;
}

/** Explicit env var wins, then a system install, then the bundled binary. */
export function resolveFfmpeg(): string | null {
  if (ffmpegPathCache !== undefined) return ffmpegPathCache;
  const configured = env().FFMPEG_PATH?.trim();
  ffmpegPathCache =
    (configured && fs.existsSync(configured) ? configured : null) ??
    onPath("ffmpeg") ??
    bundledFfmpeg();
  return ffmpegPathCache;
}

export function resolveFfprobe(): string | null {
  if (ffprobePathCache !== undefined) return ffprobePathCache;
  const configured = env().FFPROBE_PATH?.trim();
  ffprobePathCache =
    (configured && fs.existsSync(configured) ? configured : null) ??
    onPath("ffprobe") ??
    bundledFfprobe();
  return ffprobePathCache;
}

export function resetBinaryCache(): void {
  ffmpegPathCache = undefined;
  ffprobePathCache = undefined;
}

export function ffmpegAvailable(): boolean {
  return resolveFfmpeg() !== null;
}

export const FFMPEG_MISSING_MESSAGE =
  "Không tìm thấy FFmpeg. Xem hướng dẫn cài đặt trong docs/WINDOWS_SETUP.md.";

function run(
  binary: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; keepAllOutput?: boolean } = {},
): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      shell: false, // never let a path fragment reach a command interpreter
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    // FFmpeg is chatty on stderr; cap what we keep so a long render cannot
    // balloon memory while still leaving enough tail to diagnose a failure.
    //
    // `keepAllOutput` exists for capability probes. `-filters` prints far more
    // than 20000 characters, and keeping only the TAIL silently dropped every
    // filter early in the alphabet - `amix` and `areverse` read as missing on a
    // build that has both. A capability check that answers "no" for a filter
    // that exists is worse than no check at all, because the caller then
    // disables a feature that would have worked.
    const keep = (buf: string, chunk: string) =>
      opts.keepAllOutput ? buf + chunk : (buf + chunk).slice(-20000);

    child.stdout.on("data", (d: Buffer) => {
      stdout = keep(stdout, d.toString());
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = keep(stderr, d.toString());
    });

    const timeout = setTimeout(
      () => {
        child.kill("SIGKILL");
        reject(new FfmpegError("FFmpeg quá thời gian cho phép.", stderr, args));
      },
      opts.timeoutMs ?? 10 * 60 * 1000,
    );

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new FfmpegError(err.message, stderr, args));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ code: 0, stdout, stderr });
      else {
        reject(
          new FfmpegError(
            `FFmpeg thoát với mã ${code}.`,
            stderr.slice(-4000),
            args,
          ),
        );
      }
    });
  });
}

export async function ffmpeg(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; keepAllOutput?: boolean } = {},
): Promise<FfmpegResult> {
  const binary = resolveFfmpeg();
  if (!binary) throw new FfmpegError(FFMPEG_MISSING_MESSAGE, "", args);
  return run(binary, args, opts);
}

export async function ffprobe(args: string[]): Promise<FfmpegResult> {
  const binary = resolveFfprobe();
  if (!binary) {
    throw new FfmpegError("Không tìm thấy ffprobe.", "", args);
  }
  return run(binary, args, { timeoutMs: 60_000 });
}

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await ffprobe([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const value = Number.parseFloat(stdout.trim());
  return Number.isFinite(value) ? value : 0;
}

let filterCache: Set<string> | null = null;

/** Which optional filters this build has (libass for subtitle burn-in, etc). */
export async function availableFilters(): Promise<Set<string>> {
  if (filterCache) return filterCache;
  try {
    const { stdout } = await ffmpeg(["-hide_banner", "-filters"], {
      keepAllOutput: true,
    });
    const found = new Set<string>();
    for (const line of stdout.split("\n")) {
      const match = /^\s*[TSC.]{3,}\s+(\S+)/.exec(line);
      if (match?.[1]) found.add(match[1]);
    }
    filterCache = found;
  } catch {
    filterCache = new Set();
  }
  return filterCache;
}

export async function supportsSubtitleBurn(): Promise<boolean> {
  return (await availableFilters()).has("subtitles");
}

export async function ffmpegVersion(): Promise<string | null> {
  try {
    const { stdout } = await ffmpeg(["-hide_banner", "-version"]);
    return stdout.split("\n")[0]?.trim() ?? null;
  } catch {
    return null;
  }
}
