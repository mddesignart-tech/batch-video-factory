"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, PlugZap } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Table, Td, Th, Textarea } from "@/components/ui";
import {
  saveVideoProfileAction,
  setDefaultVideoModelAction,
  setVideoRoutingModeAction,
  testVideoConnectionAction,
} from "@/app/actions/video-models";
import { VI_ROUTING_MODE, type RoutingMode } from "@/domain/video-model-profile";
import type { VideoModelRow } from "@/services/video-model-admin";

const MODE_TONE: Record<RoutingMode, "ok" | "warn" | "danger" | "neutral"> = {
  AUTO_OK: "ok",
  PIN_ONLY: "warn",
  DEPRECATED: "danger",
  DISABLED: "neutral",
};

/**
 * Nhà cung cấp AI → Video AI (Nâng cao). Not part of daily work: a person
 * making videos never needs to open this. Every button is a registry write or
 * a free check - nothing here creates a video.
 */
export function VideoAiAdmin({ rows }: { rows: VideoModelRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const providers = [...new Set(rows.map((r) => r.provider))].filter((p) => p !== "ffmpeg");

  const act = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.message });
      router.refresh();
    });

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle>Video AI (Nâng cao)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-ink-400">
          Thêm/đổi nhà cung cấp Video AI không cần sửa Storyboard, giọng, phụ đề hay render: chỉ cần adapter + một dòng
          model + giá + hồ sơ khả năng. Model mới luôn bắt đầu ở “Chỉ chọn tay”; “Tự định tuyến” chỉ bật được sau khi
          benchmark đạt. Không nút nào ở đây tạo video.
        </p>
        <div className="flex flex-wrap gap-2">
          {providers.map((p) => (
            <Button
              key={p}
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await testVideoConnectionAction(p);
                  const missing = r.modelsMissing.length ? ` · Không còn trong danh sách: ${r.modelsMissing.join(", ")}` : "";
                  setMsg({ ok: r.ok, text: `${p}: ${r.note}${missing} (0 request trả phí)` });
                })
              }
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlugZap className="h-3 w-3" />}
              Kiểm tra kết nối {p}
            </Button>
          ))}
        </div>
        {msg ? <Alert tone={msg.ok ? "ok" : "danger"} title={msg.text} /> : null}
        <Table>
          <thead>
            <tr>
              <Th>Provider / Model</Th>
              <Th>Trạng thái</Th>
              <Th>Khả năng</Th>
              <Th>Tỷ lệ hỗ trợ</Th>
              <Th className="text-right">Giá dự kiến</Th>
              <Th>Routing</Th>
              <Th>Benchmark</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="align-top hover:bg-ink-850">
                <Td>
                  <p className="text-xs text-ink-400">{r.provider}</p>
                  <p className="font-medium text-ink-100">{r.displayName}</p>
                  <p className="font-mono text-[10px] text-ink-500">{r.modelId}</p>
                  {r.profile.isDefault ? <Badge tone="info">Mặc định</Badge> : null}
                  {!r.adapter ? <Badge tone="danger">Chưa có adapter</Badge> : null}
                </Td>
                <Td>
                  <Badge tone={r.enabled ? "ok" : "neutral"}>{r.enabled ? "Bật" : "Tắt"}</Badge>
                  <p className="mt-1 text-[10px] text-ink-500">{r.lifecycle}</p>
                  {r.reliability !== "OK" ? <Badge tone="danger">{r.reliability}</Badge> : null}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {r.profile.textToVideo ? <Badge>Text→Video</Badge> : null}
                    {r.profile.imageToVideo ? <Badge>Ảnh→Video</Badge> : null}
                    {r.profile.characterReference ? (
                      <Badge tone="info">Nhân vật</Badge>
                    ) : r.profile.referenceImage ? (
                      <Badge>Ảnh tham chiếu</Badge>
                    ) : null}
                    {r.profile.supportedDurations.length ? <Badge>≤{Math.max(...r.profile.supportedDurations)}s</Badge> : null}
                    <Badge>{r.profile.maxReferenceImages ?? 0} ảnh tham chiếu</Badge>
                    {r.profile.directReference ? <Badge tone="info">Gửi tham chiếu trực tiếp</Badge> : null}
                  </div>
                  {r.profile.inferred ? <p className="mt-1 text-[10px] text-ink-500">(suy ra từ cột cũ)</p> : null}
                </Td>
                <Td className="text-xs text-ink-300">{r.profile.supportedAspectRatios.join(", ") || "—"}</Td>
                <Td className="text-right text-xs tabular-nums text-ink-200">
                  ${r.price} <span className="text-ink-500">/{r.priceUnit}</span>
                  {r.profile.credits !== undefined ? (
                    <p className="text-[10px] text-ink-500">
                      {r.profile.credits} credit/{r.profile.billingUnit ?? "?"}
                    </p>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={MODE_TONE[r.routingMode]}>{VI_ROUTING_MODE[r.routingMode]}</Badge>
                  {r.lifecycle === "LOW_AUTO" ? <p className="mt-1 text-[10px] text-ink-500">chỉ cảnh LOW</p> : null}
                </Td>
                <Td className="text-xs text-ink-300">
                  {r.verification === "BENCHMARK_VERIFIED" ? <Badge tone="ok">Đạt</Badge> : <Badge>Chưa</Badge>}
                  <p className="mt-1 text-[10px] text-ink-500">
                    {r.benchmarkPassed}/{r.benchmarkRuns} lần chạy thành công
                  </p>
                </Td>
                <Td>
                  <div className="flex flex-col gap-1">
                    <Button size="sm" variant="outline" disabled={pending || r.routingMode === "AUTO_OK"} onClick={() => act(() => setVideoRoutingModeAction(r.id, "AUTO_OK"))}>
                      Tự định tuyến
                    </Button>
                    <Button size="sm" variant="ghost" disabled={pending || r.routingMode === "PIN_ONLY"} onClick={() => act(() => setVideoRoutingModeAction(r.id, "PIN_ONLY"))}>
                      Chỉ chọn tay
                    </Button>
                    <Button size="sm" variant="ghost" disabled={pending || r.routingMode === "DEPRECATED"} onClick={() => act(() => setVideoRoutingModeAction(r.id, "DEPRECATED"))}>
                      Ngừng dùng
                    </Button>
                    <Button size="sm" variant="ghost" disabled={pending || r.routingMode === "DISABLED"} onClick={() => act(() => setVideoRoutingModeAction(r.id, "DISABLED"))}>
                      Tắt
                    </Button>
                    <Button size="sm" variant="ghost" disabled={pending || r.profile.isDefault} onClick={() => act(() => setDefaultVideoModelAction(r.id))}>
                      Đặt mặc định
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(editing === r.id ? null : r.id);
                        const profile: Record<string, unknown> = { ...r.profile };
                        delete profile.inferred;
                        setDraft(JSON.stringify(profile, null, 2));
                      }}
                    >
                      Hồ sơ khả năng
                    </Button>
                  </div>
                  {editing === r.id ? (
                    <div className="mt-2 w-72 space-y-1">
                      <Textarea rows={10} value={draft} onChange={(e) => setDraft(e.currentTarget.value)} className="font-mono text-[10px]" />
                      <Button size="sm" variant="primary" disabled={pending} onClick={() => act(() => saveVideoProfileAction(r.id, draft))}>
                        Lưu hồ sơ
                      </Button>
                    </div>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </CardContent>
    </Card>
  );
}
