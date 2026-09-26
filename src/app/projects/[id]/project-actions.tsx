"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Film, RefreshCw, Sparkles, Trash2, XCircle } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
} from "@/components/ui";
import {
  ActionButton,
  ActionFeedback,
  ActionForm,
  Disclosure,
  type ActionResult,
} from "@/components/action-ui";
import {
  cancelProject,
  deleteProject,
  regenerateScript,
  renderFinal,
  startMedia,
  updateProjectSettings,
} from "@/app/actions/projects";
import {
  QUALITY_MODES,
  ROUTER_STRATEGIES,
  VI_QUALITY_MODE,
  VI_ROUTER_STRATEGY,
} from "@/domain/enums";

const BUSY_STATUSES = new Set(["media_generating", "rendering"]);

export function ProjectActions({
  projectId,
  status,
  finalVideoPath,
  subtitlePath,
  maxBudget,
  qualityMode,
  routerStrategy,
  targetDuration,
  title,
}: {
  projectId: string;
  status: string;
  finalVideoPath: string | null;
  subtitlePath: string | null;
  maxBudget: number;
  qualityMode: string;
  routerStrategy: string;
  targetDuration: number;
  title: string;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const router = useRouter();
  const busy = BUSY_STATUSES.has(status);

  // While the queue is working, refresh so scene thumbnails and job state fill
  // in without the operator reloading the page.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [busy, router]);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Hành động</CardTitle>
        {busy ? (
          <span className="text-xs text-accent-500">
            Đang xử lý... trang tự động làm mới
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            variant="outline"
            action={() => regenerateScript(projectId)}
            onDone={setResult}
            disabled={busy}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Tạo lại kịch bản
          </ActionButton>

          <ActionButton
            variant="primary"
            action={async () => {
              const r = await startMedia(projectId);
              // Media runs through the batch page's PREFLIGHT / DUYỆT & CHẠY.
              if (r.ok && r.redirectTo) window.location.href = r.redirectTo;
              return r;
            }}
            onDone={setResult}
            disabled={busy}
            confirm={`Dự toán và mở trang duyệt chi cho dự án này? Chưa chi đồng nào — tiền chỉ được duyệt ở bước DUYỆT & CHẠY (ngân sách tối đa $${maxBudget.toFixed(
              2,
            )}).`}
          >
            <Film className="h-3.5 w-3.5" />
            TẠO MEDIA
          </ActionButton>

          <ActionButton
            variant="secondary"
            action={() => renderFinal(projectId)}
            onDone={setResult}
            disabled={busy}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Render lại MP4
          </ActionButton>

          {busy ? (
            <ActionButton
              variant="outline"
              action={() => cancelProject(projectId)}
              onDone={setResult}
            >
              <XCircle className="h-3.5 w-3.5" />
              Huỷ job đang chờ
            </ActionButton>
          ) : null}

          {finalVideoPath ? (
            <a
              href={`/api/media/${finalVideoPath}`}
              download
              className="inline-flex h-9 items-center gap-2 rounded-md border border-ink-600 px-4 text-sm text-ink-100 hover:bg-ink-800"
            >
              <Download className="h-3.5 w-3.5" />
              Tải MP4
            </a>
          ) : null}

          {subtitlePath ? (
            <a
              href={`/api/media/${subtitlePath}`}
              download
              className="inline-flex h-9 items-center gap-2 rounded-md border border-ink-600 px-4 text-sm text-ink-300 hover:bg-ink-800"
            >
              <Download className="h-3.5 w-3.5" />
              Tải phụ đề .srt
            </a>
          ) : null}
        </div>

        <ActionFeedback result={result} />

        {finalVideoPath ? (
          <div className="rounded-lg border border-ink-800 bg-ink-850 p-3">
            <p className="mb-2 text-xs font-medium text-ink-300">
              Video hoàn chỉnh
            </p>
            <video
              key={finalVideoPath}
              src={`/api/media/${finalVideoPath}`}
              controls
              playsInline
              className="mx-auto max-h-[420px] rounded-md bg-black"
            />
          </div>
        ) : null}

        <Disclosure label="Cài đặt dự án">
          <ActionForm
            action={(formData) => updateProjectSettings(projectId, formData)}
            submitLabel="Lưu cài đặt"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Tiêu đề video">
                <Input name="title" defaultValue={title} />
              </Field>
              <Field label="Chế độ tạo">
                <Select name="qualityMode" defaultValue={qualityMode}>
                  {QUALITY_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {VI_QUALITY_MODE[mode]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Chiến lược chọn mô hình">
                <Select name="routerStrategy" defaultValue={routerStrategy}>
                  {ROUTER_STRATEGIES.map((s) => (
                    <option key={s} value={s}>
                      {VI_ROUTER_STRATEGY[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Thời lượng mục tiêu (giây)">
                <Input
                  name="targetDuration"
                  type="number"
                  min={15}
                  max={60}
                  defaultValue={targetDuration}
                />
              </Field>
              <Field label="Ngân sách tối đa (USD)">
                <Input
                  name="maxBudget"
                  type="number"
                  min={0}
                  step="0.5"
                  defaultValue={maxBudget}
                />
              </Field>
            </div>
          </ActionForm>

          <div className="mt-4 border-t border-ink-800 pt-4">
            <ActionButton
              variant="danger"
              size="sm"
              action={() => deleteProject(projectId)}
              confirm="Xoá dự án này? Hành động này không thể hoàn tác."
              onDone={(res) => {
                if (res.ok) window.location.href = "/projects";
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Xoá dự án
            </ActionButton>
          </div>
        </Disclosure>
      </CardContent>
    </Card>
  );
}

export function ProjectActionsFallback() {
  return (
    <Card>
      <CardContent>
        <Button variant="secondary" disabled>
          Đang tải...
        </Button>
      </CardContent>
    </Card>
  );
}
