import type { ProviderStatus } from "@/domain/enums";
import {
  ScriptSchema,
  type ScriptDoc,
  type ScriptScore,
  type SceneDoc,
} from "@/domain/script";
import type {
  CostEstimate,
  ScriptRequest,
  TextProvider,
} from "@/providers/types";
import { hashCode, sleep } from "@/lib/utils";

/**
 * Mock script writer.
 *
 * This is a template engine, not a language model, but it is deliberately not a
 * lorem-ipsum stub: it produces the real five-beat structure (hook -> literal
 * misunderstanding -> escalation -> real meaning -> example), fills in genuine
 * image/video prompts from the style preset and character sheets, and assigns
 * complexity and spend priority per scene. That means the router, the cost
 * estimator, the storyboard editor and the renderer are all exercised against
 * realistically shaped data during Milestone 1.
 *
 * Each idiom has several distinct comedy angles; the caller passes the angles it
 * has already used so a second project on the same idiom gets a different joke.
 */

interface Angle {
  key: string;
  label: string;
  /** Beat text; `{idiom}` is substituted with the idiom phrase. */
  setup: string;
  escalation: string;
  punchline: string;
  props: string;
}

const ANGLES: Angle[] = [
  {
    key: "panic",
    label: "Hoảng loạn hiểu theo nghĩa đen",
    setup: "Max hears {idiom} and freezes in total panic.",
    escalation: "Max starts preparing for the worst, very seriously.",
    punchline: "Leo arrives and finds Max mid-disaster, holding the wrong thing.",
    props: "a safety helmet and a nervous smile",
  },
  {
    key: "prop",
    label: "Mang đạo cụ theo nghĩa đen",
    setup: "Max hears {idiom} and runs off to find the exact object.",
    escalation: "Max comes back carrying far too much of it.",
    punchline: "Everything wobbles and collapses in a soft cartoon pile.",
    props: "an enormous cardboard box",
  },
  {
    key: "public",
    label: "Làm thật giữa chốn đông người",
    setup: "Max hears {idiom} and does it literally, in public.",
    escalation: "Everyone stops and stares. Max keeps going, proudly.",
    punchline: "Leo hides his face while Max takes a confident bow.",
    props: "a small confused crowd",
  },
  {
    key: "overprepare",
    label: "Chuẩn bị quá mức",
    setup: "Max hears {idiom} and builds an entire plan around it.",
    escalation: "The plan gets bigger, with charts, string and sticky notes.",
    punchline: "Leo says one sentence and the whole plan falls apart.",
    props: "a giant whiteboard covered in arrows",
  },
  {
    key: "helpful",
    label: "Giúp đỡ nhiệt tình sai cách",
    setup: "Max hears {idiom} and rushes to help someone literally.",
    escalation: "The help makes everything much, much worse.",
    punchline: "Leo gently takes the object away from Max.",
    props: "a rubber mallet and good intentions",
  },
];

/** Beat plan for one 4-to-6 scene video. */
interface Beat {
  role: string;
  share: number;
  complexity: SceneDoc["complexity"];
  spendPriority: SceneDoc["spendPriority"];
  camera: string;
  sfx: string;
}

const BEATS: Beat[] = [
  {
    role: "hook",
    share: 0.12,
    complexity: "MEDIUM",
    // The first three seconds decide whether the video is watched at all.
    spendPriority: "HIGH",
    camera: "fast push-in on a surprised face",
    sfx: "record scratch",
  },
  {
    role: "literal",
    share: 0.22,
    complexity: "MEDIUM",
    spendPriority: "NORMAL",
    camera: "medium shot, slight handheld sway",
    sfx: "cartoon gulp",
  },
  {
    role: "escalation",
    share: 0.22,
    complexity: "HIGH",
    spendPriority: "NORMAL",
    camera: "wide shot with quick whip pan",
    sfx: "comic boing",
  },
  {
    role: "punchline",
    share: 0.2,
    complexity: "HIGH",
    // The gag everyone screenshots. Worth the better model.
    spendPriority: "HIGH",
    camera: "snap zoom to a reaction close-up",
    sfx: "rimshot",
  },
  {
    role: "meaning",
    share: 0.13,
    complexity: "LOW",
    spendPriority: "LOW",
    camera: "clean static shot, text-safe framing",
    sfx: "soft chime",
  },
  {
    role: "example",
    share: 0.11,
    complexity: "LOW",
    spendPriority: "LOW",
    camera: "static two-shot, friendly and calm",
    sfx: "bright pop",
  },
];

export class MockTextProvider implements TextProvider {
  getName(): string {
    return "mock";
  }

  async checkStatus(): Promise<ProviderStatus> {
    return "connected";
  }

  async estimateScriptCost(req: ScriptRequest): Promise<CostEstimate> {
    // Mock mode is free by definition; the shape of the estimate still matches
    // what a real provider returns so the cost UI has something to render.
    return {
      amount: 0,
      unit: "per_job",
      detail: `Mock text generation for "${req.idiom}"`,
    };
  }

  async generateScript(req: ScriptRequest): Promise<ScriptDoc> {
    await sleep(120 + (hashCode(req.idiom) % 200)); // simulate latency

    const angle = pickAngle(req.idiom, req.avoidAngles);
    const max = req.characters[0]?.name ?? "Max";
    const leo = req.characters[1]?.name ?? "Leo";
    const idiom = req.idiom;

    const beats = BEATS.slice(0, req.targetDuration < 22 ? 5 : 6);
    const shareTotal = beats.reduce((sum, b) => sum + b.share, 0);

    const scenes: SceneDoc[] = beats.map((beat, index) => {
      const duration = round1(
        (beat.share / shareTotal) * req.targetDuration,
      );
      const content = beatContent(beat.role, {
        idiom,
        angle,
        max,
        leo,
        meaning: req.meaning,
        example: req.exampleSentence,
        literal: req.literalMeaning,
      });
      const characters =
        beat.role === "hook" || beat.role === "literal"
          ? [max]
          : [max, leo];

      const visualDescription = content.visual;
      return {
        sceneNumber: index + 1,
        // Clamp to what a single AI video generation can actually produce well.
        duration: Math.min(6, Math.max(2, duration)),
        visualDescription,
        dialogue: content.dialogue,
        narration: content.narration,
        subtitle: content.subtitle,
        camera: beat.camera,
        characterAction: content.action,
        soundEffect: beat.sfx,
        imagePrompt: buildImagePrompt(
          visualDescription,
          req.stylePrompt,
          req.characters.filter((c) => characters.includes(c.name)),
        ),
        videoPrompt: buildVideoPrompt(
          visualDescription,
          req.stylePrompt,
          beat.camera,
          content.action,
        ),
        complexity: beat.complexity,
        spendPriority: beat.spendPriority,
        characters,
      };
    });

    const doc: ScriptDoc = {
      idiom,
      title: `He Took "${idiom}" Literally 😂`,
      hook: `My friend said "${idiom}"... so I did exactly that.`,
      literalMisunderstanding: req.literalMeaning,
      setup: angle.setup.replace("{idiom}", `"${idiom}"`),
      escalation: angle.escalation,
      punchline: angle.punchline,
      meaning: req.meaning,
      exampleSentence: req.exampleSentence,
      durationTarget: req.targetDuration,
      scenes,
      closingCTA: "Follow for more funny English!",
      angleKey: angle.key,
    };

    // Validate our own output through exactly the same gate a real provider's
    // output goes through. A template bug should fail loudly, here, not later.
    return ScriptSchema.parse(doc);
  }

  async scoreScript(script: ScriptDoc): Promise<ScriptScore> {
    await sleep(60);
    // Deterministic pseudo-scores derived from real properties of the script, so
    // the rewrite path in ScriptService is genuinely reachable in tests.
    const seed = hashCode(script.idiom + script.angleKey);
    const hookLength = script.hook.length;
    return {
      hook: clampScore(7 + (seed % 3) - (hookLength > 90 ? 2 : 0)),
      humor: clampScore(7 + ((seed >> 3) % 3)),
      clarity: clampScore(8 + ((seed >> 5) % 2)),
      learningValue: clampScore(8 + ((seed >> 7) % 2)),
      visualFeasibility: clampScore(
        9 - script.scenes.filter((s) => s.complexity === "HIGH").length,
      ),
      notes: "Mock đánh giá kịch bản (không gọi API).",
    };
  }

  async generateYoutubeMeta(script: ScriptDoc): Promise<{
    title: string;
    description: string;
    hashtags: string[];
    keywords: string[];
  }> {
    await sleep(40);
    const idiom = script.idiom;
    return {
      title: `He Took "${idiom}" Literally 😂 | English Idioms`,
      description: [
        `What does "${idiom}" actually mean?`,
        "",
        `Meaning: ${script.meaning}`,
        `Example: ${script.exampleSentence}`,
        "",
        "Learn English with a quick laugh. New funny idiom every day!",
      ].join("\n"),
      hashtags: [
        "#English",
        "#LearnEnglish",
        "#EnglishIdioms",
        "#FunnyEnglish",
        "#Shorts",
      ],
      keywords: [
        "english idioms",
        "learn english",
        "english for beginners",
        idiom.toLowerCase(),
        "funny english",
        "english shorts",
      ],
    };
  }
}

// ----------------------------------------------------------------- helpers ---

export function pickAngle(idiom: string, avoid: string[]): Angle {
  const available = ANGLES.filter((a) => !avoid.includes(a.key));
  const pool = available.length > 0 ? available : ANGLES;
  const index = hashCode(idiom + avoid.join(",")) % pool.length;
  return pool[index] ?? ANGLES[0]!;
}

interface BeatContext {
  idiom: string;
  angle: Angle;
  max: string;
  leo: string;
  meaning: string;
  example: string;
  literal: string;
}

interface BeatContent {
  visual: string;
  dialogue: string;
  narration: string;
  subtitle: string;
  action: string;
}

function beatContent(role: string, ctx: BeatContext): BeatContent {
  const { idiom, angle, max, leo, meaning, example, literal } = ctx;
  switch (role) {
    case "hook":
      return {
        visual: `${max} stands centre frame, eyes wide, mouth open in shock, bright empty background.`,
        dialogue: `${leo}: "${idiom}!"`,
        narration: "",
        subtitle: `"${idiom.toUpperCase()}"?!`,
        action: `${max} freezes mid-step and stares straight at the camera.`,
      };
    case "literal":
      return {
        visual: `${max} imagines the literal meaning: ${literal}. A thought bubble shows it as a silly cartoon.`,
        dialogue: `${max}: "Wait... you want me to do THAT?"`,
        narration: "",
        subtitle: `He thinks it means: ${shorten(literal, 46)}`,
        action: `${max} points at his own thought bubble, confused.`,
      };
    case "escalation":
      return {
        visual: `${angle.escalation} ${max} is surrounded by ${angle.props}. Harmless, exaggerated cartoon chaos.`,
        dialogue: `${max}: "I am VERY prepared."`,
        narration: "",
        subtitle: "He is not prepared.",
        action: `${max} struggles with ${angle.props} while ${leo} watches in disbelief.`,
      };
    case "punchline":
      return {
        visual: `${angle.punchline} Big expressive reaction faces, soft slapstick, nothing gets hurt.`,
        dialogue: `${leo}: "...That is NOT what I meant."`,
        narration: "",
        subtitle: `"That is NOT what I meant!"`,
        action: `${leo} facepalms while ${max} grins proudly.`,
      };
    case "meaning":
      return {
        visual: `Clean, simple background. ${leo} calmly explains while a large text panel sits in the upper area of the frame.`,
        dialogue: `${leo}: "It just means: ${meaning}."`,
        narration: `"${idiom}" means ${meaning}.`,
        subtitle: `MEANING: ${meaning.toUpperCase()}`,
        action: `${leo} gestures to a floating text card. ${max} nods slowly.`,
      };
    case "example":
    default:
      return {
        visual: `${max} and ${leo} smile at the camera, thumbs up, cheerful simple background.`,
        dialogue: `${max}: "${example}"`,
        narration: "",
        subtitle: example,
        action: `${max} gives a thumbs up. ${leo} laughs.`,
      };
  }
}

export function buildImagePrompt(
  visual: string,
  stylePrompt: string,
  characters: { name: string; visualPrompt: string }[],
): string {
  const sheet = characters
    .map((c) => `${c.name}: ${c.visualPrompt}`)
    .join(" | ");
  return [
    stylePrompt,
    visual,
    sheet ? `Character sheet - ${sheet}` : "",
    "vertical 9:16 composition, subject centred, lower third kept clear for subtitles",
  ]
    .filter(Boolean)
    .join(". ");
}

export function buildVideoPrompt(
  visual: string,
  stylePrompt: string,
  camera: string,
  action: string,
): string {
  return [
    stylePrompt,
    visual,
    `Action: ${action}`,
    `Camera: ${camera}`,
    "smooth natural motion, consistent character design across the whole shot",
  ]
    .filter(Boolean)
    .join(". ");
}

function shorten(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampScore(value: number): number {
  return Math.min(10, Math.max(1, Math.round(value)));
}
