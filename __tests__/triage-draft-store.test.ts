import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { triageLog: { updateMany: vi.fn() } },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { dropPendingDrafts } from "@/lib/triage/draft-store";

describe("dropPendingDrafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.triageLog.updateMany.mockResolvedValue({ count: 2 });
  });

  const call = () => mockPrisma.triageLog.updateMany.mock.calls[0][0];

  it("clears the text of this person's waiting drafts and says how many", async () => {
    expect(await dropPendingDrafts({ accountId: "acct_row", senderId: "user_1" })).toBe(2);
    expect(call()).toEqual({
      where: {
        instagramAccountId: "acct_row",
        senderId: "user_1",
        action: "ESCALATED",
        replyText: { not: null },
      },
      data: { replyText: null },
    });
  });

  it("only ever touches rows that are drafts: handed to the owner, with a text", async () => {
    await dropPendingDrafts({ accountId: "acct_row", senderId: "user_1" });
    // What was really sent (REPLIED, SENT_BY_OWNER) keeps its text.
    expect(call().where.action).toBe("ESCALATED");
    expect(call().data).toEqual({ replyText: null });
  });

  it("can leave the newest draft alone, dropping only those for earlier messages", async () => {
    const at = new Date("2026-11-25T03:00:00Z");
    await dropPendingDrafts({ accountId: "acct_row", senderId: "user_1" }, { olderThan: at });
    expect(call().where.createdAt).toEqual({ lt: at });
  });

  it("finds the account by its Instagram id when that is all the caller has", async () => {
    await dropPendingDrafts({ instagramId: "ig_1", senderId: "user_1" });
    expect(call().where).toEqual({
      instagramAccount: { instagramId: "ig_1" },
      senderId: "user_1",
      action: "ESCALATED",
      replyText: { not: null },
    });
  });
});
