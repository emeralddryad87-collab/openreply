import { randomUUID } from "node:crypto";
import { getNotifyConfig } from "@/lib/triage/config";
import { handleTelegramUpdate, type TelegramUpdate } from "@/lib/triage/owner-actions";
import { holdUpdatesPoller, releaseUpdatesPoller } from "@/lib/triage/state";

/**
 * Hear the buttons under a notice.
 *
 * Telegram delivers a tap (or a reply typed to the bot) as an "update". The
 * worker asks for updates with a long poll: one request held open until
 * something happens. That needs no public address and no shared secret — the
 * only party that can deliver an update is Telegram, to whoever holds the bot
 * token, which is this worker.
 *
 * Runs beside the job queue in the worker process and is kept away from it:
 * nothing here can fail a job or stop the worker.
 *
 *   - One reader at a time. Telegram gives each update to a single reader and
 *     two readers cut each other off, so the right to read is a short lease in
 *     Redis. During a deploy the new process waits for the old one to let go.
 *   - After a gap — a restart, a network outage — whatever was waiting is
 *     handled as "late": a late tap on "send" asks the owner to tap again
 *     instead of sending (see owner-actions.ts).
 */

const LONG_POLL_SECONDS = 25;
const REQUEST_TIMEOUT_MS = (LONG_POLL_SECONDS + 15) * 1000;
const LEASE_SECONDS = 90;
// With no successful read for this long, the next batch is treated as late.
const CAUGHT_UP_WITHIN_MS = 90 * 1000;

const NOT_CONFIGURED_PAUSE_MS = 60 * 1000;
const NOT_OUR_TURN_PAUSE_MS = 15 * 1000;
const AFTER_ERROR_PAUSE_MS = 10 * 1000;
// 409: a webhook is set on the bot, or another reader is active.
const AFTER_CONFLICT_PAUSE_MS = 30 * 1000;
// How long a shutdown waits for a tap that is being acted on right now.
const STOP_GRACE_MS = 8 * 1000;

let lastReadAt = 0;

/** Whether this process has heard from Telegram recently: the buttons work. */
export function replyButtonsReady(): boolean {
  return Date.now() - lastReadAt < 2 * 60 * 1000;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

type Reply = { ok: true; updates: TelegramUpdate[] } | { ok: false; status: number };

async function getUpdates(
  token: string,
  offset: number | undefined,
  waitSeconds: number,
  signal: AbortSignal
): Promise<Reply> {
  // One controller for both ways out: the request's own time limit, and the
  // worker shutting down.
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, REQUEST_TIMEOUT_MS);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        timeout: waitSeconds,
        allowed_updates: ["message", "callback_query"],
        ...(offset === undefined ? {} : { offset }),
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status };
    const data = (await response.json().catch(() => null)) as { result?: unknown } | null;
    return { ok: true, updates: Array.isArray(data?.result) ? data.result : [] };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

async function run(instanceId: string, signal: AbortSignal): Promise<void> {
  let offset: number | undefined;
  let lastStatus = 0;

  while (!signal.aborted) {
    const { telegramBotToken: token, telegramChatId: chatId } = getNotifyConfig();
    if (!token || !chatId) {
      await pause(NOT_CONFIGURED_PAUSE_MS, signal);
      continue;
    }

    let wait = 0;
    try {
      if (!(await holdUpdatesPoller(instanceId, LEASE_SECONDS))) {
        wait = NOT_OUR_TURN_PAUSE_MS;
      } else {
        // Catching up after a gap: take what is waiting without holding the
        // request open, and handle it as late.
        const late = Date.now() - lastReadAt > CAUGHT_UP_WITHIN_MS;
        const reply = await getUpdates(token, offset, late ? 0 : LONG_POLL_SECONDS, signal);
        if (reply.ok) {
          lastReadAt = Date.now();
          lastStatus = 0;
          for (const update of reply.updates) {
            // Moved on before the update is handled: one that cannot be
            // handled must not come back for ever.
            if (typeof update.update_id === "number") offset = update.update_id + 1;
            await handleTelegramUpdate(update, { late });
          }
        } else {
          // Say it once per kind of refusal, not every few seconds.
          if (reply.status !== lastStatus) {
            console.error(`[Triage] Telegram updates refused: HTTP ${reply.status}`);
            lastStatus = reply.status;
          }
          wait = reply.status === 409 ? AFTER_CONFLICT_PAUSE_MS : AFTER_ERROR_PAUSE_MS;
        }
      }
    } catch (error) {
      if (signal.aborted) break;
      // The kind of failure only: the request URL contains the bot token.
      const name = error instanceof Error ? error.name : "Error";
      console.error(`[Triage] Telegram updates failed (${name})`);
      wait = AFTER_ERROR_PAUSE_MS;
    }
    if (wait) await pause(wait, signal);
  }
}

/**
 * Start listening. Returns a handle whose `stop` ends the loop and gives the
 * right to read back, so the next process can take over at once.
 */
export function startTelegramUpdates(): { stop: () => Promise<void> } {
  const instanceId = randomUUID();
  const stopper = new AbortController();
  const loop = run(instanceId, stopper.signal).catch((error) => {
    const name = error instanceof Error ? error.name : "Error";
    console.error(`[Triage] Telegram updates stopped (${name})`);
  });

  return {
    stop: async () => {
      stopper.abort();
      // A tap being acted on gets a moment to finish, and the lease is given
      // back; but a shutdown must never hang on either, so both are bounded.
      const finished = loop.then(() => releaseUpdatesPoller(instanceId)).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        finished,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STOP_GRACE_MS);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}

/** For tests: forget when Telegram was last heard from. */
export function resetTelegramUpdates(): void {
  lastReadAt = 0;
}
