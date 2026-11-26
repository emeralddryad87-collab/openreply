import { prisma } from "@/lib/db/client";
import { sendDirectMessage } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import {
  DM_CHAR_LIMIT,
  DRAFT_SEND_WINDOW_SECONDS,
  NOTICE_MAX_LINES,
  getNotifyConfig,
} from "@/lib/triage/config";
import { dropPendingDrafts } from "@/lib/triage/draft-store";
import { draftKeyboard, noticeName, telegram, updateNotice } from "@/lib/triage/notify";
import {
  getEditPrompt,
  getNoticeThread,
  markBotActivity,
  markOffered,
  saveEditPrompt,
  type NoticeLine,
} from "@/lib/triage/state";

/**
 * What the buttons under a notice do.
 *
 * A notice that needs the owner can carry a draft reply. This is the only
 * place a draft turns into a message, and it happens on one condition: the
 * owner said so, from their own Telegram chat.
 *
 *   送出      asks once more ("確定送出" / "取消"); the second tap sends the draft
 *   修改      the bot asks for the owner's own wording; their reply to that
 *             message is sent in place of the draft
 *   不用回    drops the draft
 *
 * Guard rails:
 *   - Only the chat the notices go to may act. A tap or a message from any
 *     other chat is ignored without a word.
 *   - A draft is sent at most once: the log row is claimed in the database
 *     before anything goes out, so a double tap, a redelivered update or two
 *     workers cannot send it twice.
 *   - A failed send is not retried. Instagram sometimes reports an error after
 *     delivering, so a retry could repeat the message; the notice says it did
 *     not go out and the owner replies in Instagram.
 *   - A draft older than Instagram's 24-hour reply window is not sent.
 *   - A tap that arrives late — the worker was restarting — does not send; the
 *     owner is asked to tap again, in case they have answered by hand since.
 *
 * A draft may offer one of the owner's tutorials ("I made one on that, shall
 * I send you the link?"). Sending it as drafted opens that offer: the
 * person's "yes" then gets the tutorial through its campaign.
 *
 * What goes out this way counts as the bot's sending, not as the owner typing
 * in Instagram: triage keeps looking after the conversation, so the next
 * message from that person gets its fixed reply or a new draft as usual.
 *
 * Nothing here throws.
 */

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    /** Unix time, in seconds. */
    date?: number;
    chat?: { id?: number | string };
    text?: string;
    reply_to_message?: { message_id?: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id?: number; chat?: { id?: number | string } };
  };
}

const CALLBACK = /^t:([synex]):([A-Za-z0-9]{8,40})$/;
// A typed reply that reaches us later than this is not sent: too much may have
// happened in the conversation since.
const LATE_REPLY_SECONDS = 5 * 60;

// Shown to the owner in Telegram, so in their language.
const SAY = {
  confirm: "再按一次「確定送出」才會發",
  sent: "已送出 ✅",
  gone: "這則已經處理過了，沒有再發",
  dropped: "好，這則不回",
  expired: "這則超過 24 小時了，Instagram 不讓這樣回。請直接到 IG 回。",
  tapAgain: "系統剛重新啟動，為了避免誤發，請再按一次「確定送出」。",
  textOnly: "只能傳文字哦。請再回覆一次上面那則，打上要回的內容。",
  lateReply: "這則回覆隔太久才收到，沒有發出去。要發的話請再回覆一次上面那則。",
  noToken: "這個帳號沒有可用的 Instagram 授權",
  cannotAsk: "現在沒辦法開修改，請再按一次。",
} as const;

const notSent = (why: string) => `沒送出去：${why}。請直接到 IG 回。`;

type Target = { instagramAccountId: string; senderId: string };

/** `logId` is the row that was acted on, which may be a newer one than asked for. */
type SendResult =
  | ({ status: "sent"; logId: string; text: string } & Target)
  | ({ status: "failed"; logId: string; text: string; why: string } & Target)
  | ({ status: "expired"; logId: string } & Target)
  | { status: "gone" };

/** A reason short and plain enough for a pop-up on a phone. */
function plainFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === SAY.noToken) return message;
  if (/outside of allowed window|2534022/i.test(message)) {
    return "超過 24 小時，Instagram 不讓這樣回了";
  }
  return "Instagram 沒有接受";
}

/**
 * Send a reply the owner approved: the stored draft, or the owner's own words
 * in its place. The row is claimed first, so this can succeed once per draft.
 */
async function sendReply(
  logId: string,
  ownWords: string | null,
  followNewer = true
): Promise<SendResult> {
  const row = await prisma.triageLog.findUnique({
    where: { id: logId },
    select: {
      instagramAccountId: true,
      action: true,
      replyText: true,
      pageKey: true,
      senderId: true,
      createdAt: true,
      instagramAccount: { select: { instagramId: true, accessToken: true } },
    },
  });
  if (!row) return { status: "gone" };

  if (row.action !== "ESCALATED" || !row.replyText) {
    // The owner's own words are meant for the person, not for one particular
    // draft. If a newer message replaced the draft while they were typing,
    // their reply goes out against the draft that is waiting now.
    if (ownWords === null || !followNewer) return { status: "gone" };
    const waiting = await prisma.triageLog.findFirst({
      where: {
        instagramAccountId: row.instagramAccountId,
        senderId: row.senderId,
        action: "ESCALATED",
        replyText: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return waiting && waiting.id !== logId
      ? sendReply(waiting.id, ownWords, false)
      : { status: "gone" };
  }

  const target: Target = {
    instagramAccountId: row.instagramAccount.instagramId,
    senderId: row.senderId,
  };
  const stillPending = { id: logId, action: "ESCALATED", replyText: { not: null } };

  if (Date.now() - row.createdAt.getTime() > DRAFT_SEND_WINDOW_SECONDS * 1000) {
    await prisma.triageLog.updateMany({ where: stillPending, data: { replyText: null } });
    return { status: "expired", logId, ...target };
  }

  const text = (ownWords ?? row.replyText).trim().slice(0, DM_CHAR_LIMIT);
  if (!text) return { status: "gone" };

  const claim = await prisma.triageLog.updateMany({
    where: stillPending,
    data: { action: "SENT_BY_OWNER", replyText: text },
  });
  if (claim.count !== 1) return { status: "gone" };

  try {
    if (!row.instagramAccount.accessToken) throw new Error(SAY.noToken);
    // So the echo of this message is not read as the owner typing in
    // Instagram, which would silence triage for this person for a day. Losing
    // the mark is not a reason to hold the owner's reply back.
    await markBotActivity(target.instagramAccountId, target.senderId).catch(() => {});
    await sendDirectMessage(
      decryptToken(row.instagramAccount.accessToken),
      target.instagramAccountId,
      target.senderId,
      text
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : "發送失敗";
    await prisma.triageLog
      .update({ where: { id: logId }, data: { action: "FAILED", reason: detail } })
      .catch(() => {});
    return { status: "failed", logId, text, why: plainFailure(error), ...target };
  }

  // A draft that offered one of the owner's tutorials, sent as drafted: the
  // offer is open, and the person's "yes" will send that tutorial (see
  // lib/triage/index.ts). The owner's own words may offer something else or
  // nothing, so they open no offer. Housekeeping: the reply is already out.
  if (ownWords === null && row.pageKey) {
    await markOffered(target.instagramAccountId, target.senderId, row.pageKey).catch(
      () => {}
    );
  }

  // The person has their answer: a draft still waiting for one of their
  // earlier messages is answered with it. Housekeeping only — the reply is
  // already out, whatever happens here.
  await dropPendingDrafts({ accountId: row.instagramAccountId, senderId: row.senderId }).catch(
    () => 0
  );
  return { status: "sent", logId, text, ...target };
}

/** Put what happened to the draft into the person's notice. */
function settleNotice(
  target: Target,
  logId: string,
  line: Pick<NoticeLine, "text" | "kind"> | null
): Promise<number | null> {
  return updateNotice(target.instagramAccountId, target.senderId, (thread) => ({
    ...thread,
    // A newer draft may have taken this one's place; that one stays.
    draft: thread.draft?.logId === logId ? null : thread.draft,
    lines: line
      ? [...thread.lines, { at: Date.now(), ...line }].slice(-NOTICE_MAX_LINES)
      : thread.lines,
  }));
}

async function onButton(
  query: NonNullable<TelegramUpdate["callback_query"]>,
  token: string,
  chatId: string,
  late: boolean
): Promise<void> {
  const pressedMessageId = query.message?.message_id;
  const parsed = CALLBACK.exec(query.data ?? "");
  // Not the owner's chat, or not one of our buttons: no reaction at all.
  if (
    String(query.message?.chat?.id ?? "") !== chatId ||
    typeof pressedMessageId !== "number" ||
    !parsed
  ) {
    return;
  }
  const [, op, logId] = parsed;

  const answer = (text?: string, alert = false) =>
    telegram(token, "answerCallbackQuery", {
      callback_query_id: query.id,
      ...(text ? { text } : {}),
      ...(alert ? { show_alert: true } : {}),
    });
  // With no keyboard given, the buttons are removed from the tapped message.
  const setButtons = (keyboard?: ReturnType<typeof draftKeyboard>) =>
    telegram(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: pressedMessageId,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  /** The notice was redrawn somewhere else, or not at all: clear what was tapped. */
  const tidy = async (redrawn: number | null) => {
    if (redrawn !== pressedMessageId) await setButtons();
  };

  const pending = async () => {
    const row = await prisma.triageLog.findUnique({
      where: { id: logId },
      select: {
        action: true,
        replyText: true,
        senderId: true,
        instagramAccount: { select: { instagramId: true } },
      },
    });
    if (!row || row.action !== "ESCALATED" || !row.replyText) return null;
    return {
      draft: row.replyText,
      instagramAccountId: row.instagramAccount.instagramId,
      senderId: row.senderId,
    };
  };

  if (op === "y") {
    if (late) {
      await answer(SAY.tapAgain, true);
      return;
    }
    const result = await sendReply(logId, null);
    if (result.status === "sent") {
      await tidy(await settleNotice(result, logId, { text: result.text, kind: "out" }));
      await answer(SAY.sent);
    } else if (result.status === "failed") {
      await tidy(await settleNotice(result, logId, { text: result.text, kind: "failed" }));
      await answer(notSent(result.why), true);
    } else if (result.status === "expired") {
      await tidy(await settleNotice(result, logId, null));
      await answer(SAY.expired, true);
    } else {
      await setButtons();
      await answer(SAY.gone);
    }
    return;
  }

  const draft = await pending();
  if (!draft) {
    await setButtons();
    await answer(SAY.gone);
    return;
  }

  if (op === "s") {
    await setButtons(draftKeyboard(logId, "confirm"));
    await answer(SAY.confirm);
    return;
  }

  if (op === "n") {
    await setButtons(draftKeyboard(logId));
    await answer();
    return;
  }

  if (op === "x") {
    await prisma.triageLog.updateMany({
      where: { id: logId, action: "ESCALATED", replyText: { not: null } },
      data: { replyText: null },
    });
    await tidy(await settleNotice(draft, logId, null));
    await answer(SAY.dropped);
    return;
  }

  // "修改": ask for the owner's own wording. The draft is shown in a form the
  // phone copies with one tap, so it can be pasted and adjusted.
  const thread = await getNoticeThread(draft.instagramAccountId, draft.senderId);
  const who = noticeName({ senderName: thread?.senderName, senderId: draft.senderId });
  const intro = `回覆這則訊息，打上你要傳給 ${who} 的內容，我會直接幫你送出。\n\n草稿（點一下可以複製）：\n`;
  const question = {
    chat_id: chatId,
    text: intro + draft.draft,
    reply_markup: { force_reply: true, input_field_placeholder: "打上要回的內容" },
  };
  const prompt =
    (await telegram(token, "sendMessage", {
      ...question,
      // Offsets are in UTF-16 code units, which is how a JS string counts.
      entities: [
        {
          type: draft.draft.includes("\n") ? "pre" : "code",
          offset: intro.length,
          length: draft.draft.length,
        },
      ],
    })) ??
    // The copy-with-a-tap formatting is a nicety; the question is not.
    (await telegram(token, "sendMessage", question));
  const promptId = prompt?.result?.message_id;
  if (typeof promptId !== "number") {
    await answer(SAY.cannotAsk, true);
    return;
  }
  await saveEditPrompt(chatId, promptId, { logId, noticeMessageId: pressedMessageId });
  await answer();
}

async function onMessage(
  message: NonNullable<TelegramUpdate["message"]>,
  token: string,
  chatId: string
): Promise<void> {
  // Only the owner's chat, and only a reply to a message that asked for one.
  if (String(message.chat?.id ?? "") !== chatId) return;
  const promptId = message.reply_to_message?.message_id;
  if (typeof promptId !== "number") return;
  const prompt = await getEditPrompt(chatId, promptId);
  if (!prompt) return;

  const say = (text: string) => telegram(token, "sendMessage", { chat_id: chatId, text });
  const remove = (messageId: number | undefined | null) =>
    typeof messageId === "number"
      ? telegram(token, "deleteMessage", { chat_id: chatId, message_id: messageId }).catch(
          () => null
        )
      : null;

  const text = (message.text ?? "").trim();
  if (!text) {
    await say(SAY.textOnly);
    return;
  }
  if (text.length > DM_CHAR_LIMIT) {
    await say(
      `太長了（${text.length} 字，Instagram 一則最多 ${DM_CHAR_LIMIT} 字）。請縮短後再回覆一次上面那則。`
    );
    return;
  }
  if (
    typeof message.date === "number" &&
    Date.now() / 1000 - message.date > LATE_REPLY_SECONDS
  ) {
    await say(SAY.lateReply);
    return;
  }

  const result = await sendReply(prompt.logId, text);
  if (result.status === "gone") {
    await say(SAY.gone);
    return;
  }
  if (result.status === "expired") {
    await settleNotice(result, result.logId, null);
    await say(SAY.expired);
    return;
  }
  if (result.status === "failed") {
    await settleNotice(result, result.logId, { text: result.text, kind: "failed" });
    await say(notSent(result.why));
    return;
  }

  const redrawn = await settleNotice(result, result.logId, { text: result.text, kind: "out" });
  if (redrawn !== null) {
    // The notice shows the reply now; the question and its answer would only
    // clutter the chat, which keeps to one message per person.
    await remove(promptId);
    await remove(message.message_id);
    return;
  }
  // No notice left to show it on: say so, and clear the buttons that were tapped.
  if (typeof prompt.noticeMessageId === "number") {
    await telegram(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: prompt.noticeMessageId,
    });
  }
  await say(SAY.sent);
}

/**
 * Act on one update from the notification bot. `late` marks an update that
 * was waiting while the worker was away (see telegram-updates.ts).
 */
export async function handleTelegramUpdate(
  update: TelegramUpdate,
  options: { late?: boolean } = {}
): Promise<void> {
  const { telegramBotToken, telegramChatId } = getNotifyConfig();
  if (!telegramBotToken || !telegramChatId) return;
  try {
    if (update.callback_query) {
      await onButton(update.callback_query, telegramBotToken, telegramChatId, options.late ?? false);
    } else if (update.message) {
      await onMessage(update.message, telegramBotToken, telegramChatId);
    }
  } catch (error) {
    // The kind of failure only: a network error can quote the request URL,
    // and that URL contains the bot token.
    const name = error instanceof Error ? error.name : "Error";
    console.error(`[Triage] Could not act on a Telegram update (${name})`);
  }
}
