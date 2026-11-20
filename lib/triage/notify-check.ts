import { isNotifyConfigured } from "@/lib/triage/config";
import { notifyFingerprint, sendHelloNotice } from "@/lib/triage/notify";
import {
  claimNotifyHello,
  getNotifyHelloState,
  setNotifyHelloResult,
  type NotifyCheck,
} from "@/lib/triage/state";

/**
 * Prove that the notification channel delivers, once per configuration.
 *
 * "The values are set" and "a message arrives" are different things: a token
 * pasted with a typo, or a bot the owner never pressed Start on, is set and
 * silent. Triage hands the messages that matter to this channel, so the first
 * time a Telegram configuration is seen the worker sends one test message to
 * the owner's own chat and records whether it was accepted. The Settings page
 * shows the result. A failure is retried after a pause; a success is never
 * repeated for the same token and chat.
 *
 * Called from the worker heartbeat.
 */

// The configuration already proven in this process, so the steady state costs
// nothing — not even a Redis read.
let provenFingerprint: string | null = null;

export async function checkNotifyChannel(): Promise<NotifyCheck> {
  const fingerprint = notifyFingerprint();
  if (!fingerprint) return isNotifyConfigured() ? "unchecked" : "unconfigured";
  if (provenFingerprint === fingerprint) return "ok";

  if (await claimNotifyHello(fingerprint)) {
    const delivered = await sendHelloNotice();
    await setNotifyHelloResult(fingerprint, delivered);
    if (delivered) provenFingerprint = fingerprint;
    return delivered ? "ok" : "failed";
  }

  const state = (await getNotifyHelloState(fingerprint)) ?? "pending";
  if (state === "ok") provenFingerprint = fingerprint;
  return state;
}

/** For tests: forget what this process has proven. */
export function resetNotifyCheck(): void {
  provenFingerprint = null;
}
