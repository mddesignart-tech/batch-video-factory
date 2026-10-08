/**
 * MULTI-LAYER SCENE MODEL (QĐ-128) - which layers a scene has, inferred from
 * the script: who is in front, what stands in the middle, where it happens,
 * and what moves quietly behind (traffic, passers-by, birds, clouds, leaves,
 * steam...). Pure: no database, no provider, no file system.
 *
 * Rules that keep the picture calm:
 *  - the FOREGROUND is the subject: characters, presenter, CRITICAL product,
 *    main animal - always first in line for its reference pictures;
 *  - MIDGROUND moves lightly, BACKGROUND is stable, AMBIENT is subtle;
 *  - at most two ambient layers, never more than the subject can carry;
 *  - an ambient layer is only rendered locally when a loop file exists for it
 *    (the ambient library); otherwise it is DESCRIBED in the image / video
 *    prompt and the plan says so. Nothing pretends FFmpeg drew a car.
 */

import { PARALLAX_FACTOR, type LayerMotion, type SceneLayer } from "./scene-plan";
import { classifyMotionScale } from "./motion-scale";

// ------------------------------------------------------------ ambient kinds ---

export interface AmbientKind {
  id: string;
  label: string;
  /** Words in the scene that ask for it. */
  match: RegExp;
  motion: LayerMotion;
  direction: SceneLayer["motionDirection"];
  promptPhrase: string;
  entityType: SceneLayer["entityType"];
  /**
   * Where a local loop of it is placed (G3): SKY = upper band, HORIZON = far
   * ground line (cars, passers-by), GROUND = lower band (water), FULL = whole
   * frame (falling leaves, lights, steam).
   */
  band: AmbientBand;
}

export const AMBIENT_BANDS = ["SKY", "HORIZON", "GROUND", "FULL"] as const;
export type AmbientBand = (typeof AMBIENT_BANDS)[number];

export const AMBIENT_KINDS: readonly AmbientKind[] = [
  { id: "traffic", label: "Xe chạy ngang", match: /\b(cars?|traffic|bus(?:es)?|taxis?|vehicles?|motorbikes?|scooters?)\b/i, motion: "CROSS", direction: "RIGHT", promptPhrase: "cars pass slowly in the distance", entityType: "VEHICLE", band: "HORIZON" },
  { id: "pedestrians", label: "Người đi bộ phía xa", match: /\b(pedestrians?|passers?-?by|crowd|people walk\w*|shoppers?)\b/i, motion: "CROSS", direction: "LEFT", promptPhrase: "a few people walk by far in the background", entityType: "PERSON", band: "HORIZON" },
  { id: "birds", label: "Chim bay xa", match: /\b(birds? (?:fly|flying|in the sky)|flock|seagulls?)\b/i, motion: "CROSS", direction: "RIGHT", promptPhrase: "small birds fly far away in the sky", entityType: "ANIMAL", band: "SKY" },
  { id: "clouds", label: "Mây trôi", match: /\b(clouds?|cloudy)\b/i, motion: "DRIFT", direction: "RIGHT", promptPhrase: "clouds drift slowly", entityType: "NATURE", band: "SKY" },
  { id: "leaves", label: "Lá rung", match: /\b(leaves|trees?|bushes|branches|foliage)\b/i, motion: "SWAY", direction: "NONE", promptPhrase: "leaves sway gently in the breeze", entityType: "NATURE", band: "FULL" },
  { id: "lights", label: "Đèn nhấp nháy", match: /\b(neon|lights? flicker\w*|fairy lights|candles?|lanterns?)\b/i, motion: "FLICKER", direction: "NONE", promptPhrase: "lights flicker softly", entityType: "EFFECT", band: "FULL" },
  { id: "water", label: "Nước chuyển động", match: /\b(river|lake|sea|ocean|pond|fountain|waves?|stream)\b/i, motion: "LOOP", direction: "NONE", promptPhrase: "water ripples gently", entityType: "NATURE", band: "GROUND" },
  { id: "steam", label: "Hơi nước", match: /\b(steam\w*|hot (?:tea|coffee|soup)|kettle|boiling)\b/i, motion: "RISE", direction: "UP", promptPhrase: "soft steam rises", entityType: "EFFECT", band: "FULL" },
  { id: "smoke", label: "Khói nhẹ", match: /\b(smoke|chimney|campfire)\b/i, motion: "RISE", direction: "UP", promptPhrase: "light smoke drifts upward", entityType: "EFFECT", band: "SKY" },
  { id: "curtain", label: "Rèm lay", match: /\b(curtains?|drapes)\b/i, motion: "SWAY", direction: "NONE", promptPhrase: "curtains sway slightly", entityType: "OBJECT", band: "FULL" },
  { id: "shadows", label: "Bóng đổ chuyển động", match: /\b(shadows? (?:move|moving|shift\w*)|dappled light)\b/i, motion: "DRIFT", direction: "LEFT", promptPhrase: "soft shadows shift slowly", entityType: "EFFECT", band: "FULL" },
];

/** A location suggests its quiet background life even when the script does not list it. */
/** `vi`: the same place in Vietnamese - a location picture is often named "Gian bếp", "Công viên". */
const LOCATION_AMBIENT: { match: RegExp; vi: RegExp; label: string; prompt: string; ambient: string[] }[] = [
  { match: /\b(street|city|town|road|crossroads|sidewalk|downtown)\b/i, vi: /(?<!\p{L})(?:đường phố|phố|vỉa hè|ngã tư|thành phố|thị trấn)(?!\p{L})/iu, label: "Đường phố", prompt: "a city street", ambient: ["traffic", "pedestrians"] },
  { match: /\b(kitchen)\b/i, vi: /(?<!\p{L})(?:bếp|nhà bếp|gian bếp)(?!\p{L})/iu, label: "Gian bếp", prompt: "a bright kitchen", ambient: ["steam"] },
  { match: /\b(park|garden|playground)\b/i, vi: /(?<!\p{L})(?:công viên|khu vườn|vườn|sân chơi)(?!\p{L})/iu, label: "Công viên", prompt: "a green park", ambient: ["leaves", "birds"] },
  { match: /\b(forest|jungle|woods)\b/i, vi: /(?<!\p{L})(?:rừng|khu rừng)(?!\p{L})/iu, label: "Rừng", prompt: "a forest", ambient: ["leaves", "birds"] },
  { match: /\b(classroom|school)\b/i, vi: /(?<!\p{L})(?:lớp học|trường học|sân trường)(?!\p{L})/iu, label: "Lớp học", prompt: "a classroom", ambient: [] },
  { match: /\b(cafe|café|coffee shop|restaurant)\b/i, vi: /(?<!\p{L})(?:quán cà phê|cà phê|quán cafe|nhà hàng)(?!\p{L})/iu, label: "Quán cà phê", prompt: "a cozy cafe", ambient: ["pedestrians"] },
  { match: /\b(bedroom|living room|home|house)\b/i, vi: /(?<!\p{L})(?:phòng ngủ|phòng khách|trong nhà|ngôi nhà|căn nhà)(?!\p{L})/iu, label: "Trong nhà", prompt: "a home interior", ambient: ["curtain"] },
  { match: /\b(beach|sea|ocean)\b/i, vi: /(?<!\p{L})(?:bãi biển|bờ biển|biển cả)(?!\p{L})/iu, label: "Bãi biển", prompt: "a beach", ambient: ["water", "clouds"] },
  { match: /\b(sky|mountain|field|farm|countryside)\b/i, vi: /(?<!\p{L})(?:bầu trời|núi|cánh đồng|nông trại|đồng quê|làng quê)(?!\p{L})/iu, label: "Ngoài trời", prompt: "open countryside", ambient: ["clouds"] },
  { match: /\b(office|studio|shop|store|market)\b/i, vi: /(?<!\p{L})(?:văn phòng|cửa hàng|siêu thị|chợ)(?!\p{L})/iu, label: "Không gian làm việc", prompt: "an office interior", ambient: [] },
  { match: /\b(construction site)\b/i, vi: /(?<!\p{L})(?:công trường)(?!\p{L})/iu, label: "Công trường", prompt: "a construction site", ambient: ["pedestrians"] },
];

const MIDGROUND = /\b(table|counter|desk|bench|sofa|couch|shelf|branch(?:es)?|fence|parked car|stall|chair)\b/i;

// ---------------------------------------------------------------- inputs ---

export interface LayerInput {
  visualDescription?: string;
  characterAction?: string;
  charactersPresent?: string[];
  speakingCharacters?: string[];
  primaryCharacters?: string[];
  /** References in this scene. */
  references?: { id: string; type: string; name: string; critical: boolean }[];
  /** Ambient kinds with a local loop file available (ids). */
  ambientAvailable?: string[];
  /** The person switched ambient motion off for this project / scene. */
  ambientEnabled?: boolean;
}

export type SceneComplexity = "LOW" | "MEDIUM" | "HIGH";

/** Infer the layers. The foreground always exists (the existing picture at minimum). */
/** The place a scene's words describe ("Đường phố", "Gian bếp"...), or null. */
export function locationOf(text: string): string | null {
  return locationFor(text)?.label ?? null;
}

function locationFor(text: string) {
  return LOCATION_AMBIENT.find((l) => l.match.test(text) || l.vi.test(text));
}

export function inferLayers(input: LayerInput): SceneLayer[] {
  const words = `${input.visualDescription ?? ""} ${input.characterAction ?? ""}`;
  const present = (input.charactersPresent ?? []).filter((n) => n && n !== "Narrator");
  const speaking = new Set(input.speakingCharacters ?? []);
  const refs = input.references ?? [];
  const layers: SceneLayer[] = [];
  const vigorous = classifyMotionScale({ characterAction: input.characterAction, visualDescription: input.visualDescription }).scale === "VIGOROUS";

  // ---- FOREGROUND: the subject(s).
  const main = present.slice(0, 3);
  const product = refs.find((r) => r.type === "PRODUCT");
  const animal = refs.find((r) => r.type === "ANIMAL");
  if (main.length) {
    layers.push(
      layer({
        id: "fg-cast",
        layerType: "FOREGROUND",
        zIndex: 30,
        label: main.join(" + "),
        promptPhrase: main.length > 1 ? `${main.join(" and ")} in the foreground` : `${main[0]} in the foreground`,
        entityType: "CHARACTER",
        entityId: main.join("+"),
        referenceAssetIds: refs.filter((r) => r.type === "CHARACTER").map((r) => r.id),
        motionType: vigorous ? "AI_MOTION" : main.some((n) => speaking.has(n)) ? "TALKING" : "IDLE",
        depth: 0.15,
        critical: refs.some((r) => r.type === "CHARACTER" && r.critical),
      }),
    );
  }
  if (product) {
    layers.push(
      layer({
        id: "fg-product",
        layerType: "FOREGROUND",
        zIndex: 31,
        label: product.name,
        promptPhrase: `${product.name} clearly visible, exactly as in the reference`,
        entityType: "PRODUCT",
        entityId: product.id,
        referenceAssetIds: [product.id],
        motionType: "STATIC",
        depth: 0.1,
        critical: product.critical,
      }),
    );
  }
  if (animal && !main.length) {
    layers.push(
      layer({
        id: "fg-animal",
        layerType: "FOREGROUND",
        zIndex: 30,
        label: animal.name,
        promptPhrase: `${animal.name} in the foreground`,
        entityType: "ANIMAL",
        entityId: animal.id,
        referenceAssetIds: [animal.id],
        motionType: vigorous ? "AI_MOTION" : "IDLE",
        depth: 0.15,
        critical: animal.critical,
      }),
    );
  }
  if (!layers.length) {
    layers.push(layer({ id: "fg-subject", layerType: "FOREGROUND", zIndex: 30, label: "Chủ thể của cảnh", promptPhrase: "", entityType: "OBJECT", motionType: "IDLE", depth: 0.2 }));
  }

  // ---- MIDGROUND: props, furniture, extra characters.
  const extras = present.slice(3);
  const mid = MIDGROUND.exec(words);
  if (mid || extras.length) {
    layers.push(
      layer({
        id: "mid",
        layerType: "MIDGROUND",
        zIndex: 20,
        label: extras.length ? extras.join(" + ") : mid![0],
        promptPhrase: extras.length ? `${extras.join(" and ")} in the middle distance` : `${mid![0]} in the middle ground`,
        entityType: extras.length ? "CHARACTER" : "OBJECT",
        motionType: extras.length ? "IDLE" : "STATIC",
        depth: 0.5,
      }),
    );
  }

  // ---- BACKGROUND: the location (environment reference first).
  const envRef = refs.find((r) => r.type === "ENVIRONMENT");
  // The location picture's own name counts ("Gian bếp" implies the kitchen's steam).
  const location = locationFor(words) ?? (envRef ? locationFor(envRef.name) : undefined);
  if (envRef || location) {
    layers.push(
      layer({
        id: "bg",
        layerType: "BACKGROUND",
        zIndex: 10,
        label: envRef?.name ?? location!.label,
        promptPhrase: envRef ? `background: ${envRef.name}, same place as the reference` : `background: ${location!.prompt}`,
        entityType: "ENVIRONMENT",
        entityId: envRef?.id,
        referenceAssetIds: envRef ? [envRef.id] : [],
        motionType: "STATIC",
        depth: 0.9,
      }),
    );
  }

  // ---- AMBIENT: what the script names first, then what the location implies. At most two.
  if (input.ambientEnabled !== false) {
    const named = AMBIENT_KINDS.filter((k) => k.match.test(words)).map((k) => k.id);
    const implied = location?.ambient ?? [];
    const kinds = [...new Set([...named, ...implied])].slice(0, 2);
    for (const id of kinds) {
      const k = AMBIENT_KINDS.find((x) => x.id === id)!;
      const local = (input.ambientAvailable ?? []).includes(id);
      layers.push(
        layer({
          id: `amb-${id}`,
          layerType: "AMBIENT",
          zIndex: 15,
          label: k.label,
          promptPhrase: k.promptPhrase,
          entityType: k.entityType,
          motionType: local ? "AMBIENT_VIDEO" : k.motion,
          motionDirection: k.direction,
          motionSpeed: "SLOW",
          depth: 0.75,
        }),
      );
    }
  }
  return layers;
}

function layer(p: Partial<SceneLayer> & Pick<SceneLayer, "id" | "layerType" | "zIndex" | "label" | "entityType" | "depth">): SceneLayer {
  return {
    promptPhrase: "",
    referenceAssetIds: [],
    motionType: "STATIC",
    motionDirection: "NONE",
    motionSpeed: "SLOW",
    startTime: null,
    endTime: null,
    enabled: true,
    critical: false,
    parallaxFactor: PARALLAX_FACTOR[p.layerType],
    ...p,
  };
}

/** LOW: one subject, no moving background. MEDIUM: subject + ambient / product + place. HIGH: a crowd of moving things. */
export function sceneComplexity(layers: SceneLayer[], cameraMove: string): SceneComplexity {
  const fg = layers.filter((l) => l.layerType === "FOREGROUND" && l.enabled);
  const castSize = fg.filter((l) => l.entityType === "CHARACTER").reduce((n, l) => n + l.label.split(" + ").length, 0);
  const ambient = layers.filter((l) => l.layerType === "AMBIENT" && l.enabled).length;
  const aiMotion = fg.some((l) => l.motionType === "AI_MOTION");
  const tracking = /TRACK|TRUCK|ORBIT|ARC|CRANE/.test(cameraMove);
  if (castSize >= 3 || (castSize >= 2 && ambient >= 2) || (aiMotion && tracking)) return "HIGH";
  if (ambient >= 1 || castSize >= 2 || layers.some((l) => l.layerType === "MIDGROUND") || aiMotion) return "MEDIUM";
  return "LOW";
}

/** The layers in prompt words: what is in front, where it is, and how quietly the background lives. */
export function layersPromptPhrase(layers: SceneLayer[]): string {
  const on = layers.filter((l) => l.enabled && l.promptPhrase);
  const bg = on.filter((l) => l.layerType === "BACKGROUND").map((l) => l.promptPhrase);
  const amb = on.filter((l) => l.layerType === "AMBIENT").map((l) => l.promptPhrase);
  const mid = on.filter((l) => l.layerType === "MIDGROUND").map((l) => l.promptPhrase);
  const parts: string[] = [];
  if (mid.length) parts.push(`${mid.join("; ")}.`);
  if (bg.length) parts.push(`${bg.join("; ").replace(/^background:/, "Background:")}.`);
  if (amb.length) parts.push(`Subtle background motion: ${amb.join(", ")} - keep it subtle, never distracting from the subject.`);
  return parts.join(" ");
}
