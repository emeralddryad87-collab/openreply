import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory stand-in for the Redis commands used, with real NX and expiry. */
const { fakeRedis, mockHandle } = vi.hoisted(() => {
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
    mockHandle: vi.fn(),
    fakeRedis: {
      store,
      down: false,
      async set(key: string, value: string, ...args: (string | number)[]) {
        if (this.down) throw new Error("redis down");
        const exIndex = args.indexOf("EX");
        const ttl = exIndex === -1 ? null : Number(args[exIndex + 1]);
        if (args.includes("NX") && live(key)) return null;
        store.set(key, { value, expiresAt: ttl === null ? null : Date.now() + ttl * 1000 });
        return "OK";
      },
      async get(key: string) {
        return live(key)?.value ?? null;
      },
      async del(key: string) {
        return store.delete(key) ? 1 : 0;
      },
    },
  };
});

vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => fakeRedis }));
vi.mock("@/lib/triage/owner-actions", () => ({ handleTelegramUpdate: mockHandle }));

import {
  replyButtonsReady,
  resetTelegramUpdates,
  startTelegramUpdates,
} from "@/lib/triage/telegram-updates";

const TOKEN = "123456:SECRET-TOKEN";
const LEASE = "triage:tg:poller";
const SECOND = 1000;

type Body = { timeout: number; offset?: number; allowed_updates: string[] };
type Responder = () => unknown;

describe("hearing the buttons", () => {
  const fetchMock = vi.fn();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  let queue: Responder[] = [];
  let running: { stop: () => Promise<void> } | null = null;

  const requests = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body) as Body);
  const handled = () => mockHandle.mock.calls.map(([update, options]) => [update.update_id, options.late]);
  const batch =
    (...ids: number[]): Responder =>
    () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: ids.map((update_id) => ({ update_id })) }),
    });
  const refused =
    (status: number): Responder =>
    () => ({ ok: false, status });
  /** Let everything that is ready to run, run. */
  const settle = () => vi.advanceTimersByTimeAsync(0);

  function start() {
    running = startTelegramUpdates();
    return running;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    fakeRedis.store.clear();
    fakeRedis.down = false;
    queue = [];
    resetTelegramUpdates();
    mockHandle.mockResolvedValue(undefined);
    // With nothing queued, a request stays open like a real long poll, until
    // it is aborted.
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      const next = queue.shift();
      if (next) return Promise.resolve(next());
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TRIAGE_TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TRIAGE_TELEGRAM_CHAT_ID", "987");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T03:00:00Z"));
  });

  afterEach(async () => {
    await running?.stop();
    running = null;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("asks nothing while Telegram is not configured", async () => {
    vi.stubEnv("TRIAGE_TELEGRAM_BOT_TOKEN", "");
    start();
    await vi.advanceTimersByTimeAsync(5 * 60 * SECOND);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replyButtonsReady()).toBe(false);
  });

  it("asks Telegram for taps and replies only, with the bot's token", async () => {
    start();
    await settle();
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(requests()[0].allowed_updates).toEqual(["message", "callback_query"]);
  });

  it("first takes what was waiting, without holding the request open, and treats it as late", async () => {
    queue = [batch(7, 8)];
    start();
    await settle();

    expect(requests()[0]).toEqual({ timeout: 0, allowed_updates: ["message", "callback_query"] });
    expect(handled()).toEqual([
      [7, true],
      [8, true],
    ]);
  });

  it("then holds a long poll open, starting after the last update it saw", async () => {
    queue = [batch(7, 8), batch(9)];
    start();
    await settle();

    expect(requests()[1]).toMatchObject({ timeout: 25, offset: 9 });
    expect(handled()[2]).toEqual([9, false]);
    // And keeps listening.
    expect(requests()[2]).toMatchObject({ timeout: 25, offset: 10 });
  });

  it("handles updates one at a time, in the order they came", async () => {
    const order: string[] = [];
    mockHandle.mockImplementation(async (update: { update_id: number }) => {
      order.push(`start ${update.update_id}`);
      await Promise.resolve();
      order.push(`end ${update.update_id}`);
    });
    queue = [batch(1, 2, 3)];
    start();
    await settle();
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  });

  it("says the buttons work once it has heard from Telegram, and not before", async () => {
    expect(replyButtonsReady()).toBe(false);
    queue = [batch()];
    start();
    await settle();
    expect(replyButtonsReady()).toBe(true);
  });

  it("stops saying so when Telegram has not answered for a while", async () => {
    queue = [batch(), ...Array.from({ length: 25 }, () => refused(502))];
    start();
    await settle();
    expect(replyButtonsReady()).toBe(true);
    await vi.advanceTimersByTimeAsync(150 * SECOND);
    expect(replyButtonsReady()).toBe(false);
  });

  it("treats what arrives after an outage as late again", async () => {
    // Heard once, then eleven refusals ten seconds apart: nearly two minutes
    // without a word before the next answer.
    queue = [batch(), ...Array.from({ length: 11 }, () => refused(502)), batch(30)];
    start();
    await settle();
    expect(handled()).toEqual([]);
    await vi.advanceTimersByTimeAsync(111 * SECOND);

    expect(handled()).toEqual([[30, true]]);
    // That batch was taken without holding the request open; listening then
    // goes back to the long poll.
    expect(requests().at(-2)!.timeout).toBe(0);
    expect(requests().at(-1)).toMatchObject({ timeout: 25, offset: 31 });
  });

  it("does not call a tap late just because nothing happened for a while", async () => {
    // Quiet long polls, each answered empty after its 25 seconds.
    queue = [batch()];
    fetchMock.mockImplementation((_url: string, init: { body: string; signal: AbortSignal }) => {
      const next = queue.shift();
      if (next) return Promise.resolve(next());
      const waitSeconds = (JSON.parse(init.body) as Body).timeout;
      return new Promise((resolve, reject) => {
        setTimeout(() => resolve(batch()()), waitSeconds * SECOND);
        init.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      });
    });
    start();
    await settle();
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    queue.push(batch(40));
    await vi.advanceTimersByTimeAsync(26 * SECOND);

    expect(handled()).toEqual([[40, false]]);
    expect(replyButtonsReady()).toBe(true);
  });

  it("waits and tries again when Telegram refuses, reporting each kind of refusal once", async () => {
    queue = [refused(409), refused(409), batch(4)];
    start();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29 * SECOND);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(31 * SECOND);

    expect(handled()).toEqual([[4, true]]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toBe("[Triage] Telegram updates refused: HTTP 409");
  });

  it("moves past an update that cannot be handled instead of receiving it for ever", async () => {
    mockHandle.mockRejectedValueOnce(new Error("boom"));
    queue = [batch(5, 6), batch(6)];
    start();
    await settle();
    await vi.advanceTimersByTimeAsync(11 * SECOND);

    // 5 failed and is not asked for again; 6 was not reached, so it comes back.
    expect(requests()[1].offset).toBe(6);
    expect(handled().map(([id]) => id)).toEqual([5, 6]);
  });

  it("keeps going when the network fails, without logging the token", async () => {
    queue = [
      () => {
        throw new TypeError(`request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`);
      },
      batch(3),
    ];
    start();
    await settle();
    await vi.advanceTimersByTimeAsync(11 * SECOND);

    expect(handled().map(([id]) => id)).toEqual([3]);
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("SECRET");
  });

  describe("one reader at a time", () => {
    it("takes a lease before it reads", async () => {
      start();
      await settle();
      expect(fakeRedis.store.has(LEASE)).toBe(true);
    });

    it("does not read while another process holds the lease, and takes over when it is let go", async () => {
      await fakeRedis.set(LEASE, "another-worker", "EX", 90);
      queue = [batch(1)];
      start();
      await vi.advanceTimersByTimeAsync(40 * SECOND);
      expect(fetchMock).not.toHaveBeenCalled();

      await fakeRedis.del(LEASE);
      await vi.advanceTimersByTimeAsync(16 * SECOND);
      expect(fetchMock).toHaveBeenCalled();
      expect(handled()).toEqual([[1, true]]);
    });

    it("takes over from a process that died without letting go, once its lease runs out", async () => {
      await fakeRedis.set(LEASE, "dead-worker", "EX", 90);
      start();
      await vi.advanceTimersByTimeAsync(80 * SECOND);
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30 * SECOND);
      expect(fetchMock).toHaveBeenCalled();
    });

    it("keeps its lease alive while it listens", async () => {
      for (let i = 0; i < 12; i++) queue.push(batch());
      start();
      await settle();
      const mine = fakeRedis.store.get(LEASE)!.value;
      // Each long poll is answered at once here, so the loop runs twelve
      // rounds; the lease still belongs to this process afterwards.
      expect(fakeRedis.store.get(LEASE)!.value).toBe(mine);
      expect(fakeRedis.store.get(LEASE)!.expiresAt).toBeGreaterThan(Date.now() + 80 * SECOND);
    });

    it("waits out a Redis outage instead of reading without a lease", async () => {
      fakeRedis.down = true;
      start();
      await vi.advanceTimersByTimeAsync(25 * SECOND);
      expect(fetchMock).not.toHaveBeenCalled();

      fakeRedis.down = false;
      await vi.advanceTimersByTimeAsync(11 * SECOND);
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  describe("stopping", () => {
    it("ends an open long poll at once and lets the lease go", async () => {
      queue = [batch()];
      const handle = start();
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await handle.stop();
      running = null;
      expect(fakeRedis.store.has(LEASE)).toBe(false);

      await vi.advanceTimersByTimeAsync(5 * 60 * SECOND);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Being stopped is not an error.
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("leaves another process's lease alone", async () => {
      await fakeRedis.set(LEASE, "another-worker", "EX", 90);
      const handle = start();
      await settle();
      await handle.stop();
      running = null;
      expect(fakeRedis.store.get(LEASE)!.value).toBe("another-worker");
    });

    it("does not hang the shutdown on a request that will not end", async () => {
      queue = [batch()];
      // A request that ignores being aborted.
      fetchMock.mockImplementation(() => {
        const next = queue.shift();
        return next ? Promise.resolve(next()) : new Promise(() => {});
      });
      const handle = start();
      await settle();
      running = null;

      let stopped = false;
      void handle.stop().then(() => (stopped = true));
      await vi.advanceTimersByTimeAsync(7 * SECOND);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(2 * SECOND);
      expect(stopped).toBe(true);
    });

    it("gives up a request that Telegram never answers", async () => {
      queue = [batch()];
      start();
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The open request passes its own time limit, fails, and is retried.
      await vi.advanceTimersByTimeAsync(41 * SECOND);
      await vi.advanceTimersByTimeAsync(11 * SECOND);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
