"use client";

import { useMemo, useRef, useState } from "react";
import { FolderUp, Upload } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { planSceneImageMapping } from "@/domain/scene-image-mapping";
import { importImagesForProject, type BulkImportResult } from "@/app/actions/scene-images";

/**
 * NHẬP ẢNH STORYBOARD - many pictures at once, matched to scenes by file name.
 *
 * Nothing is applied when files are chosen. The mapping is drawn first, from
 * the same pure function the server runs again on confirm; files that do not
 * map say why, and a scene that already has a picture is only replaced when
 * the person ticks "Thay ảnh hiện có". No Image API anywhere - $0.
 */
export function ImportImagesCard({
  projectId,
  scenes,
}: {
  projectId: string;
  scenes: { sceneNumber: number; hasImage: boolean }[];
}) {
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [replace, setReplace] = useState(false);
  const [fit, setFit] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkImportResult | null>(null);

  const plan = useMemo(
    () =>
      planSceneImageMapping(
        files.map((f) => f.name),
        scenes.map((s) => s.sceneNumber),
      ),
    [files, scenes],
  );
  const hasImage = new Map(scenes.map((s) => [s.sceneNumber, s.hasImage]));
  const willReplace = [...plan.bySceneNumber.keys()].filter((n) => hasImage.get(n));
  const willApply = [...plan.bySceneNumber.keys()].filter((n) => replace || !hasImage.get(n));

  function pick(list: FileList | null) {
    setResult(null);
    // Every picked file is listed - the mapping says which are not images.
    setFiles(list ? Array.from(list) : []);
  }

  async function onConfirm() {
    const form = new FormData();
    form.set("projectId", projectId);
    form.set("fit", fit);
    if (replace) form.set("confirmReplace", "yes");
    for (const f of files) form.append("files", f, f.name);
    setBusy(true);
    try {
      const r = await importImagesForProject(form);
      setResult(r);
      if (r.ok) setFiles([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Nhập ảnh storyboard</CardTitle>
        <span className="text-[11px] text-ink-500">
          Ảnh có sẵn (GPT, Gemini, Ideogram, Photoshop…) → dùng lại, KHÔNG gọi Image API, $0
        </span>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={filesRef}
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.webp"
            className="hidden"
            onChange={(e) => pick(e.currentTarget.files)}
          />
          <input
            ref={folderRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => pick(e.currentTarget.files)}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          />
          <Button size="sm" variant="primary" onClick={() => filesRef.current?.click()}>
            <Upload className="h-3 w-3" />
            NHẬP ẢNH (chọn nhiều file)
          </Button>
          <Button size="sm" variant="outline" onClick={() => folderRef.current?.click()}>
            <FolderUp className="h-3 w-3" />
            Chọn cả thư mục
          </Button>
          <span className="text-ink-500">
            Tên file nêu số cảnh: scene-01.png, 01.png, s1.jpg, cảnh-2.webp…
          </span>
        </div>

        {files.length > 0 ? (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>File</Th>
                  <Th>Cảnh</Th>
                  <Th>Kết quả</Th>
                </tr>
              </thead>
              <tbody>
                {plan.files.map((f) => (
                  <tr key={f.fileName}>
                    <Td className="font-mono text-[11px] text-ink-200">{f.fileName}</Td>
                    <Td>{f.sceneNumber ?? "—"}</Td>
                    <Td>
                      <Badge
                        tone={
                          f.status === "MAPPED"
                            ? hasImage.get(f.sceneNumber!)
                              ? replace
                                ? "warn"
                                : "neutral"
                              : "ok"
                            : "danger"
                        }
                      >
                        {f.status === "MAPPED"
                          ? hasImage.get(f.sceneNumber!)
                            ? replace
                              ? "THAY ảnh hiện có"
                              : "bỏ qua (cảnh đã có ảnh)"
                            : "IMPORTED"
                          : f.status}
                      </Badge>
                      {f.status !== "MAPPED" ? (
                        <span className="ml-2 text-[11px] text-ink-500">{f.reason}</span>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            {files.length !== scenes.length ? (
              <Alert tone="warn" title={`${files.length} file cho ${scenes.length} cảnh`}>
                Số file khác số cảnh. Chỉ những file ghép được mới được dùng; cảnh không có file
                {plan.scenesWithoutFile.length > 0 ? ` (${plan.scenesWithoutFile.join(", ")})` : ""} giữ nguyên
                như hiện tại.
              </Alert>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              {willReplace.length > 0 ? (
                <label className="flex items-center gap-1.5 text-ink-300">
                  <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.currentTarget.checked)} />
                  Thay ảnh hiện có ở cảnh {willReplace.join(", ")}
                </label>
              ) : null}
              <Select value={fit} onChange={(e) => setFit(e.currentTarget.value)} className="h-7 w-auto text-[11px]">
                <option value="auto">Khung: tự động (lệch 9:16 → nền mờ)</option>
                <option value="contain">Khung: luôn giữ nguyên ảnh</option>
                <option value="cover">Khung: cắt cho đầy</option>
              </Select>
              <Button size="sm" variant="primary" disabled={busy || willApply.length === 0} onClick={onConfirm}>
                XÁC NHẬN — gắn {willApply.length} ảnh
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setFiles([])}>
                Huỷ
              </Button>
            </div>
          </>
        ) : null}

        {result ? (
          <Alert tone={result.ok ? "ok" : "danger"} title={result.ok ? "Đã nhập ảnh" : "Chưa nhập được"}>
            <p>{result.message}</p>
            {result.skipped && result.skipped.length > 0 ? (
              <ul className="mt-1 list-disc pl-4">
                {result.skipped.map((s) => (
                  <li key={s.fileName}>
                    <span className="font-mono">{s.fileName}</span>: {s.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
