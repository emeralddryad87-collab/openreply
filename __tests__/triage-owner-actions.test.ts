import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The buttons under a notice, exercised end to end against stand-ins: an
 * in-memory log table with real "claim it once" behaviour, an in-memory Redis,
 * and a recorded Telegram. Only Instagram's send is a plain mock.
 */

type Row = {
  id: string;
  instagramAccountId: string;
  senderId: string;
  action: string;
  replyText: string | null;
  pageKey?: string | null;
  reason: string | null;
  createdAt: Date;
  instagramAccount: { instagramId: string; accessToken: string | null };
};

type Where = {
  id?: string;
  action?: string;
  replyText?: { not: null };
  instagramAccountId?: string;
  senderId?: string;
};

const { fakeRedis, table, mockPrisma, mockSendDirectMessage } = vi.hoisted(() => {
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
  const fakeRedis = {
    store,
    failOn: null as string | null,
    async set(key: string, value: string, ...args: (string | number)[]) {
      if (this.failOn && key.startsWith(this.failOn)) throw new Error("redis down");
      const exIndex = args.indexOf("EX");
      const ttl = exIndex === -1 ? null : Number(args[exIndex + 1]);
      if (args.includes("NX") && live(key)) return null;
      store.set(key, { value, expiresAt: ttl === null ? null : Date.now() + ttl * 1000 });
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
  };

  const table: { rows: Row[] } = { rows: [] };
  const matches = (row: Row, where: Where) =>
    (where.id === undefined || row.id === where.id) &&
    (where.action === undefined || row.action === where.action) &&
    (where.replyText === undefined || row.replyText !== null) &&
    (where.instagramAccountId === undefined ||
      row.instagramAccountId === where.instagramAccountId) &&
    (where.senderId === undefined || row.senderId === where.senderId);

  const mockPrisma = {
    triageLog: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = table.rows.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const found = table.rows
          .filter((r) => matches(r, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return found ? { ...found } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        let count = 0;
        for (const row of table.rows) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count++;
          }
        }
        return { count };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = table.rows.find((r) => r.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };

  return { fakeRedis, table, mockPrisma, mockSendDirectMessage: vi.fn() };
});

vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => fakeRedis }));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({ sendDirectMessage: mockSendDirectMessage }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (t: string) => `plain:${t}` }));

import { notifyOwner } from "@/lib/triage/notify";
import { handleTelegramUpdate } from "@/lib/triage/owner-actions";

const TOKEN = "123456:SECRET-TOKEN";
const CHAT = 987;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const LOG = "clogaaaaaaaaaaaaaaaaaaaa1";
const NEWER = "clogaaaaaaaaaaaaaaaaaaaa2";
const DRAFT = "可以呀～你是想合作哪一種形式呢？";
const OWN_WORDS = "可以呀，你方便給我你的預算嗎？";
/** The Telegram message id of the first notice sent in a test. */
const NOTICE = 100;

describe("the buttons under a notice", () => {
  const fetchMock = vi.fn();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  let nextMessageId = NOTICE;
  let nextQueryId = 1;

  /** Every Telegram call so far, as [method, body]. */
  const calls = () =>
    fetchMock.mock.calls.map(([url, init]) => [
      String(url).split("/").pop() as string,
      JSON.parse(init.body),
    ]) as [string, Record<string, unknown>][];
  const methods = () => calls().map(([method]) => method);
  const only = (method: string) => calls().filter(([m]) => m === method).map(([, body]) => body);
  const answers = () => only("answerCallbackQuery");
  const row = (id = LOG) => table.rows.find((r) => r.id === id)!;
  const sent = () => mockSendDirectMessage.mock.calls.map((call) => call.slice(1));

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

  function addRow(over: Partial<Row> = {}): Row {
    const added: Row = {
      id: LOG,
      instagramAccountId: "acct_row",
      senderId: "user_1",
      action: "ESCALATED",
      replyText: DRAFT,
      reason: "合作，要本人回",
      createdAt: new Date(),
      instagramAccount: { instagramId: "ig_1", accessToken: "enc" },
      ...over,
    };
    table.rows.push(added);
    return added;
  }

  /** A message handed to the owner with a draft, exactly as triage leaves it. */
  async function escalated(over: Partial<Row> = {}) {
    const added = addRow(over);
    await notifyOwner({
      instagramAccountId: "ig_1",
      senderId: added.senderId,
      senderName: "fan",
      messageText: "想找你合作",
      reason: "r",
      draft: { logId: added.id, text: added.replyText ?? "", at: added.createdAt.getTime() },
    });
    fetchMock.mockClear();
    return added;
  }

  const tap = (op: string, logId = LOG, over: { chat?: number; messageId?: number; late?: boolean } = {}) =>
    handleTelegramUpdate(
      {
        update_id: nextQueryId,
        callback_query: {
          id: `q${nextQueryId++}`,
          data: `t:${op}:${logId}`,
          message: { message_id: over.messageId ?? NOTICE, chat: { id: over.chat ?? CHAT } },
        },
      },
      { late: over.late }
    );

  const typed = (
    text: string | undefined,
    replyTo: number | undefined,
    over: { chat?: number; date?: number; messageId?: number } = {}
  ) =>
    handleTelegramUpdate({
      update_id: nextQueryId++,
      message: {
        message_id: over.messageId ?? 900,
        date: over.date ?? Math.floor(Date.now() / 1000),
        chat: { id: over.chat ?? CHAT },
        ...(text === undefined ? {} : { text }),
        ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo } }),
      },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    fakeRedis.store.clear();
    fakeRedis.failOn = null;
    table.rows = [];
    nextMessageId = NOTICE;
    nextQueryId = 1;
    telegramAccepts();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TRIAGE_TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TRIAGE_TELEGRAM_CHAT_ID", String(CHAT));
    mockSendDirectMessage.mockResolvedValue({ recipient_id: "user_1", message_id: "m" });
    vi.useFakeTimers();
    // 15:53 on the owner's clock (UTC+8).
    vi.setSystemTime(new Date("2026-11-21T07:53:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe("送出: two taps", () => {
    it("the first tap sends nothing; it asks to confirm", async () => {
      await escalated();
      await tap("s");

      expect(sent()).toEqual([]);
      expect(row()).toMatchObject({ action: "ESCALATED", replyText: DRAFT });
      expect(calls()).toEqual([
        [
          "editMessageReplyMarkup",
          {
            chat_id: "987",
            message_id: NOTICE,
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ 確定送出", callback_data: `t:y:${LOG}` },
                  { text: "取消", callback_data: `t:n:${LOG}` },
                ],
              ],
            },
          },
        ],
        ["answerCallbackQuery", { callback_query_id: "q1", text: "再按一次「確定送出」才會發" }],
      ]);
    });

    it("取消 puts the three buttons back and sends nothing", async () => {
      await escalated();
      await tap("s");
      fetchMock.mockClear();
      await tap("n");

      expect(sent()).toEqual([]);
      expect(row().replyText).toBe(DRAFT);
      const [method, body] = calls()[0];
      expect(method).toBe("editMessageReplyMarkup");
      expect(
        (body.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard[0].map(
          (b) => b.text
        )
      ).toEqual(["送出", "修改", "不用回"]);
      expect(answers()).toEqual([{ callback_query_id: "q2" }]);
    });

    it("確定送出 sends the draft from the owner's account, once", async () => {
      await escalated();
      await tap("y");

      expect(sent()).toEqual([["ig_1", "user_1", DRAFT]]);
      expect(mockSendDirectMessage.mock.calls[0][0]).toBe("plain:enc");
      expect(row()).toMatchObject({ action: "SENT_BY_OWNER", replyText: DRAFT });
      expect(answers()).toEqual([{ callback_query_id: "q1", text: "已送出 ✅" }]);
    });

    it("puts the reply into the notice and takes the buttons off, without ringing", async () => {
      await escalated();
      vi.advanceTimersByTime(2 * MINUTE);
      await tap("y");

      expect(methods()).toEqual(["editMessageText", "answerCallbackQuery"]);
      expect(calls()[0][1]).toEqual({
        chat_id: "987",
        message_id: NOTICE,
        text: [
          "IG 私訊已回：fan",
          "15:53「想找你合作」",
          `15:55 ✅ 已回「${DRAFT}」`,
          "https://www.instagram.com/fan/",
        ].join("\n"),
        disable_web_page_preview: true,
      });
    });

    it("marks the conversation as the bot's before sending, so the echo is not read as the owner typing", async () => {
      await escalated();
      let markedBeforeSend = false;
      mockSendDirectMessage.mockImplementation(async () => {
        markedBeforeSend = fakeRedis.store.has("triage:bot:ig_1:user_1");
        return { recipient_id: "user_1", message_id: "m" };
      });
      await tap("y");
      expect(markedBeforeSend).toBe(true);
      expect(fakeRedis.store.has("triage:owner:ig_1:user_1")).toBe(false);
    });

    it("still sends when that mark cannot be written", async () => {
      await escalated();
      fakeRedis.failOn = "triage:bot:";
      await tap("y");
      expect(sent()).toEqual([["ig_1", "user_1", DRAFT]]);
      expect(row().action).toBe("SENT_BY_OWNER");
    });

    it("claims the draft before sending, so it cannot go out twice", async () => {
      await escalated();
      let actionWhileSending = "";
      mockSendDirectMessage.mockImplementation(async () => {
        actionWhileSending = row().action;
        return { recipient_id: "user_1", message_id: "m" };
      });
      await tap("y");
      expect(actionWhileSending).toBe("SENT_BY_OWNER");
    });

    it("leaves no other draft waiting for that person once the reply is out", async () => {
      await escalated();
      addRow({ id: NEWER, replyText: "更早一則的草稿", createdAt: new Date(Date.now() - MINUTE) });
      addRow({ id: "clogothersxxxxxxxxxxxxxx3", senderId: "someone_else", replyText: "別人的草稿" });
      await tap("y");

      expect(row()).toMatchObject({ action: "SENT_BY_OWNER", replyText: DRAFT });
      expect(row(NEWER)).toMatchObject({ action: "ESCALATED", replyText: null });
      expect(row("clogothersxxxxxxxxxxxxxx3").replyText).toBe("別人的草稿");
    });

    it("has still sent the reply when that tidying fails", async () => {
      await escalated();
      const realUpdateMany = mockPrisma.triageLog.updateMany.getMockImplementation()!;
      mockPrisma.triageLog.updateMany
        .mockImplementationOnce(realUpdateMany)
        .mockRejectedValueOnce(new Error("db blip"));
      await tap("y");

      expect(sent()).toEqual([["ig_1", "user_1", DRAFT]]);
      expect(answers()[0].text).toBe("已送出 ✅");
    });

    it("does not send again on a second tap", async () => {
      await escalated();
      await tap("y");
      fetchMock.mockClear();
      await tap("y");

      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
      expect(answers()).toEqual([
        { callback_query_id: "q2", text: "這則已經處理過了，沒有再發" },
      ]);
      // The stale buttons are taken off the message that was tapped.
      expect(only("editMessageReplyMarkup")).toEqual([{ chat_id: "987", message_id: NOTICE }]);
    });

    it("sends once when the same tap is delivered twice at the same time", async () => {
      await escalated();
      await Promise.all([tap("y"), tap("y")]);
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    });

    it("does not send on a tap that was waiting while the worker was away; it asks to tap again", async () => {
      await escalated();
      await tap("y", LOG, { late: true });

      expect(sent()).toEqual([]);
      expect(row()).toMatchObject({ action: "ESCALATED", replyText: DRAFT });
      expect(calls()).toEqual([
        [
          "answerCallbackQuery",
          {
            callback_query_id: "q1",
            text: "系統剛重新啟動，為了避免誤發，請再按一次「確定送出」。",
            show_alert: true,
          },
        ],
      ]);

      await tap("y");
      expect(sent()).toEqual([["ig_1", "user_1", DRAFT]]);
    });

    it("clears the buttons of an old copy when the notice now lives in another message", async () => {
      await escalated();
      await tap("y", LOG, { messageId: 55 });

      expect(sent()).toEqual([["ig_1", "user_1", DRAFT]]);
      expect(only("editMessageText")[0].message_id).toBe(NOTICE);
      expect(only("editMessageReplyMarkup")).toEqual([{ chat_id: "987", message_id: 55 }]);
    });

    it("clears the tapped buttons when the notice has aged out", async () => {
      await escalated();
      fakeRedis.store.clear();
      await tap("y");

      expect(sent()).toEqual([["ig_1", "user_1", DRAFT]]);
      expect(methods()).toEqual(["editMessageReplyMarkup", "answerCallbackQuery"]);
      expect(answers()[0].text).toBe("已送出 ✅");
    });
  });

  describe("a draft that offers one of the owner's tutorials", () => {
    const OFFER_KEY = "triage:offer:ig_1:user_1";

    it("opens the offer when it is sent as drafted, so the person's yes gets that tutorial", async () => {
      await escalated({ pageKey: "K26", replyText: "我有做過剪片的教學哦，要的話我把連結傳給你～" });
      await tap("s");
      await tap("y");

      expect(sent()).toHaveLength(1);
      expect(await fakeRedis.get(OFFER_KEY)).toBe("K26");
    });

    it("opens nothing for a draft that offers none", async () => {
      await escalated();
      await tap("s");
      await tap("y");

      expect(sent()).toHaveLength(1);
      expect(await fakeRedis.get(OFFER_KEY)).toBeNull();
    });

    it("opens nothing when the send failed", async () => {
      mockSendDirectMessage.mockRejectedValue(new Error("nope"));
      await escalated({ pageKey: "K26" });
      await tap("s");
      await tap("y");

      expect(await fakeRedis.get(OFFER_KEY)).toBeNull();
    });

    it("still reports the reply as sent when the offer could not be stored", async () => {
      await escalated({ pageKey: "K26" });
      fakeRedis.failOn = "triage:offer:";
      await tap("s");
      await tap("y");

      expect(sent()).toHaveLength(1);
      expect(row()).toMatchObject({ action: "SENT_BY_OWNER" });
      expect(answers().at(-1)).toMatchObject({ text: "已送出 ✅" });
    });
  });

  describe("when it must not send", () => {
    it("ignores a tap from any chat but the owner's, without a word", async () => {
      await escalated();
      await tap("y", LOG, { chat: 555 });

      expect(sent()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockPrisma.triageLog.findUnique).not.toHaveBeenCalled();
      expect(row().action).toBe("ESCALATED");
    });

    it.each(["t:y", "t:z:" + LOG, "y:" + LOG, "t:y:../../etc", "t:y:" + "a".repeat(60), ""])(
      "ignores a button it did not make (%j)",
      async (data) => {
        await escalated();
        await handleTelegramUpdate({
          callback_query: { id: "q", data, message: { message_id: NOTICE, chat: { id: CHAT } } },
        });
        expect(sent()).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );

    it("does nothing for a draft it has never heard of", async () => {
      await escalated();
      await tap("y", "clogzzzzzzzzzzzzzzzzzzzz9");
      expect(sent()).toEqual([]);
      expect(answers()[0].text).toBe("這則已經處理過了，沒有再發");
    });

    it.each(["REPLIED", "FAILED", "SENT_BY_OWNER", "IGNORED", "SKIPPED_CAP", "DRY_RUN", "PENDING"])(
      "never sends the text of a row that is %s, whatever it holds",
      async (action) => {
        await escalated({ action });
        await tap("y");
        expect(sent()).toEqual([]);
        expect(row().action).toBe(action);
      }
    );

    it("does not send a draft older than Instagram's 24-hour window", async () => {
      await escalated();
      vi.advanceTimersByTime(25 * HOUR);
      // The notice has aged out by then too; the tapped message is tidied.
      await tap("y");

      expect(sent()).toEqual([]);
      expect(row()).toMatchObject({ action: "ESCALATED", replyText: null });
      expect(answers()).toEqual([
        {
          callback_query_id: "q1",
          text: "這則超過 24 小時了，Instagram 不讓這樣回。請直接到 IG 回。",
          show_alert: true,
        },
      ]);
      expect(only("editMessageReplyMarkup")).toEqual([{ chat_id: "987", message_id: NOTICE }]);
    });

    it("does nothing at all when Telegram is not configured", async () => {
      await escalated();
      vi.unstubAllEnvs();
      await tap("y");
      expect(sent()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("when Instagram does not take it", () => {
    const outsideWindow = new Error(
      "(#10) This message is sent outside of allowed window. (/v21.0/ig_1/messages) [code=10 sub=2534022 type=OAuthException trace=T]"
    );

    it("says so in the notice and in a pop-up, and records why", async () => {
      await escalated();
      mockSendDirectMessage.mockRejectedValue(outsideWindow);
      vi.advanceTimersByTime(MINUTE);
      await tap("y");

      expect(row()).toMatchObject({ action: "FAILED", replyText: DRAFT });
      expect(row().reason).toContain("outside of allowed window");
      expect(only("editMessageText")[0].text).toBe(
        [
          "IG 私訊需要你回：fan",
          "15:53「想找你合作」",
          `15:54 ⚠️ 沒送出去「${DRAFT}」`,
          "https://www.instagram.com/fan/",
        ].join("\n")
      );
      expect(only("editMessageText")[0]).not.toHaveProperty("reply_markup");
      expect(answers()).toEqual([
        {
          callback_query_id: "q1",
          text: "沒送出去：超過 24 小時，Instagram 不讓這樣回了。請直接到 IG 回。",
          show_alert: true,
        },
      ]);
    });

    it("does not try again: Instagram may have delivered it despite the error", async () => {
      await escalated();
      mockSendDirectMessage.mockRejectedValueOnce(new Error("An unknown error occurred [code=1]"));
      await tap("y");
      mockSendDirectMessage.mockResolvedValue({ recipient_id: "user_1", message_id: "m" });
      await tap("y");

      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
      expect(answers()[0].text).toBe("沒送出去：Instagram 沒有接受。請直接到 IG 回。");
      expect(answers()[1].text).toBe("這則已經處理過了，沒有再發");
    });

    it("keeps the pop-up within what Telegram allows", async () => {
      await escalated();
      mockSendDirectMessage.mockRejectedValue(new Error("x".repeat(2000)));
      await tap("y");
      expect(String(answers()[0].text).length).toBeLessThanOrEqual(200);
      expect(row().reason!.length).toBeLessThanOrEqual(300);
    });

    it("does not send for an account with no Instagram authorisation", async () => {
      await escalated({ instagramAccount: { instagramId: "ig_1", accessToken: null } });
      await tap("y");
      expect(sent()).toEqual([]);
      expect(row().action).toBe("FAILED");
      expect(answers()[0].text).toBe(
        "沒送出去：這個帳號沒有可用的 Instagram 授權。請直接到 IG 回。"
      );
    });
  });

  describe("不用回", () => {
    it("drops the draft and takes it off the notice", async () => {
      await escalated();
      await tap("x");

      expect(sent()).toEqual([]);
      expect(row()).toMatchObject({ action: "ESCALATED", replyText: null });
      expect(only("editMessageText")[0]).toEqual({
        chat_id: "987",
        message_id: NOTICE,
        text: "IG 私訊需要你回：fan\n15:53「想找你合作」\nhttps://www.instagram.com/fan/",
        disable_web_page_preview: true,
      });
      expect(answers()).toEqual([{ callback_query_id: "q1", text: "好，這則不回" }]);
    });

    it("leaves nothing to send afterwards", async () => {
      await escalated();
      await tap("x");
      await tap("y");
      expect(sent()).toEqual([]);
    });
  });

  describe("修改: the owner's own words", () => {
    /** Press 修改 and return the id of the message that asks for the wording. */
    async function askedToType() {
      await tap("e");
      const prompt = only("sendMessage")[0];
      fetchMock.mockClear();
      return { prompt, promptId: NOTICE + 1 };
    }

    it("asks for the wording in a message that opens a reply, with the draft ready to copy", async () => {
      await escalated();
      await tap("e");

      expect(sent()).toEqual([]);
      expect(methods()).toEqual(["sendMessage", "answerCallbackQuery"]);
      const prompt = only("sendMessage")[0] as {
        chat_id: string;
        text: string;
        entities: { type: string; offset: number; length: number }[];
        reply_markup: unknown;
      };
      expect(prompt.chat_id).toBe("987");
      expect(prompt.text).toContain("打上你要傳給 fan 的內容");
      expect(prompt.reply_markup).toEqual({
        force_reply: true,
        input_field_placeholder: "打上要回的內容",
      });
      // The copyable part is the draft, the whole draft and nothing else.
      const [entity] = prompt.entities;
      expect(entity.type).toBe("code");
      expect(prompt.text.slice(entity.offset, entity.offset + entity.length)).toBe(DRAFT);
      expect(row()).toMatchObject({ action: "ESCALATED", replyText: DRAFT });
    });

    it("marks a draft of several lines as a block, which is how Telegram copies those", async () => {
      await escalated({ replyText: "不好意思～\n連結在這裡" });
      await tap("e");
      const prompt = only("sendMessage")[0] as {
        text: string;
        entities: { type: string; offset: number; length: number }[];
      };
      expect(prompt.entities[0].type).toBe("pre");
      expect(
        prompt.text.slice(
          prompt.entities[0].offset,
          prompt.entities[0].offset + prompt.entities[0].length
        )
      ).toBe("不好意思～\n連結在這裡");
    });

    it("sends what the owner typed in place of the draft", async () => {
      await escalated();
      const { promptId } = await askedToType();
      vi.advanceTimersByTime(MINUTE);
      await typed(OWN_WORDS, promptId);

      expect(sent()).toEqual([["ig_1", "user_1", OWN_WORDS]]);
      expect(row()).toMatchObject({ action: "SENT_BY_OWNER", replyText: OWN_WORDS });
      expect(only("editMessageText")[0].text).toBe(
        [
          "IG 私訊已回：fan",
          "15:53「想找你合作」",
          `15:54 ✅ 已回「${OWN_WORDS}」`,
          "https://www.instagram.com/fan/",
        ].join("\n")
      );
    });

    it("then removes the question and the answer, keeping the chat to one message per person", async () => {
      await escalated();
      const { promptId } = await askedToType();
      await typed(OWN_WORDS, promptId, { messageId: 900 });

      expect(only("deleteMessage")).toEqual([
        { chat_id: "987", message_id: promptId },
        { chat_id: "987", message_id: 900 },
      ]);
      expect(only("sendMessage")).toEqual([]);
    });

    it("sends the owner's words even when a newer message replaced the draft while they typed", async () => {
      await escalated();
      const { promptId } = await askedToType();
      // A second message arrives: its draft takes over, the first is dropped.
      row().replyText = null;
      addRow({ id: NEWER, replyText: "新的草稿", createdAt: new Date(Date.now() + MINUTE) });

      await typed(OWN_WORDS, promptId);

      expect(sent()).toEqual([["ig_1", "user_1", OWN_WORDS]]);
      expect(row(NEWER)).toMatchObject({ action: "SENT_BY_OWNER", replyText: OWN_WORDS });
      expect(row(LOG)).toMatchObject({ action: "ESCALATED", replyText: null });
    });

    it("does not send to anyone else when the draft is gone and none is waiting for that person", async () => {
      await escalated();
      const { promptId } = await askedToType();
      row().replyText = null;
      addRow({ id: NEWER, senderId: "someone_else", replyText: "別人的草稿" });

      await typed(OWN_WORDS, promptId);

      expect(sent()).toEqual([]);
      expect(row(NEWER)).toMatchObject({ action: "ESCALATED", replyText: "別人的草稿" });
      expect(only("sendMessage")).toEqual([
        { chat_id: "987", text: "這則已經處理過了，沒有再發" },
      ]);
    });

    it("says it was already handled when the draft went out by button in the meantime", async () => {
      await escalated();
      const { promptId } = await askedToType();
      await tap("y");
      fetchMock.mockClear();
      await typed(OWN_WORDS, promptId);

      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sent()).toEqual([["ig_1", "user_1", DRAFT]]);
      expect(only("sendMessage")).toEqual([
        { chat_id: "987", text: "這則已經處理過了，沒有再發" },
      ]);
    });

    it("asks again for text when the reply is a photo or a sticker", async () => {
      await escalated();
      const { promptId } = await askedToType();
      await typed(undefined, promptId);

      expect(sent()).toEqual([]);
      expect(row().replyText).toBe(DRAFT);
      expect(only("sendMessage")[0].text).toContain("只能傳文字");
    });

    it("refuses a reply longer than Instagram's limit instead of cutting it", async () => {
      await escalated();
      const { promptId } = await askedToType();
      await typed("字".repeat(1001), promptId);

      expect(sent()).toEqual([]);
      expect(only("sendMessage")[0].text).toContain("1001 字");
      // The owner can still answer the same question with a shorter text.
      fetchMock.mockClear();
      await typed(OWN_WORDS, promptId);
      expect(sent()).toEqual([["ig_1", "user_1", OWN_WORDS]]);
    });

    it("does not send a typed reply that reaches it minutes late", async () => {
      await escalated();
      const { promptId } = await askedToType();
      await typed(OWN_WORDS, promptId, { date: Math.floor(Date.now() / 1000) - 6 * 60 });

      expect(sent()).toEqual([]);
      expect(row().replyText).toBe(DRAFT);
      expect(only("sendMessage")[0].text).toContain("隔太久");
    });

    it("says so when Instagram does not take the owner's words", async () => {
      await escalated();
      const { promptId } = await askedToType();
      mockSendDirectMessage.mockRejectedValue(new Error("boom"));
      await typed(OWN_WORDS, promptId);

      expect(row()).toMatchObject({ action: "FAILED", replyText: OWN_WORDS });
      expect(only("editMessageText")[0].text).toContain(`⚠️ 沒送出去「${OWN_WORDS}」`);
      expect(only("sendMessage")).toEqual([
        { chat_id: "987", text: "沒送出去：Instagram 沒有接受。請直接到 IG 回。" },
      ]);
      expect(only("deleteMessage")).toEqual([]);
    });

    it("confirms in words, and clears the tapped buttons, when there is no notice left to show it on", async () => {
      await escalated();
      const { promptId } = await askedToType();
      for (const key of [...fakeRedis.store.keys()]) {
        if (key.startsWith("triage:notice:")) fakeRedis.store.delete(key);
      }
      await typed(OWN_WORDS, promptId);

      expect(sent()).toEqual([["ig_1", "user_1", OWN_WORDS]]);
      expect(only("editMessageReplyMarkup")).toEqual([{ chat_id: "987", message_id: NOTICE }]);
      expect(only("sendMessage")).toEqual([{ chat_id: "987", text: "已送出 ✅" }]);
      expect(only("deleteMessage")).toEqual([]);
    });

    it("asks without the copy formatting if Telegram will not take the formatted question", async () => {
      await escalated();
      fetchMock.mockImplementation(async (url: string, init: { body: string }) =>
        String(url).endsWith("/sendMessage") && "entities" in JSON.parse(init.body)
          ? { ok: false, status: 400 }
          : { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 321 } }) }
      );
      await tap("e");

      const asked = only("sendMessage");
      expect(asked).toHaveLength(2);
      expect(asked[1]).not.toHaveProperty("entities");
      expect(asked[1].text).toBe(asked[0].text);
      expect(asked[1].reply_markup).toEqual(asked[0].reply_markup);
      expect(answers()).toEqual([{ callback_query_id: "q1" }]);

      // The owner's reply to that plain question is still sent.
      fetchMock.mockClear();
      await typed(OWN_WORDS, 321);
      expect(sent()).toEqual([["ig_1", "user_1", OWN_WORDS]]);
    });

    it("tells the owner when the question could not be posted", async () => {
      await escalated();
      fetchMock.mockImplementation(async (url: string) =>
        String(url).endsWith("/sendMessage")
          ? { ok: false, status: 400 }
          : { ok: true, status: 200, json: async () => ({ ok: true, result: true }) }
      );
      await tap("e");
      expect(answers()).toEqual([
        { callback_query_id: "q1", text: "現在沒辦法開修改，請再按一次。", show_alert: true },
      ]);
    });

    it("does not offer to edit a draft that is no longer waiting", async () => {
      await escalated();
      await tap("x");
      fetchMock.mockClear();
      await tap("e");
      expect(only("sendMessage")).toEqual([]);
      expect(answers()[0].text).toBe("這則已經處理過了，沒有再發");
    });
  });

  describe("messages that are not answers to its question", () => {
    it("ignores an ordinary message to the bot", async () => {
      await escalated();
      await typed("哈囉", undefined);
      expect(sent()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("ignores a reply to some other message, the notice included", async () => {
      await escalated();
      await typed(OWN_WORDS, NOTICE);
      await typed(OWN_WORDS, 4242);
      expect(sent()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("ignores a stranger who replies with the right message id", async () => {
      await escalated();
      await tap("e");
      fetchMock.mockClear();
      await typed(OWN_WORDS, NOTICE + 1, { chat: 555 });
      expect(sent()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(row().replyText).toBe(DRAFT);
    });
  });

  describe("when something breaks", () => {
    it("never throws, whatever the database does", async () => {
      await escalated();
      mockPrisma.triageLog.findUnique.mockRejectedValueOnce(new Error("db down"));
      await expect(tap("y")).resolves.toBeUndefined();
      expect(sent()).toEqual([]);
    });

    it("never writes the bot token to the log", async () => {
      await escalated();
      fetchMock.mockRejectedValue(
        new Error(`request to https://api.telegram.org/bot${TOKEN}/answerCallbackQuery failed`)
      );
      await expect(tap("s")).resolves.toBeUndefined();
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain("SECRET");
    });

    it("has sent the reply even if the notice cannot be redrawn afterwards", async () => {
      await escalated();
      fetchMock.mockResolvedValue({ ok: false, status: 500 });
      await tap("y");
      expect(sent()).toEqual([["ig_1", "user_1", DRAFT]]);
      expect(row().action).toBe("SENT_BY_OWNER");
    });
  });
});
