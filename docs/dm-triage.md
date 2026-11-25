# DM triage

Handles the inbound DMs that no campaign keyword claimed.

| The sender wrote | What happens |
|---|---|
| "no questions", "all clear", "got it" (沒問題, 都很清楚, 都理解, 了解, …) | fixed reply: 好的哦，如果有任何問題都歡迎來問我~ |
| "thanks" (謝謝, thanks, …) | fixed reply: 不用客氣~ 有問題都可以問我 — or just 不用客氣~ when a line that already invited questions went out in the last ten minutes |
| a campaign keyword, or a plain request for it (PDF, 外掛, 請問外掛呢？) | answered by that campaign itself — follow gate, link button and follow-up — as if they had commented it. Once a day per person; a second ask goes to the owner. "外掛打不開" is not a request and goes to the owner too. |
| "I followed you" (已追蹤, 追蹤了, …), typed instead of tapping the button | fixed reply: 追蹤後請按上一則訊息的按鈕，就會收到連結～ |
| "I never got the link", "there is no button" (沒收到, 沒有按鈕, 找不到連結, …) | their latest running campaign is sent again, the way a tap on its button would send it: a confirmed follower gets the link, anyone else gets the follow prompt and its button. Once a day per person and campaign; a second time goes to the owner. |
| a bare acknowledgement (可以, 好的, ok, 👍) | the same sign-off line: it is nearly always the answer to "does that make sense?" |
| "not hard", "will try later" (不會, 還好, 等下才試試, 還沒試) | the same sign-off line |
| "I do not get it", "it is hard" (不知道如何使用, 看不懂, 覺得難), with no word about which part | fixed reply: 請問你是哪一步卡住了呢？可以截圖給我看嘛？ Still stuck after that: the owner is notified. |
| new to AI tools and asks where to begin | fixed reply: 你可以先想一下你現在目前遇到最麻煩可是又最繁雜的手頭工作… |
| asks whether it can be done on a phone | fixed reply: 這個要用電腦才能做哦，手機目前沒辦法～ |
| their Claude quota keeps running out | an offer: 我有做過省額度的教學哦，如果要的話我可以把連結傳給你～ A yes sends the campaign of the quota tutorial (`QUOTA_TUTORIAL_PAGE_KEY`), with the same follow check as above. Not offered to someone who already holds that page, or when its campaign is not running: the owner is notified instead. |
| a picture, video, voice note or file | no reply; the owner is notified (nobody else can look at it) |
| the other account's own auto-reply (an away message, a bot menu, "此為系統自動訊息") | nothing: no reply and no notice. It is still written to the log. |
| a question the page they were sent, or one of the owner's standing answers, settles | an answer in one sentence, written from those only, sent as it is (no "（自動回覆）" tag) |
| "is this an AI?" / "is this the real person?" | always: 是的，這是 AI 自動回覆哦～你是想找本人嗎？ A yes hands the conversation to the owner; a no gets the sign-off line. |
| asks for the owner in person | the owner is notified; fixed reply: 好的，已經幫你轉給本人了～ Nothing more is sent to that person for 24 hours. |
| collaboration, the owner's courses, anything else | no reply; the owner is notified, with a draft reply they can send from the notice (see "Drafts and the buttons under a notice") |

The fixed lines live in `lib/triage/config.ts`. Of what is sent automatically,
only the answer to a question is written by the model. A draft for the owner is
model-written too, and goes out only if the owner sends it.

The owner's standing answers live in `lib/triage/facts.ts`: the handful of
questions people ask most that no page answers (does the free plan work, is Pro
enough, Windows or Mac, what Claude Code is, …), each with the reply the owner
approved and a note of where the fact was checked. The model is given them as
the only thing it may say on those subjects. Plans and prices change; that file
is the one place to edit when they do.

Every kind is recognised two ways. A phrase list catches the common wordings
without calling a model, in every mode. In 全開 and 試跑 the model also
recognises wordings the list does not know ("目前沒有什麼問題喔，都清楚"); it
only chooses the kind and never writes those replies, and a sign-off that is
long or asks anything still goes to the owner.

It is off for every account until it is switched on, and while it is off the app
sends exactly what it sent before.

## A short wait, and the conversation so far

A typed message is not answered the instant it arrives. The worker claims it
and comes back after `TRIAGE_REPLY_DELAY_SECONDS` (default 20; 0 answers at
once). Messages the same person sends inside that wait are answered together,
once, by the turn of the last one: the earlier rows are logged as `MERGED`, and
the model reads all of it as one message, a line each. The other account's
away message, if one lands in between, is set aside on its own. Pictures are
not held back (nothing is sent for them, and the owner should hear at once),
nor are button taps or the first DM after a comment.

The model is shown the earlier turns of the day: what the person wrote, and
what actually went out in reply (automatic replies and drafts the owner sent;
not what the owner typed by hand, which this app never sees). That is what lets
it read "the 600 one" as the rest of a question about plans, and what keeps a
sign-off from closing a question nobody answered.

Two rules about sign-off lines follow from the same idea and need no model:

- While a question of the same person is still waiting for the owner (handed
  over in the last 30 minutes), a "thanks" or "ok" gets no line at all.
- "Feel free to ask" is not said twice in a row: see the thanks row above.

## The switch

**Settings → 私訊自動分類.** One mode per Instagram account, stored in the
database (`TriageSetting`), changeable by workspace owners and admins. A change
takes effect within about 15 seconds; no redeploy.

| Mode | Sends fixed replies | Sends page answers | Notifies the owner | Drafts a reply for the owner |
|---|---|---|---|---|
| 關閉 `off` (default) | no | no | no | no |
| 試跑 `dry_run` | no, logged only | no, logged only | yes | no |
| 只開固定回覆 `canned` | yes | no (the owner is notified instead) | yes | no |
| 全開 `full` | yes | yes | yes | yes |

Roll out in that order. The same panel shows what to check between steps:

- whether the worker has a model key and a notification channel, and whether a
  test notice actually arrived;
- whether the buttons under a notice are being heard;
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
- The model may answer from the page text, the owner's standing answers and the
  earlier turns, and may reason from them ("the page lists Mac commands, so a
  Mac works"). It may not recall: a price, plan, version, command or link that
  is not written in one of those goes to the owner. An answer containing a
  link, domain or file name that is on neither the page nor the standing
  answers is thrown away.
- A screenshot is asked for only when the person says something went wrong,
  never in reply to a "can it / does it / how much" question.
- A link is re-sent once a day per person and campaign, and only a confirmed
  follower gets it: nobody tapped "I'm following" there, so a follow status
  Instagram will not confirm gets the follow prompt, not the link.
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
   - answers and drafts: `ANTHROPIC_API_KEY` (Claude, through Anthropic's own
     SDK). `TRIAGE_CLAUDE_MODEL` picks the model and defaults to
     `claude-opus-5-5`; `claude-sonnet-5-5` and `claude-haiku-5-5` cost a half
     and a fortieth of it. Without an Anthropic key the worker uses Groq as
     before (`GROQ_API_KEY` and `TRIAGE_AI_MODEL`), so removing the key is all
     it takes to go back. The Settings page shows which one is answering.
   - optional: `TRIAGE_REPLY_DELAY_SECONDS` (default 20)
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
both are set. A webhook has no buttons, so it gets no drafts.

## Drafts and the buttons under a notice

In 全開, a message that is handed to the owner arrives with a draft reply,
written by the model in the owner's voice, and three buttons:

    IG 私訊需要你回：some_fan
    15:53「想找你合作，方便給我報價嗎」
    草稿：可以呀～你是想合作哪一種形式呢？
    https://www.instagram.com/some_fan/
    [ 送出 ]  [ 修改 ]  [ 不用回 ]

| Button | What it does |
|---|---|
| 送出 | asks once more (確定送出 / 取消). The second tap sends the draft from the owner's Instagram account. |
| 修改 | the bot asks for the owner's own wording, with the draft shown ready to copy. What the owner replies to that message is sent in place of the draft. |
| 不用回 | drops the draft. Nothing is sent. |

Afterwards the notice shows what went out and the buttons are gone:

    IG 私訊已回：some_fan
    15:53「想找你合作，方便給我報價嗎」
    15:55 ✅ 已回「可以呀～你是想合作哪一種形式呢？」
    https://www.instagram.com/some_fan/

**A draft is never sent by itself.** The only code that turns one into a
message is `lib/triage/owner-actions.ts`, and it acts on one thing only: a tap
or a reply from the chat the notices go to.

What a draft is (`lib/triage/draft.ts`):

- A separate request to the model, made only when a message is handed over.
  The request that sorts messages — and so decides what is sent automatically —
  is not touched by it. If the draft request fails, or the model has nothing
  sensible to say, the notice simply arrives without a draft.
- At most a few sentences (400 characters), in the tone of the owner's own
  fixed lines, with no "（自動回覆）" tag: the owner is the one sending it.
- It does not speak for the owner on what only the owner knows — whether a
  collaboration or a course is on, prices, dates. It asks the person what they
  need instead, and the owner carries on from there.
- It may carry only links that are on the pages the person was sent, or those
  pages' own addresses (so "here is the link again" can be drafted). A draft
  with any other link is thrown away.
- The model is given the person's message, why it was handed over, the titles
  and links of the pages they were sent, the start of the newest page, and the
  day's earlier turns as far as this app saw them.

There is no draft for a picture or file, for a conversation the owner is
answering by hand, when the sender asks for the owner in person, in 試跑 and
只開固定回覆, or when the model has just failed on that message.

Guard rails:

- Only the chat named by `TRIAGE_TELEGRAM_CHAT_ID` can act. A tap or message
  from anywhere else is ignored without a reply.
- A draft is stored on the log row of the message it answers (`TriageLog`:
  action `ESCALATED` with a `replyText`). Sending claims that row first
  (`ESCALATED` → `SENT_BY_OWNER`), so a double tap, a redelivered update or a
  second worker cannot send it twice.
- One draft per person: a newer message's draft replaces the older one, and
  the notice always shows the one for the latest message.
- When the owner answers that person by hand in Instagram, the waiting draft
  is dropped and can no longer be sent.
- A draft older than 24 hours is not sent (Instagram would refuse it anyway).
- A failed send is not retried — Instagram sometimes reports an error after
  delivering. The notice says `⚠️ 沒送出去` and the owner replies in Instagram.
- A tap on 確定送出 that was waiting while the worker restarted does not send;
  the owner is asked to tap again. A typed reply more than five minutes old is
  not sent either.
- What is sent this way does not count toward the daily cap, and it counts as
  the bot's sending rather than as the owner typing in Instagram: triage keeps
  looking after that conversation, so the person's next message gets its fixed
  reply or a new draft as usual.

How a tap reaches the worker (`lib/triage/telegram-updates.ts`): the worker
long-polls Telegram's `getUpdates` with the bot token it already has. There is
no public address to protect and nothing new to configure. Two things follow:

- Only one process may read a bot's updates, so the right to read is a 90-second
  lease in Redis (`triage:tg:poller`), renewed while the worker runs and given
  back when it stops.
- A bot that has a webhook set cannot be read this way (Telegram answers 409).
  The Settings page then shows the buttons as not connected; use a bot that is
  not shared with another program.

## Meta's rules this stays inside

Replies go only to people who messaged first, within 24 hours of their last
message, through the official Instagram messaging API. A human is always
reachable, and replies the model sends by itself are labelled as automated. A
draft the owner read and chose to send is the owner's own message and carries
no label.
