import { NextResponse } from "next/server";
import { batchProgress } from "@/services/batch-runner";
import { errorMessage } from "@/lib/utils";

/**
 * Live progress for one batch, read straight from the database.
 *
 * The batch page polls this instead of reloading. Everything it returns is
 * derived from persisted rows, never from in-memory state, which is what makes
 * a reconnect work: a browser that has been closed for ten minutes asks once
 * and gets the current truth, with no notion of what it missed.
 *
 * Read-only by construction - it calls `batchProgress` and nothing else, so
 * there is no path from a poll to a provider request.
 */

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const progress = await batchProgress(id);
    if (!progress) {
      return NextResponse.json({ error: "Không tìm thấy lô." }, { status: 404 });
    }
    return NextResponse.json(progress, {
      // A cached progress response is a progress bar that lies.
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
