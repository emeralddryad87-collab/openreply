import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockMode, mockOwnerActive, mockHandedOff, fakeRedis } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    mockOwnerActive: vi.fn(),
    mockHandedOff: vi.fn(),
    mockPrisma: {
      instagramAccount: { findUnique: vi.fn() },
      triagePage: { findMany: vi.fn() },
      automation: { findMany: vi.fn() },
      dmLog: { findFirst: vi.fn() },
    },
    mockMode: vi.fn(),
    fakeRedis: {
      store,
      async set(key: string, value: string, ...args: (string | number)[]) {
        if (args.includes("NX") && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
    },
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => fakeRedis }));
vi.mock("@/lib/triage/settings", () => ({ getTriageModeFor: mockMode }));
vi.mock("@/lib/triage/state", () => ({
  ownerRepliedRecently: mockOwnerActive,
  handedOffRecently: mockHandedOff,
}));

import { findKeywordCampaign, keywordAsk } from "@/lib/triage/keyword-dm";

const KEYWORDS = ["PDF", "外掛", "剪片", "AI", "工具", "教學", "音效", "Open"];

describe("keywordAsk", () => {
  it.each([
    ["PDF", "PDF"],
    ["pdf", "PDF"],
    ["PDF！", "PDF"],
    ["PDF 謝謝", "PDF"],
    ["外掛", "外掛"],
    ["請問外掛呢？", "外掛"],
    ["外掛呢", "外掛"],
    ["我要外掛", "外掛"],
    ["可以給我外掛嗎", "外掛"],
    ["外掛連結", "外掛"],
    ["請問外掛的連結在哪", "外掛"],
    ["留言 剪片", "剪片"],
    ["想要音效 謝謝你", "音效"],
    ["AI", "AI"],
    ["open", "Open"],
  ])("reads %s as asking for %s", (text, keyword) => {
    expect(keywordAsk(text, KEYWORDS)).toBe(keyword);
  });

  // A keyword inside a longer message is a question or a complaint, not a request.
  it.each([
    "PDF 要怎麼轉",
    "外掛打不開",
    "目前的問題是..外掛打不開",
    "這個沒辦法點不開看內容",
    "外掛沒收到",
    "外掛連結打不開",
    "這個 AI 要付費嗎",
    "Ai agent",
    "工具很好用",
    "我想找你合作",
    "外掛要怎麼裝",
    "請問",
    "連結呢",
    "",
    "   ",
  ])("leaves %s alone", (text) => {
    expect(keywordAsk(text, KEYWORDS)).toBeNull();
  });

  it("prefers the longer keyword when one contains another", () => {
    expect(keywordAsk("Claude Code", ["Code", "Claude Code"])).toBe("Claude Code");
  });

  it("treats a keyword as plain text, never as a pattern", () => {
    expect(keywordAsk("aaaa", ["a+"])).toBeNull();
    expect(keywordAsk("abc", ["a.c"])).toBeNull();
    expect(keywordAsk("c++", ["C++"])).toBe("C++");
  });
});

describe("findKeywordCampaign", () => {
  const ask = (messageText: string, senderId = "user_1") =>
    findKeywordCampaign({ instagramAccountId: "ig_1", senderId, messageText });

  beforeEach(() => {
    vi.clearAllMocks();
    fakeRedis.store.clear();
    mockMode.mockResolvedValue("full");
    mockOwnerActive.mockResolvedValue(false);
    mockHandedOff.mockResolvedValue(false);
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({ id: "acct_row" });
    mockPrisma.triagePage.findMany.mockResolvedValue([
      { url: "https://claude.ai/artifact/pdf", keywords: ["PDF"] },
      { url: "https://claude.ai/artifact/cut-old", keywords: ["剪片"] },
      { url: "https://claude.ai/artifact/cut-new", keywords: ["剪片"] },
      { url: null, keywords: ["顧問"] },
    ]);
    mockPrisma.automation.findMany.mockResolvedValue([{ id: "newest" }, { id: "older" }]);
    mockPrisma.dmLog.findFirst.mockResolvedValue(null);
  });

  it("finds the campaign that sends the keyword's page", async () => {
    expect(await ask("PDF")).toEqual({ automationId: "newest", keyword: "PDF" });
    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          instagramAccountId: "acct_row",
          trackedLinks: { some: { destinationUrl: { in: ["https://claude.ai/artifact/pdf"] } } },
        },
      })
    );
  });

  it("looks across every page that shares the keyword", async () => {
    await ask("剪片");
    expect(
      mockPrisma.automation.findMany.mock.calls[0][0].where.trackedLinks.some.destinationUrl.in
    ).toEqual(["https://claude.ai/artifact/cut-old", "https://claude.ai/artifact/cut-new"]);
  });

  it("prefers the campaign this person already took part in over the newest one", async () => {
    mockPrisma.dmLog.findFirst.mockResolvedValue({ automationId: "older" });
    expect(await ask("剪片")).toEqual({ automationId: "older", keyword: "剪片" });
  });

  it("answers the same keyword once a day; a second ask is left for the owner", async () => {
    expect(await ask("PDF")).not.toBeNull();
    expect(await ask("PDF")).toBeNull();
    expect(await ask("PDF", "user_2")).not.toBeNull();
  });

  it.each(["off", "dry_run"])("does nothing while the switch is %s", async (mode) => {
    mockMode.mockResolvedValue(mode);
    expect(await ask("PDF")).toBeNull();
    expect(mockPrisma.triagePage.findMany).not.toHaveBeenCalled();
  });

  it("stays out of a conversation the owner is having by hand", async () => {
    mockOwnerActive.mockResolvedValue(true);
    expect(await ask("PDF")).toBeNull();
    expect(mockOwnerActive).toHaveBeenCalledWith("ig_1", "user_1");
    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
  });

  it("stays out once the person has asked for the owner", async () => {
    mockHandedOff.mockResolvedValue(true);
    expect(await ask("PDF")).toBeNull();
  });

  it("works in fixed-replies-only mode too", async () => {
    mockMode.mockResolvedValue("canned");
    expect(await ask("PDF")).not.toBeNull();
  });

  it("does nothing for a message that is not a keyword ask", async () => {
    expect(await ask("PDF 要怎麼轉")).toBeNull();
    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
  });

  it("does nothing for a keyword whose page has no link on file", async () => {
    expect(await ask("顧問")).toBeNull();
    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
  });

  it("does nothing when no active campaign sends that page", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    expect(await ask("PDF")).toBeNull();
    expect(fakeRedis.store.size).toBe(0);
  });

  it("skips long messages without touching the database", async () => {
    expect(await ask("字".repeat(60))).toBeNull();
    expect(mockMode).not.toHaveBeenCalled();
  });

  it("returns nothing, and throws nothing, when a lookup fails", async () => {
    mockPrisma.triagePage.findMany.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(ask("PDF")).resolves.toBeNull();
    spy.mockRestore();
  });
});
