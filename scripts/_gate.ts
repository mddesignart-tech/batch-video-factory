import { prisma } from "../src/lib/prisma";
import { averageScore } from "../src/services/benchmark-evidence";

const GATE = { identity: 8, motion: 7, artifacts: 8, camera: 8, composition: 8 };

async function main() {
  const rows = await prisma.videoBenchmark.findMany({
    where: { model: "h3_max:768x1280" },
    orderBy: { createdAt: "asc" },
  });
  console.log("Sample                 Scene  Chars Cost   OK  Ident Motion Artif Camera Comp  Overall");
  const acc = { identity: [] as number[], motion: [] as number[], artifacts: [] as number[], camera: [] as number[], composition: [] as number[] };
  for (const [i, r] of rows.entries()) {
    const s = JSON.parse(r.scoresJson) as Record<string, number>;
    const ident = averageScore({
      maxIdentity: s.maxIdentity, leoIdentity: s.leoIdentity, miaIdentity: s.miaIdentity,
    });
    acc.identity.push(ident);
    acc.motion.push(s.motion ?? 0);
    acc.artifacts.push(s.artifacts ?? 0);
    acc.camera.push(s.camera ?? 0);
    acc.composition.push(s.composition ?? 0);
    console.log(
      `${(i+1) + ". canh " + r.sceneNumber} `.padEnd(23) +
      `${r.sceneNumber}`.padEnd(7) +
      `${r.characterCount}`.padEnd(6) +
      `$${r.actualCost.toFixed(2)}`.padEnd(7) +
      `${r.outcome === "succeeded" ? "co" : "KHONG"}`.padEnd(4) +
      `${ident.toFixed(1)}`.padEnd(6) +
      `${(s.motion ?? 0)}`.padEnd(7) +
      `${(s.artifacts ?? 0)}`.padEnd(6) +
      `${(s.camera ?? 0)}`.padEnd(7) +
      `${(s.composition ?? 0)}`.padEnd(6) +
      `${averageScore(s).toFixed(1)}`,
    );
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log("\n--- NGUONG DE XEM XET LOW AUTO-ROUTING ---");
  let pass = rows.length >= 3 && rows.every((r) => r.outcome === "succeeded");
  console.log(`Success rate 3/3      : ${rows.filter(r=>r.outcome==="succeeded").length}/${rows.length}  ${pass ? "DAT" : "KHONG"}`);
  for (const [k, need] of Object.entries(GATE)) {
    const got = avg(acc[k as keyof typeof acc]);
    const ok = got >= need;
    if (!ok) pass = false;
    console.log(`${k.padEnd(22)}: ${got.toFixed(2)} (can >= ${need})  ${ok ? "DAT" : "KHONG DAT"}`);
  }
  console.log(`\nKET LUAN NGUONG: ${pass ? "DAT" : "KHONG DAT -> giu PIN_ONLY"}`);
  const m = await prisma.modelRegistry.findFirst({ where: { modelId: "h3_max:768x1280" } });
  console.log(`Trang thai hien tai: lifecycle=${m?.lifecycle} verification=${m?.verification} reliability=${m?.reliability}`);
}
main().finally(() => prisma.$disconnect());
