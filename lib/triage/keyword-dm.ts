import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { getTriageModeFor } from "@/lib/triage/settings";
import { handedOffRecently, ownerRepliedRecently } from "@/lib/triage/state";

/**
 * A campaign keyword sent as a DM.
 *
 * A reel says "comment PDF and I will send you the link". Some people send
 * "PDF" as a direct message instead, or ask for it ("請問外掛呢？"). The
 * campaigns themselves fire on any comment under their post and store no
 * keyword, so nothing in them recognises that DM. The keywords are on file
 * with the landing pages, though, and each page's link identifies the campaign
 * that sends it. This module makes that connection, so the worker can answer
 * the DM with the campaign — follow gate, link button and follow-up included —
 * exactly as it would answer the comment.
 *
 * Only a message that IS the keyword, or a plain request for it, counts.
 * "PDF 要怎麼轉" and "外掛打不開" are a question and a complaint; they go on to
 * triage, and the complaint reaches the owner.
 */

const normalize = (text: string) =>
  (text ?? "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");

// What people put in front of a keyword when they ask for its link…
const LEAD = [
  "請問", "请问", "不好意思", "你好", "您好", "老師", "老师", "hi", "hello",
  "我要", "我想要", "想要", "要", "求", "領", "领", "領取", "领取", "我要領", "我要领", "想領", "想领",
  "給我", "给我", "可以給我", "可以给我", "能給我", "能给我", "請給我", "请给我",
  "請傳", "请传", "可以傳", "可以传", "再傳一次", "再传一次", "留言", "我留言", "我留言了",
];
// …and after it.
const TAIL = [
  "呢", "嗎", "吗", "連結", "链接", "的連結", "的链接", "連結呢", "链接呢", "的連結呢", "的链接呢",
  "在哪", "在哪裡", "在哪里", "可以嗎", "可以吗", "謝謝", "谢谢", "謝謝你", "谢谢你", "感謝", "感谢",
  "麻煩了", "麻烦了", "please", "pls", "thanks", "thankyou",
];

const alternation = (words: string[]) =>
  [...new Set(words.map(normalize))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .join("|");

const LEADS = alternation(LEAD);
const TAILS = alternation(TAIL);
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MAX_ASK_LENGTH = 24;

/**
 * The keyword this message is, or asks for; null if it is anything more.
 * Longer keywords are tried first, so "claude code" wins over "code".
 */
export function keywordAsk(text: string, keywords: string[]): string | null {
  const message = normalize(text);
  if (!message || message.length > MAX_ASK_LENGTH) return null;

  const candidates = [...new Set(keywords)]
    .map((keyword) => ({ keyword, norm: normalize(keyword) }))
    .filter((k) => k.norm)
    .sort((a, b) => b.norm.length - a.norm.length);

  for (const { keyword, norm } of candidates) {
    const pattern = new RegExp(`^(?:${LEADS})*${escapeRegExp(norm)}(?:${TAILS})*$`, "u");
    if (pattern.test(message)) return keyword;
  }
  return null;
}

export interface KeywordCampaign {
  automationId: string;
  keyword: string;
}

const ONCE_SECONDS = 24 * 60 * 60;

/**
 * The campaign to answer this DM with, or null.
 *
 * Null whenever the answer should not be automatic: triage is not sending
 * (off or dry run), the message is not a keyword ask, the owner is in this
 * conversation (a keyword said in passing to a person is not a request to a
 * bot), no active campaign sends that keyword's page, or this person already
 * got this campaign by keyword today — a second "PDF" means the first did not
 * work, which is the owner's to look at. Never throws: a failure here must leave keyword campaigns and
 * triage working as they were.
 */
export async function findKeywordCampaign(input: {
  /** Instagram-side account id, as carried by the webhook. */
  instagramAccountId: string;
  senderId: string;
  messageText: string;
}): Promise<KeywordCampaign | null> {
  try {
    const { instagramAccountId, senderId, messageText } = input;
    const length = normalize(messageText).length;
    if (length === 0 || length > MAX_ASK_LENGTH) return null;

    const mode = await getTriageModeFor(instagramAccountId);
    if (mode !== "canned" && mode !== "full") return null;

    const account = await prisma.instagramAccount.findUnique({
      where: { instagramId: instagramAccountId },
      select: { id: true },
    });
    if (!account) return null;

    // The conversation is the owner's: stay out, as triage does.
    const [ownerActive, handedOff] = await Promise.all([
      ownerRepliedRecently(instagramAccountId, senderId),
      handedOffRecently(instagramAccountId, senderId),
    ]);
    if (ownerActive || handedOff) return null;

    const pages = await prisma.triagePage.findMany({
      where: { instagramAccountId: account.id, keywords: { isEmpty: false } },
      select: { url: true, keywords: true },
    });
    const keyword = keywordAsk(
      messageText,
      pages.flatMap((page) => page.keywords)
    );
    if (!keyword) return null;

    const wanted = normalize(keyword);
    const urls = pages
      .filter((page) => page.url && page.keywords.some((k) => normalize(k) === wanted))
      .map((page) => page.url as string);
    if (urls.length === 0) return null;

    const campaigns = await prisma.automation.findMany({
      where: {
        isActive: true,
        instagramAccountId: account.id,
        trackedLinks: { some: { destinationUrl: { in: urls } } },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (campaigns.length === 0) return null;

    // Several campaigns can share a keyword. The one this person already took
    // part in is the one they mean; failing that, the newest.
    const theirs = await prisma.dmLog.findFirst({
      where: {
        commenterId: senderId,
        automationId: { in: campaigns.map((campaign) => campaign.id) },
      },
      orderBy: { createdAt: "desc" },
      select: { automationId: true },
    });
    const automationId = theirs?.automationId ?? campaigns[0].id;

    const first = await getRedisConnection().set(
      `triage:keyword-dm:${instagramAccountId}:${senderId}:${automationId}`,
      "1",
      "EX",
      ONCE_SECONDS,
      "NX"
    );
    if (first !== "OK") return null;

    return { automationId, keyword };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    console.error(`[Triage] Keyword DM lookup failed (${name})`);
    return null;
  }
}
