import type { Complexity, MotionSource, QualityMode, SpendPriority } from "./enums";

/**
 * Does this scene need a generative video model, or will a keyframe do?
 *
 * The premise of the whole module: **a six-scene video does not need six AI
 * clips.** At Sora's prices six clips is $2.40, which is more than the images,
 * the script and the voice put together, and most of it buys movement nobody
 * asked for. A reaction shot, an explanation card, a closing tag - these are
 * served just as well by the keyframe with a slow push-in, which FFmpeg already
 * does locally in `buildSceneNormalizeArgs` for nothing.
 *
 * So this is not a fallback for when the money runs out. It is a routing
 * outcome with the same standing as picking a model, decided from the scene's
 * own properties before any budget is consulted.
 *
 * Three things drive it, in this order:
 *
 *   spendPriority  - the script marks the hook and the punchline HIGH. Those
 *                    are the shots a viewer judges the video on, and a push-in
 *                    on a still is visibly cheaper there.
 *   complexity     - HIGH means several characters doing something. A still
 *                    cannot fake an action beat.
 *   qualityMode    - how much of that the operator wants to pay for.
 *
 * What it deliberately does NOT look at: remaining budget. A scene that needs
 * generative motion needs it whether or not there is money left, and conflating
 * the two would let a nearly-empty batch quietly redefine what a good video is.
 * Budget is enforced afterwards, by the batch gate, where it can say so plainly.
 */

export interface MotionInput {
  qualityMode: QualityMode;
  complexity: Complexity;
  spendPriority: SpendPriority;
  characterCount: number;
}

export interface MotionDecision {
  source: MotionSource;
  /** Vietnamese, shown in the plan table beside the scene. */
  reason: string;
}

/**
 * Scenes where a still cannot do the job, regardless of mode.
 *
 * Kept separate from the mode table because it is a statement about the SCENE,
 * not about how much the operator wants to spend. QUALITY mode may buy AI video
 * for more scenes than this; no mode should buy less for these.
 */
function needsGenerativeMotion(input: MotionInput): boolean {
  // An action beat with more than one character moving. A push-in on a frozen
  // frame reads as a slideshow here, and that is the one place it shows.
  if (input.complexity === "HIGH" && input.characterCount >= 2) return true;
  return false;
}

export function decideMotion(input: MotionInput): MotionDecision {
  const { qualityMode, complexity, spendPriority } = input;

  if (needsGenerativeMotion(input)) {
    return {
      source: "AI_VIDEO",
      reason:
        `cảnh hành động phức tạp với ${input.characterCount} nhân vật — ` +
        `ảnh tĩnh không diễn được`,
    };
  }

  switch (qualityMode) {
    case "ECONOMY":
      // Economy buys generative motion only where the scene forced it above.
      // Everything else is a keyframe, which is the whole point of the mode.
      return {
        source: "LOCAL_MOTION",
        reason: "chế độ Tiết kiệm: dùng ảnh + chuyển động FFmpeg, không gọi Video AI",
      };

    case "QUALITY":
      // Quality pays for movement everywhere except the scenes that are
      // genuinely static by design - a title card is not improved by a model.
      if (complexity === "LOW" && spendPriority === "LOW") {
        return {
          source: "LOCAL_MOTION",
          reason: "cảnh phụ tĩnh, Video AI không thêm được gì đáng tiền",
        };
      }
      return { source: "AI_VIDEO", reason: "chế độ Chất lượng: ưu tiên chuyển động thật" };

    case "BALANCED":
    case "CUSTOM":
    default:
      // The default. Pay where the viewer looks - the hook, the punchline - and
      // save on the explanation and the outro.
      if (spendPriority === "HIGH") {
        return {
          source: "AI_VIDEO",
          reason: "cảnh hook/punchline, người xem đánh giá video ở đây",
        };
      }
      // LOW spend priority, not LOW complexity, is the signal that matters here.
      //
      // Measured, not assumed: six-scene scripts from the real generator come
      // back MEDIUM/MEDIUM/HIGH/HIGH/MEDIUM/MEDIUM - not one scene scores LOW,
      // because two characters in frame is already enough to clear the MEDIUM
      // threshold. A rule keyed on `complexity === "LOW"` therefore looked
      // correct in isolation and would have fired on approximately nothing.
      //
      // `spendPriority` is the field that does separate these beats: the
      // classifier assigns LOW to the "meaning" and "example" roles - the
      // explanation card and the closing tag. Those are two static beats per
      // video, and a push-in on the keyframe is genuinely indistinguishable
      // there.
      if (spendPriority === "LOW") {
        return {
          source: "LOCAL_MOTION",
          reason: "cảnh giải thích/chốt, ảnh + chuyển động FFmpeg là đủ",
        };
      }
      if (complexity === "LOW") {
        return {
          source: "LOCAL_MOTION",
          reason: "cảnh đơn giản, ảnh + chuyển động FFmpeg là đủ",
        };
      }
      return { source: "AI_VIDEO", reason: "cảnh có chuyển động đáng kể" };
  }
}

/**
 * A LOCAL_MOTION scene MUST have a keyframe.
 *
 * This is the trap in the whole idea and it is worth stating loudly: ECONOMY
 * already skips keyframes for simple one-character scenes, and those are
 * exactly the scenes this module routes away from a video model. Apply both
 * rules naively and the scene ends up with no image AND no clip, and the
 * renderer drops it - a scene silently missing from the finished video, with
 * nothing anywhere reporting an error.
 *
 * So whenever the motion comes from a still, the still stops being optional.
 */
export function keyframeRequired(source: MotionSource, wantsKeyframe: boolean): boolean {
  return source === "LOCAL_MOTION" ? true : wantsKeyframe;
}

/** Why the effective motion source is what it is, for the log and the audit. */
export interface MotionResolution {
  source: MotionSource;
  /** True when stored and freshly-decided disagreed and this call settled it. */
  diverged: boolean;
  reason: string;
}

/**
 * WHICH ANSWER WINS when the stored field and a fresh decision disagree.
 *
 * Both inputs are legitimate and neither is simply "the truth":
 *
 *   stored   what the operator saw and approved when the plan was costed. The
 *            pipeline reads this, on purpose, so that editing the registry
 *            between approval and execution cannot move money.
 *   fresh    what `decideMotion` says about the scene as it stands NOW, after
 *            a re-classification, a rewrite, or a change of spend priority.
 *
 * A dry-run found four scenes where stored said AI_VIDEO and fresh said
 * LOCAL_MOTION. Honouring stored would buy four clips the current rules say are
 * unnecessary; honouring fresh unconditionally would let a re-classification
 * quietly START buying clips, which is the failure the stored field was added
 * to prevent. Neither "newest wins" nor "stored wins" is safe on its own.
 *
 * So the rule is directional rather than chronological:
 *
 *   FREE WINS.       If either answer is LOCAL_MOTION, the scene is
 *                    LOCAL_MOTION. Going from paid to free needs no approval,
 *                    and the money not spent cannot surprise anybody.
 *   PAID NEEDS BOTH. AI_VIDEO only when stored and fresh agree, so a fresh
 *                    verdict can never begin spending on its own.
 *
 * The exception, and it is a real one: an EXPLICIT MANUAL PIN. A person who
 * named a provider and a model for this scene has decided to buy a clip, and
 * that is an instruction, not a default the classifier may overrule. Dropping
 * it would be the same silent override in the opposite direction.
 *
 * Nothing here writes to the database. The divergence is reported so it can be
 * logged and shown; mass-updating the rows would erase the evidence that the
 * two sources ever disagreed, which is the only way anyone finds out why.
 */
export function effectiveMotionSource(
  stored: string | null | undefined,
  fresh: MotionDecision,
  opts: { manuallyPinned?: boolean } = {},
): MotionResolution {
  // A row written before the column existed has no opinion to honour.
  if (stored !== "LOCAL_MOTION" && stored !== "AI_VIDEO") {
    return {
      source: fresh.source,
      diverged: false,
      reason: `chưa có motionSource lưu, dùng quyết định mới: ${fresh.reason}`,
    };
  }

  if (stored === fresh.source) {
    return { source: fresh.source, diverged: false, reason: fresh.reason };
  }

  if (stored === "AI_VIDEO" && fresh.source === "LOCAL_MOTION") {
    if (opts.manuallyPinned) {
      return {
        source: "AI_VIDEO",
        diverged: true,
        reason:
          `luật hiện tại nói LOCAL_MOTION (${fresh.reason}) nhưng cảnh đã được ` +
          `GHIM TAY một model cụ thể — giữ AI_VIDEO theo chỉ định của người dùng`,
      };
    }
    return {
      source: "LOCAL_MOTION",
      diverged: true,
      reason:
        `motionSource lưu = AI_VIDEO nhưng luật hiện tại nói LOCAL_MOTION ` +
        `(${fresh.reason}) — chọn phương án $0, không cần ai duyệt thêm`,
    };
  }

  // stored LOCAL_MOTION, fresh AI_VIDEO. The expensive direction: refused.
  return {
    source: "LOCAL_MOTION",
    diverged: true,
    reason:
      `luật hiện tại nói AI_VIDEO (${fresh.reason}) nhưng kế hoạch đã duyệt là ` +
      `LOCAL_MOTION — không tự chuyển sang trả phí, cần người duyệt lại`,
  };
}
