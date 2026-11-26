import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockAskClaude } = vi.hoisted(() => ({
  mockPrisma: {
    triagePage: { findMany: vi.fn() },
    automation: { findMany: vi.fn() },
  },
  mockAskClaude: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/triage/claude", () => ({ askClaude: mockAskClaude }));

import {
  DRAFT_SCHEMA,
  buildDraftMessages,
  draftReply,
  draftWithOffer,
  parseDrafted,
  type DraftInput,
} from "@/lib/triage/draft";
import {
  listTutorials,
  loadTutorials,
  resetTutorialCache,
  sayableTitle,
} from "@/lib/triage/tutorials";

const page = (key: string, title: string, url: string | null, content = `${key} 的內容`) => ({
  key,
  title,
  url,
  content,
});
const campaign = (...urls: string[]) => ({
  trackedLinks: urls.map((destinationUrl) => ({ destinationUrl })),
});

describe("sayableTitle", () => {
  it("drops the owner's filing code from the front", () => {
    expect(sayableTitle("K27：用 CLAUDE.md 省 Claude 額度")).toBe("用 CLAUDE.md 省 Claude 額度");
    expect(sayableTitle("K26b 剪輯效果庫")).toBe("剪輯效果庫");
    expect(sayableTitle("C03: 10 個免費 AI 工具")).toBe("10 個免費 AI 工具");
  });

  it("leaves a title that only looks like one alone", () => {
    expect(sayableTitle("Claude 6 個隱藏功能")).toBe("Claude 6 個隱藏功能");
    expect(sayableTitle("3 Sound Plugins for Editing Videos with Claude")).toBe(
      "3 Sound Plugins for Editing Videos with Claude"
    );
    expect(sayableTitle("LTX 2.5：在自己電腦跑的 AI 影片模型")).toBe(
      "LTX 2.5：在自己電腦跑的 AI 影片模型"
    );
  });

  it("never returns nothing", () => {
    expect(sayableTitle("K27")).toBe("K27");
  });
});

describe("listTutorials", () => {
  it("lists the pages a running campaign delivers, newest campaign first", () => {
    const list = listTutorials(
      [
        page("K26", "讓 Claude 幫你剪影片：我的做法", "https://x/k26"),
        page("K41", "用 Claude 剪片，只要四步", "https://x/k41"),
        page("K03", "別再燒 Claude 額度", "https://x/k03"),
      ],
      [campaign("https://x/k41"), campaign("https://x/k26")]
    );
    expect(list).toEqual([
      { key: "K41", title: "用 Claude 剪片，只要四步" },
      { key: "K26", title: "讓 Claude 幫你剪影片：我的做法" },
    ]);
  });

  it("leaves out a page nobody can be sent: no address, or no running campaign", () => {
    expect(
      listTutorials(
        [page("A", "有連結沒活動", "https://x/a"), page("B", "沒有連結", null)],
        [campaign("https://x/other")]
      )
    ).toEqual([]);
  });

  it("lists one tutorial once when it is filed under two keys", () => {
    const list = listTutorials(
      [
        page("link_4个外挂", "Claude Code 四個外掛", "https://x/new", "同一份內容"),
        page("C02_四個外掛", "Claude Code 四個外掛", "https://x/old", "同一份內容"),
      ],
      [campaign("https://x/new"), campaign("https://x/old")]
    );
    expect(list).toEqual([{ key: "link_4个外挂", title: "Claude Code 四個外掛" }]);
  });

  // A page whose title is another tutorial's by mistake: offering "that"
  // tutorial could send the wrong one, so neither is offered.
  it("leaves out both of two different pages that carry the same title", () => {
    const list = listTutorials(
      [
        page("Kiva", "用一張模型車照片，手機做出跑車廣告", "https://x/kiva", "模型車的做法"),
        page("Mailerfind", "用一張模型車照片，手機做出跑車廣告", "https://x/mailerfind", "找潛在客戶"),
        page("K26", "讓 Claude 幫你剪影片：我的做法", "https://x/k26"),
      ],
      [campaign("https://x/kiva"), campaign("https://x/mailerfind"), campaign("https://x/k26")]
    );
    expect(list).toEqual([{ key: "K26", title: "讓 Claude 幫你剪影片：我的做法" }]);
  });

  it("says titles without the filing code", () => {
    expect(
      listTutorials([page("K27", "K27：用 CLAUDE.md 省 Claude 額度", "https://x/k27")], [
        campaign("https://x/k27"),
      ])
    ).toEqual([{ key: "K27", title: "用 CLAUDE.md 省 Claude 額度" }]);
  });
});

describe("loadTutorials", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    resetTutorialCache();
    mockPrisma.triagePage.findMany.mockResolvedValue([page("K26", "剪片", "https://x/k26")]);
    mockPrisma.automation.findMany.mockResolvedValue([campaign("https://x/k26")]);
  });

  it("reads this account's pages and running campaigns", async () => {
    expect(await loadTutorials("acct_1")).toEqual([{ key: "K26", title: "剪片" }]);
    expect(mockPrisma.triagePage.findMany.mock.calls[0][0].where).toEqual({
      instagramAccountId: "acct_1",
      url: { not: null },
    });
    expect(mockPrisma.automation.findMany.mock.calls[0][0]).toMatchObject({
      where: { instagramAccountId: "acct_1", isActive: true },
      orderBy: { createdAt: "desc" },
    });
  });

  it("reads once, then remembers for a while", async () => {
    await loadTutorials("acct_1");
    await loadTutorials("acct_1");
    expect(mockPrisma.triagePage.findMany).toHaveBeenCalledTimes(1);
    await loadTutorials("acct_2");
    expect(mockPrisma.triagePage.findMany).toHaveBeenCalledTimes(2);
  });

  it("is an empty list, not an error, when it cannot be read", async () => {
    mockPrisma.triagePage.findMany.mockRejectedValue(new Error("db down"));
    expect(await loadTutorials("acct_1")).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // And it tries again next time instead of remembering the failure.
    mockPrisma.triagePage.findMany.mockResolvedValue([page("K26", "剪片", "https://x/k26")]);
    expect(await loadTutorials("acct_1")).toEqual([{ key: "K26", title: "剪片" }]);
  });
});

describe("a draft that can offer one of the owner's tutorials", () => {
  const TUTORIALS = [
    { key: "K41", title: "用 Claude 剪片，只要四步" },
    { key: "K27", title: "用 CLAUDE.md 省 Claude 額度" },
  ];
  const OFFER = "我有做過剪片的教學哦，要的話我把連結傳給你～";
  const input = (over: Partial<DraftInput> = {}): DraftInput => ({
    message: "可以教我影片剪輯嗎？",
    reason: "問教學的事：想學影片剪輯",
    pages: [],
    history: [],
    tutorials: TUTORIALS,
    ...over,
  });

  beforeEach(() => {
    mockAskClaude.mockReset();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("GROQ_API_KEY", "");
  });

  it("shows the writer the list, numbered", () => {
    const user = buildDraftMessages(input())[1].content;
    expect(user).toContain(
      "【他做過的教學】\n1. 用 Claude 剪片，只要四步\n2. 用 CLAUDE.md 省 Claude 額度"
    );
  });

  it("leaves the list out when there is none", () => {
    expect(buildDraftMessages(input({ tutorials: [] }))[1].content).not.toContain("他做過的教學");
    expect(buildDraftMessages(input({ tutorials: undefined }))[1].content).not.toContain(
      "他做過的教學"
    );
  });

  it("asks which tutorial the draft offers, as a number", () => {
    expect(DRAFT_SCHEMA.required).toEqual(["draft", "offers"]);
    expect(DRAFT_SCHEMA.properties.offers).toEqual({ type: "integer" });
  });

  describe("parseDrafted", () => {
    it("reads the draft and the tutorial it points at", () => {
      expect(parseDrafted(JSON.stringify({ draft: OFFER, offers: 1 }), TUTORIALS)).toEqual({
        draft: OFFER,
        offeredKey: "K41",
      });
    });

    it("reads no offer from 0, from a number off the list, or from anything that is not a number", () => {
      for (const offers of [0, 3, -1, 1.5, "1", null, undefined]) {
        expect(parseDrafted(JSON.stringify({ draft: OFFER, offers }), TUTORIALS)).toEqual({
          draft: OFFER,
          offeredKey: null,
        });
      }
    });

    // A "yes" to a draft that offered nothing must not send a tutorial.
    it("reads no offer when the draft does not actually offer to send a tutorial", () => {
      expect(
        parseDrafted(JSON.stringify({ draft: "你是想剪哪一種影片呢？", offers: 1 }), TUTORIALS)
      ).toEqual({ draft: "你是想剪哪一種影片呢？", offeredKey: null });
      expect(
        parseDrafted(JSON.stringify({ draft: "我有做過剪片的教學哦～", offers: 1 }), TUTORIALS)
      ).toEqual({ draft: "我有做過剪片的教學哦～", offeredKey: null });
    });

    it("is nothing when there is no draft", () => {
      expect(parseDrafted('{"draft":"","offers":1}', TUTORIALS)).toBeNull();
      expect(parseDrafted("不是 JSON", TUTORIALS)).toBeNull();
    });
  });

  it("returns the draft with the tutorial it offers", async () => {
    mockAskClaude.mockResolvedValue(JSON.stringify({ draft: OFFER, offers: 1 }));
    expect(await draftWithOffer(input())).toEqual({ draft: OFFER, offeredKey: "K41" });
    // The text alone, for whoever only wants that.
    expect(await draftReply(input())).toBe(OFFER);
  });

  it("offers nothing when it was given no list", async () => {
    mockAskClaude.mockResolvedValue(JSON.stringify({ draft: OFFER, offers: 1 }));
    expect(await draftWithOffer(input({ tutorials: [] }))).toEqual({
      draft: OFFER,
      offeredKey: null,
    });
  });

  it("still drops a draft that carries an address the owner did not publish", async () => {
    mockAskClaude.mockResolvedValue(
      JSON.stringify({ draft: "我有做過剪片的教學哦，連結在 evil.example.com", offers: 1 })
    );
    expect(await draftWithOffer(input())).toBeNull();
  });
});
