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
  mockQueueAdd,
} = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findUnique: vi.fn() },
    triageLog: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    dmLog: { findMany: vi.fn() },
    triagePage: { findMany: vi.fn(), findFirst: vi.fn() },
    automation: { findFirst: vi.fn() },
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
    getOffered: vi.fn(),
    markOffered: vi.fn(),
    clearOffered: vi.fn(),
    claimResend: vi.fn(),
  },
  mockNotifyOwner: vi.fn(),
  mockAnswerFromPages: vi.fn(),
  mockIsAiConfigured: vi.fn(),
  mockDraftReply: vi.fn(),
  mockDropPendingDrafts: vi.fn(),
  mockQueueAdd: vi.fn(),
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
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd }),
  POSTBACK_JOB_NAME: "process-postback",
}));

import { claimTriage, resumeTriage, runTriage } from "@/lib/triage";

const SIGN_OFF = "好的哦，如果有任何問題都歡迎來問我~";
const THANKS = "不用客氣~ 有問題都可以問我";
const THANKS_SHORT = "不用客氣~";
const QUOTA_OFFER = "我有做過省額度的教學哦，如果要的話我可以把連結傳給你～";
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
    id: "auto_1",
    isActive: true,
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

type CountWhere = { action?: unknown; replyText?: string | { in: string[] } };

/**
 * What the log already holds for this sender: how many automatic replies in
 * the last 24h, which fixed lines were among them, how many of their
 * questions are still waiting for the owner, and whether a line that invites
 * questions went out a moment ago.
 */
function alreadySent({
  replies = 0,
  lines = [] as string[],
  waitingOnOwner = 0,
  invitedJustNow = false,
} = {}) {
  mockPrisma.triageLog.count.mockImplementation(async ({ where }: { where: CountWhere }) => {
    if (where.action === "ESCALATED") return waitingOnOwner;
    if (typeof where.replyText === "object") return invitedJustNow ? 1 : 0;
    if (where.replyText === undefined) return replies;
    return lines.includes(where.replyText) ? 1 : 0;
  });
}

/** The count calls that decide the daily cap and "said once": not the other two. */
function replyCounts() {
  return mockPrisma.triageLog.count.mock.calls
    .map((call) => call[0].where as CountWhere)
    .filter((where: CountWhere) => where.action !== "ESCALATED");
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
    mockPrisma.triageLog.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.triageLog.findMany.mockResolvedValue([]);
    mockPrisma.triageLog.findUnique.mockResolvedValue(null);
    mockPrisma.triagePage.findFirst.mockResolvedValue(null);
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    mockQueueAdd.mockResolvedValue({});
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
    mockState.getOffered.mockResolvedValue(null);
    mockState.markOffered.mockResolvedValue(undefined);
    mockState.clearOffered.mockResolvedValue(undefined);
    mockState.claimResend.mockResolvedValue(true);
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

    it("answers from the page, in the answer's own words and nothing added", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "照第一步貼指令就會裝好。",
        reason: "頁面第一步",
      });
      const outcome = await send("這個音效要怎麼裝");
      expect(outcome?.action).toBe("REPLIED");
      expect(sent()).toEqual(["照第一步貼指令就會裝好。"]);
      expect(mockAnswerFromPages).toHaveBeenCalledWith(
        "這個音效要怎麼裝",
        [{ title: "三個音效外掛", content: "安裝步驟…" }],
        FOLLOW_UP,
        []
      );
      expect(logged()).toMatchObject({ category: "page_question", pageKey: "K36" });
    });

    it("answers a second question too: only fixed lines are said once", async () => {
      alreadySent({ replies: 1, lines: ["照第一步貼指令就會裝好。"] });
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
      expect(sent()).toEqual(["解壓縮後照第二步做。"]);
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
      await send("請問可以跟你合作嗎");
      expect(mockDraftReply).toHaveBeenCalledTimes(1);
      expect(mockDraftReply.mock.calls[0][0]).toMatchObject({
        message: "請問可以跟你合作嗎",
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
        id: { notIn: ["log_1"] },
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
      mockDraftReply.mockRejectedValue(new Error("writer blew up"));
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
      expect(sent()).toEqual(["免費版就可以用。"]);
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
      expect(sent()).toEqual(["照第一步做。"]);
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
      expect(replyCounts().length).toBeGreaterThan(0);
      for (const where of replyCounts()) {
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
      expect(logged().replyText).toBe("照第一步貼指令就會裝好。");
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
      expect(replyCounts()[0].action).toEqual({
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

describe("runTriage — the conversation so far", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMode("full");
    alreadySent();
    mockPrisma.triageLog.create.mockResolvedValue({ id: "log_1", createdAt: CLAIMED_AT });
    mockPrisma.triageLog.update.mockResolvedValue({});
    mockPrisma.triageLog.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.triageLog.findMany.mockResolvedValue([]);
    mockPrisma.triageLog.findUnique.mockResolvedValue(null);
    mockPrisma.triagePage.findFirst.mockResolvedValue(null);
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    mockQueueAdd.mockResolvedValue({});
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
    mockState.getOffered.mockResolvedValue(null);
    mockState.markOffered.mockResolvedValue(undefined);
    mockState.clearOffered.mockResolvedValue(undefined);
    mockState.claimResend.mockResolvedValue(true);
    mockNotifyOwner.mockResolvedValue(true);
    mockIsAiConfigured.mockReturnValue(true);
    mockAnswerFromPages.mockResolvedValue({ category: "other", answer: null, reason: "x" });
    mockSendDirectMessage.mockResolvedValue({ recipient_id: "user_1", message_id: "m" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("what the model is shown", () => {
    it("gets today's earlier turns, oldest first, with only what really went out", async () => {
      // Newest first, as the query returns them.
      mockPrisma.triageLog.findMany.mockResolvedValue([
        { messageText: "欸…尚未嘗試", action: "MERGED", replyText: null },
        { messageText: "免費版的也支援嗎", action: "SENT_BY_OWNER", replyText: "不太確定呢，方便截圖嗎？" },
        { messageText: "在嗎", action: "SKIPPED_CAP", replyText: "沒發出去的" },
      ]);
      await send("所以免費版到底行不行");

      expect(mockAnswerFromPages).toHaveBeenCalledWith(
        "所以免費版到底行不行",
        [{ title: "三個音效外掛", content: "安裝步驟…" }],
        FOLLOW_UP,
        [
          { from: "them", text: "在嗎" },
          { from: "them", text: "免費版的也支援嗎" },
          { from: "us", text: "不太確定呢，方便截圖嗎？" },
          { from: "them", text: "欸…尚未嘗試" },
        ]
      );
      const { where, take } = mockPrisma.triageLog.findMany.mock.calls[0][0];
      expect(where).toMatchObject({
        instagramAccountId: "acct_row",
        senderId: "user_1",
        id: { notIn: ["log_1"] },
      });
      expect(Date.now() - where.createdAt.gte.getTime()).toBeLessThan(DAY_MS + 5000);
      expect(take).toBe(6);
    });

    it("looks the earlier turns up once, for the model and the draft writer both", async () => {
      mockPrisma.triageLog.findMany.mockResolvedValue([
        { messageText: "多少錢", action: "ESCALATED", replyText: null },
      ]);
      await send("想找你合作");

      expect(mockPrisma.triageLog.findMany).toHaveBeenCalledTimes(1);
      expect(mockAnswerFromPages.mock.calls[0][3]).toEqual([{ from: "them", text: "多少錢" }]);
      expect(mockDraftReply.mock.calls[0][0].history).toEqual([{ from: "them", text: "多少錢" }]);
    });

    it("is still asked when the earlier turns cannot be read: it just sees none", async () => {
      mockPrisma.triageLog.findMany.mockRejectedValue(new Error("db blip"));
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "照第一步做。",
        reason: "頁面第一步",
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const outcome = await send("這個要怎麼裝");
      errorSpy.mockRestore();

      expect(outcome?.action).toBe("REPLIED");
      expect(mockAnswerFromPages.mock.calls[0][3]).toEqual([]);
      expect(sent()).toEqual(["照第一步做。"]);
    });

    it("is not asked at all for a phrase with a fixed answer", async () => {
      await send("謝謝");
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(mockPrisma.triageLog.findMany).not.toHaveBeenCalled();
    });
  });

  describe("a sign-off under a question that is still waiting for the owner", () => {
    it.each(["謝謝", "好的", "還沒試", "沒有問題"])("says nothing to %s", async (messageText) => {
      alreadySent({ waitingOnOwner: 1 });
      const outcome = await send(messageText);

      expect(outcome?.action).toBe("IGNORED");
      expect(sent()).toEqual([]);
      expect(logged().reason).toBe("他前面的問題還在等你回，先不發收尾句");
      // The owner already has the question in front of them.
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("says nothing either when it is the model that calls the message a sign-off", async () => {
      alreadySent({ waitingOnOwner: 1 });
      mockAnswerFromPages.mockResolvedValue({ category: "no_question", answer: null, reason: "還沒試" });
      const outcome = await send("欸…尚未嘗試");

      expect(outcome).toMatchObject({ category: "no_problem", action: "IGNORED" });
      expect(sent()).toEqual([]);
    });

    it("looks only at this person's questions handed over in the last half hour, not at this message", async () => {
      await send("謝謝");
      const where = mockPrisma.triageLog.count.mock.calls
        .map((call) => call[0].where as CountWhere & Record<string, unknown>)
        .find((w: CountWhere) => w.action === "ESCALATED") as Record<string, unknown> & {
        createdAt: { gte: Date };
      };
      expect(where).toMatchObject({
        instagramAccountId: "acct_row",
        senderId: "user_1",
        action: "ESCALATED",
        id: { notIn: ["log_1"] },
      });
      const age = Date.now() - where.createdAt.gte.getTime();
      expect(age).toBeGreaterThanOrEqual(30 * 60 * 1000);
      expect(age).toBeLessThan(30 * 60 * 1000 + 5000);
    });

    it("still answers a real question from someone who is waiting on another", async () => {
      alreadySent({ waitingOnOwner: 1 });
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "照第一步做。",
        reason: "頁面第一步",
      });
      expect((await send("那這個要怎麼裝"))?.action).toBe("REPLIED");
      expect(sent()).toEqual(["照第一步做。"]);
    });

    it("still tells someone who typed that they followed to tap the button", async () => {
      alreadySent({ waitingOnOwner: 1 });
      await send("已追蹤");
      expect(sent()).toEqual(["追蹤後請按上一則訊息的按鈕，就會收到連結～"]);
    });
  });

  describe("not inviting questions twice in a row", () => {
    it("thanks without the invitation when a line that invites questions just went out", async () => {
      alreadySent({ replies: 1, lines: [SIGN_OFF], invitedJustNow: true });
      const outcome = await send("好的 謝謝");

      expect(outcome).toMatchObject({ category: "thanks", action: "REPLIED" });
      expect(sent()).toEqual([THANKS_SHORT]);
    });

    it("thanks with the invitation the rest of the time", async () => {
      alreadySent({ replies: 1, lines: [SIGN_OFF] });
      await send("謝謝");
      expect(sent()).toEqual([THANKS]);
    });

    it("asks about the two inviting lines, sent in the last ten minutes", async () => {
      await send("謝謝");
      const where = mockPrisma.triageLog.count.mock.calls
        .map((call) => call[0].where as CountWhere & Record<string, unknown>)
        .find((w: CountWhere) => typeof w.replyText === "object") as Record<string, unknown> & {
        createdAt: { gte: Date };
      };
      expect(where).toMatchObject({
        senderId: "user_1",
        action: "REPLIED",
        replyText: { in: [SIGN_OFF, THANKS] },
      });
      const age = Date.now() - where.createdAt.gte.getTime();
      expect(age).toBeGreaterThanOrEqual(10 * 60 * 1000);
      expect(age).toBeLessThan(10 * 60 * 1000 + 5000);
    });

    it("says the short thanks once, too", async () => {
      alreadySent({ replies: 2, lines: [SIGN_OFF, THANKS_SHORT], invitedJustNow: true });
      const outcome = await send("謝謝你");
      expect(outcome?.action).toBe("IGNORED");
      expect(sent()).toEqual([]);
    });
  });
});

describe("the conversation the owner complained about (2026-11-25)", () => {
  // What went out on the day:
  //   them  免費版的也支援嗎
  //   us    頁面有寫到不需要另外申請 API key，但免費版是否支援還不太確定呢，你方便截圖給我看一下嗎？
  //   them  欸…尚未嘗試
  //   us    好的哦，如果有任何問題都歡迎來問我~
  //   them  好的 謝謝
  //   us    不用客氣~ 有問題都可以問我
  // A question nobody answered, closed twice with "feel free to ask".
  const FREE_PLAN = "免費版沒辦法哦，這個要用到 Claude Code，要 Pro 以上才有～";

  beforeEach(() => {
    vi.clearAllMocks();
    setMode("full");
    alreadySent();
    mockPrisma.triageLog.create.mockResolvedValue({ id: "log_1", createdAt: CLAIMED_AT });
    mockPrisma.triageLog.update.mockResolvedValue({});
    mockPrisma.triageLog.findMany.mockResolvedValue([]);
    mockPrisma.dmLog.findMany.mockResolvedValue([PRIOR_LOG]);
    mockPrisma.triagePage.findMany.mockResolvedValue([
      { key: "K14", title: "Claudex", content: "不需要另外申請 API key…", url: "https://example.com/page", keywords: [] },
    ]);
    mockQueueAdd.mockResolvedValue({});
    mockDraftReply.mockResolvedValue(null);
    mockDropPendingDrafts.mockResolvedValue(0);
    mockState.ownerRepliedRecently.mockResolvedValue(false);
    mockState.handedOffRecently.mockResolvedValue(false);
    mockState.wasAskedHuman.mockResolvedValue(false);
    mockState.markBotActivity.mockResolvedValue(undefined);
    mockState.getOffered.mockResolvedValue(null);
    mockNotifyOwner.mockResolvedValue(true);
    mockIsAiConfigured.mockReturnValue(true);
    mockSendDirectMessage.mockResolvedValue({ recipient_id: "user_1", message_id: "m" });
  });

  it("answers the question, in one sentence, with nothing tacked on and no screenshot asked for", async () => {
    mockAnswerFromPages.mockResolvedValue({
      category: "page_question",
      answer: FREE_PLAN,
      reason: "常見問題：免費版",
    });
    const outcome = await send("免費版的也支援嗎");

    expect(outcome).toMatchObject({ category: "page_question", action: "REPLIED" });
    expect(sent()).toEqual([FREE_PLAN]);
    expect(mockNotifyOwner).not.toHaveBeenCalled();
  });

  it("shows the model the unanswered question when the next message comes, so it can still be answered", async () => {
    mockPrisma.triageLog.findMany.mockResolvedValue([
      {
        messageText: "免費版的也支援嗎",
        action: "SENT_BY_OWNER",
        replyText: "頁面有寫到不需要另外申請 API key，但免費版是否支援還不太確定呢，你方便截圖給我看一下嗎？",
      },
    ]);
    mockAnswerFromPages.mockResolvedValue({
      category: "page_question",
      answer: FREE_PLAN,
      reason: "前面的問題還沒被回答",
    });
    await send("欸…尚未嘗試");

    expect(mockAnswerFromPages.mock.calls[0][3]).toEqual([
      { from: "them", text: "免費版的也支援嗎" },
      {
        from: "us",
        text: "頁面有寫到不需要另外申請 API key，但免費版是否支援還不太確定呢，你方便截圖給我看一下嗎？",
      },
    ]);
    // Not the sign-off line.
    expect(sent()).toEqual([FREE_PLAN]);
  });

  it("closes once, not twice: the thanks that follows a sign-off does not repeat the invitation", async () => {
    // "好的 那我之後買了再做嘗試" has just been answered with the sign-off line.
    alreadySent({ replies: 2, lines: [FREE_PLAN, SIGN_OFF], invitedJustNow: true });
    await send("好的 謝謝");

    expect(sent()).toEqual([THANKS_SHORT]);
  });

  it("says nothing at all to that thanks while the question is still with the owner", async () => {
    alreadySent({ waitingOnOwner: 1 });
    const outcome = await send("好的 謝謝");

    expect(outcome?.action).toBe("IGNORED");
    expect(sent()).toEqual([]);
  });
});

describe("runTriage — the link never came", () => {
  const RESEND_JOB = [
    "process-postback",
    {
      instagramAccountId: "ig_1",
      userId: "user_1",
      payload: "followcheck:auto_1",
      strictFollow: true,
    },
    { jobId: "triage_send_auto_1_log_1" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    setMode("full");
    alreadySent();
    mockPrisma.triageLog.create.mockResolvedValue({ id: "log_1", createdAt: CLAIMED_AT });
    mockPrisma.triageLog.update.mockResolvedValue({});
    mockPrisma.triageLog.findMany.mockResolvedValue([]);
    mockPrisma.dmLog.findMany.mockResolvedValue([PRIOR_LOG]);
    mockPrisma.triagePage.findMany.mockResolvedValue([]);
    mockQueueAdd.mockResolvedValue({});
    mockDraftReply.mockResolvedValue(null);
    mockDropPendingDrafts.mockResolvedValue(0);
    mockState.ownerRepliedRecently.mockResolvedValue(false);
    mockState.handedOffRecently.mockResolvedValue(false);
    mockState.wasAskedHuman.mockResolvedValue(false);
    mockState.getOffered.mockResolvedValue(null);
    mockState.claimResend.mockResolvedValue(true);
    mockNotifyOwner.mockResolvedValue(true);
    mockIsAiConfigured.mockReturnValue(true);
    mockAnswerFromPages.mockResolvedValue({ category: "other", answer: null, reason: "x" });
  });

  it.each(["沒收到", "沒有收到連結", "沒有按鈕", "找不到連結", "還沒收到 謝謝"])(
    "sends the campaign again when the sender writes %s, and lets the worker check the follow",
    async (messageText) => {
      const outcome = await send(messageText);

      expect(outcome).toEqual({
        category: "missing_link",
        action: "REPLIED",
        replyText: "〔重傳連結〕",
      });
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      expect(mockQueueAdd).toHaveBeenCalledWith(...RESEND_JOB);
      // Triage itself types nothing: the campaign's own message is what goes out.
      expect(sent()).toEqual([]);
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(mockNotifyOwner).not.toHaveBeenCalled();
      expect(mockState.claimResend).toHaveBeenCalledWith("ig_1", "user_1", "auto_1");
    }
  );

  it("does the same when it takes the model to see that this is what the sender means", async () => {
    mockAnswerFromPages.mockResolvedValue({
      category: "missing_link",
      answer: null,
      reason: "對方說已追蹤但沒收到連結",
    });
    const outcome = await send("已追蹤可是沒有收到連結");

    expect(outcome?.category).toBe("missing_link");
    expect(mockQueueAdd).toHaveBeenCalledWith(...RESEND_JOB);
    expect(logged()).toMatchObject({ action: "REPLIED", reason: "對方說已追蹤但沒收到連結" });
  });

  it("hands the second 'I never got it' of the day to the owner: the re-send did not help", async () => {
    mockState.claimResend.mockResolvedValue(false);
    mockDraftReply.mockResolvedValue("不好意思～連結在這裡：https://example.com/page");
    const outcome = await send("還是沒收到");

    expect(outcome).toMatchObject({ category: "missing_link", action: "ESCALATED" });
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    expect(logged().reason).toBe("今天已經重傳過一次，對方還是說沒收到");
    // With a draft the owner can send as it is.
    expect(mockNotifyOwner.mock.calls[0][0].draft).toMatchObject({
      text: "不好意思～連結在這裡：https://example.com/page",
    });
  });

  it("re-sends the newest campaign that is still running", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      { ...PRIOR_LOG, automation: { ...PRIOR_LOG.automation, id: "auto_off", isActive: false } },
      { ...PRIOR_LOG, automation: { ...PRIOR_LOG.automation, id: "auto_older" } },
    ]);
    await send("沒收到");
    expect(mockQueueAdd.mock.calls[0][1]).toMatchObject({ payload: "followcheck:auto_older" });
  });

  it("hands the message to the owner when no campaign of theirs is running any more", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      { ...PRIOR_LOG, automation: { ...PRIOR_LOG.automation, isActive: false } },
    ]);
    const outcome = await send("沒收到");

    expect(outcome?.action).toBe("ESCALATED");
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockState.claimResend).not.toHaveBeenCalled();
    expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
  });

  it("hands the message to the owner when the re-send cannot be queued", async () => {
    mockQueueAdd.mockRejectedValue(new Error("redis down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await send("沒收到");
    errorSpy.mockRestore();

    expect(outcome?.action).toBe("ESCALATED");
    expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
  });

  it("works in fixed-replies-only mode: it needs no model", async () => {
    setMode("canned");
    expect((await send("沒收到"))?.action).toBe("REPLIED");
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it("only records what it would do in a dry run, and does not use up the day's re-send", async () => {
    setMode("dry_run");
    const outcome = await send("沒收到");

    expect(outcome).toMatchObject({ action: "DRY_RUN", replyText: "〔重傳連結〕" });
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockState.claimResend).not.toHaveBeenCalled();
  });

  it("tells the owner instead when the day's replies to this person are used up", async () => {
    alreadySent({ replies: 6 });
    const outcome = await send("沒收到");

    expect(outcome?.action).toBe("SKIPPED_CAP");
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
  });

  it("stays out, but tells the owner, when the owner is in the conversation", async () => {
    mockState.ownerRepliedRecently.mockResolvedValue(true);
    const outcome = await send("沒收到");

    expect(outcome).toMatchObject({ category: "missing_link", action: "SKIPPED_OWNER_ACTIVE" });
    expect(mockQueueAdd).not.toHaveBeenCalled();
    // Not a pleasantry: it must not be passed over in silence.
    expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
  });

  it("is not held back by a question that is waiting for the owner", async () => {
    alreadySent({ waitingOnOwner: 1 });
    expect((await send("沒收到"))?.action).toBe("REPLIED");
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });
});

describe("runTriage — the quota tutorial", () => {
  const offerStanding = () => mockState.getOffered.mockResolvedValue("quota");

  /** The tutorial page is on file and a running campaign sends it. */
  function tutorialAvailable() {
    mockPrisma.triagePage.findFirst.mockResolvedValue({ url: "https://example.com/quota" });
    mockPrisma.automation.findFirst.mockResolvedValue({ id: "auto_quota" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setMode("full");
    alreadySent();
    mockPrisma.triageLog.create.mockResolvedValue({ id: "log_1", createdAt: CLAIMED_AT });
    mockPrisma.triageLog.update.mockResolvedValue({});
    mockPrisma.triageLog.findMany.mockResolvedValue([]);
    mockPrisma.dmLog.findMany.mockResolvedValue([PRIOR_LOG]);
    mockPrisma.triagePage.findMany.mockResolvedValue([
      { key: "K36", title: "三個音效外掛", content: "安裝步驟…", url: "https://example.com/page", keywords: [] },
    ]);
    mockPrisma.triagePage.findFirst.mockResolvedValue(null);
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    mockQueueAdd.mockResolvedValue({});
    mockDraftReply.mockResolvedValue(null);
    mockDropPendingDrafts.mockResolvedValue(0);
    mockState.ownerRepliedRecently.mockResolvedValue(false);
    mockState.handedOffRecently.mockResolvedValue(false);
    mockState.wasAskedHuman.mockResolvedValue(false);
    mockState.markBotActivity.mockResolvedValue(undefined);
    mockState.getOffered.mockResolvedValue(null);
    mockState.markOffered.mockResolvedValue(undefined);
    mockState.clearOffered.mockResolvedValue(undefined);
    mockNotifyOwner.mockResolvedValue(true);
    mockIsAiConfigured.mockReturnValue(true);
    mockAnswerFromPages.mockResolvedValue({
      category: "quota",
      answer: null,
      reason: "對方說額度很快用完",
    });
    mockSendDirectMessage.mockResolvedValue({ recipient_id: "user_1", message_id: "m" });
  });

  describe("the offer", () => {
    it("offers the tutorial, in the owner's words, and waits for a yes", async () => {
      tutorialAvailable();
      const outcome = await send("最近 token 一下就用完");

      expect(outcome).toMatchObject({ category: "quota", action: "REPLIED" });
      expect(sent()).toEqual([QUOTA_OFFER]);
      expect(mockState.markOffered).toHaveBeenCalledWith("ig_1", "user_1", "quota");
      // The link itself is not sent yet.
      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("looks for the tutorial page by its key, and for a running campaign that sends it", async () => {
      tutorialAvailable();
      await send("最近 token 一下就用完");

      expect(mockPrisma.triagePage.findFirst.mock.calls[0][0].where).toEqual({
        instagramAccountId: "acct_row",
        key: "K27_CLAUDE.md省額度",
      });
      expect(mockPrisma.automation.findFirst.mock.calls[0][0].where).toEqual({
        isActive: true,
        instagramAccountId: "acct_row",
        trackedLinks: { some: { destinationUrl: "https://example.com/quota" } },
      });
    });

    it("hands the message to the owner when there is no tutorial to offer", async () => {
      const outcome = await send("最近 token 一下就用完");

      expect(outcome).toMatchObject({ category: "quota", action: "ESCALATED" });
      expect(sent()).toEqual([]);
      expect(mockState.markOffered).not.toHaveBeenCalled();
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });

    it("hands the message to the owner when the tutorial's campaign is switched off", async () => {
      mockPrisma.triagePage.findFirst.mockResolvedValue({ url: "https://example.com/quota" });
      const outcome = await send("最近 token 一下就用完");
      expect(outcome?.action).toBe("ESCALATED");
      expect(sent()).toEqual([]);
    });

    it("does not offer the tutorial to someone who already holds it", async () => {
      tutorialAvailable();
      mockPrisma.triagePage.findMany.mockResolvedValue([
        { key: "K27_CLAUDE.md省額度", title: "省額度", content: "…", url: "https://example.com/quota", keywords: [] },
      ]);
      const outcome = await send("照做了額度還是很快用完");

      expect(outcome?.action).toBe("ESCALATED");
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });

    it("makes the offer once: asked again, the owner hears about it", async () => {
      tutorialAvailable();
      alreadySent({ replies: 1, lines: [QUOTA_OFFER] });
      const outcome = await send("額度真的不夠用");

      expect(outcome?.action).toBe("ESCALATED");
      expect(sent()).toEqual([]);
      expect(mockState.markOffered).not.toHaveBeenCalled();
    });

    it("does not leave the offer open when the offer was not actually sent", async () => {
      tutorialAvailable();
      setMode("dry_run");
      const outcome = await send("最近 token 一下就用完");
      expect(outcome?.action).toBe("DRY_RUN");
      expect(mockState.markOffered).not.toHaveBeenCalled();
    });
  });

  describe("the answer to it", () => {
    it.each(["要", "好啊", "好的 謝謝", "可以", "傳給我", "我要", "麻煩了"])(
      "sends the tutorial's campaign when the sender says %s",
      async (messageText) => {
        offerStanding();
        tutorialAvailable();
        const outcome = await send(messageText);

        expect(outcome).toEqual({
          category: "quota",
          action: "REPLIED",
          replyText: "〔傳省額度教學〕",
        });
        expect(mockQueueAdd).toHaveBeenCalledWith(
          "process-postback",
          {
            instagramAccountId: "ig_1",
            userId: "user_1",
            payload: "followcheck:auto_quota",
            strictFollow: true,
          },
          { jobId: "triage_send_auto_quota_log_1" }
        );
        expect(mockState.clearOffered).toHaveBeenCalledWith("ig_1", "user_1");
        // The yes is not also answered with a sign-off line.
        expect(sent()).toEqual([]);
        expect(mockAnswerFromPages).not.toHaveBeenCalled();
      }
    );

    it("closes the offer on a no, and answers the no like any other message", async () => {
      offerStanding();
      tutorialAvailable();
      mockAnswerFromPages.mockResolvedValue({ category: "no_question", answer: null, reason: "不用" });
      await send("不用了");

      expect(mockState.clearOffered).toHaveBeenCalledWith("ig_1", "user_1");
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("keeps the offer open through a message that is neither a yes nor a no", async () => {
      offerStanding();
      tutorialAvailable();
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "照第一步做。",
        reason: "頁面第一步",
      });
      await send("先問一下這個要怎麼裝");

      expect(mockState.clearOffered).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(sent()).toEqual(["照第一步做。"]);
    });

    it.each(["不想要", "先不要給我", "不用傳給我", "我不要", "沒有想要"])(
      "does not read %s as a yes: the same words with a not in them mean the opposite",
      async (messageText) => {
        offerStanding();
        tutorialAvailable();
        mockAnswerFromPages.mockResolvedValue({ category: "no_question", answer: null, reason: "不要" });
        await send(messageText);
        expect(mockQueueAdd).not.toHaveBeenCalled();
      }
    );

    it("does not read a question as a yes", async () => {
      offerStanding();
      tutorialAvailable();
      await send("可以給我嗎？是免費的嗎");
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("hands the yes to the owner if the campaign has been switched off meanwhile", async () => {
      offerStanding();
      const outcome = await send("要");

      expect(outcome?.action).toBe("ESCALATED");
      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(logged().reason).toBe("找不到可以重傳的活動");
    });

    it("sends nothing in a dry run", async () => {
      offerStanding();
      tutorialAvailable();
      setMode("dry_run");
      const outcome = await send("要");
      expect(outcome).toMatchObject({ action: "DRY_RUN", replyText: "〔傳省額度教學〕" });
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("means nothing when no offer is standing: a bare 要 is just an acknowledgement", async () => {
      tutorialAvailable();
      mockAnswerFromPages.mockResolvedValue({ category: "other", answer: null, reason: "x" });
      await send("要");
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });
});

describe("claimTriage and resumeTriage — answering after a wait", () => {
  const ROW = {
    id: "log_2",
    action: "PENDING",
    senderId: "user_1",
    messageText: "謝謝",
    createdAt: new Date("2026-11-25T03:00:20Z"),
    instagramAccountId: "acct_row",
    instagramAccount: { instagramId: "ig_1" },
  };

  /** What is still waiting from this person, oldest first; the claimed row is last. */
  function waiting(...earlier: { id: string; messageText: string }[]) {
    mockPrisma.triageLog.findUnique.mockResolvedValue(ROW);
    mockPrisma.triageLog.findMany.mockImplementation(
      async ({ where }: { where: { action?: string } }) =>
        where.action === "PENDING" ? [...earlier, { id: ROW.id, messageText: ROW.messageText }] : []
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setMode("full");
    alreadySent();
    mockPrisma.triageLog.create.mockResolvedValue({ id: "log_2", createdAt: ROW.createdAt });
    mockPrisma.triageLog.update.mockResolvedValue({});
    mockPrisma.triageLog.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.triageLog.findMany.mockResolvedValue([]);
    mockPrisma.triageLog.findUnique.mockResolvedValue(null);
    mockPrisma.dmLog.findMany.mockResolvedValue([PRIOR_LOG]);
    mockPrisma.triagePage.findMany.mockResolvedValue([]);
    mockQueueAdd.mockResolvedValue({});
    mockDraftReply.mockResolvedValue(null);
    mockDropPendingDrafts.mockResolvedValue(0);
    mockState.ownerRepliedRecently.mockResolvedValue(false);
    mockState.handedOffRecently.mockResolvedValue(false);
    mockState.wasAskedHuman.mockResolvedValue(false);
    mockState.markBotActivity.mockResolvedValue(undefined);
    mockState.getOffered.mockResolvedValue(null);
    mockNotifyOwner.mockResolvedValue(true);
    mockIsAiConfigured.mockReturnValue(true);
    mockAnswerFromPages.mockResolvedValue({ category: "other", answer: null, reason: "x" });
    mockSendDirectMessage.mockResolvedValue({ recipient_id: "user_1", message_id: "m" });
  });

  describe("claiming", () => {
    it("writes the pending row and decides nothing yet", async () => {
      expect(await claimTriage(INPUT)).toEqual({ logId: "log_2" });

      expect(claimed()).toMatchObject({ messageId: "mid_1", messageText: "沒有問題", action: "PENDING" });
      expect(mockPrisma.triageLog.update).not.toHaveBeenCalled();
      expect(sent()).toEqual([]);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
    });

    it.each([
      ["triage is off", () => setMode("off")],
      ["the sender was never sent a campaign", () => mockPrisma.dmLog.findMany.mockResolvedValue([])],
      [
        "the message was already claimed",
        () =>
          mockPrisma.triageLog.create.mockRejectedValue(
            Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
          ),
      ],
    ])("claims nothing when %s", async (_why, arrange) => {
      arrange();
      expect(await claimTriage(INPUT)).toBeNull();
      expect(sent()).toEqual([]);
    });

    it("claims nothing for a reply to a Story, without even looking the account up", async () => {
      expect(await claimTriage({ ...INPUT, isStoryReply: true })).toBeNull();
      expect(mockPrisma.instagramAccount.findUnique).not.toHaveBeenCalled();
    });

    it("never throws", async () => {
      mockPrisma.instagramAccount.findUnique.mockRejectedValue(new Error("db down"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(claimTriage(INPUT)).resolves.toBeNull();
      errorSpy.mockRestore();
    });
  });

  describe("coming back to it", () => {
    it("handles the message exactly as it would have at once", async () => {
      waiting();
      const outcome = await resumeTriage("log_2");

      expect(outcome).toMatchObject({ category: "thanks", action: "REPLIED" });
      expect(sent()).toEqual([THANKS]);
      expect(mockPrisma.triageLog.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "log_2" } })
      );
      // The row was claimed before the wait: nothing is claimed again.
      expect(mockPrisma.triageLog.create).not.toHaveBeenCalled();
    });

    it("reads the mode and the owner's presence when the wait is over, not when it began", async () => {
      waiting();
      mockState.ownerRepliedRecently.mockResolvedValue(true);
      const outcome = await resumeTriage("log_2");

      expect(outcome?.action).toBe("SKIPPED_OWNER_ACTIVE");
      expect(sent()).toEqual([]);
    });

    it("does nothing for a row that is no longer waiting", async () => {
      mockPrisma.triageLog.findUnique.mockResolvedValue({ ...ROW, action: "MERGED" });
      expect(await resumeTriage("log_2")).toBeNull();
      expect(sent()).toEqual([]);
      expect(mockPrisma.triageLog.update).not.toHaveBeenCalled();
    });

    it("does nothing for a row that does not exist", async () => {
      expect(await resumeTriage("nope")).toBeNull();
      expect(sent()).toEqual([]);
    });

    it("sends nothing and says why when triage was switched off during the wait", async () => {
      waiting({ id: "log_1", messageText: "好的" });
      setMode("off");
      expect(await resumeTriage("log_2")).toBeNull();

      expect(sent()).toEqual([]);
      expect(mockPrisma.triageLog.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["log_1", "log_2"] }, action: "PENDING" },
        data: { category: "other", action: "IGNORED", reason: "處理之前自動分流被關掉了" },
      });
    });

    it("never throws", async () => {
      mockPrisma.triageLog.findUnique.mockRejectedValue(new Error("db down"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(resumeTriage("log_2")).resolves.toBeNull();
      errorSpy.mockRestore();
    });
  });

  describe("several messages in a row", () => {
    it("leaves a message alone when the sender has written again since: the later turn answers both", async () => {
      mockPrisma.triageLog.findUnique.mockResolvedValue(ROW);
      mockPrisma.triageLog.findMany.mockResolvedValue([
        { id: "log_2", messageText: "謝謝" },
        { id: "log_3", messageText: "對了想問一下" },
      ]);
      expect(await resumeTriage("log_2")).toBeNull();

      expect(sent()).toEqual([]);
      expect(mockPrisma.triageLog.update).not.toHaveBeenCalled();
      expect(mockPrisma.triageLog.updateMany).not.toHaveBeenCalled();
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("answers them together, once, from the turn of the last one", async () => {
      waiting({ id: "log_1", messageText: "好的" });
      const outcome = await resumeTriage("log_2");

      // "好的" + "謝謝" is one thank-you, not a sign-off line and then a thanks line.
      expect(outcome).toMatchObject({ category: "thanks", action: "REPLIED" });
      expect(sent()).toEqual([THANKS]);
      expect(mockPrisma.triageLog.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["log_1"] }, action: "PENDING" },
        data: { category: "merged", action: "MERGED", reason: "對方接著又傳了新的，跟下一則一起回" },
      });
    });

    it("gives the model the whole of what was said, a line each", async () => {
      mockPrisma.triageLog.findUnique.mockResolvedValue({ ...ROW, messageText: "600多那個" });
      mockPrisma.triageLog.findMany.mockImplementation(
        async ({ where }: { where: { action?: string } }) =>
          where.action === "PENDING"
            ? [
                { id: "log_1", messageText: "claud用到pro夠嗎" },
                { id: "log_2", messageText: "600多那個" },
              ]
            : []
      );
      await resumeTriage("log_2");

      expect(mockAnswerFromPages.mock.calls[0][0]).toBe("claud用到pro夠嗎\n600多那個");
      // Its own parts are not also shown to it as "earlier turns".
      const history = mockPrisma.triageLog.findMany.mock.calls
        .map((call) => call[0].where as { id?: unknown })
        .find((where: { id?: unknown }) => where.id !== undefined);
      expect(history).toMatchObject({ id: { notIn: ["log_2", "log_1"] } });
    });

    it("shows the owner all of it in one line of the notice", async () => {
      mockPrisma.triageLog.findUnique.mockResolvedValue({ ...ROW, messageText: "多少錢" });
      mockPrisma.triageLog.findMany.mockImplementation(
        async ({ where }: { where: { action?: string } }) =>
          where.action === "PENDING"
            ? [
                { id: "log_1", messageText: "想找你合作" },
                { id: "log_2", messageText: "多少錢" },
              ]
            : []
      );
      await resumeTriage("log_2");

      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      expect(mockNotifyOwner.mock.calls[0][0].messageText).toBe("想找你合作 ／ 多少錢");
    });

    it("only gathers what this person sent in the last few minutes and has not been handled", async () => {
      waiting();
      await resumeTriage("log_2");

      const { where, orderBy } = mockPrisma.triageLog.findMany.mock.calls[0][0];
      expect(where).toMatchObject({
        instagramAccountId: "acct_row",
        senderId: "user_1",
        action: "PENDING",
      });
      expect(ROW.createdAt.getTime() - where.createdAt.gte.getTime()).toBe(5 * 60 * 1000);
      expect(orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    });

    describe("with the other account's away message among them", () => {
      const AWAY = "謝謝你傳送訊息給我們。我們將盡快與你聯絡。";
      const at = (seconds: number) => new Date(ROW.createdAt.getTime() + seconds * 1000);
      const pending = (...rows: { id: string; messageText: string; createdAt: Date }[]) =>
        mockPrisma.triageLog.findMany.mockImplementation(
          async ({ where }: { where: { action?: string } }) => (where.action === "PENDING" ? rows : [])
        );

      it("sets the away message aside and answers what the person typed", async () => {
        mockPrisma.triageLog.findUnique.mockResolvedValue({ ...ROW, messageText: AWAY });
        pending(
          { id: "log_1", messageText: "謝謝", createdAt: at(-8) },
          { id: "log_2", messageText: AWAY, createdAt: at(0) }
        );
        const outcome = await resumeTriage("log_2");

        expect(outcome).toMatchObject({ category: "thanks", action: "REPLIED" });
        expect(sent()).toEqual([THANKS]);
        expect(mockPrisma.triageLog.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ["log_2"] }, action: "PENDING" },
          data: { category: "auto_reply", action: "IGNORED", reason: "對方帳號的自動回覆，不用處理" },
        });
        // The decision is written on the message it is about.
        expect(mockPrisma.triageLog.update).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: "log_1" } })
        );
      });

      it("does not let it join two typed messages into something nobody wrote", async () => {
        mockPrisma.triageLog.findUnique.mockResolvedValue({ ...ROW, messageText: "多少錢" });
        pending(
          { id: "log_0", messageText: "想找你合作", createdAt: at(-15) },
          { id: "log_1", messageText: AWAY, createdAt: at(-9) },
          { id: "log_2", messageText: "多少錢", createdAt: at(0) }
        );
        await resumeTriage("log_2");

        expect(mockAnswerFromPages.mock.calls[0][0]).toBe("想找你合作\n多少錢");
        expect(mockNotifyOwner.mock.calls[0][0].messageText).toBe("想找你合作 ／ 多少錢");
      });

      it("answers nothing, and tells nobody, when away messages are all there is", async () => {
        mockPrisma.triageLog.findUnique.mockResolvedValue({ ...ROW, messageText: AWAY });
        pending({ id: "log_2", messageText: AWAY, createdAt: at(0) });
        const outcome = await resumeTriage("log_2");

        expect(outcome).toEqual({ category: "auto_reply", action: "IGNORED", replyText: null });
        expect(sent()).toEqual([]);
        expect(mockNotifyOwner).not.toHaveBeenCalled();
        expect(mockAnswerFromPages).not.toHaveBeenCalled();
      });
    });

    it("does not count the merged parts as a question waiting for the owner", async () => {
      waiting({ id: "log_1", messageText: "好的" });
      await resumeTriage("log_2");
      const where = mockPrisma.triageLog.count.mock.calls
        .map((call) => call[0].where as CountWhere & Record<string, unknown>)
        .find((w: CountWhere) => w.action === "ESCALATED");
      expect(where).toMatchObject({ id: { notIn: ["log_2", "log_1"] } });
    });
  });
});
