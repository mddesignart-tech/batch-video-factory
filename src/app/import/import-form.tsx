"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { formatUSD } from "@/lib/utils";
import {
  createImportBatch,
  validateStoryboardSource,
  type ImportValidationView,
} from "@/app/actions/storyboard-import";
import type { ImportPreflight } from "@/services/import-preflight";

/**
 * Three buttons, in the order the money actually moves.
 *
 * KIỂM TRA reads the source and says what is wrong with it. DỰ TOÁN creates the
 * rows and prices them. Neither can spend. The third step is not here at all:
 * approving an amount happens on the batch page, through the same gate a V1
 * batch goes through, because an "import and run" button is exactly the thing
 * that turns a typo in a spreadsheet into a bill.
 */
export function ImportForm() {
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [perVideo, setPerVideo] = useState("1.50");
  const [perBatch, setPerBatch] = useState("5.00");
  const [busy, setBusy] = useState<"validate" | "create" | null>(null);
  const [view, setView] = useState<ImportValidationView | null>(null);
  const [preflight, setPreflight] = useState<ImportPreflight | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function onValidate() {
    setBusy("validate");
    setMessage(null);
    setPreflight(null);
    setBatchId(null);
    try {
      const result = await validateStoryboardSource(source);
      setView(result);
      if (!result.ok) {
        setMessage({
          tone: "danger",
          text: `${result.errorCount} lỗi cần sửa trước khi nhập.`,
        });
      }
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function onCreate() {
    setBusy("create");
    setMessage(null);
    try {
      const result = await createImportBatch({
        source,
        name,
        maxCostPerVideo: Number(perVideo),
        maxCostForBatch: Number(perBatch),
      });
      setMessage({ tone: result.ok ? "ok" : "danger", text: result.message });
      if (result.ok) {
        setPreflight(result.preflight ?? null);
        setBatchId(result.batchId ?? null);
      }
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Nguồn nhập</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="Đường dẫn thư mục, file .zip, hoặc một file .json/.csv"
            hint="Ví dụ: F:\\storyboards\\batch-01 hoặc F:\\storyboards\\batch.zip"
          >
            <Input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="F:\storyboards\batch-01"
            />
          </Field>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Tên lô">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Lô nhập storyboard"
              />
            </Field>
            <Field label="Trần chi MỖI VIDEO ($)">
              <Input
                type="number"
                step="0.01"
                min="0"
                value={perVideo}
                onChange={(e) => setPerVideo(e.target.value)}
              />
            </Field>
            <Field label="Trần chi CẢ LÔ ($)">
              <Input
                type="number"
                step="0.01"
                min="0"
                value={perBatch}
                onChange={(e) => setPerBatch(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button onClick={onValidate} disabled={busy !== null || source.trim().length === 0}>
              {busy === "validate" ? <Loader2 className="size-4 animate-spin" /> : null}
              KIỂM TRA
            </Button>
            <Button
              variant="secondary"
              onClick={onCreate}
              disabled={busy !== null || view === null || !view.ok}
            >
              {busy === "create" ? <Loader2 className="size-4 animate-spin" /> : null}
              DỰ TOÁN &amp; TẠO LÔ
            </Button>
          </div>
          <Alert tone="info">
            Hai nút trên <strong>không gọi API tính phí nào</strong>. Lô được tạo ở trạng thái
            PLANNED với quyền chi DRAFT — chưa tiêu được một đồng. Việc duyệt hạn mức nằm ở
            trang lô, đi qua đúng cổng mà lô V1 vẫn đi.
          </Alert>
          {message ? <Alert tone={message.tone === "ok" ? "ok" : "danger"}>{message.text}</Alert> : null}
        </CardContent>
      </Card>

      {view ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Kết quả kiểm tra — {view.videos.length} video{" "}
              <Badge tone={view.errorCount > 0 ? "danger" : "ok"}>
                {view.errorCount} lỗi
              </Badge>{" "}
              <Badge tone="neutral">{view.warningCount} nhắc nhở</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {view.issues.length > 0 ? (
              <div className="max-h-72 overflow-auto rounded-md border border-border">
                <Table>
                  <thead>
                    <tr>
                      <Th>Mức</Th>
                      <Th>Mã lỗi</Th>
                      <Th>Ở đâu</Th>
                      <Th>Nội dung</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.issues.map((i, index) => (
                      <tr key={`${i.code}-${index}`}>
                        <Td>
                          <Badge tone={i.level === "error" ? "danger" : "warn"}>
                            {i.level === "error" ? "LỖI" : "NHẮC"}
                          </Badge>
                        </Td>
                        <Td className="font-mono text-xs">{i.code}</Td>
                        <Td className="text-xs">
                          {[
                            i.videoId ? `video ${i.videoId}` : "",
                            i.sceneNumber !== undefined ? `cảnh ${i.sceneNumber}` : "",
                            i.line !== undefined ? `dòng ${i.line}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Td>
                        <Td className="text-xs">{i.message}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ) : null}

            {view.videos.map((v) => (
              <div key={v.videoId} className="rounded-md border border-border">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                  onClick={() => setOpen(open === v.videoId ? null : v.videoId)}
                >
                  <span className="font-medium">{v.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {v.sceneCount} cảnh · ảnh có sẵn {v.suppliedImages}, sẽ tạo {v.missingImages} ·
                    LOCAL_MOTION {v.localMotion} · VIDEO_AI {v.videoAi} · AUTO {v.auto}
                  </span>
                </button>
                {open === v.videoId ? (
                  <Table>
                    <thead>
                      <tr>
                        <Th>#</Th>
                        <Th>Giây</Th>
                        <Th>Chuyển động</Th>
                        <Th>Độ khó</Th>
                        <Th>Keyframe</Th>
                        <Th>Ghim model</Th>
                        <Th>Mô tả</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.scenes.map((s) => (
                        <tr key={s.sceneNumber}>
                          <Td>{s.sceneNumber}</Td>
                          <Td>{s.duration}</Td>
                          <Td>{s.motionMode}</Td>
                          <Td>{s.complexity}</Td>
                          <Td>
                            <Badge tone={s.keyframe === "có sẵn" ? "ok" : "warn"}>
                              {s.keyframe}
                            </Badge>
                          </Td>
                          <Td className="font-mono text-xs">{s.pin ?? "—"}</Td>
                          <Td className="max-w-md truncate text-xs">{s.visual}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {preflight ? (
        <Card>
          <CardHeader>
            <CardTitle>Dự toán lô nhập</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Table>
              <thead>
                <tr>
                  <Th>Video</Th>
                  <Th>Cảnh</Th>
                  <Th>LOCAL</Th>
                  <Th>AI</Th>
                  <Th>Ảnh có sẵn</Th>
                  <Th>TEXT</Th>
                  <Th>IMAGE</Th>
                  <Th>VIDEO</Th>
                  <Th>VOICE</Th>
                  <Th>Tổng</Th>
                  <Th>Trạng thái</Th>
                </tr>
              </thead>
              <tbody>
                {preflight.videos.map((v) => (
                  <tr key={v.projectId}>
                    <Td>{v.title}</Td>
                    <Td>{v.sceneCount}</Td>
                    <Td>{v.localMotionCount}</Td>
                    <Td>{v.videoAiCount}</Td>
                    <Td>
                      {v.suppliedImages}/{v.sceneCount}
                    </Td>
                    <Td>{formatUSD(v.breakdown.text)}</Td>
                    <Td>{formatUSD(v.breakdown.image)}</Td>
                    <Td>{formatUSD(v.breakdown.video)}</Td>
                    <Td>{formatUSD(v.breakdown.voice)}</Td>
                    <Td className="font-medium">{formatUSD(v.estimatedCost)}</Td>
                    <Td>
                      <Badge tone={v.status === "OK" ? "ok" : "warn"}>{v.status}</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <div className="grid gap-2 text-sm md:grid-cols-2">
              <div>
                Tổng dự toán: <strong>{formatUSD(preflight.estimatedTotal)}</strong> (cơ sở giá{" "}
                {preflight.costBasis})
              </div>
              <div>
                Kể cả video bị chặn:{" "}
                <strong>{formatUSD(preflight.estimatedTotalIncludingBlocked)}</strong>
              </div>
              <div>
                Chạy được / bị chặn: {preflight.runnableCount} / {preflight.blockedCount}
              </div>
              <div>Trần cả lô: {formatUSD(preflight.maxCostForBatch)}</div>
              <div>Trần mỗi video: {formatUSD(preflight.maxCostPerVideo)}</div>
              <div>Đề xuất duyệt: {formatUSD(preflight.suggestedAuthorizedMaxSpend)}</div>
            </div>

            {preflight.warnings.map((w) => (
              <Alert key={w} tone="warn">
                {w}
              </Alert>
            ))}

            {batchId ? (
              <Alert tone="info">
                Lô đã tạo nhưng <strong>chưa được cấp phép chi</strong>.{" "}
                <Link className="underline" href={`/batches/${batchId}`}>
                  Mở trang lô để xem lại và DUYỆT
                </Link>
                .
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
