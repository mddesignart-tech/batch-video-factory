import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { toAbsolute, toRelative, projectSubdir, uuidFilename } from "@/lib/paths";
import { ffmpeg, ffprobe } from "@/media/ffmpeg";

/**
 * Pull a scene's speech back inside its planned duration by shortening SILENCE,
 * never speech.
 *
 * ## The problem this solves
 *
 * `buildSceneTimeline` extends a scene when its speech outruns the planned
 * length - the right call, because the alternative is a clipped word. But a
 * scene that runs 0.09s long drags the cut after it, and the fix is not to cut
 * the line: it is to take the slack out of the pauses the TTS left behind.
 *
 * ## What it will and will not touch
 *
 * It re-cuts the line's audio as a set of keep-windows and concatenates them.
 * Every window boundary falls INSIDE a silence that `silencedetect` found, so
 * no sample of speech is ever removed and no sample is time-stretched. Playback
 * speed is untouched: the voice sounds the same, there is simply less air.
 *
 * Floors exist so "less air" does not become "breathless":
 *
 *   internal pause   >= 0.15s   a phrase boundary is still audible as one
 *   trailing silence >= 0.03s   the line does not slam into the next scene
 *   leading silence  >= 0.05s
 *
 * Dead air at the ends goes first, then the longest internal pauses. If the
 * floors cannot buy enough room, it STOPS and says so rather than shaving the
 * pauses flat or touching the words - rewriting a line is the operator's call,
 * not a script's.
 *
 * ## Cost
 *
 * Zero. FFmpeg on this machine, no provider is contacted. The original file is
 * left on disk untouched and the new cut is written beside it, so the paid TTS
 * output remains recoverable and this is reversible by pointing the row back.
 *
 *   npx tsx scripts/tighten-scene-pacing.ts --project <id>            # dry run
 *   npx tsx scripts/tighten-scene-pacing.ts --project <id> --apply
 */

const INTERNAL_PAUSE_FLOOR = 0.15;
const TRAILING_FLOOR = 0.03;
const LEADING_FLOOR = 0.05;
/** Aim this far under the planned duration so rounding cannot push it back over. */
const HEADROOM = 0.05;
const SILENCE_DB = -45;
const SILENCE_MIN = 0.05;

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const secs = (n: number) => `${n.toFixed(4)}s`;

interface Silence {
  start: number;
  end: number;
  length: number;
  kind: "leading" | "internal" | "trailing";
}

async function durationOf(file: string): Promise<number> {
  const { stdout } = await ffprobe([
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    file,
  ]);
  return Number(stdout.trim());
}

/** Silence windows as ffmpeg hears them, labelled by where they sit. */
async function silencesIn(file: string, total: number): Promise<Silence[]> {
  const { stderr } = await ffmpeg([
    "-hide_banner",
    "-i", file,
    "-af", `silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MIN}`,
    "-f", "null",
    process.platform === "win32" ? "NUL" : "/dev/null",
  ]);

  const out: Silence[] = [];
  let pending: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start?.[1] !== undefined) pending = Number(start[1]);
    const end = /silence_end:\s*([\d.]+)/.exec(line);
    if (end?.[1] !== undefined && pending !== null) {
      const s = Math.max(0, pending);
      const e = Number(end[1]);
      out.push({
        start: s,
        end: e,
        length: e - s,
        kind: s <= 0.01 ? "leading" : e >= total - 0.01 ? "trailing" : "internal",
      });
      pending = null;
    }
  }
  // A file ending in silence reports a start with no matching end.
  if (pending !== null && total - pending > 0.001) {
    out.push({
      start: pending,
      end: total,
      length: total - pending,
      kind: "trailing",
    });
  }
  return out;
}

function floorFor(s: Silence): number {
  return s.kind === "trailing"
    ? TRAILING_FLOOR
    : s.kind === "leading"
      ? LEADING_FLOOR
      : INTERNAL_PAUSE_FLOOR;
}

interface Plan {
  keep: { start: number; end: number }[];
  cuts: { silence: Silence; from: number; to: number }[];
  before: number;
  after: number;
  shortfall: number;
}

/**
 * Decide how much to take out of each silence.
 *
 * Ends first: dead air before the first word and after the last is the cheapest
 * thing in the file, and removing it changes nothing anyone can hear. Only then
 * the internal pauses, longest first, because taking 0.1s out of a 0.3s beat is
 * far less audible than taking it out of a 0.16s one.
 */
function planTrim(total: number, silences: Silence[], target: number): Plan {
  const need = total - target;
  const order = [...silences].sort((a, b) => {
    const edge = (s: Silence) => (s.kind === "internal" ? 1 : 0);
    if (edge(a) !== edge(b)) return edge(a) - edge(b);
    return b.length - a.length;
  });

  const newLength = new Map<Silence, number>();
  let remaining = Math.max(0, need);
  for (const s of order) {
    const available = Math.max(0, s.length - floorFor(s));
    const take = Math.min(available, remaining);
    newLength.set(s, s.length - take);
    remaining -= take;
  }

  const kept = [...silences].sort((a, b) => a.start - b.start);
  const keep: { start: number; end: number }[] = [];
  const cuts: Plan["cuts"] = [];
  let cursor = 0;
  for (const s of kept) {
    const length = newLength.get(s) ?? s.length;
    if (length < s.length) cuts.push({ silence: s, from: s.length, to: length });
    keep.push({ start: cursor, end: s.start + length });
    cursor = s.end;
  }
  if (cursor < total) keep.push({ start: cursor, end: total });

  const after = keep.reduce((sum, w) => sum + (w.end - w.start), 0);
  return { keep, cuts, before: total, after, shortfall: remaining };
}

/** Re-cut the file from the keep-windows. No filter here re-times audio. */
async function writeTrimmed(
  source: string,
  keep: { start: number; end: number }[],
  destination: string,
): Promise<void> {
  const parts = keep
    .map(
      (w, i) =>
        `[0:a]atrim=start=${w.start.toFixed(6)}:end=${w.end.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`,
    )
    .join(";");
  const chain = keep.map((_, i) => `[a${i}]`).join("");
  await ffmpeg([
    "-hide_banner",
    "-loglevel", "error",
    "-i", source,
    "-filter_complex", `${parts};${chain}concat=n=${keep.length}:v=0:a=1[out]`,
    "-map", "[out]",
    "-c:a", "pcm_s16le",
    "-ar", "24000",
    "-ac", "1",
    destination,
    "-y",
  ]);
}

async function main(): Promise<void> {
  const projectId = arg("project");
  const only = arg("scene");
  const apply = process.argv.includes("--apply");

  console.log("=".repeat(88));
  console.log(`  SIET NHIP CANH  ${apply ? "[GHI THAT]" : "[DRY RUN]"}  (chi dung FFmpeg, $0)`);
  console.log("=".repeat(88));

  const scenes = await prisma.scene.findMany({
    where: { projectId, skipped: false },
    include: { dialogueLines: { orderBy: { lineNumber: "asc" } } },
    orderBy: { sceneNumber: "asc" },
  });
  if (scenes.length === 0) throw new Error(`Khong tim thay canh nao cua ${projectId}`);

  let changed = 0;
  let blocked = 0;

  for (const scene of scenes) {
    if (only && String(scene.sceneNumber) !== only) continue;
    const lines = scene.dialogueLines.filter((l) => l.outputPath.length > 0);
    if (lines.length === 0) continue;

    // What the timeline will do with these lines as they stand. One line means
    // no inter-line pause; several carry the default gap between them.
    const speech = lines.reduce((sum, l) => sum + l.durationSec, 0);
    const overrun = speech - scene.duration;
    const flag = overrun > 0 ? "TRAN" : "vua";
    console.log(
      `\ncanh ${scene.sceneNumber}: thoai ${secs(speech)} / canh ${scene.duration.toFixed(2)}s  ${flag}` +
        `${overrun > 0 ? ` (+${overrun.toFixed(4)}s)` : ""}`,
    );
    if (overrun <= 0) continue;

    // Only single-line scenes are handled here. With several lines the slack
    // may belong in `pauseAfterMs` instead, and picking for the operator would
    // be guessing at intent rather than removing dead air.
    if (lines.length > 1) {
      console.log("  BO QUA: canh co nhieu dong thoai, hay chinh pauseAfterMs thay vi cat file.");
      blocked += 1;
      continue;
    }

    const line = lines[0]!;
    const source = toAbsolute(line.outputPath);
    if (!fs.existsSync(source)) {
      console.log(`  BO QUA: khong tim thay file ${line.outputPath}`);
      blocked += 1;
      continue;
    }

    const total = await durationOf(source);
    const silences = await silencesIn(source, total);
    console.log(`  file  : ${line.outputPath}`);
    console.log(`  do dai: ${secs(total)}`);
    for (const s of silences) {
      console.log(
        `  im lang ${s.kind.padEnd(8)} ${s.start.toFixed(4)} -> ${s.end.toFixed(4)}  ${secs(s.length)}` +
          `  (san toi thieu ${floorFor(s)}s)`,
      );
    }

    const target = scene.duration - HEADROOM;
    const plan = planTrim(total, silences, target);
    if (plan.shortfall > 0.0005) {
      console.log(
        `  DUNG: can bot ${secs(total - target)} nhung im lang chi nhuong duoc ` +
          `${secs(total - target - plan.shortfall)}. Con thieu ${secs(plan.shortfall)}.\n` +
          `  Khong cat vao loi thoai va khong tang toc giong. Hay rut ngan cau thoai roi tao lai.`,
      );
      blocked += 1;
      continue;
    }

    for (const c of plan.cuts) {
      console.log(
        `  cat     ${c.silence.kind.padEnd(8)} ${secs(c.from)} -> ${secs(c.to)}  ` +
          `(bot ${secs(c.from - c.to)})`,
      );
    }
    console.log(`  ket qua: ${secs(plan.before)} -> ${secs(plan.after)}  (muc tieu <= ${secs(target)})`);
    console.log(`  giu nguyen ${plan.keep.length} doan tieng noi, khong cat chu nao, khong doi toc do`);

    if (!apply) {
      changed += 1;
      continue;
    }

    const destination = path.join(projectSubdir(scene.projectId, "audio"), uuidFilename(".wav"));
    await writeTrimmed(source, plan.keep, destination);
    const actual = await durationOf(destination);
    if (actual > target + 0.01) {
      fs.rmSync(destination);
      console.log(`  DUNG: file moi do duoc ${secs(actual)}, van vuot muc tieu. Da xoa, khong ghi DB.`);
      blocked += 1;
      continue;
    }

    await prisma.dialogueLine.update({
      where: { id: line.id },
      data: { outputPath: toRelative(destination), durationSec: actual },
    });
    console.log(`  da ghi : ${toRelative(destination)}  ${secs(actual)}`);
    console.log(`  ban goc giu nguyen tren dia: ${line.outputPath}`);
    changed += 1;
  }

  console.log(
    `\n${apply ? "Da sua" : "Se sua"} ${changed} canh, bo qua ${blocked}. ` +
      `Chi phi API: $0.00.\n` +
      (apply ? "Hay render lai de ap dung.\n" : "Them --apply de ghi.\n"),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
