import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Ask the vendor what happened to a video job we already created, and collect
 * the file if it finished.
 *
 * This exists for the one situation that costs real money to get wrong: a
 * create that succeeded, followed by a failure on our side - a timeout, a
 * crash, a dropped connection. The clip may already be paid for. Sending the
 * request again buys a second one; asking costs nothing.
 *
 * Every request here is a GET. There is deliberately no code path in this file
 * that can reach a create endpoint.
 *
 * It also reads the credit balance, which is the only independent check on
 * whether a charge landed: our ledger records what we think happened, the
 * balance records what did.
 *
 * Usage:
 *   npx tsx scripts/video-job-status.ts --provider runway
 *   npx tsx scripts/video-job-status.ts --provider runway --id <task id>
 *   npx tsx scripts/video-job-status.ts --provider runway --id <task id> --download
 */

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface TaskView {
  status: string;
  failure?: string;
  failureCode?: string;
  credits?: number;
  outputUrl?: string;
  raw: string;
  httpStatus: number;
  /** Vendor request id, if the response carried one. Worth keeping for support. */
  requestId?: string;
}

async function fetchTask(
  baseUrl: string,
  apiKey: string,
  taskId: string,
): Promise<TaskView | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/tasks/${taskId}`, {
      headers: {
        "X-Runway-Version": "2024-11-06",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.text();
    // Vendors name this header differently; keep whichever one is present so a
    // support ticket has something to quote.
    const requestId =
      res.headers.get("x-request-id") ??
      res.headers.get("x-runway-request-id") ??
      res.headers.get("cf-ray") ??
      undefined;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* keep raw */
    }
    const cost = parsed.cost as { credits?: number } | undefined;
    const output = parsed.output as string[] | undefined;
    return {
      httpStatus: res.status,
      status: typeof parsed.status === "string" ? parsed.status : "?",
      failure: typeof parsed.failure === "string" ? parsed.failure : undefined,
      failureCode:
        typeof parsed.failureCode === "string" ? parsed.failureCode : undefined,
      credits: cost?.credits,
      outputUrl: Array.isArray(output) ? output[0] : undefined,
      raw,
      requestId,
    };
  } catch {
    return null;
  }
}

async function balanceOf(baseUrl: string, apiKey: string): Promise<number | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/organization`, {
      headers: {
        "X-Runway-Version": "2024-11-06",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { creditBalance?: number };
    return json.creditBalance ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const provider = arg("provider", "runway");
  const onlyId = arg("id", "");
  const wantDownload = flag("download");

  const { resolveApiKey, resolveBaseUrl } = await import(
    "../src/providers/provider-credentials"
  );
  const { toAbsolute, projectSubdir, uuidFilename } = await import("../src/lib/paths");

  const apiKey = await resolveApiKey(provider);
  const baseUrl = await resolveBaseUrl(provider);

  console.log(`\n========== JOB VIDEO ${provider.toUpperCase()} (chi GET, khong tinh tien) ==========\n`);

  const balance = await balanceOf(baseUrl, apiKey);
  console.log(
    `  So du hien tai : ${balance === null ? "khong doc duoc" : `${balance} credit (~$${(balance * 0.01).toFixed(2)})`}`,
  );

  const jobs = await prisma.providerJob.findMany({
    where: {
      provider,
      kind: "video",
      ...(onlyId ? { externalId: onlyId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  // A task id the operator typed that we have no record of is still worth
  // asking about - that is exactly the "we crashed before writing it down" case.
  const ids = jobs.map((j) => j.externalId).filter((x): x is string => Boolean(x));

  // Earlier attempts on the same work. Runway has NO endpoint that lists tasks,
  // so an id that is not in our own ledger is gone forever - which is exactly
  // why these are kept, and why they must be checked too.
  for (const job of jobs) {
    try {
      const prior: unknown = JSON.parse(job.previousExternalIds);
      if (Array.isArray(prior)) {
        for (const id of prior) {
          if (typeof id === "string" && !ids.includes(id)) ids.push(id);
        }
      }
    } catch {
      /* a malformed history is not a reason to stop looking */
    }
  }

  if (onlyId && !ids.includes(onlyId)) ids.unshift(onlyId);

  console.log(`  Job se kiem tra: ${ids.length}\n`);
  if (ids.length === 0) {
    console.log("  Khong co job nao de kiem tra.\n");
    return;
  }

  for (const id of ids) {
    const job = jobs.find((j) => j.externalId === id);
    const isPrior = !job && jobs.some((j) => j.previousExternalIds.includes(id));
    console.log(`  ---- ${id} ----`);
    if (isPrior) console.log("    (LAN THU TRUOC tren cung cong viec)");
    if (job) {
      console.log(`    So ghi cua ta : ${job.status}, uoc tinh $${job.estimatedCost.toFixed(6)}, da ghi $${job.actualCost.toFixed(6)}`);
      console.log(`    Tao luc       : ${job.createdAt.toISOString()}`);
      console.log(`    So lan thu    : ${job.attempts}`);
      if (job.error) console.log(`    Loi da luu    : ${job.error}`);
    } else {
      console.log("    So ghi cua ta : KHONG CO - id nay khong nam trong so cua ung dung");
    }

    const view = await fetchTask(baseUrl, apiKey, id);
    if (!view) {
      console.log("    Nha cung cap  : khong hoi duoc (loi mang)\n");
      continue;
    }
    console.log(`    Nha cung cap  : HTTP ${view.httpStatus}, status ${view.status}`);
    if (view.requestId) console.log(`    Request ID    : ${view.requestId}`);
    if (view.failureCode) console.log(`    failureCode   : ${view.failureCode}`);
    if (view.failure) console.log(`    failure       : ${view.failure}`);
    console.log(
      `    CHI PHI THAT  : ${view.credits === undefined ? "khong bao" : `${view.credits} credit = $${(view.credits * 0.01).toFixed(4)}`}`,
    );
    console.log(`    Body day du   : ${view.raw.slice(0, 500)}`);

    // Recovery: a finished clip is already paid for, so collecting it is free
    // and is the whole reason this tool exists.
    if (view.status.toUpperCase() === "SUCCEEDED" && view.outputUrl) {
      if (!wantDownload) {
        console.log("    -> Job DA XONG. Them --download de tai ve (mien phi, da tra tien roi).");
      } else if (!job?.projectId) {
        console.log("    -> Job DA XONG nhung khong biet thuoc du an nao, khong biet luu vao dau.");
      } else {
        const dest = toAbsolute(
          path.join(projectSubdir(job.projectId, "videos"), uuidFilename(".mp4")),
        );
        const res = await fetch(view.outputUrl, { signal: AbortSignal.timeout(300_000) });
        if (!res.ok) {
          console.log(`    -> Tai that bai: HTTP ${res.status}`);
        } else {
          const bytes = Buffer.from(await res.arrayBuffer());
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, bytes);
          console.log(`    -> DA TAI VE: ${dest} (${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB)`);
        }
      }
    }
    console.log("");
  }

  console.log("  (Khong co duong nao trong tep nay goi den endpoint create.)\n");
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
