import { createHash } from "node:crypto";
import { checkClaude } from "@/lib/triage/claude";
import { getAiConfig } from "@/lib/triage/config";
import { sendOwnerAlert } from "@/lib/triage/notify";
import { claimAiAlert, type AiCheck } from "@/lib/triage/state";

/**
 * Prove that the model answers, not just that a key is set.
 *
 * "A key is set" and "the key is accepted" are different things: a value
 * pasted wrong is set, and every call fails. Triage then degrades quietly —
 * each question is handed to the owner with no draft — and nothing on the
 * surface says why. That is exactly what happened on the day Claude was
 * switched on (2026-11-25), so the worker now asks Anthropic a free question
 * at start-up and every so often after: is this key accepted, and does this
 * model exist? The Settings page shows the answer, and a key or model that is
 * refused is reported to the owner's own chat once.
 *
 * Called from the worker heartbeat. Only Claude is checked; Groq, the older
 * path, reports "unchecked" as before.
 */

// A healthy connection is looked at again now and then; a broken one soon, so
// that a corrected key shows as corrected within a couple of minutes.
const RECHECK_OK_MS = 30 * 60_000;
const RECHECK_BAD_MS = 2 * 60_000;

const ALERT: Partial<Record<AiCheck, string>> = {
  bad_key:
    "⚠️ OpenReply：Claude 不接受 Railway 上的 ANTHROPIC_API_KEY（金鑰無效）。修好之前，需要 AI 判斷的私訊都只會通知你、不會有草稿；固定回覆不受影響。",
  bad_model:
    "⚠️ OpenReply：TRIAGE_CLAUDE_MODEL 填的模型名稱 Claude 不認得。修好之前，需要 AI 判斷的私訊都只會通知你、不會有草稿；固定回覆不受影響。",
};

let last: { fingerprint: string; result: AiCheck; at: number } | null = null;

/** A one-way name for the key and model in use: it can be compared without keeping the key. */
function fingerprintOf(apiKey: string, model: string): string {
  return createHash("sha256").update(`${apiKey}:${model}`).digest("hex").slice(0, 16);
}

/** Whether the configured model can be reached. Never throws. */
export async function checkAiConnection(): Promise<AiCheck> {
  const { provider, apiKey, model } = getAiConfig();
  if (!provider) return "unconfigured";
  if (provider !== "anthropic") return "unchecked";

  const fingerprint = fingerprintOf(apiKey, model);
  const now = Date.now();
  const known = last?.fingerprint === fingerprint ? last : null;
  if (known && now - known.at < (known.result === "ok" ? RECHECK_OK_MS : RECHECK_BAD_MS)) {
    return known.result;
  }

  let result: AiCheck;
  try {
    result = await checkClaude(apiKey, model);
  } catch {
    result = "failed";
  }
  last = { fingerprint, result, at: now };

  // A refused key or model is the owner's to fix, and nothing else tells
  // them: say so once, in the chat their notices arrive in.
  const alert = ALERT[result];
  if (alert && known?.result !== result) {
    try {
      if (await claimAiAlert(`${result}:${fingerprint}`)) await sendOwnerAlert(alert);
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      console.error(`[Triage] Could not report a refused model setting (${name})`);
    }
  }
  return result;
}

/** For tests: forget what this process has learned. */
export function resetAiCheck(): void {
  last = null;
}
