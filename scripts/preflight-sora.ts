import { PrismaClient } from "@prisma/client";

/**
 * Free checks before spending anything on Sora-2.
 *
 * PREFLIGHT ONLY. Every request this script makes is a GET. Nothing here calls
 * POST /videos, so nothing here can start a generation and nothing here can be
 * billed. It does not touch the create permit either - it reads it, prints it,
 * and reads it again at the end, because a preflight that could change the
 * permit would be a preflight that could authorise a purchase.
 *
 * The job is to answer "would the paid call work, and what would it really
 * cost" from what the VENDOR says today rather than from what our seed said in
 * February. Runway taught that twice: a model name trusted from the seed, and a
 * 1000-character prompt limit nobody had checked until it cost a 400.
 *
 * Usage:
 *   npx tsx scripts/preflight-sora.ts --scene 3 --duration 6 --limit 0.90 \
 *     --prompt-file prompts/sora-scene3.txt
 */

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

let failures = 0;
let unknowns = 0;

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "[DAT ]" : "[HONG]"} ${label.padEnd(30)} ${detail}`);
}

/**
 * A fact we could not establish from a live source.
 *
 * Deliberately not a failure. "The vendor said no" and "we never asked" lead to
 * different decisions, and collapsing them into one status is precisely how an
 * unverified assumption gets treated as a verified one.
 */
function unknown(label: string, detail: string): void {
  unknowns += 1;
  console.log(`  [ ?  ] ${label.padEnd(30)} ${detail}`);
}

interface LiveVideoJob {
  id?: string;
  model?: string;
  size?: string;
  seconds?: string | number;
  status?: string;
}

async function main(): Promise<void> {
  const idiom = arg("idiom", "Spill the beans");
  const sceneNumber = Number(arg("scene", "3"));
  const limit = Number(arg("limit", "0.90"));
  const wantModel = arg("model", "sora-2:720x1280");

  process.env.AI_MOCK_MODE = "false";
  const { resetEnvCache, resolvedEnvVarName, envVarCandidates } = await import(
    "../src/lib/env"
  );
  resetEnvCache();
  const { resolveApiKey, resolveBaseUrl } = await import(
    "../src/providers/provider-credentials"
  );
  const { splitModelSize, billedVideoSeconds } = await import(
    "../src/domain/video-duration"
  );
  const { spendStatus } = await import("../src/services/spend-guard");
  const { providerSpendBreakdown } = await import("../src/services/provider-budget");
  const { peekCreateToken } = await import("../src/services/create-token");
  const { toAbsolute } = await import("../src/lib/paths");
  const { ffprobe, resolveFfprobe } = await import("../src/media/ffmpeg");
  const fs = await import("node:fs");
  const path = await import("node:path");

  console.log("\n========== PREFLIGHT SORA-2 (mien phi, chi GET) ==========\n");

  // ---- 1. the permit, read and left alone --------------------------------
  console.log("--- 1. Giay phep tao video ---");
  const permitBefore = await peekCreateToken();
  console.log(
    `         CREATE_ATTEMPT_TOKEN         ${permitBefore ? `1 (${permitBefore.provider}/${permitBefore.model})` : "0"}`,
  );
  console.log("         Preflight nay                CHI DOC, khong cap, khong tieu");

  // ---- 2. key ------------------------------------------------------------
  console.log("\n--- 2. API key ---");
  const varName = resolvedEnvVarName("openai");
  check(
    "Bien moi truong",
    varName !== null,
    varName !== null
      ? `doc tu ${varName}`
      : `khong thay: ${envVarCandidates("openai").join(" / ")}`,
  );
  let apiKey = "";
  try {
    apiKey = await resolveApiKey("openai");
  } catch (err) {
    check("Giai ma key", false, err instanceof Error ? err.message : String(err));
  }
  // Never print the key. Length and last four are enough to tell a real key
  // from a placeholder, and neither can be used to authenticate.
  check(
    "Hinh dang key",
    apiKey.length > 20,
    `do dai ${apiKey.length}, ket thuc ...${apiKey.slice(-4)}`,
  );
  const baseUrl = (await resolveBaseUrl("openai")).replace(/\/+$/, "");
  console.log(
    `         Endpoint create              POST ${baseUrl}/videos   (KHONG goi o day)`,
  );

  if (failures > 0) {
    console.log("\n  [DUNG] Chua co key dung. Khong goi gi them.\n");
    process.exitCode = 1;
    return;
  }

  const auth = { Authorization: `Bearer ${apiKey}` };

  // ---- 3. does the vendor still serve this model, today? -----------------
  console.log("\n--- 3. Model, hoi thang nha cung cap (GET /models) ---");
  const { apiModel, size } = splitModelSize(wantModel);
  let liveModelIds: string[] = [];
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: auth,
      signal: AbortSignal.timeout(30_000),
    });
    console.log(`         GET /models                  -> HTTP ${res.status}`);
    if (res.ok) {
      const json = (await res.json()) as { data?: { id?: string }[] };
      liveModelIds = (json.data ?? []).map((m) => m.id ?? "").filter((id) => id !== "");
    }
  } catch (err) {
    console.log(
      `         GET /models                  -> loi mang: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const soraLive = liveModelIds.filter((id) => id.startsWith("sora")).sort();
  check(
    "API XAC NHAN co model nay",
    soraLive.includes(apiModel),
    soraLive.includes(apiModel)
      ? `"${apiModel}" co trong danh sach live`
      : `"${apiModel}" KHONG co trong danh sach live`,
  );
  console.log(
    `         Ban Sora tai khoan nhin thay ${soraLive.join(", ") || "(khong co)"}`,
  );

  // ---- 4. the registry row we would actually use -------------------------
  console.log("\n--- 4. Dong trong ModelRegistry ---");
  const model = await prisma.modelRegistry.findFirst({
    where: { provider: "openai", type: "video", modelId: wantModel },
  });
  check("Co dong model", model !== null, wantModel);
  if (!model) {
    console.log("\n  [DUNG]\n");
    process.exitCode = 1;
    return;
  }
  const [rawW, rawH] = size.split("x").map(Number);
  const w = rawW ?? 0;
  const h = rawH ?? 0;
  console.log(`         Ten gui len API              ${apiModel}`);
  console.log(`         Resolution                   ${size}`);
  check("Doc 9:16", h > w, `${w}x${h}`);
  check(
    "Image-to-video",
    model.supportsImageToVideo,
    model.supportsImageToVideo ? "co co supportsImageToVideo" : "model khong ho tro",
  );
  console.log(`         Gia trong registry           $${model.price}/giay`);
  console.log(
    `         Gia kiem chung lan cuoi      ${
      model.lastVerifiedAt?.toISOString().slice(0, 10) ?? "CHUA BAO GIO"
    }`,
  );
  console.log(`         maxDuration trong registry   ${model.maxDuration}s`);

  // ---- 5. what this account has ACTUALLY sent and had accepted -----------
  //
  // The live source that matters. /models proves a name exists; it says nothing
  // about which durations or sizes Sora will take. Past jobs do - they are
  // requests this very key made that the vendor accepted.
  console.log("\n--- 5. Job Sora that cua tai khoan (GET /videos) ---");
  const accepted = new Map<string, number>();
  const secondsSeen: number[] = [];
  const sizesSeen = new Set<string>();
  let listed = 0;
  try {
    const res = await fetch(`${baseUrl}/videos?limit=50`, {
      headers: auth,
      signal: AbortSignal.timeout(30_000),
    });
    console.log(`         GET /videos                  -> HTTP ${res.status}`);
    if (res.ok) {
      const json = (await res.json()) as { data?: LiveVideoJob[] };
      const rows = json.data ?? [];
      listed = rows.length;
      for (const j of rows) {
        const secs = Number(j.seconds);
        if (Number.isFinite(secs) && secs > 0) secondsSeen.push(secs);
        if (j.size) sizesSeen.add(j.size);
        const key =
          `${j.model ?? "?"}  ${j.size ?? "?"}  ${j.seconds ?? "?"}s  ` +
          `${j.status ?? "?"}`;
        accepted.set(key, (accepted.get(key) ?? 0) + 1);
      }
    }
  } catch (err) {
    console.log(
      `         GET /videos                  -> loi mang: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  console.log(`         So job lich su               ${listed}`);
  for (const [key, count] of [...accepted.entries()].sort()) {
    console.log(`           ${count}x  ${key}`);
  }
  const uniqueSeconds = [...new Set(secondsSeen)].sort((a, b) => a - b);
  check(
    "Do phan giai da tung gui duoc",
    sizesSeen.size === 0 || sizesSeen.has(size),
    sizesSeen.size === 0
      ? "khong co job lich su de doi chieu"
      : sizesSeen.has(size)
        ? `${size} da tung duoc chap nhan`
        : `chi thay ${[...sizesSeen].join(", ")}`,
  );

  // ---- 6. the duration question, answered honestly -----------------------
  //
  // This step decides whether the cost preview below is worth anything.
  console.log("\n--- 6. Thoi luong Sora that su nhan ---");
  const requested = Number(arg("duration", "6"));
  console.log(`         Canh nay dai                 ${requested}s`);
  console.log(
    `         Do dai da tung gui duoc      ${
      uniqueSeconds.length > 0
        ? uniqueSeconds.map((s) => `${s}s`).join(", ")
        : "(chua co job nao)"
    }`,
  );

  const confirmedDuration = uniqueSeconds.includes(requested);
  if (confirmedDuration) {
    check("Do dai nay gui duoc", true, `${requested}s da tung duoc chap nhan`);
  } else {
    // Not a pass and not a failure. No free endpoint publishes Sora's allowed
    // duration set, and the only way to test one is to send a create - which is
    // the exact thing this preflight exists to avoid.
    unknown(
      `Do dai ${requested}s gui duoc?`,
      "CHUA KIEM CHUNG - khong endpoint mien phi nao cong bo tap do dai hop le, " +
        "cach duy nhat de biet la goi create.",
    );
  }

  // What OUR router would quote. If domain/video-duration has no rule for a
  // provider it passes the requested seconds straight through - which is
  // precisely how the Runway quote came out 20% low.
  const billedByUs = billedVideoSeconds({
    provider: "openai",
    model: wantModel,
    size,
    requestedSeconds: requested,
    hasKeyframe: true,
  });
  if (billedByUs === requested && !confirmedDuration) {
    unknown(
      "Luat tinh tien cho openai",
      `domain/video-duration KHONG co luat rieng cho openai, nen router bao gia ` +
        `dung ${requested}s. Neu Sora lam tron len, bao gia se THAP HON hoa don.`,
    );
  } else {
    check("Luat tinh tien cho openai", true, `bao gia ${billedByUs}s`);
  }

  // ---- 7. the scene, its keyframe and its prompt -------------------------
  console.log("\n--- 7. Canh, keyframe va prompt ---");
  const project = await prisma.project.findFirst({
    where: { idiom: { phrase: idiom } },
    include: { idiom: true, scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  const scene = project?.scenes.find((s) => s.sceneNumber === sceneNumber);
  check("Tim thay canh", Boolean(scene), `${idiom} canh ${sceneNumber}`);
  if (!project || !scene) {
    console.log("\n  [DUNG]\n");
    process.exitCode = 1;
    return;
  }
  const kf = scene.imagePath;
  check("Canh co keyframe", Boolean(kf), kf ?? "khong co");
  if (kf) {
    const abs = toAbsolute(kf);
    const exists = fs.existsSync(abs);
    check(
      "Keyframe tren dia",
      exists,
      exists
        ? `${(fs.statSync(abs).size / 1024 / 1024).toFixed(2)} MB`
        : "khong thay tep",
    );
    // Sora rejects a first-frame image whose pixel size is not EXACTLY the
    // output size. The adapter resizes before sending, so a mismatch is a note
    // rather than a failure - but anyone comparing two vendors should know the
    // image is being re-encoded on the way out.
    if (exists && resolveFfprobe()) {
      try {
        const probe = await ffprobe([
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height",
          "-of",
          "csv=p=0",
          abs,
        ]);
        const dims = probe.stdout.trim().replace(/,/g, "x");
        console.log(
          `         Kich thuoc keyframe          ${dims}` +
            (dims === size ? "  (khop chinh xac)" : `  -> se resize ve ${size}`),
        );
      } catch {
        console.log("         Kich thuoc keyframe          khong doc duoc");
      }
    }
  }

  // The prompt Sora would actually receive. Named on the command line so this
  // checks the text about to be paid for, not whatever the scene row holds.
  const promptFile = arg("prompt-file", "");
  let promptText = scene.videoPrompt;
  let promptSource = "Scene.videoPrompt";
  if (promptFile !== "") {
    const abs = path.resolve(promptFile);
    if (!fs.existsSync(abs)) {
      check("Doc tep prompt", false, `khong thay ${promptFile}`);
    } else {
      promptText = fs.readFileSync(abs, "utf8").trim();
      promptSource = promptFile;
      check("Doc tep prompt", true, promptFile);
    }
  }
  console.log(`         Nguon prompt                 ${promptSource}`);
  check("Prompt khong rong", promptText.length > 0, `${promptText.length} ky tu`);
  // Sora publishes no promptText ceiling the way Runway does, and nothing here
  // has hit one. Saying so beats pretending a limit was checked.
  unknown(
    "Gioi han do dai prompt",
    `Sora khong cong bo gioi han nhu Runway (1000 ky tu). Prompt hien tai ` +
      `${promptText.length} ky tu / ${Buffer.byteLength(promptText, "utf8")} byte.`,
  );

  // ---- 8. cost preview ---------------------------------------------------
  //
  // NOT a single number. The requested length is unverified, so a single
  // "estimate" would be a guess wearing a decimal point - and the guess that
  // comes naturally is the flattering one: price the seconds we asked for and
  // conclude Sora is cheaper. Runway's per-second price also looked lower right
  // up until it quantised 4 seconds to 5.
  //
  // So: a ladder, and the break-even point against what gen4.5 actually cost.
  console.log("\n--- 8. Du toan chi phi ---");
  const status = await spendStatus();
  const perSecond = model.price;
  const gen45 = await prisma.videoBenchmark.findFirst({
    where: { model: { startsWith: "gen4.5" }, sceneNumber, outcome: "succeeded" },
    orderBy: { createdAt: "desc" },
  });

  console.log(`         Gia                          $${perSecond}/giay`);
  if (confirmedDuration) {
    const cost = Math.round(requested * perSecond * 1e6) / 1e6;
    console.log(`         ${requested}s (DA KIEM CHUNG)          $${cost.toFixed(4)}`);
  } else {
    console.log(
      `         Do dai bi tinh tien          CHUA BIET - xem thang gia ben duoi`,
    );
  }

  // The ladder: every length the vendor might settle on, from the shortest we
  // have actually been billed for up to the registry ceiling.
  const ladderFrom = uniqueSeconds.length > 0 ? Math.min(...uniqueSeconds) : requested;
  const ladder: number[] = [];
  for (let sec = Math.min(ladderFrom, requested); sec <= model.maxDuration; sec += 1) {
    ladder.push(sec);
  }
  console.log("\n         Thang gia (giay -> hoa don):");
  for (const sec of ladder) {
    const cost = Math.round(sec * perSecond * 1e6) / 1e6;
    const tags: string[] = [];
    if (uniqueSeconds.includes(sec)) tags.push("da tung gui duoc");
    if (sec === requested) tags.push("do dai canh");
    if (gen45 && cost > gen45.actualCost) tags.push("DAT HON Gen-4.5");
    console.log(
      `           ${String(sec).padStart(2)}s  $${cost.toFixed(4)}` +
        (tags.length > 0 ? `   ${tags.join(", ")}` : ""),
    );
  }

  // ---- 9. against what gen4.5 actually cost, not a list price ------------
  //
  // Sora's price per second is lower. That is not the question. The question is
  // what gets invoiced, which is price times the duration THE VENDOR uses.
  console.log("\n--- 9. So voi Gen-4.5 tren dung canh nay ---");
  let suggestedLimit = limit;
  if (!gen45) {
    console.log("         Chua co benchmark Gen-4.5 cho canh nay.");
  } else {
    const gen45PerSecond = gen45.actualCost / gen45.durationSent;
    const breakEven = gen45.actualCost / perSecond;
    console.log(
      `         Gen-4.5 (DA TRA TIEN)        ${gen45.durationSent}s, ` +
        `$${gen45.actualCost.toFixed(4)}  ($${gen45PerSecond.toFixed(4)}/giay)`,
    );
    console.log(
      `         Sora-2 gia niem yet          $${perSecond.toFixed(4)}/giay ` +
        `(thap hon ${(((gen45PerSecond - perSecond) / gen45PerSecond) * 100).toFixed(0)}%)`,
    );
    console.log(
      `         DIEM HOA VON                 ${breakEven.toFixed(1)}s`,
    );
    console.log(
      `         Nghia la                     Sora chi re hon NEU bi tinh tien ` +
        `<= ${Math.floor(breakEven)}s. Tu ${Math.floor(breakEven) + 1}s tro len la dat hon.`,
    );
    console.log(
      `         Ta biet gi ve do dai         ${
        confirmedDuration
          ? `${requested}s da tung gui duoc - Sora re hon`
          : `CHUA BIET ${requested}s co gui duoc khong. Moi do dai duy nhat tung ` +
            `duoc chap nhan la ${uniqueSeconds.map((x) => `${x}s`).join(", ") || "(khong co)"}.`
      }`,
    );
    if (!confirmedDuration) {
      console.log(
        "         KET LUAN                     CHUA KET LUAN DUOC ai re hon. " +
          "Khong gia dinh Sora re hon.",
      );
    }

    // The hard limit that makes the unknown safe to test.
    //
    // Set it at what gen4.5 actually cost: if our estimate for Sora comes out
    // above that, the spend guard refuses before the request leaves, so the
    // benchmark can only happen on terms where Sora is genuinely the cheaper
    // option. It guards the ESTIMATE, though - if Sora silently bills longer
    // than we quoted, no limit of ours can catch that. Only the invoice can.
    suggestedLimit = Math.round(gen45.actualCost * 1e6) / 1e6;
    console.log(
      `
         HARD LIMIT DE XUAT           $${suggestedLimit.toFixed(4)} ` +
        `(= dung bang Gen-4.5 da tra)`,
    );
    console.log(
      "         Vi sao                       neu bao gia Sora vuot muc nay, " +
        "spend guard chan truoc khi gui,",
    );
    console.log(
      "                                      nen benchmark chi chay khi Sora that su re hon.",
    );
    console.log(
      "         Canh bao                     limit chan BAO GIA CUA TA, khong chan hoa don cua ho.",
    );
  }

  const quoted = Math.round(billedByUs * perSecond * 1e6) / 1e6;
  console.log(`
         Bao gia hien tai cua router  ${billedByUs}s = $${quoted.toFixed(4)}`);
  check(
    "Bao gia <= hard limit de xuat",
    quoted <= suggestedLimit,
    `$${quoted.toFixed(4)} vs $${suggestedLimit.toFixed(4)}`,
  );

  const breakdown = await providerSpendBreakdown();
  const wallet = breakdown.find((b) => b.provider === "openai");
  console.log(
    `         Vi OpenAI da chi             $${(wallet?.spentUsd ?? 0).toFixed(6)}` +
      (wallet?.availableUsd !== null && wallet?.availableUsd !== undefined
        ? `, con lai (KHAI BAO) $${wallet.availableUsd.toFixed(2)}`
        : ""),
  );
  console.log(
    `         Han muc tong                 $${status.spent.toFixed(6)} / $${status.cap.toFixed(2)}`,
  );
  // Checked against the ceiling of the ladder, not the quote: the point of the
  // cap is to survive the case where the quote was wrong.
  const ceiling = Math.round(model.maxDuration * perSecond * 1e6) / 1e6;
  check(
    "Con han muc ke ca khi bi tinh du " + model.maxDuration + "s",
    status.spent + ceiling <= status.cap,
    `can toi da $${ceiling.toFixed(4)}, con lai $${status.remaining.toFixed(6)}`,
  );

  // ---- verdict ------------------------------------------------------------
  console.log("\n---------- KET LUAN ----------");
  console.log(`  Muc khong dat:        ${failures}`);
  console.log(`  Muc CHUA KIEM CHUNG:  ${unknowns}`);
  if (failures > 0) {
    console.log("  PREFLIGHT HONG. KHONG goi API tra phi.\n");
    process.exitCode = 1;
  } else if (unknowns > 0) {
    console.log(
      "  Moi thu kiem chung duoc deu DAT, nhung cac muc [ ? ] o tren chi tra loi\n" +
        "  duoc bang mot lan create that. Quyet dinh chi tien la cua ban.\n",
    );
  } else {
    console.log("  PREFLIGHT DAT.\n");
  }
  const permitAfter = await peekCreateToken();
  console.log(
    `  CREATE_ATTEMPT_TOKEN sau preflight: ${permitAfter ? 1 : 0}` +
      `  (truoc: ${permitBefore ? 1 : 0})\n`,
  );
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
