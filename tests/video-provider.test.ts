import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createVideo,
  downloadVideo,
  getVideoJob,
  isTerminal,
  MAX_CREATE_ATTEMPTS,
  type OpenAIVideoConfig,
} from "@/providers/openai/openai-video-client";
import {
  clearVideoOutputs,
  OpenAIVideoProvider,
  prepareKeyframe,
} from "@/providers/openai/openai-video-provider";
import { parseSize, splitModelSize } from "@/providers/video-config";
import { ProviderError } from "@/providers/types";
import { isMockMode, resetEnvCache } from "@/lib/env";
import { getVideoProvider } from "@/providers/registry";
import { resolveFfmpeg } from "@/media/ffmpeg";
import { execFileSync } from "node:child_process";

/**
 * Real video provider, tested against a local stub of the Sora API.
 *
 * Video is the most expensive thing this app can buy, so the properties under
 * test here are mostly about money: a create is never retried automatically, a
 * timeout is reported as "may already have been billed", and a finished file is
 * never overwritten. All of it runs offline for $0.00.
 */

interface StubBehaviour {
  createStatus: number;
  createBody: unknown;
  jobBody?: unknown;
  contentStatus?: number;
  contentBody?: Buffer;
  /** Delay the create response, to exercise the timeout path. */
  createDelayMs?: number;
}

let server: http.Server;
let baseUrl = "";
let behaviour: StubBehaviour;
let createCount = 0;
let lastCreateBody = "";
let tempDir = "";

const MP4 = Buffer.from("ftypisom-not-a-real-mp4-but-nonzero", "latin1");

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown, json = true) => {
        res.writeHead(status, {
          "Content-Type": json ? "application/json" : "video/mp4",
        });
        res.end(json ? JSON.stringify(body) : (body as Buffer));
      };

      if (req.method === "POST" && url.endsWith("/videos")) {
        createCount++;
        lastCreateBody = Buffer.concat(chunks).toString("latin1");
        const reply = () => send(behaviour.createStatus, behaviour.createBody);
        if (behaviour.createDelayMs) setTimeout(reply, behaviour.createDelayMs);
        else reply();
        return;
      }
      if (url.includes("/content")) {
        const status = behaviour.contentStatus ?? 200;
        if (status !== 200) return send(status, { error: { message: "nope" } });
        return send(200, behaviour.contentBody ?? MP4, false);
      }
      if (url.includes("/videos/")) {
        return send(200, behaviour.jobBody ?? { id: "vid_1", status: "completed" });
      }
      send(404, { error: { message: "not found" } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-test-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  createCount = 0;
  lastCreateBody = "";
  clearVideoOutputs();
});

function config(overrides: Partial<OpenAIVideoConfig> = {}): OpenAIVideoConfig {
  return {
    providerName: "openai",
    model: "sora-2",
    apiKey: "test-key-not-a-real-secret",
    baseUrl,
    pricePerSecond: 0.1,
    size: "720x1280",
    timeoutMs: 3000,
    ...overrides,
  };
}

function out(name: string): string {
  return path.join(tempDir, name);
}

// ------------------------------------------------------------- pure logic ---

describe("tách model và kích thước", () => {
  it("tách hậu tố kích thước khỏi tên model", () => {
    expect(splitModelSize("sora-2:720x1280")).toEqual({
      apiModel: "sora-2",
      size: "720x1280",
    });
    expect(splitModelSize("sora-2-pro:1080x1920").size).toBe("1080x1920");
  });

  it("giữ nguyên tên khi hậu tố không phải kích thước", () => {
    expect(splitModelSize("vendor:model-x").apiModel).toBe("vendor:model-x");
  });

  it("từ chối kích thước vô nghĩa thay vì gửi đi rồi bị trả về", () => {
    expect(() => parseSize("abc")).toThrow();
    expect(parseSize("720x1280")).toEqual({ width: 720, height: 1280 });
  });

  it("nhận đúng trạng thái kết thúc của job", () => {
    expect(isTerminal("completed")).toBe("ok");
    expect(isTerminal("failed")).toBe("failed");
    expect(isTerminal("queued")).toBeNull();
    expect(isTerminal("in_progress")).toBeNull();
  });
});

// ------------------------------------------------------------------ create ---

describe("tạo job video", () => {
  it("gửi đúng model, kích thước và thời lượng", async () => {
    behaviour = {
      createStatus: 200,
      createBody: { id: "vid_abc", status: "queued" },
    };
    const job = await createVideo(config(), { prompt: "x", seconds: 4 });

    expect(job.id).toBe("vid_abc");
    expect(lastCreateBody).toContain("sora-2");
    expect(lastCreateBody).toContain("720x1280");
    expect(lastCreateBody).toContain("4");
  });

  it("gửi kèm ảnh keyframe khi có", async () => {
    behaviour = { createStatus: 200, createBody: { id: "vid_ref", status: "queued" } };
    const frame = out("frame.png");
    fs.writeFileSync(frame, Buffer.from("fake-png"));

    await createVideo(config(), {
      prompt: "x",
      seconds: 4,
      inputReferencePath: frame,
    });
    expect(lastCreateBody).toContain("input_reference");
    expect(lastCreateBody).toContain("frame.png");
  });

  it("KHÔNG BAO GIỜ tự gửi lại một yêu cầu tạo video", async () => {
    behaviour = { createStatus: 500, createBody: { error: { message: "boom" } } };
    await expect(createVideo(config(), { prompt: "x", seconds: 4 })).rejects.toBeInstanceOf(
      ProviderError,
    );
    // Đây là khác biệt lớn nhất so với text và ảnh: một lần gửi lại nhầm ở đây
    // là sai lầm tốn kém nhất hệ thống có thể mắc.
    expect(createCount).toBe(1);
    expect(MAX_CREATE_ATTEMPTS).toBe(1);
  });

  it("lỗi 500 cũng bị đánh dấu KHÔNG được thử lại tự động", async () => {
    behaviour = { createStatus: 500, createBody: { error: { message: "boom" } } };
    await expect(
      createVideo(config(), { prompt: "x", seconds: 4 }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("lỗi 401 dừng hẳn", async () => {
    behaviour = { createStatus: 401, createBody: { error: { message: "bad key" } } };
    await expect(
      createVideo(config(), { prompt: "x", seconds: 4 }),
    ).rejects.toMatchObject({ code: "auth_failed", retryable: false });
  });

  it("phản hồi 200 nhưng thiếu mã job thì báo lỗi rõ ràng", async () => {
    behaviour = { createStatus: 200, createBody: { status: "queued" } };
    await expect(
      createVideo(config(), { prompt: "x", seconds: 4 }),
    ).rejects.toMatchObject({ code: "missing_job_id" });
  });

  it("hết thời gian chờ thì cảnh báo CÓ THỂ đã bị tính phí và không gửi lại", async () => {
    behaviour = {
      createStatus: 200,
      createBody: { id: "vid_slow", status: "queued" },
      createDelayMs: 500,
    };
    const err = await createVideo(config({ timeoutMs: 80 }), {
      prompt: "x",
      seconds: 4,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("create_timeout");
    // Thông báo phải nói thẳng là job có thể đã tồn tại, nếu không người vận
    // hành sẽ bấm lại và trả tiền lần hai.
    expect((err as ProviderError).message).toContain("có thể đã được tạo");
    expect(createCount).toBe(1);
  });

  it("không bao giờ đặt API key vào URL", async () => {
    behaviour = { createStatus: 200, createBody: { id: "v", status: "queued" } };
    await createVideo(config(), { prompt: "x", seconds: 4 });
    expect(lastCreateBody).not.toContain("test-key-not-a-real-secret");
  });
});

// -------------------------------------------------------------- poll/fetch ---

describe("theo dõi và tải kết quả", () => {
  it("đọc được trạng thái job", async () => {
    behaviour = {
      createStatus: 200,
      createBody: {},
      jobBody: { id: "vid_1", status: "in_progress", progress: 42 },
    };
    const job = await getVideoJob(config(), "vid_1");
    expect(job.status).toBe("in_progress");
    expect(job.progress).toBe(42);
  });

  it("tải tệp về đĩa", async () => {
    behaviour = { createStatus: 200, createBody: {}, contentBody: MP4 };
    const target = out("clip.mp4");
    const bytes = await downloadVideo(config(), "vid_1", target);
    expect(bytes).toBe(MP4.byteLength);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("TỪ CHỐI ghi đè tệp đã có", async () => {
    behaviour = { createStatus: 200, createBody: {}, contentBody: MP4 };
    const target = out("khong-duoc-ghi-de.mp4");
    fs.writeFileSync(target, "video cu da tra tien");

    await expect(downloadVideo(config(), "vid_1", target)).rejects.toMatchObject({
      code: "output_exists",
    });
    // Tài sản đã trả tiền không được mất vì một lần chạy lại.
    expect(fs.readFileSync(target, "utf8")).toBe("video cu da tra tien");
  });

  it("tệp rỗng bị coi là lỗi, không phải thành công", async () => {
    behaviour = {
      createStatus: 200,
      createBody: {},
      contentBody: Buffer.alloc(0),
    };
    await expect(
      downloadVideo(config(), "vid_1", out("rong.mp4")),
    ).rejects.toMatchObject({ code: "empty_video" });
  });
});

// ---------------------------------------------------------------- provider ---

describe("OpenAIVideoProvider", () => {
  it("ước tính theo giây và theo giá trong bảng model", async () => {
    const provider = new OpenAIVideoProvider(config({ pricePerSecond: 0.1 }));
    const estimate = await provider.estimateCost({
      projectId: "p",
      sceneId: "s",
      model: "sora-2:720x1280",
      prompt: "x",
      negativePrompt: "",
      durationSeconds: 4,
      width: 720,
      height: 1280,
      fps: 30,
      outputPath: out("a.mp4"),
    });
    expect(estimate.amount).toBeCloseTo(0.4, 6);
    expect(estimate.unit).toBe("per_second");
  });

  it("báo thiếu key mà không tiết lộ key", async () => {
    const provider = new OpenAIVideoProvider(config({ apiKey: "" }));
    expect(await provider.checkStatus()).toBe("missing_key");
  });

  it("ghi nhận ĐÚNG chi phí khi tải về, không phải $0", async () => {
    // Lỗi thật đã xảy ra: API tính tiền lúc TẠO nhưng pipeline ghi sổ lúc TẢI
    // VỀ. Trả 0 ở đây làm khoản $0.40 biến mất khỏi sổ và hạn mức tự hoàn lại.
    behaviour = {
      createStatus: 200,
      createBody: { id: "vid_cost", status: "queued" },
      contentBody: MP4,
    };
    const provider = new OpenAIVideoProvider(config({ pricePerSecond: 0.1 }));
    const target = out(`cost-${Date.now()}.mp4`);

    const job = await provider.createVideo({
      projectId: "p",
      sceneId: "s",
      model: "sora-2:720x1280",
      prompt: "x",
      negativePrompt: "",
      durationSeconds: 4,
      width: 720,
      height: 1280,
      fps: 30,
      outputPath: target,
    });
    expect(job.estimatedCost).toBeCloseTo(0.4, 6);

    const asset = await provider.downloadResult(job.externalId);
    expect(asset.actualCost).toBeCloseTo(0.4, 6);
  });

  it("từ chối tải về khi không biết ghi vào đâu", async () => {
    const provider = new OpenAIVideoProvider(config());
    await expect(provider.downloadResult("vid_khong_biet")).rejects.toMatchObject({
      code: "unknown_output_path",
    });
  });

  it("cắt keyframe về đúng kích thước video", () => {
    // Ảnh 2:3 phải thành 720x1280 trước khi gửi: API từ chối nếu lệch.
    const source = out("source-1024x1536.png");
    const binary = resolveFfmpeg();
    if (!binary) return;

    execFileSync(binary, [
      "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1024x1536",
      "-frames:v", "1", "-y", source,
    ]);

    const prepared = prepareKeyframe(source, "720x1280");
    expect(fs.existsSync(prepared.path)).toBe(true);

    // Doc lai so byte tho: 720 x 1280 x 3 kenh mau la bang chung kich thuoc.
    const size = execFileSync(
      binary,
      ["-v", "error", "-i", prepared.path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { maxBuffer: 1024 * 1024 * 64 },
    );
    expect(size.length).toBe(720 * 1280 * 3);
    fs.rmSync(path.dirname(prepared.path), { recursive: true, force: true });
  });
});

// ------------------------------------------------------------- mock gating ---

describe("Mock Mode là cổng chặn cứng cho video", () => {
  it("trả về provider giả lập khi bật mock, dù gọi tên nhà cung cấp thật", async () => {
    process.env.AI_MOCK_MODE = "true";
    resetEnvCache();
    expect(isMockMode()).toBe(true);

    const provider = await getVideoProvider("openai", "sora-2:720x1280");
    expect(provider.getName()).toBe("mock");
  });

  it("từ chối rõ ràng nhà cung cấp video chưa tích hợp khi tắt mock", async () => {
    process.env.AI_MOCK_MODE = "false";
    resetEnvCache();
    // Runway va Google gio da co adapter, nen vi du phai la mot ten khac.
    await expect(
      getVideoProvider("kling", "bat-ky-model-nao"),
    ).rejects.toMatchObject({ code: "provider_not_implemented" });

    process.env.AI_MOCK_MODE = "true";
    resetEnvCache();
  });
});
