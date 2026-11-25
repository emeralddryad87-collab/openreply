import { getRedisConnection } from "@/lib/queue/client";
import {
  ASKED_HUMAN_SECONDS,
  BOT_ACTIVITY_SECONDS,
  EDIT_PROMPT_SECONDS,
  HANDOFF_QUIET_SECONDS,
  NOTICE_THREAD_SECONDS,
  NOTIFY_COOLDOWN_SECONDS,
  OWNER_QUIET_SECONDS,
} from "@/lib/triage/config";

/**
 * Short-lived per-conversation markers, kept in Redis.
 *
 * The problem they solve: Instagram echoes every message the account sends,
 * and an echo looks the same whether the worker sent it or the owner typed it
 * in the app. Triage must go quiet when the owner is talking to someone, so it
 * has to tell the two apart.
 *
 * The worker marks a conversation as "bot is active" whenever it is about to
 * send that user something. An echo that arrives while the marker is alive is
 * the bot's own; any other echo is the owner replying by hand.
 *
 * The marker is tied to sending, not to handling a message: when triage hands
 * a question to the owner it sends nothing, so the owner's answer a minute
 * later is correctly seen as theirs.
 */

const botKey = (accountId: string, userId: string) =>
  `triage:bot:${accountId}:${userId}`;
const ownerKey = (accountId: string, userId: string) =>
  `triage:owner:${accountId}:${userId}`;
const notifyKey = (accountId: string, userId: string) =>
  `triage:notified:${accountId}:${userId}`;
const lastOwnerReplyKey = (accountId: string) => `triage:owner:last:${accountId}`;

const LAST_OWNER_REPLY_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function markBotActivity(
  accountId: string,
  userId: string
): Promise<void> {
  await getRedisConnection().set(
    botKey(accountId, userId),
    String(Date.now()),
    "EX",
    BOT_ACTIVITY_SECONDS
  );
}

/**
 * Record an echo. Returns true when it was treated as a manual owner reply.
 */
export async function recordEcho(
  accountId: string,
  userId: string
): Promise<boolean> {
  const redis = getRedisConnection();
  if (await redis.exists(botKey(accountId, userId))) return false;
  await redis.set(
    ownerKey(accountId, userId),
    String(Date.now()),
    "EX",
    OWNER_QUIET_SECONDS
  );
  await redis.set(
    lastOwnerReplyKey(accountId),
    new Date().toISOString(),
    "EX",
    LAST_OWNER_REPLY_TTL_SECONDS
  );
  return true;
}

/**
 * When a hand-typed reply from the owner was last noticed on this account, or
 * null. Shown on the Settings page: it is the direct evidence that the "owner
 * is replying, stay out" guard can see the owner's messages at all.
 */
export async function getLastOwnerReplyAt(
  accountId: string
): Promise<string | null> {
  return getRedisConnection().get(lastOwnerReplyKey(accountId));
}

export async function ownerRepliedRecently(
  accountId: string,
  userId: string
): Promise<boolean> {
  return (await getRedisConnection().exists(ownerKey(accountId, userId))) === 1;
}

const askedHumanKey = (accountId: string, userId: string) =>
  `triage:asked-human:${accountId}:${userId}`;
const handoffKey = (accountId: string, userId: string) =>
  `triage:handoff:${accountId}:${userId}`;

/**
 * The sender was just asked "do you want the owner in person?". Their next
 * short "yes" or "no" is an answer to that, not an ordinary acknowledgement.
 */
export async function markAskedHuman(accountId: string, userId: string): Promise<void> {
  await getRedisConnection().set(
    askedHumanKey(accountId, userId),
    String(Date.now()),
    "EX",
    ASKED_HUMAN_SECONDS
  );
}

export async function wasAskedHuman(accountId: string, userId: string): Promise<boolean> {
  return (await getRedisConnection().exists(askedHumanKey(accountId, userId))) === 1;
}

export async function clearAskedHuman(accountId: string, userId: string): Promise<void> {
  await getRedisConnection().del(askedHumanKey(accountId, userId));
}

/**
 * The sender asked for the owner in person and the owner was told. Until the
 * mark expires nothing automatic is sent to them: the conversation is the
 * owner's now.
 */
export async function markHandoff(accountId: string, userId: string): Promise<void> {
  await getRedisConnection().set(
    handoffKey(accountId, userId),
    String(Date.now()),
    "EX",
    HANDOFF_QUIET_SECONDS
  );
}

export async function handedOffRecently(accountId: string, userId: string): Promise<boolean> {
  return (await getRedisConnection().exists(handoffKey(accountId, userId))) === 1;
}

const noticeKey = (accountId: string, userId: string) =>
  `triage:notice:${accountId}:${userId}`;

export interface NoticeLine {
  /** When the sender's message arrived (or the owner's reply went out), in ms. */
  at: number;
  text: string;
  /**
   * Unset for a message from the sender. "out" is a reply the owner sent from
   * the notice; "failed" is one Instagram did not accept.
   */
  kind?: "out" | "failed";
}

/** A reply written for the owner to approve: which log row holds it, and its text. */
export interface NoticeDraft {
  logId: string;
  text: string;
  /** When the message it answers arrived, in ms: the newest draft is the one shown. */
  at: number;
}

/**
 * The one notice in the owner's chat that carries a person's messages: which
 * Telegram message it is, what it shows, and when the phone last rang for it.
 */
export interface NoticeThread {
  messageId: number;
  startedAt: number;
  pingedAt: number;
  lines: NoticeLine[];
  /** Kept so the notice can be redrawn later without looking the person up. */
  senderName?: string | null;
  /** The draft waiting for the owner's decision, if there is one. */
  draft?: NoticeDraft | null;
}

export async function getNoticeThread(
  accountId: string,
  userId: string
): Promise<NoticeThread | null> {
  const raw = await getRedisConnection().get(noticeKey(accountId, userId));
  if (!raw) return null;
  try {
    const thread = JSON.parse(raw) as NoticeThread;
    return typeof thread.messageId === "number" && Array.isArray(thread.lines) ? thread : null;
  } catch {
    return null;
  }
}

/**
 * Save the notice. It lives for a day from its first line, not from its last:
 * a person who writes every few hours still gets a fresh notice the next day.
 */
export async function saveNoticeThread(
  accountId: string,
  userId: string,
  thread: NoticeThread
): Promise<void> {
  const remaining = Math.ceil(
    (thread.startedAt + NOTICE_THREAD_SECONDS * 1000 - Date.now()) / 1000
  );
  await getRedisConnection().set(
    noticeKey(accountId, userId),
    JSON.stringify(thread),
    "EX",
    Math.max(remaining, 60)
  );
}

const editPromptKey = (chatId: string, messageId: number) =>
  `triage:tg:prompt:${chatId}:${messageId}`;

/**
 * "Reply to this message with your own wording": the message the owner was
 * asked to reply to, and which draft their reply replaces.
 */
export interface EditPrompt {
  logId: string;
  /** The notice whose button was pressed, so its buttons can be cleared. */
  noticeMessageId: number | null;
}

export async function saveEditPrompt(
  chatId: string,
  promptMessageId: number,
  prompt: EditPrompt
): Promise<void> {
  await getRedisConnection().set(
    editPromptKey(chatId, promptMessageId),
    JSON.stringify(prompt),
    "EX",
    EDIT_PROMPT_SECONDS
  );
}

export async function getEditPrompt(
  chatId: string,
  promptMessageId: number
): Promise<EditPrompt | null> {
  const raw = await getRedisConnection().get(editPromptKey(chatId, promptMessageId));
  if (!raw) return null;
  try {
    const prompt = JSON.parse(raw) as EditPrompt;
    return typeof prompt.logId === "string" && prompt.logId ? prompt : null;
  } catch {
    return null;
  }
}

const POLLER_KEY = "triage:tg:poller";

/**
 * Only one process may read the bot's updates: Telegram hands each update to
 * a single reader, and two readers cut each other off. True means this process
 * holds (or just renewed) the right; false means another one does.
 */
export async function holdUpdatesPoller(
  instanceId: string,
  ttlSeconds: number
): Promise<boolean> {
  const redis = getRedisConnection();
  if ((await redis.set(POLLER_KEY, instanceId, "EX", ttlSeconds, "NX")) === "OK") return true;
  if ((await redis.get(POLLER_KEY)) !== instanceId) return false;
  await redis.set(POLLER_KEY, instanceId, "EX", ttlSeconds);
  return true;
}

/** Give the right up at shutdown, so the next process need not wait it out. */
export async function releaseUpdatesPoller(instanceId: string): Promise<void> {
  const redis = getRedisConnection();
  if ((await redis.get(POLLER_KEY)) === instanceId) await redis.del(POLLER_KEY);
}

/**
 * Claim the right to notify the owner about this person. False means a notice
 * already went out inside the cooldown, so this one should be skipped. Used
 * for the webhook channel; Telegram stacks instead (see notify.ts).
 */
export async function claimNotifySlot(
  accountId: string,
  userId: string
): Promise<boolean> {
  const result = await getRedisConnection().set(
    notifyKey(accountId, userId),
    "1",
    "EX",
    NOTIFY_COOLDOWN_SECONDS,
    "NX"
  );
  return result === "OK";
}

/**
 * What the worker is able to do, published by the worker itself on every
 * heartbeat. The page-answer model and the notification channel are configured
 * in the worker's environment, which the web app cannot see; this is how the
 * Settings page can still tell the owner whether each one is ready.
 */
export interface WorkerCapabilities {
  ai: boolean;
  notify: boolean;
  /** Whether the notification channel was actually proven to deliver. */
  notifyCheck?: NotifyCheck;
  /**
   * Whether this worker is hearing the buttons under a notice. Unset on a
   * worker older than the buttons.
   */
  replyButtons?: boolean;
  checkedAt: string;
}

/**
 *   ok            the test message reached the owner
 *   failed        the test message was rejected; it is retried after a pause
 *   pending       a test message is being sent right now
 *   unchecked     a channel is set that has no test (the generic webhook)
 *   unconfigured  no channel is set
 */
export type NotifyCheck = "ok" | "failed" | "pending" | "unchecked" | "unconfigured";

const helloKey = (fingerprint: string) => `triage:notify:hello:${fingerprint}`;
const HELLO_OK_TTL_SECONDS = 400 * 24 * 60 * 60;
const HELLO_RETRY_SECONDS = 10 * 60;
const HELLO_PENDING_SECONDS = 2 * 60;

/**
 * Claim the one test message for this notification configuration. True means
 * the caller should send it now; false means it was already sent, is being
 * sent, or failed recently and is waiting to be retried.
 */
export async function claimNotifyHello(fingerprint: string): Promise<boolean> {
  const result = await getRedisConnection().set(
    helloKey(fingerprint),
    "pending",
    "EX",
    HELLO_PENDING_SECONDS,
    "NX"
  );
  return result === "OK";
}

export async function setNotifyHelloResult(
  fingerprint: string,
  delivered: boolean
): Promise<void> {
  await getRedisConnection().set(
    helloKey(fingerprint),
    delivered ? "ok" : "failed",
    "EX",
    delivered ? HELLO_OK_TTL_SECONDS : HELLO_RETRY_SECONDS
  );
}

export async function getNotifyHelloState(
  fingerprint: string
): Promise<"ok" | "failed" | "pending" | null> {
  const value = await getRedisConnection().get(helloKey(fingerprint));
  return value === "ok" || value === "failed" || value === "pending" ? value : null;
}

const CAPABILITIES_KEY = "triage:worker:capabilities";
const CAPABILITIES_TTL_SECONDS = 120;

export async function recordWorkerCapabilities(
  capabilities: Omit<WorkerCapabilities, "checkedAt">
): Promise<void> {
  const payload: WorkerCapabilities = {
    ...capabilities,
    checkedAt: new Date().toISOString(),
  };
  await getRedisConnection().set(
    CAPABILITIES_KEY,
    JSON.stringify(payload),
    "EX",
    CAPABILITIES_TTL_SECONDS
  );
}

/** Null when no worker has reported recently (worker down, or an older build). */
export async function getWorkerCapabilities(): Promise<WorkerCapabilities | null> {
  const raw = await getRedisConnection().get(CAPABILITIES_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkerCapabilities;
  } catch {
    return null;
  }
}
