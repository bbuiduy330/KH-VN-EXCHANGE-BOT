CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_id_idx" ON "AuditLog"("createdAt", "id");

-- Part 2 — durable customer chat transcript + true customer last-activity.
-- ADDITIVE ONLY. Backfill lastActivityAt from updatedAt (row-update time is
-- the nearest safe approximation for existing rows; never invents data).
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "Customer" SET "lastActivityAt" = "updatedAt";
CREATE INDEX IF NOT EXISTS "Customer_lastActivityAt_id_idx" ON "Customer"("lastActivityAt", "id");

CREATE TABLE IF NOT EXISTS "CustomerChatMessage" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "conversationId" TEXT,
  "telegramChatId" TEXT NOT NULL,
  "telegramMessageId" TEXT,
  "direction" TEXT NOT NULL,
  "senderType" TEXT NOT NULL,
  "staffTelegramId" TEXT,
  "contentType" TEXT NOT NULL DEFAULT 'TEXT',
  "text" TEXT,
  "caption" TEXT,
  "telegramFileId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerChatMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CustomerChatMessage_customerId_createdAt_idx"
  ON "CustomerChatMessage"("customerId", "createdAt", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "CustomerChatMessage_tg_dedupe_idx"
  ON "CustomerChatMessage"("telegramChatId", "telegramMessageId", "direction");
