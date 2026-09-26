import path from "node:path";

/**
 * Which SQLite file this process actually opens.
 *
 * Prisma resolves a relative `file:` URL against the folder holding
 * `schema.prisma` (not the working directory), so `file:../data/app.db` means
 * `<repo>/data/app.db`. The settings page prints this path next to the global
 * spend limit: a limit typed into a server that is pointed at a scratch or QA
 * database changes that database, and nothing else - the operator must be able
 * to see which one they are editing.
 */

export function resolveDatabaseFile(
  url: string | undefined = process.env.DATABASE_URL,
  cwd: string = process.cwd(),
): string | null {
  const value = (url ?? "file:../data/app.db").trim();
  if (!value.startsWith("file:")) return null;
  const raw = value.slice("file:".length).split("?")[0] ?? "";
  if (raw === "") return null;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, "prisma", raw);
}

/** True when this process is reading and writing the operator's real `data/app.db`. */
export function isProductionDatabase(
  url: string | undefined = process.env.DATABASE_URL,
  cwd: string = process.cwd(),
): boolean {
  const file = resolveDatabaseFile(url, cwd);
  if (!file) return false;
  const prod = path.resolve(cwd, "data", "app.db");
  return process.platform === "win32" ? file.toLowerCase() === prod.toLowerCase() : file === prod;
}
