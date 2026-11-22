/**
 * Build the page library DM triage answers from (the TriagePage table).
 *
 *   npx tsx scripts/triage-sync-pages.ts --pages <dir> [--packs <dir>] [--extra <dir>]
 *                                        [--out <file>] [--account <username>] [--write]
 *
 *   --pages  folder of landing pages (*.html). Backups (*.bak*) are skipped.
 *   --packs  folder of the write-ups that record, per page, the comment keyword
 *            and the public URL (施工包_*.md). Optional; without it pages are
 *            synced with no keyword/URL and can only be matched once those are
 *            filled in.
 *   --extra  folder of pages saved straight from their published link, for
 *            campaigns whose page has no file in --pages. It holds the *.html
 *            files and a urls.json that maps each file name to its link.
 *   --out    also save what was parsed as JSON, for review.
 *   --account  Instagram username the pages belong to. Optional when exactly
 *              one account is connected.
 *   --write  upsert into the database named by DATABASE_URL. Without this flag
 *            the script only prints what it found and touches nothing.
 *
 * Re-run it whenever a page is added or edited; rows are keyed by account and
 * file name, so a re-run updates in place.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export interface PageRecord {
  key: string;
  title: string;
  url: string | null;
  keywords: string[];
  content: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
  "&rarr;": "→", "&larr;": "←", "&middot;": "·", "&hellip;": "…",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Block boundaries become line breaks so steps and commands stay apart.
    .replace(/<\/(p|div|section|li|h[1-6]|tr|pre|ol|ul|summary|details|title)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function pageTitle(html: string, fallback: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return htmlToText(h1 ?? title ?? "") || fallback;
}

/** Comment keyword and public URL recorded in one write-up. */
export function parsePack(markdown: string): { keywords: string[]; url: string | null } {
  const keywords = new Set<string>();
  const direct = markdown.match(/留言關鍵字[*＊:：\s]*([^\n*＊]+)/);
  if (direct) keywords.add(direct[1].trim());
  for (const m of markdown.matchAll(/留言\s*[「『"]([^」』"\n]{1,20})[」』"]/g)) {
    keywords.add(m[1].trim());
  }
  const url =
    // Both link shapes are in use: claude.ai/artifact/<id> and, for pages
    // published from Claude Code, claude.ai/code/artifact/<uuid>.
    markdown.match(/https:\/\/claude\.ai\/(?:public\/|code\/)?artifacts?\/[A-Za-z0-9_-]+/)?.[0] ??
    null;
  // A keyword is one short word. Anything long or punctuated is a sentence the
  // pattern caught by accident.
  const clean = [...keywords]
    .map((k) => k.replace(/[*＊`]/g, "").trim())
    .filter((k) => k && k.length <= 12 && !/[，。、,.!?！？:：\s]/.test(k));
  return { keywords: [...new Set(clean)], url };
}

/** "施工包_K38_Git存檔.md" → "K38_Git存檔"; also the bare "K38" for loose matching. */
function packStem(file: string): string {
  return basename(file, extname(file)).replace(/^施工包_/, "");
}
const seriesId = (stem: string) => stem.match(/^([A-Za-z]+\d+)/)?.[1]?.toUpperCase() ?? null;

export function collectPages(pagesDir: string, packsDir?: string): PageRecord[] {
  const packs = new Map<string, { keywords: string[]; url: string | null }>();
  if (packsDir) {
    for (const file of readdirSync(packsDir)) {
      if (!/^施工包_.+\.md$/.test(file) || file.includes("底稿") || file.includes(".bak")) continue;
      const parsed = parsePack(readFileSync(join(packsDir, file), "utf8"));
      const stem = packStem(file);
      packs.set(stem, parsed);
      const id = seriesId(stem);
      if (id && !packs.has(id)) packs.set(id, parsed);
    }
  }

  const pages: PageRecord[] = [];
  for (const file of readdirSync(pagesDir).sort()) {
    if (extname(file).toLowerCase() !== ".html" || file.includes(".bak")) continue;
    const html = readFileSync(join(pagesDir, file), "utf8");
    const key = basename(file, extname(file));
    const pack = packs.get(key) ?? packs.get(seriesId(key) ?? "") ?? { keywords: [], url: null };
    pages.push({
      key,
      title: pageTitle(html, key),
      url: pack.url,
      keywords: pack.keywords,
      content: htmlToText(html),
    });
  }
  return pages;
}

/**
 * Pages saved straight from their published link. `urls.json` in the folder
 * maps each file name to that link, and the link is what a campaign is matched
 * on, so these need no write-up and no keyword.
 */
export function collectLinkedPages(dir: string): PageRecord[] {
  const urls = JSON.parse(readFileSync(join(dir, "urls.json"), "utf8")) as Record<
    string,
    string
  >;
  return Object.entries(urls).map(([file, url]) => {
    const html = readFileSync(join(dir, file), "utf8");
    const key = `link_${basename(file, extname(file))}`;
    return { key, title: pageTitle(html, key), url, keywords: [], content: htmlToText(html) };
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const pagesDir = arg("pages");
  if (!pagesDir) {
    console.error(
      "Usage: tsx scripts/triage-sync-pages.ts --pages <dir> [--packs <dir>] [--extra <dir>] [--out <file>] [--account <username>] [--write]"
    );
    process.exit(1);
  }

  const extraDir = arg("extra");
  const pages = [
    ...collectPages(pagesDir, arg("packs")),
    ...(extraDir ? collectLinkedPages(extraDir) : []),
  ];
  for (const p of pages) {
    console.log(
      [p.key, `${p.content.length} chars`, p.keywords.join("/") || "(no keyword)", p.url ? "url ok" : "(no url)"].join(" | ")
    );
  }
  const unmatched = pages.filter((p) => p.keywords.length === 0 && !p.url).length;
  console.log(`\n${pages.length} pages, ${unmatched} without a keyword or URL`);

  const out = arg("out");
  if (out) writeFileSync(out, JSON.stringify(pages, null, 2), "utf8");

  if (!process.argv.includes("--write")) {
    console.log("Preview only. Re-run with --write to save to the database.");
    return;
  }

  const { prisma } = await import("../lib/db/client");

  const wanted = arg("account")?.replace(/^@/, "");
  const accounts = await prisma.instagramAccount.findMany({
    where: wanted ? { username: wanted } : {},
    select: { id: true, username: true },
  });
  if (accounts.length !== 1) {
    console.error(
      wanted
        ? `No connected account named @${wanted}.`
        : `Found ${accounts.length} connected accounts; pick one with --account <username>.`
    );
    process.exitCode = 1;
    return;
  }
  const account = accounts[0];

  for (const p of pages) {
    await prisma.triagePage.upsert({
      where: { instagramAccountId_key: { instagramAccountId: account.id, key: p.key } },
      create: { ...p, instagramAccountId: account.id },
      update: { title: p.title, url: p.url, keywords: p.keywords, content: p.content },
    });
  }
  console.log(`Saved ${pages.length} pages for @${account.username}.`);
}

// Only run when invoked directly, so the parsers above can be imported in tests.
if (process.argv[1] && basename(process.argv[1]).startsWith("triage-sync-pages")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
