"use server";

import { spawn } from "node:child_process";
import { errorMessage } from "@/lib/utils";
import { resolveOutputFolder } from "@/services/output-folder";
import type { ActionResult } from "./idioms";

/**
 * Open a project's output folder in the operating system's file manager.
 *
 * This is a local-first app: the server and the person are on the same machine,
 * so "open the folder" can literally mean that. Only a project id comes from
 * the client; the folder is resolved from the database and confined to the
 * data root (see `resolveOutputFolder`). No shell is involved, so a path cannot
 * be read as a command.
 */
export async function openOutputFolder(projectId: string): Promise<ActionResult> {
  try {
    const folder = await resolveOutputFolder(projectId);
    if (!folder) return { ok: false, message: "Thư mục output chưa tồn tại." };

    const [command, args] =
      process.platform === "win32"
        ? ["explorer.exe", [folder]]
        : process.platform === "darwin"
          ? ["open", [folder]]
          : ["xdg-open", [folder]];
    // Detached and ignored: explorer.exe exits 1 even on success, and the page
    // must not wait on a window the person may keep open for an hour.
    spawn(command, args, { detached: true, stdio: "ignore", shell: false }).unref();
    return { ok: true, message: `Đã mở ${folder}` };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
