import { prisma } from "@/lib/db/client";
import { sendDirectMessage } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { POSTBACK_JOB_NAME, getDMQueue } from "@/lib/queue/client";
import { answerFromPages, isAiConfigured, type Turn } from "@/lib/triage/ai";
import {
  answersNo,
  answersYes,
  asksForHuman,
  asksIfAutomated,
  classifyCanned,
  looksLikeAutoReply,
} from "@/lib/triage/classify";
import { dropPendingDrafts } from "@/lib/triage/draft-store";
import { draftReply } from "@/lib/triage/draft";
import {
  AI_DISCLOSURE_REPLY,
  BATCH_WINDOW_SECONDS,
  CANNED_REPLIES,
  HANDOFF_REPLY,
  INVITE_REPEAT_SECONDS,
  OPEN_QUESTION_SECONDS,
  QUOTA_TUTORIAL_PAGE_KEY,
  getDailyReplyCap,
  getEligibleDays,
  parseTriageMode,
  type TriageMode,
} from "@/lib/triage/config";
import { notifyOwner } from "@/lib/triage/notify";
import type { NoticeDraft } from "@/lib/triage/state";
import {
  claimResend,
  clearAskedHuman,
  clearOffered,
  getOffered,
  handedOffRecently,
  markAskedHuman,
  markBotActivity,
  markHandoff,
  markOffered,
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
 *   "I never got the link" / "no button"     → the link again if they follow,
 *                                              the follow button if they do not
 *   "I do not get it" / "it is hard"         → "which step are you stuck on?"
 *   new to AI, asks where to begin           → the where-to-start line
 *   "can I do this on my phone?"             → the use-a-computer line
 *   their Claude quota keeps running out     → an offer of the quota tutorial,
 *                                              sent if they say yes
 *   a picture or a file                      → no reply; the owner is told
 *   the other account's own auto-reply       → nothing: no reply, no notice
 *   a question the page or the owner's       → an answer in one sentence,
 *     standing answers settle                  written from those only
 *   "is this an AI?"                         → "yes", and "do you want the owner?"
 *   wants the owner (or says yes to that)    → the owner is told; one line says so
 *   collaboration, courses, anything else    → no reply; the owner is told
 *
 * Each kind is recognised by a phrase list first and, in the modes that use
 * one, by the model. Only the answer to a question is model-written text;
 * every other reply is a fixed line from config.ts or a fixed action.
 *
 * A typed message is answered after a short wait (getReplyDelaySeconds): the
 * worker claims it at once with claimTriage and comes back with resumeTriage.
 * Messages a person sends inside that wait are answered together, once, by the
 * turn of the last one; the earlier ones are marked as merged into it.
 *
 * The model is shown the earlier turns of the conversation. A sign-off line
 * is never sent while a question of the same person is still waiting for the
 * owner, and "feel free to ask" is not said twice in a row.
 *
 * When a message is handed to the owner in full mode, the notice carries a
 * draft reply (draft.ts). The draft is never sent from here: it goes out only
 * if the owner presses the button under the notice (owner-actions.ts).
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
 *   - A link is re-sent once a day; the second "I never got it" is the owner's.
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
  | "MERGED"
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
  openQuestion: "他前面的問題還在等你回，先不發收尾句",
  missingLink: "對方說沒收到連結：有追蹤就重傳連結，沒追蹤就重傳按鈕那一則",
  resentAlready: "今天已經重傳過一次，對方還是說沒收到",
  noCampaign: "找不到可以重傳的活動",
  queueFailed: "重傳沒有排進去",
  offerTaken: "問過要不要省額度的教學，對方說要",
  merged: "對方接著又傳了新的，跟下一則一起回",
  switchedOff: "處理之前自動分流被關掉了",
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

// What the log holds in place of a reply when the reply was a campaign message
// sent by the worker rather than a line of text.
const RESEND_MARK = "〔重傳連結〕";
const TUTORIAL_MARK = "〔傳省額度教學〕";

// The lines that end with "feel free to ask".
const INVITATIONS: string[] = [CANNED_REPLIES.no_problem, CANNED_REPLIES.thanks];

// What the sender was told counts as part of the conversation so far.
const SAID = new Set(["REPLIED", "SENT_BY_OWNER"]);

const SHORT_MESSAGE_MAX_CHARS = 60;
const ASKS_SOMETHING = /[?？嗎吗]|請問|请问|怎麼|怎么|為什麼|为什么|如何/;
// "Send it to me", said in answer to an offer — unless it is said with a
// "not" in it: 不想要 and 先不要給我 contain the same words and mean the opposite.
const TAKES_OFFER = /傳給我|传给我|發給我|发给我|寄給我|給我|给我|我要|想要|send/i;
const NEGATES = /不|別|别|沒|没|免了|no\b|don'?t/i;
const OFFER_ANSWER_MAX_CHARS = 16;

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

type PriorLog = {
  commenterName: string | null;
  automation: {
    id: string;
    isActive: boolean;
    keywords: string[];
    followUpEnabled: boolean;
    followUpMessage: string | null;
    trackedLinks: { destinationUrl: string }[];
  };
};

/** Everything known about the account and the sender before the message is read. */
interface Prepared {
  account: { id: string; instagramId: string; accessToken: string | null };
  mode: Exclude<TriageMode, "off">;
  priorLogs: PriorLog[];
  senderName: string | null;
  /** The question the latest campaign asks after delivering its link. */
  asked: string | null;
}

/** One claimed message (or several answered as one), ready to be handled. */
interface Claimed {
  prepared: Prepared;
  senderId: string;
  logId: string;
  claimedAt: Date;
  /** What the rules and the model read: every message answered here, one per line. */
  messageText: string;
  /** The same, as the owner is shown it. */
  shownText: string;
  attachmentKind?: TriageInput["attachmentKind"];
  /** Earlier log rows answered together with this one. */
  batchIds: string[];
}

/** Handle the message now: claim it and act on it in one go. */
export async function runTriage(input: TriageInput): Promise<TriageOutcome | null> {
  try {
    const claimed = await claimMessage(input);
    return claimed ? await handle(claimed) : null;
  } catch (error) {
    console.error("[Triage] Unexpected failure:", error);
    return null;
  }
}

/**
 * Claim the message without acting on it yet. Returns the log row to come
 * back to with resumeTriage, or null when triage has nothing to do with this
 * message (switched off, a Story reply, someone it does not handle, or a
 * message already claimed).
 */
export async function claimTriage(input: TriageInput): Promise<{ logId: string } | null> {
  try {
    const claimed = await claimMessage(input);
    return claimed ? { logId: claimed.logId } : null;
  } catch (error) {
    console.error("[Triage] Could not claim a message:", error);
    return null;
  }
}

/** Act on a message claimed earlier with claimTriage. */
export async function resumeTriage(logId: string): Promise<TriageOutcome | null> {
  try {
    return await resume(logId);
  } catch (error) {
    console.error("[Triage] Unexpected failure:", error);
    return null;
  }
}

async function prepare(
  instagramAccountId: string,
  senderId: string
): Promise<Prepared | null> {
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
  const priorLogs: PriorLog[] = await prisma.dmLog.findMany({
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
          id: true,
          isActive: true,
          keywords: true,
          followUpEnabled: true,
          followUpMessage: true,
          trackedLinks: { select: { destinationUrl: true } },
        },
      },
    },
  });
  if (priorLogs.length === 0) return null;

  // The question the latest campaign asks after delivering its link ("does
  // that make sense?"). A one-word DM is very often the answer to it.
  const latest = priorLogs[0].automation;
  return {
    account: {
      id: account.id,
      instagramId: account.instagramId,
      accessToken: account.accessToken,
    },
    mode,
    priorLogs,
    senderName: priorLogs.find((l) => l.commenterName)?.commenterName ?? null,
    asked:
      latest.followUpEnabled && latest.followUpMessage?.trim()
        ? latest.followUpMessage.trim()
        : null,
  };
}

async function claimMessage(input: TriageInput): Promise<Claimed | null> {
  if (input.isStoryReply) return null;

  const prepared = await prepare(input.instagramAccountId, input.senderId);
  if (!prepared) return null;

  // A picture or file has no words; show what it was instead.
  const shownText = input.attachmentKind
    ? ATTACHMENT_LABEL[input.attachmentKind]
    : input.messageText;

  // Claim the message. The unique key on (account, message) makes this the
  // lock: a second run of the same message fails here, before it can send.
  try {
    const claim = await prisma.triageLog.create({
      data: {
        instagramAccountId: prepared.account.id,
        senderId: input.senderId,
        messageId: input.messageId,
        messageText: shownText.slice(0, 2000),
        category: "pending",
        action: "PENDING",
        mode: prepared.mode,
      },
      select: { id: true, createdAt: true },
    });
    return {
      prepared,
      senderId: input.senderId,
      logId: claim.id,
      claimedAt: claim.createdAt,
      messageText: input.messageText,
      shownText,
      attachmentKind: input.attachmentKind,
      batchIds: [],
    };
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

async function resume(logId: string): Promise<TriageOutcome | null> {
  const row = await prisma.triageLog.findUnique({
    where: { id: logId },
    select: {
      id: true,
      action: true,
      senderId: true,
      messageText: true,
      createdAt: true,
      instagramAccountId: true,
      instagramAccount: { select: { instagramId: true } },
    },
  });
  // Already handled, or merged into a later message.
  if (!row || row.action !== "PENDING") return null;

  // What this person has sent that is still waiting, oldest first.
  const waiting = await prisma.triageLog.findMany({
    where: {
      instagramAccountId: row.instagramAccountId,
      senderId: row.senderId,
      action: "PENDING",
      createdAt: { gte: new Date(row.createdAt.getTime() - BATCH_WINDOW_SECONDS * 1000) },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, messageText: true, createdAt: true },
  });
  // They wrote again after this one: the turn of that later message answers
  // both, so this one waits for it.
  const newest = waiting[waiting.length - 1];
  if (newest && newest.id !== row.id) return null;
  // Everything waiting, this message last. (The list always ends with this
  // row; it is added by hand only so that a missing row cannot lose it.)
  const all = [
    ...waiting.filter((w) => w.id !== row.id),
    { id: row.id, messageText: row.messageText, createdAt: row.createdAt },
  ];
  const stillWaiting = (ids: string[]) => ({ id: { in: ids }, action: "PENDING" });

  const prepared = await prepare(row.instagramAccount.instagramId, row.senderId);
  if (!prepared) {
    // Switched off while the message waited: say so, send nothing.
    await prisma.triageLog.updateMany({
      where: stillWaiting(all.map((w) => w.id)),
      data: { category: "other", action: "IGNORED", reason: REASON.switchedOff },
    });
    return null;
  }

  // An away message from the other account can land between two things a
  // person typed. It is set aside on its own, so that it neither gets an
  // answer nor makes the whole batch look like nobody wrote it.
  const noise = all.filter((w) => looksLikeAutoReply(w.messageText));
  if (noise.length > 0) {
    await prisma.triageLog.updateMany({
      where: stillWaiting(noise.map((w) => w.id)),
      data: { category: "auto_reply", action: "IGNORED", reason: REASON.autoReply },
    });
  }
  const typed = all.filter((w) => !noise.includes(w));
  const last = typed[typed.length - 1];
  if (!last) return { category: "auto_reply", action: "IGNORED", replyText: null };

  const merged = typed.slice(0, -1);
  if (merged.length > 0) {
    await prisma.triageLog.updateMany({
      where: stillWaiting(merged.map((w) => w.id)),
      data: { category: "merged", action: "MERGED", reason: REASON.merged },
    });
  }

  const texts = typed.map((w) => w.messageText);
  return handle({
    prepared,
    senderId: row.senderId,
    logId: last.id,
    claimedAt: last.createdAt,
    messageText: texts.join("\n"),
    shownText: texts.join(" ／ "),
    batchIds: merged.map((w) => w.id),
  });
}

async function handle(claimed: Claimed): Promise<TriageOutcome> {
  const { prepared, senderId, logId, claimedAt, messageText, shownText, batchIds } = claimed;
  const { account, mode, priorLogs, senderName, asked } = prepared;
  /** The rows that make up the message being handled: never "earlier turns". */
  const ownRows = [logId, ...batchIds];

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
  // `ring` is for the notice that must not arrive silently. `draft` is left
  // out to keep whatever draft is already waiting under the notice.
  const tellOwner = (
    reason: string,
    options: { ring?: boolean; draft?: NoticeDraft | null } = {}
  ) =>
    notifyOwner(
      {
        instagramAccountId: account.instagramId,
        senderId,
        senderName,
        messageText: shownText,
        reason,
        ...(options.draft === undefined ? {} : { draft: options.draft }),
      },
      { ring: options.ring ?? false }
    );

  const notify = (reason: string) => tellOwner(reason);

  // Forget drafts that no longer fit. Housekeeping: a failure here must not
  // keep the message itself from being handled.
  const dropDrafts = (options: { olderThan?: Date } = {}) =>
    dropPendingDrafts({ accountId: account.id, senderId }, options).catch((error) => {
      console.error("[Triage] Could not drop an old draft:", error);
      return 0;
    });

  // The pages this sender was sent, looked up at most once per message.
  let pagesLookup: ReturnType<typeof findPagesForSender> | null = null;
  const loadPages = () => (pagesLookup ??= findPagesForSender(account.id, priorLogs));

  // What this app saw of the conversation today, oldest first: their
  // messages, and what actually went out in reply. Looked up at most once.
  // Context, not a requirement: if it cannot be read, the message is handled
  // without it rather than not handled.
  let historyLookup: Promise<Turn[]> | null = null;
  const loadHistory = () =>
    (historyLookup ??= Promise.resolve()
      .then(() =>
        prisma.triageLog.findMany({
          where: {
            instagramAccountId: account.id,
            senderId,
            createdAt: { gte: new Date(Date.now() - DAY_MS) },
            id: { notIn: ownRows },
          },
          orderBy: { createdAt: "desc" },
          take: 6,
          select: { messageText: true, action: true, replyText: true },
        })
      )
      .then((rows) =>
        rows.reverse().flatMap((row): Turn[] => [
          { from: "them", text: row.messageText },
          ...(row.replyText && SAID.has(row.action)
            ? [{ from: "us" as const, text: row.replyText }]
            : []),
        ])
      )
      .catch((error): Turn[] => {
        console.error("[Triage] Could not read the earlier turns:", error);
        return [];
      }));

  // A reply for the owner to approve, written only where the owner can act on
  // it: full mode, with a model. Failing to write one is never an error — the
  // notice goes out without it.
  const writeDraft = async (reason: string): Promise<string | null> => {
    if (mode !== "full" || !isAiConfigured()) return null;
    try {
      const [pages, history] = await Promise.all([loadPages(), loadHistory()]);
      return await draftReply({
        message: messageText,
        reason,
        pages: pages.map((p) => ({ title: p.title, url: p.url, content: p.content })),
        history,
      });
    } catch (error) {
      console.error("[Triage] Could not prepare a draft:", error);
      return null;
    }
  };

  // Hand the message to the owner: nothing is sent to the person. With a
  // draft, the row is written before the notice goes out, so the buttons
  // under the notice always find the draft they are for.
  const escalate = async (
    category: string,
    reason: string,
    options: { draft?: boolean } = {}
  ): Promise<TriageOutcome> => {
    const text = options.draft === false ? null : await writeDraft(reason);
    if (!text) {
      await notify(reason);
      return record(category, "ESCALATED", { reason });
    }
    // One draft per person: this message's draft replaces those of earlier ones.
    await dropDrafts({ olderThan: claimedAt });
    let outcome: TriageOutcome;
    try {
      outcome = await record(category, "ESCALATED", { reason, replyText: text });
    } catch (error) {
      // The draft could not be stored, so its buttons would have nothing to
      // send. The owner still hears about the message, as a plain notice.
      await notify(reason);
      throw error;
    }
    await tellOwner(reason, { draft: { logId, text, at: claimedAt.getTime() } });
    return outcome;
  };

  // An away message or bot menu from the other account. Nobody wrote it, so it
  // gets no reply and no notice — checked before anything else, because it
  // often arrives seconds after the owner's own reply, in a conversation that
  // would otherwise be flagged to them.
  if (!claimed.attachmentKind && looksLikeAutoReply(messageText)) {
    return record("auto_reply", "IGNORED", { reason: REASON.autoReply });
  }

  const canned = claimed.attachmentKind ? null : classifyCanned(messageText);
  // "The link never came" matches a phrase list too, but it is no pleasantry:
  // wherever a pleasantry would be passed over in silence, this is not.
  const pleasantry = canned !== null && canned !== "missing_link";

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
    if (ownerActive) {
      // The owner is answering by hand, so a draft written before that no
      // longer fits: it is dropped, and taken off the notice.
      await dropDrafts();
      if (!pleasantry) await tellOwner(reason, { draft: null });
    } else if (!pleasantry) {
      await notify(reason);
    }
    return record(canned ?? "other", "SKIPPED_OWNER_ACTIVE", { reason });
  }

  // A picture or a file: usually the screenshot someone was asked for. Nobody
  // but the owner can look at it.
  if (claimed.attachmentKind) {
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

  const atDailyCap = async () =>
    (await prisma.triageLog.count({ where: sentToSender })) >= getDailyReplyCap();

  const deliver = async (
    category: string,
    replyText: string,
    extra: { pageKey?: string | null; reason?: string | null } = {}
  ): Promise<TriageOutcome> => {
    if (await atDailyCap()) {
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
    if (whenRepeated === "tell-owner") return escalate(category, reason ?? REASON.repeated);
    return record(category, "ESCALATED", { reason: reason ?? REASON.repeated });
  };

  // A sign-off, a thanks or an "ok". Two things make such a line a non
  // sequitur, and both are checked here. Under a question this person is
  // still waiting on the owner for, "feel free to ask" answers nothing, so
  // nothing is said. And right after a line that already invited questions,
  // the thanks is said without inviting them again.
  const courtesy = async (
    kind: "no_problem" | "thanks" | "ack",
    reason: string | null = null
  ): Promise<TriageOutcome> => {
    const waitingOnOwner = await prisma.triageLog.count({
      where: {
        instagramAccountId: account.id,
        senderId,
        action: "ESCALATED",
        id: { notIn: ownRows },
        createdAt: { gte: new Date(Date.now() - OPEN_QUESTION_SECONDS * 1000) },
      },
    });
    if (waitingOnOwner > 0) {
      return record(kind, "IGNORED", { reason: REASON.openQuestion });
    }
    if (kind !== "thanks") return sayOnce(kind, CANNED_REPLIES.no_problem, reason);

    const invitedJustNow = await prisma.triageLog.count({
      where: {
        ...sentToSender,
        replyText: { in: INVITATIONS },
        createdAt: { gte: new Date(Date.now() - INVITE_REPEAT_SECONDS * 1000) },
      },
    });
    return sayOnce(
      "thanks",
      invitedJustNow > 0 ? CANNED_REPLIES.thanks_short : CANNED_REPLIES.thanks,
      reason
    );
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
    await tellOwner(reason, { ring: true });
    if (mode !== "dry_run") {
      await markHandoff(account.instagramId, senderId);
      await clearAskedHuman(account.instagramId, senderId);
    }
    return sayOnce("wants_human", HANDOFF_REPLY, reason, "owner-already-told");
  };

  // Send a campaign's own message to this person, the way a tap on its button
  // would: the worker checks whether they follow, and sends the link if they
  // do and the follow prompt with its button if they do not. Because nobody
  // tapped anything here, only a confirmed follower gets the link.
  const sendCampaign = async (
    category: string,
    automationId: string,
    mark: string,
    reason: string
  ): Promise<TriageOutcome> => {
    if (await atDailyCap()) {
      await notify(REASON.cap);
      return record(category, "SKIPPED_CAP", { replyText: mark, reason: REASON.cap });
    }
    if (mode === "dry_run") return record(category, "DRY_RUN", { replyText: mark, reason });
    try {
      await getDMQueue().add(
        POSTBACK_JOB_NAME,
        {
          instagramAccountId: account.instagramId,
          userId: senderId,
          payload: `followcheck:${automationId}`,
          strictFollow: true,
        },
        { jobId: `triage_send_${automationId}_${logId}` }
      );
    } catch (error) {
      console.error("[Triage] Could not queue a campaign message:", error);
      return escalate(category, REASON.queueFailed);
    }
    return record(category, "REPLIED", { replyText: mark, reason });
  };

  // "I never got the link." Sent again once; a second time means the re-send
  // did not help, and the owner looks.
  const resendLink = async (reason: string): Promise<TriageOutcome> => {
    const campaign = priorLogs.find((log) => log.automation.isActive)?.automation;
    if (!campaign) return escalate("missing_link", REASON.noCampaign);
    if (
      mode !== "dry_run" &&
      !(await claimResend(account.instagramId, senderId, campaign.id))
    ) {
      return escalate("missing_link", REASON.resentAlready);
    }
    return sendCampaign("missing_link", campaign.id, RESEND_MARK, reason);
  };

  // The campaign that delivers the quota tutorial, if it is running.
  const findTutorialCampaign = async (): Promise<string | null> => {
    const page = await prisma.triagePage.findFirst({
      where: { instagramAccountId: account.id, key: QUOTA_TUTORIAL_PAGE_KEY },
      select: { url: true },
    });
    if (!page?.url) return null;
    const campaign = await prisma.automation.findFirst({
      where: {
        isActive: true,
        instagramAccountId: account.id,
        trackedLinks: { some: { destinationUrl: page.url } },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return campaign?.id ?? null;
  };

  // Their Claude quota keeps running out: offer the tutorial, and send it only
  // if they say yes. Someone who already holds that tutorial is not offered it
  // again; the owner hears about them instead.
  const offerTutorial = async (reason: string): Promise<TriageOutcome> => {
    const [campaignId, pages] = await Promise.all([findTutorialCampaign(), loadPages()]);
    if (!campaignId || pages.some((page) => page.key === QUOTA_TUTORIAL_PAGE_KEY)) {
      return escalate("quota", reason);
    }
    const outcome = await sayOnce("quota", CANNED_REPLIES.quota_offer, reason, "tell-owner");
    if (outcome.action === "REPLIED") {
      await markOffered(account.instagramId, senderId, "quota");
    }
    return outcome;
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

  // We offered the quota tutorial — a plain yes takes it, a plain no closes
  // the offer and the message is handled like any other.
  if ((await getOffered(account.instagramId, senderId)) === "quota") {
    const takesIt =
      answersYes(messageText) ||
      (messageText.trim().length <= OFFER_ANSWER_MAX_CHARS &&
        !/[?？]/.test(messageText) &&
        !NEGATES.test(messageText) &&
        TAKES_OFFER.test(messageText));
    if (takesIt) {
      await clearOffered(account.instagramId, senderId);
      const campaignId = await findTutorialCampaign();
      if (!campaignId) return escalate("quota", REASON.noCampaign);
      return sendCampaign("quota", campaignId, TUTORIAL_MARK, REASON.offerTaken);
    }
    if (answersNo(messageText)) await clearOffered(account.instagramId, senderId);
  }

  if (asksIfAutomated(messageText)) return disclose(REASON.askedIfAi);
  if (asksForHuman(messageText)) return handOff(REASON.wantsHuman);

  if (canned === "missing_link") return resendLink(REASON.missingLink);
  // A bare "可以" or 👍 is nearly always the answer to "does that make sense?",
  // so it closes the same way as "no questions". Said once: if the line has
  // already gone out, the acknowledgement of it is left alone.
  if (canned === "ack") return courtesy("ack", REASON.ack);
  if (canned === "stuck") return askWhereStuck();
  if (canned === "followed") return sayOnce("followed", CANNED_REPLIES.followed);
  if (canned) return courtesy(canned);

  // Not one of the fixed cases. The model only runs where its verdict could be
  // used (full) or reviewed (dry_run); in canned mode this goes to the owner.
  let escalationReason: string = REASON.notCanned;
  let modelFailed = false;
  if (mode === "full" || mode === "dry_run") {
    if (!isAiConfigured()) {
      escalationReason = REASON.aiNotConfigured;
    } else {
      try {
        const [pages, history] = await Promise.all([loadPages(), loadHistory()]);
        const verdict = await answerFromPages(
          messageText,
          pages.map((p) => ({ title: p.title, content: p.content })),
          asked,
          history
        );
        // For everything but an answer the model only picks the kind; the
        // text that goes out is ours.
        switch (verdict.category) {
          case "page_question":
            return deliver("page_question", verdict.answer, {
              pageKey: pages[0]?.key ?? null,
              reason: verdict.reason,
            });
          case "missing_link":
            return resendLink(verdict.reason || REASON.missingLink);
          case "quota":
            return offerTutorial(verdict.reason);
          case "no_question":
          case "thanks": {
            if (isPlainSignOff(messageText)) {
              return courtesy(
                verdict.category === "no_question" ? "no_problem" : "thanks",
                verdict.reason
              );
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
        modelFailed = true;
      }
    }
  }

  // Collaboration, courses, complaints, anything unclear: no reply goes out,
  // the owner hears about it — with a draft they can send as it is. A model
  // that has just failed is not asked again for the draft.
  return escalate("other", escalationReason, { draft: !modelFailed });
}

type PageSource = {
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
export async function findPagesForSender(accountId: string, priorLogs: PageSource[]) {
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
