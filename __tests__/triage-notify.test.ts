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
      async del(key: string) {
        return store.delete(key) ? 1 : 0;
      },
    },
  };
});

vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => fakeRedis }));

import { isNotifyConfigured } from "@/lib/triage/config";
import { notifyOwner } from "@/lib/triage/notify";

const TOKEN = "123456:SECRET-TOKEN";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const notice = (messageText: string, senderId = "user_1", senderName = "fan") => ({
  instagramAccountId: "ig_1",
  senderId,
  senderName,
  messageText,
  reason: "這行不該出現在通知裡",
});

describe("notifyOwner", () => {
  const fetchMock = vi.fn();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  let nextMessageId = 100;

  /** Every Telegram call so far, as [method, body]. */
  const calls = () =>
    fetchMock.mock.calls.map(([url, init]) => [
      String(url).split("/").pop() as string,
      JSON.parse(init.body),
    ]);
  const methods = () => calls().map(([method]) => method);
  const lastText = () => calls().filter(([m]) => m !== "deleteMessage").at(-1)?.[1].text as string;

  function telegramAccepts() {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).endsWith("/sendMessage")
          ? { ok: true, result: { message_id: nextMessageId++ } }
          : { ok: true, result: true },
    }));
  }

  function configureTelegram() {
    vi.stubEnv("TRIAGE_TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TRIAGE_TELEGRAM_CHAT_ID", "987");
  }

  beforeEach(() => {
    fakeRedis.store.clear();
    fetchMock.mockReset();
    errorSpy.mockClear();
    nextMessageId = 100;
    telegramAccepts();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    // 15:53 on the owner's clock (UTC+8).
    vi.setSystemTime(new Date("2026-11-21T07:53:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does nothing when no channel is configured", async () => {
    expect(isNotifyConfigured()).toBe(false);
    expect(await notifyOwner(notice("想找你合作"))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs both Telegram values before using Telegram", async () => {
    vi.stubEnv("TRIAGE_TELEGRAM_BOT_TOKEN", TOKEN);
    expect(isNotifyConfigured()).toBe(false);
    expect(await notifyOwner(notice("想找你合作"))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("on Telegram: one person, one message", () => {
    beforeEach(configureTelegram);

    it("sends a person's first message as a new notice: name, time, text, link — and no reason", async () => {
      expect(await notifyOwner(notice("出現這個，裝不了"))).toBe(true);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
      expect(calls()).toEqual([
        [
          "sendMessage",
          {
            chat_id: "987",
            text: "IG 私訊需要你回：fan\n15:53「出現這個，裝不了」\nhttps://www.instagram.com/fan/",
            disable_web_page_preview: true,
          },
        ],
      ]);
    });

    it("adds the next message to the same notice, quietly, while the phone rang recently", async () => {
      await notifyOwner(notice("出現這個，裝不了"));
      vi.advanceTimersByTime(10 * MINUTE);
      expect(await notifyOwner(notice("我好像裝完了"))).toBe(true);

      expect(methods()).toEqual(["sendMessage", "editMessageText"]);
      expect(calls()[1][1]).toEqual({
        chat_id: "987",
        message_id: 100,
        text: [
          "IG 私訊需要你回：fan",
          "15:53「出現這個，裝不了」",
          "16:03「我好像裝完了」",
          "https://www.instagram.com/fan/",
        ].join("\n"),
        disable_web_page_preview: true,
      });
    });

    it("keeps stacking on the same message for as long as they keep writing inside the quiet window", async () => {
      await notifyOwner(notice("一"));
      vi.advanceTimersByTime(5 * MINUTE);
      await notifyOwner(notice("二"));
      vi.advanceTimersByTime(5 * MINUTE);
      await notifyOwner(notice("三"));

      expect(methods()).toEqual(["sendMessage", "editMessageText", "editMessageText"]);
      expect(lastText()).toContain("15:53「一」\n15:58「二」\n16:03「三」");
    });

    it("rings again after half an hour: the stack is sent afresh and the old copy removed", async () => {
      await notifyOwner(notice("出現這個，裝不了"));
      vi.advanceTimersByTime(45 * MINUTE);
      expect(await notifyOwner(notice("我好像裝完了"))).toBe(true);

      expect(methods()).toEqual(["sendMessage", "sendMessage", "deleteMessage"]);
      expect(calls()[1][1].text).toBe(
        [
          "IG 私訊需要你回：fan",
          "15:53「出現這個，裝不了」",
          "16:38「我好像裝完了」",
          "https://www.instagram.com/fan/",
        ].join("\n")
      );
      expect(calls()[2][1]).toEqual({ chat_id: "987", message_id: 100 });
    });

    it("then stacks quietly on the new copy, not on the one it removed", async () => {
      await notifyOwner(notice("一"));
      vi.advanceTimersByTime(45 * MINUTE);
      await notifyOwner(notice("二"));
      vi.advanceTimersByTime(MINUTE);
      await notifyOwner(notice("三"));

      const edit = calls().at(-1)!;
      expect(edit[0]).toBe("editMessageText");
      expect(edit[1].message_id).toBe(101);
    });

    it("rings at once when asked to, even right after the last ring", async () => {
      await notifyOwner(notice("你是AI嗎"));
      vi.advanceTimersByTime(MINUTE);
      await notifyOwner(notice("要"), { ring: true });

      expect(methods()).toEqual(["sendMessage", "sendMessage", "deleteMessage"]);
      expect(lastText()).toContain("15:53「你是AI嗎」\n15:54「要」");
    });

    it("keeps each person in their own notice", async () => {
      await notifyOwner(notice("甲的訊息", "user_1", "fan_a"));
      await notifyOwner(notice("乙的訊息", "user_2", "fan_b"));
      await notifyOwner(notice("甲又傳了", "user_1", "fan_a"));

      expect(methods()).toEqual(["sendMessage", "sendMessage", "editMessageText"]);
      expect(lastText()).toContain("fan_a");
      expect(lastText()).toContain("「甲的訊息」");
      expect(lastText()).not.toContain("乙的訊息");
    });

    it("starts a new notice the next day and leaves yesterday's where it is", async () => {
      await notifyOwner(notice("昨天的訊息"));
      vi.advanceTimersByTime(25 * HOUR);
      await notifyOwner(notice("今天的訊息"));

      expect(methods()).toEqual(["sendMessage", "sendMessage"]);
      expect(lastText()).not.toContain("昨天的訊息");
    });

    it("counts the day from the first message, however often they write", async () => {
      await notifyOwner(notice("第一則"));
      for (let hour = 0; hour < 23; hour++) {
        vi.advanceTimersByTime(HOUR);
        await notifyOwner(notice(`第 ${hour} 小時`));
      }
      vi.advanceTimersByTime(2 * HOUR);
      await notifyOwner(notice("隔天"));
      expect(lastText()).not.toContain("第一則");
      expect(lastText().split("\n")).toHaveLength(3);
    });

    it("shows only the latest ten messages of someone who writes a lot", async () => {
      for (let i = 1; i <= 14; i++) {
        await notifyOwner(notice(`第${i}則`));
        vi.advanceTimersByTime(MINUTE);
      }
      const lines = lastText().split("\n");
      expect(lines).toHaveLength(12);
      expect(lines[1]).toContain("「第5則」");
      expect(lines[10]).toContain("「第14則」");
    });

    it("sends the stack afresh if the owner deleted the notice by hand", async () => {
      await notifyOwner(notice("一"));
      vi.advanceTimersByTime(MINUTE);
      fetchMock.mockImplementation(async (url: string) =>
        String(url).endsWith("/editMessageText")
          ? { ok: false, status: 400 }
          : { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 555 } }) }
      );
      expect(await notifyOwner(notice("二"))).toBe(true);

      expect(methods()).toEqual(["sendMessage", "editMessageText", "sendMessage", "deleteMessage"]);
      expect(lastText()).toContain("15:53「一」\n15:54「二」");
    });

    it("does not mind if the old copy cannot be removed", async () => {
      await notifyOwner(notice("一"));
      vi.advanceTimersByTime(45 * MINUTE);
      fetchMock.mockImplementation(async (url: string) =>
        String(url).endsWith("/deleteMessage")
          ? { ok: false, status: 400 }
          : { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 200 } }) }
      );
      expect(await notifyOwner(notice("二"))).toBe(true);
    });

    it("reports a rejected notice without throwing, and tries the whole stack again next time", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401 });
      expect(await notifyOwner(notice("一"))).toBe(false);

      telegramAccepts();
      expect(await notifyOwner(notice("二"))).toBe(true);
      expect(lastText()).toContain("「二」");
    });

    it("never writes the bot token to the log, even when the request blows up", async () => {
      fetchMock.mockRejectedValue(
        new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`)
      );
      expect(await notifyOwner(notice("一"))).toBe(false);

      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain("SECRET");
    });

    it("keeps the token out of what it stores", async () => {
      await notifyOwner(notice("一"));
      const stored = [...fakeRedis.store.entries()].flat().map((v) => JSON.stringify(v)).join(" ");
      expect(stored).not.toContain("SECRET");
    });

    it("wins over the webhook when both are configured", async () => {
      vi.stubEnv("TRIAGE_NOTIFY_URL", "https://hooks.example.com/triage");
      await notifyOwner(notice("一"));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain("api.telegram.org");
    });
  });

  describe("on the generic webhook", () => {
    beforeEach(() => {
      vi.stubEnv("TRIAGE_NOTIFY_URL", "https://hooks.example.com/triage");
      vi.stubEnv("TRIAGE_NOTIFY_SECRET", "s3cret");
    });

    it("posts the notice with its secret header", async () => {
      expect(await notifyOwner(notice("想找你合作"))).toBe(true);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://hooks.example.com/triage");
      expect(init.headers["x-triage-secret"]).toBe("s3cret");
      expect(JSON.parse(init.body)).toMatchObject({
        senderId: "user_1",
        messageText: "想找你合作",
        text: "IG 私訊需要你回：fan\n15:53「想找你合作」\nhttps://www.instagram.com/fan/",
      });
    });

    it("posts at most one notice per person inside the cooldown, since a post cannot be edited", async () => {
      await notifyOwner(notice("一"));
      vi.advanceTimersByTime(10 * MINUTE);
      expect(await notifyOwner(notice("二"))).toBe(false);
      vi.advanceTimersByTime(25 * MINUTE);
      expect(await notifyOwner(notice("三"))).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("posts at once when asked to ring", async () => {
      await notifyOwner(notice("一"));
      expect(await notifyOwner(notice("要"), { ring: true })).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
