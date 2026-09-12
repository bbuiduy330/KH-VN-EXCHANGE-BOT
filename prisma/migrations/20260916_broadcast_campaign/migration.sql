-- Broadcast / customer outreach (Part C) — ADDITIVE ONLY.
-- One campaign → many recipients; audience SNAPSHOTTED before sending.
-- Customer reachability fields default ON for existing users (approved
-- product behavior) with an explicit opt-out control in the customer menu.
-- Fresh DB: works with `prisma migrate deploy`. No manual SQL.

CREATE TABLE "BroadcastCampaign" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "createdByTelegramId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "audienceType" TEXT NOT NULL,
    "audienceFilter" JSONB,
    "content" JSONB NOT NULL,
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "blockedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BroadcastCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BroadcastRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "locale" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BroadcastRecipient_campaignId_customerId_key" ON "BroadcastRecipient"("campaignId", "customerId");
CREATE INDEX "BroadcastRecipient_campaignId_status_idx" ON "BroadcastRecipient"("campaignId", "status");
CREATE INDEX "BroadcastCampaign_status_idx" ON "BroadcastCampaign"("status");

ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "BroadcastCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Customer" ADD COLUMN "marketingEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Customer" ADD COLUMN "telegramReachable" BOOLEAN NOT NULL DEFAULT true;
