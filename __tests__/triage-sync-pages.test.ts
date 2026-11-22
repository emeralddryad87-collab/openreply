import { describe, it, expect } from "vitest";
import { htmlToText, pageTitle, parsePack } from "../scripts/triage-sync-pages";

describe("triage page sync parsers", () => {
  it("turns a page into readable text and drops scripts and styles", () => {
    const html =
      "<html><head><title>T</title><style>p{}</style></head><body><h1>安裝 &amp; 設定</h1><ol><li>第一步</li><li>第二步</li></ol><script>x()</script></body></html>";
    expect(htmlToText(html)).toBe("T\n安裝 & 設定\n- 第一步\n- 第二步");
  });

  it("prefers the h1 as the title", () => {
    expect(pageTitle("<title>短</title><h1>清掉 <b>Claude</b> 浮水印</h1>", "x")).toBe(
      "清掉 Claude 浮水印"
    );
    expect(pageTitle("<p>no heading</p>", "fallback")).toBe("fallback");
  });

  it("reads the keyword and URL out of a write-up", () => {
    const pack =
      "**留言關鍵字**：**浮水印**\n\n### ② 私訊連結\n\nhttps://claude.ai/artifact/QSQRfCgrh591rR3HDQmxAq\n\n留言「浮水印」，我私訊給你";
    expect(parsePack(pack)).toEqual({
      keywords: ["浮水印"],
      url: "https://claude.ai/artifact/QSQRfCgrh591rR3HDQmxAq",
    });
  });

  it("rejects sentences that only look like a keyword", () => {
    expect(parsePack("留言關鍵字，就自動私訊連結給他。").keywords).toEqual([]);
  });

  it("reads a link to a page published from Claude Code, which has its own shape", () => {
    expect(
      parsePack("私訊頁 https://claude.ai/code/artifact/948507a0-0b84-4b91-aae0-f336f03e1211（私人）").url
    ).toBe("https://claude.ai/code/artifact/948507a0-0b84-4b91-aae0-f336f03e1211");
    expect(parsePack("頁面 https://claude.ai/artifact/KddvL4fXCmhoxhPHvhZZjG 。").url).toBe(
      "https://claude.ai/artifact/KddvL4fXCmhoxhPHvhZZjG"
    );
  });

  it("returns nothing for a write-up without either", () => {
    expect(parsePack("# 筆記")).toEqual({ keywords: [], url: null });
  });
});
