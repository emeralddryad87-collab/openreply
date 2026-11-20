import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { parseTriageMode, TRIAGE_MODES } from "@/lib/triage/config";
import { setTriageMode } from "@/lib/triage/settings";
import { getLastOwnerReplyAt, getWorkerCapabilities } from "@/lib/triage/state";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";
// The switch must read back what was just saved.
export const dynamic = "force-dynamic";

const RECENT_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * DM triage settings for the workspace's Instagram accounts: the current mode,
 * how many pages the model can answer from, what the worker reports about its
 * own configuration, and the latest decisions (the way to review a dry run).
 */
export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: context.workspaceId },
    orderBy: { connectedAt: "desc" },
    select: {
      id: true,
      instagramId: true,
      username: true,
      triageSetting: { select: { mode: true } },
      _count: { select: { triagePages: true } },
    },
  });

  const since = new Date(Date.now() - DAY_MS);
  const data = await Promise.all(
    accounts.map(async (account) => {
      const [grouped, recent, lastOwnerReplyAt] = await Promise.all([
        prisma.triageLog.groupBy({
          by: ["action"],
          where: { instagramAccountId: account.id, createdAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.triageLog.findMany({
          where: { instagramAccountId: account.id },
          orderBy: { createdAt: "desc" },
          take: RECENT_LIMIT,
          select: {
            id: true,
            createdAt: true,
            messageText: true,
            category: true,
            action: true,
            replyText: true,
            reason: true,
          },
        }),
        // Redis being unreachable must not take the settings page down.
        getLastOwnerReplyAt(account.instagramId).catch(() => null),
      ]);

      return {
        id: account.id,
        username: account.username,
        mode: parseTriageMode(account.triageSetting?.mode),
        pageCount: account._count.triagePages,
        lastOwnerReplyAt,
        last24h: Object.fromEntries(grouped.map((g) => [g.action, g._count._all])),
        recent: recent.map((r) => ({
          ...r,
          messageText: r.messageText.slice(0, 200),
          replyText: r.replyText?.slice(0, 300) ?? null,
          reason: r.reason?.slice(0, 200) ?? null,
        })),
      };
    })
  );

  // The worker's own report of whether its model key and notification channel
  // are set. Redis being unreachable must not take the settings page down.
  let worker: Awaited<ReturnType<typeof getWorkerCapabilities>> = null;
  try {
    worker = await getWorkerCapabilities();
  } catch (error) {
    console.error("[Triage] Could not read worker capabilities:", error);
  }

  return NextResponse.json({
    success: true,
    data: {
      canManage: canManageWorkspace(context.role),
      accounts: data,
      worker,
    },
  });
}

const updateSchema = z.object({
  instagramAccountId: z.string().min(1),
  mode: z.enum(TRIAGE_MODES),
});

/** Set the triage mode for one account. Owners and admins only. */
export async function PATCH(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can change this setting" },
      { status: 403 }
    );
  }

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid input" },
      { status: 400 }
    );
  }

  // Scoped to the caller's workspace: an id from another workspace is a 404.
  const account = await prisma.instagramAccount.findFirst({
    where: { id: parsed.data.instagramAccountId, workspaceId: context.workspaceId },
    select: { id: true, instagramId: true },
  });
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not found" },
      { status: 404 }
    );
  }

  await setTriageMode(account, parsed.data.mode);

  return NextResponse.json({ success: true, data: { mode: parsed.data.mode } });
}
