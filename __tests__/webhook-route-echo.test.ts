import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The webhook route's handling of an echo: a message the account itself sent.
 * When the owner typed it, a draft waiting for their decision is answered too.
 */

const { mockPrisma, mockParse, mockMode, mockRecordEcho, mockDropPendingDrafts } = vi.hoisted(
  () => ({
    mockPrisma: {
      operationalEvent: { create: vi.fn() },
      webhookEvent: { create: vi.fn(), update: vi.fn() },
      instagramAccount: { findUnique: vi.fn() },
      dmLog: { findMany: vi.fn() },
    },
    mockParse: { echoes: vi.fn() },
    mockMode: vi.fn(),
    mockRecordEcho: vi.fn(),
    mockDropPendingDrafts: vi.fn(),
  })
);

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/app/generated/prisma/client", () => ({ Prisma: {} }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: vi.fn() }),
  MESSAGE_JOB_NAME: "process-message",
  POSTBACK_JOB_NAME: "process-postback",
}));
vi.mock("@/lib/meta/webhook", () => ({
  verifyWebhookSignature: () => true,
  parseCommentEvents: () => [],
  parsePostbackEvents: () => [],
  parseEchoEvents: mockParse.echoes,
  parseMessageEvents: () => [],
  parseAttachmentEvents: () => [],
  parseReadEvents: () => [],
}));
vi.mock("@/lib/triage/settings", () => ({ getTriageModeFor: mockMode }));
vi.mock("@/lib/triage/state", () => ({ recordEcho: mockRecordEcho }));
vi.mock("@/lib/triage/draft-store", () => ({ dropPendingDrafts: mockDropPendingDrafts }));

import { POST } from "@/app/api/webhook/route";

const post = () =>
  POST(
    new NextRequest("http://localhost/api/webhook", {
      method: "POST",
      body: JSON.stringify({ object: "instagram", entry: [] }),
      headers: { "x-hub-signature-256": "sha256=test" },
    })
  );

describe("POST /api/webhook — an echo of the account's own message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.webhookEvent.create.mockResolvedValue({ id: "evt_1" });
    mockPrisma.webhookEvent.update.mockResolvedValue({});
    mockParse.echoes.mockReturnValue([{ instagramAccountId: "ig_1", userId: "user_1" }]);
    mockMode.mockResolvedValue("full");
    mockRecordEcho.mockResolvedValue(true);
    mockDropPendingDrafts.mockResolvedValue(1);
  });

  it("drops the draft that was waiting when the owner answers that person by hand", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(mockRecordEcho).toHaveBeenCalledWith("ig_1", "user_1");
    expect(mockDropPendingDrafts).toHaveBeenCalledTimes(1);
    expect(mockDropPendingDrafts).toHaveBeenCalledWith({ instagramId: "ig_1", senderId: "user_1" });
  });

  it("keeps the draft when the echo is of the bot's own message", async () => {
    mockRecordEcho.mockResolvedValue(false);
    expect((await post()).status).toBe(200);
    expect(mockDropPendingDrafts).not.toHaveBeenCalled();
  });

  it("looks at nothing while triage is off for the account", async () => {
    mockMode.mockResolvedValue("off");
    expect((await post()).status).toBe(200);
    expect(mockRecordEcho).not.toHaveBeenCalled();
    expect(mockDropPendingDrafts).not.toHaveBeenCalled();
  });

  it("still accepts the webhook when the draft cannot be dropped", async () => {
    mockDropPendingDrafts.mockRejectedValue(new Error("db blip"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post();
    errorSpy.mockRestore();
    expect(response.status).toBe(200);
    expect(mockPrisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PROCESSED" }) })
    );
  });
});
