import { getRedisConnection } from "@/lib/queue/client";
import {
  BOT_ACTIVITY_SECONDS,
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

/**
 * Claim the right to notify the owner about this person. False means a notice
 * already went out inside the cooldown, so this one should be skipped.
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
