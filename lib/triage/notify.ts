import { createHash } from "node:crypto";
import {
  NOTICE_MAX_LINES,
  NOTIFY_COOLDOWN_SECONDS,
  getNoticeTimeZone,
  getNotifyConfig,
} from "@/lib/triage/config";
import {
  claimNotifySlot,
  getNoticeThread,
  saveNoticeThread,
  type NoticeDraft,
  type NoticeLine,
  type NoticeThread,
} from "@/lib/triage/state";

/**
 * Tell the account owner about a DM that needs a human.
 *
 * Telegram is the primary channel: a bot the owner created messages their own
 * chat (free, no approval, no per-message cost). A generic authenticated
 * webhook is the alternative for anything else. With neither configured the
 * notice is skipped and the triage log is the only record.
 *
 * On Telegram, one person is one message. Everything they send within a day is
 * stacked into the same message, newest at the bottom, so the chat reads as a
 * list of people rather than a stream of fragments:
 *
 *   - Within half an hour of the last ring, a new line is added to the message
 *     that is already there. Telegram does not ring for an edit.
 *   - After that, the stacked message is sent afresh and the old copy removed:
 *     the phone rings once, and the message is at the bottom of the chat again.
 *
 * A notice may carry a draft reply. It is shown under the person's messages
 * with buttons to send it, replace it or drop it; what the owner then sends is
 * added to the same notice (see owner-actions.ts for what the buttons do).
 */

export interface EscalationNotice {
  instagramAccountId: string;
  senderId: string;
  senderName: string | null;
  messageText: string;
  reason: string;
  /**
   * A reply for the owner to approve. Left out, a draft already waiting under
   * this person's notice stays; null removes it (the owner has taken the
   * conversation over by hand, so an older draft no longer fits).
   */
  draft?: NoticeDraft | null;
}

const IG_USERNAME = /^[A-Za-z0-9._]{1,30}$/;
const LINE_CHAR_LIMIT = 300;
// Telegram refuses a message over 4096 characters.
const NOTICE_CHAR_LIMIT = 3800;

function clock(at: number): string {
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).format(new Date(at));
  try {
    return format(getNoticeTimeZone());
  } catch {
    return format("Asia/Taipei");
  }
}

/** How the person is named in a notice: their username when there is one. */
export function noticeName(sender: { senderName?: string | null; senderId: string }): string {
  return sender.senderName || `用戶 ${sender.senderId}`;
}

function renderLine(line: NoticeLine): string {
  const text = line.text.replace(/\s*\n\s*/g, " ").slice(0, LINE_CHAR_LIMIT);
  if (line.kind === "out") return `${clock(line.at)} ✅ 已回「${text}」`;
  if (line.kind === "failed") return `${clock(line.at)} ⚠️ 沒送出去「${text}」`;
  return `${clock(line.at)}「${text}」`;
}

/**
 * One person's messages as a single notice: who, each message with its time,
 * and a link to their profile. Nothing else — the owner asked for it short.
 * A draft, when there is one, sits under the messages exactly as it would be
 * sent; a reply the owner sent from the notice is one more line.
 *
 * The name is written without a leading "@": Telegram turns "@name" into a
 * link to the Telegram account of that name, which is a different person.
 */
export function formatNotice(
  sender: { senderName?: string | null; senderId: string },
  lines: NoticeLine[],
  draft: NoticeDraft | null = null
): string {
  const username =
    sender.senderName && IG_USERNAME.test(sender.senderName) ? sender.senderName : null;
  // Once the owner's reply is the last thing in it, the notice no longer asks.
  const answered = lines.at(-1)?.kind === "out";
  const head = `${answered ? "IG 私訊已回" : "IG 私訊需要你回"}：${noticeName(sender)}`;
  const tail = username ? `https://www.instagram.com/${username}/` : "";

  const render = (shown: NoticeLine[]) =>
    [head, ...shown.map(renderLine), draft ? `草稿：${draft.text}` : "", tail]
      .filter(Boolean)
      .join("\n");

  // Keep the newest lines if the whole thing would be too long for Telegram.
  let shown = lines;
  while (shown.length > 1 && render(shown).length > NOTICE_CHAR_LIMIT) shown = shown.slice(1);
  return render(shown);
}

/**
 * The buttons under a draft. Sending takes two taps — "送出", then "確定送出" —
 * because a stray tap in a chat full of buttons would otherwise put words in
 * the owner's mouth, to a real person, with no way to take them back.
 *
 * What a button carries is the id of the log row that holds the draft, so a
 * tap always means that draft and no other.
 */
export function draftKeyboard(logId: string, stage: "ask" | "confirm" = "ask") {
  const button = (text: string, op: string) => ({ text, callback_data: `t:${op}:${logId}` });
  return {
    inline_keyboard: [
      stage === "confirm"
        ? [button("✅ 確定送出", "y"), button("取消", "n")]
        : [button("送出", "s"), button("修改", "e"), button("不用回", "x")],
    ],
  };
}

export type TelegramMethod =
  | "sendMessage"
  | "editMessageText"
  | "editMessageReplyMarkup"
  | "deleteMessage"
  | "answerCallbackQuery";

/**
 * Which draft the notice shows after this message is added. No word about a
 * draft keeps the one that is waiting; null removes it. Otherwise the draft
 * for the later message wins — two messages sent seconds apart are handled at
 * the same time, and the notice for the earlier one can be the last to arrive.
 */
function draftToShow(
  incoming: NoticeDraft | null | undefined,
  waiting: NoticeDraft | null
): NoticeDraft | null {
  if (incoming === undefined) return waiting;
  if (incoming === null) return null;
  return waiting && waiting.at > incoming.at ? waiting : incoming;
}

/**
 * Call one Telegram Bot API method. Returns the parsed reply, or null when
 * Telegram refused. The bot token is part of the URL, so the URL is never
 * logged and errors from here are reported by status only.
 */
export async function telegram(
  token: string,
  method: TelegramMethod,
  body: Record<string, unknown>
): Promise<{ result?: { message_id?: number } } | null> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    console.error(`[Triage] Telegram ${method} rejected: HTTP ${response.status}`);
    return null;
  }
  if (typeof response.json !== "function") return {};
  return ((await response.json().catch(() => null)) as { result?: { message_id?: number } }) ?? {};
}

async function notifyTelegram(
  token: string,
  chatId: string,
  notice: EscalationNotice,
  ring: boolean
): Promise<boolean> {
  const now = Date.now();
  const thread = await getNoticeThread(notice.instagramAccountId, notice.senderId);
  const lines = [...(thread?.lines ?? []), { at: now, text: notice.messageText }].slice(
    -NOTICE_MAX_LINES
  );
  let draft = draftToShow(notice.draft, thread?.draft ?? null);
  const text = formatNotice(notice, lines, draft);
  // Without a draft the request is exactly what it was before drafts existed.
  const buttons = draft ? { reply_markup: draftKeyboard(draft.logId) } : {};

  // The phone rang for this person a moment ago: add the new line to the
  // message that is already in the chat, quietly.
  const rangRecently =
    thread !== null && now - thread.pingedAt < NOTIFY_COOLDOWN_SECONDS * 1000;
  if (thread && rangRecently && !ring) {
    const edited = await telegram(token, "editMessageText", {
      chat_id: chatId,
      message_id: thread.messageId,
      text,
      disable_web_page_preview: true,
      ...buttons,
    });
    if (edited) {
      await saveNoticeThread(notice.instagramAccountId, notice.senderId, {
        ...thread,
        lines,
        senderName: notice.senderName,
        draft,
      });
      return true;
    }
    // The owner deleted that message by hand: send the stack afresh below.
  }

  let sent = await telegram(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...buttons,
  });
  if (!sent && draft) {
    // The notice matters more than its draft. If Telegram will not take it
    // with the draft and buttons, it goes out as the plain notice it was
    // before drafts existed.
    draft = null;
    sent = await telegram(token, "sendMessage", {
      chat_id: chatId,
      text: formatNotice(notice, lines, null),
      disable_web_page_preview: true,
    });
  }
  if (!sent) return false;

  // One person, one message: the older copy goes once the new one is in.
  if (thread) {
    await telegram(token, "deleteMessage", {
      chat_id: chatId,
      message_id: thread.messageId,
    }).catch(() => null);
  }

  const messageId = sent.result?.message_id;
  if (typeof messageId === "number") {
    await saveNoticeThread(notice.instagramAccountId, notice.senderId, {
      messageId,
      startedAt: thread?.startedAt ?? now,
      pingedAt: now,
      lines,
      senderName: notice.senderName,
      draft,
    });
  }
  return true;
}

/**
 * Redraw a person's notice after the owner acted on it: a reply went out, or a
 * draft was dropped. Quiet — an edit does not ring.
 *
 * Returns the id of the Telegram message that now shows the change, or null
 * when there was nothing to redraw: the notice has aged out, or Telegram
 * refused the edit. The caller then tidies the message the owner actually
 * tapped.
 */
export async function updateNotice(
  instagramAccountId: string,
  senderId: string,
  change: (thread: NoticeThread) => NoticeThread
): Promise<number | null> {
  const { telegramBotToken, telegramChatId } = getNotifyConfig();
  if (!telegramBotToken || !telegramChatId) return null;

  const thread = await getNoticeThread(instagramAccountId, senderId);
  if (!thread) return null;
  const next = change(thread);
  const draft = next.draft ?? null;
  await saveNoticeThread(instagramAccountId, senderId, next);

  // Leaving reply_markup out of an edit takes the buttons away with it.
  const edited = await telegram(telegramBotToken, "editMessageText", {
    chat_id: telegramChatId,
    message_id: next.messageId,
    text: formatNotice({ senderName: next.senderName, senderId }, next.lines, draft),
    disable_web_page_preview: true,
    ...(draft ? { reply_markup: draftKeyboard(draft.logId) } : {}),
  });
  return edited ? next.messageId : null;
}

async function sendWebhook(
  url: string,
  secret: string,
  notice: EscalationNotice
): Promise<boolean> {
  // A webhook has no buttons, so the draft is left out of what it posts:
  // nothing could be done with it there.
  const { draft: _draft, ...posted } = notice;
  void _draft;
  const text = formatNotice(notice, [{ at: Date.now(), text: notice.messageText }]);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-triage-secret": secret } : {}),
    },
    body: JSON.stringify({ text, ...posted }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    console.error(`[Triage] Webhook notice rejected: HTTP ${response.status}`);
  }
  return response.ok;
}

/**
 * A short, stable name for the current Telegram configuration, or null when
 * Telegram is not configured. It is a one-way hash, so it can be stored as a
 * key without storing the token.
 */
export function notifyFingerprint(): string | null {
  const { telegramBotToken, telegramChatId } = getNotifyConfig();
  if (!telegramBotToken || !telegramChatId) return null;
  return createHash("sha256")
    .update(`${telegramBotToken}:${telegramChatId}`)
    .digest("hex")
    .slice(0, 16);
}

export const HELLO_TEXT =
  "✅ OpenReply 通知接好了。之後 IG 有需要你親自回的私訊，會傳到這裡。";

/**
 * Send the one-off "notifications are connected" message to the owner's own
 * chat. Returns true when Telegram accepted it. Never throws.
 */
export async function sendHelloNotice(): Promise<boolean> {
  const { telegramBotToken, telegramChatId } = getNotifyConfig();
  if (!telegramBotToken || !telegramChatId) return false;
  try {
    const sent = await telegram(telegramBotToken, "sendMessage", {
      chat_id: telegramChatId,
      text: HELLO_TEXT,
      disable_web_page_preview: true,
    });
    return sent !== null;
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    console.error(`[Triage] Telegram test message failed (${name})`);
    return false;
  }
}

/**
 * Tell the owner that something in the set-up needs them — not about a
 * person's message. Sent to the same chat the notices arrive in. Returns true
 * when Telegram accepted it. Never throws.
 */
export async function sendOwnerAlert(text: string): Promise<boolean> {
  const { telegramBotToken, telegramChatId } = getNotifyConfig();
  if (!telegramBotToken || !telegramChatId) return false;
  try {
    const sent = await telegram(telegramBotToken, "sendMessage", {
      chat_id: telegramChatId,
      text,
      disable_web_page_preview: true,
    });
    return sent !== null;
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    console.error(`[Triage] Telegram alert failed (${name})`);
    return false;
  }
}

/**
 * Tell the owner. Returns true when the notice was delivered. Never throws.
 *
 * `ring: true` is for the notice that must not arrive silently — someone
 * asking for the owner by name — and makes the phone ring even if it rang for
 * the same person a minute ago.
 */
export async function notifyOwner(
  notice: EscalationNotice,
  options: { ring?: boolean } = {}
): Promise<boolean> {
  const { telegramBotToken, telegramChatId, webhookUrl, webhookSecret } =
    getNotifyConfig();
  const ring = options.ring ?? false;

  try {
    if (telegramBotToken && telegramChatId) {
      return await notifyTelegram(telegramBotToken, telegramChatId, notice, ring);
    }
    if (webhookUrl) {
      // A webhook cannot be edited after the fact, so it keeps the simpler
      // rule: at most one notice per person inside the cooldown.
      if (!ring && !(await claimNotifySlot(notice.instagramAccountId, notice.senderId))) {
        return false;
      }
      return await sendWebhook(webhookUrl, webhookSecret, notice);
    }
    return false;
  } catch (error) {
    // Log the kind of failure only: an error message can echo the request URL,
    // and for Telegram that URL contains the bot token.
    const name = error instanceof Error ? error.name : "Error";
    console.error(`[Triage] Owner notification failed (${name})`);
    return false;
  }
}
