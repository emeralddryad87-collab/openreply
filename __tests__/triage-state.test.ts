import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for the handful of Redis commands the triage markers use, with
 * real NX and expiry behaviour so the tests exercise the actual logic.
 */
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

import {
  claimNotifySlot,
  clearAskedHuman,
  getLastOwnerReplyAt,
  getWorkerCapabilities,
  handedOffRecently,
  markAskedHuman,
  markBotActivity,
  markHandoff,
  ownerRepliedRecently,
  recordEcho,
  recordWorkerCapabilities,
  wasAskedHuman,
} from "@/lib/triage/state";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  fakeRedis.store.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
});

describe("telling the owner's replies from the bot's", () => {
  it("treats an echo as the owner's when the bot sent nothing", async () => {
    expect(await recordEcho("ig_1", "user_1")).toBe(true);
    expect(await ownerRepliedRecently("ig_1", "user_1")).toBe(true);
  });

  it("treats an echo as the bot's own right after the bot sends", async () => {
    await markBotActivity("ig_1", "user_1");
    expect(await recordEcho("ig_1", "user_1")).toBe(false);
    expect(await ownerRepliedRecently("ig_1", "user_1")).toBe(false);
  });

  it("covers every message of a multi-part send, not just the first echo", async () => {
    await markBotActivity("ig_1", "user_1");
    expect(await recordEcho("ig_1", "user_1")).toBe(false);
    expect(await recordEcho("ig_1", "user_1")).toBe(false);
  });

  it("sees the owner again once the bot's send is a few minutes old", async () => {
    await markBotActivity("ig_1", "user_1");
    vi.advanceTimersByTime(4 * MINUTE);
    expect(await recordEcho("ig_1", "user_1")).toBe(true);
  });

  it("keeps conversations and accounts apart", async () => {
    await markBotActivity("ig_1", "user_1");
    expect(await recordEcho("ig_1", "user_2")).toBe(true);
    expect(await ownerRepliedRecently("ig_1", "user_1")).toBe(false);
    expect(await ownerRepliedRecently("ig_2", "user_2")).toBe(false);
  });

  it("stays out of the conversation for 24 hours after the owner's reply, then returns", async () => {
    await recordEcho("ig_1", "user_1");
    vi.advanceTimersByTime(23 * HOUR);
    expect(await ownerRepliedRecently("ig_1", "user_1")).toBe(true);
    vi.advanceTimersByTime(2 * HOUR);
    expect(await ownerRepliedRecently("ig_1", "user_1")).toBe(false);
  });

  it("remembers when the owner's reply was last noticed, per account", async () => {
    expect(await getLastOwnerReplyAt("ig_1")).toBeNull();
    await recordEcho("ig_1", "user_1");
    expect(await getLastOwnerReplyAt("ig_1")).toBe("2026-11-20T10:00:00.000Z");
    expect(await getLastOwnerReplyAt("ig_2")).toBeNull();
  });

  it("does not count the bot's own echo as a noticed owner reply", async () => {
    await markBotActivity("ig_1", "user_1");
    await recordEcho("ig_1", "user_1");
    expect(await getLastOwnerReplyAt("ig_1")).toBeNull();
  });
});

describe("the 'do you want the owner?' question", () => {
  it("stays open for half a day, per conversation", async () => {
    expect(await wasAskedHuman("ig_1", "user_1")).toBe(false);
    await markAskedHuman("ig_1", "user_1");
    expect(await wasAskedHuman("ig_1", "user_1")).toBe(true);
    expect(await wasAskedHuman("ig_1", "user_2")).toBe(false);
    vi.advanceTimersByTime(11 * HOUR);
    expect(await wasAskedHuman("ig_1", "user_1")).toBe(true);
    vi.advanceTimersByTime(2 * HOUR);
    expect(await wasAskedHuman("ig_1", "user_1")).toBe(false);
  });

  it("closes as soon as it is answered", async () => {
    await markAskedHuman("ig_1", "user_1");
    await clearAskedHuman("ig_1", "user_1");
    expect(await wasAskedHuman("ig_1", "user_1")).toBe(false);
  });
});

describe("handing a conversation to the owner", () => {
  it("keeps the bot out of that conversation for 24 hours", async () => {
    expect(await handedOffRecently("ig_1", "user_1")).toBe(false);
    await markHandoff("ig_1", "user_1");
    expect(await handedOffRecently("ig_1", "user_1")).toBe(true);
    expect(await handedOffRecently("ig_1", "user_2")).toBe(false);
    vi.advanceTimersByTime(23 * HOUR);
    expect(await handedOffRecently("ig_1", "user_1")).toBe(true);
    vi.advanceTimersByTime(2 * HOUR);
    expect(await handedOffRecently("ig_1", "user_1")).toBe(false);
  });

  it("is not the same thing as the owner having replied", async () => {
    await markHandoff("ig_1", "user_1");
    expect(await ownerRepliedRecently("ig_1", "user_1")).toBe(false);
  });
});

describe("claimNotifySlot", () => {
  it("allows one notice per person inside the cooldown", async () => {
    expect(await claimNotifySlot("ig_1", "user_1")).toBe(true);
    expect(await claimNotifySlot("ig_1", "user_1")).toBe(false);
    expect(await claimNotifySlot("ig_1", "user_2")).toBe(true);
  });

  it("allows another notice once the cooldown has passed", async () => {
    await claimNotifySlot("ig_1", "user_1");
    vi.advanceTimersByTime(31 * MINUTE);
    expect(await claimNotifySlot("ig_1", "user_1")).toBe(true);
  });
});

describe("worker capabilities", () => {
  it("reads back what the worker reported", async () => {
    await recordWorkerCapabilities({ ai: true, notify: false });
    expect(await getWorkerCapabilities()).toEqual({
      ai: true,
      notify: false,
      checkedAt: "2026-11-20T10:00:00.000Z",
    });
  });

  it("is null when no worker has reported lately", async () => {
    expect(await getWorkerCapabilities()).toBeNull();
    await recordWorkerCapabilities({ ai: true, notify: true });
    vi.advanceTimersByTime(3 * MINUTE);
    expect(await getWorkerCapabilities()).toBeNull();
  });

  it("is null when the stored value is not readable", async () => {
    fakeRedis.store.set("triage:worker:capabilities", { value: "{oops", expiresAt: null });
    expect(await getWorkerCapabilities()).toBeNull();
  });
});
