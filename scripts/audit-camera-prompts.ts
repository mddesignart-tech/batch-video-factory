/**
 * What every scene's prompt will look like when it reaches a video model.
 *
 * FREE. No network calls, no writes, no API of any kind. It runs the same
 * classifier and the same guardrail composer that `generateSceneVideo` runs at
 * send time, so what it prints is what would actually be sent.
 *
 * Written after an audit found 17 of 23 scenes carrying prompts with no camera
 * lock - seventeen repeats of the one clip this project has paid for that
 * scored 1/10 on camera. The point of a preview is to find the eighteenth
 * before it costs anything.
 *
 *   npx tsx scripts/audit-camera-prompts.ts
 *   npx tsx scripts/audit-camera-prompts.ts --verbose
 */
import { prisma } from "../src/lib/prisma";
import { classifyCameraIntent } from "../src/domain/camera-intent";
import {
  applyCameraGuardrails,
  fitVideoPrompt,
  findPromptContradictions,
  RUNWAY_MAX_PROMPT_CHARS,
} from "../src/domain/video-prompt";

const VERBOSE = process.argv.includes("--verbose");

async function main() {
  const scenes = await prisma.scene.findMany({
    where: { skipped: false },
    include: { project: { include: { idiom: true } } },
    orderBy: [{ projectId: "asc" }, { sceneNumber: "asc" }],
  });

  let locked = 0;
  let directed = 0;
  let defaulted = 0;
  const contradictions: string[] = [];
  const overLimit: string[] = [];
  const stillUnlocked: string[] = [];

  console.log("=== XEM TRƯỚC PROMPT SẼ GỬI (miễn phí, không gọi API) ===\n");
  console.log(
    "Cảnh      #  Độ khó  Chế độ            Trước→Sau  Thêm  Bỏ  Ký tự  Ghi chú",
  );

  for (const scene of scenes) {
    const intent = classifyCameraIntent(scene);
    const before = scene.videoPrompt;
    const guarded = applyCameraGuardrails(before, intent, RUNWAY_MAX_PROMPT_CHARS);
    // The adapter runs one more step before the wire: fitVideoPrompt compacts
    // anything still over the vendor ceiling. A preview that stopped short of
    // it would be previewing a request nobody sends - and it is exactly where
    // the two long legacy prompts end up.
    let sent = guarded.text;
    let compacted = false;
    try {
      const fitted = fitVideoPrompt(guarded.text, RUNWAY_MAX_PROMPT_CHARS);
      sent = fitted.text;
      compacted = fitted.changed;
    } catch {
      // PromptTooLongError: even the compact form does not fit. Reported below
      // as over-limit rather than swallowed.
      sent = guarded.text;
    }

    if (intent.mode === "LOCKED_CAMERA") locked += 1;
    else directed += 1;
    if (intent.defaulted) defaulted += 1;

    const hadLock = /\block(?:ed)?\b/i.test(before);
    // Checked against `sent`, not `guarded.text`: the compaction step can
    // replace the whole constraint block, so the only text worth auditing is
    // the one that actually goes on the wire.
    const hasLock = /\block(?:ed)?\b/i.test(sent);
    const found = findPromptContradictions(sent);
    if (found.length > 0) {
      contradictions.push(`${scene.id.slice(0, 8)} #${scene.sceneNumber}: ${found.join("; ")}`);
    }
    if (sent.length > RUNWAY_MAX_PROMPT_CHARS) {
      overLimit.push(`${scene.id.slice(0, 8)} #${scene.sceneNumber}: ${sent.length}`);
    }
    // A LOCKED scene that still has no lock wording after the pass is the exact
    // failure this system exists to prevent - usually because the prompt was
    // already so long the guardrail would not fit.
    if (intent.mode === "LOCKED_CAMERA" && !hasLock) {
      stillUnlocked.push(
        `${scene.id.slice(0, 8)} #${scene.sceneNumber} (${guarded.chars} ký tự${guarded.truncated ? ", HẾT CHỖ" : ""})`,
      );
    }

    console.log(
      `${scene.id.slice(0, 8)} ${String(scene.sceneNumber).padEnd(3)}` +
        `${scene.complexity.padEnd(8)}${intent.mode.padEnd(18)}` +
        `${(hadLock ? "khoá" : "-").padEnd(5)}→${(hasLock ? "khoá" : "-").padEnd(5)}` +
        `${String(guarded.added.length).padEnd(6)}${String(guarded.skipped.length).padEnd(4)}` +
        `${String(sent.length).padEnd(7)}` +
        `${guarded.truncated ? "HẾT CHỖ " : ""}${compacted ? "rút gọn" : ""}`,
    );
    if (VERBOSE) {
      console.log(`    lý do: ${intent.reason}`);
      if (intent.movements.length > 0) {
        console.log(`    chuyển động kịch bản yêu cầu: ${intent.movements.join(", ")}`);
      }
    }
  }

  console.log("\n=== TỔNG KẾT ===");
  console.log(`Tổng số cảnh          : ${scenes.length}`);
  console.log(`LOCKED_CAMERA         : ${locked}`);
  console.log(`DIRECTED_CAMERA       : ${directed}`);
  console.log(`  (trong đó mặc định  : ${defaulted} — kịch bản không ghi ý đồ camera)`);
  console.log(`Chưa phân loại được   : ${scenes.length - locked - directed}`);

  console.log(`\nMâu thuẫn còn lại     : ${contradictions.length}`);
  for (const c of contradictions) console.log(`  ${c}`);
  console.log(`Vượt giới hạn ký tự   : ${overLimit.length}`);
  for (const c of overLimit) console.log(`  ${c}`);
  console.log(`LOCKED mà vẫn chưa khoá: ${stillUnlocked.length}`);
  for (const c of stillUnlocked) console.log(`  ${c}`);

  const before = scenes.filter((s) => !/\block(?:ed)?\b/i.test(s.videoPrompt)).length;
  console.log(`\nTrước khi chuẩn hoá   : ${before}/${scenes.length} cảnh thiếu chữ "locked"`);
  const after = scenes.filter((s) => {
    const intent = classifyCameraIntent(s);
    if (intent.mode !== "LOCKED_CAMERA") return false;
    const g = applyCameraGuardrails(s.videoPrompt, intent, RUNWAY_MAX_PROMPT_CHARS);
    let text = g.text;
    try {
      text = fitVideoPrompt(text, RUNWAY_MAX_PROMPT_CHARS).text;
    } catch {
      // Reported separately in the over-limit list.
    }
    return !/\block(?:ed)?\b/i.test(text);
  }).length;
  console.log(`Sau khi chuẩn hoá     : ${after}/${scenes.length} cảnh LOCKED còn thiếu khoá`);
  console.log(
    after === 0 && contradictions.length === 0 && overLimit.length === 0
      ? "\nKẾT LUẬN: sạch."
      : "\nKẾT LUẬN: còn việc phải sửa — xem danh sách trên.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
