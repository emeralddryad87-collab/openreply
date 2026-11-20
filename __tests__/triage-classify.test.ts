import { describe, it, expect } from "vitest";
import {
  answersNo,
  answersYes,
  asksForHuman,
  asksIfAutomated,
  classifyCanned,
} from "@/lib/triage/classify";

describe("classifyCanned", () => {
  it.each([
    "沒有問題", "沒問題", "没有问题", "沒有", "沒問題喔", "目前沒有～", "沒有問題了！",
    "沒有問題，謝謝", "好的沒問題", "OK 沒問題 👍", "no problem", "Nope",
    "目前沒有什麼問題喔 都清楚謝謝你", "沒什麼問題", "沒有任何問題，謝謝", "都清楚了，沒有問題",
    "目前沒有什麼問題", "暫時沒有，謝謝", "沒有，謝謝你", "沒啦謝謝", "没有什么问题，都清楚了",
    "no thanks",
    // "I understood" is a sign-off too.
    "都很清楚", "都理解", "了解", "瞭解了", "清楚", "都懂了", "明白了", "都清楚了喔", "知道了",
    "好的，了解", "收到 了解 謝謝", "got it", "Understood!",
  ])("treats %s as no_problem", (text) => {
    expect(classifyCanned(text)).toBe("no_problem");
  });

  it.each([
    "謝謝", "謝謝你！", "感謝分享🙏", "谢谢", "thanks", "Thank you!!", "thx", "tq", "好的謝謝", "收到，感謝",
    "謝謝啦～", "好的謝謝你", "ok thanks", "嗯嗯 感恩",
  ])("treats %s as thanks", (text) => {
    expect(classifyCanned(text)).toBe("thanks");
  });

  it.each([
    "已追蹤", "已追蹤✅", "追蹤了喔", "我已經追蹤了", "已追踪", "已關注", "已关注了", "有追蹤",
    "已追蹤 謝謝", "好的已追蹤", "已追蹤你了～", "followed", "I followed you!", "已 follow",
  ])("treats %s as followed", (text) => {
    expect(classifyCanned(text)).toBe("followed");
  });

  it.each([
    "還沒追蹤", "沒有追蹤", "追蹤了但沒收到", "已追蹤可是沒有連結", "怎麼追蹤", "要追蹤嗎", "追蹤",
    "已追蹤？", "追蹤了還是不行",
  ])("leaves %s for a human or the model", (text) => {
    expect(classifyCanned(text)).toBeNull();
  });

  it.each(["好的", "ok", "收到", "👍", "🙏🙏", "嗯嗯", "好喔", "可以", "讚"])(
    "treats %s as a bare acknowledgement",
    (text) => {
      expect(classifyCanned(text)).toBe("ack");
    }
  );

  it.each([
    "沒問題，但我想問一下音效要怎麼裝",
    "謝謝，請問這個要付費嗎",
    "這個音效要怎麼裝",
    "我裝不起來",
    "有問題",
    "沒有收到連結",
    "沒有聲音",
    "可以合作嗎",
    "ok 那我想問",
    "謝謝你，另外想請教報價",
    "連結打不開",
  ])("leaves %s for a human or the page answer", (text) => {
    expect(classifyCanned(text)).toBeNull();
  });

  it.each(["?", "？？", "可以？", "沒有?", "好的？", "謝謝？", "ok?", "👍?"])(
    "leaves %s for a human, because a question mark makes it a question",
    (text) => {
      expect(classifyCanned(text)).toBeNull();
    }
  );

  // A "no" in front of another word negates that word. These are complaints
  // and confusion, the messages that must never get the cheerful fixed line.
  it.each([
    "沒收到", "沒有收到", "沒有很清楚", "沒懂", "沒有懂", "沒有明白", "沒了解", "沒有可以",
    "目前沒有收到", "目前沒有很清楚", "没收到", "没有很清楚", "沒看懂", "不清楚", "不太懂",
    "還是不清楚", "no ok", "不了解", "沒有了解", "不理解", "沒有很理解", "不是很清楚", "有點不懂",
  ])("leaves %s for a human, because the no negates what follows", (text) => {
    expect(classifyCanned(text)).toBeNull();
  });

  it("ignores empty input", () => {
    expect(classifyCanned("")).toBeNull();
    expect(classifyCanned("   ")).toBeNull();
  });

  it("does not match long messages even when they start politely", () => {
    expect(
      classifyCanned("謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝謝")
    ).toBeNull();
  });
});

describe("asksIfAutomated", () => {
  it.each([
    "你是AI嗎", "你是 AI 嗎？", "是機器人嗎", "是机器人吗", "這是自動回覆嗎", "請問這是自動回覆嗎？",
    "是不是AI在回", "現在是AI在回嗎", "是AI回的嗎", "AI回覆嗎", "機器人回的吧", "AI?", "是bot嗎",
    "是真人嗎", "你是本人嗎", "是你本人回的嗎", "有真人嗎", "真人嗎", "本人？", "是本人在回嗎",
    "你是ChatGPT嗎",
  ])("recognises %s", (text) => {
    expect(asksIfAutomated(text)).toBe(true);
  });

  // The audience talks about AI tools all day; none of this is about the replies.
  it.each([
    "AI", "這個AI要付費嗎", "是AI工具嗎", "AI回答很慢怎麼辦", "這個是AI做的嗎", "你影片的聲音是AI嗎還是本人配的",
    "機器人", "自動回覆", "想學AI", "本人", "真人", "你本人好帥", "是", "可以用AI剪片嗎",
    "請問這個 AI 外掛是不是要先裝 Claude Code 才能用",
  ])("does not mistake %s for it", (text) => {
    expect(asksIfAutomated(text)).toBe(false);
  });
});

describe("asksForHuman", () => {
  it.each([
    "我要找本人", "想找你本人", "可以轉真人嗎", "請本人回覆我", "幫我轉人工", "要真人", "有真人客服嗎",
    "可以請本人回嗎", "我想找真人聊",
  ])("recognises %s", (text) => {
    expect(asksForHuman(text)).toBe(true);
  });

  it.each([
    "不用找本人", "不需要真人", "你本人好帥", "本人", "是本人嗎", "真人版的教學在哪", "謝謝",
    "這個音效要怎麼裝", "",
  ])("does not mistake %s for it", (text) => {
    expect(asksForHuman(text)).toBe(false);
  });
});

describe("answers to 'do you want the owner?'", () => {
  it.each(["要", "要的", "好", "好的", "好啊～", "是的", "對", "嗯嗯", "可以", "麻煩了", "需要", "找本人",
    "我要找本人", "yes", "OK", "好的謝謝", "要 謝謝你", "sure 👍"])("reads %s as yes", (text) => {
    expect(answersYes(text)).toBe(true);
    expect(answersNo(text)).toBe(false);
  });

  it.each(["不用", "不用了", "不需要", "沒關係", "不用了謝謝", "先不用", "no", "不用麻煩～", "算了"])(
    "reads %s as no",
    (text) => {
      expect(answersNo(text)).toBe(true);
      expect(answersYes(text)).toBe(false);
    }
  );

  it.each(["要怎麼裝", "好像不行", "要嗎？", "不用付費嗎", "那這個音效要怎麼裝", "", "謝謝"])(
    "reads %s as neither",
    (text) => {
      expect(answersYes(text)).toBe(false);
      expect(answersNo(text)).toBe(false);
    }
  );
});
