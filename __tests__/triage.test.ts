import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPrisma,
  mockSendDirectMessage,
  mockState,
  mockNotifyOwner,
  mockAnswerFromPages,
  mockIsAiConfigured,
  mockDraftReply,
  mockDropPendingDrafts,
} = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findUnique: vi.fn() },
    triageLog: { create: vi.fn(), update: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    triagePage: { findMany: vi.fn() },
  },
  mockSendDirectMessage: vi.fn(),
  mockState: {
    ownerRepliedRecently: vi.fn(),
    handedOffRecently: vi.fn(),
    wasAskedHuman: vi.fn(),
    markBotActivity: vi.fn(),
    markAskedHuman: vi.fn(),
    clearAskedHuman: vi.fn(),
    markHandoff: vi.fn(),
  },
  mockNotifyOwner: vi.fn(),
  mockAnswerFromPages: vi.fn(),
  mockIsAiConfigured: vi.fn(),
  mockDraftReply: vi.fn(),
  mockDropPendingDrafts: vi.fn(),
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
vi.mock("@/lib/triage/draft", () => ({ draftReply: mockDraftReply }));
vi.mock("@/lib/triage/draft-store", () => ({ dropPendingDrafts: mockDropPendingDrafts }));

import { runTriage } from "@/lib/triage";

const SIGN_OFF = "好的哦，如果有任何問題都歡迎來問我~";
const THANKS = "不用客氣~ 有問題都可以問我";
const DISCLOSURE = "是的，這是 AI 自動回覆哦～你是想找本人嗎？";
const HANDOFF = "好的，已經幫你轉給本人了～";

const INPUT = {
  instagramAccountId: "ig_1",
  messageId: "mid_1",
  messageText: "沒有問題",
  senderId: "user_1",
};

const FOLLOW_UP = "到這裏還明白嗎？想問下有什麽東西想學的呢？";
const STUCK = "請問你是哪一步卡住了呢？可以截圖給我看嘛？";
const WHERE_TO_START =
  "你可以先想一下你現在目前遇到最麻煩可是又最繁雜的手頭工作，比如說 email reply 或者是回訊息，或者寫報表，其實這些都是可以用 Claude 自動化的";
const USE_COMPUTER = "這個要用電腦才能做哦，手機目前沒辦法～";

const PRIOR_LOG = {
  commenterName: "fan",
  automation: {
    keywords: ["音效"],
    followUpEnabled: true,
    followUpMessage: FOLLOW_UP,
    trackedLinks: [{ destinationUrl: "https://example.com/page" }],
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** When the message under test was claimed. */
const CLAIMED_AT = new Date("2026-11-25T03:00:00Z");
const DRAFT = "可以呀～你是想合作哪一種形式呢？";

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
    mockPrisma.triageLog.create.mockResolvedValue({ id: "log_1", createdAt: CLAIMED_AT });
    mockPrisma.triageLog.update.mockResolvedValue({});
    mockPrisma.triageLog.findMany.mockResolvedValue([]);
    // No draft unless a test asks for one, which is also what a model that
    // declines to write one looks like.
    mockDraftReply.mockResolvedValue(null);
    mockDropPendingDrafts.mockResolvedValue(0);
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

    it.each(["可以", "好的", "ok", "👍", "嗯嗯"])(
      "answers a bare %s with the sign-off line too: it is the reply to 'does that make sense?'",
      async (messageText) => {
        const outcome = await send(messageText);
        expect(outcome).toMatchObject({ category: "ack", action: "REPLIED" });
        expect(sent()).toEqual([SIGN_OFF]);
        expect(mockAnswerFromPages).not.toHaveBeenCalled();
        expect(mockNotifyOwner).not.toHaveBeenCalled();
      }
    );

    it("leaves a bare acknowledgement of the sign-off line itself alone", async () => {
      alreadySent({ replies: 1, lines: [SIGN_OFF] });
      const outcome = await send("好的");
      expect(outcome).toMatchObject({ category: "ack", action: "IGNORED" });
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it.each(["等下才试试", "還沒試", "不會", "還好"])(
      "closes with the sign-off line when the sender says %s",
      async (messageText) => {
        await send(messageText);
        expect(sent()).toEqual([SIGN_OFF]);
        expect(mockAnswerFromPages).not.toHaveBeenCalled();
      }
    );

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
      expect(mockAnswerFromPages).toHaveBeenCalledWith(
        "這個音效要怎麼裝",
        [{ title: "三個音效外掛", content: "安裝步驟…" }],
        FOLLOW_UP
      );
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

  describe("stuck, new to AI, and phones", () => {
    it.each(["不知道如何使用", "看不懂", "覺得難", "天哪，好複雜", "沒有很清楚"])(
      "asks %s which step they are stuck on, and for a screenshot",
      async (messageText) => {
        const outcome = await send(messageText);
        expect(outcome).toMatchObject({ category: "stuck", action: "REPLIED" });
        expect(sent()).toEqual([STUCK]);
        expect(mockAnswerFromPages).not.toHaveBeenCalled();
        expect(mockNotifyOwner).not.toHaveBeenCalled();
      }
    );

    it("asks the same when the model sees that a short reply means it was hard", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "stuck",
        answer: null,
        reason: "我們問會不會難，對方回有點",
      });
      await send("有點");
      expect(sent()).toEqual([STUCK]);
      expect(mockAnswerFromPages.mock.calls[0][2]).toBe(FOLLOW_UP);
    });

    it("does not pass on a follow-up question the campaign has switched off", async () => {
      mockPrisma.dmLog.findMany.mockResolvedValue([
        { ...PRIOR_LOG, automation: { ...PRIOR_LOG.automation, followUpEnabled: false } },
      ]);
      await send("有點");
      expect(mockAnswerFromPages.mock.calls[0][2]).toBeNull();
    });

    it("answers a concrete question from the page instead of asking where they are stuck", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "解壓縮後照第二步做。",
        reason: "頁面第二步",
      });
      await send("下載好ZIP然後呢？");
      expect(sent()).toEqual(["解壓縮後照第二步做。\n（自動回覆）"]);
    });

    it("tells someone who has just subscribed where to begin, in the owner's words", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "where_to_start",
        answer: null,
        reason: "剛訂閱，不知道怎麼更進一步運用",
      });
      const outcome = await send("我目前只有訂閱GPT plus\n用了蠻長一段時間\n不太清楚可以怎麼更進一步運用");
      expect(outcome).toMatchObject({ category: "where_to_start", action: "REPLIED" });
      expect(sent()).toEqual([WHERE_TO_START]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("tells someone who asks about using a phone to use a computer", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "device",
        answer: null,
        reason: "問手機能不能用",
      });
      const outcome = await send("这个是必须要有Claude code 才能够用的对吧？如果在电话使用的话呢？");
      expect(outcome).toMatchObject({ category: "use_computer", action: "REPLIED" });
      expect(sent()).toEqual([USE_COMPUTER]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("hands someone who is still stuck after being asked to the owner, rather than going quiet", async () => {
      alreadySent({ replies: 1, lines: [STUCK] });
      const outcome = await send("還是看不懂");
      expect(outcome?.action).toBe("ESCALATED");
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner.mock.calls[0][0]).toMatchObject({ messageText: "還是看不懂", reason: "問過哪一步卡住了，對方還是說不會" });
    });

    it("does not repeat the phone line or the where-to-start line to the same person", async () => {
      alreadySent({ replies: 1, lines: [USE_COMPUTER] });
      mockAnswerFromPages.mockResolvedValue({ category: "device", answer: null, reason: "r" });
      const outcome = await send("所以手機真的不行嗎");
      expect(outcome?.action).toBe("IGNORED");
      expect(sent()).toEqual([]);
    });
  });

  describe("pictures and files", () => {
    const picture = { ...INPUT, messageText: "", attachmentKind: "image" as const };

    it("tells the owner about a screenshot, since nobody else can look at it", async () => {
      const outcome = await runTriage(picture);
      expect(outcome).toMatchObject({ category: "attachment", action: "ESCALATED" });
      expect(sent()).toEqual([]);
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(mockNotifyOwner.mock.calls[0][0]).toMatchObject({ senderName: "fan", messageText: "［圖片］" });
      expect(claimed().messageText).toBe("［圖片］");
    });

    it("does not treat a picture as an acknowledgement, even though it has no words", async () => {
      const outcome = await runTriage(picture);
      expect(outcome?.category).not.toBe("ack");
    });

    it("passes every picture on without forcing the phone to ring each time", async () => {
      await runTriage(picture);
      expect(mockNotifyOwner.mock.calls[0][1]).toEqual({ ring: false });
    });

    it("leaves pictures from people who were not sent a campaign DM alone", async () => {
      mockPrisma.dmLog.findMany.mockResolvedValue([]);
      expect(await runTriage(picture)).toBeNull();
      nothingWritten();
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("still flags a picture in a conversation the owner is handling", async () => {
      mockState.ownerRepliedRecently.mockResolvedValue(true);
      const outcome = await runTriage(picture);
      expect(outcome?.action).toBe("SKIPPED_OWNER_ACTIVE");
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });
  });

  describe("the other account's own auto-reply", () => {
    const AWAY = "謝謝你傳送訊息給我們。我們將盡快與你聯絡。";

    it("gets no reply and no notice", async () => {
      const outcome = await send(AWAY);
      expect(outcome).toMatchObject({ category: "auto_reply", action: "IGNORED" });
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
    });

    it("gets no notice even in a conversation the owner is handling by hand", async () => {
      mockState.ownerRepliedRecently.mockResolvedValue(true);
      const outcome = await send("感謝你送來的訊息，現在不是真人回復");
      expect(outcome).toMatchObject({ category: "auto_reply", action: "IGNORED" });
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("is still written to the log, so the owner can see what was left out", async () => {
      await send(AWAY);
      expect(logged()).toMatchObject({ category: "auto_reply", action: "IGNORED" });
      expect(claimed().messageText).toBe(AWAY);
    });

    it("is also left alone when only the model can tell it is automatic", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "auto_reply",
        answer: null,
        reason: "店家的離線訊息",
      });
      const outcome = await send("本店今日公休，明日恢復服務，造成不便敬請見諒");
      expect(outcome).toMatchObject({ category: "auto_reply", action: "IGNORED" });
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("does not swallow a real person asking whether the replies are automatic", async () => {
      await send("這是自動回覆嗎");
      expect(sent()).toEqual([DISCLOSURE]);
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
        expect(mockNotifyOwner.mock.calls[0][0]).toMatchObject({
            senderId: "user_1",
            senderName: "fan",
            messageText,
            reason: "合作或課程，要本人回",
          });
      }
    );

    it("does not mark the conversation bot-active when it only tells the owner", async () => {
      await send("想找你合作");
      expect(mockState.markBotActivity).not.toHaveBeenCalled();
    });

    it("passes every such message on, and leaves how often the phone rings to the notice", async () => {
      const outcome = await send("想找你合作");
      expect(outcome?.action).toBe("ESCALATED");
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      expect(mockNotifyOwner.mock.calls[0][1]).toEqual({ ring: false });
    });
  });

  describe("a draft for the owner to approve", () => {
    const other = (reason = "合作，要本人回") =>
      mockAnswerFromPages.mockResolvedValue({ category: "other", answer: null, reason });
    const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder[0];

    beforeEach(() => {
      other();
      mockDraftReply.mockResolvedValue(DRAFT);
    });

    it("hands the message over with a draft, and sends nothing itself", async () => {
      const outcome = await send("想找你合作");

      expect(outcome).toEqual({ category: "other", action: "ESCALATED", replyText: DRAFT });
      expect(sent()).toEqual([]);
      expect(mockState.markBotActivity).not.toHaveBeenCalled();
      expect(logged()).toMatchObject({
        category: "other",
        action: "ESCALATED",
        replyText: DRAFT,
        reason: "合作，要本人回",
      });
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      expect(mockNotifyOwner.mock.calls[0]).toEqual([
        {
          instagramAccountId: "ig_1",
          senderId: "user_1",
          senderName: "fan",
          messageText: "想找你合作",
          reason: "合作，要本人回",
          draft: { logId: "log_1", text: DRAFT, at: CLAIMED_AT.getTime() },
        },
        { ring: false },
      ]);
    });

    it("writes the draft onto the row before the notice goes out, so its buttons always find it", async () => {
      await send("想找你合作");
      expect(order(mockPrisma.triageLog.update)).toBeLessThan(order(mockNotifyOwner));
    });

    it("gives the writer the message, why it was handed over, the page and its link", async () => {
      await send("沒收到連結");
      expect(mockDraftReply).toHaveBeenCalledTimes(1);
      expect(mockDraftReply.mock.calls[0][0]).toMatchObject({
        message: "沒收到連結",
        reason: "合作，要本人回",
        pages: [{ title: "三個音效外掛", url: "https://example.com/page", content: "安裝步驟…" }],
        history: [],
      });
    });

    it("gives the writer today's conversation, oldest first, with only what really went out", async () => {
      // Newest first, as the query returns them.
      mockPrisma.triageLog.findMany.mockResolvedValue([
        { messageText: "多少錢", action: "ESCALATED", replyText: "一份沒送出的草稿" },
        { messageText: "有課嗎", action: "SENT_BY_OWNER", replyText: "有的～你想學哪方面？" },
        { messageText: "謝謝", action: "REPLIED", replyText: THANKS },
        { messageText: "在嗎", action: "SKIPPED_CAP", replyText: "沒發出去的" },
      ]);
      await send("想找你合作");

      expect(mockDraftReply.mock.calls[0][0].history).toEqual([
        { from: "them", text: "在嗎" },
        { from: "them", text: "謝謝" },
        { from: "us", text: THANKS },
        { from: "them", text: "有課嗎" },
        { from: "us", text: "有的～你想學哪方面？" },
        { from: "them", text: "多少錢" },
      ]);
      const { where } = mockPrisma.triageLog.findMany.mock.calls[0][0];
      expect(where).toMatchObject({
        instagramAccountId: "acct_row",
        senderId: "user_1",
        id: { not: "log_1" },
      });
    });

    it("replaces the drafts of this person's earlier messages, and only earlier ones", async () => {
      await send("想找你合作");
      expect(mockDropPendingDrafts).toHaveBeenCalledTimes(1);
      expect(mockDropPendingDrafts).toHaveBeenCalledWith(
        { accountId: "acct_row", senderId: "user_1" },
        { olderThan: CLAIMED_AT }
      );
      expect(order(mockDropPendingDrafts)).toBeLessThan(order(mockPrisma.triageLog.update));
    });

    it("still hands the message over when an old draft cannot be dropped", async () => {
      mockDropPendingDrafts.mockRejectedValue(new Error("db blip"));
      const outcome = await send("想找你合作");
      expect(outcome?.action).toBe("ESCALATED");
      expect(mockNotifyOwner.mock.calls[0][0].draft).toMatchObject({ text: DRAFT });
    });

    it("still tells the owner, plainly, when the draft cannot be stored", async () => {
      mockPrisma.triageLog.update.mockRejectedValue(new Error("db blip"));
      await expect(send("想找你合作")).resolves.toBeNull();

      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      // No buttons for a draft that is not there to be sent.
      expect(mockNotifyOwner.mock.calls[0][0]).not.toHaveProperty("draft");
    });

    it("sends the notice without a draft when there is none to offer", async () => {
      mockDraftReply.mockResolvedValue(null);
      const outcome = await send("c");

      expect(outcome).toEqual({ category: "other", action: "ESCALATED", replyText: null });
      expect(logged().replyText).toBeNull();
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      // No word about a draft: one already waiting under the notice stays.
      expect(mockNotifyOwner.mock.calls[0][0]).not.toHaveProperty("draft");
      expect(mockDropPendingDrafts).not.toHaveBeenCalled();
    });

    it("still tells the owner when preparing the draft blows up", async () => {
      mockPrisma.triageLog.findMany.mockRejectedValue(new Error("db blip"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const outcome = await send("想找你合作");
      errorSpy.mockRestore();

      expect(outcome?.action).toBe("ESCALATED");
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      expect(mockNotifyOwner.mock.calls[0][0]).not.toHaveProperty("draft");
    });

    it("offers one when the sender is still stuck after being asked which step", async () => {
      alreadySent({ lines: [STUCK] });
      const outcome = await send("還是看不懂");

      expect(outcome?.action).toBe("ESCALATED");
      expect(sent()).toEqual([]);
      expect(mockDraftReply.mock.calls[0][0]).toMatchObject({
        message: "還是看不懂",
        reason: "問過哪一步卡住了，對方還是說不會",
      });
      expect(mockNotifyOwner.mock.calls[0][0].draft).toMatchObject({ text: DRAFT });
    });

    describe("is not written", () => {
      afterEach(() => {
        expect(mockDraftReply).not.toHaveBeenCalled();
      });

      it("in a dry run, where nothing may go out", async () => {
        setMode("dry_run");
        await send("想找你合作");
        expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
        expect(mockNotifyOwner.mock.calls[0][0]).not.toHaveProperty("draft");
      });

      it("in canned mode, which uses no model", async () => {
        setMode("canned");
        await send("想找你合作");
        expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      });

      it("when no model is configured", async () => {
        mockIsAiConfigured.mockReturnValue(false);
        await send("想找你合作");
        expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      });

      it("when the model has just failed on this message", async () => {
        mockAnswerFromPages.mockRejectedValue(new Error("AI 呼叫失敗（test 回 429）"));
        const outcome = await send("想找你合作");
        expect(outcome?.action).toBe("ESCALATED");
        expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      });

      it("for a picture, which nobody but the owner can look at", async () => {
        await runTriage({ ...INPUT, messageText: "", attachmentKind: "image" });
        expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
        expect(mockNotifyOwner.mock.calls[0][0]).not.toHaveProperty("draft");
      });

      it("when the sender asks for the owner in person: they get the fixed line, the owner a ring", async () => {
        await send("我要找本人");
        expect(sent()).toEqual([HANDOFF]);
        expect(mockNotifyOwner.mock.calls[0][0]).not.toHaveProperty("draft");
        expect(mockNotifyOwner.mock.calls[0][1]).toEqual({ ring: true });
      });

      it("while the owner is answering by hand — and the draft from before is dropped and taken off the notice", async () => {
        mockState.ownerRepliedRecently.mockResolvedValue(true);
        const outcome = await send("那預算大概多少");

        expect(outcome?.action).toBe("SKIPPED_OWNER_ACTIVE");
        expect(mockDropPendingDrafts).toHaveBeenCalledWith(
          { accountId: "acct_row", senderId: "user_1" },
          {}
        );
        expect(mockNotifyOwner.mock.calls[0][0]).toMatchObject({ draft: null });
      });

      it("after the sender asked for the owner — the draft from before is left for the owner to decide", async () => {
        mockState.handedOffRecently.mockResolvedValue(true);
        const outcome = await send("那預算大概多少");

        expect(outcome?.action).toBe("SKIPPED_OWNER_ACTIVE");
        expect(mockDropPendingDrafts).not.toHaveBeenCalled();
        expect(mockNotifyOwner.mock.calls[0][0]).not.toHaveProperty("draft");
      });
    });

    it("drops the earlier draft even for a pleasantry the owner is not told about", async () => {
      mockState.ownerRepliedRecently.mockResolvedValue(true);
      await send("謝謝");
      expect(mockDropPendingDrafts).toHaveBeenCalledTimes(1);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("keeps handling the message when the owner is active and the old draft cannot be dropped", async () => {
      mockState.ownerRepliedRecently.mockResolvedValue(true);
      mockDropPendingDrafts.mockRejectedValue(new Error("db blip"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const outcome = await send("那預算大概多少");
      errorSpy.mockRestore();
      expect(outcome?.action).toBe("SKIPPED_OWNER_ACTIVE");
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
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
      expect(mockNotifyOwner.mock.calls[0][0]).toMatchObject({ senderName: "fan", messageText: "要" });
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

    it("makes the phone ring for a yes, even if it rang for this person a minute ago", async () => {
      mockState.wasAskedHuman.mockResolvedValue(true);
      await send("要");
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      expect(mockNotifyOwner.mock.calls[0][1]).toEqual({ ring: true });
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
      expect(mockNotifyOwner.mock.calls[0][0]).toMatchObject({ reason: "對方想跟創作者本人對話" });
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

    it("does not force a ring for that follow-up", async () => {
      mockState.ownerRepliedRecently.mockResolvedValue(true);
      await send("這個音效要怎麼裝");
      expect(mockNotifyOwner.mock.calls[0][1]).toEqual({ ring: false });
    });

    it("stops at the daily cap", async () => {
      alreadySent({ replies: 6 });
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("SKIPPED_CAP");
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("hands a real question that hits the cap to the owner instead of dropping it", async () => {
      alreadySent({ replies: 6 });
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "照第一步做。",
        reason: "r",
      });
      const outcome = await send("那第三步的指令要貼在哪");
      expect(outcome?.action).toBe("SKIPPED_CAP");
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
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
      alreadySent({ replies: 6 });
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
