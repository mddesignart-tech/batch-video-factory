import { Alert } from "@/components/ui";
import { isNeedsSelection, splitNeedsSelection } from "@/domain/video-selection";

/**
 * A stop reason as an Alert. A VIDEO_MODEL_NEEDS_SELECTION stop shows its one
 * sentence; the router's full diagnostics stay under "Xem chi tiết kỹ thuật"
 * (QĐ-120). Anything else is shown as before.
 */
export function FriendlyReason({ reason, tone }: { reason: string; tone: "danger" | "warn" }) {
  if (!isNeedsSelection(reason)) return <Alert tone={tone}>{reason}</Alert>;
  const { summary, detail } = splitNeedsSelection(reason);
  return (
    <Alert tone="warn" title="Có cảnh cần chọn model Video AI">
      {summary} Mở cảnh trong Storyboard: chọn model (xem giá rồi xác nhận), dùng LOCAL MOTION ($0) hoặc bỏ qua Video AI.
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-ink-500">Xem chi tiết kỹ thuật</summary>
        <p className="mt-1 whitespace-pre-wrap break-words font-mono text-ink-500">{detail}</p>
      </details>
    </Alert>
  );
}
