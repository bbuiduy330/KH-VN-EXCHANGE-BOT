CREATE UNIQUE INDEX IF NOT EXISTS "CustomerChatMessage_tg_dedupe_idx"
  ON "CustomerChatMessage"("telegramChatId", "telegramMessageId", "direction");

-- ===========================================================================
-- 20260920 — CANONICAL PUBLIC ORDER REFERENCE + order-linked support context.
-- ADDITIVE ONLY. Order.id is NEVER mutated.
--   Order.publicRef      : unique, immutable, human-friendly public ref.
--   Conversation.orderId : nullable Order-linked support context.
--   CustomerChatMessage.orderId : nullable transcript order context.
-- Backfill preserves the existing UX short ref (UPPER last-6 of id) wherever
-- it is already unique; collisions disambiguate with longer suffixes, then
-- the full id (guaranteed unique). No banking/private data encoded.
-- ===========================================================================
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "publicRef" TEXT;
UPDATE "Order" SET "publicRef" = UPPER(RIGHT("id", 6)) WHERE "publicRef" IS NULL;
UPDATE "Order" o SET "publicRef" = UPPER(RIGHT(o."id", 8))
  WHERE (SELECT COUNT(*) FROM "Order" d WHERE d."publicRef" = o."publicRef") > 1;
UPDATE "Order" o SET "publicRef" = UPPER(RIGHT(o."id", 12))
  WHERE (SELECT COUNT(*) FROM "Order" d WHERE d."publicRef" = o."publicRef") > 1;
UPDATE "Order" o SET "publicRef" = UPPER(o."id")
  WHERE (SELECT COUNT(*) FROM "Order" d WHERE d."publicRef" = o."publicRef") > 1;
CREATE UNIQUE INDEX IF NOT EXISTS "Order_publicRef_key" ON "Order"("publicRef");

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "orderId" TEXT;
ALTER TABLE "CustomerChatMessage" ADD COLUMN IF NOT EXISTS "orderId" TEXT;
CREATE INDEX IF NOT EXISTS "CustomerChatMessage_orderId_createdAt_idx"
  ON "CustomerChatMessage"("orderId", "createdAt");
