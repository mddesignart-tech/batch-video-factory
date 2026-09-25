import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chatCompletion,
  classifyHttpError,
  MAX_ATTEMPTS,
  type OpenAICompatibleConfig,
} from "@/providers/openai/openai-client";
import {
  estimateTokens,
  OpenAICompatibleTextProvider,
} from "@/providers/openai/openai-text-provider";
import { ProviderError } from "@/providers/types";
import { prisma } from "@/lib/prisma";
import { resetEnvCache } from "@/lib/env";
import {
  assertCanSpend,
  canEnableModel,
  confirmProvider,
  ProviderNotConfirmedError,
  revokeProvider,
  setSpendCap,
  spendStatus,
  SpendCapExceededError,
  totalRealSpend,
} from "@/services/spend-guard";

/**
 * Real text provider, tested against a local stub of the Chat Completions API.
 *
 * A stub rather than the real thing on purpose: this exercises the entire HTTP
 * path - request shape, token accounting, cost maths, error classification,
 * retry limits, JSON repair - for $0.00 and with no network. What it cannot
 * prove is that a specific vendor behaves as documented; that needs a real key
 * and is called out as untested in the report.
 */

// ------------------------------------------------------------------- stub ---

interface StubBehaviour {
  status: number;
  body: unknown;
  /** Fail this many times before succeeding. */
  failFirst?: number;
  delayMs?: number;
  headers?: Record<string, string>;
}

let server: http.Server;
let baseUrl = "";
let behaviour: StubBehaviour;
let requestCount = 0;
let lastRequest: { headers: http.IncomingHttpHeaders; body: string } | null = null;

function okBody(content: string, promptTokens = 100, completionTokens = 200) {
  return {
    model: "stub-model",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

const VALID_SCRIPT = JSON.stringify({
  idiom: "Break a leg",
  title: "He Took It Literally",
  hook: "My friend said break a leg.",
  meaning: "Good luck",
  exampleSentence: "Break a leg on your interview!",
  durationTarget: 25,
  angleKey: "panic",
  scenes: [
    { sceneNumber: 1, duration: 3, visualDescription: "Max looks shocked" },
    { sceneNumber: 2, duration: 5, visualDescription: "Max panics" },
    { sceneNumber: 3, duration: 5, visualDescription: "Leo facepalms" },
    { sceneNumber: 4, duration: 4, visualDescription: "Leo explains" },
  ],
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount++;
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      lastRequest = { headers: req.headers, body };

      const shouldFail =
        behaviour.failFirst !== undefined && requestCount <= behaviour.failFirst;
      const status = shouldFail ? behaviour.status : 200;
      const payload = shouldFail ? behaviour.body : behaviour.body;

      const send = () => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          ...(behaviour.headers ?? {}),
        });
        res.end(JSON.stringify(payload));
      };
      if (behaviour.delayMs) setTimeout(send, behaviour.delayMs);
      else send();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function config(over: Partial<OpenAICompatibleConfig> = {}): OpenAICompatibleConfig {
  return {
    providerName: "stub",
    model: "stub-model",
    apiKey: "fake-api-key-for-test-only",
    baseUrl,
    requiresKey: true,
    // Deliberately non-round so a maths error is obvious rather than plausible.
    pricePer1kInput: 0.01,
    pricePer1kOutput: 0.03,
    maxOutputTokens: 2500,
    timeoutMs: 5000,
    ...over,
  };
}

function reset(b: StubBehaviour) {
  behaviour = b;
  requestCount = 0;
  lastRequest = null;
}

// ------------------------------------------------------------------ tests ---

describe("phân loại lỗi HTTP", () => {
  it("không thử lại khi API key sai", () => {
    for (const status of [401, 403]) {
      const c = classifyHttpError(status);
      expect(c.retryable, `status ${status}`).toBe(false);
      expect(c.code).toBe("auth_failed");
    }
  });

  it("không thử lại khi yêu cầu sai định dạng", () => {
    expect(classifyHttpError(400).retryable).toBe(false);
    expect(classifyHttpError(422).retryable).toBe(false);
  });

  it("không thử lại khi không tìm thấy model hoặc hết hạn mức", () => {
    expect(classifyHttpError(404).retryable).toBe(false);
    expect(classifyHttpError(402).retryable).toBe(false);
    expect(classifyHttpError(402).code).toBe("insufficient_quota");
  });

  it("có thử lại khi bị giới hạn tần suất hoặc lỗi máy chủ", () => {
    expect(classifyHttpError(429).retryable).toBe(true);
    expect(classifyHttpError(500).retryable).toBe(true);
    expect(classifyHttpError(503).retryable).toBe(true);
  });

  it("thông báo bằng tiếng Việt để người dùng biết phải làm gì", () => {
    expect(classifyHttpError(401).message).toMatch(/API key/i);
    expect(classifyHttpError(404).message).toMatch(/model/i);
  });
});

describe("gọi API thành công", () => {
  it("gửi đúng dạng yêu cầu và đọc được token", async () => {
    reset({ status: 200, body: okBody(VALID_SCRIPT, 1234, 567) });

    const result = await chatCompletion(config(), {
      messages: [{ role: "user", content: "xin chào" }],
      temperature: 0.5,
      jsonMode: true,
      purpose: "test",
    });

    expect(result.inputTokens).toBe(1234);
    expect(result.outputTokens).toBe(567);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(requestCount).toBe(1);

    const sent = JSON.parse(lastRequest!.body) as Record<string, unknown>;
    expect(sent.model).toBe("stub-model");
    expect(sent.temperature).toBe(0.5);
    expect(sent.response_format).toEqual({ type: "json_object" });
  });

  it("gửi API key trong header Authorization, không nằm trong body hay URL", async () => {
    reset({ status: 200, body: okBody(VALID_SCRIPT) });
    await chatCompletion(config({ apiKey: "sk-secret-abc123" }), {
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      jsonMode: false,
      purpose: "test",
    });

    expect(lastRequest!.headers.authorization).toBe("Bearer sk-secret-abc123");
    // The key must never appear in anything we might later store or log.
    expect(lastRequest!.body).not.toContain("sk-secret-abc123");
  });

  it("không gửi Authorization khi chạy model cục bộ không cần key", async () => {
    reset({ status: 200, body: okBody(VALID_SCRIPT) });
    await chatCompletion(config({ apiKey: "", requiresKey: false }), {
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      jsonMode: false,
      purpose: "test",
    });
    expect(lastRequest!.headers.authorization).toBeUndefined();
  });
});

describe("thử lại có giới hạn", () => {
  it("thử lại khi bị 429 rồi thành công", async () => {
    reset({
      status: 429,
      body: okBody(VALID_SCRIPT),
      failFirst: 1,
      headers: { "retry-after": "0" },
    });

    const result = await chatCompletion(config(), {
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      jsonMode: false,
      purpose: "test",
    });

    expect(result.content).toContain("Break a leg");
    expect(requestCount).toBe(2);
  });

  it("KHÔNG thử lại khi key sai - gửi lại chỉ tốn tiền vô ích", async () => {
    reset({
      status: 401,
      body: { error: { message: "Invalid API key" } },
      failFirst: 99,
    });

    await expect(
      chatCompletion(config(), {
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
        jsonMode: false,
        purpose: "test",
      }),
    ).rejects.toThrow(ProviderError);

    expect(requestCount).toBe(1);
  });

  it("dừng sau đúng số lần thử tối đa, không lặp vô hạn", async () => {
    reset({
      status: 500,
      body: { error: { message: "boom" } },
      failFirst: 99,
      headers: { "retry-after": "0" },
    });

    await expect(
      chatCompletion(config(), {
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
        jsonMode: false,
        purpose: "test",
      }),
    ).rejects.toThrow();

    expect(requestCount).toBe(MAX_ATTEMPTS);
  });

  it("lỗi SAU khi đã bị tính phí vẫn mang theo chi phí - nếu không tiền sẽ biến mất", async () => {
    // Phản hồi rỗng và phản hồi bị cắt đều xảy ra SAU khi nhà cung cấp đã tính
    // tiền. Ném lỗi mà không kèm usage là đánh mất khoản chi thật.
    reset({
      status: 200,
      body: {
        model: "stub-model",
        choices: [{ message: { content: "" }, finish_reason: "length" }],
        usage: { prompt_tokens: 500, completion_tokens: 40 },
      },
    });

    let caught: unknown;
    try {
      await chatCompletion(config(), {
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
        jsonMode: false,
        purpose: "test",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    const usage = (caught as InstanceType<typeof ProviderError>).usage;
    expect(usage).toBeDefined();
    expect(usage?.inputTokens).toBe(500);
    expect(usage?.outputTokens).toBe(40);
    // 500 vào x $0.01/1k + 40 ra x $0.03/1k = $0.0062
    expect(usage?.actualCost).toBeCloseTo(0.0062, 6);
  });

  it("báo lỗi rõ ràng khi phản hồi bị cắt do chạm giới hạn token", async () => {
    reset({
      status: 200,
      body: {
        model: "stub-model",
        choices: [{ message: { content: "{\"a\":" }, finish_reason: "length" }],
        usage: { prompt_tokens: 10, completion_tokens: 2500 },
      },
    });

    await expect(
      chatCompletion(config(), {
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
        jsonMode: true,
        purpose: "test",
      }),
    ).rejects.toThrow(/bị cắt/);
  });

  it("coi phản hồi rỗng là lỗi thay vì để lọt xuống bộ phân tích JSON", async () => {
    reset({ status: 200, body: okBody("   "), failFirst: 0 });
    await expect(
      chatCompletion(config(), {
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
        jsonMode: false,
        purpose: "test",
      }),
    ).rejects.toThrow(/rỗng/);
  });
});

describe("tính chi phí thật từ token", () => {
  const request = {
    idiom: "Break a leg",
    meaning: "Good luck",
    literalMeaning: "He wraps his leg in a giant cartoon bandage.",
    exampleSentence: "Break a leg!",
    targetDuration: 25,
    stylePrompt: "3D cartoon",
    characters: [{ name: "Max", personality: "naive", visualPrompt: "yellow hoodie" }],
    avoidAngles: [],
    model: "stub-model",
    systemPrompt: "viết kịch bản",
  };

  it("tính tiền theo token nhà cung cấp báo về, không theo ước tính", async () => {
    reset({ status: 200, body: okBody(VALID_SCRIPT, 1000, 1000) });
    const provider = new OpenAICompatibleTextProvider(config());

    const { script, usage } = await provider.generateScript(request);

    expect(script.idiom).toBe("Break a leg");
    expect(usage.inputTokens).toBe(1000);
    expect(usage.outputTokens).toBe(1000);
    // 1000 token vào x $0.01/1k + 1000 token ra x $0.03/1k = $0.04
    expect(usage.actualCost).toBeCloseTo(0.04, 6);
  });

  it("báo chi phí 0 khi nhà cung cấp không trả về số liệu token", async () => {
    reset({
      status: 200,
      body: {
        model: "local",
        choices: [{ message: { content: VALID_SCRIPT }, finish_reason: "stop" }],
      },
    });
    const provider = new OpenAICompatibleTextProvider(config());
    const { usage } = await provider.generateScript(request);

    expect(usage.inputTokens).toBeNull();
    // Refuses to invent a charge it cannot substantiate.
    expect(usage.actualCost).toBe(0);
  });

  it("ước tính trước khi gọi là chặn trên, không phải phỏng đoán", async () => {
    const provider = new OpenAICompatibleTextProvider(config());
    const estimate = await provider.estimateScriptCost(request);
    // maxOutputTokens (2500) là trần, nên ước tính phải >= chi phí thật thường gặp.
    expect(estimate.amount).toBeGreaterThan(0.03 * 2.5 - 0.001);
    expect(estimate.unit).toBe("per_1k_tokens");
  });

  it("đếm token xấp xỉ theo độ dài văn bản", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("")).toBe(1);
  });
});

describe("sửa JSON hỏng từ model thật", () => {
  const request = {
    idiom: "Break a leg",
    meaning: "Good luck",
    literalMeaning: "cartoon bandage",
    exampleSentence: "Break a leg!",
    targetDuration: 25,
    stylePrompt: "3D cartoon",
    characters: [],
    avoidAngles: [],
    model: "stub-model",
    systemPrompt: "viết kịch bản",
  };

  it("đọc được khi model bọc JSON trong code fence", async () => {
    reset({
      status: 200,
      body: okBody("```json\n" + VALID_SCRIPT + "\n```"),
    });
    const provider = new OpenAICompatibleTextProvider(config());
    const { script } = await provider.generateScript(request);
    expect(script.scenes).toHaveLength(4);
  });

  it("đọc được khi model thêm lời dẫn trước JSON", async () => {
    reset({
      status: 200,
      body: okBody("Đây là kịch bản của bạn:\n" + VALID_SCRIPT),
    });
    const provider = new OpenAICompatibleTextProvider(config());
    const { script } = await provider.generateScript(request);
    expect(script.title).toBe("He Took It Literally");
  });

  it("báo lỗi rõ ràng thay vì crash khi JSON không thể sửa", async () => {
    reset({ status: 200, body: okBody("đây không phải JSON gì cả") });
    const provider = new OpenAICompatibleTextProvider(config());
    await expect(provider.generateScript(request)).rejects.toThrow(
      /kịch bản JSON/i,
    );
  });
});

describe("chặn bật model chưa có giá", () => {
  it("từ chối model text chưa nhập cả giá input lẫn output", () => {
    const v = canEnableModel({
      provider: "openai",
      type: "text",
      price: 0,
      priceOutput: 0,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/giá/i);
  });

  it("cho phép khi đã nhập giá", () => {
    expect(
      canEnableModel({
        provider: "openai",
        type: "text",
        price: 0.00015,
        priceOutput: 0.0006,
      }).allowed,
    ).toBe(true);
  });

  it("cho phép model chạy cục bộ dù giá bằng 0 - vì thật sự miễn phí", () => {
    expect(
      canEnableModel({ provider: "ollama", type: "text", price: 0, priceOutput: 0 })
        .allowed,
    ).toBe(true);
  });

  it("không chặn model mock", () => {
    expect(
      canEnableModel({ provider: "mock", type: "text", price: 0, priceOutput: 0 })
        .allowed,
    ).toBe(true);
  });

  it("model không phải text chỉ cần giá input", () => {
    expect(
      canEnableModel({ provider: "runway", type: "video", price: 0.05, priceOutput: 0 })
        .allowed,
    ).toBe(true);
    expect(
      canEnableModel({ provider: "runway", type: "video", price: 0, priceOutput: 0 })
        .allowed,
    ).toBe(false);
  });
});

describe("hạn mức chi tiêu (spend guard)", () => {
  // The guard is a no-op while mock mode is on - correct in production, but it
  // means these tests must exercise the real path with mock mode off, which is
  // exactly the code that will run when the operator switches providers on.
  beforeAll(async () => {
    process.env.AI_MOCK_MODE = "false";
    resetEnvCache();
    await prisma.costEntry.deleteMany({});
    await setSpendCap(0.5);
    await revokeProvider("stub", "stub-model");
  });

  it("chặn khi nhà cung cấp chưa được xác nhận", async () => {
    await expect(
      assertCanSpend({ provider: "stub", model: "stub-model", estimatedCost: 0.01 }),
    ).rejects.toThrow(ProviderNotConfirmedError);
  });

  it("cho phép sau khi người dùng xác nhận", async () => {
    await confirmProvider("stub", "stub-model");
    const status = await assertCanSpend({
      provider: "stub",
      model: "stub-model",
      estimatedCost: 0.01,
    });
    expect(status.cap).toBe(0.5);
  });

  it("xác nhận có phạm vi theo từng model, không lan sang model khác", async () => {
    await expect(
      assertCanSpend({ provider: "stub", model: "model-dat-tien", estimatedCost: 0.01 }),
    ).rejects.toThrow(ProviderNotConfirmedError);
  });

  it("chặn khi yêu cầu sẽ làm vượt hạn mức", async () => {
    await expect(
      assertCanSpend({ provider: "stub", model: "stub-model", estimatedCost: 0.6 }),
    ).rejects.toThrow(SpendCapExceededError);
  });

  it("cộng dồn chi phí thật đã ghi nhận", async () => {
    await prisma.costEntry.create({
      data: {
        category: "text",
        provider: "stub",
        model: "stub-model",
        amount: 0.45,
        estimated: false,
      },
    });

    expect(await totalRealSpend()).toBeCloseTo(0.45, 4);

    // Còn $0.05; một yêu cầu $0.10 phải bị chặn.
    await expect(
      assertCanSpend({ provider: "stub", model: "stub-model", estimatedCost: 0.1 }),
    ).rejects.toThrow(SpendCapExceededError);
  });

  it("không tính chi phí mock vào hạn mức", async () => {
    const before = await totalRealSpend();
    await prisma.costEntry.create({
      data: {
        category: "text",
        provider: "mock",
        model: "mock-text-1",
        amount: 999,
        estimated: false,
      },
    });
    expect(await totalRealSpend()).toBeCloseTo(before, 4);
  });

  it("không tính ước tính vào hạn mức", async () => {
    const before = await totalRealSpend();
    await prisma.costEntry.create({
      data: {
        category: "text",
        provider: "stub",
        model: "stub-model",
        amount: 500,
        estimated: true,
      },
    });
    expect(await totalRealSpend()).toBeCloseTo(before, 4);
  });

  it("GIỮ lịch sử chi phí khi dự án bị xoá - tiền đã tiêu không được biến mất", async () => {
    // Nếu CostEntry cascade theo Project thì xoá dự án sẽ hoàn lại hạn mức một
    // cách sai trái, và người dùng có thể tiêu vượt bằng cách xoá dự án cũ.
    const idiom = await prisma.idiom.create({
      data: {
        phrase: "Spend guard fixture",
        slug: "spend-guard-fixture-" + Date.now(),
        meaning: "x",
        literalMeaning: "x",
        exampleSentence: "x",
        category: "Funny Expressions",
      },
    });
    const project = await prisma.project.create({
      data: { idiomId: idiom.id, title: "Sẽ bị xoá", maxBudget: 1 },
    });
    await prisma.costEntry.create({
      data: {
        projectId: project.id,
        category: "text",
        provider: "stub",
        model: "stub-model",
        amount: 0.02,
        estimated: false,
      },
    });

    const before = await totalRealSpend();
    await prisma.project.delete({ where: { id: project.id } });
    const after = await totalRealSpend();

    // Dòng chi phí vẫn còn, chỉ mất liên kết tới dự án.
    expect(after).toBeCloseTo(before, 6);
    const orphan = await prisma.costEntry.findFirst({
      where: { provider: "stub", amount: 0.02 },
    });
    expect(orphan).not.toBeNull();
    expect(orphan?.projectId).toBeNull();

    await prisma.costEntry.deleteMany({ where: { provider: "stub", amount: 0.02 } });
    await prisma.idiom.delete({ where: { id: idiom.id } });
  });

  it("báo cáo trạng thái chi tiêu cho giao diện", async () => {
    const status = await spendStatus();
    expect(status.cap).toBe(0.5);
    expect(status.spent).toBeCloseTo(0.45, 4);
    expect(status.remaining).toBeCloseTo(0.05, 4);
    expect(status.confirmedProviders).toContain("stub/stub-model");
  });

  it("không chặn gì khi Mock Mode đang bật - không có tiền nào để bảo vệ", async () => {
    process.env.AI_MOCK_MODE = "true";
    resetEnvCache();
    // Chưa xác nhận, ước tính vượt hạn mức, vậy mà vẫn qua: vì mock không tốn phí.
    await expect(
      assertCanSpend({ provider: "stub", model: "chua-xac-nhan", estimatedCost: 99 }),
    ).resolves.toBeDefined();
  });

  afterAll(async () => {
    process.env.AI_MOCK_MODE = "true";
    resetEnvCache();
    await prisma.costEntry.deleteMany({});
    await revokeProvider("stub", "stub-model");
  });
});
