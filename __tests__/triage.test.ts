import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPrisma,
  mockSendDirectMessage,
  mockState,
  mockNotifyOwner,
  mockAnswerFromPages,
  mockIsAiConfigured,
} = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findUnique: vi.fn() },
    triageLog: { create: vi.fn(), update: vi.fn(), count: vi.fn() },
    dmLog: { findMany: vi.fn() },
    triagePage: { findMany: vi.fn() },
  },
  mockSendDirectMessage: vi.fn(),
  mockState: {
    ownerRepliedRecently: vi.fn(),
    handedOffRecently: vi.fn(),
    wasAskedHuman: vi.fn(),
    claimNotifySlot: vi.fn(),
    markBotActivity: vi.fn(),
    markAskedHuman: vi.fn(),
    clearAskedHuman: vi.fn(),
    markHandoff: vi.fn(),
  },
  mockNotifyOwner: vi.fn(),
  mockAnswerFromPages: vi.fn(),
  mockIsAiConfigured: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({ sendDirectMessage: mockSendDirectMessage }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (t: string) => `plain:${t}` }));
vi.mock("@/lib/triage/state", () => mockState);
vi.mock("@/lib/triage/notify", () => ({ notifyOwner: mockNotifyOwner }));
vi.mock("@/lib/triage/ai", () => ({
  answerFromPages: mockAnswerFromPages,
  isAiConfigured: mockIsAiConfigured,
}));

import { runTriage } from "@/lib/triage";

const SIGN_OFF = "好的哦，如果有任何問題都歡迎來問我~";
const THANKS = "不用客氣~";
const DISCLOSURE = "是的，這是 AI 自動回覆哦～你是想找本人嗎？";
const HANDOFF = "好的，已經幫你轉給本人了～";

const INPUT = {
  instagramAccountId: "ig_1",
  messageId: "mid_1",
  messageText: "沒有問題",
  senderId: "user_1",
};

const PRIOR_LOG = {
  commenterName: "fan",
  automation: {
    keywords: ["音效"],
    trackedLinks: [{ destinationUrl: "https://example.com/page" }],
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The account row as triage reads it, with the given stored mode (null = no setting row). */
function setMode(mode: string | null) {
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    id: "acct_row",
    instagramId: "ig_1",
    accessToken: "enc",
    triageSetting: mode === null ? null : { mode },
  });
}

/**
 * What the log already holds for this sender in the last 24h: how many
 * automatic replies in all, and which fixed lines were among them.
 */
function alreadySent({ replies = 0, lines = [] as string[] } = {}) {
  mockPrisma.triageLog.count.mockImplementation(
    async ({ where }: { where: { replyText?: string } }) =>
      where.replyText === undefined ? replies : lines.includes(where.replyText) ? 1 : 0
  );
}

/** The row written to claim the message, before any decision is made. */
function claimed() {
  return mockPrisma.triageLog.create.mock.calls[0][0].data;
}

/** The decision written onto the claimed row. */
function logged() {
  return mockPrisma.triageLog.update.mock.calls[0][0].data;
}

function nothingWritten() {
  expect(mockPrisma.triageLog.create).not.toHaveBeenCalled();
  expect(mockPrisma.triageLog.update).not.toHaveBeenCalled();
}

const sent = () => mockSendDirectMessage.mock.calls.map((call) => call[3]);
const send = (messageText: string) => runTriage({ ...INPUT, messageText });

describe("runTriage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMode("full");
    alreadySent();
    mockPrisma.triageLog.create.mockResolvedValue({ id: "log_1" });
    mockPrisma.triageLog.update.mockResolvedValue({});
    mockPrisma.dmLog.findMany.mockResolvedValue([PRIOR_LOG]);
    mockPrisma.triagePage.findMany.mockResolvedValue([
      {
        key: "K36",
        title: "三個音效外掛",
        content: "安裝步驟…",
        url: "https://example.com/page",
        keywords: ["音效"],
      },
    ]);
    mockState.ownerRepliedRecently.mockResolvedValue(false);
    mockState.handedOffRecently.mockResolvedValue(false);
    mockState.wasAskedHuman.mockResolvedValue(false);
    mockState.claimNotifySlot.mockResolvedValue(true);
    mockState.markBotActivity.mockResolvedValue(undefined);
    mockState.markAskedHuman.mockResolvedValue(undefined);
    mockState.clearAskedHuman.mockResolvedValue(undefined);
    mockState.markHandoff.mockResolvedValue(undefined);
    mockNotifyOwner.mockResolvedValue(true);
    mockIsAiConfigured.mockReturnValue(true);
    mockAnswerFromPages.mockResolvedValue({ category: "other", answer: null, reason: "x" });
    mockSendDirectMessage.mockResolvedValue({ recipient_id: "user_1", message_id: "m" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("when it must not touch the message", () => {
    it("does nothing when the account's mode is off", async () => {
      setMode("off");
      expect(await runTriage(INPUT)).toBeNull();
      expect(mockPrisma.dmLog.findMany).not.toHaveBeenCalled();
      nothingWritten();
      expect(sent()).toEqual([]);
    });

    it("is off for an account that has never touched the setting", async () => {
      setMode(null);
      expect(await runTriage(INPUT)).toBeNull();
      expect(sent()).toEqual([]);
    });

    it("treats an unrecognised stored mode as off", async () => {
      setMode("banana");
      expect(await runTriage(INPUT)).toBeNull();
      nothingWritten();
    });

    it("does nothing for an account it does not know", async () => {
      mockPrisma.instagramAccount.findUnique.mockResolvedValue(null);
      expect(await runTriage(INPUT)).toBeNull();
      nothingWritten();
    });

    it("leaves a reply to a Story alone, without even looking the account up", async () => {
      expect(await runTriage({ ...INPUT, isStoryReply: true })).toBeNull();
      expect(mockPrisma.instagramAccount.findUnique).not.toHaveBeenCalled();
      nothingWritten();
      expect(sent()).toEqual([]);
    });

    it("never replies to, notifies about, or records someone who was not sent a campaign DM", async () => {
      mockPrisma.dmLog.findMany.mockResolvedValue([]);
      expect(await send("想找你合作")).toBeNull();
      nothingWritten();
      expect(sent()).toEqual([]);
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("only counts campaign DMs that were sent to this person recently", async () => {
      const before = Date.now();
      await runTriage(INPUT);
      const where = mockPrisma.dmLog.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        instagramAccountId: "acct_row",
        commenterId: "user_1",
        status: "SENT",
      });
      const cutoff = where.dmSentAt.gte.getTime();
      expect(cutoff).toBeGreaterThanOrEqual(before - 14 * DAY_MS);
      expect(cutoff).toBeLessThanOrEqual(Date.now() - 14 * DAY_MS);
    });

    it("lets the eligibility window be changed", async () => {
      vi.stubEnv("TRIAGE_ELIGIBLE_DAYS", "3");
      await runTriage(INPUT);
      const cutoff = mockPrisma.dmLog.findMany.mock.calls[0][0].where.dmSentAt.gte.getTime();
      expect(Date.now() - cutoff).toBeLessThan(3 * DAY_MS + 5000);
      expect(Date.now() - cutoff).toBeGreaterThanOrEqual(3 * DAY_MS);
    });
  });

  describe("handling each message once", () => {
    it("claims the message with a pending row before it sends anything", async () => {
      await runTriage(INPUT);
      expect(claimed()).toMatchObject({
        instagramAccountId: "acct_row",
        senderId: "user_1",
        messageId: "mid_1",
        messageText: "沒有問題",
        action: "PENDING",
        mode: "full",
      });
      expect(mockPrisma.triageLog.create.mock.invocationCallOrder[0]).toBeLessThan(
        mockSendDirectMessage.mock.invocationCallOrder[0]
      );
      expect(mockPrisma.triageLog.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "log_1" } })
      );
    });

    it("stops when another run already claimed the same message", async () => {
      mockPrisma.triageLog.create.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
      );
      expect(await runTriage(INPUT)).toBeNull();
      expect(sent()).toEqual([]);
      expect(mockPrisma.triageLog.update).not.toHaveBeenCalled();
    });

    it("sends nothing when the claim fails for any other reason", async () => {
      mockPrisma.triageLog.create.mockRejectedValue(new Error("db down"));
      await expect(runTriage(INPUT)).resolves.toBeNull();
      expect(sent()).toEqual([]);
    });

    it("keeps an over-long message out of the log in full", async () => {
      await send("字".repeat(5000));
      expect(claimed().messageText.length).toBe(2000);
    });
  });

  describe("1. no questions / all clear / got it", () => {
    it.each(["沒有問題", "沒問題", "都很清楚", "都理解", "了解", "目前沒有什麼問題喔 都清楚謝謝你"])(
      "answers %s with the owner's sign-off line",
      async (messageText) => {
        const outcome = await send(messageText);
        expect(outcome?.action).toBe("REPLIED");
        expect(mockSendDirectMessage).toHaveBeenCalledWith("plain:enc", "ig_1", "user_1", SIGN_OFF);
        expect(mockAnswerFromPages).not.toHaveBeenCalled();
        expect(mockNotifyOwner).not.toHaveBeenCalled();
        expect(logged()).toMatchObject({ category: "no_problem", action: "REPLIED" });
      }
    );

    it("tells someone who typed that they followed to tap the button", async () => {
      const outcome = await send("已追蹤");
      expect(outcome).toMatchObject({ category: "followed", action: "REPLIED" });
      expect(sent()).toEqual(["追蹤後請按上一則訊息的按鈕，就會收到連結～"]);
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("says that once: typing it again does not get the line again, or a notice", async () => {
      alreadySent({ replies: 1, lines: ["追蹤後請按上一則訊息的按鈕，就會收到連結～"] });
      const outcome = await send("追蹤了");
      expect(outcome?.action).toBe("IGNORED");
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("sends someone who followed but got nothing to the owner", async () => {
      const outcome = await send("已追蹤可是沒有收到連結");
      expect(outcome?.action).toBe("ESCALATED");
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });

    it("answers thanks with the thanks line", async () => {
      await send("謝謝你！");
      expect(sent()).toEqual([THANKS]);
    });

    it("sends the sign-off line when the model recognises a sign-off the phrase list missed", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "no_question",
        answer: null,
        reason: "對方表示沒有問題且感謝",
      });
      const outcome = await send("目前沒有問麽問題哦，都清楚。");
      expect(outcome?.action).toBe("REPLIED");
      expect(sent()).toEqual([SIGN_OFF]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
      expect(logged()).toMatchObject({
        category: "no_problem",
        reason: "對方表示沒有問題且感謝",
      });
    });

    it("sends the thanks line when the model recognises a thank-you", async () => {
      mockAnswerFromPages.mockResolvedValue({ category: "thanks", answer: null, reason: "道謝" });
      await send("哇這個超實用 太感動了");
      expect(sent()).toEqual([THANKS]);
      expect(logged().category).toBe("thanks");
    });

    it.each([
      "都清楚了，不過可以再傳一次連結嗎",
      "沒有問題了，請問之後還會出進階版",
      "謝謝你，另外想知道怎麼匯出",
      "謝謝 " + "真的很感謝你的分享".repeat(8),
    ])("hands %s to the owner even if the model calls it a sign-off", async (messageText) => {
      mockAnswerFromPages.mockResolvedValue({ category: "no_question", answer: null, reason: "r" });
      const outcome = await send(messageText);
      expect(outcome?.action).toBe("ESCALATED");
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });

    it("says the sign-off line once: a second sign-off within 24h gets no reply", async () => {
      alreadySent({ replies: 1, lines: [SIGN_OFF] });
      const outcome = await send("了解");
      expect(outcome?.action).toBe("IGNORED");
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("still thanks someone who already got the sign-off line", async () => {
      alreadySent({ replies: 1, lines: [SIGN_OFF] });
      await send("謝謝");
      expect(sent()).toEqual([THANKS]);
    });

    it("ignores a bare acknowledgement without replying or notifying", async () => {
      const outcome = await send("好的");
      expect(outcome).toMatchObject({ category: "ack", action: "IGNORED" });
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("marks the conversation bot-active before it sends, so its own echo is not read as the owner", async () => {
      await runTriage(INPUT);
      expect(mockState.markBotActivity).toHaveBeenCalledWith("ig_1", "user_1");
      expect(mockState.markBotActivity.mock.invocationCallOrder[0]).toBeLessThan(
        mockSendDirectMessage.mock.invocationCallOrder[0]
      );
    });
  });

  describe("2. a question about what is on the link", () => {
    it("only looks at pages that belong to this account", async () => {
      await send("這個要怎麼裝");
      expect(mockPrisma.triagePage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ instagramAccountId: "acct_row" }),
        })
      );
    });

    it("answers from the page and labels the answer as automated", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "照第一步貼指令就會裝好。",
        reason: "頁面第一步",
      });
      const outcome = await send("這個音效要怎麼裝");
      expect(outcome?.action).toBe("REPLIED");
      expect(sent()).toEqual(["照第一步貼指令就會裝好。\n（自動回覆）"]);
      expect(mockAnswerFromPages).toHaveBeenCalledWith("這個音效要怎麼裝", [
        { title: "三個音效外掛", content: "安裝步驟…" },
      ]);
      expect(logged()).toMatchObject({ category: "page_question", pageKey: "K36" });
    });

    it("answers a second question too: only fixed lines are said once", async () => {
      alreadySent({ replies: 1, lines: ["照第一步貼指令就會裝好。\n（自動回覆）"] });
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "照第一步貼指令就會裝好。",
        reason: "頁面第一步",
      });
      expect((await send("所以是貼第一步的指令嗎"))?.action).toBe("REPLIED");
    });

    it("escalates instead of failing when the model call throws", async () => {
      mockAnswerFromPages.mockRejectedValue(new Error("model down"));
      const outcome = await send("這個要怎麼裝");
      expect(outcome?.action).toBe("ESCALATED");
      expect(sent()).toEqual([]);
      expect(logged().reason).toBe("model down");
    });

    it("escalates without calling the model when no model is configured", async () => {
      mockIsAiConfigured.mockReturnValue(false);
      const outcome = await send("這個音效要怎麼裝");
      expect(outcome?.action).toBe("ESCALATED");
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(mockNotifyOwner).toHaveBeenCalled();
    });

    it("skips the model in fixed-replies-only mode and escalates real questions", async () => {
      setMode("canned");
      const outcome = await send("這個音效要怎麼裝");
      expect(outcome?.action).toBe("ESCALATED");
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(mockNotifyOwner).toHaveBeenCalled();
    });
  });

  describe("3. collaboration, courses and everything else", () => {
    it.each(["想找你合作 請問價格是多少", "你有開課嗎 想報名你的課程"])(
      "sends nothing for %s and tells the owner",
      async (messageText) => {
        mockAnswerFromPages.mockResolvedValue({
          category: "other",
          answer: null,
          reason: "合作或課程，要本人回",
        });
        const outcome = await send(messageText);
        expect(outcome?.action).toBe("ESCALATED");
        expect(sent()).toEqual([]);
        expect(mockNotifyOwner).toHaveBeenCalledWith(
          expect.objectContaining({
            senderId: "user_1",
            senderName: "fan",
            messageText,
            reason: "合作或課程，要本人回",
          })
        );
      }
    );

    it("does not mark the conversation bot-active when it only tells the owner", async () => {
      await send("想找你合作");
      expect(mockState.markBotActivity).not.toHaveBeenCalled();
    });

    it("tells the owner at most once per person inside the cooldown", async () => {
      mockState.claimNotifySlot.mockResolvedValue(false);
      const outcome = await send("想找你合作");
      expect(outcome?.action).toBe("ESCALATED");
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });
  });

  describe("4. is this an AI?", () => {
    it.each(["你是AI嗎", "是機器人嗎？", "這是自動回覆嗎", "是本人回的嗎", "真人嗎"])(
      "always says yes to %s and asks whether they want the owner",
      async (messageText) => {
        const outcome = await send(messageText);
        expect(outcome).toMatchObject({ category: "asks_if_ai", action: "REPLIED" });
        expect(sent()).toEqual([DISCLOSURE]);
        expect(mockAnswerFromPages).not.toHaveBeenCalled();
        expect(mockState.markAskedHuman).toHaveBeenCalledWith("ig_1", "user_1");
      }
    );

    it("says so in fixed-replies-only mode as well", async () => {
      setMode("canned");
      await send("你是機器人嗎");
      expect(sent()).toEqual([DISCLOSURE]);
    });

    it("says so again if asked again: the disclosure is never withheld", async () => {
      alreadySent({ replies: 1, lines: [DISCLOSURE] });
      await send("所以是AI在回嗎");
      expect(sent()).toEqual([DISCLOSURE]);
    });

    it("says so when the model recognises a wording the patterns missed", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "asks_if_ai",
        answer: null,
        reason: "對方在問是不是機器人回覆",
      });
      await send("感覺不像本人在打字欸");
      expect(sent()).toEqual([DISCLOSURE]);
      expect(mockState.markAskedHuman).toHaveBeenCalled();
    });

    it("does not mistake a question about an AI tool for this", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "免費版就可以用。",
        reason: "頁面有寫",
      });
      await send("這個 AI 要付費嗎");
      expect(sent()).toEqual(["免費版就可以用。\n（自動回覆）"]);
      expect(mockState.markAskedHuman).not.toHaveBeenCalled();
    });

    it("tells the owner and says so when the sender answers yes", async () => {
      mockState.wasAskedHuman.mockResolvedValue(true);
      const outcome = await send("要");
      expect(outcome).toMatchObject({ category: "wants_human", action: "REPLIED" });
      expect(sent()).toEqual([HANDOFF]);
      expect(mockNotifyOwner).toHaveBeenCalledWith(
        expect.objectContaining({ senderName: "fan", messageText: "要" })
      );
      expect(mockState.markHandoff).toHaveBeenCalledWith("ig_1", "user_1");
      expect(mockState.clearAskedHuman).toHaveBeenCalledWith("ig_1", "user_1");
    });

    it.each(["好", "好的謝謝", "嗯嗯", "麻煩了", "找本人", "ok"])(
      "reads %s as yes only because the question was just asked",
      async (messageText) => {
        mockState.wasAskedHuman.mockResolvedValue(true);
        expect((await send(messageText))?.category).toBe("wants_human");
        expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      }
    );

    it("tells the owner about a yes even inside the notice cooldown", async () => {
      mockState.wasAskedHuman.mockResolvedValue(true);
      mockState.claimNotifySlot.mockResolvedValue(false);
      await send("要");
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });

    it("closes with the sign-off line when the sender answers no", async () => {
      mockState.wasAskedHuman.mockResolvedValue(true);
      const outcome = await send("不用了謝謝");
      expect(outcome).toMatchObject({ category: "no_problem", action: "REPLIED" });
      expect(sent()).toEqual([SIGN_OFF]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
      expect(mockState.clearAskedHuman).toHaveBeenCalledWith("ig_1", "user_1");
      expect(mockState.markHandoff).not.toHaveBeenCalled();
    });

    it("carries on as usual when the next message is neither yes nor no", async () => {
      mockState.wasAskedHuman.mockResolvedValue(true);
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "照第一步做。",
        reason: "r",
      });
      await send("那這個音效要怎麼裝");
      expect(sent()).toEqual(["照第一步做。\n（自動回覆）"]);
      expect(mockState.markHandoff).not.toHaveBeenCalled();
    });

    it.each(["我要找本人", "可以轉真人嗎", "請本人回覆我"])(
      "hands %s straight to the owner without asking first",
      async (messageText) => {
        const outcome = await send(messageText);
        expect(outcome).toMatchObject({ category: "wants_human", action: "REPLIED" });
        expect(sent()).toEqual([HANDOFF]);
        expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
        expect(mockState.markHandoff).toHaveBeenCalled();
      }
    );

    it("hands over when the model recognises the request", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "wants_human",
        answer: null,
        reason: "對方想跟創作者本人對話",
      });
      await send("有辦法直接跟老師本尊聊嗎");
      expect(sent()).toEqual([HANDOFF]);
      expect(mockNotifyOwner).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "對方想跟創作者本人對話" })
      );
    });

    it("still tells the owner, without repeating the line, when they ask for the owner twice", async () => {
      alreadySent({ replies: 1, lines: [HANDOFF] });
      const outcome = await send("我要找本人");
      expect(outcome?.action).toBe("ESCALATED");
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });

    it("sends nothing more to someone who asked for the owner", async () => {
      mockState.handedOffRecently.mockResolvedValue(true);
      const outcome = await send("沒有問題");
      expect(outcome?.action).toBe("SKIPPED_OWNER_ACTIVE");
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("flags a real question from someone who is waiting for the owner", async () => {
      mockState.handedOffRecently.mockResolvedValue(true);
      await send("這個音效要怎麼裝");
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });
  });

  describe("staying out of the way", () => {
    it("stays quiet when the owner replied by hand in the last 24h", async () => {
      mockState.ownerRepliedRecently.mockResolvedValue(true);
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("SKIPPED_OWNER_ACTIVE");
      expect(mockState.ownerRepliedRecently).toHaveBeenCalledWith("ig_1", "user_1");
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("does not answer a question while the owner is in the conversation, but still flags it", async () => {
      mockState.ownerRepliedRecently.mockResolvedValue(true);
      const outcome = await send("這個音效要怎麼裝");
      expect(outcome?.action).toBe("SKIPPED_OWNER_ACTIVE");
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });

    it("does not answer 'is this an AI?' for the owner, who is right there", async () => {
      mockState.ownerRepliedRecently.mockResolvedValue(true);
      await send("你是AI嗎");
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });

    it("flags that follow-up at most once inside the cooldown", async () => {
      mockState.ownerRepliedRecently.mockResolvedValue(true);
      mockState.claimNotifySlot.mockResolvedValue(false);
      await send("這個音效要怎麼裝");
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("stops at the daily cap", async () => {
      alreadySent({ replies: 3 });
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("SKIPPED_CAP");
      expect(sent()).toEqual([]);
    });

    it("counts only real replies toward the cap in the live modes", async () => {
      await runTriage(INPUT);
      for (const [{ where }] of mockPrisma.triageLog.count.mock.calls) {
        expect(where).toMatchObject({
          instagramAccountId: "acct_row",
          senderId: "user_1",
          action: "REPLIED",
        });
      }
    });

    it("honours a changed daily cap", async () => {
      vi.stubEnv("TRIAGE_DAILY_REPLY_CAP", "1");
      alreadySent({ replies: 1 });
      expect((await runTriage(INPUT))?.action).toBe("SKIPPED_CAP");
    });
  });

  describe("dry run", () => {
    beforeEach(() => setMode("dry_run"));

    it("sends nothing but logs what it would have sent", async () => {
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("DRY_RUN");
      expect(sent()).toEqual([]);
      expect(mockState.markBotActivity).not.toHaveBeenCalled();
      expect(claimed().mode).toBe("dry_run");
      expect(logged()).toMatchObject({ action: "DRY_RUN", replyText: SIGN_OFF });
    });

    it("shows the would-be page answer without sending it", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "照第一步貼指令就會裝好。",
        reason: "頁面第一步",
      });
      const outcome = await send("這個音效要怎麼裝");
      expect(outcome?.action).toBe("DRY_RUN");
      expect(sent()).toEqual([]);
      expect(logged().replyText).toBe("照第一步貼指令就會裝好。\n（自動回覆）");
    });

    it("does not open the 'want the owner?' question, since the sender never saw it", async () => {
      const outcome = await send("你是AI嗎");
      expect(outcome?.action).toBe("DRY_RUN");
      expect(mockState.markAskedHuman).not.toHaveBeenCalled();
    });

    it("tells the owner about a handover but does not take the conversation over", async () => {
      await send("我要找本人");
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      expect(mockState.markHandoff).not.toHaveBeenCalled();
      expect(sent()).toEqual([]);
    });

    it("still tells the owner about messages that need them", async () => {
      await send("想找你合作");
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });

    it("applies the limits by counting its own would-be replies", async () => {
      alreadySent({ replies: 3 });
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("SKIPPED_CAP");
      expect(mockPrisma.triageLog.count.mock.calls[0][0].where.action).toEqual({
        in: ["REPLIED", "DRY_RUN"],
      });
    });
  });

  describe("when something breaks", () => {
    it("logs a failed send instead of throwing", async () => {
      mockSendDirectMessage.mockRejectedValue(new Error("window closed"));
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("FAILED");
      expect(logged()).toMatchObject({ action: "FAILED", reason: "window closed" });
    });

    it("does not open the 'want the owner?' question when the disclosure failed to send", async () => {
      mockSendDirectMessage.mockRejectedValue(new Error("window closed"));
      await send("你是AI嗎");
      expect(mockState.markAskedHuman).not.toHaveBeenCalled();
    });

    it("does not send when the account has no access token", async () => {
      mockPrisma.instagramAccount.findUnique.mockResolvedValue({
        id: "acct_row",
        instagramId: "ig_1",
        accessToken: null,
        triageSetting: { mode: "canned" },
      });
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("FAILED");
      expect(sent()).toEqual([]);
    });

    it("swallows unexpected errors so the job never retries", async () => {
      mockPrisma.instagramAccount.findUnique.mockRejectedValue(new Error("db down"));
      await expect(runTriage(INPUT)).resolves.toBeNull();
    });

    it("sends nothing when the conversation markers cannot be read", async () => {
      mockState.ownerRepliedRecently.mockRejectedValue(new Error("redis down"));
      await expect(runTriage(INPUT)).resolves.toBeNull();
      expect(sent()).toEqual([]);
    });

    it("swallows a failure to write the decision, after the reply already went out", async () => {
      mockPrisma.triageLog.update.mockRejectedValue(new Error("db blip"));
      await expect(runTriage(INPUT)).resolves.toBeNull();
      expect(sent()).toEqual([SIGN_OFF]);
    });
  });
});
