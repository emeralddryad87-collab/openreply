/**
 * Rule-based first pass of DM triage: recognise, without calling a model, the
 * short messages whose handling is fixed.
 *
 *   "no questions" / "all clear" / "got it"   the sign-off line
 *   "thanks"                                  the thanks line
 *   "I followed you" (已追蹤)                  the link, like "I never got it"
 *   "I never got the link" (沒收到)            the link, or the follow button, again
 *   "I don't get it" / "it's hard"            the which-step-are-you-stuck-on line
 *   another account's auto-reply              nothing, and nobody is told
 *   a bare acknowledgement (好的, ok, 👍)      the sign-off line as well
 *   "is this an AI?"                          the disclosure line
 *   "I want the owner"                        hand over to the owner
 *
 * Deliberately strict: a message only counts when it is made up ENTIRELY of
 * known phrases. "沒問題，但我想問…" must not match, because answering a real
 * question with "feel free to ask" is the failure this feature exists to avoid.
 * Whatever is not recognised here goes on to the model, or to the owner.
 */

export type CannedKind =
  | "no_problem"
  | "thanks"
  | "followed"
  | "missing_link"
  | "stuck"
  | "ack";

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
  // "有的" / "有" answers "did you try it?" and "does that make sense?" alike.
  "有的", "有", "有喔", "有哦", "有啊", "有呀", "有的喔", "有明白", "有懂", "有看懂", "有了解",
  "有理解", "有試", "有試過", "有試了", "試過了", "試了", "有用", "有在用", "用過了", "有看", "有看了",
  "看了", "看過了", "有试", "有试过", "有试了", "试过了", "试了", "用过了", "看过了",
  "gotit", "noted", "understood", "iunderstand", "allclear", "clear", "isee",
];

// Answers to "was it hard to follow?" that mean "no": not hard, or not tried
// yet. Both close the conversation the same way as "no questions".
const EASY_OR_LATER = [
  "不會", "不會啊", "不會啦", "不會難", "不會很難", "不會太難", "不難", "不難啊", "不算難", "不複雜",
  "不會很複雜", "沒有很難", "沒有難", "沒很難", "沒有很複雜", "還好", "還好啦", "還可以", "還行", "還ok",
  "不会", "不会啊", "不会啦", "不会难", "不会很难", "不会太难", "不难", "不难啊", "不算难", "不复杂",
  "不会很复杂", "没有很难", "没有难", "没很难", "没有很复杂", "还好", "还好啦", "还可以", "还行", "还ok",
  "等下試試", "等下才試試", "等下再試", "等下再試試", "等一下試試", "等一下再試", "等等試試", "等等再試",
  "晚點試試", "晚點再試", "晚點再試試", "晚一點試試", "之後試試", "之後再試", "之後再試試", "有空試試",
  "有空再試", "有空再試試", "回家試試", "回家再試", "明天試試", "明天再試", "改天試試", "改天再試",
  "還沒試", "還沒試過", "還沒有試", "還沒開始", "還沒開始試", "還沒", "還沒有", "還沒看", "還沒看完",
  "還沒研究", "還在研究", "還在研究中", "還在看", "還在試", "還在摸索", "我試試", "我試試看", "試試看",
  "我來試試", "我來試試看", "我先試試", "我先試試看", "先試試看", "正在試", "研究中", "研究一下",
  "我研究一下", "我研究看看", "我看看", "我先看看", "先看看",
  "等下试试", "等下才试试", "等下再试", "等下再试试", "等一下试试", "等一下再试", "等等试试", "等等再试",
  "晚点试试", "晚点再试", "晚点再试试", "晚一点试试", "之后试试", "之后再试", "之后再试试", "有空试试",
  "有空再试", "回家试试", "回家再试", "明天试试", "明天再试", "改天试试", "改天再试",
  "还没试", "还没试过", "还没有试", "还没开始", "还没开始试", "还没", "还没有", "还没看", "还没看完",
  "还没研究", "还在研究", "还在研究中", "还在看", "还在试", "还在摸索", "我试试", "我试试看", "试试看",
  "我来试试", "我来试试看", "我先试试", "我先试试看", "先试试看", "正在试",
  "notyet", "notyettried", "haventtried", "haventtriedyet", "willtry", "illtry", "illtryit", "letmetry",
  "trylater", "illtrylater", "later", "nothard", "notbad", "prettyeasy", "easy",
];

// "I don't get it" / "it's hard", with no word about which part. These get one
// question back: which step, and can you send a screenshot.
const STUCK = [
  "不知道如何使用", "不知道怎麼用", "不知道怎麼使用", "不知道要怎麼用", "不知道怎麼做", "不知道要怎麼做",
  "不知道怎麼弄", "不知道怎麼操作", "不知道怎麼開始", "不知道從哪開始", "不知道從哪裡開始",
  "不會用", "不會做", "不會弄", "不會操作", "不太會", "不太會用", "我不會用", "我不會",
  "看不懂", "看不太懂", "我看不懂", "不懂", "不太懂", "還是不懂", "聽不懂", "搞不懂", "搞不定",
  "還是看不懂", "還是不會", "還是不會用", "還是不太懂", "還是不明白", "還是不知道",
  "不明白", "不太明白", "不了解", "不太了解", "不理解", "不太理解", "不清楚", "不太清楚", "還是不清楚",
  "不是很懂", "不是很清楚", "不是很明白", "不是很了解", "有點不懂", "有點看不懂", "有點不清楚",
  "沒看懂", "沒有看懂", "沒懂", "沒有懂", "沒聽懂", "沒有很懂", "沒有很清楚", "沒有明白", "沒有很理解",
  "沒有很了解", "沒了解", "沒有了解",
  "難", "好難", "很難", "太難", "太難了", "超難", "覺得難", "覺得很難", "有點難", "有難", "蠻難", "蠻難的",
  "滿難的", "會難", "會很難", "複雜", "好複雜", "很複雜", "太複雜", "太複雜了", "有點複雜", "天哪好複雜",
  "卡住", "卡住了", "我卡住了", "卡關", "卡關了", "做不出來", "弄不出來", "做不到",
  "不知道怎么用", "不知道怎么使用", "不知道要怎么用", "不知道怎么做", "不知道要怎么做", "不知道怎么弄",
  "不知道怎么操作", "不知道怎么开始", "不知道从哪开始", "不知道从哪里开始",
  "不会用", "不会做", "不会弄", "不会操作", "不太会", "不太会用", "我不会用", "我不会",
  "看不太懂", "还是不懂", "听不懂", "不太明白", "不太了解", "不太理解", "不太清楚", "还是不清楚",
  "还是看不懂", "还是不会", "还是不会用", "还是不太懂", "还是不明白", "还是不知道",
  "不是很懂", "不是很清楚", "不是很明白", "不是很了解", "有点不懂", "有点看不懂", "有点不清楚",
  "没看懂", "没有看懂", "没懂", "没有懂", "没听懂", "没有很懂", "没有很清楚", "没有明白", "没有很理解",
  "没有很了解", "没了解", "没有了解",
  "难", "好难", "很难", "太难", "太难了", "超难", "觉得难", "觉得很难", "有点难", "蛮难", "蛮难的",
  "满难的", "会难", "会很难", "复杂", "好复杂", "很复杂", "太复杂", "太复杂了", "有点复杂",
  "卡关", "卡关了", "做不出来", "弄不出来",
  "idontunderstand", "dontunderstand", "idontgetit", "confused", "imconfused", "toohard", "sohard",
  "itshard", "hard", "stuck", "imstuck", "idontknowhow", "idontknowhowtouseit",
];

// People who are asked to follow before getting their link often type that
// they did, instead of tapping the button that checks it and sends the link.
const FOLLOWED = [
  "已追蹤", "已經追蹤", "已追蹤了", "已經追蹤了", "追蹤了", "追蹤好了", "追蹤完成", "已完成追蹤",
  "我追蹤了", "我已追蹤", "我已經追蹤", "我已經追蹤了", "我有追蹤", "我有追蹤了", "有追蹤", "有追蹤了",
  "已追蹤你", "已追蹤你了", "追蹤你了", "已按追蹤", "按追蹤了", "已追", "追了",
  "已追踪", "已经追踪", "已追踪了", "已经追踪了", "追踪了", "追踪好了", "追踪完成", "已完成追踪",
  "我追踪了", "我已追踪", "我已经追踪", "我已经追踪了", "我有追踪", "有追踪", "已追踪你", "追踪你了",
  "已關注", "已經關注", "已關注了", "已經關注了", "關注了", "我關注了", "我已關注", "我已經關注了",
  "已关注", "已经关注", "已关注了", "已经关注了", "关注了", "我关注了", "我已关注", "我已经关注了",
  "已follow", "已經follow", "已经follow", "follow了", "我follow了",
  "followed", "ifollowed", "ifollowedyou", "alreadyfollowed", "following", "imfollowing",
];

// "The link never came" / "there is no button". Said by people who followed but
// did not tap the button again, and by people who never followed: the answer
// is the link for the first and the follow button for the second (the caller
// checks which). Listed whole, so that they match before the bare "no" below.
const MISSING_LINK = [
  "沒收到", "沒有收到", "還沒收到", "還沒有收到", "都沒收到", "沒收到連結", "沒有收到連結",
  "還沒收到連結", "還沒有收到連結", "還是沒收到", "還是沒有收到", "還是收不到",
  "沒收到鏈接", "沒有收到鏈接", "還沒收到鏈接", "沒收到東西", "沒有收到東西", "沒收到訊息",
  "沒看到連結", "沒有看到連結", "沒看到鏈接", "沒看到按鈕", "沒有看到按鈕", "沒有按鈕", "沒按鈕",
  "沒有連結", "沒連結", "沒有鏈接", "找不到連結", "找不到鏈接", "找不到按鈕", "看不到連結",
  "看不到鏈接", "看不到按鈕", "連結沒有來", "連結沒來", "連結不見了", "收不到", "收不到連結",
  "没收到", "没有收到", "还没收到", "还没有收到", "都没收到", "没收到链接", "没有收到链接",
  "还没收到链接", "还没有收到链接", "还是没收到", "还是没有收到", "还是收不到",
  "没收到东西", "没有收到东西", "没收到消息", "没看到链接", "没有看到链接", "没看到按钮",
  "没有看到按钮", "没有按钮", "没按钮", "没有链接", "没链接", "找不到链接", "找不到按钮",
  "看不到链接", "看不到按钮", "链接没有来", "链接没来", "链接不见了", "收不到链接",
  "didntgetit", "didntgetthelink", "ididntgetit", "ididntgetthelink", "nolink", "nobutton",
  "notreceived", "didntreceive", "ididntreceiveit", "haventreceived",
];

// A bare "no" on its own answers "any questions?". Followed by another word it
// usually negates that word instead — 沒辦法下載 is "I cannot download it" — and
// those are exactly the messages a person must see. So after a phrase that
// ends in a bare "no", only a thank-you (or the end of the message) is
// allowed. The negations that do have a fixed meaning (沒有很難, 沒看懂, 沒收到)
// are listed whole above and match first.
const ENDS_IN_BARE_NO = /(?:沒有|沒|没有|没)$/u;

const THANKS = [
  "謝謝", "謝謝你", "謝謝您", "感謝", "感謝你", "感謝您", "感恩", "謝啦", "謝了", "多謝",
  "謝謝分享", "感謝分享", "非常感謝", "太感謝了", "太感謝",
  "谢谢", "谢谢你", "谢谢您", "感谢", "感谢你", "感谢您", "谢啦", "谢了", "多谢",
  "谢谢分享", "感谢分享", "非常感谢", "太感谢了", "太感谢",
  "thanks", "thankyou", "thankyousomuch", "thanksalot", "thx", "tq", "tqvm", "ty", "tysm", "3q",
];

// Acknowledgements that carry no question, no thanks and no "I understood":
// usually a one-word answer to "does that make sense?".
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

// A greeting in front changes nothing either: "您好! 我已追蹤" is "我已追蹤".
// Only in front of something: a greeting on its own is not one of the kinds.
const GREETING = /^(?:你好|您好|妳好|哈囉|哈啰|嗨|hello|hi|hey)+(?=.)/u;

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
  ...EASY_OR_LATER.map((text) => ({ text, kind: "no_problem" as const })),
  ...STUCK.map((text) => ({ text, kind: "stuck" as const })),
  ...THANKS.map((text) => ({ text, kind: "thanks" as const })),
  ...FOLLOWED.map((text) => ({ text, kind: "followed" as const })),
  ...MISSING_LINK.map((text) => ({ text, kind: "missing_link" as const })),
  ...FILLER.map((text) => ({ text, kind: "ack" as const })),
]
  .map((t) => ({ ...t, text: normalize(t.text) }))
  // Longest first, so "沒有問題" is consumed whole instead of as "沒有" + junk.
  .sort((a, b) => b.text.length - a.text.length);

const BARE_NEGATIONS = new Set(
  [...NO_PROBLEM, ...EASY_OR_LATER]
    .map(normalize)
    .filter((text) => ENDS_IN_BARE_NO.test(text) || text === "no")
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
  // An emoji on its own ("👍", "🙏🙏") is an acknowledgement. Punctuation on its
  // own ("...") says something is off, and is left for a person.
  if (!cleaned) return /\p{Extended_Pictographic}/u.test(text ?? "") ? "ack" : null;
  if (cleaned.length > MAX_LENGTH) return null;

  const greeted = cleaned.replace(GREETING, "");
  const kinds =
    consume(cleaned.replace(PARTICLES, ""), []) ??
    consume(cleaned, []) ??
    (greeted !== cleaned
      ? consume(greeted.replace(PARTICLES, ""), []) ?? consume(greeted, [])
      : null);
  if (!kinds || kinds.length === 0) return null;

  // "已追蹤，但沒收到" is someone still waiting for their link: nothing else in
  // the message matters as much.
  if (kinds.includes("missing_link")) return "missing_link";
  // "謝謝，但看不懂" is someone who needs help: that comes before any courtesy.
  if (kinds.includes("stuck")) return "stuck";
  // "已追蹤，謝謝" is someone waiting for their link.
  if (kinds.includes("followed")) return "followed";
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

// ─── The other side's own auto-reply ──────────────────────────────────────────
//
// Shops and studios that get one of our DMs often answer with an away message
// or a bot menu: "謝謝你傳送訊息給我們。我們將盡快與你聯絡。" Nobody wrote it, so
// nobody needs to read it. These patterns come from messages this account
// really received.
//
// A person can mention auto-replies too ("你那個自動回覆超讚"), so a pattern must
// be something only an automated message says, and anything that asks a
// question is left for the model: a real question must never be dropped here.

const ASKS = /[?？]|嗎|吗|請問|请问/u;

const AUTO_REPLY = [
  // Says outright that it is automatic.
  /(?:此乃|此為|此为|這是|这是|這則是|本訊息為|本訊息是|本消息为|以下為|系統發出的|系统发出的|系統|系统)[^。！!\n]{0,8}自動(?:訊息|消息|回覆|回復|回复|發送|发送)/u,
  /(?:不會作出|不会作出|不會有|不会有|不是|非)真人(?:在)?回(?:覆|復|复)/u,
  /(?:現在|目前|现在)不是真人/u,
  /\bauto(?:matic|mated)?[- ]?(?:reply|response|message)\b/i,
  /\bthis is an automated\b/i,
  // Away messages: "we" will get back to "you".
  /我們(?:將|會|将|会)?(?:盡快|儘快|尽快|稍後|稍后)(?:與你|與您|跟你|跟您|和你|和您|与你|与您)?(?:聯絡|聯繫|回覆|回復|联络|联系|回复)/u,
  /我們(?:將|會|将|会)?在[^。！!\n]{0,12}內(?:聯絡|聯繫|回覆|回復)/u,
  /(?:謝謝|感謝|谢谢|感谢)(?:你|您)(?:傳送訊息|傳訊息|发送消息|的來訊|的來信|送來的訊息|發來的訊息|傳來的訊息)/u,
  /(?:謝謝|感謝)(?:你|您)的(?:訊息|message)[^。！!\n]{0,6}(?:我們|此乃|此為|本)/iu,
  /無法(?:迅速|即時|立即|馬上)回(?:覆|復)/u,
  /\bthank(?:s| you) for (?:your message|contacting|reaching out|getting in touch)\b/i,
  /\bwe(?:'ll| will) get back to you\b/i,
  // Shop fronts: opening hours, official LINE, bot menus.
  /(?:營業|服務|上班|客服|营业|服务)時間/u,
  /(?:請|请)(?:加|加入|洽)(?:入)?(?:我們的|我们的)?官方\s*line/iu,
  /官方\s*line\s*(?:詢問|洽詢|預約|询问)/iu,
  /(?:請輸入|请输入)[「『"][^」』"\n]{1,12}[」』"]/u,
  /點選[「『"][^」』"\n]{1,14}[」』"]按鈕/u,
  /^[^。！!\n]{0,14}歡迎來到[^。！!\n]{1,24}/u,
];

/** True when the message is another account's away message or bot menu. */
export function looksLikeAutoReply(text: string): boolean {
  const message = (text ?? "").normalize("NFKC");
  if (message.trim().length < 8) return false;
  if (ASKS.test(message)) return false;
  return AUTO_REPLY.some((pattern) => pattern.test(message));
}
