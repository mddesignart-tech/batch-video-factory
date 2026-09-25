"use client";

import { useRef, useState } from "react";
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
import {
  createImportBatch,
  validateStoryboardSource,
  type ImportValidationView,
} from "@/app/actions/storyboard-import";
import type { ImportPreflight } from "@/services/import-preflight";
import { SceneEditor } from "./scene-editor";
import { CharacterEditor } from "./character-editor";
import { PreflightPanel } from "./preflight-panel";
import { reestimateImportBatch } from "@/app/actions/storyboard-import";
import { stageStoryboardUpload } from "@/app/actions/scene-images";

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
  // Off by default: importing less than the operator handed over is a choice
  // they make, not a convenience the tool grants itself. QĐ-073.
  const [allowPartial, setAllowPartial] = useState(false);
  const [busy, setBusy] = useState<"validate" | "create" | null>(null);
  const [view, setView] = useState<ImportValidationView | null>(null);
  const [preflight, setPreflight] = useState<ImportPreflight | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);

  // Upload from the browser into a staging folder under data/, then run the
  // SAME check a typed path gets. Nothing is imported yet.
  async function onUpload(list: FileList | null) {
    if (!list || list.length === 0) return;
    const form = new FormData();
    for (const f of Array.from(list)) {
      form.append("files", f, f.name);
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
      form.append("paths", rel && rel.length > 0 ? rel : f.name);
    }
    setBusy("validate");
    setMessage(null);
    try {
      const staged = await stageStoryboardUpload(form);
      if (!staged.ok || !staged.source) {
        setMessage({ tone: "danger", text: staged.message });
        return;
      }
      setSource(staged.source);
      const result = await validateStoryboardSource(staged.source);
      setView(result);
      setPreflight(null);
      setBatchId(null);
      setMessage(
        result.ok
          ? { tone: "ok", text: `${staged.message} Đã kiểm tra — xem kết quả bên dưới.` }
          : { tone: "danger", text: `${staged.message} ${result.errorCount} lỗi cần sửa trước khi nhập.` },
      );
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

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
        allowPartial,
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
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={folderRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void onUpload(e.currentTarget.files)}
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            />
            <input
              ref={filesRef}
              type="file"
              multiple
              accept=".json,.csv,.zip,.png,.jpg,.jpeg,.webp"
              className="hidden"
              onChange={(e) => void onUpload(e.currentTarget.files)}
            />
            <Button variant="secondary" disabled={busy !== null} onClick={() => folderRef.current?.click()}>
              TẢI LÊN THƯ MỤC STORYBOARD
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => filesRef.current?.click()}>
              Chọn file (.json/.csv + ảnh, hoặc .zip)
            </Button>
            <span className="text-xs text-ink-500">
              Có thể chứa nhiều video: video-01/storyboard.json + ảnh, video-02/…
            </span>
          </div>
          <Field
            label="…hoặc đường dẫn thư mục, file .zip, hoặc một file .json/.csv trên máy"
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
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowPartial}
              onChange={(e) => setAllowPartial(e.target.checked)}
            />
            Nhập phần chạy được — bỏ qua video còn lỗi (sẽ nêu tên từng video bị bỏ)
          </label>
          <div className="flex flex-wrap gap-3">
            <Button onClick={onValidate} disabled={busy !== null || source.trim().length === 0}>
              {busy === "validate" ? <Loader2 className="size-4 animate-spin" /> : null}
              KIỂM TRA
            </Button>
            <Button
              variant="secondary"
              onClick={onCreate}
              disabled={busy !== null || view === null || (!view.ok && !allowPartial)}
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

      {batchId ? (
        <CharacterEditor
          batchId={batchId}
          onChanged={async () => {
            // Editing a character invalidates the frozen estimate on purpose,
            // so the panel below is re-priced rather than left describing the
            // batch as it was a moment ago. Free: no provider is contacted.
            const again = await reestimateImportBatch(batchId);
            if (again.preflight) setPreflight(again.preflight);
          }}
        />
      ) : null}

      {batchId ? <SceneEditor batchId={batchId} onEstimated={setPreflight} /> : null}

      {preflight ? <PreflightPanel preflight={preflight} batchId={batchId} /> : null}
    </div>
  );
}
