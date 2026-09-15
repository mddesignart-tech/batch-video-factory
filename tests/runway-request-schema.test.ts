import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildCreateBody,
  createTask,
  sizeStyleFor,
  toRunwayResolution,
} from "@/providers/runway/runway-video-client";
import type { VideoModelConfig } from "@/providers/video-config";

/**
 * The exact JSON that leaves this machine, per model.
 *
 * Runway's /image_to_video is ONE endpoint serving models from several vendors,
 * and they do NOT share a request schema. The adapter used to send the Gen-4
 * shape to everything: `ratio` plus `duration`, always. That is correct for
 * gen4_turbo and gen4.5 and a validation error for h3_max, which takes
 * `resolution` and rejects `ratio` outright.
 *
 * Verbatim from docs.dev.runwayml.com/assets/inputs (read 2026-09-15):
 *
 *   "MiniMax H3 Max supports `resolution` of `480p` or `768p`. Durations are
 *    5-15 seconds. There is no `ratio` parameter."
 *
 * Note the lower-case `p`, and note that the SIBLING model `hailuo3` spells it
 * `768P` and DOES take a `ratio`. Two MiniMax models, two schemas, one letter
 * apart - which is why the adapter carries a table rather than an if-statement,
 * and why this file asserts the bytes rather than the intent.
 *
 * Why assert the body at all: a rejected create is still a create. This project
 * allows exactly one paid POST per approval, so a schema mistake does not cost
 * a retry - it costs the whole attempt.
 */

let server: http.Server;
let baseUrl = "";
let lastBody = "";
let createCount = 0;
let tempDir = "";
let keyframe = "";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function config(model: string, size: string): VideoModelConfig {
  return {
    providerName: "runway",
    model,
    apiKey: "test-key",
    baseUrl,
    pricePerSecond: 0.08,
    size,
    timeoutMs: 5000,
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastBody = Buffer.concat(chunks).toString("utf8");
      createCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "task-1", status: "PENDING" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rwreq-"));
  keyframe = path.join(tempDir, "keyframe.png");
  fs.writeFileSync(keyframe, PNG);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  createCount = 0;
  lastBody = "";
});

describe("h3_max: body thực tế gửi đi", () => {
  it("gửi đúng schema của h3_max và KHÔNG có field thừa", async () => {
    await createTask(config("h3_max", "768x1280"), {
      prompt: "a man stares at a bowl of cold soup",
      seconds: 5,
      keyframePath: keyframe,
    });

    expect(createCount).toBe(1);
    const sent = JSON.parse(lastBody) as Record<string, unknown>;

    expect(sent.model).toBe("h3_max");
    expect(sent.resolution).toBe("768p");
    expect(sent.duration).toBe(5);
    expect(sent.promptText).toBe("a man stares at a bowl of cold soup");
    expect(typeof sent.promptImage).toBe("string");
    expect(sent.promptImage as string).toMatch(/^data:image\/png;base64,/);

    // `ratio` must be ABSENT, not empty and not null. h3_max rejects the field
    // rather than ignoring it, so an empty string would still be a 400.
    expect("ratio" in sent).toBe(false);

    // No field beyond the five the schema names. An extra key is exactly the
    // kind of thing that passes review and fails validation.
    expect(Object.keys(sent).sort()).toEqual([
      "duration",
      "model",
      "promptImage",
      "promptText",
      "resolution",
    ]);
  });

  it("dùng chữ p THƯỜNG, không phải 768P của hailuo3", () => {
    // One letter. hailuo3 documents `768P`; h3_max documents `768p`. They are
    // different models with different schemas and the capital would be a 400.
    const body = buildCreateBody(config("h3_max", "768x1280"), {
      prompt: "x",
      seconds: 5,
      keyframePath: keyframe,
    });
    expect(body.resolution).toBe("768p");
    expect(body.resolution).not.toBe("768P");
  });

  it("lấy CẠNH NGẮN làm bậc phân giải", () => {
    // Portrait clips: a 768x1280 frame is 768p, not 1280p. Getting this
    // backwards asks for a tier the model does not sell.
    expect(toRunwayResolution("h3_max", "768x1280")).toBe("768p");
    expect(toRunwayResolution("h3_max", "480x854")).toBe("480p");
  });

  it("làm tròn XUỐNG khi bậc không tồn tại, không bao giờ lên", () => {
    // Rounding up would silently cost more than the registry row was priced at.
    // wan3 is the cautionary case: its own default is auto_1080p at 20
    // credits/s, four times the 480p rate.
    expect(toRunwayResolution("h3_max", "600x1000")).toBe("480p");
    expect(toRunwayResolution("wan3", "900x1600")).toBe("720p");
    expect(toRunwayResolution("wan3", "720x1280")).toBe("720p");
  });

  it("độ dài 5 giây đi nguyên vẹn, không bị ép về bậc 5/10 của gen4_turbo", async () => {
    await createTask(config("h3_max", "768x1280"), {
      prompt: "x",
      seconds: 5,
      keyframePath: keyframe,
    });
    expect((JSON.parse(lastBody) as { duration: number }).duration).toBe(5);

    lastBody = "";
    await createTask(config("h3_max", "768x1280"), {
      prompt: "x",
      seconds: 7,
      keyframePath: keyframe,
    });
    // 7 is inside h3_max's 5-15 range, so it goes as 7. gen4_turbo would have
    // rounded this to 10 and billed double.
    expect((JSON.parse(lastBody) as { duration: number }).duration).toBe(7);
  });
});

describe("gen4 vẫn giữ nguyên schema cũ", () => {
  it("gen4_turbo gửi ratio, KHÔNG gửi resolution", async () => {
    await createTask(config("gen4_turbo", "720x1280"), {
      prompt: "x",
      seconds: 5,
      keyframePath: keyframe,
    });
    const sent = JSON.parse(lastBody) as Record<string, unknown>;
    expect(sent.ratio).toBe("720:1280");
    expect("resolution" in sent).toBe(false);
    expect(Object.keys(sent).sort()).toEqual([
      "duration",
      "model",
      "promptImage",
      "promptText",
      "ratio",
    ]);
  });

  it("gen4.5 cũng dùng ratio", () => {
    expect(sizeStyleFor("gen4.5")).toBe("RATIO");
    expect(sizeStyleFor("gen4_turbo")).toBe("RATIO");
    expect(sizeStyleFor("h3_max")).toBe("RESOLUTION");
    expect(sizeStyleFor("wan3")).toBe("RESOLUTION");
  });

  it("wan3 PHẢI gửi resolution tường minh", () => {
    // Omitting it falls back to the vendor's own `auto_1080p` at 20 credits/s -
    // a 5-second clip becomes $1.00 instead of $0.25.
    const body = buildCreateBody(config("wan3", "480x854"), {
      prompt: "x",
      seconds: 5,
      keyframePath: keyframe,
    });
    expect(body.resolution).toBe("480p");
    expect(body.ratio).toBeUndefined();
  });
});
