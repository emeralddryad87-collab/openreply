"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Settings panel for DM triage: the per-account mode switch, a readout of
 * whether the worker has what it needs, and the latest decisions.
 *
 * Written in Traditional Chinese on purpose. This panel is the kill switch for
 * a feature that messages real people, and the person operating it reads
 * Chinese; being found and understood in a hurry matters more here than
 * matching the English of the rest of the dashboard.
 */

type TriageMode = "off" | "dry_run" | "canned" | "full";

interface RecentEntry {
  id: string;
  createdAt: string;
  messageText: string;
  category: string;
  action: string;
  replyText: string | null;
  reason: string | null;
}

interface TriageAccount {
  id: string;
  username: string;
  mode: TriageMode;
  pageCount: number;
  lastOwnerReplyAt: string | null;
  last24h: Record<string, number>;
  recent: RecentEntry[];
}

interface TriageData {
  canManage: boolean;
  accounts: TriageAccount[];
  worker: {
    ai: boolean;
    /** Which model answers, e.g. "Claude（claude-opus-5-5）". Unset on an older worker. */
    aiModel?: string | null;
    notify: boolean;
    notifyCheck?: "ok" | "failed" | "pending" | "unchecked" | "unconfigured";
    /** Unset on a worker older than the buttons under a notice. */
    replyButtons?: boolean;
    checkedAt: string;
  } | null;
}

const MODES: { value: TriageMode; label: string; hint: string }[] = [
  { value: "off", label: "關閉", hint: "什麼都不做，私訊跟原本一樣。" },
  {
    value: "dry_run",
    label: "試跑（不發訊息）",
    hint: "只記錄它會怎麼回，不會發任何訊息給粉絲。需要你回的還是會通知你。",
  },
  {
    value: "canned",
    label: "只開固定回覆",
    hint: "對方說「沒問題」「了解」「可以」「謝謝」「看不懂」會自動回固定句；說沒收到連結會重傳（有追蹤給連結，沒追蹤給按鈕）；問是不是 AI 會照實說是。其他的通知你。",
  },
  {
    value: "full",
    label: "全開",
    hint: "固定回覆，再加上照留言連結頁和常見問題，用一句話回答問題。合作、課程和答不出來的通知你，並附上草稿：你在 Telegram 按「送出」才會發。",
  },
];

// What each logged outcome means, in the order they are worth reading.
const ACTIONS: Record<string, { label: string; tone: "ok" | "warn" | "muted" | "error" }> = {
  REPLIED: { label: "已自動回", tone: "ok" },
  DRY_RUN: { label: "試跑：會這樣回", tone: "muted" },
  ESCALATED: { label: "轉給你", tone: "warn" },
  SENT_BY_OWNER: { label: "你按送出回的", tone: "ok" },
  IGNORED: { label: "不用回", tone: "muted" },
  MERGED: { label: "跟下一則一起回", tone: "muted" },
  SKIPPED_OWNER_ACTIVE: { label: "你在回，沒插嘴", tone: "muted" },
  SKIPPED_CAP: { label: "超過每日上限", tone: "muted" },
  FAILED: { label: "發送失敗", tone: "error" },
  // A typed message waits a moment before it is answered.
  PENDING: { label: "等一下才回", tone: "muted" },
};

const TONE: Record<string, string> = {
  ok: "bg-success/10 text-success",
  warn: "bg-warning/10 text-warning",
  error: "bg-error/10 text-error",
  muted: "bg-zinc-500/15 text-muted",
};

/** The server's own wording is English; keep it as a detail after ours. */
function withDetail(message: string, detail: unknown): string {
  return typeof detail === "string" && detail ? `${message}（${detail}）` : message;
}

function Pill({ tone, children }: { tone: keyof typeof TONE; children: ReactNode }) {
  return (
    <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${TONE[tone]}`}>
      {children}
    </span>
  );
}

function StatusPill({ ok, unknown }: { ok: boolean; unknown?: boolean }) {
  if (unknown) return <Pill tone="muted">讀不到</Pill>;
  return <Pill tone={ok ? "ok" : "warn"}>{ok ? "已設定" : "還沒設定"}</Pill>;
}

/** The notification channel is the one setting that is proven, not just read. */
function NotifyPill({ worker }: { worker: TriageData["worker"] }) {
  if (!worker) return <Pill tone="muted">讀不到</Pill>;
  if (!worker.notify) return <Pill tone="warn">還沒設定</Pill>;
  if (worker.notifyCheck === "ok") return <Pill tone="ok">已接上，測試訊息有送到</Pill>;
  if (worker.notifyCheck === "failed") return <Pill tone="error">設定了但送不出去</Pill>;
  if (worker.notifyCheck === "pending") return <Pill tone="muted">測試中</Pill>;
  return <Pill tone="ok">已設定</Pill>;
}

export function TriageSettings() {
  const [data, setData] = useState<TriageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [savedFor, setSavedFor] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/triage")
      .then((res) => res.json())
      .then((payload) => {
        if (payload.success) setData(payload.data);
        else setError(withDetail("讀不到私訊自動分類的設定", payload.error));
      })
      .catch(() => setError("讀不到私訊自動分類的設定"));
  }, []);

  async function changeMode(account: TriageAccount, mode: TriageMode) {
    if (mode === account.mode) return;
    // Turning real sending on is the one change worth a second look.
    if (
      (mode === "canned" || mode === "full") &&
      !confirm("這會開始真的發訊息給粉絲。確定要打開嗎？")
    ) {
      return;
    }

    setError(null);
    setSavedFor(null);
    setSaving(account.id);
    try {
      const res = await fetch("/api/triage", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instagramAccountId: account.id, mode }),
      });
      const payload = await res.json();
      if (!payload.success) {
        setError(withDetail("沒有儲存成功，設定沒有變", payload.error));
        return;
      }
      setData((current) =>
        current
          ? {
              ...current,
              accounts: current.accounts.map((a) =>
                a.id === account.id ? { ...a, mode } : a
              ),
            }
          : current
      );
      setSavedFor(account.id);
    } catch {
      setError("沒有儲存成功，設定沒有變。請再試一次");
    } finally {
      setSaving(null);
    }
  }

  if (!data && !error) {
    return <section className="panel rounded p-4 sm:p-6 h-40" />;
  }

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold mb-2">私訊自動分類</h2>
      <p className="text-xs text-muted mb-6">
        只處理領過你連結的人傳來的私訊。你自己回過的對話，24 小時內它不會插嘴。對方打字傳來的訊息，會隔一下才回，連傳幾則會一起回一次。
      </p>

      {error && (
        <div className="mb-4 rounded border border-error/20 bg-error/10 p-3 text-sm text-error">
          {error}
        </div>
      )}

      {data && data.accounts.length === 0 && (
        <p className="text-sm text-muted">先連接一個 Instagram 帳號。</p>
      )}

      {data?.accounts.map((account) => {
        const active = MODES.find((m) => m.value === account.mode) ?? MODES[0];
        const on = account.mode !== "off";
        const warnings: string[] = [];
        if (on && data.worker && !data.worker.notify) {
          warnings.push("通知還沒設定，需要你回的訊息不會通知你。");
        }
        if (data.worker?.notify && data.worker.notifyCheck === "failed") {
          warnings.push(
            "Telegram 測試訊息送不出去：先在 Telegram 對你的 bot 按 Start，再檢查 token 和 chat id 有沒有貼錯。大約 10 分鐘會自動再試一次。"
          );
        }
        if ((account.mode === "full" || account.mode === "dry_run") && data.worker && !data.worker.ai) {
          warnings.push("AI 金鑰還沒設定，問連結內容的訊息會全部轉給你。");
        }
        if ((account.mode === "full" || account.mode === "dry_run") && account.pageCount === 0) {
          warnings.push("還沒有頁面資料，AI 沒有東西可以參考。");
        }
        if (on && !data.worker) {
          warnings.push("讀不到 worker 的狀態，可能沒在跑，或還是舊版本。");
        }
        if (account.mode === "full" && data.worker?.notify && data.worker.replyButtons === false) {
          warnings.push(
            "Telegram 通知下面的按鈕現在沒有接上，按了不會有反應。worker 剛重新啟動的話等一兩分鐘就好；一直這樣，可能是這個 bot 被別的程式佔用了。"
          );
        }

        return (
          <div key={account.id} className="space-y-4">
            <div className="flex flex-col gap-3 border-b border-border py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">@{account.username}</p>
                <p className="mt-0.5 text-xs text-muted">{active.hint}</p>
              </div>
              <select
                aria-label={`@${account.username} 的私訊自動分類模式`}
                value={account.mode}
                disabled={!data.canManage || saving === account.id}
                onChange={(event) => changeMode(account, event.target.value as TriageMode)}
                className="rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40 disabled:opacity-50"
              >
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            {savedFor === account.id && (
              <p className="text-xs text-success">已儲存，最多 15 秒後生效。</p>
            )}

            {warnings.map((w) => (
              <div
                key={w}
                className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
              >
                {w}
              </div>
            ))}

            <div className="flex items-center justify-between gap-3 border-b border-border py-3">
              <div className="min-w-0">
                <p className="text-sm text-foreground">AI 金鑰（回答連結內容用）</p>
                {data.worker?.aiModel && (
                  <p className="mt-0.5 text-xs text-muted">現在用的是 {data.worker.aiModel}</p>
                )}
              </div>
              <StatusPill ok={Boolean(data.worker?.ai)} unknown={!data.worker} />
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border py-3">
              <p className="text-sm text-foreground">通知你的管道</p>
              <NotifyPill worker={data.worker} />
            </div>
            {data.worker?.notify && data.worker.replyButtons !== undefined && (
              <div className="flex items-center justify-between gap-3 border-b border-border py-3">
                <p className="text-sm text-foreground">通知下面的「送出」按鈕</p>
                <Pill tone={data.worker.replyButtons ? "ok" : "warn"}>
                  {data.worker.replyButtons ? "可以用" : "還沒接上"}
                </Pill>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 border-b border-border py-3">
              <p className="text-sm text-foreground">AI 可以參考的頁面</p>
              <span className="text-sm text-muted">{account.pageCount} 頁</span>
            </div>
            <div className="flex flex-col gap-1 border-b border-border py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <div className="min-w-0">
                <p className="text-sm text-foreground">上次偵測到你親手回覆</p>
                <p className="mt-0.5 text-xs text-muted">
                  打開後你親手回一則私訊，這裡要會更新，「你在回它不插嘴」才有作用。
                </p>
              </div>
              <span className="shrink-0 text-sm text-muted">
                {account.lastOwnerReplyAt
                  ? new Date(account.lastOwnerReplyAt).toLocaleString()
                  : "還沒偵測到"}
              </span>
            </div>

            <div className="py-3">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                最近 24 小時
              </p>
              <div className="flex flex-wrap gap-2">
                {Object.keys(account.last24h).length === 0 && (
                  <span className="text-sm text-muted">還沒有紀錄</span>
                )}
                {Object.entries(account.last24h).map(([action, count]) => {
                  const meta = ACTIONS[action] ?? { label: action, tone: "muted" as const };
                  return (
                    <span
                      key={action}
                      className={`rounded-full px-3 py-1 text-xs font-medium ${TONE[meta.tone]}`}
                    >
                      {meta.label} {count}
                    </span>
                  );
                })}
              </div>
            </div>

            {account.recent.length > 0 && (
              <details className="py-3">
                <summary className="cursor-pointer text-sm font-medium text-foreground">
                  最近 {account.recent.length} 則怎麼處理的
                </summary>
                <ul className="mt-3 space-y-3">
                  {account.recent.map((entry) => {
                    const meta = ACTIONS[entry.action] ?? {
                      label: entry.action,
                      tone: "muted" as const,
                    };
                    return (
                      <li
                        key={entry.id}
                        className="rounded border border-border bg-surface/70 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[meta.tone]}`}
                          >
                            {meta.label}
                          </span>
                          <span className="text-xs text-muted">
                            {new Date(entry.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <p className="mt-2 break-words text-sm text-foreground">
                          {entry.messageText}
                        </p>
                        {entry.replyText && (
                          <p className="mt-1 whitespace-pre-line break-words text-sm text-muted">
                            {/* On a row handed to the owner, the text is a draft
                                that has not been sent. */}
                            {entry.action === "ESCALATED" ? "草稿（還沒發）：" : "↳ "}
                            {entry.replyText}
                          </p>
                        )}
                        {entry.reason && (
                          <p className="mt-1 break-words text-xs text-muted">
                            （{entry.reason}）
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
          </div>
        );
      })}
    </section>
  );
}
