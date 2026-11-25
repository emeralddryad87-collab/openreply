import { prisma } from "@/lib/db/client";
import { sendDirectMessage } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { answerFromPages, isAiConfigured } from "@/lib/triage/ai";
import {
  answersNo,
  answersYes,
  asksForHuman,
  asksIfAutomated,
  classifyCanned,
  looksLikeAutoReply,
} from "@/lib/triage/classify";
import {
  AI_DISCLOSURE_REPLY,
  AI_REPLY_SUFFIX,
  CANNED_REPLIES,
  HANDOFF_REPLY,
  getDailyReplyCap,
  getEligibleDays,
  parseTriageMode,
  type TriageMode,
} from "@/lib/triage/config";
import { notifyOwner } from "@/lib/triage/notify";
import {
  clearAskedHuman,
  handedOffRecently,
  markAskedHuman,
  markBotActivity,
  markHandoff,
  ownerRepliedRecently,
  wasAskedHuman,
} from "@/lib/triage/state";

/**
 * DM triage: decide what to do with an inbound DM that no campaign keyword
 * claimed.
 *
 *   "no questions" / "all clear" / "got it"  → the sign-off line
 *   "thanks"                                 → the thanks line
 *   "I followed you"                         → the tap-the-button line
 *   a bare "ok" / "可以" / 👍                 → the sign-off line as well
 *   "I do not get it" / "it is hard"         → "which step are you stuck on?"
 *   new to AI, asks where to begin           → the where-to-start line
 *   "can I do this on my phone?"             → the use-a-computer line
 *   a picture or a file                      → no reply; the owner is told
 *   the other account's own auto-reply       → nothing: no reply, no notice
 *   a question the page answers              → an answer written from that page only
 *   "is this an AI?"                         → "yes", and "do you want the owner?"
 *   wants the owner (or says yes to that)    → the owner is told; one line says so
 *   collaboration, courses, anything else    → no reply; the owner is told
 *
 * Each kind is recognised by a phrase list first and, in the modes that use
 * one, by the model. Only the page answer is model-written text; every other
 * reply is a fixed line from config.ts.
 *
 * Guard rails, in the order they apply:
 *   - Off unless switched on for the account (Settings page).
 *   - Replies to Stories are left alone.
 *   - Only people this account sent a campaign DM to recently are eligible.
 *     Everyone else — friends, brands, strangers — is not touched and not
 *     logged, so private conversations never end up in this app's tables.
 *   - Each message is claimed with a log row before anything is sent, so it
 *     can be handled at most once even if the job runs twice.
 *   - If the owner replied by hand in the last 24h, or the sender asked for the
 *     owner, nothing is sent to that person; a real question from them is
 *     still flagged to the owner.
 *   - The same fixed line is not sent to the same person twice within 24h.
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
  /** Set when the DM is a picture, video, voice note or file with no text. */
  attachmentKind?: "image" | "video" | "audio" | "file";
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
  ack: "只是回應一聲",
  ownerActive: "你 24 小時內親手回過這個人，沒有自動回",
  handedOff: "對方說要找本人，已經通知過你，這段時間不自動回",
  cap: "今天自動回這個人的次數到上限了",
  repeated: "同一句 24 小時內回過這個人了，不重複",
  notCanned: "不是固定回覆能處理的",
  aiNotConfigured: "AI 還沒設定，沒辦法照頁面回答",
  aiFailed: "AI 呼叫失敗",
  noToken: "這個帳號沒有可用的 Instagram 授權",
  sendFailed: "發送失敗",
  signOffUnsure: "看起來只是收尾，但訊息比較長或帶了問句，交給你確認",
  askedIfAi: "對方問是不是 AI：照實回答，並問要不要找本人",
  wantsHuman: "對方要找本人",
  wantsHumanYes: "問過要不要找本人，對方說要",
  declinedHuman: "問過要不要找本人，對方說不用",
  attachment: "對方傳了圖片或檔案，AI 看不到內容",
  stillStuck: "問過哪一步卡住了，對方還是說不會",
  autoReply: "對方帳號的自動回覆，不用處理",
} as const;

// How a picture or file is shown in the log and in the notice to the owner.
const ATTACHMENT_LABEL = {
  image: "［圖片］",
  video: "［影片］",
  audio: "［語音］",
  file: "［檔案］",
} as const;

// Kinds whose reply is a courtesy. Going without one costs nothing, so when
// the daily cap is reached these are simply not sent; anything else that hits
// the cap is a real question, and the owner is told about it instead.
const COURTESY = new Set(["no_problem", "thanks", "ack", "followed"]);

const SHORT_MESSAGE_MAX_CHARS = 60;
const ASKS_SOMETHING = /[?？嗎吗]|請問|请问|怎麼|怎么|為什麼|为什么|如何/;

const isShort = (text: string) => text.trim().length <= SHORT_MESSAGE_MAX_CHARS;

/**
 * Short and asking nothing: the only messages a fixed line may answer on the
 * model's say-so. Anything longer, or with a question in it, is more than a
 * sign-off whatever the model made of it, and goes to the owner.
 */
function isPlainSignOff(text: string): boolean {
  return isShort(text) && !ASKS_SOMETHING.test(text);
}

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
          followUpEnabled: true,
          followUpMessage: true,
          trackedLinks: { select: { destinationUrl: true } },
        },
      },
    },
  });
  if (priorLogs.length === 0) return null;
  const senderName = priorLogs.find((l) => l.commenterName)?.commenterName ?? null;

  // The question the latest campaign asks after delivering its link ("does
  // that make sense?"). A one-word DM is very often the answer to it.
  const latest = priorLogs[0].automation;
  const asked =
    latest.followUpEnabled && latest.followUpMessage?.trim()
      ? latest.followUpMessage.trim()
      : null;

  // A picture or file has no words; show what it was instead.
  const shownText = input.attachmentKind
    ? ATTACHMENT_LABEL[input.attachmentKind]
    : messageText;

  // Claim the message. The unique key on (account, message) makes this the
  // lock: a second run of the same message fails here, before it can send.
  let logId: string;
  try {
    const claim = await prisma.triageLog.create({
      data: {
        instagramAccountId: account.id,
        senderId,
        messageId,
        messageText: shownText.slice(0, 2000),
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

  // Tell the owner. A person's messages are stacked into one notice, and the
  // phone rings at most once per person inside the cooldown (see notify.ts);
  // `ring` is for the notice that must not arrive silently.
  const tellOwner = (reason: string, ring = false) =>
    notifyOwner(
      {
        instagramAccountId: account.instagramId,
        senderId,
        senderName,
        messageText: shownText,
        reason,
      },
      { ring }
    );

  const notify = (reason: string) => tellOwner(reason);

  // An away message or bot menu from the other account. Nobody wrote it, so it
  // gets no reply and no notice — checked before anything else, because it
  // often arrives seconds after the owner's own reply, in a conversation that
  // would otherwise be flagged to them.
  if (!input.attachmentKind && looksLikeAutoReply(messageText)) {
    return record("auto_reply", "IGNORED", { reason: REASON.autoReply });
  }

  const canned = input.attachmentKind ? null : classifyCanned(messageText);

  const [ownerActive, handedOff, askedHuman] = await Promise.all([
    ownerRepliedRecently(account.instagramId, senderId),
    handedOffRecently(account.instagramId, senderId),
    wasAskedHuman(account.instagramId, senderId),
  ]);

  // The conversation is the owner's — they replied by hand, or the sender
  // asked for them. Nothing automatic is sent. A message that is more than a
  // pleasantry is still flagged, so a follow-up question does not get buried
  // under newer DMs.
  if (ownerActive || handedOff) {
    const reason = ownerActive ? REASON.ownerActive : REASON.handedOff;
    if (!canned) await notify(reason);
    return record(canned ?? "other", "SKIPPED_OWNER_ACTIVE", { reason });
  }

  // A picture or a file: usually the screenshot someone was asked for. Nobody
  // but the owner can look at it.
  if (input.attachmentKind) {
    await notify(REASON.attachment);
    return record("attachment", "ESCALATED", { reason: REASON.attachment });
  }

  // What counts as "already sent" to this person. A dry run counts its own
  // would-be replies, so it shows the limits exactly as the live modes apply them.
  const sentToSender = {
    instagramAccountId: account.id,
    senderId,
    action: mode === "dry_run" ? { in: ["REPLIED", "DRY_RUN"] } : "REPLIED",
    createdAt: { gte: new Date(Date.now() - DAY_MS) },
  };

  const deliver = async (
    category: string,
    replyText: string,
    extra: { pageKey?: string | null; reason?: string | null } = {}
  ): Promise<TriageOutcome> => {
    const repliesToday = await prisma.triageLog.count({ where: sentToSender });
    if (repliesToday >= getDailyReplyCap()) {
      if (!COURTESY.has(category)) await notify(REASON.cap);
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

  // A fixed line is said once. Sending "feel free to ask" again when the
  // sender answers it with "好的" would turn two polite people into a loop.
  // What happens instead depends on the line: a courtesy is just left out; for
  // a line that offered help, saying nothing would strand the sender, so the
  // owner takes over.
  const sayOnce = async (
    category: string,
    replyText: string,
    reason: string | null = null,
    whenRepeated: "ignore" | "tell-owner" | "owner-already-told" = "ignore"
  ): Promise<TriageOutcome> => {
    const already = await prisma.triageLog.count({
      where: { ...sentToSender, replyText },
    });
    if (already === 0) return deliver(category, replyText, { reason });
    if (whenRepeated === "ignore") {
      return record(category, "IGNORED", { reason: reason ?? REASON.repeated });
    }
    if (whenRepeated === "tell-owner") await notify(reason ?? REASON.repeated);
    return record(category, "ESCALATED", { reason: reason ?? REASON.repeated });
  };

  // "Which step are you stuck on?" is asked once. If the sender still cannot
  // say, the bot has nothing more to offer and the owner hears about it.
  const askWhereStuck = (reason: string | null = null) =>
    prisma.triageLog
      .count({ where: { ...sentToSender, replyText: CANNED_REPLIES.stuck } })
      .then((asked) =>
        sayOnce(
          "stuck",
          CANNED_REPLIES.stuck,
          asked > 0 ? REASON.stillStuck : reason,
          "tell-owner"
        )
      );

  // "Is this an AI?" is always answered with yes, and with the offer of the
  // owner in person. The offer only stays open if the sender actually saw it.
  const disclose = async (reason: string): Promise<TriageOutcome> => {
    const outcome = await deliver("asks_if_ai", AI_DISCLOSURE_REPLY, { reason });
    if (outcome.action === "REPLIED") {
      await markAskedHuman(account.instagramId, senderId);
    }
    return outcome;
  };

  // The sender wants the owner. The phone rings for this one even if it rang
  // for the same person a minute ago, and from here on the conversation is
  // the owner's.
  const handOff = async (reason: string): Promise<TriageOutcome> => {
    await tellOwner(reason, true);
    if (mode !== "dry_run") {
      await markHandoff(account.instagramId, senderId);
      await clearAskedHuman(account.instagramId, senderId);
    }
    return sayOnce("wants_human", HANDOFF_REPLY, reason, "owner-already-told");
  };

  // We asked "do you want the owner?" — a plain yes or no answers that question.
  if (askedHuman) {
    if (answersYes(messageText) || asksForHuman(messageText)) {
      return handOff(REASON.wantsHumanYes);
    }
    if (answersNo(messageText)) {
      await clearAskedHuman(account.instagramId, senderId);
      return sayOnce("no_problem", CANNED_REPLIES.no_problem, REASON.declinedHuman);
    }
  }

  if (asksIfAutomated(messageText)) return disclose(REASON.askedIfAi);
  if (asksForHuman(messageText)) return handOff(REASON.wantsHuman);

  // A bare "可以" or 👍 is nearly always the answer to "does that make sense?",
  // so it closes the same way as "no questions". Said once: if the line has
  // already gone out, the acknowledgement of it is left alone.
  if (canned === "ack") {
    return sayOnce("ack", CANNED_REPLIES.no_problem, REASON.ack);
  }
  if (canned === "stuck") return askWhereStuck();
  if (canned) {
    return sayOnce(canned, CANNED_REPLIES[canned]);
  }

  // Not one of the fixed cases. The model only runs where its verdict could be
  // used (full) or reviewed (dry_run); in canned mode this goes to the owner.
  let escalationReason: string = REASON.notCanned;
  if (mode === "full" || mode === "dry_run") {
    if (!isAiConfigured()) {
      escalationReason = REASON.aiNotConfigured;
    } else {
      const pages = await findPagesForSender(account.id, priorLogs);
      try {
        const verdict = await answerFromPages(
          messageText,
          pages.map((p) => ({ title: p.title, content: p.content })),
          asked
        );
        // For everything but a page answer the model only picks the kind; the
        // text that goes out is ours.
        switch (verdict.category) {
          case "page_question":
            return deliver("page_question", verdict.answer + AI_REPLY_SUFFIX, {
              pageKey: pages[0]?.key ?? null,
              reason: verdict.reason,
            });
          case "no_question":
          case "thanks": {
            if (isPlainSignOff(messageText)) {
              const kind = verdict.category === "no_question" ? "no_problem" : "thanks";
              return sayOnce(kind, CANNED_REPLIES[kind], verdict.reason);
            }
            escalationReason = REASON.signOffUnsure;
            break;
          }
          case "stuck":
            return askWhereStuck(verdict.reason);
          case "where_to_start":
            return sayOnce("where_to_start", CANNED_REPLIES.where_to_start, verdict.reason);
          case "device":
            return sayOnce("use_computer", CANNED_REPLIES.use_computer, verdict.reason);
          case "asks_if_ai":
            // A long message that also asks this has more in it; the owner reads it.
            if (isShort(messageText)) return disclose(verdict.reason || REASON.askedIfAi);
            escalationReason = verdict.reason;
            break;
          case "wants_human":
            return handOff(verdict.reason || REASON.wantsHuman);
          case "auto_reply":
            return record("auto_reply", "IGNORED", {
              reason: verdict.reason || REASON.autoReply,
            });
          default:
            escalationReason = verdict.reason;
        }
      } catch (error) {
        // The model's error text names the model and status only (see ai.ts).
        escalationReason =
          error instanceof Error ? error.message.slice(0, 200) : REASON.aiFailed;
      }
    }
  }

  // Collaboration, courses, complaints, anything unclear: no reply goes out,
  // the owner hears about it.
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
