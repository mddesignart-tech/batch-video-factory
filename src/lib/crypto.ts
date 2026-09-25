import crypto from "node:crypto";
import { env } from "./env";

/**
 * AES-256-GCM at-rest encryption for API keys entered through the admin UI.
 *
 * The plaintext key never leaves the server: the UI only ever receives a mask
 * such as `****F92A`, and there is no endpoint that decrypts back to the client.
 */

const ALGO = "aes-256-gcm";

function keyMaterial(): Buffer | null {
  const raw = env().SECRET_ENCRYPTION_KEY;
  if (!raw || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  // Accept either 64 hex chars or any passphrase (hashed to 32 bytes).
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  return crypto.createHash("sha256").update(trimmed).digest();
}

export function encryptionAvailable(): boolean {
  return keyMaterial() !== null;
}

export function encryptSecret(plain: string): string {
  const key = keyMaterial();
  if (!key) {
    throw new Error(
      "SECRET_ENCRYPTION_KEY chưa được cấu hình. Không thể lưu API key.",
    );
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const key = keyMaterial();
  if (!key) throw new Error("SECRET_ENCRYPTION_KEY chưa được cấu hình.");
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Định dạng khoá mã hoá không hợp lệ.");
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = crypto.createDecipheriv(
    ALGO,
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** `fake-api-key-for-test-only` -> `****ONLY`. Never reveals more than 4 chars. */
export function maskSecret(plain: string): string {
  const tail = plain.trim().slice(-4).toUpperCase();
  return `****${tail}`;
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Hash raw bytes, for deciding whether two files are the same file.
 *
 * Separate from `sha256` rather than an overload because the question is
 * different: that one fingerprints a string we composed, this one identifies
 * content we were handed. A filename is not an identity - the same reference
 * image arrives under a different name every time a storyboard is re-zipped.
 */
export function sha256Bytes(input: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
