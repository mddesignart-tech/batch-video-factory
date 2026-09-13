"use client";

import { useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { listProviderModels } from "@/app/actions/spending";
import type { ModelDiscovery } from "@/services/model-discovery";

/**
 * Asks the provider which models it currently serves.
 *
 * Added after a real outage of our own making: the seed shipped a model name
 * that Groq had retired, and the first real call failed with a 404 at exactly
 * the wrong moment. Model names belong to the provider, so the registry has to
 * be checkable against the live list rather than trusted indefinitely.
 *
 * Listing models is free on every OpenAI-compatible API, so this button never
 * costs anything.
 */
export function ModelDiscoveryPanel({ provider }: { provider: string }) {
  const [result, setResult] = useState<ModelDiscovery | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <div className="space-y-2 border-t border-ink-800 pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
          Danh sách model thật
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            setResult(await listProviderModels(provider));
            setLoading(false);
          }}
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Hỏi nhà cung cấp
        </Button>
      </div>

      {result ? (
        result.ok ? (
          <div className="space-y-2">
            {result.stale.length > 0 ? (
              <div className="rounded-md border border-danger-500/30 bg-danger-500/10 p-2.5 text-[11px]">
                <p className="flex items-center gap-1.5 font-semibold text-danger-500">
                  <AlertTriangle className="h-3 w-3" />
                  {result.stale.length} model trong bảng Mô hình AI không còn tồn
                  tại
                </p>
                <p className="mt-1 text-ink-300">
                  Gọi những model này sẽ nhận lỗi 404. Hãy sửa tên hoặc xoá:{" "}
                  <span className="font-mono">{result.stale.join(", ")}</span>
                </p>
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-[11px] text-ok-500">
                <Check className="h-3 w-3" />
                Mọi model trong bảng đều còn tồn tại ở nhà cung cấp.
              </p>
            )}

            <div className="max-h-48 overflow-y-auto rounded-md border border-ink-800">
              <table className="w-full text-[11px]">
                <tbody>
                  {result.models.map((m) => (
                    <tr key={m.id} className="border-b border-ink-850">
                      <td className="px-2 py-1 font-mono text-ink-300">
                        {m.id}
                      </td>
                      <td className="px-2 py-1 text-right text-ink-600">
                        {m.contextWindow
                          ? `${Math.round(m.contextWindow / 1024)}k`
                          : ""}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {m.known ? (
                          <Badge tone="ok">đã có</Badge>
                        ) : (
                          <span className="text-ink-600">chưa thêm</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-ink-600">
              {result.models.length} model khả dụng. Lấy danh sách không tốn phí.
            </p>
          </div>
        ) : (
          <p className="rounded-md border border-warn-500/30 bg-warn-500/10 p-2.5 text-[11px] text-warn-500">
            {result.error}
          </p>
        )
      ) : null}
    </div>
  );
}
