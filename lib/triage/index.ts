import { prisma } from "@/lib/db/client";
import { sendDirectMessage } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { answerFromPages, isAiConfigured } from "@/lib/triage/ai";
import { classifyCanned } from "@/lib/triage/classify";
import {
  AI_REPLY_SUFFIX,
  CANNED_REPLIES,
  getDailyReplyCap,
  getEligibleDays,
  parseTriageMode,
  type TriageMode,
} from "@/lib/triage/config";
import { notifyOwner } from "@/lib/triage/notify";
import {
  claimNotifySlot,
  markBotActivity,
  ownerRepliedRecently,
} from "@/lib/triage/state";

/**
 * DM triage: decide what to do with an inbound DM that no campaign keyword
 * claimed.
 *
 *   "no questions" / "thanks"      → one fixed reply
 *   a question the page answers    → an answer written from that page only
 *   anything else                  → no reply; the owner is told
 *
 * Guard rails, in the order they apply:
 *   - Off unless switched on for the account (Settings page).
 *   - Replies to Stories are left alone.
 *   - Only people this account sent a campaign DM to recently are eligible.
 *     Everyone else — friends, brands, strangers — is not touched and not
 *     logged, so private conversations never end up in this app's tables.
 *   - Each message is claimed with a log row before anything is sent, so it
 *     can be handled at most once even if the job runs twice.
 *   - If the owner replied by hand in the last 24h, nothing is sent to that
 *     person; a real question from them is still flagged to the owner.
 *   - A person gets at most N automatic replies per 24h.
 *   - In dry_run nothing is sent; the log records what would have been.
 *
 * Nothing here throws: a triage failure must never fail the job or trigger a
 * retry that could send a second reply.
 */

export interface TriageInput {
  /** Instagram-side account id, as carried by the webhook. */
  instagramAccountId: string;
  messageId: string;
  messageText: string;
  senderId: string;
  isStoryReply?: boolean;
}

export type TriageAction =
  | "REPLIED"
  | "DRY_RUN"
  | "ESCALATED"
  | "IGNORED"
  | "SKIPPED_OWNER_ACTIVE"
  | "SKIPPED_CAP"
  | "FAILED";

export interface TriageOutcome {
  category: string;
  action: TriageAction;
  replyText: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Why a message was handled the way it was. Shown to the owner on the Settings
// page and in the notice sent to their phone, so written in their language.
const REASON = {
  ack: "只是回應，不用回",
  ownerActive: "你 24 小時內親手回過這個人，沒有自動回",
  cap: "今天自動回這個人的次數到上限了",
  notCanned: "不是固定回覆能處理的",
  aiNotConfigured: "AI 還沒設定，沒辦法照頁面回答",
  aiFailed: "AI 呼叫失敗",
  noToken: "這個帳號沒有可用的 Instagram 授權",
  sendFailed: "發送失敗",
} as const;

/** Prisma's code for "a row with this unique key already exists". */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

export async function runTriage(input: TriageInput): Promise<TriageOutcome | null> {
  try {
    return await triage(input);
  } catch (error) {
    console.error("[Triage] Unexpected failure:", error);
    return null;
  }
}

async function triage(input: TriageInput): Promise<TriageOutcome | null> {
  const { instagramAccountId, messageId, messageText, senderId } = input;
  if (input.isStoryReply) return null;

  // Read fresh, not through the mode cache: this is the one place where acting
  // on a stale "on" would actually send something.
  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: instagramAccountId },
    select: {
      id: true,
      instagramId: true,
      accessToken: true,
      triageSetting: { select: { mode: true } },
    },
  });
  if (!account) return null;

  const mode: TriageMode = parseTriageMode(account.triageSetting?.mode);
  if (mode === "off") return null;

  // Eligibility: only people we sent a campaign DM to recently. Checked before
  // anything is written, so an ordinary conversation leaves no trace here.
  const priorLogs = await prisma.dmLog.findMany({
    where: {
      instagramAccountId: account.id,
      commenterId: senderId,
      status: "SENT",
      dmSentAt: { gte: new Date(Date.now() - getEligibleDays() * DAY_MS) },
    },
    orderBy: { dmSentAt: "desc" },
    take: 3,
    select: {
      commenterName: true,
      automation: {
        select: {
          keywords: true,
          trackedLinks: { select: { destinationUrl: true } },
        },
      },
    },
  });
  if (priorLogs.length === 0) return null;
  const senderName = priorLogs.find((l) => l.commenterName)?.commenterName ?? null;

  // Claim the message. The unique key on (account, message) makes this the
  // lock: a second run of the same message fails here, before it can send.
  let logId: string;
  try {
    const claim = await prisma.triageLog.create({
      data: {
        instagramAccountId: account.id,
        senderId,
        messageId,
        messageText: messageText.slice(0, 2000),
        category: "pending",
        action: "PENDING",
        mode,
      },
      select: { id: true },
    });
    logId = claim.id;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }

  const record = async (
    category: string,
    action: TriageAction,
    extra: { replyText?: string | null; pageKey?: string | null; reason?: string | null } = {}
  ): Promise<TriageOutcome> => {
    await prisma.triageLog.update({
      where: { id: logId },
      data: {
        category,
        action,
        replyText: extra.replyText ?? null,
        pageKey: extra.pageKey ?? null,
        reason: extra.reason ?? null,
      },
    });
    return { category, action, replyText: extra.replyText ?? null };
  };

  // Tell the owner, at most once per person inside the cooldown.
  const notify = async (reason: string) => {
    if (await claimNotifySlot(account.instagramId, senderId)) {
      await notifyOwner({
        instagramAccountId: account.instagramId,
        senderId,
        senderName,
        messageText,
        reason,
      });
    }
  };

  const canned = classifyCanned(messageText);
  if (canned === "ack") {
    return record("ack", "IGNORED", { reason: REASON.ack });
  }

  // The owner is handling this person: no automatic reply of any kind. A
  // message that is more than a pleasantry is still flagged, so a follow-up
  // question does not get buried under newer DMs.
  if (await ownerRepliedRecently(account.instagramId, senderId)) {
    if (!canned) await notify(REASON.ownerActive);
    return record(canned ?? "other", "SKIPPED_OWNER_ACTIVE", {
      reason: REASON.ownerActive,
    });
  }

  // A dry run counts its own would-be replies, so it shows the cap exactly as
  // the live modes would apply it.
  const repliesToday = await prisma.triageLog.count({
    where: {
      instagramAccountId: account.id,
      senderId,
      action: mode === "dry_run" ? { in: ["REPLIED", "DRY_RUN"] } : "REPLIED",
      createdAt: { gte: new Date(Date.now() - DAY_MS) },
    },
  });
  const overCap = repliesToday >= getDailyReplyCap();

  const deliver = async (
    category: string,
    replyText: string,
    extra: { pageKey?: string | null; reason?: string | null } = {}
  ): Promise<TriageOutcome> => {
    if (overCap) {
      return record(category, "SKIPPED_CAP", {
        ...extra,
        replyText,
        reason: REASON.cap,
      });
    }
    if (mode === "dry_run") {
      return record(category, "DRY_RUN", { ...extra, replyText });
    }
    try {
      if (!account.accessToken) throw new Error(REASON.noToken);
      // So the echo of this reply is recognised as ours, not as the owner
      // typing — otherwise our own message would silence triage for a day.
      await markBotActivity(account.instagramId, senderId);
      await sendDirectMessage(
        decryptToken(account.accessToken),
        account.instagramId,
        senderId,
        replyText
      );
    } catch (error) {
      return record(category, "FAILED", {
        ...extra,
        replyText,
        reason: error instanceof Error ? error.message.slice(0, 300) : REASON.sendFailed,
      });
    }
    return record(category, "REPLIED", { ...extra, replyText });
  };

  if (canned === "no_problem" || canned === "thanks") {
    return deliver(canned, CANNED_REPLIES[canned]);
  }

  // Not a stock reply. The model only runs where its answer could be used
  // (full) or reviewed (dry_run); in canned mode this goes straight to a human.
  let escalationReason: string = REASON.notCanned;
  if (mode === "full" || mode === "dry_run") {
    if (!isAiConfigured()) {
      escalationReason = REASON.aiNotConfigured;
    } else {
      const pages = await findPagesForSender(account.id, priorLogs);
      try {
        const verdict = await answerFromPages(
          messageText,
          pages.map((p) => ({ title: p.title, content: p.content }))
        );
        if (verdict.category === "page_question") {
          return deliver("page_question", verdict.answer + AI_REPLY_SUFFIX, {
            pageKey: pages[0]?.key ?? null,
            reason: verdict.reason,
          });
        }
        escalationReason = verdict.reason;
      } catch (error) {
        // The model's error text names the model and status only (see ai.ts).
        escalationReason =
          error instanceof Error ? error.message.slice(0, 200) : REASON.aiFailed;
      }
    }
  }

  // Escalate: no reply goes out, the owner hears about it.
  await notify(escalationReason);
  return record("other", "ESCALATED", { reason: escalationReason });
}

type PriorLog = {
  automation: {
    keywords: string[];
    trackedLinks: { destinationUrl: string }[];
  };
};

/**
 * The pages this sender was most likely sent, newest campaign first. A page
 * is matched by its URL (the campaign's tracked link) and, failing that, by
 * the campaign keyword.
 */
export async function findPagesForSender(accountId: string, priorLogs: PriorLog[]) {
  const urls = new Set<string>();
  const keywords = new Set<string>();
  for (const log of priorLogs) {
    for (const link of log.automation.trackedLinks) {
      if (link.destinationUrl) urls.add(link.destinationUrl);
    }
    for (const keyword of log.automation.keywords) keywords.add(keyword);
  }
  if (urls.size === 0 && keywords.size === 0) return [];

  const candidates = await prisma.triagePage.findMany({
    where: {
      instagramAccountId: accountId,
      OR: [
        { url: { in: [...urls] } },
        { keywords: { hasSome: [...keywords] } },
      ],
    },
    take: 12,
    select: { key: true, title: true, content: true, url: true, keywords: true },
  });

  // Rank by the most recent campaign that points at the page. A URL match is
  // exact; a keyword match can be shared by several pages, so it ranks behind
  // any URL match from the same campaign.
  const rank = (page: { url: string | null; keywords: string[] }) => {
    for (let i = 0; i < priorLogs.length; i++) {
      const { trackedLinks, keywords: campaignKeywords } = priorLogs[i].automation;
      if (trackedLinks.some((l) => l.destinationUrl === page.url)) return i * 2;
      if (campaignKeywords.some((k) => page.keywords.includes(k))) return i * 2 + 1;
    }
    return priorLogs.length * 2;
  };
  return candidates.sort((x, y) => rank(x) - rank(y)).slice(0, 2);
}
