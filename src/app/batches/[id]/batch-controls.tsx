"use client";

import {
  continueBatch,
  reanalyseBatch,
  retryBatchVideo,
  stopBatch,
} from "@/app/actions/batches";
import { ActionButtonWithFeedback } from "@/components/action-ui";

/**
 * The stop/resume/retry controls.
 *
 * STOP is offered whenever a batch could still spend, and its confirmation text
 * says plainly what stopping can and cannot do: it prevents further requests,
 * and it cannot claw back a request a vendor has already accepted. Promising a
 * cancellation the vendor does not support would be the more comfortable
 * wording and the less true one.
 */
export function BatchControls({
  batchId,
  canStop,
  canResume,
  canReplan,
}: {
  batchId: string;
  canStop: boolean;
  canResume: boolean;
  canReplan: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      {canStop ? (
        <ActionButtonWithFeedback
          action={() => stopBatch(batchId)}
          variant="danger"
          size="sm"
          confirm={
            "Dừng lô? Sẽ không gửi thêm request trả phí nào. Các request đã gửi " +
            "tới nhà cung cấp vẫn chạy tới khi có kết quả — nhà cung cấp có thể " +
            "đã tính phí và huỷ ở phía ta không lấy lại được tiền."
          }
        >
          DỪNG BATCH
        </ActionButtonWithFeedback>
      ) : null}

      {canResume ? (
        <ActionButtonWithFeedback
          action={() => continueBatch(batchId)}
          variant="primary"
          size="sm"
          confirm={
            "Chạy tiếp lô? Giữ nguyên hạn mức và số tiền đã chi — resume KHÔNG " +
            "cấp thêm quyền chi, và công việc đã xong sẽ không làm lại."
          }
        >
          CHẠY TIẾP
        </ActionButtonWithFeedback>
      ) : null}

      {canReplan ? (
        <ActionButtonWithFeedback
          action={() => reanalyseBatch(batchId)}
          variant="outline"
          size="sm"
        >
          DỰ TOÁN LẠI
        </ActionButtonWithFeedback>
      ) : null}
    </div>
  );
}

export function RetryVideoButton({ projectId }: { projectId: string }) {
  return (
    <ActionButtonWithFeedback
      action={() => retryBatchVideo(projectId)}
      variant="outline"
      size="sm"
      confirm="Chạy lại video này? Vẫn chịu hạn mức lô và hạn mức/video như cũ."
    >
      Thử lại
    </ActionButtonWithFeedback>
  );
}
