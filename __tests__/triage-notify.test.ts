import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isNotifyConfigured } from "@/lib/triage/config";
import { notifyOwner } from "@/lib/triage/notify";

const NOTICE = {
  instagramAccountId: "ig_1",
  senderId: "user_1",
  senderName: "fan",
  messageText: "想找你合作",
  reason: "合作邀約",
};

const TOKEN = "123456:SECRET-TOKEN";

describe("notifyOwner", () => {
  const fetchMock = vi.fn();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    fetchMock.mockReset();
    errorSpy.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does nothing when no channel is configured", async () => {
    expect(isNotifyConfigured()).toBe(false);
    expect(await notifyOwner(NOTICE)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the notice to the owner's Telegram chat", async () => {
    vi.stubEnv("TRIAGE_TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TRIAGE_TELEGRAM_CHAT_ID", "987");

    expect(isNotifyConfigured()).toBe(true);
    expect(await notifyOwner(NOTICE)).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(init.body)).toEqual({
      chat_id: "987",
      text: "IG 私訊需要你回：fan\n「想找你合作」\n（合作邀約）\nhttps://www.instagram.com/fan/",
      disable_web_page_preview: true,
    });
  });

  it("needs both Telegram values before using Telegram", async () => {
    vi.stubEnv("TRIAGE_TELEGRAM_BOT_TOKEN", TOKEN);
    expect(isNotifyConfigured()).toBe(false);
    expect(await notifyOwner(NOTICE)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the generic webhook, with its secret header", async () => {
    vi.stubEnv("TRIAGE_NOTIFY_URL", "https://hooks.example.com/triage");
    vi.stubEnv("TRIAGE_NOTIFY_SECRET", "s3cret");

    expect(await notifyOwner(NOTICE)).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/triage");
    expect(init.headers["x-triage-secret"]).toBe("s3cret");
    expect(JSON.parse(init.body)).toMatchObject({ senderId: "user_1", messageText: "想找你合作" });
  });

  it("prefers Telegram when both are configured", async () => {
    vi.stubEnv("TRIAGE_TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TRIAGE_TELEGRAM_CHAT_ID", "987");
    vi.stubEnv("TRIAGE_NOTIFY_URL", "https://hooks.example.com/triage");

    await notifyOwner(NOTICE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("api.telegram.org");
  });

  it("reports a rejected notice without throwing", async () => {
    vi.stubEnv("TRIAGE_TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TRIAGE_TELEGRAM_CHAT_ID", "987");
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    expect(await notifyOwner(NOTICE)).toBe(false);
  });

  it("never writes the bot token to the log, even when the request blows up", async () => {
    vi.stubEnv("TRIAGE_TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TRIAGE_TELEGRAM_CHAT_ID", "987");
    fetchMock.mockRejectedValue(
      new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`)
    );

    expect(await notifyOwner(NOTICE)).toBe(false);

    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("SECRET");
  });
});
