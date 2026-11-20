-- DM triage: a per-account switch, a log of how each inbound DM was handled,
-- and the pages the triage model may answer from. Additive only: three new
-- tables, no change to any existing table.

-- CreateTable
CREATE TABLE "TriageSetting" (
    "instagramAccountId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'off',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriageSetting_pkey" PRIMARY KEY ("instagramAccountId")
);

-- CreateTable
CREATE TABLE "TriageLog" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "messageText" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "replyText" TEXT,
    "pageKey" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriagePage" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "keywords" TEXT[],
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriagePage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TriageLog_instagramAccountId_messageId_key" ON "TriageLog"("instagramAccountId", "messageId");

-- CreateIndex
CREATE INDEX "TriageLog_instagramAccountId_senderId_createdAt_idx" ON "TriageLog"("instagramAccountId", "senderId", "createdAt");

-- CreateIndex
CREATE INDEX "TriageLog_createdAt_idx" ON "TriageLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TriagePage_instagramAccountId_key_key" ON "TriagePage"("instagramAccountId", "key");

-- CreateIndex
CREATE INDEX "TriagePage_instagramAccountId_idx" ON "TriagePage"("instagramAccountId");

-- AddForeignKey
ALTER TABLE "TriageSetting" ADD CONSTRAINT "TriageSetting_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageLog" ADD CONSTRAINT "TriageLog_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriagePage" ADD CONSTRAINT "TriagePage_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
