/**
 * Bring the ledger back in line with what the vendors actually charged.
 *
 * WHAT WENT WRONG
 * ---------------
 * A failed Runway clip was settled by assumption rather than by evidence. The
 * request had left the machine, so the code held the $0.25 estimate against the
 * batch "in case it was billed" - while the same HTTP response it had just read
 * said `cost: { credits: 0 }`, and the account balance was 831 credits before
 * the run and 831 after. The adapter never surfaced the number and the
 * settlement never asked for it.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 *   1. backfills ProviderJob.failureCode / billedUnits for failed jobs
 *   2. corrects settlements the vendor says were never billed
 *   3. files the failure as evidence, keyed by model + input fingerprint
 *   4. re-judges model reliability from that evidence
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * Correct a settlement on anybody's say-so. Every correction needs a source:
 * either a live read of the task, or a VideoBenchmark row recorded at the time.
 * An unsourced job is reported and left alone - a ledger that can be edited by
 * assertion is not a ledger.
 *
 * COST: zero. `--verify` issues GETs, which Runway does not bill (polling a
 * task is free), and nothing here can POST a generation.
 *
 *   npx tsx scripts/repair-failure-accounting.ts            # dry run
 *   npx tsx scripts/repair-failure-accounting.ts --apply
 *   npx tsx scripts/repair-failure-accounting.ts --apply --verify
 */
import { prisma } from "../src/lib/prisma";
import { correctSettlement } from "../src/services/cost-reservation";
import {
  evaluateReliability,
  failureTally,
  fingerprintInput,
  recordFailureEvidence,
} from "../src/services/model-reliability";
import { getTask } from "../src/providers/runway/runway-video-client";
import { splitModelSize } from "../src/providers/video-config";
import { parseJson } from "../src/lib/utils";
import { marksProviderUnsuitable, withFlag } from "../src/domain/video-suitability";

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");

interface Evidence {
  failureCode: string;
  billedUnits: number;
  source: string;
}

function money(n: number): string {
  return `$${n.toFixed(6)}`;
}

/** Ask the vendor. Read-only, unbilled, and the best source there is. */
async function fromVendor(
  provider: string,
  model: string,
  taskId: string,
): Promise<Evidence | null> {
  if (provider !== "runway") return null;
  const apiKey = process.env.RUNWAY_API_KEY ?? "";
  if (!apiKey) return null;
  const { apiModel, size } = splitModelSize(model);
  try {
    const task = await getTask(
      {
        providerName: "runway",
        model: apiModel,
        apiKey,
        baseUrl: process.env.RUNWAY_BASE_URL ?? "https://api.dev.runwayml.com/v1",
        pricePerSecond: 0,
        size,
        timeoutMs: 30_000,
      },
      taskId,
    );
    if (task.billedCredits === null) return null;
    return {
      failureCode: task.failureCode ?? task.error ?? "",
      billedUnits: task.billedCredits,
      source: `runway GET /tasks/${taskId}`,
    };
  } catch (err) {
    console.log(`    ! không đọc được task ${taskId}: ${String(err)}`);
    return null;
  }
}

/** What was written down at the time, by the benchmark harness. */
async function fromBenchmark(taskId: string): Promise<Evidence | null> {
  const row = await prisma.videoBenchmark.findFirst({ where: { taskId } });
  if (!row || row.outcome !== "failed" || !row.failureCode) return null;
  return {
    failureCode: row.failureCode,
    billedUnits: row.credits,
    source: `VideoBenchmark ${row.id.slice(0, 8)}`,
  };
}

async function main() {
  console.log(
    APPLY ? "=== SỬA SỔ (ghi thật) ===" : "=== THỬ KHÔ - không ghi gì ===",
  );
  console.log(VERIFY ? "Nguồn: hỏi lại nhà cung cấp (GET, miễn phí)\n" : "Nguồn: bản ghi đã có\n");

  const failed = await prisma.providerJob.findMany({
    where: { status: "failed" },
    orderBy: { createdAt: "asc" },
  });

  let corrected = 0;
  let reclaimed = 0;
  const touchedModels = new Set<string>();

  for (const job of failed) {
    console.log(`--- ${job.provider}/${job.model} ${job.kind} task=${job.externalId ?? "-"}`);
    console.log(`    message: ${job.error ?? "-"}`);

    if (!job.externalId) {
      console.log("    bỏ qua: không có task id, không tra cứu được.\n");
      continue;
    }

    const evidence =
      (VERIFY ? await fromVendor(job.provider, job.model, job.externalId) : null) ??
      (await fromBenchmark(job.externalId));

    if (!evidence) {
      console.log("    KHÔNG CÓ BẰNG CHỨNG -> để nguyên. Không sửa sổ theo phỏng đoán.\n");
      continue;
    }
    console.log(
      `    bằng chứng (${evidence.source}): ${evidence.failureCode}, ` +
        `credits=${evidence.billedUnits}`,
    );

    // 1. The job row keeps the vendor's own words.
    if (APPLY) {
      await prisma.providerJob.update({
        where: { id: job.id },
        data: {
          failureCode: evidence.failureCode,
          billedUnits: evidence.billedUnits,
          actualCost: evidence.billedUnits === 0 ? 0 : job.actualCost,
        },
      });
    }

    // 2. The settlement. Zero credits means the money goes back, full stop.
    const reservation = await prisma.costReservation.findUnique({
      where: { idempotencyKey: job.idempotencyKey },
    });
    if (reservation && evidence.billedUnits === 0 && reservation.actualCost > 0) {
      console.log(
        `    SỬA: reservation ${money(reservation.actualCost)} -> ${money(0)} ` +
          `(${reservation.status})`,
      );
      reclaimed += reservation.actualCost;
      corrected += 1;
      if (APPLY) {
        await correctSettlement(job.idempotencyKey, {
          actualCost: 0,
          reason:
            `Nhà cung cấp xác nhận không tính phí (credits=0, ${evidence.failureCode}). ` +
            `Nguồn: ${evidence.source}.`,
        });
      }
    } else if (reservation) {
      console.log(`    reservation ${reservation.status} ${money(reservation.actualCost)} - đúng rồi.`);
    } else {
      console.log("    không có reservation (chạy ngoài lô).");
    }

    // 3. File it as evidence so nobody buys this answer again.
    const scene = job.sceneId
      ? await prisma.scene.findUnique({ where: { id: job.sceneId } })
      : null;
    const sent = parseJson<Record<string, unknown>>(job.requestJson, {});
    const prompt =
      typeof sent.promptText === "string"
        ? sent.promptText
        : typeof sent.prompt === "string"
          ? sent.prompt
          : (scene?.videoPrompt ?? "");
    const fingerprintArgs = {
      model: job.model,
      kind: job.kind,
      prompt,
      keyframePath: scene?.imagePath ?? null,
      durationSeconds: scene?.duration ?? null,
    };
    console.log(`    fingerprint: ${fingerprintInput(fingerprintArgs)}`);
    if (APPLY) {
      const verdict = await recordFailureEvidence({
        ...fingerprintArgs,
        provider: job.provider,
        failureCode: evidence.failureCode,
        message: job.error ?? "",
        projectId: job.projectId,
        sceneId: job.sceneId,
        taskId: job.externalId,
        billedUnits: evidence.billedUnits,
        actualCost: evidence.billedUnits === 0 ? 0 : job.actualCost,
      });
      console.log(
        `    evidence: ${verdict.recorded ? "đã ghi" : "bỏ qua (lỗi không nói về model)"}` +
          `, reliability=${verdict.reliability}`,
      );
    }
    // 4. The per-scene flag that should have been set at the time. Narrower
    //    than the fingerprint rule - it bans the whole PROVIDER from this
    //    scene, which is what lets the router pick someone else rather than
    //    simply failing.
    const flag = marksProviderUnsuitable(job.provider, evidence.failureCode);
    if (flag && scene) {
      const current = parseJson<string[]>(scene.providerFlagsJson, []);
      const next = withFlag(current, flag);
      if (next.length !== current.length) {
        console.log(`    cờ cảnh: + ${flag}`);
        if (APPLY) {
          await prisma.scene.update({
            where: { id: scene.id },
            data: { providerFlagsJson: JSON.stringify(next) },
          });
        }
      } else {
        console.log(`    cờ cảnh: đã có ${flag}`);
      }
    }

    touchedModels.add(`${job.provider}|${job.model}`);
    console.log("");
  }

  console.log("=== TỔNG ===");
  console.log(`Số settlement sai: ${corrected}`);
  console.log(`Số tiền trả lại lô: ${money(reclaimed)}`);

  for (const entry of touchedModels) {
    const [provider, model] = entry.split("|");
    if (!provider || !model) continue;
    const tally = await failureTally(model);
    const ok = await prisma.videoBenchmark.count({
      where: { model, outcome: "succeeded" },
    });
    const verdict = APPLY
      ? await evaluateReliability(provider, model)
      : { reliability: "(thử khô)", distinctScenes: tally.distinctScenes };
    console.log(
      `${provider}/${model}: thất bại ${tally.failures} (trên ${tally.distinctScenes} cảnh khác nhau), ` +
        `thành công ${ok} -> ${verdict.reliability}`,
    );
  }

  if (!APPLY) console.log("\nChạy lại với --apply để ghi.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
