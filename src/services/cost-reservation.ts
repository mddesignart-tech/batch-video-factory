import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { round } from "@/lib/utils";

/**
 * Hold money before spending it, settle it after.
 *
 * The problem this solves only appears with concurrency, which is exactly when
 * nobody is watching. Five scene jobs run at once against a batch with $0.60
 * left. Each one reads the ledger, sees $0.60 available, decides its own $0.40
 * request fits, and sends it. Every one of those five checks was correct at the
 * moment it ran. They were just all correct about the same $0.60, and the batch
 * spends $2.00.
 *
 * A check that reads committed spend can never fix this, because the spend does
 * not exist yet when the check runs. So the money is promised first and sent
 * second: a reservation is written before the request leaves, and the next
 * check sees it. Two jobs can no longer promise the same dollar.
 *
 * Settling has two outcomes and the difference matters:
 *
 *   commit  - the vendor billed us. The held amount is replaced by the real one.
 *   release - the vendor did not bill us. The money goes back to the batch.
 *
 * `release` is the dangerous one. Releasing budget for a request that WAS
 * charged hands the operator money that is already gone, and the batch then
 * overspends while every number on screen looks right. So a release has to be
 * able to prove nothing was billed - which in practice means the request never
 * left this machine. Anything else commits.
 */

const MONEY_DIGITS = 6;
const money = (value: number): number => round(value, MONEY_DIGITS);

/**
 * Reservations are taken one at a time.
 *
 * Writing the reservation is not enough on its own: `reserve` READS the ledger
 * and then WRITES, and two jobs interleaving between those two steps both read
 * the same headroom and both take it. The unique key stops one request being
 * reserved twice; it does nothing about two different requests racing for the
 * same last dollar.
 *
 * So the read-and-write pair is serialised. This app is a single local process
 * with a worker whose concurrency defaults to 2, so a promise chain is the whole
 * mechanism needed - no advisory locks, no broker.
 *
 * The limit, stated plainly: this holds WITHIN one process. Two copies of the
 * app pointed at the same SQLite file could still race. That is already outside
 * what this design supports (the job worker assumes it is the only one), and the
 * fix if it ever changes is a transaction with a real write lock, not a bigger
 * mutex.
 *
 * On `globalThis` for the same reason the worker state is: Next bundles
 * instrumentation separately from route handlers, so a module-level variable
 * would give each bundle its own lock and protect nothing.
 */
const globalForReservation = globalThis as unknown as {
  __reservationLock?: Promise<unknown>;
};

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const previous = globalForReservation.__reservationLock ?? Promise.resolve();
  // `catch` so one failed reservation does not poison the chain for the next.
  const next = previous.then(work, work);
  globalForReservation.__reservationLock = next.catch(() => undefined);
  return next;
}

export interface ReservationLedger {
  /** Really billed, summed from settled reservations. */
  committed: number;
  /** Promised but not yet settled. Money that is spoken for. */
  reserved: number;
  /** committed + reserved. What the next request must be added to. */
  used: number;
  /** Ceiling minus `used`, floored at zero. */
  available: number;
  ceiling: number;
}

export interface ReserveInput {
  batchId: string;
  projectId?: string | null;
  sceneId?: string | null;
  /** The SAME key services/generation computes for the ProviderJob. */
  idempotencyKey: string;
  kind: string;
  provider: string;
  model: string;
  estimatedCost: number;
}

export class ReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReservationError";
  }
}

/**
 * What a batch has promised and spent.
 *
 * RELEASED rows are excluded from both totals by construction: a released
 * reservation is money that was never taken, and counting it would shrink the
 * batch for no reason.
 */
export async function reservationLedger(
  batchId: string,
  ceiling: number,
): Promise<ReservationLedger> {
  const [committedAgg, reservedAgg] = await Promise.all([
    prisma.costReservation.aggregate({
      where: { batchId, status: "COMMITTED" },
      _sum: { actualCost: true },
    }),
    prisma.costReservation.aggregate({
      where: { batchId, status: "RESERVED" },
      _sum: { estimatedCost: true },
    }),
  ]);

  const committed = money(committedAgg._sum.actualCost ?? 0);
  const reserved = money(reservedAgg._sum.estimatedCost ?? 0);
  const used = money(committed + reserved);

  return {
    committed,
    reserved,
    used,
    available: money(Math.max(0, ceiling - used)),
    ceiling: money(ceiling),
  };
}

/**
 * Hold money for one request, or say why it cannot be held.
 *
 * Returns `reused: true` when this exact request already has a reservation.
 * That is the normal path after a restart, a browser refresh or a resume: the
 * caller recomputes the same idempotency key, finds the same row, and does NOT
 * get charged a second time for asking twice. It is also why the unique
 * constraint on the key is load-bearing rather than tidiness - the database is
 * what makes "reserve once" true across processes.
 */
export function reserve(
  input: ReserveInput,
  ceiling: number,
): Promise<{ reused: boolean; ledger: ReservationLedger }> {
  // Serialised: see `serialise` above for why the unique key alone is not
  // enough to keep two concurrent jobs off the same last dollar.
  return serialise(() => reserveOnce(input, ceiling));
}

async function reserveOnce(
  input: ReserveInput,
  ceiling: number,
): Promise<{ reused: boolean; ledger: ReservationLedger }> {
  const existing = await prisma.costReservation.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });

  if (existing) {
    // Already held or already settled: this exact request is spoken for. Asking
    // twice must not hold money twice.
    return {
      reused: true,
      ledger: await reservationLedger(input.batchId, ceiling),
    };
  }

  const cost = money(Math.max(0, input.estimatedCost));
  const ledger = await reservationLedger(input.batchId, ceiling);

  if (money(ledger.used + cost) > ledger.ceiling) {
    throw new ReservationError(
      `Lô đã dùng $${ledger.used.toFixed(6)} trong hạn mức được duyệt ` +
        `$${ledger.ceiling.toFixed(6)} (đã chi $${ledger.committed.toFixed(6)}, ` +
        `đang giữ chỗ $${ledger.reserved.toFixed(6)}). Yêu cầu này ước tính ` +
        `$${cost.toFixed(6)} nên sẽ vượt. KHÔNG gửi request.`,
    );
  }

  try {
    await prisma.costReservation.create({
      data: {
        batchId: input.batchId,
        projectId: input.projectId ?? null,
        sceneId: input.sceneId ?? null,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        provider: input.provider,
        model: input.model,
        status: "RESERVED",
        estimatedCost: cost,
      },
    });
  } catch (err) {
    // Another worker created the same reservation between our read and our
    // write. That is the constraint doing its job, not an error: the request is
    // already spoken for, so treat it exactly like finding the row above.
    if (isUniqueViolation(err)) {
      return { reused: true, ledger: await reservationLedger(input.batchId, ceiling) };
    }
    throw err;
  }

  await logger.debug({
    event: "batch.reserved",
    provider: input.provider,
    model: input.model,
    projectId: input.projectId ?? undefined,
    sceneId: input.sceneId ?? undefined,
    message: `Giữ chỗ $${cost.toFixed(6)} cho ${input.kind}.`,
  });

  return { reused: false, ledger: await reservationLedger(input.batchId, ceiling) };
}

/** Settle a reservation against what the vendor actually charged. */
export async function commit(
  idempotencyKey: string,
  actualCost: number,
  note = "",
): Promise<void> {
  const row = await prisma.costReservation.findUnique({ where: { idempotencyKey } });
  if (!row || row.status === "COMMITTED") return;

  await prisma.costReservation.update({
    where: { idempotencyKey },
    data: {
      status: "COMMITTED",
      actualCost: money(Math.max(0, actualCost)),
      settledAt: new Date(),
      note: note || row.note,
    },
  });
  await syncAuthorizationSpend(row.batchId);
}

/**
 * Give the money back - but only when nothing was billed.
 *
 * `billed` is the caller's honest answer to "did a request reach the vendor?".
 * When it is true, or simply unknown, the reservation is committed at the held
 * estimate instead of released, and flagged so a reader can see it is a guess
 * rather than an invoice.
 *
 * Erring this way costs the operator some headroom in a batch. Erring the other
 * way costs them money they cannot see leaving.
 */
export async function release(
  idempotencyKey: string,
  opts: { billed: boolean; actualCost?: number; note?: string },
): Promise<void> {
  const row = await prisma.costReservation.findUnique({ where: { idempotencyKey } });
  if (!row || row.status !== "RESERVED") return;

  if (opts.billed) {
    const billedAmount =
      typeof opts.actualCost === "number" && opts.actualCost > 0
        ? opts.actualCost
        : null;
    const known = billedAmount !== null;
    await prisma.costReservation.update({
      where: { idempotencyKey },
      data: {
        status: "COMMITTED",
        actualCost: money(billedAmount ?? row.estimatedCost),
        possiblyBilled: !known,
        settledAt: new Date(),
        note:
          opts.note ||
          (known
            ? "Thất bại nhưng nhà cung cấp đã tính phí."
            : "Thất bại sau khi request đã gửi đi. Giữ nguyên số tiền ước tính " +
              "vì không xác định được có bị tính phí hay không."),
      },
    });
    await syncAuthorizationSpend(row.batchId);
    return;
  }

  await prisma.costReservation.update({
    where: { idempotencyKey },
    data: {
      status: "RELEASED",
      actualCost: 0,
      settledAt: new Date(),
      note: opts.note || "Request chưa rời máy, không phát sinh chi phí.",
    },
  });
  await logger.debug({
    event: "batch.released",
    provider: row.provider,
    model: row.model,
    sceneId: row.sceneId ?? undefined,
    message: `Trả lại $${row.estimatedCost.toFixed(6)} cho lô.`,
  });
  await syncAuthorizationSpend(row.batchId);
}

/**
 * Correct a settlement that later evidence proved wrong.
 *
 * `release` deliberately refuses to touch a COMMITTED row: money that has been
 * declared spent must not un-spend itself because some code ran twice. But a
 * committed row can still be WRONG, and when the vendor itself says so there
 * has to be a way to say it back - otherwise the ledger's only failure mode is
 * permanent.
 *
 * The case this was written for: a Runway clip failed, the settlement fell back
 * to "assume the estimate was billed" because nothing read `cost.credits`, and
 * $0.25 stood against the batch that the credit balance (831 before, 831 after)
 * proves was never charged.
 *
 * Deliberately narrow, and never automatic:
 *   - the caller must pass a reason, which is stored on the row
 *   - it only ever moves the actual cost, never the estimate or the key
 *   - `possiblyBilled` is cleared, because a correction is by definition made
 *     when the answer stopped being a guess
 */
export async function correctSettlement(
  idempotencyKey: string,
  opts: { actualCost: number; reason: string },
): Promise<{ before: number; after: number } | null> {
  const row = await prisma.costReservation.findUnique({ where: { idempotencyKey } });
  if (!row) return null;

  const after = money(opts.actualCost);
  await prisma.costReservation.update({
    where: { idempotencyKey },
    data: {
      // A corrected-to-zero settlement is a release: nothing was spent.
      status: after > 0 ? "COMMITTED" : "RELEASED",
      actualCost: after,
      possiblyBilled: false,
      settledAt: new Date(),
      note: opts.reason.slice(0, 300),
    },
  });
  await logger.warn({
    event: "batch.settlement_corrected",
    provider: row.provider,
    model: row.model,
    sceneId: row.sceneId ?? undefined,
    message:
      `Sửa sổ: $${row.actualCost.toFixed(6)} -> $${after.toFixed(6)}. ${opts.reason}`,
  });
  await syncAuthorizationSpend(row.batchId);
  return { before: row.actualCost, after };
}

/** Recompute the authorisation's committed total from its reservations. */
export async function syncAuthorizationSpend(batchId: string): Promise<number> {
  const agg = await prisma.costReservation.aggregate({
    where: { batchId, status: "COMMITTED" },
    _sum: { actualCost: true },
  });
  const total = money(agg._sum.actualCost ?? 0);
  await prisma.batchAuthorization
    .updateMany({ where: { batchId }, data: { actualSpend: total } })
    .catch(() => undefined);
  return total;
}

/** Everything held or spent on one project, so a per-video ceiling can be checked. */
export async function projectReservedAndSpent(projectId: string): Promise<number> {
  const [committedAgg, reservedAgg] = await Promise.all([
    prisma.costReservation.aggregate({
      where: { projectId, status: "COMMITTED" },
      _sum: { actualCost: true },
    }),
    prisma.costReservation.aggregate({
      where: { projectId, status: "RESERVED" },
      _sum: { estimatedCost: true },
    }),
  ]);
  return money(
    (committedAgg._sum.actualCost ?? 0) + (reservedAgg._sum.estimatedCost ?? 0),
  );
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as Prisma.PrismaClientKnownRequestError | undefined)?.code;
  return code === "P2002";
}
