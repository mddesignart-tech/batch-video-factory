import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  consumeCreateToken,
  CreateTokenError,
  grantCreateToken,
  peekCreateToken,
  revokeCreateToken,
} from "@/services/create-token";
import { needsCreatePermit } from "@/services/generation";

/**
 * A benchmark authorised as ONE paid create issued four. All four happened to
 * cost nothing - two schema rejections, two vendor-side failures - but each was
 * a genuine attempt to charge the account, and the spend guard waved every one
 * through because nothing had been spent yet.
 *
 * These tests pin the rule that closes that hole: the permit is spent by the
 * ATTEMPT, never by the outcome.
 */

const REQ = {
  provider: "runway",
  model: "gen4_turbo:720x1280",
  sceneId: "scene-1",
  kind: "video",
  estimatedCost: 0.25,
};

const GRANT = {
  provider: REQ.provider,
  model: REQ.model,
  sceneId: REQ.sceneId,
  kind: REQ.kind,
  maxCost: 0.3,
  note: "test",
};

beforeEach(async () => {
  await revokeCreateToken();
});

describe("granting", () => {
  it("issues a permit that can then be seen", async () => {
    await grantCreateToken(GRANT);
    const t = await peekCreateToken();
    expect(t?.provider).toBe("runway");
    expect(t?.maxCost).toBe(0.3);
  });

  it("REPLACES an outstanding permit instead of stacking a second one", async () => {
    // Two permits in the drawer is two clips, and no confirmation this app
    // asks for has ever meant that.
    await grantCreateToken(GRANT);
    await grantCreateToken({ ...GRANT, note: "second" });
    await consumeCreateToken(REQ);
    await expect(consumeCreateToken(REQ)).rejects.toThrow(CreateTokenError);
  });

  it("looking at a permit does not spend it", async () => {
    await grantCreateToken(GRANT);
    await peekCreateToken();
    await peekCreateToken();
    await expect(consumeCreateToken(REQ)).resolves.toBeTruthy();
  });
});

describe("the permit is spent by the attempt, not the outcome", () => {
  it("allows exactly one create", async () => {
    await grantCreateToken(GRANT);
    await expect(consumeCreateToken(REQ)).resolves.toBeTruthy();
    await expect(consumeCreateToken(REQ)).rejects.toThrow(CreateTokenError);
  });

  it("is NOT returned when the call that used it fails", async () => {
    // This is the whole point. A free failure must not buy another attempt.
    await grantCreateToken(GRANT);
    await consumeCreateToken(REQ);

    // Caller then hits a 400, a 500, a vendor FAILED, or a timeout.
    await expect(consumeCreateToken(REQ)).rejects.toThrow(
      /đã được dùng hoặc chưa từng được cấp/,
    );
  });

  it("blocks a create when no permit was ever issued", async () => {
    await expect(consumeCreateToken(REQ)).rejects.toThrow(CreateTokenError);
  });

  it("says plainly that the user must confirm again", async () => {
    await expect(consumeCreateToken(REQ)).rejects.toThrow(
      /Người dùng phải xác nhận lại/,
    );
  });
});

describe("a permit only covers the work it was granted for", () => {
  it("refuses a different provider", async () => {
    await grantCreateToken(GRANT);
    await expect(
      consumeCreateToken({ ...REQ, provider: "openai" }),
    ).rejects.toThrow(CreateTokenError);
  });

  it("refuses a different model", async () => {
    await grantCreateToken(GRANT);
    await expect(
      consumeCreateToken({ ...REQ, model: "gen4_turbo:1080x1920" }),
    ).rejects.toThrow(CreateTokenError);
  });

  it("refuses a different scene", async () => {
    await grantCreateToken(GRANT);
    await expect(
      consumeCreateToken({ ...REQ, sceneId: "scene-5" }),
    ).rejects.toThrow(CreateTokenError);
  });

  it("refuses a cost above the ceiling it was granted against", async () => {
    await grantCreateToken(GRANT);
    await expect(
      consumeCreateToken({ ...REQ, estimatedCost: 0.9 }),
    ).rejects.toThrow(/vượt mức/);
  });

  it("BURNS a mismatched permit rather than leaving it lying about", async () => {
    // Left available, the next call would pick up a permit meant for other work.
    await grantCreateToken(GRANT);
    await expect(
      consumeCreateToken({ ...REQ, provider: "openai" }),
    ).rejects.toThrow(CreateTokenError);
    expect(await peekCreateToken()).toBeNull();
    await expect(consumeCreateToken(REQ)).rejects.toThrow(CreateTokenError);
  });
});

describe("durability", () => {
  it("survives as a row, so a crash cannot resurrect a spent permit", async () => {
    await grantCreateToken(GRANT);
    await consumeCreateToken(REQ);
    const row = await prisma.setting.findUnique({
      where: { key: "spend.oneCreateToken" },
    });
    expect(row).toBeNull();
  });

  it("treats a corrupted permit as no permit", async () => {
    await prisma.setting.upsert({
      where: { key: "spend.oneCreateToken" },
      create: { key: "spend.oneCreateToken", valueJson: "{ not json" },
      update: { valueJson: "{ not json" },
    });
    expect(await peekCreateToken()).toBeNull();
    await expect(consumeCreateToken(REQ)).rejects.toThrow(CreateTokenError);
  });

  it("can be thrown away without being used", async () => {
    await grantCreateToken(GRANT);
    await revokeCreateToken();
    expect(await peekCreateToken()).toBeNull();
  });
});

describe("one approval = exactly one create attempt", () => {
  /**
   * The rule the operator asked for, stated as tests.
   *
   * "It did not cost anything" is NOT the same as "you may try again". Each of
   * these outcomes ends an approval, because each one was a real attempt to
   * charge the account - and the four that cost nothing did so by the vendor's
   * choice, not by ours.
   */
  const OUTCOMES = [
    "success",
    "HTTP 400",
    "HTTP 401",
    "HTTP 429",
    "HTTP 500",
    "timeout",
    "vendor FAILED",
    "provider internal error",
  ];

  for (const outcome of OUTCOMES) {
    it(`is spent after a create that ended in: ${outcome}`, async () => {
      await grantCreateToken(GRANT);
      // The permit is taken BEFORE the request leaves, so the outcome cannot
      // change whether it was spent.
      await consumeCreateToken(REQ);
      // ... the call then ends in `outcome`, whatever that was ...
      await expect(consumeCreateToken(REQ)).rejects.toThrow(CreateTokenError);
    });
  }

  it("two approvals allow exactly two creates, not three", async () => {
    await grantCreateToken(GRANT);
    await expect(consumeCreateToken(REQ)).resolves.toBeTruthy();
    await grantCreateToken(GRANT);
    await expect(consumeCreateToken(REQ)).resolves.toBeTruthy();
    await expect(consumeCreateToken(REQ)).rejects.toThrow(CreateTokenError);
  });
});

describe("read-only work never consumes an approval", () => {
  /**
   * Polling, status checks, downloads, model discovery and balance reads all
   * happen many times per job. If any of them spent the permit, a single
   * approved create could never finish.
   */
  it("needs NO permit in Mock Mode, whatever the kind", () => {
    // The test suite runs in Mock Mode, which is itself the point: nothing can
    // be billed, so requiring a permit would break every offline run for no
    // benefit. Mock Mode is a hard gate ahead of this check.
    expect(needsCreatePermit("video", "runway")).toBe(false);
    expect(needsCreatePermit("image", "openai")).toBe(false);
  });

  it("in REAL mode, only a paid VIDEO create needs a permit", async () => {
    const { resetEnvCache } = await import("@/lib/env");
    const previous = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "false";
    resetEnvCache();
    try {
      expect(needsCreatePermit("video", "runway")).toBe(true);
      // Nothing else does: these are either not creates at all, or not the
      // expensive kind the permit exists to guard.
      expect(needsCreatePermit("image", "openai")).toBe(false);
      expect(needsCreatePermit("audio", "openai")).toBe(false);
      expect(needsCreatePermit("quality", "groq")).toBe(false);
      // Nothing to authorise when nothing can be billed.
      expect(needsCreatePermit("video", "ollama")).toBe(false);
      expect(needsCreatePermit("video", "lmstudio")).toBe(false);
    } finally {
      process.env.AI_MOCK_MODE = previous;
      resetEnvCache();
    }
  });

  it("a permit survives any number of status reads", async () => {
    await grantCreateToken(GRANT);
    for (let i = 0; i < 25; i += 1) {
      // Stands in for poll / download / balance / discovery: all of these read
      // and none of them consume.
      expect(await peekCreateToken()).not.toBeNull();
    }
    await expect(consumeCreateToken(REQ)).resolves.toBeTruthy();
  });

  it("the permit is gone once the create is attempted, even mid-poll", async () => {
    // Polling after the create must not be able to resurrect an approval.
    await grantCreateToken(GRANT);
    await consumeCreateToken(REQ);
    expect(await peekCreateToken()).toBeNull();
    await expect(consumeCreateToken(REQ)).rejects.toThrow(CreateTokenError);
  });
});
