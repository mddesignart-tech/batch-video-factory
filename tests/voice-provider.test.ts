import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSpeech,
  isKnownVoice,
  OPENAI_VOICES,
} from "@/providers/openai/openai-voice-client";
import {
  clearVoiceOutputs,
  OpenAIVoiceProvider,
} from "@/providers/openai/openai-voice-provider";
import {
  clampSpeed,
  FORMAT_EXTENSION,
  type VoiceModelConfig,
} from "@/providers/voice-config";
import { ProviderError } from "@/providers/types";

/**
 * Voice against a local fake server. Costs nothing, and covers the parts a real
 * call would not exercise cheaply: what lands in the request body, what happens
 * on each error class, and whether the cost that reaches the ledger is the real
 * one.
 */

let server: http.Server;
let baseUrl = "";
let lastBody: Record<string, unknown> = {};
let lastAuth = "";
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let tmpDir = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      lastAuth = String(req.headers.authorization ?? "");
      try {
        lastBody = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        lastBody = {};
      }
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-test-"));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  clearVoiceOutputs();
});

function config(over: Partial<VoiceModelConfig> = {}): VoiceModelConfig {
  return {
    providerName: "openai",
    model: "gpt-4o-mini-tts",
    apiKey: "sk-test-not-a-real-key",
    baseUrl,
    pricePer1kChars: 0.0006,
    supportsInstructions: true,
    format: "wav",
    timeoutMs: 5000,
    ...over,
  };
}

function outPath(name: string): string {
  return path.join(tmpDir, `${name}-${Math.random().toString(36).slice(2)}.wav`);
}

function okAudio(res: http.ServerResponse): void {
  res.writeHead(200, { "Content-Type": "audio/wav" });
  res.end(Buffer.from("RIFFfake-audio-bytes-for-testing"));
}

function req(over: Partial<Parameters<OpenAIVoiceProvider["createVoice"]>[0]> = {}) {
  return {
    projectId: "p",
    sceneId: "s",
    model: "gpt-4o-mini-tts",
    text: "Hello",
    voiceId: "echo",
    instructions: "",
    accent: "US" as const,
    gender: "male" as const,
    speed: 1,
    targetDuration: 5,
    outputPath: outPath("req"),
    ...over,
  };
}

describe("the request body", () => {
  it("sends model, text, voice, format and speed", async () => {
    handler = (_q, res) => okAudio(res);
    await createSpeech(
      config(),
      { text: "Hello", voiceId: "echo", instructions: "", speed: 1, format: "wav" },
      outPath("a"),
    );
    expect(lastBody.model).toBe("gpt-4o-mini-tts");
    expect(lastBody.input).toBe("Hello");
    expect(lastBody.voice).toBe("echo");
    expect(lastBody.response_format).toBe("wav");
    expect(lastBody.speed).toBe(1);
  });

  it("sends instructions when the model supports them", async () => {
    handler = (_q, res) => okAudio(res);
    await createSpeech(
      config(),
      {
        text: "Hello",
        voiceId: "echo",
        instructions: "Speak playfully.",
        speed: 1,
        format: "wav",
      },
      outPath("b"),
    );
    expect(lastBody.instructions).toBe("Speak playfully.");
  });

  it("OMITS instructions when the model does not support them", async () => {
    // Older TTS models reject an unknown field rather than ignoring it, so
    // sending it unconditionally would turn a working call into a 400.
    handler = (_q, res) => okAudio(res);
    await createSpeech(
      config({ supportsInstructions: false }),
      {
        text: "Hello",
        voiceId: "echo",
        instructions: "Speak playfully.",
        speed: 1,
        format: "wav",
      },
      outPath("c"),
    );
    expect(lastBody.instructions).toBeUndefined();
  });

  it("omits empty instructions even when supported", async () => {
    handler = (_q, res) => okAudio(res);
    await createSpeech(
      config(),
      { text: "Hi", voiceId: "echo", instructions: "   ", speed: 1, format: "wav" },
      outPath("d"),
    );
    expect(lastBody.instructions).toBeUndefined();
  });

  it("puts the key in the Authorization header and nowhere else", async () => {
    handler = (_q, res) => okAudio(res);
    await createSpeech(
      config(),
      { text: "Hi", voiceId: "echo", instructions: "", speed: 1, format: "wav" },
      outPath("e"),
    );
    expect(lastAuth).toBe("Bearer sk-test-not-a-real-key");
    expect(JSON.stringify(lastBody)).not.toContain("sk-test");
  });

  it("clamps a speed the vendor would reject", async () => {
    handler = (_q, res) => okAudio(res);
    await createSpeech(
      config(),
      { text: "Hi", voiceId: "echo", instructions: "", speed: 99, format: "wav" },
      outPath("f"),
    );
    expect(lastBody.speed).toBe(4);
  });
});

describe("errors", () => {
  it("does not retry a 401", async () => {
    let calls = 0;
    handler = (_q, res) => {
      calls += 1;
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    };
    await expect(
      createSpeech(
        config(),
        { text: "Hi", voiceId: "echo", instructions: "", speed: 1, format: "wav" },
        outPath("g"),
      ),
    ).rejects.toThrow(ProviderError);
    expect(calls).toBe(1);
  });

  it("keeps the vendor's message so the cause is visible", async () => {
    handler = (_q, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unknown voice." } }));
    };
    await expect(
      createSpeech(
        config(),
        { text: "Hi", voiceId: "nope", instructions: "", speed: 1, format: "wav" },
        outPath("h"),
      ),
    ).rejects.toThrow(/Unknown voice/);
  });

  it("treats empty audio as an error rather than a silent success", async () => {
    handler = (_q, res) => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(Buffer.alloc(0));
    };
    await expect(
      createSpeech(
        config(),
        { text: "Hi", voiceId: "echo", instructions: "", speed: 1, format: "wav" },
        outPath("i"),
      ),
    ).rejects.toThrow(/rỗng/);
  });

  it("REFUSES to overwrite audio that already exists", async () => {
    // An existing file means something already produced audio there, and it was
    // paid for. Replacing it silently discards a purchase.
    handler = (_q, res) => okAudio(res);
    const target = outPath("j");
    fs.writeFileSync(target, "already here");
    await expect(
      createSpeech(
        config(),
        { text: "Hi", voiceId: "echo", instructions: "", speed: 1, format: "wav" },
        target,
      ),
    ).rejects.toThrow(/Không ghi đè/);
    expect(fs.readFileSync(target, "utf8")).toBe("already here");
  });
});

describe("cost", () => {
  it("bills the characters sent, so estimate and charge cannot drift apart", async () => {
    const provider = new OpenAIVoiceProvider(config());
    const estimate = await provider.estimateCost(req({ text: "a".repeat(1000) }));
    expect(estimate.amount).toBeCloseTo(0.0006, 8);
  });

  it("reports the REAL cost on download, not zero", async () => {
    // Returning 0 here is how a real charge vanishes from the ledger and lets
    // the spend cap refund itself.
    handler = (_q, res) => okAudio(res);
    const provider = new OpenAIVoiceProvider(config());
    const job = await provider.createVoice(req({ text: "a".repeat(500) }));
    const asset = await provider.downloadResult(job.externalId);
    expect(asset.actualCost).toBeCloseTo(0.0003, 8);
    expect(asset.bytes).toBeGreaterThan(0);
  });

  it("refuses an empty line instead of paying for silence", async () => {
    const provider = new OpenAIVoiceProvider(config());
    await expect(provider.createVoice(req({ text: "   " }))).rejects.toThrow(
      ProviderError,
    );
  });

  it("reports a finished job as completed, since the endpoint is synchronous", async () => {
    handler = (_q, res) => okAudio(res);
    const provider = new OpenAIVoiceProvider(config());
    const job = await provider.createVoice(req({ text: "Hi there" }));
    expect(job.state).toBe("completed");
    const status = await provider.getJobStatus(job.externalId);
    expect(status.state).toBe("completed");
  });

  it("fails cleanly when asked about a job it never had", async () => {
    const provider = new OpenAIVoiceProvider(config());
    const status = await provider.getJobStatus("voice_nothing");
    expect(status.state).toBe("failed");
  });
});

describe("config helpers", () => {
  it("clamps speed into the range the vendor accepts", () => {
    expect(clampSpeed(0)).toBe(1);
    expect(clampSpeed(0.1)).toBe(0.25);
    expect(clampSpeed(10)).toBe(4);
    expect(clampSpeed(1.5)).toBe(1.5);
    expect(clampSpeed(Number.NaN)).toBe(1);
  });

  it("maps every format to an extension", () => {
    expect(FORMAT_EXTENSION.wav).toBe(".wav");
    expect(FORMAT_EXTENSION.mp3).toBe(".mp3");
  });

  it("knows the voices it offers", () => {
    expect(isKnownVoice("echo")).toBe(true);
    expect(isKnownVoice("nonexistent")).toBe(false);
    expect(OPENAI_VOICES.length).toBeGreaterThan(5);
  });
});
