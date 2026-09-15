import { PrismaClient } from "@prisma/client";

/**
 * Rewrite a scene's videoPrompt for image-to-video generation.
 *
 * Calls nothing and spends nothing: it only edits stored text.
 *
 * The rewrite follows what image-to-video models actually do well. They animate
 * a keyframe; they do not stage a new shot. So the prompt describes small
 * movement on top of an image that is already correct, and says nothing that
 * invites the model to re-draw faces, move the camera, or render text - the
 * three things that break character consistency in a 3-5 second clip.
 *
 * Usage:
 *   npx tsx scripts/prepare-video-prompt.ts --idiom "Spill the beans" --scene 4
 *   npx tsx scripts/prepare-video-prompt.ts --idiom "Spill the beans" --scene 4 --apply
 */

const prisma = new PrismaClient();

/**
 * Appended to every clip prompt. Written once so it cannot drift per scene.
 *
 * Revised after the first real clip came back almost motionless. The original
 * set piled on suppressors - "everything else stays still", "subtle motion
 * only", "no fast action" - and the model obeyed them over the movement it was
 * actually asked for. What remains forbids the things that break a clip
 * (camera moves, identity drift, text, morphing) and says nothing that
 * discourages motion itself.
 */
const VIDEO_GUARDRAILS = [
  "Use natural expressive character animation. The described gestures and",
  "facial reactions should be clearly visible to a viewer.",
  "Camera remains locked and stable: no camera pan, no camera tilt, no large",
  "zoom, no scene transition.",
  "Keep every character exactly as they appear in the source image: same face,",
  "same hairstyle, same clothing, same body proportions, same relative height,",
  "same visual style. Do not redraw or restyle either character.",
  "No new characters. No new objects. No text, no captions, no subtitles, no",
  "letters or numbers.",
  "Avoid: morphing, face drift, body deformation, extra limbs, warped hands,",
  "flicker, background replacement.",
].join(" ");

/**
 * Hand-written motion, per scene. Only movement the shot genuinely needs.
 *
 * `frame` restates the scene as a STATE rather than an action. The stored
 * description is written for a storyboard - "Leo steps forward" - and feeding
 * that to an image-to-video model alongside "both stay in place" gives it two
 * contradictory instructions. The frame line describes what the keyframe shows;
 * the movement line is the only thing that asks for motion.
 */
const MOTION: Record<
  string,
  Record<number, { frame: string; motion: string; duration: number }>
> = {
  "Spill the beans": {
    4: {
      frame:
        "Max and Leo stand together on a floor covered with spilled beans.",
      motion:
        "Max notices the ridiculous mess around him, looks briefly down at the " +
        "beans, then looks toward the camera with an embarrassed expression. " +
        "Max raises both shoulders in one clearly visible shrug and opens his " +
        "hands slightly as if saying \"What did I do?\". His shoulders then " +
        "relax naturally. Leo turns his eyes toward Max and reacts with an " +
        "amused smile, followed by one small visible head shake. A few beans " +
        "near their shoes roll and settle naturally.",
      // Under the 6s ceiling a scene is allowed, and short enough that an
      // image-to-video model holds the faces steady for the whole clip.
      duration: 4,
    },
    5: {
      frame:
        "Leo stands alone against a plain background, pointing off to one side.",
      motion:
        "Leo holds his pointing gesture and gives one small friendly nod, " +
        "blinking once. His hand stays where it is. He does not step or turn.",
      duration: 3,
    },
    6: {
      // Written for the h3_max stability benchmark, from what is actually in
      // the keyframe: Leo on the left in a teal shirt and glasses, one hand
      // open mid-gesture; Mia on the right in a denim jacket, already looking
      // at him.
      //
      // Deliberately NOT an easy shot. Two faces to hold, two outfits, a
      // visible open hand and lip movement are exactly where image-to-video
      // models drift - picking something trivially easy would prove nothing
      // about whether this model can carry the LOW band. The stored scene text
      // ("subtitle appears") is dropped on purpose: our renderer burns
      // subtitles itself, and asking a video model for on-screen text is asking
      // for the one thing every model in this class does badly.
      frame:
        "Leo and Mia stand side by side against a plain background. Leo has " +
        "one hand open in front of him, mid-explanation. Mia is turned " +
        "slightly toward him.",
      motion:
        "Leo speaks: his mouth moves naturally through a short sentence and " +
        "his open hand makes one small outward gesture in time with it, then " +
        "settles. He glances toward Mia as he finishes. Mia listens, then " +
        "gives one clear nod and her smile widens slightly. Both keep their " +
        "feet planted; neither steps, turns away or leaves the frame.",
      duration: 3,
    },
  },
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

export function buildVideoPrompt(input: {
  frame: string;
  motion: string;
}): string {
  return [
    `Animate this keyframe. Scene: ${input.frame.trim()}`,
    "",
    `Movement: ${input.motion}`,
    "",
    VIDEO_GUARDRAILS,
  ].join("\n");
}

async function main(): Promise<void> {
  const idiom = arg("idiom", "Spill the beans");
  const sceneNumber = Number(arg("scene", "4"));
  const apply = process.argv.includes("--apply");

  const project = await prisma.project.findFirst({
    where: { idiom: { phrase: idiom } },
    include: { idiom: true, scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  if (!project) {
    console.log(`Khong tim thay du an "${idiom}".`);
    process.exitCode = 1;
    return;
  }

  const scene = project.scenes.find((s) => s.sceneNumber === sceneNumber);
  if (!scene) {
    console.log(`Khong tim thay canh ${sceneNumber}.`);
    process.exitCode = 1;
    return;
  }

  const plan = MOTION[idiom]?.[sceneNumber];
  if (!plan) {
    console.log(`Chua soan chuyen dong cho ${idiom} canh ${sceneNumber}.`);
    process.exitCode = 1;
    return;
  }

  const prompt = buildVideoPrompt({ frame: plan.frame, motion: plan.motion });

  const videoModels = await prisma.modelRegistry.findMany({
    where: { type: "video" },
    orderBy: { price: "asc" },
  });

  console.log(`\n===== VIDEO PROMPT: ${idiom} canh ${sceneNumber} =====\n`);
  console.log(`  Anh keyframe : ${scene.imagePath ?? "CHUA CO"}`);
  console.log(`  Mo ta goc    : ${scene.visualDescription}`);
  console.log(`  Thoi luong cu: ${scene.duration}s`);
  console.log(`  De xuat      : ${plan.duration}s`);
  console.log(`\n--- videoPrompt ---\n`);
  console.log(prompt);

  const { billedVideoSeconds, splitModelSize } = await import(
    "../src/domain/video-duration"
  );

  console.log(`\n--- Uoc tinh neu goi Video API ---`);
  if (videoModels.length === 0) {
    console.log("  Chua co model video nao trong bang Mo hinh AI.");
  }
  for (const m of videoModels) {
    // Price the duration the vendor BILLS, not the one the scene asks for.
    //
    // `price * plan.duration` was wrong for every model with a minimum or a
    // quantised ladder, and quietly so: h3_max sells nothing shorter than 5
    // seconds, so a 3-second scene was quoted at $0.24 and would have been
    // charged $0.40 - a 67% understatement, on the exact screen an operator
    // reads before deciding what to spend. gen4_turbo rounds 3s up to 5s too.
    const billed =
      m.priceUnit === "per_second"
        ? billedVideoSeconds({
            provider: m.provider,
            model: m.modelId,
            size: splitModelSize(m.modelId).size,
            requestedSeconds: plan.duration,
            hasKeyframe: true,
          })
        : plan.duration;
    const cost = m.priceUnit === "per_second" ? m.price * billed : m.price;
    const note =
      billed !== plan.duration
        ? ` (tinh tien ${billed}s, khong phai ${plan.duration}s)`
        : ` cho ${plan.duration}s`;
    console.log(
      `  ${m.enabled ? "[BAT]" : "[TAT]"} ${m.provider}/${m.modelId}: ` +
        `$${m.price}/${m.priceUnit} -> $${cost.toFixed(4)}${note}`,
    );
  }

  if (!apply) {
    console.log("\n  (Chua luu. Them --apply de ghi vao co so du lieu.)\n");
    return;
  }

  await prisma.scene.update({
    where: { id: scene.id },
    data: { videoPrompt: prompt, duration: plan.duration },
  });
  console.log(`\n  Da luu videoPrompt va thoi luong ${plan.duration}s.\n`);
}

main()
  .catch((err: unknown) => {
    console.error("That bai:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
