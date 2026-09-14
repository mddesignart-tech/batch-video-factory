import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/**
 * A single-use permit to call one paid create endpoint.
 *
 * The spend guard answers "can we afford this?". It does not answer "was this
 * particular purchase authorised?", and those are different questions. A run
 * that fails for free and is retried passes the spend guard every time, because
 * nothing was ever spent - so a benchmark meant to buy ONE clip can quietly
 * issue create after create, each one a genuine attempt to charge the account.
 *
 * That happened: a Runway benchmark authorised as one paid create issued four.
 * All four were free, by luck rather than by design - two schema rejections and
 * two vendor-side failures. Had any succeeded, the account would have been
 * charged for a clip nobody approved.
 *
 * So the permit is consumed by the ATTEMPT, never by the outcome:
 *
 *   consumed  - success, 400, 500, vendor FAILED, timeout, thrown exception
 *   untouched - GET status, polling, download, cost lookups, dry runs
 *
 * Consumption happens BEFORE the request leaves, so a crash mid-flight cannot
 * leave a spent permit looking unspent. Erring towards "used" is right here: a
 * wrongly-spent permit costs one confirmation prompt, a wrongly-kept one costs
 * a clip.
 */

const TOKEN_KEY = "spend.oneCreateToken";

export class CreateTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateTokenError";
  }
}

export interface CreateToken {
  provider: string;
  model: string;
  sceneId: string;
  kind: string;
  /** Ceiling this permit was granted against, in dollars. */
  maxCost: number;
  grantedAt: string;
  /** Who granted it and why, for the audit trail. */
  note: string;
}

function parse(valueJson: string): CreateToken | null {
  try {
    const v: unknown = JSON.parse(valueJson);
    if (v === null || typeof v !== "object") return null;
    const t = v as Partial<CreateToken>;
    if (
      typeof t.provider !== "string" ||
      typeof t.model !== "string" ||
      typeof t.sceneId !== "string" ||
      typeof t.kind !== "string" ||
      typeof t.maxCost !== "number"
    ) {
      return null;
    }
    return {
      provider: t.provider,
      model: t.model,
      sceneId: t.sceneId,
      kind: t.kind,
      maxCost: t.maxCost,
      grantedAt: typeof t.grantedAt === "string" ? t.grantedAt : "",
      note: typeof t.note === "string" ? t.note : "",
    };
  } catch {
    return null;
  }
}

/**
 * Issue exactly one permit, replacing any permit still outstanding.
 *
 * Replacing rather than stacking is deliberate: two permits in the drawer is
 * two clips, and no confirmation this app asks for has ever meant that.
 */
export async function grantCreateToken(token: {
  provider: string;
  model: string;
  sceneId: string;
  kind: string;
  maxCost: number;
  note: string;
}): Promise<CreateToken> {
  const full: CreateToken = { ...token, grantedAt: new Date().toISOString() };
  const valueJson = JSON.stringify(full);
  await prisma.setting.upsert({
    where: { key: TOKEN_KEY },
    create: { key: TOKEN_KEY, valueJson },
    update: { valueJson },
  });
  await logger.info({
    event: "spend.create_token_granted",
    provider: token.provider,
    model: token.model,
    sceneId: token.sceneId,
    message: `Cấp 1 quyền gọi create, tối đa $${token.maxCost.toFixed(4)}. ${token.note}`,
  });
  return full;
}

/** Look without spending. Used by dry runs and status output. */
export async function peekCreateToken(): Promise<CreateToken | null> {
  const row = await prisma.setting.findUnique({ where: { key: TOKEN_KEY } });
  return row ? parse(row.valueJson) : null;
}

/** Throw the permit away without using it. */
export async function revokeCreateToken(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: TOKEN_KEY } });
}

/**
 * Spend the permit, or refuse the call.
 *
 * Deletes first and validates after, so there is no window in which a second
 * caller can read the same permit. A mismatched permit is deleted too: it was
 * granted for different work, and silently leaving it available would let the
 * next call pick it up.
 */
export async function consumeCreateToken(req: {
  provider: string;
  model: string;
  sceneId: string;
  kind: string;
  estimatedCost: number;
}): Promise<CreateToken> {
  const row = await prisma.setting.findUnique({ where: { key: TOKEN_KEY } });
  const token = row ? parse(row.valueJson) : null;

  // Delete unconditionally. Whatever was there is now used up or invalid.
  if (row) await prisma.setting.deleteMany({ where: { key: TOKEN_KEY } });

  if (!token) {
    throw new CreateTokenError(
      `Chưa được cấp quyền gọi create trả phí cho ${req.provider}/${req.model}. ` +
        `Mỗi lần xác nhận chỉ cho phép ĐÚNG MỘT lần gọi create, và quyền đó đã ` +
        `được dùng hoặc chưa từng được cấp. Người dùng phải xác nhận lại.`,
    );
  }

  const mismatch =
    token.provider !== req.provider ||
    token.model !== req.model ||
    token.sceneId !== req.sceneId ||
    token.kind !== req.kind;

  if (mismatch) {
    throw new CreateTokenError(
      `Quyền gọi create được cấp cho ${token.kind} ${token.provider}/${token.model} ` +
        `cảnh ${token.sceneId}, không phải ${req.kind} ${req.provider}/${req.model} ` +
        `cảnh ${req.sceneId}. Quyền đã bị huỷ, phải xác nhận lại.`,
    );
  }

  if (req.estimatedCost > token.maxCost) {
    throw new CreateTokenError(
      `Ước tính $${req.estimatedCost.toFixed(6)} vượt mức $${token.maxCost.toFixed(6)} ` +
        `mà quyền này được cấp. Quyền đã bị huỷ, phải xác nhận lại.`,
    );
  }

  await logger.info({
    event: "spend.create_token_consumed",
    provider: req.provider,
    model: req.model,
    sceneId: req.sceneId,
    message:
      `Đã dùng quyền gọi create (ước tính $${req.estimatedCost.toFixed(6)}). ` +
      `Mọi lần gọi create tiếp theo sẽ bị chặn cho tới khi được xác nhận lại.`,
  });

  return token;
}
