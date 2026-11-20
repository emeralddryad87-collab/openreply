import { describe, it, expect } from "vitest";
import { classifyCanned } from "@/lib/triage/classify";

describe("classifyCanned", () => {
  it.each([
    "沒有問題", "沒問題", "没有问题", "沒有", "沒問題喔", "目前沒有～", "沒有問題了！",
    "沒有問題，謝謝", "好的沒問題", "OK 沒問題 👍", "no problem", "Nope",
  ])("treats %s as no_problem", (text) => {
    expect(classifyCanned(text)).toBe("no_problem");
  });

  it.each([
    "謝謝", "謝謝你！", "感謝分享🙏", "谢谢", "thanks", "Thank you!!", "thx", "tq", "好的謝謝", "收到，感謝",
    "謝謝啦～",
  ])("treats %s as thanks", (text) => {
    expect(classifyCanned(text)).toBe("thanks");
  });

  it.each(["好的", "ok", "收到", "👍", "🙏🙏", "嗯嗯", "了解"])(
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
