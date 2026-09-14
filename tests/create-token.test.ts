import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  consumeCreateToken,
  CreateTokenError,
  grantCreateToken,
  peekCreateToken,
  revokeCreateToken,
} from "@/services/create-token";

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
