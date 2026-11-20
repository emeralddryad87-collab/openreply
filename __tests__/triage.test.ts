import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPrisma,
  mockSendDirectMessage,
  mockOwnerRepliedRecently,
  mockClaimNotifySlot,
  mockMarkBotActivity,
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
  mockOwnerRepliedRecently: vi.fn(),
  mockClaimNotifySlot: vi.fn(),
  mockMarkBotActivity: vi.fn(),
  mockNotifyOwner: vi.fn(),
  mockAnswerFromPages: vi.fn(),
  mockIsAiConfigured: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({ sendDirectMessage: mockSendDirectMessage }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (t: string) => `plain:${t}` }));
vi.mock("@/lib/triage/state", () => ({
  ownerRepliedRecently: mockOwnerRepliedRecently,
  claimNotifySlot: mockClaimNotifySlot,
  markBotActivity: mockMarkBotActivity,
}));
vi.mock("@/lib/triage/notify", () => ({ notifyOwner: mockNotifyOwner }));
vi.mock("@/lib/triage/ai", () => ({
  answerFromPages: mockAnswerFromPages,
  isAiConfigured: mockIsAiConfigured,
}));

import { runTriage } from "@/lib/triage";

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

describe("runTriage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMode("full");
    mockPrisma.triageLog.count.mockResolvedValue(0);
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
    mockOwnerRepliedRecently.mockResolvedValue(false);
    mockClaimNotifySlot.mockResolvedValue(true);
    mockMarkBotActivity.mockResolvedValue(undefined);
    mockNotifyOwner.mockResolvedValue(true);
    mockIsAiConfigured.mockReturnValue(true);
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
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
    });

    it("is off for an account that has never touched the setting", async () => {
      setMode(null);
      expect(await runTriage(INPUT)).toBeNull();
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
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
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
    });

    it("never replies to, notifies about, or records someone who was not sent a campaign DM", async () => {
      mockPrisma.dmLog.findMany.mockResolvedValue([]);
      expect(await runTriage({ ...INPUT, messageText: "想找你合作" })).toBeNull();
      nothingWritten();
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
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
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      expect(mockPrisma.triageLog.update).not.toHaveBeenCalled();
    });

    it("sends nothing when the claim fails for any other reason", async () => {
      mockPrisma.triageLog.create.mockRejectedValue(new Error("db down"));
      await expect(runTriage(INPUT)).resolves.toBeNull();
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
    });

    it("keeps an over-long message out of the log in full", async () => {
      await runTriage({ ...INPUT, messageText: "字".repeat(5000) });
      expect(claimed().messageText.length).toBe(2000);
    });
  });

  describe("fixed replies", () => {
    it("answers 'no questions' with the fixed line", async () => {
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("REPLIED");
      expect(mockSendDirectMessage).toHaveBeenCalledWith(
        "plain:enc",
        "ig_1",
        "user_1",
        "有問題都可以來問我哦"
      );
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(logged()).toMatchObject({ category: "no_problem", action: "REPLIED" });
    });

    it("answers thanks with the fixed line", async () => {
      await runTriage({ ...INPUT, messageText: "謝謝你！" });
      expect(mockSendDirectMessage.mock.calls[0][3]).toBe("不用客氣~");
    });

    it("marks the conversation bot-active before it sends, so its own echo is not read as the owner", async () => {
      await runTriage(INPUT);
      expect(mockMarkBotActivity).toHaveBeenCalledWith("ig_1", "user_1");
      expect(mockMarkBotActivity.mock.invocationCallOrder[0]).toBeLessThan(
        mockSendDirectMessage.mock.invocationCallOrder[0]
      );
    });

    it("sends nothing in dry_run but logs what it would have sent", async () => {
      setMode("dry_run");
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("DRY_RUN");
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      expect(mockMarkBotActivity).not.toHaveBeenCalled();
      expect(claimed().mode).toBe("dry_run");
      expect(logged()).toMatchObject({
        action: "DRY_RUN",
        replyText: "有問題都可以來問我哦",
      });
    });

    it("ignores a bare acknowledgement without replying or notifying", async () => {
      const outcome = await runTriage({ ...INPUT, messageText: "好的" });
      expect(outcome).toMatchObject({ category: "ack", action: "IGNORED" });
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("logs a failed send instead of throwing", async () => {
      mockSendDirectMessage.mockRejectedValue(new Error("window closed"));
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("FAILED");
      expect(logged()).toMatchObject({ action: "FAILED", reason: "window closed" });
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
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
    });
  });

  describe("staying out of the way", () => {
    it("stays quiet when the owner replied by hand in the last 24h", async () => {
      mockOwnerRepliedRecently.mockResolvedValue(true);
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("SKIPPED_OWNER_ACTIVE");
      expect(mockOwnerRepliedRecently).toHaveBeenCalledWith("ig_1", "user_1");
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("does not answer a question while the owner is in the conversation, but still flags it", async () => {
      mockOwnerRepliedRecently.mockResolvedValue(true);
      const outcome = await runTriage({ ...INPUT, messageText: "這個音效要怎麼裝" });
      expect(outcome?.action).toBe("SKIPPED_OWNER_ACTIVE");
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      expect(mockNotifyOwner.mock.calls[0][0]).toMatchObject({
        senderName: "fan",
        messageText: "這個音效要怎麼裝",
      });
    });

    it("flags that follow-up at most once inside the cooldown", async () => {
      mockOwnerRepliedRecently.mockResolvedValue(true);
      mockClaimNotifySlot.mockResolvedValue(false);
      await runTriage({ ...INPUT, messageText: "這個音效要怎麼裝" });
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    it("stops at the daily cap", async () => {
      mockPrisma.triageLog.count.mockResolvedValue(3);
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("SKIPPED_CAP");
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      expect(mockPrisma.triageLog.count.mock.calls[0][0].where).toMatchObject({
        instagramAccountId: "acct_row",
        senderId: "user_1",
        action: "REPLIED",
      });
    });

    it("applies the cap in a dry run by counting its own would-be replies", async () => {
      setMode("dry_run");
      mockPrisma.triageLog.count.mockResolvedValue(3);
      const outcome = await runTriage(INPUT);
      expect(outcome?.action).toBe("SKIPPED_CAP");
      expect(mockPrisma.triageLog.count.mock.calls[0][0].where.action).toEqual({
        in: ["REPLIED", "DRY_RUN"],
      });
    });

    it("honours a changed daily cap", async () => {
      vi.stubEnv("TRIAGE_DAILY_REPLY_CAP", "1");
      mockPrisma.triageLog.count.mockResolvedValue(1);
      expect((await runTriage(INPUT))?.action).toBe("SKIPPED_CAP");
    });
  });

  describe("questions", () => {
    it("only looks at pages that belong to this account", async () => {
      mockAnswerFromPages.mockResolvedValue({ category: "other", answer: null, reason: "x" });
      await runTriage({ ...INPUT, messageText: "這個要怎麼裝" });
      expect(mockPrisma.triagePage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ instagramAccountId: "acct_row" }),
        })
      );
    });

    it("answers a page question from the page and labels it as automated", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "照第一步貼指令就會裝好。",
        reason: "頁面第一步",
      });
      const outcome = await runTriage({ ...INPUT, messageText: "這個音效要怎麼裝" });
      expect(outcome?.action).toBe("REPLIED");
      expect(mockSendDirectMessage.mock.calls[0][3]).toBe(
        "照第一步貼指令就會裝好。\n（自動回覆）"
      );
      expect(mockAnswerFromPages).toHaveBeenCalledWith("這個音效要怎麼裝", [
        { title: "三個音效外掛", content: "安裝步驟…" },
      ]);
      expect(logged()).toMatchObject({ category: "page_question", pageKey: "K36" });
    });

    it("shows the would-be answer in a dry run without sending it", async () => {
      setMode("dry_run");
      mockAnswerFromPages.mockResolvedValue({
        category: "page_question",
        answer: "照第一步貼指令就會裝好。",
        reason: "頁面第一步",
      });
      const outcome = await runTriage({ ...INPUT, messageText: "這個音效要怎麼裝" });
      expect(outcome?.action).toBe("DRY_RUN");
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      expect(logged().replyText).toBe("照第一步貼指令就會裝好。\n（自動回覆）");
    });

    it("escalates to the owner when the page has no answer", async () => {
      mockAnswerFromPages.mockResolvedValue({
        category: "other",
        answer: null,
        reason: "合作邀約",
      });
      const outcome = await runTriage({ ...INPUT, messageText: "想找你合作" });
      expect(outcome?.action).toBe("ESCALATED");
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      expect(mockNotifyOwner).toHaveBeenCalledWith(
        expect.objectContaining({
          senderId: "user_1",
          senderName: "fan",
          messageText: "想找你合作",
          reason: "合作邀約",
        })
      );
    });

    it("does not mark the conversation bot-active when it only escalates", async () => {
      mockAnswerFromPages.mockResolvedValue({ category: "other", answer: null, reason: "x" });
      await runTriage({ ...INPUT, messageText: "想找你合作" });
      expect(mockMarkBotActivity).not.toHaveBeenCalled();
    });

    it("escalates instead of failing when the model call throws", async () => {
      mockAnswerFromPages.mockRejectedValue(new Error("model down"));
      const outcome = await runTriage({ ...INPUT, messageText: "這個要怎麼裝" });
      expect(outcome?.action).toBe("ESCALATED");
      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      expect(logged().reason).toBe("model down");
    });

    it("escalates without calling the model when no model is configured", async () => {
      mockIsAiConfigured.mockReturnValue(false);
      const outcome = await runTriage({ ...INPUT, messageText: "這個音效要怎麼裝" });
      expect(outcome?.action).toBe("ESCALATED");
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(mockNotifyOwner).toHaveBeenCalled();
    });

    it("skips the model in canned mode and escalates real questions", async () => {
      setMode("canned");
      const outcome = await runTriage({ ...INPUT, messageText: "這個音效要怎麼裝" });
      expect(outcome?.action).toBe("ESCALATED");
      expect(mockAnswerFromPages).not.toHaveBeenCalled();
      expect(mockNotifyOwner).toHaveBeenCalled();
    });

    it("still tells the owner in a dry run", async () => {
      setMode("dry_run");
      mockAnswerFromPages.mockResolvedValue({ category: "other", answer: null, reason: "合作" });
      await runTriage({ ...INPUT, messageText: "想找你合作" });
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });

    it("notifies at most once per person inside the cooldown", async () => {
      mockAnswerFromPages.mockResolvedValue({ category: "other", answer: null, reason: "x" });
      mockClaimNotifySlot.mockResolvedValue(false);
      const outcome = await runTriage({ ...INPUT, messageText: "想找你合作" });
      expect(outcome?.action).toBe("ESCALATED");
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });
  });

  it("swallows unexpected errors so the job never retries", async () => {
    mockPrisma.instagramAccount.findUnique.mockRejectedValue(new Error("db down"));
    await expect(runTriage(INPUT)).resolves.toBeNull();
  });

  it("swallows a failure to write the decision, after the reply already went out", async () => {
    mockPrisma.triageLog.update.mockRejectedValue(new Error("db blip"));
    await expect(runTriage(INPUT)).resolves.toBeNull();
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });
});
