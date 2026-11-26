import { prisma } from "@/lib/db/client";

/**
 * The tutorials the owner can hand out right now.
 *
 * A draft used to see one thing of the owner's work: the page the person
 * already holds. Asked "can you teach me to edit video?", it could only guess,
 * and it guessed an app the owner never taught while five of his own campaigns
 * were about exactly that. This is the list that draft now reads.
 *
 * A tutorial is on the list when it can actually be sent: its page is in the
 * page table and a running campaign links to it. Sending is still the
 * campaign's job (follow check, tracked link); this list only names what
 * exists.
 */

export interface Tutorial {
  /** The page's key in the page table. */
  key: string;
  /** Its title, as a person would be told it. */
  title: string;
}

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; list: Tutorial[] }>();

/** Forget what was read, so the next call reads again. For tests. */
export function resetTutorialCache(): void {
  cache.clear();
}

// Page titles sometimes carry the owner's own filing code in front ("K27：",
// "K26b "). It means nothing to the person the title is said to.
const FILING_CODE = /^[A-Z]{1,2}\d{1,3}[a-z]?\s*[：:]?\s*/;

export function sayableTitle(title: string): string {
  return title.replace(FILING_CODE, "").trim() || title.trim();
}

type PageRow = { key: string; title: string; url: string | null; content: string };
type CampaignRow = { trackedLinks: { destinationUrl: string }[] };

/**
 * Pages a running campaign delivers, newest campaign first, each title once.
 *
 * Two pages under one title are the same tutorial filed twice when their text
 * is the same, and then one entry is enough. When their text differs, one of
 * the titles is wrong, and there is no telling which: offering "that" tutorial
 * could send the other one. Both are left off until the title is fixed.
 */
export function listTutorials(pages: PageRow[], campaigns: CampaignRow[]): Tutorial[] {
  // The position of the newest running campaign that links to each address.
  const rank = new Map<string, number>();
  campaigns.forEach((campaign, i) => {
    for (const link of campaign.trackedLinks) {
      if (link.destinationUrl && !rank.has(link.destinationUrl)) rank.set(link.destinationUrl, i);
    }
  });

  const deliverable = pages
    .filter((page) => page.url !== null && rank.has(page.url))
    .sort((a, b) => (rank.get(a.url ?? "") ?? 0) - (rank.get(b.url ?? "") ?? 0));

  const byTitle = new Map<string, PageRow[]>();
  for (const page of deliverable) {
    const title = sayableTitle(page.title);
    byTitle.set(title, [...(byTitle.get(title) ?? []), page]);
  }

  const list: Tutorial[] = [];
  for (const [title, same] of byTitle) {
    const text = same[0].content.trim();
    if (same.every((page) => page.content.trim() === text)) {
      list.push({ key: same[0].key, title });
    }
  }
  return list;
}

/**
 * The account's tutorials, read at most once every ten minutes. Never throws:
 * a draft written without the list is still a draft.
 */
export async function loadTutorials(accountId: string): Promise<Tutorial[]> {
  const cached = cache.get(accountId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.list;
  try {
    const [pages, campaigns] = await Promise.all([
      prisma.triagePage.findMany({
        where: { instagramAccountId: accountId, url: { not: null } },
        select: { key: true, title: true, url: true, content: true },
      }),
      prisma.automation.findMany({
        where: { instagramAccountId: accountId, isActive: true },
        orderBy: { createdAt: "desc" },
        select: { trackedLinks: { select: { destinationUrl: true } } },
      }),
    ]);
    const list = listTutorials(pages, campaigns);
    cache.set(accountId, { at: Date.now(), list });
    return list;
  } catch (error) {
    console.error("[Triage] Could not read the tutorial list:", error);
    return cached?.list ?? [];
  }
}
