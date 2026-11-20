/**
 * Print recent DM triage decisions, newest first — the way to review a dry run.
 *
 *   npx tsx scripts/triage-report.ts [--hours 24] [--limit 200]
 *
 * Read-only. Uses the database named by DATABASE_URL.
 */
import { prisma } from "../lib/db/client";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const n = i === -1 ? NaN : Number.parseInt(process.argv[i + 1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main() {
  const hours = arg("hours", 24);
  const rows = await prisma.triageLog.findMany({
    where: { createdAt: { gte: new Date(Date.now() - hours * 3_600_000) } },
    orderBy: { createdAt: "desc" },
    take: arg("limit", 200),
  });

  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.category} → ${r.action}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log(`Last ${hours}h: ${rows.length} messages`);
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${key}`);
  console.log("");

  for (const r of rows) {
    console.log(
      `${r.createdAt.toISOString().slice(5, 16)} [${r.category} → ${r.action}] ${r.messageText.replace(/\s+/g, " ").slice(0, 80)}`
    );
    if (r.replyText) console.log(`    ↳ ${r.replyText.replace(/\s+/g, " ").slice(0, 160)}`);
    if (r.reason) console.log(`    (${r.reason.slice(0, 120)})`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
