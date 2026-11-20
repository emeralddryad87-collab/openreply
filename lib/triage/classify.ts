/**
 * Rule-based first pass of DM triage: recognise, without calling a model, the
 * short messages whose handling is fixed.
 *
 *   "no questions" / "all clear" / "got it"   the sign-off line
 *   "thanks"                                  the thanks line
 *   a bare acknowledgement (好的, ok, 👍)      nothing
 *   "is this an AI?"                          the disclosure line
 *   "I want the owner"                        hand over to the owner
 *
 * Deliberately strict: a message only counts when it is made up ENTIRELY of
 * known phrases. "沒問題，但我想問…" must not match, because answering a real
 * question with "feel free to ask" is the failure this feature exists to avoid.
 * Whatever is not recognised here goes on to the model, or to the owner.
 */

export type CannedKind = "no_problem" | "thanks" | "ack";

// Traditional and simplified forms are both listed: the audience writes both.
const NO_PROBLEM = [
  "沒有問題", "沒問題", "沒有", "沒", "沒有了", "沒了", "目前沒有", "暫時沒有",
  "暫時沒有問題", "目前沒有問題", "沒有問題了", "沒問題了", "都沒問題", "沒有其他問題",
  "沒有什麼問題", "沒什麼問題", "沒有甚麼問題", "沒甚麼問題", "沒有任何問題", "都沒有問題",
  "沒有疑問", "沒有其他問題了",
  "没有问题", "没问题", "没有", "没", "没有了", "没了", "目前没有", "暂时没有",
  "暂时没有问题", "目前没有问题", "没有问题了", "没问题了", "都没问题", "没有其他问题",
  "没有什么问题", "没什么问题", "没有任何问题", "都没有问题", "没有疑问", "没有其他问题了",
  "noproblem", "noquestions", "noquestion", "nope", "no", "nothing", "allgood",
];

// "I understood" is a sign-off as well and gets the same line as "no questions".
const UNDERSTOOD = [
  "清楚", "都清楚", "很清楚", "都很清楚", "非常清楚", "清楚了", "都清楚了", "很清楚了",
  "懂了", "都懂", "都懂了", "看懂了", "聽懂了", "听懂了",
  "明白", "明白了", "都明白", "都明白了",
  "了解", "了解了", "都了解", "都了解了", "瞭解", "瞭解了", "都瞭解", "都瞭解了",
  "理解", "理解了", "都理解", "都理解了",
  "知道了", "都知道了",
  "gotit", "noted", "understood", "iunderstand", "allclear", "clear", "isee",
];

// A bare "no" on its own answers "any questions?". Followed by another word it
// usually negates that word instead — 沒收到 is "I didn't get it", 目前沒有很清楚
// is "it isn't clear yet" — and those are exactly the messages a person must
// see. So after a phrase that ends in a bare "no", only a thank-you (or the end
// of the message) is allowed.
const ENDS_IN_BARE_NO = /(?:沒有|沒|没有|没)$/u;

const THANKS = [
  "謝謝", "謝謝你", "謝謝您", "感謝", "感謝你", "感謝您", "感恩", "謝啦", "謝了", "多謝",
  "謝謝分享", "感謝分享", "非常感謝", "太感謝了", "太感謝",
  "谢谢", "谢谢你", "谢谢您", "感谢", "感谢你", "感谢您", "谢啦", "谢了", "多谢",
  "谢谢分享", "感谢分享", "非常感谢", "太感谢了", "太感谢",
  "thanks", "thankyou", "thankyousomuch", "thanksalot", "thx", "tq", "tqvm", "ty", "tysm", "3q",
];

// Acknowledgements that carry no question, no thanks and no "I understood".
// On their own they get no reply at all; next to a real phrase they are padding.
const FILLER = [
  "好的", "好", "好喔", "好哦", "ok", "okay", "okok", "k", "嗯", "嗯嗯", "恩", "恩恩",
  "收到", "可以", "行", "讚", "赞", "棒", "目前", "暫時", "暂时",
  "sure", "yes", "yep", "nice", "great", "cool",
];

// Sentence-final particles that change nothing: 沒問題喔 / 謝謝啦 / 好的呢.
const PARTICLE_CLASS = "喔哦噢啊呀啦呢唷耶欸哈嘿了囉咯嘍哟哇";
const PARTICLES = new RegExp(`[${PARTICLE_CLASS}]+$`, "u");
const LEADING_PARTICLES = new RegExp(`^[${PARTICLE_CLASS}]+`, "u");

const MAX_LENGTH = 24;

/** The wording only: lower-cased, with spaces, punctuation and emoji removed. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

const TOKENS: { text: string; kind: CannedKind }[] = [
  ...NO_PROBLEM.map((text) => ({ text, kind: "no_problem" as const })),
  ...UNDERSTOOD.map((text) => ({ text, kind: "no_problem" as const })),
  ...THANKS.map((text) => ({ text, kind: "thanks" as const })),
  ...FILLER.map((text) => ({ text, kind: "ack" as const })),
]
  .map((t) => ({ ...t, text: normalize(t.text) }))
  // Longest first, so "沒有問題" is consumed whole instead of as "沒有" + junk.
  .sort((a, b) => b.text.length - a.text.length);

const BARE_NEGATIONS = new Set(
  NO_PROBLEM.map(normalize).filter((text) => ENDS_IN_BARE_NO.test(text) || text === "no")
);

/**
 * Consume `rest` as a sequence of known phrases, allowing trailing particles
 * after each one. Returns the kinds found, or null if any part is unknown.
 */
function consume(
  rest: string,
  found: CannedKind[],
  depth = 0,
  afterBareNegation = false
): CannedKind[] | null {
  if (!rest) return found;
  if (depth > 8) return null;

  for (const token of TOKENS) {
    if (!rest.startsWith(token.text)) continue;
    if (afterBareNegation && token.kind !== "thanks") continue;
    let tail = rest.slice(token.text.length);
    const particles = tail.match(LEADING_PARTICLES);
    const branches = particles ? [tail.slice(particles[0].length), tail] : [tail];
    for (const next of branches) {
      tail = next;
      const result = consume(
        tail,
        [...found, token.kind],
        depth + 1,
        BARE_NEGATIONS.has(token.text)
      );
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

// ─── "Is this an AI?" and "I want the owner" ──────────────────────────────────
//
// Only the short, unmistakable wordings are recognised here, so that these two
// work in every mode. The audience talks about AI tools all day: "這個 AI 要付費
// 嗎" must never be read as "are you an AI", which is why every pattern is
// anchored to the whole message. Looser wordings are left to the model.

/** Lower-cased and width-folded with whitespace removed; punctuation kept. */
function squash(text: string): string {
  return (text ?? "").toLowerCase().normalize("NFKC").replace(/\s+/g, "");
}

const BOT =
  "(?:chatgpt|chatbot|gpt|a\\.i\\.?|ai|bot|機器人|机器人|自動回覆|自動回復|自动回复|罐頭訊息|罐头消息|罐頭|罐头)";
const HUMAN = "(?:真人|本人|人工|活人)";
const REPLY_VERB =
  "(?:在回覆|在回复|在回|回覆的|回复的|回復的|回的|回覆|回复|回復|回答|回我|回訊息|回消息|親自回|亲自回)";
const QUESTION_END = "(?:嗎|吗|麼|么|呢|吧|啊|喔|哦|耶)?[?!.~。]*";
const LEAD =
  "(?:請問|请问|所以|那|欸|诶|哈囉|你好|您好|hi|hello)?(?:你|妳|您|這個|这个|這邊|这边|這裡|这里|這|这|現在|现在)?";

const ASKS_IF_AUTOMATED = [
  // 你是AI嗎 / 是機器人? / 這是自動回覆嗎 / 是不是AI在回
  new RegExp(`^${LEAD}(?:是不是|是)${BOT}${REPLY_VERB}?${QUESTION_END}$`, "u"),
  // AI回覆嗎 / 機器人回的吧 / AI?
  new RegExp(`^${LEAD}${BOT}(?:${REPLY_VERB}${QUESTION_END}|(?:嗎|吗)[?!.~。]*|[?]+)$`, "u"),
  // 是真人嗎 / 你是本人嗎 / 是你本人回的嗎 / 有真人嗎
  new RegExp(
    `^${LEAD}(?:是不是|是|有)(?:你|妳|您)?${HUMAN}${REPLY_VERB}?${QUESTION_END}$`,
    "u"
  ),
  // 真人嗎 / 本人?
  new RegExp(`^${LEAD}${HUMAN}${REPLY_VERB}?(?:嗎|吗|[?])+[?!.~。]*$`, "u"),
];

const SHORT_QUESTION_MAX = 20;

/** "Are you an AI?" / "Is this the real person?" — asked about the replies. */
export function asksIfAutomated(text: string): boolean {
  const squashed = squash(text);
  if (!squashed || squashed.length > SHORT_QUESTION_MAX) return false;
  return ASKS_IF_AUTOMATED.some((pattern) => pattern.test(squashed));
}

const DECLINES = /不用|不需要|不必|不要|別|别|免了/u;
const WANTS_HUMAN = [
  // 我要找本人 / 想找你本人 / 可以轉真人嗎 / 請本人回覆
  new RegExp(
    `(?:找|轉|转|換|换|叫|請|请|要|給我|给我|接)(?:一下|個|个|給|给)?(?:你|妳|您|他)?${HUMAN}`,
    "u"
  ),
  // 真人客服 / 人工客服
  /(?:真人|人工)(?:客服|服務|服务)/u,
];

const HUMAN_REQUEST_MAX = 30;

/** "I want to talk to the owner / a real person." */
export function asksForHuman(text: string): boolean {
  const squashed = squash(text);
  if (!squashed || squashed.length > HUMAN_REQUEST_MAX) return false;
  if (DECLINES.test(squashed)) return false;
  return WANTS_HUMAN.some((pattern) => pattern.test(squashed));
}

// ─── Answers to "do you want the owner in person?" ────────────────────────────

const YES = new Set(
  [
    "要", "要的", "要啊", "想", "想要", "好", "好的", "好啊", "好喔", "好哦", "是", "是的",
    "對", "对", "對啊", "对啊", "嗯", "嗯嗯", "恩", "可以", "麻煩", "麻烦", "麻煩了", "麻烦了",
    "麻煩你", "麻烦你", "麻煩你了", "麻烦你了", "需要", "有需要", "本人", "真人", "找本人",
    "要找本人", "我要找本人", "想找本人", "我想找本人", "找真人", "要找真人", "我要找真人",
    "請他回我", "请他回我", "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "please", "plz",
  ].map(normalize)
);

const NO = new Set(
  [
    "不用", "不用了", "不需要", "不需要了", "不必", "不必了", "不要", "不要了", "不了",
    "沒關係", "没关系", "沒事", "没事", "先不用", "不用麻煩", "不用麻烦", "算了",
    "no", "nope", "nah",
  ].map(normalize)
);

const THANKS_TOKENS = THANKS.map(normalize).sort((a, b) => b.length - a.length);

/**
 * The ways the message can be read as a bare answer: as written, without its
 * closing particles, and without a closing thank-you ("好的謝謝" → "好的").
 */
function answerForms(text: string): string[] {
  const whole = normalize(text ?? "");
  const forms = new Set([whole, whole.replace(PARTICLES, "")]);
  for (const form of [...forms]) {
    const thanks = THANKS_TOKENS.find((t) => form.length > t.length && form.endsWith(t));
    if (!thanks) continue;
    const rest = form.slice(0, -thanks.length);
    forms.add(rest);
    forms.add(rest.replace(PARTICLES, ""));
  }
  return [...forms].filter(Boolean);
}

/** A plain "yes" — only meaningful right after the sender was asked something. */
export function answersYes(text: string): boolean {
  if (/[?？]/.test(text ?? "")) return false;
  return answerForms(text).some((form) => YES.has(form));
}

/** A plain "no" — only meaningful right after the sender was asked something. */
export function answersNo(text: string): boolean {
  if (/[?？]/.test(text ?? "")) return false;
  const forms = answerForms(text);
  return forms.some((form) => NO.has(form)) && !forms.some((form) => YES.has(form));
}
