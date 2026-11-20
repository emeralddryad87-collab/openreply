/**
 * Rule-based first pass of DM triage: recognise the short replies that need no
 * thinking — "no questions", "thanks", or a bare acknowledgement — without
 * calling a model. Anything else returns null and goes on to the page-answer
 * step (or to the account owner).
 *
 * Deliberately strict: a message only counts when it is made up ENTIRELY of
 * known phrases. "沒問題，但我想問…" must not match, because answering a real
 * question with "feel free to ask" is the failure this feature exists to avoid.
 */

export type CannedKind = "no_problem" | "thanks" | "ack";

// Traditional and simplified forms are both listed: the audience writes both.
const NO_PROBLEM = [
  "沒有問題", "沒問題", "沒有", "沒", "沒有了", "沒了", "目前沒有", "暫時沒有",
  "暫時沒有問題", "目前沒有問題", "沒有問題了", "沒問題了", "都沒問題", "沒有其他問題",
  "没有问题", "没问题", "没有", "没", "没有了", "没了", "目前没有", "暂时没有",
  "暂时没有问题", "目前没有问题", "没有问题了", "没问题了", "都没问题", "没有其他问题",
  "noproblem", "noquestions", "noquestion", "nope", "no", "nothing", "allgood",
];

const THANKS = [
  "謝謝", "謝謝你", "謝謝您", "感謝", "感謝你", "感謝您", "感恩", "謝啦", "謝了", "多謝",
  "謝謝分享", "感謝分享", "非常感謝", "太感謝了", "太感謝",
  "谢谢", "谢谢你", "谢谢您", "感谢", "感谢你", "感谢您", "谢啦", "谢了", "多谢",
  "谢谢分享", "感谢分享", "非常感谢", "太感谢了", "太感谢",
  "thanks", "thankyou", "thankyousomuch", "thanksalot", "thx", "tq", "tqvm", "ty", "tysm", "3q",
];

// Acknowledgements that carry no question and no thanks. On their own they get
// no reply at all; next to a real phrase they are just padding.
const FILLER = [
  "好的", "好", "好喔", "好哦", "ok", "okay", "okok", "k", "嗯", "嗯嗯", "恩", "恩恩",
  "收到", "了解", "瞭解", "明白", "知道了", "懂了", "可以", "行", "讚", "赞", "棒",
  "gotit", "noted", "sure", "yes", "yep", "nice", "great", "cool",
];

// Sentence-final particles that change nothing: 沒問題喔 / 謝謝啦 / 好的呢.
const PARTICLES = /[喔哦噢啊呀啦呢唷耶欸哈嘿了囉咯嘍哟哇]+$/u;

const MAX_LENGTH = 24;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    // Drop everything that is not a letter or digit: spaces, punctuation,
    // emoji, tildes. What is left is the wording only.
    .replace(/[^\p{L}\p{N}]/gu, "");
}

const TOKENS: { text: string; kind: CannedKind }[] = [
  ...NO_PROBLEM.map((text) => ({ text, kind: "no_problem" as const })),
  ...THANKS.map((text) => ({ text, kind: "thanks" as const })),
  ...FILLER.map((text) => ({ text, kind: "ack" as const })),
]
  .map((t) => ({ ...t, text: normalize(t.text) }))
  // Longest first, so "沒有問題" is consumed whole instead of as "沒有" + junk.
  .sort((a, b) => b.text.length - a.text.length);

/**
 * Consume `rest` as a sequence of known phrases, allowing trailing particles
 * after each one. Returns the kinds found, or null if any part is unknown.
 */
function consume(rest: string, found: CannedKind[], depth = 0): CannedKind[] | null {
  if (!rest) return found;
  if (depth > 8) return null;

  for (const token of TOKENS) {
    if (!rest.startsWith(token.text)) continue;
    let tail = rest.slice(token.text.length);
    const particles = tail.match(/^[喔哦噢啊呀啦呢唷耶欸哈嘿了囉咯嘍哟哇]+/u);
    const branches = particles ? [tail.slice(particles[0].length), tail] : [tail];
    for (const next of branches) {
      tail = next;
      const result = consume(tail, [...found, token.kind], depth + 1);
      if (result) return result;
    }
  }
  return null;
}

export function classifyCanned(text: string): CannedKind | null {
  // A question mark turns any of these phrases into a question — "可以？",
  // "沒有？", or a bare "?" from someone still waiting. That needs a person.
  if (/[?？]/.test(text ?? "")) return null;

  const cleaned = normalize(text ?? "");
  // Emoji- or punctuation-only messages ("👍", "🙏🙏") are acknowledgements.
  if (!cleaned) return text?.trim() ? "ack" : null;
  if (cleaned.length > MAX_LENGTH) return null;

  const kinds = consume(cleaned.replace(PARTICLES, ""), []) ?? consume(cleaned, []);
  if (!kinds || kinds.length === 0) return null;

  // "沒問題，謝謝" answers the question we asked, so it gets that reply.
  if (kinds.includes("no_problem")) return "no_problem";
  if (kinds.includes("thanks")) return "thanks";
  return "ack";
}
