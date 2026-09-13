import { NextResponse } from "next/server";
import { isMockMode } from "@/lib/env";
import { ffmpegAvailable, ffmpegVersion } from "@/media/ffmpeg";
import { queueStats } from "@/jobs/queue";
import { workerRunning } from "@/jobs/worker";
import { getConnectivity, OFFLINE_MESSAGE } from "@/services/connectivity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Feeds the status strip. Cheap, cached at the service layer, safe offline. */
export async function GET(): Promise<NextResponse> {
  const [connectivity, queue, version] = await Promise.all([
    getConnectivity(),
    queueStats(),
    ffmpegVersion(),
  ]);

  return NextResponse.json({
    connectivity,
    mockMode: isMockMode(),
    ffmpegAvailable: ffmpegAvailable(),
    ffmpegVersion: version,
    workerRunning: workerRunning(),
    queue,
    offlineMessage: OFFLINE_MESSAGE,
  });
}
