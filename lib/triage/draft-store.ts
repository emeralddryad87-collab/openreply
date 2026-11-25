import { prisma } from "@/lib/db/client";

/**
 * Where a draft lives: on the log row of the message it answers.
 *
 * A row with action ESCALATED and a reply text is a draft waiting for the
 * owner's decision. Sending it turns the row into SENT_BY_OWNER (see
 * owner-actions.ts); dropping it clears the text. Nothing else in triage reads
 * such a row as "something that was sent": the daily cap and the say-once rule
 * count REPLIED rows only.
 */

type Who =
  | { accountId: string; instagramId?: undefined; senderId: string }
  | { instagramId: string; accountId?: undefined; senderId: string };

/**
 * Forget the drafts waiting for this person, because they no longer fit: a
 * newer message has its own draft (`olderThan` that message), or the owner has
 * answered by hand. Returns how many were dropped.
 */
export async function dropPendingDrafts(
  who: Who,
  options: { olderThan?: Date } = {}
): Promise<number> {
  const result = await prisma.triageLog.updateMany({
    where: {
      ...(who.accountId !== undefined
        ? { instagramAccountId: who.accountId }
        : { instagramAccount: { instagramId: who.instagramId } }),
      senderId: who.senderId,
      action: "ESCALATED",
      replyText: { not: null },
      ...(options.olderThan ? { createdAt: { lt: options.olderThan } } : {}),
    },
    data: { replyText: null },
  });
  return result.count;
}
