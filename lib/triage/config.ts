/**
 * DM triage constants and environment-backed settings.
 *
 * The on/off switch is NOT here: the mode is stored per Instagram account
 * (TriageSetting, edited on the Settings page; see lib/triage/settings.ts).
 * What lives in the environment are the worker's secrets and tuning knobs.
 *
 *   off      (default) nothing runs; inbound DMs behave exactly as before
 *   dry_run  classify and log what WOULD be sent; escalations still notify
 *   canned   send only the two fixed replies; everything else escalates
 *   full     canned replies plus AI answers grounded in the sender's page
 */
export const TRIAGE_MODES = ["off", "dry_run", "canned", "full"] as const;
export type TriageMode = (typeof TRIAGE_MODES)[number];

/** Anything unrecognised is treated as off — the safe reading of bad data. */
export function parseTriageMode(value: unknown): TriageMode {
  return TRIAGE_MODES.includes(value as TriageMode) ? (value as TriageMode) : "off";
}

// The fixed lines. Every one of them is the account owner's own wording or was
// approved by them; nothing sent to a sender is improvised except an answer
// written from the sender's page.
export const CANNED_REPLIES = {
  // "no questions" / "all clear" / "got it"
  no_problem: "好的哦，如果有任何問題都歡迎來問我~",
  // The owner's wording (11-25): always followed by the invitation to ask.
  thanks: "不用客氣~ 有問題都可以問我",
  // "I followed you", typed instead of tapping the button that sends the link.
  followed: "追蹤後請按上一則訊息的按鈕，就會收到連結～",
  // "I do not know how to use it" / "it is hard", with no word about which part.
  stuck: "請問你是哪一步卡住了呢？可以截圖給我看嘛？",
  // Someone who has just subscribed to an AI tool and asks where to begin.
  where_to_start:
    "你可以先想一下你現在目前遇到最麻煩可是又最繁雜的手頭工作，比如說 email reply 或者是回訊息，或者寫報表，其實這些都是可以用 Claude 自動化的",
  // "Can I do this on my phone?" Every tutorial is done on a computer.
  use_computer: "這個要用電腦才能做哦，手機目前沒辦法～",
} as const;

// When someone asks whether an AI is replying: always say yes, and ask whether
// they want the owner in person.
export const AI_DISCLOSURE_REPLY = "是的，這是 AI 自動回覆哦～你是想找本人嗎？";

// When someone asks for the owner in person, after the owner has been told.
export const HANDOFF_REPLY = "好的，已經幫你轉給本人了～";

// Appended to AI-written answers only. Meta recommends telling people when a
// reply is automated; the fixed lines above are left as they are.
export const AI_REPLY_SUFFIX = "\n（自動回覆）";

/** How long "do you want the owner?" stays open for a yes or a no. */
export const ASKED_HUMAN_SECONDS = 12 * 60 * 60;

/** After someone asks for the owner, send them nothing more for this long. */
export const HANDOFF_QUIET_SECONDS = 24 * 60 * 60;

/**
 * Max automatic replies to one person per rolling 24 hours. Fixed lines cannot
 * repeat (each is said once a day), so this mostly bounds page answers; past
 * it, a real question goes to the owner instead of being dropped.
 */
export function getDailyReplyCap(): number {
  const n = Number.parseInt(process.env.TRIAGE_DAILY_REPLY_CAP ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

/**
 * How recently we must have sent someone a campaign DM for triage to touch
 * their messages. Past this, a DM from them is an ordinary conversation again.
 */
export function getEligibleDays(): number {
  const n = Number.parseInt(process.env.TRIAGE_ELIGIBLE_DAYS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

/** After the owner replies by hand, stay out of that thread for this long. */
export const OWNER_QUIET_SECONDS = 24 * 60 * 60;

/** How long a "the bot just messaged this user" marker lives. */
export const BOT_ACTIVITY_SECONDS = 180;

/** The owner's phone rings at most once per person within this window. */
export const NOTIFY_COOLDOWN_SECONDS = 30 * 60;

/** One person's messages are stacked into one notice for this long. */
export const NOTICE_THREAD_SECONDS = 24 * 60 * 60;

/** How many of a person's latest messages one notice shows. */
export const NOTICE_MAX_LINES = 10;

/** A draft reply offered to the owner is at most this long: a few sentences. */
export const DRAFT_CHAR_LIMIT = 400;

/**
 * Instagram accepts a reply for 24 hours after the person's message. A draft
 * older than that can no longer be sent from the notice.
 */
export const DRAFT_SEND_WINDOW_SECONDS = 24 * 60 * 60;

/** Instagram's limit on one text message. */
export const DM_CHAR_LIMIT = 1000;

/** How long "reply to this with your own wording" stays answerable. */
export const EDIT_PROMPT_SECONDS = 24 * 60 * 60;

/** The clock the times in a notice are written in. */
export function getNoticeTimeZone(): string {
  return env("TRIAGE_TIMEZONE") || "Asia/Taipei";
}

// Values pasted into a hosting dashboard often arrive with a stray space or
// line break on the end, which silently breaks a key or a URL. Trim them.
const env = (name: string) => (process.env[name] ?? "").trim();

export function getAiConfig() {
  return {
    apiKey: env("GROQ_API_KEY"),
    model: env("TRIAGE_AI_MODEL") || env("GROQ_MODEL"),
  };
}

/**
 * Where "needs a human" notices go. Telegram is used when both of its values
 * are set; otherwise a generic webhook, if one is configured.
 */
export function getNotifyConfig() {
  return {
    telegramBotToken: env("TRIAGE_TELEGRAM_BOT_TOKEN"),
    telegramChatId: env("TRIAGE_TELEGRAM_CHAT_ID"),
    webhookUrl: env("TRIAGE_NOTIFY_URL"),
    webhookSecret: env("TRIAGE_NOTIFY_SECRET"),
  };
}

export function isNotifyConfigured(): boolean {
  const c = getNotifyConfig();
  return Boolean((c.telegramBotToken && c.telegramChatId) || c.webhookUrl);
}
