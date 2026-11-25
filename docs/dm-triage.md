# DM triage

Handles the inbound DMs that no campaign keyword claimed.

| The sender wrote | What happens |
|---|---|
| "no questions", "all clear", "got it" (沒問題, 都很清楚, 都理解, 了解, …) | fixed reply: 好的哦，如果有任何問題都歡迎來問我~ |
| "thanks" (謝謝, thanks, …) | fixed reply: 不用客氣~ |
| a campaign keyword, or a plain request for it (PDF, 外掛, 請問外掛呢？) | answered by that campaign itself — follow gate, link button and follow-up — as if they had commented it. Once a day per person; a second ask goes to the owner. "外掛打不開" is not a request and goes to the owner too. |
| "I followed you" (已追蹤, 追蹤了, …), typed instead of tapping the button | fixed reply: 追蹤後請按上一則訊息的按鈕，就會收到連結～ |
| a bare acknowledgement (可以, 好的, ok, 👍) | the same sign-off line: it is nearly always the answer to "does that make sense?" |
| "not hard", "will try later" (不會, 還好, 等下才試試, 還沒試) | the same sign-off line |
| "I do not get it", "it is hard" (不知道如何使用, 看不懂, 覺得難), with no word about which part | fixed reply: 請問你是哪一步卡住了呢？可以截圖給我看嘛？ Still stuck after that: the owner is notified. |
| new to AI tools and asks where to begin | fixed reply: 你可以先想一下你現在目前遇到最麻煩可是又最繁雜的手頭工作… |
| asks whether it can be done on a phone | fixed reply: 這個要用電腦才能做哦，手機目前沒辦法～ |
| a picture, video, voice note or file | no reply; the owner is notified (nobody else can look at it) |
| the other account's own auto-reply (an away message, a bot menu, "此為系統自動訊息") | nothing: no reply and no notice. It is still written to the log. |
| a question the page they were sent answers | an answer written from that page's steps, ending with （自動回覆） |
| "is this an AI?" / "is this the real person?" | always: 是的，這是 AI 自動回覆哦～你是想找本人嗎？ A yes hands the conversation to the owner; a no gets the sign-off line. |
| asks for the owner in person | the owner is notified; fixed reply: 好的，已經幫你轉給本人了～ Nothing more is sent to that person for 24 hours. |
| collaboration, the owner's courses, anything else | no reply; the owner is notified |

The fixed lines live in `lib/triage/config.ts`. Only the page answer is written
by the model.

Every kind is recognised two ways. A phrase list catches the common wordings
without calling a model, in every mode. In 全開 and 試跑 the model also
recognises wordings the list does not know ("目前沒有什麼問題喔，都清楚"); it
only chooses the kind and never writes those replies, and a sign-off that is
long or asks anything still goes to the owner.

It is off for every account until it is switched on, and while it is off the app
sends exactly what it sent before.

## The switch

**Settings → 私訊自動分類.** One mode per Instagram account, stored in the
database (`TriageSetting`), changeable by workspace owners and admins. A change
takes effect within about 15 seconds; no redeploy.

| Mode | Sends fixed replies | Sends page answers | Notifies the owner |
|---|---|---|---|
| 關閉 `off` (default) | no | no | no |
| 試跑 `dry_run` | no, logged only | no, logged only | yes |
| 只開固定回覆 `canned` | yes | no (the owner is notified instead) | yes |
| 全開 `full` | yes | yes | yes |

Roll out in that order. The same panel shows what to check between steps:

- whether the worker has a model key and a notification channel, and whether a
  test notice actually arrived;
- how many pages the model can answer from;
- when a hand-typed reply from the owner was last noticed — reply to any DM by
  hand and this must update, otherwise the "owner is replying" guard is blind;
- the last 24 hours of decisions and the latest 20 messages with what was (or
  would have been) sent.

`npx tsx scripts/triage-report.ts [--hours 24]` prints the same log from a shell.

## Guard rails

- Only people this account sent a campaign DM to in the last
  `TRIAGE_ELIGIBLE_DAYS` (default 14) are eligible. Everyone else is not replied
  to, not notified about and not logged.
- Replies to Stories are left alone.
- Each message is claimed with a log row before anything is sent, so a repeated
  job can never send twice.
- After the owner replies to someone by hand, nothing is sent to that person for
  24 hours. A real question from them in that time is still flagged to the owner.
- The same fixed line is not sent to the same person twice within 24 hours, so
  "了解" → line → "好的" → line cannot loop. (The AI disclosure is the exception:
  it is given every time it is asked for.)
- One person gets at most `TRIAGE_DAILY_REPLY_CAP` (default 6) automatic replies
  per 24 hours. A real question that hits the cap goes to the owner; a courtesy
  that hits it is simply not sent.
- The model is shown the follow-up question the campaign asks ("does that make
  sense?"), so a one-word DM can be read as the answer to it.
- The model may only answer from the page text; "not on the page" always goes to
  the owner. An answer containing a link, domain or file name that is not on the
  page is thrown away.
- A failed send or model call is logged and never retried.

### How the owner's replies are told apart from the bot's

Instagram echoes every message the account sends, whoever typed it. The worker
marks a conversation as bot-active for three minutes each time it is about to
send; an echo inside that window is the bot's, any other echo is the owner's.
Handing a message to the owner sends nothing and so sets no mark, which is what
lets the owner's answer be recognised. The mark is written whether or not triage
is on, so there is no blind moment right after it is switched on.

## Setup

1. Deploy. The migration `add_dm_triage` adds three tables (`TriageSetting`,
   `TriageLog`, `TriagePage`) and changes no existing one.
2. Load the pages the model may answer from:
   `npx tsx scripts/triage-sync-pages.ts --pages <dir> --packs <dir> [--extra <dir>] --write`
   (run without `--write` first to preview). Re-run after adding or editing a page.
   A campaign is matched to its page by the link it sends, so every campaign
   needs a page with that exact link: `--packs` supplies links for the files in
   `--pages`, and `--extra` is a folder of pages saved straight from their
   published link, with a `urls.json` mapping file name to link.
3. Set these on the **worker** only — the web app needs none of them:
   - notices: `TRIAGE_TELEGRAM_BOT_TOKEN` and `TRIAGE_TELEGRAM_CHAT_ID`
   - page answers: `GROQ_API_KEY` and `TRIAGE_AI_MODEL`
4. Switch the account to 試跑 on the Settings page and review before going further.

## Notices

Telegram, from a bot the owner creates:

1. In Telegram, message `@BotFather`, send `/newbot`, and keep the token it gives.
2. Open the new bot's chat and press **Start**.
3. Open `https://api.telegram.org/bot<token>/getUpdates` in a browser and read
   `chat.id` from the reply.
4. Put the token and the id in the worker's environment.

The first time the worker sees a token and chat id it sends one test message
("通知接好了") and the Settings page shows whether Telegram accepted it. A
rejected test is retried every ten minutes; a delivered one is never repeated.

One person is one message in the owner's chat. Everything they send within a
day is stacked into it, newest at the bottom, each line with its time, and the
message ends with one link to the sender's profile. No reasons, no extra text:

    IG 私訊需要你回：some_fan
    15:53「出現這個，裝不了」
    16:38「我好像裝完了」
    https://www.instagram.com/some_fan/

Within half an hour of the last ring, a new line is added to the message that
is already there; Telegram does not ring for an edit. After that, the stacked
message is sent afresh and the old copy deleted, so the phone rings once and
the message is at the bottom of the chat again. Someone asking for the owner by
name always rings. Times are written on `TRIAGE_TIMEZONE` (default Asia/Taipei).

Instead of Telegram, `TRIAGE_NOTIFY_URL` (with optional `TRIAGE_NOTIFY_SECRET`,
sent as the `x-triage-secret` header) receives each notice as a JSON `POST` with
`text`, `senderId`, `senderName`, `messageText` and `reason`, at most once per
person every 30 minutes (a POST cannot be edited afterwards). Telegram wins when
both are set.

## Meta's rules this stays inside

Replies go only to people who messaged first, within 24 hours of their last
message, through the official Instagram messaging API. A human is always
reachable, and model-written replies are labelled as automated.
