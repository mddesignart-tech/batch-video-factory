import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "@prisma/client";
import { estimateProject, type PlannedSceneInput } from "@/services/cost-estimator";
import { paidModelsFor } from "@/services/import-preflight";

/**
 * Two things a plan must get right before anybody approves money.
 *
 * ## 1. The second lock
 *
 * A batch approval answers "how much may be spent". The confirmation list
 * answers "has a person looked at THIS model's price and agreed to it". Batch
 * `a690a290` passed the first and died on the second, mid-run, after the first
 * clip - and nothing checked it at plan time, so the plan read OK right up
 * until the request was refused. `paidModelsFor` is that rule, tested here
 * rather than through the whole pipeline because the gate only has meaning with
 * mock mode OFF - and a test that needs a live provider to prove a safety rule
 * is a test that gets skipped.
 *
 * ## 2. Not charging for a script that already exists
 *
 * An imported storyboard arrives with its scenes written. The project is created
 * at `script_ready` and no text model is ever called - but the estimate charged
 * for one anyway, the same mistake QĐ-067 fixed for supplied keyframes: pricing
 * work the pipeline will not do, and hiding the saving that is the whole point
 * of importing. See QĐ-079.
 */

function model(over: Partial<ModelRegistry> & { modelId: string }): ModelRegistry {
  return {
    id: over.modelId,
    provider: "mock",
    displayName: over.modelId,
    type: "image",
    enabled: true,
    priceUnit: "per_image",
    price: 0.048,
    priceOutput: 0,
    supportsTextToVideo: false,
    supportsImageToVideo: false,
    supportsReferenceImage: true,
    supportsCharacterReference: true,
    supportsAudio: false,
    supports1080p: true,
    supportsUpscale: false,
    maxDuration: 12,
    qualityRating: 7,
    speedRating: 7,
    consistencyRating: 7,
    historicalSuccessRate: 1,
    notes: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ModelRegistry;
}

const MODELS = [
  model({ modelId: "img", type: "image", priceUnit: "per_image", price: 0.048 }),
  model({
    modelId: "txt",
    type: "text",
    priceUnit: "per_1k_tokens",
    price: 0.00015,
    priceOutput: 0.0006,
  }),
  model({ modelId: "vox", type: "voice", priceUnit: "per_1k_chars", price: 0.0006 }),
];

const scene = (n: number, over: Partial<PlannedSceneInput> = {}): PlannedSceneInput => ({
  sceneNumber: n,
  duration: 4,
  complexity: "LOW",
  spendPriority: "LOW",
  characterCount: 1,
  speechText: `Line ${n}.`,
  ...over,
});

const base = {
  scenes: [scene(1), scene(2), scene(3)],
  models: MODELS,
  qualityMode: "ECONOMY" as const,
  strategy: "AUTO" as const,
  maxBudget: 5,
  availableProviders: ["mock"],
};

describe("kịch bản đã có sẵn thì KHÔNG tính tiền viết kịch bản", () => {
  it("không khai hasScript -> vẫn tính tiền text, như V1", () => {
    const out = estimateProject(base);
    expect(out.breakdown.text).toBeGreaterThan(0);
    expect(out.textProvider).toBe("mock");
  });

  it("hasScript: true -> text = $0, và không nêu nhà cung cấp text", () => {
    const out = estimateProject({ ...base, hasScript: true });
    expect(out.breakdown.text).toBe(0);
    expect(out.textProvider).toBeNull();
  });

  // The saving is the point, so it has to be visible in the total rather than
  // quietly absorbed somewhere else.
  it("khoản chênh đúng bằng tiền text, không hơn không kém", () => {
    const withText = estimateProject(base);
    const without = estimateProject({ ...base, hasScript: true });
    const diff = Math.round((withText.breakdown.total - without.breakdown.total) * 1e6) / 1e6;
    expect(diff).toBeGreaterThan(0);
    // Retries are a percentage of the subtotal, so removing the text cost
    // removes its share of the provision too - the gap is at least the text
    // line and no more than the text line plus its provision.
    expect(diff).toBeGreaterThanOrEqual(withText.breakdown.text);
    expect(diff).toBeLessThanOrEqual(withText.breakdown.text * 1.2);
  });

  it("ảnh, giọng, clip không bị đụng tới", () => {
    const withText = estimateProject(base);
    const without = estimateProject({ ...base, hasScript: true });
    expect(without.breakdown.image).toBe(withText.breakdown.image);
    expect(without.breakdown.voice).toBe(withText.breakdown.voice);
    expect(without.breakdown.video).toBe(withText.breakdown.video);
  });

  // The budget is walked down scene by scene starting from the text cost, so
  // removing it genuinely gives later scenes more headroom - which is the
  // behaviour that made scene 5 of "Bite the bullet" lose its image.
  it("bỏ tiền text -> cảnh cuối có thêm chỗ trong trần mỗi video", () => {
    const tight = { ...base, maxBudget: 0.15 };
    const withText = estimateProject(tight);
    const without = estimateProject({ ...tight, hasScript: true });
    const boughtWith = withText.scenes.filter((s) => s.image !== null).length;
    const boughtWithout = without.scenes.filter((s) => s.image !== null).length;
    expect(boughtWithout).toBeGreaterThanOrEqual(boughtWith);
  });
});

// -------------------------------------------------- the second money lock ---

describe("model trả phí phải được XÁC NHẬN GIÁ, không chỉ được duyệt tiền", () => {
  const decision = (provider: string, modelId: string) => ({ provider, modelId });

  it("gom đúng các cặp provider/model sẽ phải trả tiền, đã sắp xếp và không trùng", () => {
    const out = paidModelsFor(
      [
        {
          image: decision("openai", "gpt-image-2:medium"),
          video: decision("runway", "h3_max:768x1280"),
          voice: decision("openai", "gpt-4o-mini-tts"),
        },
        {
          image: decision("openai", "gpt-image-2:medium"),
          video: null,
          voice: decision("openai", "gpt-4o-mini-tts"),
        },
      ],
      [],
    );
    expect(out.map((m) => m.key)).toEqual([
      "openai/gpt-4o-mini-tts",
      "openai/gpt-image-2:medium",
      "runway/h3_max:768x1280",
    ]);
  });

  // The exact shape that stopped batch a690a290 mid-run: images and voice
  // confirmed, the video model not.
  it("thiếu đúng một model -> chỉ model đó chưa xác nhận", () => {
    const out = paidModelsFor(
      [
        {
          image: decision("openai", "gpt-image-2:medium"),
          video: decision("runway", "h3_max:768x1280"),
          voice: decision("openai", "gpt-4o-mini-tts"),
        },
      ],
      ["openai/gpt-image-2:medium", "openai/gpt-4o-mini-tts"],
    );
    expect(out.filter((m) => !m.confirmed).map((m) => m.key)).toEqual([
      "runway/h3_max:768x1280",
    ]);
  });

  it("xác nhận đủ -> không còn cặp nào thiếu", () => {
    const out = paidModelsFor(
      [{ image: decision("openai", "img"), video: null, voice: null }],
      ["openai/img"],
    );
    expect(out.every((m) => m.confirmed)).toBe(true);
  });

  // Not a loophole: `assertCanSpend` returns early in mock mode because a mock
  // call costs nothing. Demanding confirmation for it would block every test
  // while protecting no money.
  it("mock được miễn — nó không tốn tiền nên không có gì để xác nhận", () => {
    const out = paidModelsFor(
      [
        {
          image: decision("mock", "mock-image-fast"),
          video: decision("mock", "mock-video-std"),
          voice: decision("mock", "mock-voice-std"),
        },
      ],
      [],
    );
    expect(out).toEqual([]);
  });

  it("cảnh LOCAL_MOTION không đóng góp model video nào", () => {
    const out = paidModelsFor(
      [{ image: decision("openai", "img"), video: null, voice: decision("openai", "vox") }],
      [],
    );
    expect(out.map((m) => m.key)).toEqual(["openai/img", "openai/vox"]);
  });
});
