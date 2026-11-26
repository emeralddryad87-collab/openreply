import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMessages, linksComeFromPages } from "@/lib/triage/ai";
import { buildDraftMessages } from "@/lib/triage/draft";
import { AI_DISCLOSURE_REPLY, CANNED_REPLIES, HANDOFF_REPLY } from "@/lib/triage/config";
import {
  GUIDE_AS_PAGE,
  GUIDE_SECTIONS,
  REPLY_GUIDE,
  guideBlock,
  guideForModel,
  sectionOf,
} from "@/lib/triage/guide";
import { REPLY_GUIDE_SOURCE } from "@/lib/triage/reply-guide.generated";
import { buildLineMessages } from "@/lib/triage/wording";
import {
  GUIDE_MODULE_PATH,
  GUIDE_SOURCE_PATH,
  normalizeNewlines,
  renderGuideModule,
} from "@/scripts/build-reply-guide";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("the reply guide the worker reads", () => {
  it("is the Markdown file, word for word (run `npm run guide` after editing it)", () => {
    expect(normalizeNewlines(read(GUIDE_MODULE_PATH))).toBe(
      renderGuideModule(read(GUIDE_SOURCE_PATH))
    );
    expect(normalizeNewlines(REPLY_GUIDE_SOURCE)).toBe(
      normalizeNewlines(read(GUIDE_SOURCE_PATH))
    );
  });

  it("survives the characters a template string would trip over", () => {
    const tricky = "用 `npm run guide`\n價格 ${price}\n路徑 C:\\Users\r\n結尾";
    const moduleSource = renderGuideModule(tricky);
    const literal = moduleSource.slice(
      moduleSource.indexOf("`", moduleSource.indexOf("REPLY_GUIDE_SOURCE")),
      moduleSource.lastIndexOf("`") + 1
    );
    // The literal, evaluated, is the text that went in.
    expect(new Function(`return ${literal};`)()).toBe(normalizeNewlines(tricky));
  });
});

describe("what the model is given of it", () => {
  it("holds how the owner talks, his standing answers and what only he answers", () => {
    for (const heading of Object.values(GUIDE_SECTIONS)) {
      expect(REPLY_GUIDE).toContain(`## ${heading}`);
      expect(sectionOf(REPLY_GUIDE, heading)).not.toBe("");
    }
  });

  it("leaves out the notes kept for whoever maintains the guide", () => {
    expect(REPLY_GUIDE_SOURCE).toContain("## 附註");
    expect(REPLY_GUIDE).not.toContain("附註");
    expect(REPLY_GUIDE).not.toContain("npm run guide");
    expect(REPLY_GUIDE).not.toContain("claude.com/pricing");
  });

  it("reads the same whatever was done to the line endings", () => {
    expect(guideForModel("\uFEFF# 指南\r\n\r\n內容\r\n\r\n## 附註\r\n不給模型")).toBe(
      "# 指南\n\n內容"
    );
    expect(guideForModel("# 指南\n內容")).toBe("# 指南\n內容");
  });

  // It is sent with every request, so every thousand characters is paid for
  // on every message. Past this, something should move out before more goes in.
  it("stays short enough to send with every message", () => {
    expect(REPLY_GUIDE.length).toBeLessThanOrEqual(4000);
    // And no request is sent the whole of it.
    expect(guideBlock(["tone", "answers", "ownerOnly"]).length).toBeLessThan(REPLY_GUIDE.length);
    expect(guideBlock(["tone", "situations"]).length).toBeLessThan(REPLY_GUIDE.length);
  });

  it("is written for a reader who is told who 'I' is", () => {
    const block = guideBlock(["tone"]);
    expect(block).toContain("【回覆指南】");
    expect(block).toContain("文中的「我」就是他");
    expect(block.endsWith(sectionOf(REPLY_GUIDE, GUIDE_SECTIONS.tone))).toBe(true);
  });

  it("cuts a section at the next heading, and is empty for a heading that is not there", () => {
    const guide = "# 指南\n\n## 甲\n一\n二\n\n## 乙\n三";
    expect(sectionOf(guide, "甲")).toBe("## 甲\n一\n二");
    expect(sectionOf(guide, "乙")).toBe("## 乙\n三");
    expect(sectionOf(guide, "丙")).toBe("");
  });

  it("closes all three sets of rules, each with the sections it needs", () => {
    const sorting = buildMessages("q", [{ title: "t", content: "c" }])[0].content;
    const drafting = buildDraftMessages({
      message: "q",
      reason: null,
      pages: [],
      history: [],
    })[0].content;
    const wording = buildLineMessages({ kind: "thanks", message: "謝謝", history: [] })[0]
      .content;

    const knowledge = guideBlock(["tone", "answers", "ownerOnly"]);
    expect(sorting.endsWith(knowledge)).toBe(true);
    expect(drafting.endsWith(knowledge)).toBe(true);
    expect(wording.endsWith(guideBlock(["tone", "situations"]))).toBe(true);

    // The one that sorts has no use for how a fixed line is worded, and the
    // one that words a fixed line must not start answering questions.
    expect(sorting).not.toContain("## 固定的幾種情況");
    expect(wording).not.toContain("## 常見問題");
  });

  // The model learns each fixed line from the guide; the code sends its own
  // copy when the model's line will not do. They must be the same sentence.
  it("quotes, word for word, every sentence the code falls back on", () => {
    const situations = sectionOf(REPLY_GUIDE, GUIDE_SECTIONS.situations);
    const sentences = [...Object.values(CANNED_REPLIES), AI_DISCLOSURE_REPLY, HANDOFF_REPLY];
    expect(sentences.length).toBeGreaterThanOrEqual(9);
    for (const sentence of sentences) expect(situations).toContain(`「${sentence}」`);
  });

  it("says in the owner's words what he decided on 2026-11-26", () => {
    const tone = sectionOf(REPLY_GUIDE, GUIDE_SECTIONS.tone);
    expect(tone).toContain("對方寫英文，就用英文回");
    expect(sectionOf(REPLY_GUIDE, GUIDE_SECTIONS.ownerOnly)).toContain("問教學的事");
    expect(sectionOf(REPLY_GUIDE, GUIDE_SECTIONS.situations)).toContain("對方說沒收到留言的連結");
  });
});

describe("the links it lets a reply carry", () => {
  it("allows an address the owner wrote into the guide", () => {
    expect(
      linksComeFromPages("照官方這頁裝就可以了哦～ code.claude.com/docs/en/setup", [GUIDE_AS_PAGE])
    ).toBe(true);
  });

  it("does not allow an address that is only in the maintainers' notes", () => {
    expect(REPLY_GUIDE_SOURCE).toContain("claude.com/pricing");
    expect(linksComeFromPages("價格看這裡 claude.com/pricing", [GUIDE_AS_PAGE])).toBe(false);
  });

  it("does not allow an address that is nowhere in it", () => {
    expect(linksComeFromPages("看這頁 code.claude.com/docs/en/pricing", [GUIDE_AS_PAGE])).toBe(
      false
    );
  });
});
