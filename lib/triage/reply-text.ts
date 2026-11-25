/**
 * Tidy text a model wrote into something that could be sent as it stands.
 * Shared by the answers that go out automatically and the drafts the owner
 * approves.
 */

const LABEL = /^(?:草稿|回覆|回复|回答|draft|answer)\s*[:：]\s*/i;
const WRAPPERS: [string, string][] = [
  ["「", "」"],
  ["『", "』"],
  ["“", "”"],
  ['"', '"'],
];
// The owner had the "(auto-reply)" tag dropped; a model that adds one anyway
// (it is all over older conversations) has it removed here.
const AUTO_SUFFIX = /\s*[（(]\s*自動回覆\s*[）)]\s*$/;
const SENTENCE_END = /[。！？!?～~\n]/g;

/**
 * No label in front, no quotation marks around the whole text, no
 * "(auto-reply)" tag, and no longer than `limit`. Null when nothing usable is
 * left.
 */
export function cleanReply(raw: string, limit: number): string | null {
  let text = raw.trim().replace(LABEL, "").trim();
  for (const [open, close] of WRAPPERS) {
    if (text.length > 2 && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, -close.length);
      // Only strip a pair that wraps the whole text, not one that merely
      // opens it and another that happens to end it.
      if (!inner.includes(open) && !inner.includes(close)) text = inner.trim();
    }
  }
  text = text.replace(AUTO_SUFFIX, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return null;
  if (text.length <= limit) return text;

  // Too long: keep whole sentences that fit. Half a sentence is worse than
  // nothing, so with no sentence break inside the limit there is no text.
  let cut = -1;
  for (const match of text.slice(0, limit).matchAll(SENTENCE_END)) {
    cut = (match.index ?? 0) + match[0].length;
  }
  const kept = cut > 0 ? text.slice(0, cut).trim() : "";
  return kept || null;
}
