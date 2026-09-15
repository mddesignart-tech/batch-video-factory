import { describe, expect, it } from "vitest";
import { classifyCameraIntent } from "@/domain/camera-intent";
import {
  applyCameraGuardrails,
  CAMERA_DIRECTED_GUARDRAIL,
  CAMERA_LOCK_GUARDRAIL,
  FINAL_FRAME_GUARDRAIL,
  findPromptContradictions,
  FRAMING_GUARDRAIL,
  IDENTITY_GUARDRAIL,
  RUNWAY_MAX_PROMPT_CHARS,
} from "@/domain/video-prompt";

/**
 * Camera and composition guardrails.
 *
 * Built from a measured failure rather than a hunch. The SAME scene, the SAME
 * keyframe and the SAME model (h3_max) scored:
 *
 *   camera  1/10, composition  3/10, overall 4.3  - prompt said "Static camera."
 *   camera 10/10, composition 10/10, overall 9.2  - prompt said "Locked tripod
 *                                                   camera. No zoom. ..."
 *
 * Only the prompt differed. First-vs-last-frame PSNR went from 8.4 dB to
 * 39.7 dB. An audit then found 17 of 23 scenes carrying prompts with no camera
 * lock at all - seventeen repeats of that failure waiting to happen.
 *
 * The hard part is not adding the text. It is adding it ONLY where it belongs:
 * a script that says "then pan to Leo" wants a pan, and appending "No pan" to
 * it would make the model choose between two instructions - which is the
 * instability these rules exist to remove.
 */

const LOCKED = { camera: "Medium shot of Leo." };
const PAN = { camera: "Close-up on Max, then pan to Leo." };

describe("phân loại ý đồ camera", () => {
  it("cảnh LOW mô tả cỡ cảnh -> LOCKED_CAMERA", () => {
    // "Medium shot" says where the camera stands, not where it goes.
    const intent = classifyCameraIntent(LOCKED);
    expect(intent.mode).toBe("LOCKED_CAMERA");
    expect(intent.defaulted).toBe(false);
  });

  it("không ghi gì -> LOCKED_CAMERA, nhưng đánh dấu là mặc định", () => {
    const intent = classifyCameraIntent({ camera: "" });
    expect(intent.mode).toBe("LOCKED_CAMERA");
    // "We defaulted" and "the script asked for it" are different facts, and an
    // audit has to be able to tell them apart.
    expect(intent.defaulted).toBe(true);
  });

  it("kịch bản yêu cầu pan -> DIRECTED_CAMERA", () => {
    const intent = classifyCameraIntent(PAN);
    expect(intent.mode).toBe("DIRECTED_CAMERA");
    expect(intent.movements).toContain("pan");
  });

  it("kịch bản yêu cầu zoom -> DIRECTED_CAMERA", () => {
    const intent = classifyCameraIntent({ camera: "Slow zoom in on the cake." });
    expect(intent.mode).toBe("DIRECTED_CAMERA");
    expect(intent.movements).toContain("zoom");
  });

  it("đổi khung giữa cảnh cũng là DIRECTED, dù không có động từ chuyển động", () => {
    // "Wide shot of whole room, then close on Max's face" is a push-in
    // described without ever using a movement word.
    const intent = classifyCameraIntent({
      camera: "Wide shot of whole room, then close on Max's panicked face.",
    });
    expect(intent.mode).toBe("DIRECTED_CAMERA");
  });

  it("KHÔNG nhầm 'panicked' thành 'pan'", () => {
    // A real scene in this project is "close on Max's panicked face". Without
    // word boundaries that reads as a pan and loses its camera lock.
    const intent = classifyCameraIntent({ camera: "Close-up on Max's panicked face." });
    expect(intent.mode).toBe("LOCKED_CAMERA");
    expect(intent.movements).toEqual([]);
  });

  it("khoá tường minh thắng, kể cả khi câu có chứa từ chuyển động", () => {
    // "locked, no pan" is a prohibition, not a request.
    const intent = classifyCameraIntent({ camera: "Locked static shot, no pan." });
    expect(intent.mode).toBe("LOCKED_CAMERA");
  });
});

describe("áp guardrail", () => {
  it("LOCKED nhận khoá camera + final frame", () => {
    const g = applyCameraGuardrails("Leo nods once.", classifyCameraIntent(LOCKED));
    expect(g.mode).toBe("LOCKED_CAMERA");
    expect(g.text).toContain(CAMERA_LOCK_GUARDRAIL);
    expect(g.text).toContain(FINAL_FRAME_GUARDRAIL);
  });

  it("DIRECTED KHÔNG bị cấm pan mà nó được yêu cầu", () => {
    const g = applyCameraGuardrails("Max reacts.", classifyCameraIntent(PAN));
    expect(g.mode).toBe("DIRECTED_CAMERA");
    expect(g.text).not.toContain("No pan");
    expect(g.text).toContain(CAMERA_DIRECTED_GUARDRAIL);
  });

  it("DIRECTED KHÔNG bị cấm zoom mà nó được yêu cầu", () => {
    const g = applyCameraGuardrails(
      "The cake expands.",
      classifyCameraIntent({ camera: "Slow zoom in on the cake." }),
    );
    expect(g.text).not.toContain("No zoom");
    expect(g.text).not.toContain(CAMERA_LOCK_GUARDRAIL);
  });

  it("DIRECTED vẫn giữ identity, framing và cấm tự phát minh chuyển động", () => {
    const g = applyCameraGuardrails("Max reacts.", classifyCameraIntent(PAN));
    expect(g.text).toContain(IDENTITY_GUARDRAIL);
    expect(g.text).toContain(FRAMING_GUARDRAIL);
    expect(g.text).toContain("Do not invent any additional camera movement");
    // A directed shot is ALLOWED to end on a different framing - that is what
    // "then pan to Leo" means - so the final-frame rule must not be forced on.
    expect(g.text).not.toContain(FINAL_FRAME_GUARDRAIL);
  });

  it("prompt đã khoá camera thì KHÔNG append lần hai", () => {
    const already = "Leo nods.\n\nCamera remains locked and stable: no camera pan.";
    const g = applyCameraGuardrails(already, classifyCameraIntent(LOCKED));
    expect(g.skipped).toContain(CAMERA_LOCK_GUARDRAIL);
    expect(g.text).not.toContain("Locked tripod camera");
    expect(findPromptContradictions(g.text)).toEqual([]);
  });

  it("chạy hai lần cho kết quả giống hệt lần một", () => {
    // Idempotence matters beyond tidiness: the prompt is part of the
    // idempotency key, so a prompt that grows on every pass would turn each
    // retry into a brand new paid purchase.
    const once = applyCameraGuardrails("Leo nods.", classifyCameraIntent(LOCKED));
    const twice = applyCameraGuardrails(once.text, classifyCameraIntent(LOCKED));
    expect(twice.text).toBe(once.text);
    expect(twice.added).toEqual([]);
  });

  it('"Static camera" KHÔNG được tính là đã khoá', () => {
    // This is the exact wording that failed. The clip that scored 1/10 said
    // "Static camera. No camera movement." and pushed in anyway; every clip
    // that held the camera contained the word "locked".
    const g = applyCameraGuardrails(
      "Leo nods.\n\nStatic camera. No camera movement.",
      classifyCameraIntent(LOCKED),
    );
    expect(g.added).toContain(CAMERA_LOCK_GUARDRAIL);
  });

  it("giữ nguyên nội dung gốc của cảnh", () => {
    const action = "Leo gives one small friendly nod and a slight smile.";
    const g = applyCameraGuardrails(action, classifyCameraIntent(LOCKED));
    expect(g.text.startsWith(action)).toBe(true);
  });
});

describe("không vượt giới hạn và không tự mâu thuẫn", () => {
  it("không bao giờ vượt giới hạn ký tự của nhà cung cấp", () => {
    const long = "A".repeat(RUNWAY_MAX_PROMPT_CHARS - 100);
    const g = applyCameraGuardrails(long, classifyCameraIntent(LOCKED));
    expect(g.chars).toBeLessThanOrEqual(RUNWAY_MAX_PROMPT_CHARS);
    // And it says so rather than silently dropping rules.
    expect(g.truncated).toBe(true);
  });

  it("guardrail quan trọng nhất được thêm trước khi hết chỗ", () => {
    // Order is priority. The camera rule is the one that has actually been
    // measured to change an outcome, so it survives a tight budget.
    const long = "A".repeat(RUNWAY_MAX_PROMPT_CHARS - 200);
    const g = applyCameraGuardrails(long, classifyCameraIntent(LOCKED));
    expect(g.added[0]).toBe(CAMERA_LOCK_GUARDRAIL);
  });

  it("đếm byte UTF-8 chứ không chỉ ký tự", () => {
    const g = applyCameraGuardrails("Leo gật đầu một cái.", classifyCameraIntent(LOCKED));
    // Vietnamese is multi-byte; the two counts must not be assumed equal.
    expect(g.bytes).toBeGreaterThan(g.chars);
  });

  it("phát hiện mâu thuẫn cấm-và-yêu-cầu", () => {
    const bad = "Camera pans to Leo.\n\n" + CAMERA_LOCK_GUARDRAIL;
    expect(findPromptContradictions(bad)).toContain("vừa cấm pan vừa yêu cầu pan");
  });

  it("phát hiện guardrail bị lặp", () => {
    const dup = `x\n\n${CAMERA_LOCK_GUARDRAIL}\n\n${CAMERA_LOCK_GUARDRAIL}`;
    expect(findPromptContradictions(dup).some((c) => c.includes("lặp"))).toBe(true);
  });

  it("prompt LOCKED bình thường KHÔNG có mâu thuẫn", () => {
    const g = applyCameraGuardrails("Leo nods once.", classifyCameraIntent(LOCKED));
    expect(findPromptContradictions(g.text)).toEqual([]);
  });

  it("prompt DIRECTED bình thường KHÔNG có mâu thuẫn", () => {
    const g = applyCameraGuardrails(
      "Camera pans to Leo as he speaks.",
      classifyCameraIntent(PAN),
    );
    expect(findPromptContradictions(g.text)).toEqual([]);
  });
});

describe("dùng chung cho mọi model, không đụng tới định tuyến", () => {
  it("guardrail không phụ thuộc provider hay model", () => {
    // Same text whatever the vendor: h3_max today, gen4_turbo if it is ever
    // re-benchmarked. Nothing here reads a provider name, which is what makes
    // that true rather than merely intended.
    const g = applyCameraGuardrails("Leo nods.", classifyCameraIntent(LOCKED));
    expect(g.text).toContain(CAMERA_LOCK_GUARDRAIL);
    for (const vendor of ["h3_max", "gen4_turbo", "gen4.5", "wan3", "sora-2"]) {
      expect(g.text).not.toContain(vendor);
    }
  });

  it("giới hạn của nhà cung cấp là tham số, không phải hằng số cứng", () => {
    const tight = applyCameraGuardrails("Leo nods.", classifyCameraIntent(LOCKED), 200);
    expect(tight.chars).toBeLessThanOrEqual(200);
    const roomy = applyCameraGuardrails("Leo nods.", classifyCameraIntent(LOCKED), 2000);
    expect(roomy.added.length).toBeGreaterThan(tight.added.length);
  });
});
