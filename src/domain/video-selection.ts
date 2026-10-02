/**
 * VIDEO MODEL NEEDS_SELECTION (QĐ-120).
 *
 * When no video model is cleared to be chosen AUTOMATICALLY for a scene
 * (deprecated, PIN_ONLY, not benchmarked for this complexity, LOW_AUTO only
 * for LOW scenes...), that is a decision for a person - not a system failure.
 * The policy that refused is unchanged; only how the stop is named and shown.
 *
 * The message keeps the router's full diagnostics after DETAIL_MARK, so the
 * technical text is still there for a bug report while the screen shows one
 * sentence and three choices.
 */

export const NEEDS_SELECTION_CODE = "VIDEO_MODEL_NEEDS_SELECTION";
/** Scene status for a scene waiting for a person to choose how it moves. */
export const NEEDS_SELECTION_STATUS = "needs_selection";
const DETAIL_MARK = "\nChi tiết kỹ thuật: ";

export function needsSelectionMessage(opts: {
  sceneNumber: number;
  complexity: string;
  /** A pinned model that is gone (shut down / disabled), if that is the reason. */
  unavailablePin?: string | null;
  diagnostics: string;
}): string {
  const head = opts.unavailablePin
    ? `${NEEDS_SELECTION_CODE}: cảnh ${opts.sceneNumber} — model cũ ${opts.unavailablePin} không còn khả dụng. Chọn model thay thế.`
    : `${NEEDS_SELECTION_CODE}: cảnh ${opts.sceneNumber} — không có model Video AI nào hiện đủ điều kiện chạy tự động ` +
      `(độ phức tạp ${opts.complexity}). Cần chọn thủ công.`;
  return `${head} Không gửi request nào.${DETAIL_MARK}${opts.diagnostics}`;
}

export function isNeedsSelection(message: string | null | undefined): boolean {
  return Boolean(message && message.includes(NEEDS_SELECTION_CODE));
}

/** The short sentence and the technical part, split for the screen. */
export function splitNeedsSelection(message: string): { summary: string; detail: string } {
  const at = message.indexOf(DETAIL_MARK);
  const head = (at >= 0 ? message.slice(0, at) : message).replace(`${NEEDS_SELECTION_CODE}: `, "").trim();
  return { summary: head, detail: at >= 0 ? message.slice(at + DETAIL_MARK.length).trim() : message };
}

/** The status a stopped scene gets: a selection is waited for, not failed. */
export function stoppedSceneStatus(message: string): "failed" | typeof NEEDS_SELECTION_STATUS {
  return isNeedsSelection(message) ? NEEDS_SELECTION_STATUS : "failed";
}
