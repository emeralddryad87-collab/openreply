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

export const CANNED_REPLIES = {
  no_problem: "有問題都可以來問我哦",
  thanks: "不用客氣~",
} as const;

// Appended to AI-written answers only. Meta recommends telling people when a
// reply is automated; the two fixed lines above are left as they are.
export const AI_REPLY_SUFFIX = "\n（自動回覆）";

/** Max automatic replies to one person per rolling 24 hours. */
export function getDailyReplyCap(): number {
  const n = Number.parseInt(process.env.TRIAGE_DAILY_REPLY_CAP ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
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

/** At most one escalation notice per person within this window. */
export const NOTIFY_COOLDOWN_SECONDS = 30 * 60;

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
