"use client";

import { useEffect, useState } from "react";
import { Cloud, CloudOff, HardDrive, Loader2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The status strip at the top of every page.
 *
 * It answers the three questions an operator asks constantly: am I online, is
 * mock mode on (i.e. am I about to spend money), and is the worker actually
 * chewing through the queue. Polling is slow on purpose - this is a local tool,
 * not a monitoring dashboard.
 */

interface SystemStatus {
  connectivity: "ONLINE" | "OFFLINE";
  mockMode: boolean;
  ffmpegAvailable: boolean;
  ffmpegVersion: string | null;
  workerRunning: boolean;
  queue: Record<string, number>;
  offlineMessage: string;
}

const POLL_MS = 8000;

export function SystemStatus() {
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as SystemStatus;
        if (!cancelled) setStatus(data);
      } catch {
        // A failed status poll is not worth surfacing; the banner just holds
        // its last known value.
      }
    };

    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!status) {
    return (
      <div className="flex h-9 items-center gap-2 px-6 text-xs text-ink-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Đang kiểm tra hệ thống...
      </div>
    );
  }

  const offline = status.connectivity === "OFFLINE";
  const busy = (status.queue.processing ?? 0) + (status.queue.queued ?? 0);

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-ink-850 bg-ink-900 px-6 py-2 text-xs">
      <span
        className={cn(
          "flex items-center gap-1.5",
          offline ? "text-warn-500" : "text-ok-500",
        )}
      >
        {offline ? (
          <CloudOff className="h-3.5 w-3.5" />
        ) : (
          <Cloud className="h-3.5 w-3.5" />
        )}
        {offline ? "Ngoại tuyến" : "Trực tuyến"}
      </span>

      {status.mockMode ? (
        <span className="flex items-center gap-1.5 text-brand-400">
          <Zap className="h-3.5 w-3.5" />
          Chế độ mock - không tốn phí API
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-danger-500">
          <Zap className="h-3.5 w-3.5" />
          Chế độ thật - sẽ tính phí API
        </span>
      )}

      <span
        className={cn(
          "flex items-center gap-1.5",
          status.ffmpegAvailable ? "text-ink-400" : "text-danger-500",
        )}
        title={status.ffmpegVersion ?? undefined}
      >
        <HardDrive className="h-3.5 w-3.5" />
        FFmpeg: {status.ffmpegAvailable ? "sẵn sàng" : "chưa cài"}
      </span>

      <span className="flex items-center gap-1.5 text-ink-400">
        {busy > 0 ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-500" />
        ) : null}
        Hàng đợi: {status.queue.queued ?? 0} chờ / {status.queue.processing ?? 0}{" "}
        đang chạy
        {!status.workerRunning ? (
          <span className="text-danger-500"> (worker đang tắt)</span>
        ) : null}
      </span>

      {offline ? (
        <span className="w-full text-warn-500">{status.offlineMessage}</span>
      ) : null}
    </div>
  );
}
