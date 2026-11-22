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
  type NoticeLine,
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
 */

export interface EscalationNotice {
  instagramAccountId: string;
  senderId: string;
  senderName: string | null;
  messageText: string;
  reason: string;
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

/**
 * One person's messages as a single notice: who, each message with its time,
 * and a link to their profile. Nothing else — the owner asked for it short.
 *
 * The name is written without a leading "@": Telegram turns "@name" into a
 * link to the Telegram account of that name, which is a different person.
 */
export function formatNotice(
  sender: { senderName: string | null; senderId: string },
  lines: NoticeLine[]
): string {
  const username =
    sender.senderName && IG_USERNAME.test(sender.senderName) ? sender.senderName : null;
  const who = username ?? sender.senderName ?? `用戶 ${sender.senderId}`;
  const head = `IG 私訊需要你回：${who}`;
  const tail = username ? `https://www.instagram.com/${username}/` : "";

  const render = (shown: NoticeLine[]) =>
    [
      head,
      ...shown.map(
        (line) =>
          `${clock(line.at)}「${line.text.replace(/\s*\n\s*/g, " ").slice(0, LINE_CHAR_LIMIT)}」`
      ),
      tail,
    ]
      .filter(Boolean)
      .join("\n");

  // Keep the newest lines if the whole thing would be too long for Telegram.
  let shown = lines;
  while (shown.length > 1 && render(shown).length > NOTICE_CHAR_LIMIT) shown = shown.slice(1);
  return render(shown);
}

/**
 * Call one Telegram Bot API method. Returns the parsed reply, or null when
 * Telegram refused. The bot token is part of the URL, so the URL is never
 * logged and errors from here are reported by status only.
 */
async function telegram(
  token: string,
  method: "sendMessage" | "editMessageText" | "deleteMessage",
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
  const text = formatNotice(notice, lines);

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
    });
    if (edited) {
      await saveNoticeThread(notice.instagramAccountId, notice.senderId, { ...thread, lines });
      return true;
    }
    // The owner deleted that message by hand: send the stack afresh below.
  }

  const sent = await telegram(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
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
    });
  }
  return true;
}

async function sendWebhook(
  url: string,
  secret: string,
  notice: EscalationNotice
): Promise<boolean> {
  const text = formatNotice(notice, [{ at: Date.now(), text: notice.messageText }]);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-triage-secret": secret } : {}),
    },
    body: JSON.stringify({ text, ...notice }),
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
