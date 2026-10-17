/**
 * The default name offered for a new batch (QĐ-137).
 *
 * It used to be "Batch Video Factory #001" every time. The next number is one
 * past the highest number already used in a default-style name AND past the
 * number of batches that exist, so a renamed or deleted batch can never make
 * the form offer a number that is already taken. The person can still type
 * any name they like.
 */
export const DEFAULT_BATCH_NAME_PREFIX = "Batch Video Factory #";

const NUMBERED = /^Batch Video Factory #(\d+)\s*$/;

export function nextDefaultBatchName(existingNames: readonly string[]): string {
  let highest = 0;
  for (const name of existingNames) {
    const m = NUMBERED.exec(name.trim());
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  const next = Math.max(highest, existingNames.length) + 1;
  return `${DEFAULT_BATCH_NAME_PREFIX}${String(next).padStart(3, "0")}`;
}
