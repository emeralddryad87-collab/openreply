import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory stand-in for the Redis commands used, with real NX and expiry. */
const { fakeRedis } = vi.hoisted(() => {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  };
  return {
    fakeRedis: {
      store,
      async set(key: string, value: string, ...args: (string | number)[]) {
        const exIndex = args.indexOf("EX");
        const ttl = exIndex === -1 ? null : Number(args[exIndex + 1]);
        if (args.includes("NX") && live(key)) return null;
        store.set(key, {
          value,
          expiresAt: ttl === null ? null : Date.now() + ttl * 1000,
        });
        return "OK";
      },
      async get(key: string) {
        return live(key)?.value ?? null;
      },
      async exists(key: string) {
        return live(key) ? 1 : 0;
      },
    },
  };
});

vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => fakeRedis }));

import { HELLO_TEXT, notifyFingerprint } from "@/lib/triage/notify";
import { checkNotifyChannel, resetNotifyCheck } from "@/lib/triage/notify-check";

const TOKEN = "123456:SECRET-TOKEN";
const MINUTE = 60 * 1000;

describe("checkNotifyChannel", () => {
  const fetchMock = vi.fn();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  function configureTelegram(token = TOKEN, chatId = "987") {
    vi.stubEnv("TRIAGE_TELEGRAM_BOT_TOKEN", token);
    vi.stubEnv("TRIAGE_TELEGRAM_CHAT_ID", chatId);
  }

  beforeEach(() => {
    fakeRedis.store.clear();
    resetNotifyCheck();
    fetchMock.mockReset();
    errorSpy.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports unconfigured, and sends nothing, when no channel is set", async () => {
    expect(await checkNotifyChannel()).toBe("unconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not test a generic webhook", async () => {
    vi.stubEnv("TRIAGE_NOTIFY_URL", "https://hooks.example.com/triage");
    expect(await checkNotifyChannel()).toBe("unchecked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends one test message to the owner's chat the first time Telegram is configured", async () => {
    configureTelegram();
    expect(await checkNotifyChannel()).toBe("ok");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: "987", text: HELLO_TEXT });
  });

  it("never sends the test message twice for the same configuration", async () => {
    configureTelegram();
    await checkNotifyChannel();
    await checkNotifyChannel();
    // A restarted worker has no memory of its own, only the shared record.
    resetNotifyCheck();
    vi.advanceTimersByTime(30 * 24 * 60 * MINUTE);
    expect(await checkNotifyChannel()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send a second one when two workers check at the same moment", async () => {
    configureTelegram();
    const results = await Promise.all([checkNotifyChannel(), checkNotifyChannel()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toContain("ok");
  });

  it("reports a rejected test message and waits before trying again", async () => {
    configureTelegram();
    fetchMock.mockResolvedValue({ ok: false, status: 400 });

    expect(await checkNotifyChannel()).toBe("failed");
    expect(await checkNotifyChannel()).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After the pause it tries again, and this time the owner has pressed Start.
    vi.advanceTimersByTime(11 * MINUTE);
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    expect(await checkNotifyChannel()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a request that blows up as a failed test, without throwing", async () => {
    configureTelegram();
    fetchMock.mockRejectedValue(
      new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`)
    );
    expect(await checkNotifyChannel()).toBe("failed");
    expect(errorSpy.mock.calls.flat().map(String).join(" ")).not.toContain("SECRET");
  });

  it("tests again when the token or the chat is changed", async () => {
    configureTelegram();
    await checkNotifyChannel();
    configureTelegram(TOKEN, "555");
    expect(await checkNotifyChannel()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).chat_id).toBe("555");
  });

  it("ignores a stray space or line break around pasted values", async () => {
    configureTelegram(`${TOKEN}\n`, " 987 ");
    expect(await checkNotifyChannel()).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(init.body).chat_id).toBe("987");
  });

  it("keeps the token out of what it stores", async () => {
    configureTelegram();
    await checkNotifyChannel();
    const stored = [...fakeRedis.store.entries()].flat().map((v) => JSON.stringify(v)).join(" ");
    expect(stored).not.toContain("SECRET");
    expect(stored).not.toContain("123456");
    expect(notifyFingerprint()).toMatch(/^[0-9a-f]{16}$/);
  });
});
