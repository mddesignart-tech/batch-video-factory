"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui";
import { refreshRunwayBalanceNow } from "@/app/actions/balance";

/** One free GET to Runway, on demand. Never automatic. */
export function RefreshBalanceButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await refreshRunwayBalanceNow();
            setMsg({ ok: r.ok, text: r.message });
            router.refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} />
        REFRESH BALANCE
      </Button>
      {msg ? <span className={`text-[11px] ${msg.ok ? "text-ok-500" : "text-warn-500"}`}>{msg.text}</span> : null}
    </div>
  );
}
