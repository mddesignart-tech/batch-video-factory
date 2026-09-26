"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { ActionButtonWithFeedback } from "@/components/action-ui";
import { exportOutput } from "@/app/actions/batch-run";
import { openOutputFolder } from "@/app/actions/output";
import { formatUSD } from "@/lib/utils";
import { CopyPathButton } from "@/components/copy-path-button";

/**
 * The finished video as a person wants it: playable, with its size, cost and
 * the folder it lives in. Exporting is local (copy + one FFmpeg frame) and can
 * be redone at any time - it never touches what was bought.
 */
export function OutputCard({
  projectId,
  output,
  actualCost,
  pacing = null,
}: {
  projectId: string;
  output: {
    dir: string;
    relative: string;
    duration: number | null;
    resolution: string | null;
    aspectRatio: string | null;
  } | null;
  actualCost: number;
  /** "Đã tối ưu nhịp: 26s → 21.8s" from the last render, or null. */
  pacing?: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Output</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {output ? (
          <div className="flex flex-wrap gap-4">
            <video
              src={`/api/media/${output.relative}/final.mp4`}
              poster={`/api/media/${output.relative}/thumbnail.jpg`}
              controls
              className="h-72 rounded-lg bg-black"
            />
            <div className="space-y-1.5 text-ink-300">
              <p>Thời lượng: {output.duration !== null ? `${output.duration.toFixed(2)}s` : "—"}</p>
              {pacing ? <p className="text-ok-500">{pacing}</p> : null}
              <p>Độ phân giải: {output.resolution ?? "—"} · {output.aspectRatio ?? ""}</p>
              <p>Chi thật: {formatUSD(actualCost, 6)}</p>
              <p className="max-w-md break-all font-mono text-[11px] text-ink-400">{output.dir}</p>
              <p className="text-ink-500">final.mp4 · thumbnail.jpg · subtitles.srt · metadata.json</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <ActionButtonWithFeedback action={() => openOutputFolder(projectId)} size="sm" variant="outline">
                  MỞ THƯ MỤC
                </ActionButtonWithFeedback>
                <CopyPathButton
                  path={output.dir}
                  className="rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-300 hover:border-brand-500"
                />
                <ActionButtonWithFeedback action={() => exportOutput(projectId)} size="sm" variant="ghost">
                  Xuất lại
                </ActionButtonWithFeedback>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-ink-400">Video đã xong nhưng chưa xuất ra thư mục output.</span>
            <ActionButtonWithFeedback action={() => exportOutput(projectId)} size="sm" variant="primary">
              XUẤT OUTPUT
            </ActionButtonWithFeedback>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
