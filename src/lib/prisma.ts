import { PrismaClient } from "@prisma/client";
import { ensureDataDirs } from "./paths";

/**
 * One PrismaClient per process. Next's dev server hot-reloads modules, so the
 * client is parked on globalThis to avoid exhausting SQLite file handles.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  ensureDataDirs();
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
