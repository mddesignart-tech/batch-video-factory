import { PrismaClient } from "@prisma/client";
import { ensureDataDirs } from "./paths";

/**
 * One PrismaClient per process. Next's dev server hot-reloads modules, so the
 * client is parked on globalThis to avoid exhausting SQLite file handles.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * QĐ-152 TRASH: a project in the trash (deletedAt set) is left out of every
 * top-level project LIST (findMany / findFirst / count / aggregate / groupBy)
 * unless the query asks about `deletedAt` itself - the trash page does. A
 * lookup by id (findUnique) is untouched, so an open link or a restore still
 * finds it. Nested `projects` includes are filtered where they are written.
 */
function withTrashFilter(where: Record<string, unknown> | undefined): Record<string, unknown> {
  if (where && "deletedAt" in where) return where;
  return { ...(where ?? {}), deletedAt: null };
}

function createClient(): PrismaClient {
  ensureDataDirs();
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  return base.$extends({
    query: {
      project: {
        findMany: ({ args, query }) => query({ ...args, where: withTrashFilter(args.where as Record<string, unknown> | undefined) }),
        findFirst: ({ args, query }) => query({ ...args, where: withTrashFilter(args.where as Record<string, unknown> | undefined) }),
        findFirstOrThrow: ({ args, query }) => query({ ...args, where: withTrashFilter(args.where as Record<string, unknown> | undefined) }),
        count: ({ args, query }) => query({ ...args, where: withTrashFilter(args?.where as Record<string, unknown> | undefined) }),
        aggregate: ({ args, query }) => query({ ...args, where: withTrashFilter(args.where as Record<string, unknown> | undefined) }),
        groupBy: ({ args, query }) => query({ ...args, where: withTrashFilter(args.where as Record<string, unknown> | undefined) }),
      },
    },
  }) as unknown as PrismaClient;
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
