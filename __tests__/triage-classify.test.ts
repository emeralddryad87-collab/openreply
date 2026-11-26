import { describe, it, expect } from "vitest";
import {
  answersNo,
  answersYes,
  asksForHuman,
  asksIfAutomated,
  classifyCanned,
  looksLikeAutoReply,
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
    "有的", "有", "有喔", "有的 謝謝", "有試過了", "試過了", "有看懂", "有收到",
    // Answers to "was it hard?" that mean no: not hard, or not tried yet.
    "不會", "不會啊", "還好", "還行", "不難", "沒有很難", "還可以 謝謝",
    "等下才试试", "等下才試試", "晚點再試", "還沒試", "還沒", "我試試看", "還在研究中", "not yet",
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

  // A "no" in front of another word negates that word. These are complaints,
  // the messages that must never get the cheerful sign-off line.
  it.each([
    "沒有可以", "no ok", "沒有聲音", "沒辦法下載", "沒有很順", "還沒有回我",
  ])("leaves %s for a human, because the no negates what follows", (text) => {
    expect(classifyCanned(text)).toBeNull();
  });

  // "The link never came." Its answer is the link again, or the follow
  // button, which the caller decides; here it only has to be recognised,
  // and never mistaken for the bare "no" it starts with.
  it.each([
    "沒收到", "沒有收到", "目前沒有收到", "没收到", "還沒收到", "還沒有收到連結", "沒有連結",
    "沒有收到連結", "沒有按鈕", "找不到連結", "看不到按鈕", "沒收到😭", "沒收到 謝謝", "已追蹤 沒收到",
    "没有链接", "I didn't get the link", "還是沒收到", "还是没收到",
  ])("treats %s as the link never having come", (text) => {
    expect(classifyCanned(text)).toBe("missing_link");
  });

  it("leaves a question about the link to the model", () => {
    expect(classifyCanned("沒收到？")).toBeNull();
    expect(classifyCanned("連結在哪裡？")).toBeNull();
  });

  // "I do not get it", with no word about which part.
  it.each([
    "不知道如何使用", "不知道怎麼用", "看不懂", "不太懂", "覺得難", "好複雜", "天哪，好複雜", "有點難",
    "不會用", "卡住了", "不清楚", "還是不清楚", "不了解", "不理解", "不是很清楚", "有點不懂",
    "沒看懂", "沒懂", "沒有懂", "沒有明白", "沒了解", "沒有了解", "沒有很理解", "沒有很清楚",
    "没有很清楚", "目前沒有很清楚", "太難了😭", "看不懂 謝謝", "好的 看不太懂", "還是看不懂", "I don't understand",
  ])("treats %s as stuck", (text) => {
    expect(classifyCanned(text)).toBe("stuck");
  });

  it.each([
    "...", "。。。", "有點", "不會的話怎麼辦", "不會用的話可以問你嗎", "難在哪", "好的 但看不太懂",
    "有問題", "有一個問題", "有的話再問你", "有空嗎",
  ])(
    "leaves %s for the model or a human",
    (text) => {
      expect(classifyCanned(text)).toBeNull();
    }
  );

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

describe("looksLikeAutoReply", () => {
  // Every one of these arrived for real, from a shop or a studio that had been
  // sent a campaign DM.
  it.each([
    "謝謝你傳送訊息給我們。我們將盡快與你聯絡。",
    "你好，感謝你的訊息，我們將盡快回覆。",
    "您好😊 ❣️第一次購買請輸入「結帳」兩個字 並點選「來去逛逛」按鈕完成認證。 這邊沒有處理購物車問題唷~",
    "Hello 你好，謝謝你的Message ***此乃系統發出的自動訊息，此Inbox不會作出真人回覆及不回覆拍攝價錢詢問***",
    "👋 嗨你好！歡迎來到某某影像 如果你有拍攝需求，可以先填這份表單， 我們會在 1～2 天內聯繫你",
    "您好，謝謝您傳訊息給我們 個人工作室人力有限，無法迅速回覆請見諒",
    "嗨! 如果要預約或是任何問題請加我們的官方line詢問喔！ Hi ! If any inquiry or reservation please add our whatsapp",
    "親愛的家長您好，感謝您的來訊！ 若想洽詢課程，請您於營業時間直接前往",
    "感謝你送來的訊息，現在不是真人回復",
    "Thank you for contacting us. We will get back to you as soon as possible.",
    "This is an automated message, please do not reply.",
  ])("recognises %s", (text) => {
    expect(looksLikeAutoReply(text)).toBe(true);
  });

  // A person can talk about auto-replies, say "we", or thank you. None of that
  // makes their message automatic.
  it.each([
    "你那個自動回覆超讚",
    "我發現你開發多那個自動回覆超讚 我可以這樣拿來回覆不好搞定的家長🤣🤣",
    "那這樣以後我受到的訊息就會是自動化回覆了嗎 我要來判斷一下",
    "這樣就讓人感受不出來我們在跟誰聊天",
    "新手做自動化 這種你有在出教學嗎",
    "了解，我在思考我們公司需不需要，那通常都大概怎麼收費呢～？",
    "希望有人教會我們",
    "我明天遊說我們老闆",
    "我好像裝完了 我請claude一步步帶我排除問題，目前應該是可以了 我再試試看，感謝您",
    "謝謝你的分享",
    "謝謝",
    "想找你合作",
    "這個音效要怎麼裝",
    "",
  ])("does not mistake %s for one", (text) => {
    expect(looksLikeAutoReply(text)).toBe(false);
  });

  // Anything that asks something is left for the model, even if it reads like
  // an away message: a real question must never be dropped by a pattern.
  it.each([
    "這是自動回覆嗎",
    "這是系統自動回覆嗎？還是你本人",
    "謝謝你傳訊息給我們，請問你們的營業時間是幾點",
    "你們的營業時間？",
  ])("leaves %s to the model, because it asks something", (text) => {
    expect(looksLikeAutoReply(text)).toBe(false);
  });
});

describe("a greeting in front of a fixed phrase", () => {
  it.each([
    ["您好! 我已追蹤", "followed"],
    ["你好，已經追蹤了", "followed"],
    ["hi 已追蹤", "followed"],
    ["哈囉 謝謝", "thanks"],
    ["您好 沒收到連結", "missing_link"],
  ])("reads %s as %s", (text, kind) => {
    expect(classifyCanned(text)).toBe(kind);
  });

  it("is not a kind by itself", () => {
    expect(classifyCanned("你好")).toBeNull();
    expect(classifyCanned("您好!")).toBeNull();
    expect(classifyCanned("hi")).toBeNull();
  });

  it("does not turn a real message into a fixed one", () => {
    expect(classifyCanned("你好，我想問一下怎麼安裝")).toBeNull();
    expect(classifyCanned("您好 我已追蹤 但是打不開")).toBeNull();
  });
});
