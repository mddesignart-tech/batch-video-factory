import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareSpeechText } from "../../src/domain/speech-text";

/**
 * QĐ-156: the text each A/B column hands the engine. A = prepareSpeechText as
 * it was before QĐ-156 (passed in as a module path), B = as it is now. $0.
 *
 *   npx tsx scripts/qa/qd156-make-cases.ts <cases-raw.json> <old speech-text.ts> <out.json>
 */
async function main(): Promise<void> {
  const [raw, oldModule, out] = process.argv.slice(2);
  const old = (await import(pathToFileURL(path.resolve(oldModule!)).href)) as { prepareSpeechText: typeof prepareSpeechText };
  const cases = JSON.parse(fs.readFileSync(raw!, "utf8")) as { id: string; text: string }[];
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const rows = cases.map((c) => ({ ...c, words: words(c.text), textA: old.prepareSpeechText(c.text, "vi"), textB: prepareSpeechText(c.text, "vi") }));
  fs.writeFileSync(out!, JSON.stringify(rows, null, 1));
  for (const r of rows) console.log(r.id, r.words, "từ", r.textA === r.textB ? "A=B" : "A≠B");
}
void main();
