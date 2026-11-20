import { createHash } from "node:crypto";
import { getNotifyConfig } from "@/lib/triage/config";

/**
 * Tell the account owner about a DM that needs a human.
 *
 * Telegram is the primary channel: a bot the owner created messages their own
 * chat (free, no approval, no per-message cost). A generic authenticated
 * webhook is the alternative for anything else. With neither configured the
 * notice is skipped and the triage log is the only record.
 */

export interface EscalationNotice {
  instagramAccountId: string;
  senderId: string;
  senderName: string | null;
  messageText: string;
  reason: string;
}

const IG_USERNAME = /^[A-Za-z0-9._]{1,30}$/;

/**
 * The name is written without a leading "@": Telegram turns "@name" into a
 * link to the Telegram account of that name, which is a different person. The
 * profile link on the last line is the one-tap way to the conversation.
 */
export function formatNotice(notice: EscalationNotice): string {
  const username =
    notice.senderName && IG_USERNAME.test(notice.senderName) ? notice.senderName : null;
  const who = username ?? notice.senderName ?? `用戶 ${notice.senderId}`;
  const lines = [`IG 私訊需要你回：${who}`, `「${notice.messageText.slice(0, 500)}」`];
  if (notice.reason) lines.push(`（${notice.reason}）`);
  if (username) lines.push(`https://www.instagram.com/${username}/`);
  return lines.join("\n");
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  // The bot token is part of the URL, so this URL must never be logged.
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    console.error(`[Triage] Telegram notice rejected: HTTP ${response.status}`);
  }
  return response.ok;
}

async function sendWebhook(
  url: string,
  secret: string,
  notice: EscalationNotice
): Promise<boolean> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-triage-secret": secret } : {}),
    },
    body: JSON.stringify({ text: formatNotice(notice), ...notice }),
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
    return await sendTelegram(telegramBotToken, telegramChatId, HELLO_TEXT);
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    console.error(`[Triage] Telegram test message failed (${name})`);
    return false;
  }
}

/** Returns true when the notice was delivered. Never throws. */
export async function notifyOwner(notice: EscalationNotice): Promise<boolean> {
  const { telegramBotToken, telegramChatId, webhookUrl, webhookSecret } =
    getNotifyConfig();

  try {
    if (telegramBotToken && telegramChatId) {
      return await sendTelegram(telegramBotToken, telegramChatId, formatNotice(notice));
    }
    if (webhookUrl) {
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
