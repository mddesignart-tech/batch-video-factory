import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import type { ProviderSpendRow } from "@/services/provider-budget";

/**
 * Each vendor's wallet, side by side, never added up.
 *
 * The absence of a total is the point of this component. Money at one vendor
 * buys nothing at another, and a single "available" figure across all of them
 * would invite exactly the decision it must not: authorising a Sora call
 * against Runway credits.
 */

function money(n: number): string {
  return `$${n.toFixed(n < 0.01 ? 6 : 4)}`;
}

const UNIT_LABEL: Record<string, string> = {
  usd: "USD trả trước",
  credits: "credit của hãng",
  external: "hãng tự tính",
};

export function ProviderBudgets({ rows }: { rows: ProviderSpendRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ngân sách theo nhà cung cấp</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[11px] text-ink-400">
          Mỗi nhà cung cấp là một <strong>ví riêng</strong>. Tiền nạp ở OpenAI
          không dùng được ở Runway, và ngược lại. Vì vậy ở đây{" "}
          <strong>không có số tổng</strong> — cộng chúng lại là cách nhanh nhất
          để duyệt một lệnh gọi mà hãng sắp từ chối.
        </p>

        <div className="space-y-2">
          {rows.map((row) => {
            const budget = row.budget;
            const external = budget?.unit === "external";
            const low =
              row.remainingUsd !== null && row.remainingUsd > 0 && row.remainingUsd < 0.5;

            return (
              <div
                key={row.provider}
                className="rounded-lg border border-ink-800 p-2.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink-100">
                    {row.provider}
                  </span>
                  <Badge tone={external ? "neutral" : low ? "warn" : "ok"}>
                    {UNIT_LABEL[budget?.unit ?? "usd"] ?? "không rõ"}
                  </Badge>
                </div>

                <dl className="mt-1.5 space-y-0.5 text-[11px]">
                  <div className="flex justify-between">
                    <dt className="text-ink-400">Tool đã ghi nhận đã tiêu</dt>
                    <dd className="font-mono text-ink-200">{money(row.spentUsd)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-400">Số lần gọi</dt>
                    <dd className="font-mono text-ink-200">{row.calls}</dd>
                  </div>
                  {budget && !external && (
                    <div className="flex justify-between">
                      <dt className="text-ink-400">Còn ở tài khoản hãng</dt>
                      <dd className="font-mono text-ink-100">
                        {budget.unit === "credits"
                          ? `${budget.available} credit ≈ ${money(row.availableUsd ?? 0)}`
                          : money(row.availableUsd ?? 0)}
                      </dd>
                    </div>
                  )}
                  {external && (
                    <div className="flex justify-between">
                      <dt className="text-ink-400">Số dư</dt>
                      <dd className="text-ink-300">hãng tự quản lý, tool không giữ</dd>
                    </div>
                  )}
                </dl>

                {budget?.note && (
                  <p className="mt-1.5 text-[10px] text-ink-500">{budget.note}</p>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-[10px] text-ink-500">
          Hạn mức tổng của tool là một giới hạn <em>tự áp</em>, không phải số dư
          tài khoản. Nâng nó lên là cấp thêm quyền, không phải tạo ra tiền. Một
          lệnh gọi phải qua <strong>cả hai</strong>: hạn mức của tool và ví của
          chính nhà cung cấp đó.
        </p>
      </CardContent>
    </Card>
  );
}
