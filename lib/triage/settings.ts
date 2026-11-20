import { prisma } from "@/lib/db/client";
import { parseTriageMode, type TriageMode } from "@/lib/triage/config";

/**
 * The per-account triage mode, as set on the Settings page.
 *
 * Read on hot paths (once per webhook echo, twice per worker job), so the
 * answer is cached in memory for a few seconds. The web app and the worker are
 * separate processes with separate caches: after the switch is flipped, the
 * worker can keep the old mode for up to CACHE_MS. That is the price of not
 * hitting the database on every job, and it is short enough for a kill switch.
 */
const CACHE_MS = 15_000;

const cache = new Map<string, { mode: TriageMode; at: number }>();

/** Mode for an account, looked up by its Instagram-side id (what webhooks and jobs carry). */
export async function getTriageModeFor(instagramId: string): Promise<TriageMode> {
  const hit = cache.get(instagramId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.mode;

  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId },
    select: { triageSetting: { select: { mode: true } } },
  });
  const mode = parseTriageMode(account?.triageSetting?.mode);
  cache.set(instagramId, { mode, at: Date.now() });
  return mode;
}

/** Save the mode for an account (by row id) and drop this process's cached copy. */
export async function setTriageMode(
  account: { id: string; instagramId: string },
  mode: TriageMode
): Promise<void> {
  await prisma.triageSetting.upsert({
    where: { instagramAccountId: account.id },
    create: { instagramAccountId: account.id, mode },
    update: { mode },
  });
  cache.delete(account.instagramId);
}

/** Test hook: forget everything cached. */
export function clearTriageModeCache(): void {
  cache.clear();
}
