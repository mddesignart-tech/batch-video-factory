import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
} from "@/components/ui";
import { isMockMode } from "@/lib/env";
import { encryptionAvailable } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { listProviderHealth } from "@/services/provider-health";
import { VI_PROVIDER_STATUS, type ProviderStatus } from "@/domain/enums";
import { formatDateVi } from "@/lib/utils";
import { ProviderCard } from "./provider-forms";
import { SpendGate } from "@/components/spend-gate";
import { ModelDiscoveryPanel } from "@/components/model-discovery-panel";
import { spendStatus } from "@/services/spend-guard";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<ProviderStatus, "ok" | "warn" | "danger" | "neutral"> = {
  connected: "ok",
  missing_key: "warn",
  unavailable: "danger",
  rate_limited: "warn",
  disabled: "neutral",
};

export default async function ProvidersPage() {
  const [health, configs, textModels, spend] = await Promise.all([
    listProviderHealth(),
    prisma.providerConfig.findMany(),
    // Only text models get a spend gate in this build - text is the only slot
    // with a real provider behind it.
    prisma.modelRegistry.findMany({
      where: { type: "text", provider: { not: "mock" } },
      orderBy: [{ provider: "asc" }, { modelId: "asc" }],
    }),
    spendStatus(),
  ]);

  const configById = new Map(configs.map((c) => [c.name, c]));
  const canStoreKeys = encryptionAvailable();

  return (
    <>
      <PageHeader
        title="Nhà cung cấp AI"
        description="Trạng thái kết nối, API key và thứ tự ưu tiên khi chuyển dự phòng."
      />

      {isMockMode() ? (
        <Card className="mb-4 border-brand-500/30">
          <CardContent className="text-xs text-ink-300">
            <strong className="text-brand-400">Đang bật chế độ mock.</strong>{" "}
            Mọi yêu cầu tạo nội dung đều dùng nhà cung cấp mock cục bộ, không có
            kết nối mạng nào tới nhà cung cấp trả phí và không phát sinh chi phí.
            Tắt bằng cách đặt <code className="text-ink-200">AI_MOCK_MODE=false</code>{" "}
            trong tệp <code className="text-ink-200">.env</code>.
          </CardContent>
        </Card>
      ) : null}

      {!canStoreKeys ? (
        <Card className="mb-4 border-warn-500/30">
          <CardContent className="text-xs text-ink-300">
            Chưa cấu hình{" "}
            <code className="text-ink-200">SECRET_ENCRYPTION_KEY</code> trong{" "}
            <code className="text-ink-200">.env</code>, nên không thể lưu API key
            từ giao diện. Bạn vẫn có thể dùng biến môi trường riêng cho từng nhà
            cung cấp. Tạo khoá bằng lệnh:{" "}
            <code className="text-ink-200">
              node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;hex&apos;))&quot;
            </code>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mb-4 border-ink-700">
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-2 text-xs">
          <span>
            <span className="text-ink-500">Đã chi cho API thật: </span>
            <strong
              className={spend.spent > 0 ? "text-warn-500" : "text-ok-500"}
            >
              ${spend.spent.toFixed(4)}
            </strong>
          </span>
          <span>
            <span className="text-ink-500">Hạn mức: </span>
            <strong className="text-brand-400">${spend.cap.toFixed(2)}</strong>
          </span>
          <span>
            <span className="text-ink-500">Còn lại: </span>
            <strong
              className={spend.remaining <= 0 ? "text-danger-500" : "text-ink-100"}
            >
              ${spend.remaining.toFixed(4)}
            </strong>
          </span>
          <span className="text-ink-500">
            Đổi hạn mức trong trang Cài đặt.
          </span>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {health.map((provider) => {
          const config = configById.get(provider.name);
          if (!config) return null;
          return (
            <Card key={provider.name}>
              <CardHeader className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle>{provider.displayName}</CardTitle>
                  <p className="mt-0.5 text-xs text-ink-500">{provider.note}</p>
                </div>
                <Badge tone={STATUS_TONE[provider.status]}>
                  {VI_PROVIDER_STATUS[provider.status]}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <Info label="Loại dịch vụ" value={provider.types.join(", ")} />
                  <Info
                    label="Số mô hình"
                    value={String(provider.modelCount)}
                  />
                  <Info
                    label="API key"
                    value={
                      provider.apiKeyMask ??
                      (provider.apiConfigured
                        ? `biến môi trường ${config.apiKeyEnvVar}`
                        : "chưa có")
                    }
                  />
                  <Info
                    label="Đã tích hợp"
                    value={provider.implemented ? "Có" : "Chưa (Milestone 2)"}
                  />
                  <Info
                    label="Ưu tiên chính"
                    value={String(provider.priority)}
                  />
                  <Info
                    label="Ưu tiên dự phòng"
                    value={String(provider.fallbackPriority)}
                  />
                  <Info
                    label="Kiểm tra lần cuối"
                    value={formatDateVi(provider.lastCheckedAt)}
                  />
                </div>

                <ProviderCard
                  id={config.id}
                  name={provider.name}
                  enabled={provider.enabled}
                  hasStoredKey={provider.apiKeyMask !== null}
                  canStoreKeys={canStoreKeys}
                  priority={provider.priority}
                  fallbackPriority={provider.fallbackPriority}
                />

                {provider.types.includes("text") && provider.name !== "mock" ? (
                  <ModelDiscoveryPanel provider={provider.name} />
                ) : null}

                <SpendGate
                  provider={provider.name}
                  models={textModels
                    .filter((m) => m.provider === provider.name)
                    .map((m) => ({
                      modelId: m.modelId,
                      displayName: m.displayName,
                      enabled: m.enabled,
                    }))}
                />
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-ink-500">{label}</p>
      <p className="truncate text-ink-300">{value || "-"}</p>
    </div>
  );
}
