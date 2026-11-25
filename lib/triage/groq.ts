/**
 * The Groq side of the model step. This is how triage ran before Claude and
 * what it falls back to when no Anthropic key is set (see getAiConfig).
 *
 * Groq speaks the OpenAI chat-completions shape, so the request is a plain
 * fetch. Nothing here is used for Claude: that goes through Anthropic's own
 * SDK in claude.ts.
 */

// A rate-limit reply that asks for a wait this short is worth waiting out once;
// a longer one is not, and the message goes to the owner instead.
const MAX_RETRY_WAIT_SECONDS = 20;

export interface GroqRequest {
  apiKey: string;
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
}

/**
 * Send one request and return the text the model wrote. Throws when the call
 * fails; the error names the kind of failure and nothing else, because it ends
 * up in front of the owner as the reason a message was handed over.
 */
export async function askGroq({
  apiKey,
  model,
  messages,
  temperature,
}: GroqRequest): Promise<string> {
  const request = () =>
    fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: temperature ?? 0.2,
        max_tokens: 600,
        messages,
      }),
      signal: AbortSignal.timeout(20_000),
    });

  let response: Response;
  try {
    response = await request();
    // Two messages in the same minute can trip the per-minute limit of the
    // provider. It says how long to wait; if that is short, wait and ask again.
    if (response.status === 429) {
      const header = response.headers?.get?.("retry-after");
      const wait = header ? Number(header) : Number.NaN;
      if (Number.isFinite(wait) && wait >= 0 && wait <= MAX_RETRY_WAIT_SECONDS) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 1) * 1000));
        response = await request();
      }
    }
  } catch (error) {
    const kind = error instanceof Error ? error.name : "Error";
    throw new Error(`AI 呼叫失敗（${kind}）`);
  }

  if (!response.ok) {
    throw new Error(`AI 呼叫失敗（${model} 回 ${response.status}）`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}
