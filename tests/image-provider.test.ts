import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createImage,
  MAX_IMAGE_ATTEMPTS,
  MAX_REFERENCES_SENT,
  mergeNegative,
  nearestSize,
  type OpenAIImageConfig,
} from "@/providers/openai/openai-image-client";
import {
  clearFinishedImages,
  OpenAIImageProvider,
} from "@/providers/openai/openai-image-provider";
import { splitModelTier } from "@/providers/image-config";
import {
  estimateImageBatchCost,
  imagePolicyFor,
} from "@/services/image-quality";
import { ProviderError } from "@/providers/types";
import { isMockMode, resetEnvCache } from "@/lib/env";
import { getImageProvider } from "@/providers/registry";

/**
 * Real image provider, tested against a local stub of the Images API.
 *
 * Same reasoning as the text provider tests: this exercises the whole HTTP
 * path - endpoint selection, multipart reference upload, size mapping, error
 * classification, retry limits, cost accounting - for $0.00 and with no
 * network. What it cannot prove is that the vendor draws a good picture.
 */

// ------------------------------------------------------------------- stub ---

interface StubBehaviour {
  status: number;
  body: unknown;
  failFirst?: number;
  headers?: Record<string, string>;
}

/** A 1x1 PNG, base64. Small enough to inline, real enough to write to disk. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let server: http.Server;
let baseUrl = "";
let behaviour: StubBehaviour;
let requestCount = 0;
let lastRequest: { url: string; contentType: string; body: Buffer } | null = null;

function okBody() {
  return {
    data: [{ b64_json: TINY_PNG_B64 }],
    usage: { input_tokens: 40, output_tokens: 1200 },
  };
}

let tempDir = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount++;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      lastRequest = {
        url: req.url ?? "",
        contentType: String(req.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks),
      };
      const shouldFail =
        behaviour.failFirst !== undefined && requestCount <= behaviour.failFirst;
      res.writeHead(shouldFail ? behaviour.status : 200, {
        "Content-Type": "application/json",
        ...(behaviour.headers ?? {}),
      });
      res.end(JSON.stringify(behaviour.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-test-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  requestCount = 0;
  lastRequest = null;
  clearFinishedImages();
});

function config(overrides: Partial<OpenAIImageConfig> = {}): OpenAIImageConfig {
  return {
    providerName: "openai",
    model: "gpt-image-1",
    quality: "medium",
    apiKey: "test-key-not-a-real-secret",
    baseUrl,
    pricePerImage: 0.063,
    pricePerMillionOutputTokens: 0,
    supportsInputFidelity: true,
    timeoutMs: 5000,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "Max looks shocked",
    negativePrompt: "watermark, extra fingers",
    width: 1080,
    height: 1920,
    referenceImages: [] as string[],
    purpose: "test",
    ...overrides,
  };
}

// ------------------------------------------------------------- pure logic ---

describe("chọn kích thước và ghép prompt", () => {
  it("ánh xạ 9:16 về khổ dọc mà API chấp nhận", () => {
    expect(nearestSize(1080, 1920)).toBe("1024x1536");
  });

  it("ánh xạ khổ vuông và khổ ngang", () => {
    expect(nearestSize(1024, 1024)).toBe("1024x1024");
    expect(nearestSize(1920, 1080)).toBe("1536x1024");
  });

  it("không trả về kích thước lạ khi số đo vô nghĩa", () => {
    expect(nearestSize(0, 0)).toBe("1024x1536");
    expect(nearestSize(-5, 10)).toBe("1024x1536");
  });

  it("gộp prompt phủ định vào prompt chính vì API không có trường riêng", () => {
    expect(mergeNegative("a cat", "blurry")).toContain("Avoid: blurry.");
    // Không có gì để tránh thì không thêm câu thừa.
    expect(mergeNegative("a cat", "   ")).toBe("a cat");
  });
});

describe("tách tầng chất lượng khỏi tên model", () => {
  it("tách hậu tố thành tham số quality", () => {
    expect(splitModelTier("gpt-image-1:high")).toEqual({
      apiModel: "gpt-image-1",
      quality: "high",
    });
  });

  it("giữ nguyên tên khi không có hậu tố hợp lệ", () => {
    expect(splitModelTier("gpt-image-1")).toEqual({
      apiModel: "gpt-image-1",
      quality: "medium",
    });
    // Dấu hai chấm không phải tầng chất lượng thì không được cắt mất.
    expect(splitModelTier("vendor:model-x").apiModel).toBe("vendor:model-x");
  });
});

// --------------------------------------------------------------- HTTP path ---

describe("gọi API tạo ảnh", () => {
  it("dùng /images/generations khi không có ảnh tham chiếu", async () => {
    behaviour = { status: 200, body: okBody() };
    const result = await createImage(config(), request());

    expect(lastRequest?.url).toBe("/v1/images/generations");
    expect(lastRequest?.contentType).toContain("application/json");
    expect(result.usedReferences).toBe(false);
    expect(result.size).toBe("1024x1536");
    expect(result.data.byteLength).toBeGreaterThan(0);
  });

  it("chuyển sang /images/edits khi có ảnh tham chiếu, và gửi kèm tệp", async () => {
    behaviour = { status: 200, body: okBody() };
    const reference = path.join(tempDir, "max-master.png");
    fs.writeFileSync(reference, Buffer.from(TINY_PNG_B64, "base64"));

    const result = await createImage(
      config(),
      request({ referenceImages: [reference] }),
    );

    expect(lastRequest?.url).toBe("/v1/images/edits");
    expect(lastRequest?.contentType).toContain("multipart/form-data");
    expect(result.usedReferences).toBe(true);

    const body = lastRequest?.body.toString("latin1") ?? "";
    expect(body).toContain("max-master.png");
    // input_fidelity là thứ giữ khuôn mặt nhân vật không bị vẽ lại.
    expect(body).toContain("input_fidelity");
    expect(body).toContain("high");
  });

  it("KHÔNG gửi input_fidelity cho model không nhận tham số đó", async () => {
    // gpt-image-2 trả 400 nếu thấy tham số này. Gửi mù sẽ làm hỏng đúng loại
    // yêu cầu quan trọng nhất: mọi cảnh có ảnh tham chiếu.
    behaviour = { status: 200, body: okBody() };
    const reference = path.join(tempDir, "ref-fidelity.png");
    fs.writeFileSync(reference, Buffer.from(TINY_PNG_B64, "base64"));

    const result = await createImage(
      config({ supportsInputFidelity: false }),
      request({ referenceImages: [reference] }),
    );

    // Vẫn dùng endpoint có ảnh tham chiếu - chỉ bỏ riêng tham số kia.
    expect(result.usedReferences).toBe(true);
    expect(lastRequest?.url).toBe("/v1/images/edits");
    const body = lastRequest?.body.toString("latin1") ?? "";
    expect(body).toContain("ref-fidelity.png");
    expect(body).not.toContain("input_fidelity");
  });

  it("bỏ qua ảnh tham chiếu không tồn tại thay vì làm hỏng cả lần tạo", async () => {
    behaviour = { status: 200, body: okBody() };
    const result = await createImage(
      config(),
      request({ referenceImages: [path.join(tempDir, "khong-ton-tai.png")] }),
    );
    // Không có tệp hợp lệ nào nên quay về endpoint không tham chiếu.
    expect(result.usedReferences).toBe(false);
    expect(lastRequest?.url).toBe("/v1/images/generations");
  });

  it("không gửi quá số ảnh tham chiếu cho phép", async () => {
    behaviour = { status: 200, body: okBody() };
    const many: string[] = [];
    for (let i = 0; i < MAX_REFERENCES_SENT + 3; i++) {
      const p = path.join(tempDir, `ref-${i}.png`);
      fs.writeFileSync(p, Buffer.from(TINY_PNG_B64, "base64"));
      many.push(p);
    }
    await createImage(config(), request({ referenceImages: many }));

    const body = lastRequest?.body.toString("latin1") ?? "";
    const sent = (body.match(/filename="ref-\d+\.png"/g) ?? []).length;
    expect(sent).toBe(MAX_REFERENCES_SENT);
  });

  it("không bao giờ đặt API key vào URL", async () => {
    behaviour = { status: 200, body: okBody() };
    await createImage(config(), request());
    expect(lastRequest?.url).not.toContain("test-key-not-a-real-secret");
  });
});

// ------------------------------------------------------------------ errors ---

describe("phân loại lỗi và giới hạn thử lại", () => {
  it("không thử lại lỗi 401 vì gửi lại cũng hỏng y hệt", async () => {
    behaviour = {
      status: 401,
      body: { error: { message: "Invalid key" } },
      failFirst: 99,
    };
    await expect(createImage(config(), request())).rejects.toMatchObject({
      retryable: false,
      code: "auth_failed",
    });
    expect(requestCount).toBe(1);
  });

  it("không thử lại lỗi 400", async () => {
    behaviour = { status: 400, body: { error: { message: "bad" } }, failFirst: 99 };
    await expect(createImage(config(), request())).rejects.toMatchObject({
      retryable: false,
    });
    expect(requestCount).toBe(1);
  });

  it("thử lại lỗi 500 nhưng dừng đúng hạn mức", async () => {
    behaviour = { status: 500, body: { error: { message: "oops" } }, failFirst: 99 };
    await expect(createImage(config(), request())).rejects.toBeInstanceOf(
      ProviderError,
    );
    // Mỗi lần thử là một lần có thể bị tính tiền, nên số lần phải chặn cứng.
    expect(requestCount).toBe(MAX_IMAGE_ATTEMPTS);
    expect(MAX_IMAGE_ATTEMPTS).toBeLessThan(3);
  });

  it("thành công sau khi lỗi tạm thời rồi hết lỗi", async () => {
    behaviour = { status: 500, body: okBody(), failFirst: 1 };
    const result = await createImage(config(), request());
    expect(result.data.byteLength).toBeGreaterThan(0);
    expect(requestCount).toBe(2);
  });

  it("phản hồi 200 nhưng không có ảnh thì không thử lại", async () => {
    behaviour = { status: 200, body: { data: [] } };
    await expect(createImage(config(), request())).rejects.toMatchObject({
      code: "empty_image",
      retryable: false,
    });
    // Đã bị tính tiền rồi; gửi lại y hệt chỉ tốn thêm tiền cho cùng kết quả.
    expect(requestCount).toBe(1);
  });
});

// ---------------------------------------------------------------- provider ---

describe("OpenAIImageProvider", () => {
  it("ghi tệp xuống đĩa và báo chi phí theo giá trong bảng model", async () => {
    behaviour = { status: 200, body: okBody() };
    const provider = new OpenAIImageProvider(config({ pricePerImage: 0.063 }));
    const outputPath = path.join(tempDir, "scene-1.png");

    const job = await provider.createImage({
      projectId: "p1",
      sceneId: "s1",
      model: "gpt-image-1:medium",
      prompt: "Max looks shocked",
      negativePrompt: "",
      width: 1080,
      height: 1920,
      referenceImages: [],
      outputPath,
    });

    expect(job.state).toBe("completed");
    expect(fs.existsSync(outputPath)).toBe(true);

    const asset = await provider.downloadResult(job.externalId);
    expect(asset.filePath).toBe(outputPath);
    expect(asset.actualCost).toBe(0.063);
    expect(asset.bytes).toBeGreaterThan(0);
    expect(asset.meta?.size).toBe("1024x1536");
  });

  it("giải phóng kết quả sau khi lấy về, không giữ lại trong bộ nhớ", async () => {
    behaviour = { status: 200, body: okBody() };
    const provider = new OpenAIImageProvider(config());
    const job = await provider.createImage({
      projectId: "p1",
      sceneId: "s2",
      model: "gpt-image-1:medium",
      prompt: "x",
      negativePrompt: "",
      width: 1024,
      height: 1536,
      referenceImages: [],
      outputPath: path.join(tempDir, "scene-2.png"),
    });

    await provider.downloadResult(job.externalId);
    await expect(provider.downloadResult(job.externalId)).rejects.toMatchObject({
      code: "missing_result",
    });
  });

  it("báo thiếu key mà không tiết lộ key", async () => {
    const provider = new OpenAIImageProvider(config({ apiKey: "" }));
    expect(await provider.checkStatus()).toBe("missing_key");
  });

  it("tính chi phí thật từ token API báo về khi có giá theo token", async () => {
    behaviour = { status: 200, body: okBody() };
    // okBody báo 1200 token ra; $30/1M => $0.036, khác hẳn giá ước tính $0.063.
    const provider = new OpenAIImageProvider(
      config({ pricePerImage: 0.063, pricePerMillionOutputTokens: 30 }),
    );
    const job = await provider.createImage({
      projectId: "p1",
      sceneId: "s3",
      model: "gpt-image-2:medium",
      prompt: "x",
      negativePrompt: "",
      width: 1024,
      height: 1536,
      referenceImages: [],
      outputPath: path.join(tempDir, "scene-3.png"),
    });
    const asset = await provider.downloadResult(job.externalId);
    expect(asset.actualCost).toBeCloseTo(0.036, 6);
  });

  it("quay về giá ước tính khi API không báo token, thay vì ghi nhận $0", async () => {
    behaviour = { status: 200, body: { data: [{ b64_json: TINY_PNG_B64 }] } };
    const provider = new OpenAIImageProvider(
      config({ pricePerImage: 0.063, pricePerMillionOutputTokens: 30 }),
    );
    const job = await provider.createImage({
      projectId: "p1",
      sceneId: "s4",
      model: "gpt-image-2:medium",
      prompt: "x",
      negativePrompt: "",
      width: 1024,
      height: 1536,
      referenceImages: [],
      outputPath: path.join(tempDir, "scene-4.png"),
    });
    const asset = await provider.downloadResult(job.externalId);
    // Ghi $0 sẽ làm tiền thật biến mất khỏi sổ và hạn mức tự hoàn lại.
    expect(asset.actualCost).toBe(0.063);
  });

  it("ước tính chi phí bằng đúng giá mỗi ảnh", async () => {
    const provider = new OpenAIImageProvider(config({ pricePerImage: 0.25 }));
    const estimate = await provider.estimateCost({
      projectId: "p",
      sceneId: "s",
      model: "gpt-image-1:high",
      prompt: "x",
      negativePrompt: "",
      width: 1080,
      height: 1920,
      referenceImages: [],
      outputPath: "x.png",
    });
    expect(estimate.amount).toBe(0.25);
    expect(estimate.unit).toBe("per_image");
  });
});

// ------------------------------------------------------------ quality mode ---

describe("chế độ chất lượng ảnh", () => {
  it("BALANCED là mặc định hợp lý: một ảnh, cho vẽ lại tối đa một lần", () => {
    const policy = imagePolicyFor("BALANCED");
    expect(policy.candidates).toBe(1);
    expect(policy.maxAutoRegenerate).toBe(1);
  });

  it("ECONOMY không bao giờ tự vẽ lại", () => {
    expect(imagePolicyFor("ECONOMY").maxAutoRegenerate).toBe(0);
  });

  it("mọi chế độ chỉ tự vẽ MỘT ảnh, nên ước tính không nhân đôi", () => {
    const counts = (["ECONOMY", "BALANCED", "QUALITY", "CUSTOM"] as const).map(
      (mode) =>
        estimateImageBatchCost({ mode, imageCount: 6, pricePerImage: 0.063 })
          .images,
    );
    // Ước tính hai ảnh trong khi code chỉ vẽ một sẽ báo thừa tiền và làm hạn
    // mức còn lại trông nhỏ hơn thực tế.
    expect(counts).toEqual([6, 6, 6, 6]);
  });

  it("QUALITY cho phép tạo phương án khác thủ công, không tự tạo", () => {
    const quality = imagePolicyFor("QUALITY");
    expect(quality.candidates).toBe(1);
    expect(quality.allowsManualAlternative).toBe(true);
    // Chế độ rẻ không mời gọi tiêu thêm tiền.
    expect(imagePolicyFor("ECONOMY").allowsManualAlternative).toBe(false);
  });

  it("ước tính khớp với giá nhân số lượng", () => {
    const est = estimateImageBatchCost({
      mode: "ECONOMY",
      imageCount: 4,
      pricePerImage: 0.016,
    });
    expect(est.total).toBeCloseTo(0.064, 6);
  });
});

// ------------------------------------------------------------- mock gating ---

describe("Mock Mode là cổng chặn cứng", () => {
  it("trả về provider giả lập khi bật mock, dù gọi tên nhà cung cấp thật", async () => {
    process.env.AI_MOCK_MODE = "true";
    resetEnvCache();
    expect(isMockMode()).toBe(true);

    const provider = await getImageProvider("openai", "gpt-image-1:medium");
    expect(provider.getName()).toBe("mock");
  });

  it("từ chối rõ ràng nhà cung cấp ảnh chưa tích hợp khi tắt mock", async () => {
    process.env.AI_MOCK_MODE = "false";
    resetEnvCache();
    await expect(
      getImageProvider("runway", "bat-ky-model-nao"),
    ).rejects.toMatchObject({ code: "provider_not_implemented" });

    process.env.AI_MOCK_MODE = "true";
    resetEnvCache();
  });
});
