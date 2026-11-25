import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreate, mockBetaCreate, mockConstructed } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockBetaCreate: vi.fn(),
  mockConstructed: vi.fn(),
}));

// The SDK itself is not under test: what is, is the request this app builds
// and what it makes of each kind of reply and failure. The stand-in keeps the
// SDK's own error classes apart, because the code tells failures apart by class.
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status: number | undefined;
    constructor(status?: number, message = "api error") {
      super(message);
      this.status = status;
      this.name = new.target.name;
    }
  }
  class BadRequestError extends APIError {
    constructor(message = "bad request") {
      super(400, message);
    }
  }
  class AuthenticationError extends APIError {
    constructor() {
      super(401, "invalid x-api-key sk-ant-secret");
    }
  }
  class PaymentRequiredError extends APIError {
    constructor() {
      super(402, "payment required");
    }
  }
  class RateLimitError extends APIError {
    constructor() {
      super(429, "rate limited");
    }
  }
  class InternalServerError extends APIError {
    constructor() {
      super(529, "overloaded");
    }
  }
  class APIConnectionError extends APIError {
    constructor(message = "Connection error.") {
      super(undefined, message);
    }
  }
  class APIConnectionTimeoutError extends APIConnectionError {
    constructor() {
      super("Request timed out.");
    }
  }

  class Anthropic {
    static APIError = APIError;
    static BadRequestError = BadRequestError;
    static AuthenticationError = AuthenticationError;
    static PaymentRequiredError = PaymentRequiredError;
    static RateLimitError = RateLimitError;
    static InternalServerError = InternalServerError;
    static APIConnectionError = APIConnectionError;
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    messages = { create: mockCreate };
    beta = { messages: { create: mockBetaCreate } };
    constructor(options: unknown) {
      mockConstructed(options);
    }
  }
  return { default: Anthropic };
});

import Anthropic from "@anthropic-ai/sdk";
import { askClaude, getClaudeUsage, resetClaudeUsage } from "@/lib/triage/claude";

// The stand-in's error classes take a message at most; the SDK's own take
// the whole HTTP response. Tests build the stand-in's.
const sdkError = Anthropic as unknown as Record<string, new (message?: string) => Error>;

const SCHEMA = {
  type: "object",
  properties: { category: { type: "string" } },
  required: ["category"],
  additionalProperties: false,
};

const reply = (text: string, extra: Record<string, unknown> = {}) => ({
  stop_reason: "end_turn",
  content: [
    // Thinking comes first and carries no visible text.
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text },
  ],
  usage: { input_tokens: 1200, output_tokens: 80 },
  ...extra,
});

const ask = (over: Partial<Parameters<typeof askClaude>[0]> = {}) =>
  askClaude({
    apiKey: "sk-ant-test",
    model: "claude-opus-5-5",
    system: "規則",
    user: "對方的訊息",
    schema: SCHEMA,
    ...over,
  });

describe("askClaude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClaudeUsage();
    mockCreate.mockResolvedValue(reply('{"category":"thanks"}'));
    mockBetaCreate.mockResolvedValue(reply('{"category":"thanks"}'));
  });

  describe("the request", () => {
    it("asks Opus with a low effort, the answer's shape, and a stand-in for declined requests", async () => {
      expect(await ask()).toBe('{"category":"thanks"}');

      expect(mockBetaCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockBetaCreate.mock.calls[0][0]).toEqual({
        model: "claude-opus-5-5",
        max_tokens: 4096,
        system: "規則",
        messages: [{ role: "user", content: "對方的訊息" }],
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    });

    it.each(["claude-sonnet-5-5", "claude-fable-5-2"])(
      "sends %s the same request",
      async (model) => {
        await ask({ model });
        expect(mockBetaCreate.mock.calls[0][0]).toMatchObject({ model, fallbacks: "default" });
      }
    );

    it("does not send Haiku the stand-in setting: Haiku has none and rejects a list of them", async () => {
      await ask({ model: "claude-haiku-5-5" });

      expect(mockBetaCreate).not.toHaveBeenCalled();
      const body = mockCreate.mock.calls[0][0];
      expect(body).toMatchObject({
        model: "claude-haiku-5-5",
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      });
      expect(body).not.toHaveProperty("fallbacks");
      expect(body).not.toHaveProperty("betas");
    });

    it("never sends sampling or thinking settings, which current models reject", async () => {
      await ask();
      await ask({ model: "claude-haiku-5-5" });
      for (const body of [mockBetaCreate.mock.calls[0][0], mockCreate.mock.calls[0][0]]) {
        for (const key of ["temperature", "top_p", "top_k", "thinking"]) {
          expect(body).not.toHaveProperty(key);
        }
      }
    });

    it("leaves the shape out when it is given none", async () => {
      await ask({ schema: undefined });
      expect(mockBetaCreate.mock.calls[0][0].output_config).toEqual({ effort: "low" });
    });

    it("talks to Anthropic and nowhere else, whatever the environment says", async () => {
      vi.stubEnv("ANTHROPIC_BASE_URL", "https://somewhere-else.example");
      await ask({ apiKey: "sk-ant-a-different-key" });
      vi.unstubAllEnvs();

      const options = mockConstructed.mock.calls.at(-1)?.[0];
      expect(options).toMatchObject({
        apiKey: "sk-ant-a-different-key",
        baseURL: "https://api.anthropic.com",
        maxRetries: 1,
      });
      expect(options.timeout).toBeGreaterThanOrEqual(30_000);
    });

    it("keeps one client per key instead of building one per message", async () => {
      await ask({ apiKey: "sk-ant-reused" });
      const built = mockConstructed.mock.calls.length;
      await ask({ apiKey: "sk-ant-reused" });
      await ask({ apiKey: "sk-ant-reused" });
      expect(mockConstructed.mock.calls.length).toBe(built);
    });
  });

  describe("the reply", () => {
    it("returns the visible text only, however many thinking blocks come before it", async () => {
      mockBetaCreate.mockResolvedValue({
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "", signature: "a" },
          { type: "thinking", thinking: "", signature: "b" },
          { type: "text", text: '{"category":' },
          { type: "text", text: '"other"}' },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      expect(await ask()).toBe('{"category":"other"}');
    });

    it("returns nothing, rather than failing, when the reply holds no text", async () => {
      mockBetaCreate.mockResolvedValue({
        stop_reason: "max_tokens",
        content: [{ type: "thinking", thinking: "", signature: "a" }],
        usage: { input_tokens: 10, output_tokens: 4096 },
      });
      expect(await ask()).toBe("");
    });

    it("treats a declined request as a failure, so nothing is sent on the strength of it", async () => {
      mockBetaCreate.mockResolvedValue({
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "general_harms" },
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      });
      await expect(ask()).rejects.toThrow("AI 沒有處理這一則（被安全檢查擋下）");
    });

    it("adds up what was used, for a trial run to price itself", async () => {
      await ask();
      await ask({ model: "claude-haiku-5-5" });
      expect(getClaudeUsage()).toEqual({
        calls: 2,
        inputTokens: 2400,
        outputTokens: 160,
        retriedPlain: 0,
      });
      resetClaudeUsage();
      expect(getClaudeUsage()).toEqual({
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        retriedPlain: 0,
      });
    });
  });

  describe("when the request is rejected", () => {
    it("asks once more with the two optional parts left out", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockBetaCreate.mockRejectedValue(new sdkError.BadRequestError("fallbacks: not supported"));
      mockCreate.mockResolvedValue(reply('{"category":"other"}'));

      expect(await ask()).toBe('{"category":"other"}');
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const body = mockCreate.mock.calls[0][0];
      expect(body).toMatchObject({
        model: "claude-opus-5-5",
        system: "規則",
        output_config: { effort: "low" },
      });
      expect(body).not.toHaveProperty("fallbacks");
      expect(body).not.toHaveProperty("betas");
      expect(body.output_config).not.toHaveProperty("format");
      // Counted and logged: it means every request is paying for two calls.
      expect(getClaudeUsage().retriedPlain).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("claude-opus-5-5");
      warnSpy.mockRestore();
    });

    it("gives up after that one more try", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockBetaCreate.mockRejectedValue(new sdkError.BadRequestError());
      mockCreate.mockRejectedValue(new sdkError.BadRequestError());
      await expect(ask()).rejects.toThrow("AI 呼叫失敗（Claude 回 400）");
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("does not ask again for anything but a rejected request", async () => {
      mockBetaCreate.mockRejectedValue(new sdkError.RateLimitError());
      await expect(ask()).rejects.toThrow("AI 呼叫失敗（Claude 回 429）");
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("the reason the owner is shown", () => {
    it.each([
      ["a key Anthropic does not accept", () => new sdkError.AuthenticationError(), "AI 呼叫失敗（Claude 金鑰無效）"],
      ["no credit left", () => new sdkError.PaymentRequiredError(), "AI 呼叫失敗（Claude 額度不足）"],
      ["too many requests", () => new sdkError.RateLimitError(), "AI 呼叫失敗（Claude 回 429）"],
      ["Anthropic being overloaded", () => new sdkError.InternalServerError(), "AI 呼叫失敗（Claude 回 529）"],
      ["a dropped connection", () => new sdkError.APIConnectionError(), "AI 呼叫失敗（APIConnectionError）"],
      ["a timeout", () => new sdkError.APIConnectionTimeoutError(), "AI 呼叫失敗（APIConnectionTimeoutError）"],
      ["anything else", () => Object.assign(new Error("boom"), { name: "TypeError" }), "AI 呼叫失敗（TypeError）"],
    ])("names %s, and nothing else", async (_what, make, shown) => {
      mockBetaCreate.mockRejectedValue(make());
      const error = await ask().catch((e: Error) => e);
      expect((error as Error).message).toBe(shown);
    });

    it("never repeats what the provider said, which can quote the key", async () => {
      mockBetaCreate.mockRejectedValue(new sdkError.AuthenticationError());
      const error = (await ask().catch((e: Error) => e)) as Error;
      expect(error.message).not.toContain("sk-ant");
    });
  });
});
