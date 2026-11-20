import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockContext, mockCapabilities, mockLastOwnerReply } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    triageSetting: { upsert: vi.fn() },
    triageLog: { groupBy: vi.fn(), findMany: vi.fn() },
  },
  mockContext: vi.fn(),
  mockCapabilities: vi.fn(),
  mockLastOwnerReply: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));
vi.mock("@/lib/triage/state", () => ({
  getWorkerCapabilities: mockCapabilities,
  getLastOwnerReplyAt: mockLastOwnerReply,
}));

import { GET, PATCH } from "../app/api/triage/route";
import { parseTriageMode } from "@/lib/triage/config";
import {
  clearTriageModeCache,
  getTriageModeFor,
  setTriageMode,
} from "@/lib/triage/settings";

function patch(body: unknown) {
  return PATCH(
    new Request("https://example.com/api/triage", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as Parameters<typeof PATCH>[0]
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTriageModeCache();
  mockContext.mockResolvedValue({ workspaceId: "ws_1", role: "OWNER" });
  mockPrisma.triageSetting.upsert.mockResolvedValue({});
});

describe("parseTriageMode", () => {
  it("accepts the four modes and nothing else", () => {
    expect(["off", "dry_run", "canned", "full"].map(parseTriageMode)).toEqual([
      "off",
      "dry_run",
      "canned",
      "full",
    ]);
    for (const bad of ["FULL", "on", "", null, undefined, 1, {}]) {
      expect(parseTriageMode(bad)).toBe("off");
    }
  });
});

describe("getTriageModeFor", () => {
  it("reads the stored mode by Instagram id", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      triageSetting: { mode: "canned" },
    });
    expect(await getTriageModeFor("ig_1")).toBe("canned");
    expect(mockPrisma.instagramAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { instagramId: "ig_1" } })
    );
  });

  it("is off when the account has no setting or does not exist", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValueOnce({ triageSetting: null });
    expect(await getTriageModeFor("ig_a")).toBe("off");
    mockPrisma.instagramAccount.findUnique.mockResolvedValueOnce(null);
    expect(await getTriageModeFor("ig_b")).toBe("off");
  });

  it("answers repeat lookups from memory", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      triageSetting: { mode: "full" },
    });
    await getTriageModeFor("ig_1");
    await getTriageModeFor("ig_1");
    expect(mockPrisma.instagramAccount.findUnique).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the mode is saved in this process", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      triageSetting: { mode: "full" },
    });
    await getTriageModeFor("ig_1");

    await setTriageMode({ id: "acct_row", instagramId: "ig_1" }, "off");
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      triageSetting: { mode: "off" },
    });

    expect(await getTriageModeFor("ig_1")).toBe("off");
    expect(mockPrisma.triageSetting.upsert).toHaveBeenCalledWith({
      where: { instagramAccountId: "acct_row" },
      create: { instagramAccountId: "acct_row", mode: "off" },
      update: { mode: "off" },
    });
  });
});

describe("PATCH /api/triage", () => {
  beforeEach(() => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({
      id: "acct_row",
      instagramId: "ig_1",
    });
  });

  it("saves the mode for an account in the caller's workspace", async () => {
    const response = await patch({ instagramAccountId: "acct_row", mode: "dry_run" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { mode: "dry_run" } });
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "acct_row", workspaceId: "ws_1" } })
    );
    expect(mockPrisma.triageSetting.upsert).toHaveBeenCalledTimes(1);
  });

  it("rejects a signed-out caller", async () => {
    mockContext.mockResolvedValue(null);
    expect((await patch({ instagramAccountId: "acct_row", mode: "full" })).status).toBe(401);
    expect(mockPrisma.triageSetting.upsert).not.toHaveBeenCalled();
  });

  it("rejects a plain member", async () => {
    mockContext.mockResolvedValue({ workspaceId: "ws_1", role: "MEMBER" });
    expect((await patch({ instagramAccountId: "acct_row", mode: "full" })).status).toBe(403);
    expect(mockPrisma.triageSetting.upsert).not.toHaveBeenCalled();
  });

  it("rejects an account from another workspace", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);
    expect((await patch({ instagramAccountId: "other", mode: "full" })).status).toBe(404);
    expect(mockPrisma.triageSetting.upsert).not.toHaveBeenCalled();
  });

  it.each([
    { instagramAccountId: "acct_row", mode: "on" },
    { instagramAccountId: "acct_row" },
    { mode: "full" },
    "not json",
  ])("rejects a malformed body %#", async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(mockPrisma.triageSetting.upsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/triage", () => {
  beforeEach(() => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      {
        id: "acct_row",
        instagramId: "ig_1",
        username: "creator",
        triageSetting: { mode: "dry_run" },
        _count: { triagePages: 52 },
      },
    ]);
    mockPrisma.triageLog.groupBy.mockResolvedValue([
      { action: "DRY_RUN", _count: { _all: 7 } },
      { action: "ESCALATED", _count: { _all: 2 } },
    ]);
    mockPrisma.triageLog.findMany.mockResolvedValue([
      {
        id: "log_1",
        createdAt: new Date("2026-11-20T10:00:00Z"),
        messageText: "沒有問題",
        category: "no_problem",
        action: "DRY_RUN",
        replyText: "有問題都可以來問我哦",
        reason: null,
      },
    ]);
    mockCapabilities.mockResolvedValue({ ai: true, notify: false, checkedAt: "now" });
    mockLastOwnerReply.mockResolvedValue("2026-11-20T09:30:00.000Z");
  });

  it("returns each account's mode, page count, tallies and recent decisions", async () => {
    const response = await GET();
    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.data.canManage).toBe(true);
    expect(payload.data.worker).toEqual({ ai: true, notify: false, checkedAt: "now" });
    expect(payload.data.accounts[0]).toMatchObject({
      id: "acct_row",
      username: "creator",
      mode: "dry_run",
      pageCount: 52,
      lastOwnerReplyAt: "2026-11-20T09:30:00.000Z",
      last24h: { DRY_RUN: 7, ESCALATED: 2 },
    });
    expect(mockLastOwnerReply).toHaveBeenCalledWith("ig_1");
    expect(payload.data.accounts[0].recent[0]).toMatchObject({
      messageText: "沒有問題",
      action: "DRY_RUN",
    });
    expect(mockPrisma.instagramAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws_1" } })
    );
  });

  it("still answers when the worker status cannot be read", async () => {
    mockCapabilities.mockRejectedValue(new Error("redis down"));
    mockLastOwnerReply.mockRejectedValue(new Error("redis down"));
    const payload = await (await GET()).json();
    expect(payload.success).toBe(true);
    expect(payload.data.worker).toBeNull();
    expect(payload.data.accounts[0].lastOwnerReplyAt).toBeNull();
  });

  it("does not hand the Instagram-side id or message history of other accounts to the page", async () => {
    const payload = await (await GET()).json();
    expect(payload.data.accounts[0]).not.toHaveProperty("instagramId");
    expect(mockPrisma.triageLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { instagramAccountId: "acct_row" } })
    );
  });

  it("tells a member they cannot change the switch", async () => {
    mockContext.mockResolvedValue({ workspaceId: "ws_1", role: "MEMBER" });
    expect((await (await GET()).json()).data.canManage).toBe(false);
  });

  it("rejects a signed-out caller", async () => {
    mockContext.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});
