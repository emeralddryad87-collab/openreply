import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCheckClaude, mockSendOwnerAlert, mockClaimAiAlert } = vi.hoisted(() => ({
  mockCheckClaude: vi.fn(),
  mockSendOwnerAlert: vi.fn(),
  mockClaimAiAlert: vi.fn(),
}));

vi.mock("@/lib/triage/claude", () => ({ checkClaude: mockCheckClaude }));
vi.mock("@/lib/triage/notify", () => ({ sendOwnerAlert: mockSendOwnerAlert }));
vi.mock("@/lib/triage/state", () => ({ claimAiAlert: mockClaimAiAlert }));

import { checkAiConnection, resetAiCheck } from "@/lib/triage/ai-check";

const MINUTE = 60_000;

function useClaude(key = "sk-ant-right", model = "") {
  vi.stubEnv("ANTHROPIC_API_KEY", key);
  vi.stubEnv("TRIAGE_CLAUDE_MODEL", model);
}

describe("checkAiConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAiCheck();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T16:00:00Z"));
    for (const name of ["ANTHROPIC_API_KEY", "TRIAGE_CLAUDE_MODEL", "GROQ_API_KEY", "TRIAGE_AI_MODEL", "GROQ_MODEL"]) {
      vi.stubEnv(name, "");
    }
    mockCheckClaude.mockResolvedValue("ok");
    mockClaimAiAlert.mockResolvedValue(true);
    mockSendOwnerAlert.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("says so when no model is set, and asks nobody", async () => {
    expect(await checkAiConnection()).toBe("unconfigured");
    expect(mockCheckClaude).not.toHaveBeenCalled();
  });

  it("does not check Groq, which has no check", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_x");
    vi.stubEnv("TRIAGE_AI_MODEL", "some/model");
    expect(await checkAiConnection()).toBe("unchecked");
    expect(mockCheckClaude).not.toHaveBeenCalled();
  });

  it("asks Claude about the key and the model that are actually in use", async () => {
    useClaude("sk-ant-right", "claude-haiku-5-5");
    expect(await checkAiConnection()).toBe("ok");
    expect(mockCheckClaude).toHaveBeenCalledWith("sk-ant-right", "claude-haiku-5-5");
  });

  it("asks about the default model when none is named", async () => {
    useClaude();
    await checkAiConnection();
    expect(mockCheckClaude).toHaveBeenCalledWith("sk-ant-right", "claude-opus-5-5");
  });

  it("does not ask again on every heartbeat while things are fine", async () => {
    useClaude();
    await checkAiConnection();
    vi.advanceTimersByTime(29 * MINUTE);
    expect(await checkAiConnection()).toBe("ok");
    expect(mockCheckClaude).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * MINUTE);
    await checkAiConnection();
    expect(mockCheckClaude).toHaveBeenCalledTimes(2);
  });

  it("looks again soon while the key is refused, so a corrected key shows quickly", async () => {
    useClaude("*".repeat(60));
    mockCheckClaude.mockResolvedValue("bad_key");
    expect(await checkAiConnection()).toBe("bad_key");

    vi.advanceTimersByTime(1 * MINUTE);
    expect(await checkAiConnection()).toBe("bad_key");
    expect(mockCheckClaude).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(90_000);
    mockCheckClaude.mockResolvedValue("ok");
    expect(await checkAiConnection()).toBe("ok");
    expect(mockCheckClaude).toHaveBeenCalledTimes(2);
  });

  it("asks at once when the key or the model is changed", async () => {
    useClaude("sk-ant-first");
    await checkAiConnection();
    useClaude("sk-ant-second");
    await checkAiConnection();
    useClaude("sk-ant-second", "claude-sonnet-5-5");
    await checkAiConnection();
    expect(mockCheckClaude).toHaveBeenCalledTimes(3);
  });

  describe("telling the owner", () => {
    it("tells them once, in plain words, when the key is refused", async () => {
      useClaude("*".repeat(60));
      mockCheckClaude.mockResolvedValue("bad_key");
      await checkAiConnection();

      expect(mockSendOwnerAlert).toHaveBeenCalledTimes(1);
      const text = mockSendOwnerAlert.mock.calls[0][0] as string;
      expect(text).toContain("ANTHROPIC_API_KEY");
      expect(text).toContain("金鑰無效");
      expect(text).toContain("不會有草稿");
      // Never the key itself.
      expect(text).not.toContain("*".repeat(10));
    });

    it("tells them when the model name is not one Claude knows", async () => {
      useClaude("sk-ant-right", "claude-opus-55");
      mockCheckClaude.mockResolvedValue("bad_model");
      await checkAiConnection();

      expect(mockSendOwnerAlert.mock.calls[0][0]).toContain("TRIAGE_CLAUDE_MODEL");
    });

    it("does not repeat itself on the heartbeats that follow", async () => {
      useClaude("wrong");
      mockCheckClaude.mockResolvedValue("bad_key");
      for (let i = 0; i < 5; i++) {
        await checkAiConnection();
        vi.advanceTimersByTime(3 * MINUTE);
      }
      expect(mockCheckClaude.mock.calls.length).toBeGreaterThan(1);
      expect(mockSendOwnerAlert).toHaveBeenCalledTimes(1);
    });

    it("does not tell them again after a restart if they were told recently", async () => {
      useClaude("wrong");
      mockCheckClaude.mockResolvedValue("bad_key");
      mockClaimAiAlert.mockResolvedValue(false);
      await checkAiConnection();
      expect(mockSendOwnerAlert).not.toHaveBeenCalled();
    });

    it("claims the message for this particular setting, without naming the key", async () => {
      useClaude("sk-ant-secret-value");
      mockCheckClaude.mockResolvedValue("bad_key");
      await checkAiConnection();

      const what = mockClaimAiAlert.mock.calls[0][0] as string;
      expect(what).toMatch(/^bad_key:[0-9a-f]{16}$/);
      expect(what).not.toContain("secret");
    });

    it("says nothing when it merely could not reach Anthropic", async () => {
      useClaude();
      mockCheckClaude.mockResolvedValue("failed");
      expect(await checkAiConnection()).toBe("failed");
      expect(mockSendOwnerAlert).not.toHaveBeenCalled();
    });

    it("says nothing when all is well", async () => {
      useClaude();
      await checkAiConnection();
      expect(mockSendOwnerAlert).not.toHaveBeenCalled();
      expect(mockClaimAiAlert).not.toHaveBeenCalled();
    });
  });

  describe("never getting in the worker's way", () => {
    it("reports a failed check instead of throwing", async () => {
      useClaude();
      mockCheckClaude.mockRejectedValue(new Error("boom"));
      await expect(checkAiConnection()).resolves.toBe("failed");
    });

    it("still reports the refusal when the owner cannot be told", async () => {
      useClaude("wrong");
      mockCheckClaude.mockResolvedValue("bad_key");
      mockClaimAiAlert.mockRejectedValue(new Error("redis down"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(checkAiConnection()).resolves.toBe("bad_key");
      errorSpy.mockRestore();
    });
  });
});
