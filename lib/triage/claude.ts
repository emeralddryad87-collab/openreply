import Anthropic from "@anthropic-ai/sdk";

/**
 * The Claude side of the model step, through Anthropic's own SDK.
 *
 * One request, one answer: no tools, no conversation kept on Anthropic's
 * side. The request is the same for every current Claude model, so the model
 * is a setting and not a code change:
 *
 *   - Thinking is left to the model (it is always on for Opus and on by
 *     default elsewhere); how hard it thinks is set with a low effort, which
 *     is what a short chat reply needs.
 *   - No sampling settings: current models reject them.
 *   - The answer is asked for as JSON in a fixed shape, so a reply cannot come
 *     back as prose.
 *   - If a safety check declines the request, the API retries it once on the
 *     model Anthropic recommends as a stand-in. Haiku has no stand-in, and
 *     must not be sent the setting.
 *
 * Whatever goes wrong — a refusal that stands, a rejected request, no credit
 * left — surfaces as an error. The caller hands the message to the owner, so
 * nothing is ever sent on the strength of a failed call.
 */

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
// Named outright, so that the owner's key can only ever go to Anthropic: left
// to its default, the SDK would send it wherever ANTHROPIC_BASE_URL points, and
// that variable is set by other tools on some machines.
const API_URL = "https://api.anthropic.com";
// Room for the model's thinking plus a short JSON answer. Thinking counts
// toward this cap, so a cap sized for the answer alone would cut it off.
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 45_000;

export interface ClaudeRequest {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  /** JSON schema the answer must follow. */
  schema?: Record<string, unknown>;
}

export interface ClaudeUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Requests that were rejected as sent and went through without the optional parts. */
  retriedPlain: number;
}

const usage: ClaudeUsage = { calls: 0, inputTokens: 0, outputTokens: 0, retriedPlain: 0 };

/** Tokens used by this process so far: what a trial run reads to price itself. */
export function getClaudeUsage(): ClaudeUsage {
  return { ...usage };
}

export function resetClaudeUsage(): void {
  usage.calls = 0;
  usage.inputTokens = 0;
  usage.outputTokens = 0;
  usage.retriedPlain = 0;
}

let cached: { apiKey: string; client: Anthropic } | null = null;

function clientFor(apiKey: string): Anthropic {
  if (!cached || cached.apiKey !== apiKey) {
    cached = {
      apiKey,
      client: new Anthropic({
        apiKey,
        baseURL: API_URL,
        timeout: TIMEOUT_MS,
        maxRetries: 1,
      }),
    };
  }
  return cached.client;
}

/** Haiku has no server-side fallback: the setting must not be sent to it. */
function supportsFallback(model: string): boolean {
  return !model.startsWith("claude-haiku");
}

// Shown to the owner as the reason a message was handed over, so in their
// language, and naming the kind of failure only.
const REFUSED = "AI 沒有處理這一則（被安全檢查擋下）";

function describe(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new Error("AI 呼叫失敗（Claude 金鑰無效）");
  }
  if (error instanceof Anthropic.PaymentRequiredError) {
    return new Error("AI 呼叫失敗（Claude 額度不足）");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new Error("AI 呼叫失敗（Claude 回 429）");
  }
  // Checked before APIError: a dropped connection or a timeout has no status.
  if (error instanceof Anthropic.APIConnectionError) {
    return new Error(`AI 呼叫失敗（${error.name}）`);
  }
  if (error instanceof Anthropic.APIError) {
    return new Error(`AI 呼叫失敗（Claude 回 ${error.status ?? "錯誤"}）`);
  }
  return new Error(`AI 呼叫失敗（${error instanceof Error ? error.name : "Error"}）`);
}

export type ClaudeCheck = "ok" | "bad_key" | "bad_model" | "failed";

/**
 * Ask Anthropic for the model's own entry. It costs nothing and answers two
 * questions at once: is this key accepted, and does this model exist for it?
 * "failed" is everything else — no network, Anthropic unwell — and says
 * nothing about the settings. Never throws.
 */
export async function checkClaude(apiKey: string, model: string): Promise<ClaudeCheck> {
  try {
    await clientFor(apiKey).models.retrieve(model);
    return "ok";
  } catch (error) {
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      return "bad_key";
    }
    if (error instanceof Anthropic.NotFoundError) return "bad_model";
    return "failed";
  }
}

/** The visible text of a reply. Thinking blocks come first and carry no text. */
function textOf(content: ReadonlyArray<{ type: string; text?: unknown }>): string {
  return content
    .map((block) =>
      block.type === "text" && typeof block.text === "string" ? block.text : ""
    )
    .join("");
}

/**
 * Send one request and return the text Claude wrote. Throws when the call
 * fails or the request is declined.
 */
export async function askClaude(request: ClaudeRequest): Promise<string> {
  const client = clientFor(request.apiKey);
  const base = {
    model: request.model,
    max_tokens: MAX_TOKENS,
    system: request.system,
    messages: [{ role: "user" as const, content: request.user }],
  };
  const outputConfig = {
    effort: "low" as const,
    ...(request.schema
      ? { format: { type: "json_schema" as const, schema: request.schema } }
      : {}),
  };

  let response: {
    stop_reason: string | null;
    content: ReadonlyArray<{ type: string; text?: unknown }>;
    usage: { input_tokens: number; output_tokens: number };
  };
  try {
    response = supportsFallback(request.model)
      ? await client.beta.messages.create({
          ...base,
          output_config: outputConfig,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        })
      : await client.messages.create({ ...base, output_config: outputConfig });
  } catch (error) {
    if (!(error instanceof Anthropic.BadRequestError)) throw describe(error);
    // The request itself was rejected. The two optional parts are the likely
    // cause (a stand-in setting a model does not take, a schema it does not
    // accept), so ask once more without them: the instructions still ask for
    // JSON, and the reply is checked either way.
    try {
      response = await client.messages.create({
        ...base,
        output_config: { effort: "low" },
      });
    } catch (again) {
      throw describe(again);
    }
    // Worth knowing about: every request is then paying for two calls.
    if (usage.retriedPlain === 0) {
      console.warn(
        `[Triage] ${request.model} rejected the full request; it went through without the optional parts`
      );
    }
    usage.retriedPlain += 1;
  }

  usage.calls += 1;
  usage.inputTokens += response.usage.input_tokens;
  usage.outputTokens += response.usage.output_tokens;

  // A declined request is a normal reply with nothing usable in it.
  if (response.stop_reason === "refusal") throw new Error(REFUSED);
  return textOf(response.content);
}
