import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
} from "@/components/ui";
import { getSettings } from "@/lib/settings";
import { isMockMode } from "@/lib/env";
import { DATA_ROOT } from "@/lib/paths";
import { ffmpegVersion, resolveFfmpeg, resolveFfprobe } from "@/media/ffmpeg";
import { SettingsForm } from "./settings-form";
import { AudioMixForm } from "./audio-mix-form";
import { SpendCapForm } from "@/components/spend-gate";
import { spendStatus } from "@/services/spend-guard";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [settings, version, spend] = await Promise.all([
    getSettings(),
    ffmpegVersion(),
    spendStatus(),
  ]);

  return (
    <>
      <PageHeader
        title="Cài đặt"
        description="Giá trị mặc định cho dự án mới, hàng đợi công việc và dọn dẹp media."
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader>
            <CardTitle>Cấu hình ứng dụng</CardTitle>
          </CardHeader>
          <CardContent>
            <SettingsForm settings={settings} />
          </CardContent>
        </Card>

        <Card className="lg:col-start-1">
          <CardHeader>
            <CardTitle>Âm thanh</CardTitle>
          </CardHeader>
          <CardContent>
            <AudioMixForm mix={settings.audioMix} />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <SpendCapForm cap={spend.cap} spent={spend.spent} />

          <Card>
            <CardHeader>
              <CardTitle>Môi trường</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-xs">
              <Row
                label="Chế độ mock"
                value={isMockMode() ? "Bật (không tốn phí)" : "Tắt (sẽ tính phí)"}
                tone={isMockMode() ? "ok" : "danger"}
              />
              <Row label="Thư mục dữ liệu" value={DATA_ROOT} />
              <Row
                label="FFmpeg"
                value={resolveFfmpeg() ?? "không tìm thấy"}
                tone={resolveFfmpeg() ? "ok" : "danger"}
              />
              <Row
                label="ffprobe"
                value={resolveFfprobe() ?? "không tìm thấy"}
                tone={resolveFfprobe() ? "ok" : "danger"}
              />
              <Row label="Phiên bản FFmpeg" value={version ?? "-"} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Những gì không sửa được ở đây</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-ink-400">
              <p>
                <code className="text-ink-200">AI_MOCK_MODE</code>,{" "}
                <code className="text-ink-200">SECRET_ENCRYPTION_KEY</code> và
                các API key chỉ đọc từ tệp{" "}
                <code className="text-ink-200">.env</code>. Đây là chủ ý: công
                tắc an toàn chi phí không nên bật/tắt được bằng một cú nhấp
                chuột trong trình duyệt.
              </p>
              <p>
                Sau khi sửa <code className="text-ink-200">.env</code>, hãy khởi
                động lại ứng dụng.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "danger";
}) {
  const colors = {
    neutral: "text-ink-300",
    ok: "text-ok-500",
    danger: "text-danger-500",
  } as const;
  return (
    <div>
      <p className="text-[11px] text-ink-500">{label}</p>
      <p className={`break-all font-mono text-[11px] ${colors[tone]}`}>{value}</p>
    </div>
  );
}
