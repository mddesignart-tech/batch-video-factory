import { prisma } from "@/lib/prisma";
import { isMockMode } from "@/lib/env";
import { ScriptSchema, type ScriptDoc } from "@/domain/script";
import { classifyScene } from "@/services/complexity";
import { withDerivedRouting } from "@/services/script-service";
import { createProjectForIdiom, persistScript } from "@/services/project-service";
import { planBatch } from "@/services/batch-planner";
import { savePlan } from "@/services/batch-runner";
import { createAuthorization } from "@/services/batch-authorization";
import { peekCreateToken } from "@/services/create-token";

/**
 * Hand-write and prepare ONE production-test video. Spends nothing.
 *
 * Writing the script here rather than calling the Text AI is not a shortcut -
 * it is the only option that keeps this step free, and the script is the part
 * that has to be shaped carefully anyway.
 *
 * ## The honesty rule this file follows
 *
 * The scene text below is written to be genuinely simple: one character, one
 * large prop, plain backgrounds, small clear movements. What it does NOT do is
 * omit description in order to score low. Every scene says what is actually on
 * screen, and the classifier is then run over that text and its verdict is what
 * gets stored - `withDerivedRouting` recomputes complexity and spend priority
 * from the words, exactly as it does for a model-written script.
 *
 * If a scene came back MEDIUM the honest response would be to rewrite the SCENE,
 * not to overwrite the label. A declared complexity would route real money on a
 * number nobody checked.
 *
 *   npx tsx scripts/prepare-first-real-video.ts            # dry run, prints only
 *   npx tsx scripts/prepare-first-real-video.ts --persist  # also writes the project
 */

const IDIOM_PHRASE = "Cold feet";

/**
 * Why this idiom.
 *
 * It needs one character, one big prop and no crowd: a person about to do
 * something, then not doing it. Compare the alternatives in the library -
 * "Butterflies in my stomach" is a swarm of small moving objects, which is the
 * exact signal that made Runway refuse a scene twice; "Break the ice" puts the
 * gag at a party, which means a crowd; "Under the weather" is a rain cloud, and
 * rain is repeated small objects by definition.
 *
 * Cold feet is a single slab of cartoon ice and one nervous man.
 */
function buildScript(idiom: {
  phrase: string;
  meaning: string;
  exampleSentence: string;
}): ScriptDoc {
  const scenes = [
    {
      // HOOK. Scene 1 always gets HIGH spend priority, so in BALANCED this is
      // one of the two scenes that will call a video model. Written for the
      // motion gen4_turbo actually does well: a small head movement and a
      // change of expression, on one character against a plain background -
      // the same shape as the scene it succeeded on.
      sceneNumber: 1,
      // FIVE seconds, not four, and the reason is the vendor's price list.
      //
      // Runway sells 5- and 10-second clips only. A 4-second scene is sent as 5
      // and billed as 5 - identical money - and the renderer then trims a second
      // of finished animation off the end. Writing the scene at 5 buys that
      // second back for nothing. It also removes a DURATION_TRANSFORM_REQUIRED
      // notice that would otherwise sit on the plan for no benefit.
      //
      // Five, not six: the complexity classifier adds a point for a scene
      // longer than five seconds, and this scene has to stay LOW.
      duration: 5,
      visualDescription:
        "Max stands alone at the end of a high diving board against a plain pale sky. " +
        "He tips his head down to look at the water far below, and his eyes widen.",
      characterAction: "Max lowers his chin slowly, eyes widening.",
      camera: "Locked static medium shot, no camera movement.",
      dialogue: 'Max: "I am definitely doing this."',
      subtitle: "I am definitely doing this.",
      narration: "",
      soundEffect: "Faint wind",
      imagePrompt: "",
      videoPrompt:
        "Static locked camera. Max slowly tips his head down and his eyes widen. " +
        "No camera movement, no other motion in frame.",
      charactersPresent: ["Max"],
      speakingCharacters: ["Max"],
      primaryCharacters: ["Max"],
    },
    {
      // LITERAL. A still with a slow push-in is enough here - the joke is the
      // reveal, not the motion.
      sceneNumber: 2,
      duration: 4,
      visualDescription:
        "A plain shot of Max from the knees down. Both of his feet are sealed inside " +
        "one thick slab of pale cartoon ice resting on the diving board.",
      characterAction: "Max stays completely still.",
      camera: "Locked static shot.",
      dialogue: 'Max: "...my feet have other plans."',
      subtitle: "...my feet have other plans.",
      narration: "",
      soundEffect: "Ice creak",
      imagePrompt: "",
      videoPrompt: "Static shot, no motion.",
      charactersPresent: ["Max"],
      speakingCharacters: ["Max"],
      primaryCharacters: ["Max"],
    },
    {
      sceneNumber: 3,
      duration: 4,
      visualDescription:
        "Max looks down at the ice on his feet, then up again at the empty sky ahead of him. " +
        "Plain background, nothing else in frame.",
      characterAction: "Max shifts his gaze down, then forward.",
      camera: "Locked static shot.",
      dialogue: 'Max: "It is very cold up here. That is all this is."',
      subtitle: "It is very cold up here. That is all this is.",
      narration: "",
      soundEffect: "",
      imagePrompt: "",
      videoPrompt: "Static shot.",
      charactersPresent: ["Max"],
      speakingCharacters: ["Max"],
      primaryCharacters: ["Max"],
    },
    {
      // PUNCHLINE. Index 3 gets the "punchline" role, which forces HIGH spend
      // priority - so this is the second video-model scene. Again the movement
      // is deliberately small: one head shake and one short step.
      sceneNumber: 4,
      // 5 seconds for the same reason as scene 1 - Runway bills 5 either way.
      duration: 5,
      visualDescription:
        "Max shakes his head once and moves one short pace backwards along the board. " +
        "His eyes stay wide. Plain pale sky behind him, nothing else in frame.",
      characterAction: "Max shakes his head once, then eases one short pace back.",
      camera: "Locked static medium shot, no camera movement.",
      dialogue: 'Max: "Tomorrow. Tomorrow is also a day."',
      subtitle: "Tomorrow. Tomorrow is also a day.",
      narration: "",
      soundEffect: "Small wooden creak",
      imagePrompt: "",
      videoPrompt:
        "Static locked camera. Max shakes his head once, then eases one short pace " +
        "backwards. Eyes stay wide. No camera movement.",
      charactersPresent: ["Max"],
      speakingCharacters: ["Max"],
      primaryCharacters: ["Max"],
    },
    {
      // MEANING. The explanation beat - static by design.
      sceneNumber: 5,
      duration: 4,
      visualDescription:
        "Max stands on plain ground against a clean background, arms relaxed at his sides. " +
        "The ice is gone.",
      characterAction: "Max stands still.",
      camera: "Locked static shot.",
      dialogue: 'Max: "Cold feet means you are suddenly too nervous to do it."',
      subtitle: "Cold feet = suddenly too nervous to do it.",
      narration: "",
      soundEffect: "",
      imagePrompt: "",
      videoPrompt: "Static shot.",
      charactersPresent: ["Max"],
      speakingCharacters: ["Max"],
      primaryCharacters: ["Max"],
    },
    {
      sceneNumber: 6,
      duration: 4,
      visualDescription:
        "Max on the same clean background, giving one small nod, a little calmer than before.",
      characterAction: "Max gives one small nod.",
      camera: "Locked static shot.",
      dialogue: 'Max: "He got cold feet before the interview."',
      subtitle: "He got cold feet before the interview.",
      narration: "",
      soundEffect: "",
      imagePrompt: "",
      videoPrompt: "Static shot.",
      charactersPresent: ["Max"],
      speakingCharacters: ["Max"],
      primaryCharacters: ["Max"],
    },
  ];

  return ScriptSchema.parse({
    idiom: idiom.phrase,
    title: "He Got Cold Feet — Literally",
    hook: "A man on a diving board announces he is definitely doing this.",
    literalMisunderstanding: "His feet are frozen into a slab of cartoon ice.",
    setup: "He is about to jump.",
    escalation: "He insists the cold is the only problem.",
    punchline: "He shakes his head and steps back. Tomorrow is also a day.",
    meaning: idiom.meaning,
    exampleSentence: idiom.exampleSentence,
    durationTarget: 24,
    scenes,
    closingCTA: "Follow for more funny English!",
    angleKey: "diving-board-nerves",
  });
}

async function main(): Promise<void> {
  // --make-batch implies --persist: there is nothing to attach otherwise.
  const makeBatch = process.argv.includes("--make-batch");
  const persist = makeBatch || process.argv.includes("--persist");

  console.log("=".repeat(86));
  console.log("  CHUAN BI 1 VIDEO TEST PRODUCTION  (KHONG GOI API)");
  console.log("=".repeat(86));
  console.log(`  AI_MOCK_MODE         : ${isMockMode()}`);
  console.log(`  CREATE_ATTEMPT_TOKEN : ${(await peekCreateToken()) ? "CO (!!)" : "0"}`);
  console.log(`  Che do ghi           : ${persist ? "PERSIST (ghi project)" : "DRY RUN (chi in)"}`);

  const idiom = await prisma.idiom.findFirst({ where: { phrase: IDIOM_PHRASE } });
  if (!idiom) {
    console.log(`\n  Khong tim thay thanh ngu "${IDIOM_PHRASE}".`);
    return;
  }

  const draft = buildScript(idiom);

  // The classifier's verdict, not the author's. `withDerivedRouting` recomputes
  // complexity and spend priority from the scene text and overwrites whatever
  // the script claimed - the same treatment a model-written script gets.
  const script = withDerivedRouting(draft);

  console.log(`\n  Thanh ngu : ${idiom.phrase} — ${idiom.meaning}`);
  console.log(`  Tieu de   : ${script.title}`);
  console.log(`  So canh   : ${script.scenes.length}\n`);

  console.log(
    `  ${"Canh".padEnd(6)}${"Giay".padEnd(6)}${"Do kho".padEnd(9)}${"Uu tien".padEnd(9)}${"Diem".padEnd(7)}Tin hieu classifier tim thay`,
  );
  console.log("  " + "-".repeat(82));

  let high = 0;
  let medium = 0;
  let low = 0;
  for (const scene of script.scenes) {
    const detail = classifyScene({
      duration: scene.duration,
      visualDescription: scene.visualDescription,
      characterAction: scene.characterAction,
      camera: scene.camera,
      characters: scene.charactersPresent,
    });
    if (detail.complexity === "HIGH") high += 1;
    else if (detail.complexity === "MEDIUM") medium += 1;
    else low += 1;

    console.log(
      `  ${String(scene.sceneNumber).padEnd(6)}${String(scene.duration).padEnd(6)}` +
        `${scene.complexity.padEnd(9)}${scene.spendPriority.padEnd(9)}` +
        `${detail.score.toFixed(1).padEnd(7)}` +
        (detail.reasons.length > 0 ? detail.reasons.join("; ") : "(khong co tin hieu nao)"),
    );
  }

  console.log(`\n  LOW ${low}   MEDIUM ${medium}   HIGH ${high}`);
  if (high > 0) {
    console.log("  !! Con canh HIGH — phai viet lai canh do, KHONG duoc sua nhan.");
  }
  if (medium > 0) {
    console.log("  !! Con canh MEDIUM — hien chua co provider duoc duyet cho MEDIUM.");
  }

  const totalSeconds = script.scenes.reduce((n, s) => n + s.duration, 0);
  console.log(`  Tong thoi luong kich ban: ${totalSeconds}s`);

  if (!persist) {
    console.log("\n  DRY RUN — chua ghi gi. Them --persist de tao project.");
    console.log("  CHI PHI API: $0.00\n");
    return;
  }

  // Creating the project writes rows and nothing else. `autoGenerateScript` is
  // false on purpose: turning it on would call the Text AI and throw away the
  // script this file exists to write.
  const existing = await prisma.project.findFirst({
    where: { idiomId: idiom.id, angleKey: script.angleKey },
    orderBy: { createdAt: "desc" },
  });

  const project =
    existing ??
    (await createProjectForIdiom({
      idiomId: idiom.id,
      qualityMode: "BALANCED",
      targetDuration: 24,
      // A placeholder ceiling. The real one is the batch authorisation, and the
      // per-video cap inside it, both set when the operator approves.
      maxBudget: 2,
      autoGenerateScript: false,
      autoStartMedia: false,
    }));

  await persistScript(project.id, script);
  await prisma.project.update({
    where: { id: project.id },
    data: {
      title: script.title,
      scriptJson: JSON.stringify(script),
      angleKey: script.angleKey,
      status: "script_ready",
    },
  });

  console.log(`\n  Da ghi project ${project.id}`);
  console.log(`  Trang thai: script_ready, ${script.scenes.length} canh.`);

  if (!makeBatch) {
    console.log("  KHONG goi API nao. CHI PHI API: $0.00\n");
    return;
  }

  // ---- a batch that will ADOPT this project rather than rewrite it --------
  const batch = await prisma.batch.create({
    data: {
      name: `Production test — ${idiom.phrase}`,
      amount: 1,
      qualityMode: "BALANCED",
      targetDuration: 24,
      maxCostPerVideo: 1.5,
      maxBudget: 0,
      status: "PLANNED",
      idiomIdsJson: JSON.stringify([idiom.id]),
    },
  });

  // Attach BEFORE planning, so the planner prices the real script rather than
  // the six-scene reference profile.
  await prisma.project.update({
    where: { id: project.id },
    data: { batchId: batch.id },
  });

  const plan = await planBatch(
    {
      idiomIds: [idiom.id],
      amount: 1,
      qualityMode: "BALANCED",
      targetDuration: 24,
      maxCostPerVideo: 1.5,
    },
    batch.id,
  );
  await savePlan(batch.id, plan);

  const forMoney = plan.production ?? plan.runtime;
  await createAuthorization({
    batchId: batch.id,
    estimatedCost: forMoney.estimatedTotal,
    maxCostPerVideo: plan.maxCostPerVideo,
    providerScope: forMoney.providerScope,
    videoCount: 1,
    qualityMode: "BALANCED",
    note: `Kich ban soan tay, chuan bi luc ${new Date().toISOString()}`,
  });

  console.log(`\n  Da tao lo ${batch.id}`);
  console.log(`  Co so gia            : ${forMoney.costBasis}`);
  console.log(`  Du toan chay that    : $${forMoney.estimatedTotal.toFixed(6)}`);
  console.log(`  De xuat tran duyet   : $${plan.recommendation.recommended.toFixed(2)}`);
  console.log(`  Quyen chi            : DRAFT (chua duoc phep chi gi)`);
  console.log(`  Mo tai               : /batches/${batch.id}`);
  console.log("\n  KHONG goi API nao. CHI PHI API: $0.00\n");

}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
