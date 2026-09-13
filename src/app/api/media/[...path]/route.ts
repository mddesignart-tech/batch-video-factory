import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { toAbsolute } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Serves generated media out of `data/`.
 *
 * The files live outside `public/` deliberately - they are user data, not app
 * assets, and must not be statically traced into a build. `toAbsolute` refuses
 * any path that resolves outside the data root, so a crafted `../` segment gets
 * a 400 rather than a file read.
 *
 * Range requests are honoured so the browser's <video> element can seek.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".srt": "text/plain; charset=utf-8",
  ".ass": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segments } = await context.params;
  const relative = segments.map(decodeURIComponent).join("/");

  let absolute: string;
  try {
    absolute = toAbsolute(relative);
  } catch {
    return NextResponse.json({ error: "Đường dẫn không hợp lệ." }, { status: 400 });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return NextResponse.json({ error: "Không tìm thấy tệp." }, { status: 404 });
  }
  if (!stat.isFile()) {
    return NextResponse.json({ error: "Không tìm thấy tệp." }, { status: 404 });
  }

  const contentType =
    CONTENT_TYPES[path.extname(absolute).toLowerCase()] ??
    "application/octet-stream";

  const range = request.headers.get("range");
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        end < stat.size &&
        start <= end
      ) {
        const stream = fs.createReadStream(absolute, { start, end });
        return new Response(stream as unknown as ReadableStream, {
          status: 206,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${stat.size}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
          },
        });
      }
    }
  }

  const stream = fs.createReadStream(absolute);
  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}
