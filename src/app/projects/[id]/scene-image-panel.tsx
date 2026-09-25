"use client";

import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Badge, Button, Select } from "@/components/ui";
import type { ActionResult } from "@/components/action-ui";
import {
  importImageForScene,
  removeImportedImage,
  sceneImageHistory,
  useEarlierImportedImage,
  type SceneImageHistoryItem,
} from "@/app/actions/scene-images";

/**
 * One scene's picture: where it came from, and the ways to change that.
 *
 * The source badge is the whole point. IMPORTED means a person supplied it and
 * no Image API call will ever be made for it; AI means it was (or will be)
 * generated; THIẾU means the next run will CREATE one and pay for it. Every
 * button here is $0 - none of them calls an image provider.
 */
export function SceneImagePanel({
  sceneId,
  sceneNumber,
  imageSource,
  hasImage,
  motionMode,
  hasClip,
  onDone,
}: {
  sceneId: string;
  sceneNumber: number;
  imageSource: string;
  hasImage: boolean;
  motionMode: string;
  hasClip: boolean;
  onDone: (result: ActionResult) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fit, setFit] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<SceneImageHistoryItem[]>([]);

  useEffect(() => {
    let live = true;
    sceneImageHistory(sceneId).then((h) => live && setHistory(h)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sceneId, imageSource, hasImage]);

  const imported = imageSource === "IMPORTED" && hasImage;
  const source = imported ? "NHẬP" : hasImage ? "AI" : "THIẾU";
  const tone = imported ? "ok" : hasImage ? "info" : "warn";

  async function onPick(file: File) {
    if (hasImage) {
      const warn =
        `Thay ảnh hiện tại của cảnh ${sceneNumber}?` +
        (hasClip ? "\n\nClip AI dựng từ ảnh cũ sẽ bị bỏ; cảnh VIDEO_AI sẽ cần clip mới (có tính phí khi chạy)." : "") +
        "\n\nẢnh cũ vẫn được giữ trong lịch sử.";
      if (!window.confirm(warn)) return;
    }
    const form = new FormData();
    form.set("sceneId", sceneId);
    form.set("file", file);
    form.set("fit", fit);
    if (hasImage) form.set("confirmReplace", "yes");
    setBusy(true);
    try {
      onDone(await importImageForScene(form));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="mb-3 rounded-lg border border-ink-800 bg-ink-850 p-3 text-[11px]">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-ink-300">Ảnh cảnh</span>
        <Badge tone={tone}>{source}</Badge>
        <Badge tone={imported ? "ok" : hasImage ? "neutral" : "warn"}>
          {imported || hasImage ? "REUSE · $0" : "CREATE · Image API"}
        </Badge>
        <Badge tone={motionMode === "VIDEO_AI" ? "brand" : "neutral"}>
          {motionMode === "AUTO" ? "Motion: tự chọn" : motionMode}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <input
          ref={fileRef}
          type="file"
          accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void onPick(f);
          }}
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload className="h-3 w-3" />
          {hasImage ? "Thay ảnh" : "Chọn ảnh"}
        </Button>
        <Select value={fit} onChange={(e) => setFit(e.currentTarget.value)} className="h-7 w-auto text-[11px]">
          <option value="auto">Khung: tự động</option>
          <option value="contain">Khung: giữ nguyên ảnh (nền mờ)</option>
          <option value="cover">Khung: cắt cho đầy</option>
        </Select>
        {imported ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm(`Bỏ ảnh nhập của cảnh ${sceneNumber}? Lần chạy sau sẽ TẠO ảnh bằng AI (có tính phí).`)) return;
              setBusy(true);
              try {
                onDone(await removeImportedImage(sceneId));
              } finally {
                setBusy(false);
              }
            }}
          >
            Bỏ ảnh nhập
          </Button>
        ) : null}
      </div>

      {history.length > 1 || (history.length === 1 && !history[0]!.active) ? (
        <div className="mt-2 space-y-1">
          <p className="text-ink-500">Ảnh đã nhập trước đây:</p>
          {history.map((h) => (
            <div key={h.assetId} className="flex items-center justify-between gap-2">
              <span className="truncate text-ink-400">
                {h.originalFilename ?? "ảnh"} · {h.width}x{h.height}
              </span>
              {h.active ? (
                <Badge tone="ok">đang dùng</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      onDone(await useEarlierImportedImage(sceneId, h.assetId));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Dùng ảnh này
                </Button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
