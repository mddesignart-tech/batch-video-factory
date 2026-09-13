import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createTask,
  downloadTaskOutput,
  getTask,
  isTerminal as runwayTerminal,
  nearestDuration as runwayDuration,
  RUNWAY_API_VERSION,
  RUNWAY_DURATIONS,
  toDataUri,
  toRunwayRatio,
} from "@/providers/runway/runway-video-client";
import {
  clearRunwayOutputs,
  RunwayVideoProvider,
} from "@/providers/runway/runway-video-provider";
import {
  createOperation,
  forcedToEightSeconds,
  getOperation,
  nearestDuration as veoDuration,
  VEO_DURATIONS,
} from "@/providers/google/google-video-client";
import {
  clearGoogleOutputs,
  GoogleVideoProvider,
} from "@/providers/google/google-video-provider";
import {
  aspectRatioFor,
  resolutionTierFor,
  type VideoModelConfig,
} from "@/providers/video-config";
import { isMockMode, resetEnvCache } from "@/lib/env";
import { getVideoProvider } from "@/providers/registry";

/**
 * Google Veo and Runway adapters, against local stubs.
 *
 * Neither provider has an API key in this environment, so nothing here could
 * reach them even by accident. What these tests are really guarding is the
 * pricing arithmetic: both vendors bill a duration the caller did not ask for
 * - Runway rounds 4 seconds up to 5, Veo forces 8 with a keyframe - and an
 * estimate that ignored either would understate the bill by 25% or 100%.
 */

let server: http.Server;
let baseUrl = "";
let lastBody = "";
let lastHeaders: http.IncomingHttpHeaders = {};
let lastUrl = "";
let createCount = 0;
let tempDir = "";

let behaviour: {
  createStatus: number;
  createBody: unknown;
  taskBody?: unknown;
  outputBody?: Buffer;
};

const MP4 = Buffer.from("ftypisom-fake-clip", "latin1");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    lastUrl = url;
    lastHeaders = req.headers;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastBody = Buffer.concat(chunks).toString("utf8");
      const send = (status: number, body: unknown, json = true) => {
        res.writeHead(status, {
          "Content-Type": json ? "application/json" : "video/mp4",
        });
        res.end(json ? JSON.stringify(body) : (body as Buffer));
      };

      if (req.method === "POST") {
        createCount++;
        return send(behaviour.createStatus, behaviour.createBody);
      }
      if (url.includes("/download")) {
        return send(200, behaviour.outputBody ?? MP4, false);
      }
      return send(200, behaviour.taskBody ?? { id: "t1", status: "SUCCEEDED" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcmp-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  createCount = 0;
  lastBody = "";
  clearRunwayOutputs();
  clearGoogleOutputs();
});

function config(
  provider: string,
  overrides: Partial<VideoModelConfig> = {},
): VideoModelConfig {
  return {
    providerName: provider,
    model: provider === "runway" ? "gen4_turbo" : "veo-3.1-lite-generate-preview",
    apiKey: "test-key-not-a-real-secret",
    baseUrl,
    pricePerSecond: 0.05,
    size: "720x1280",
    timeoutMs: 3000,
    ...overrides,
  };
}

function keyframe(name: string): string {
  const p = path.join(tempDir, name);
  fs.writeFileSync(p, PNG);
  return p;
}

function videoRequest(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "p",
    sceneId: "s",
    model: "m",
    prompt: "animate",
    negativePrompt: "",
    durationSeconds: 4,
    width: 720,
    height: 1280,
    fps: 30,
    outputPath: path.join(tempDir, `out-${Math.random()}.mp4`),
    ...overrides,
  };
}

// -------------------------------------------------------- size translation ---

describe("dịch kích thước cho từng nhà cung cấp", () => {
  it("Runway dùng dấu hai chấm, không phải chữ x", () => {
    expect(toRunwayRatio("720x1280")).toBe("720:1280");
  });

  it("Google dùng nhãn tỷ lệ và mức độ phân giải", () => {
    expect(aspectRatioFor("720x1280")).toBe("9:16");
    expect(aspectRatioFor("1280x720")).toBe("16:9");
    expect(resolutionTierFor("720x1280")).toBe("720p");
    expect(resolutionTierFor("1080x1920")).toBe("1080p");
  });
});

// ------------------------------------------------------ billed duration ---

describe("thời lượng bị tính tiền khác thời lượng yêu cầu", () => {
  it("Runway làm tròn LÊN, không bao giờ xuống", () => {
    expect(RUNWAY_DURATIONS).toEqual([5, 10]);
    expect(runwayDuration(4)).toBe(5);
    expect(runwayDuration(5)).toBe(5);
    expect(runwayDuration(6)).toBe(10);
  });

  it("Veo chấp nhận 4, 6, 8 giây", () => {
    expect(VEO_DURATIONS).toEqual([4, 6, 8]);
    expect(veoDuration(4)).toBe(4);
    expect(veoDuration(5)).toBe(6);
  });

  it("Veo bị ép 8 giây khi có keyframe hoặc độ phân giải cao", () => {
    expect(forcedToEightSeconds("720x1280", true)).toBe(true);
    expect(forcedToEightSeconds("1080x1920", false)).toBe(true);
    expect(forcedToEightSeconds("720x1280", false)).toBe(false);
  });

  it("ước tính Runway tính theo 5 giây cho cảnh 4 giây", async () => {
    const provider = new RunwayVideoProvider(config("runway", { pricePerSecond: 0.05 }));
    const estimate = await provider.estimateCost(videoRequest() as never);
    // 4 x 0.05 = 0.20 se thap hon hoa don 25%.
    expect(estimate.amount).toBeCloseTo(0.25, 6);
    expect(estimate.detail).toContain("tính tiền 5s");
  });

  it("ước tính Veo tính theo 8 giây khi có keyframe", async () => {
    const provider = new GoogleVideoProvider(config("google", { pricePerSecond: 0.05 }));
    const estimate = await provider.estimateCost(
      videoRequest({ referenceImagePath: keyframe("k1.png") }) as never,
    );
    // 4 x 0.05 = 0.20 se thap hon hoa don gap doi.
    expect(estimate.amount).toBeCloseTo(0.4, 6);
    expect(estimate.detail).toContain("bị ép thành 8s");
  });
});

// ------------------------------------------------------------ runway HTTP ---

describe("Runway HTTP", () => {
  it("gửi đúng header phiên bản API", async () => {
    behaviour = { createStatus: 200, createBody: { id: "t_abc", status: "PENDING" } };
    await createTask(config("runway"), {
      prompt: "x",
      seconds: 4,
      keyframePath: keyframe("k2.png"),
    });
    // Thieu header nay la loi cung, khong phai mac dinh.
    expect(lastHeaders["x-runway-version"]).toBe(RUNWAY_API_VERSION);
  });

  it("gửi keyframe dưới dạng data URI trong JSON", async () => {
    behaviour = { createStatus: 200, createBody: { id: "t_img", status: "PENDING" } };
    await createTask(config("runway"), {
      prompt: "x",
      seconds: 4,
      keyframePath: keyframe("k3.png"),
    });
    expect(lastBody).toContain("data:image/png;base64,");
    expect(lastBody).toContain('"ratio":"720:1280"');
    expect(lastBody).toContain('"duration":5');
  });

  it("KHÔNG tự gửi lại khi lỗi", async () => {
    behaviour = { createStatus: 500, createBody: { error: "boom" } };
    await expect(
      createTask(config("runway"), {
        prompt: "x",
        seconds: 4,
        keyframePath: keyframe("k4.png"),
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(createCount).toBe(1);
  });

  it("nhận đúng trạng thái kết thúc", () => {
    expect(runwayTerminal("SUCCEEDED")).toBe("ok");
    expect(runwayTerminal("FAILED")).toBe("failed");
    expect(runwayTerminal("RUNNING")).toBeNull();
  });

  it("đọc tiến độ 0-1 thành phần trăm", async () => {
    behaviour = {
      createStatus: 200,
      createBody: {},
      taskBody: { id: "t1", status: "RUNNING", progress: 0.42 },
    };
    const task = await getTask(config("runway"), "t1");
    expect(task.progress).toBe(42);
  });

  it("KHÔNG gửi API key tới máy chủ tải tệp", async () => {
    behaviour = { createStatus: 200, createBody: {}, outputBody: MP4 };
    const target = path.join(tempDir, `dl-${Date.now()}.mp4`);
    await downloadTaskOutput(config("runway"), `${baseUrl}/download/x`, target);
    // Tep ket qua nam tren CDN, gui key toi do la de lo key khong can thiet.
    expect(lastHeaders.authorization).toBeUndefined();
    expect(fs.existsSync(target)).toBe(true);
  });

  it("từ chối ghi đè tệp đã có", async () => {
    behaviour = { createStatus: 200, createBody: {}, outputBody: MP4 };
    const target = path.join(tempDir, "runway-ton-tai.mp4");
    fs.writeFileSync(target, "da tra tien");
    await expect(
      downloadTaskOutput(config("runway"), `${baseUrl}/download/x`, target),
    ).rejects.toMatchObject({ code: "output_exists" });
  });

  it("bắt buộc có keyframe vì endpoint không có chế độ text-only", async () => {
    const provider = new RunwayVideoProvider(config("runway"));
    await expect(
      provider.createVideo(videoRequest() as never),
    ).rejects.toMatchObject({ code: "keyframe_required" });
  });

  it("chuyển data URI đúng loại MIME", () => {
    expect(toDataUri(keyframe("k5.png"))).toContain("data:image/png;base64,");
  });
});

// ------------------------------------------------------------ google HTTP ---

describe("Google Veo HTTP", () => {
  it("dùng header x-goog-api-key, không phải bearer token", async () => {
    behaviour = { createStatus: 200, createBody: { name: "operations/abc" } };
    await createOperation(config("google"), { prompt: "x", seconds: 4 });
    expect(lastHeaders["x-goog-api-key"]).toBe("test-key-not-a-real-secret");
    expect(lastHeaders.authorization).toBeUndefined();
  });

  it("tắt âm thanh do Veo tự sinh", async () => {
    behaviour = { createStatus: 200, createBody: { name: "operations/abc" } };
    await createOperation(config("google"), { prompt: "x", seconds: 4 });
    // Pipeline nay tu lam giong noi; am thanh cua Veo se bi tra tien roi bo di.
    expect(lastBody).toContain('"generateAudio":false');
    expect(lastBody).toContain('"aspectRatio":"9:16"');
  });

  it("gọi đúng endpoint predictLongRunning", async () => {
    behaviour = { createStatus: 200, createBody: { name: "operations/abc" } };
    await createOperation(config("google"), { prompt: "x", seconds: 4 });
    expect(lastUrl).toContain("predictLongRunning");
  });

  it("KHÔNG tự gửi lại khi lỗi", async () => {
    behaviour = { createStatus: 500, createBody: { error: { message: "boom" } } };
    await expect(
      createOperation(config("google"), { prompt: "x", seconds: 4 }),
    ).rejects.toMatchObject({ retryable: false });
    expect(createCount).toBe(1);
  });

  it("thiếu tên operation thì báo lỗi rõ ràng", async () => {
    behaviour = { createStatus: 200, createBody: { done: false } };
    await expect(
      createOperation(config("google"), { prompt: "x", seconds: 4 }),
    ).rejects.toMatchObject({ code: "missing_job_id" });
  });

  it("đọc được operation đã xong và lấy URI video", async () => {
    behaviour = {
      createStatus: 200,
      createBody: {},
      taskBody: {
        name: "operations/abc",
        done: true,
        response: { generatedVideos: [{ video: { uri: "https://files/x" } }] },
      },
    };
    const op = await getOperation(config("google"), "operations/abc");
    expect(op.done).toBe(true);
    expect(op.videoUri).toBe("https://files/x");
  });

  it("chưa xong thì từ chối tải về thay vì trả tệp rỗng", async () => {
    behaviour = {
      createStatus: 200,
      createBody: { name: "operations/xyz" },
      taskBody: { name: "operations/xyz", done: false },
    };
    const provider = new GoogleVideoProvider(config("google"));
    const job = await provider.createVideo(
      videoRequest({ referenceImagePath: keyframe("k6.png") }) as never,
    );
    await expect(provider.downloadResult(job.externalId)).rejects.toMatchObject({
      code: "result_not_ready",
    });
  });
});

// ------------------------------------------------------------- mock gating ---

describe("Mock Mode chặn cả hai nhà cung cấp mới", () => {
  it("trả về provider giả lập khi bật mock", async () => {
    process.env.AI_MOCK_MODE = "true";
    resetEnvCache();
    expect(isMockMode()).toBe(true);

    for (const name of ["runway", "google"]) {
      const provider = await getVideoProvider(name, "bat-ky");
      expect(provider.getName()).toBe("mock");
    }
  });

  it("từ chối nhà cung cấp video chưa tích hợp khi tắt mock", async () => {
    process.env.AI_MOCK_MODE = "false";
    resetEnvCache();
    await expect(getVideoProvider("kling", "x")).rejects.toMatchObject({
      code: "provider_not_implemented",
    });
    process.env.AI_MOCK_MODE = "true";
    resetEnvCache();
  });
});
