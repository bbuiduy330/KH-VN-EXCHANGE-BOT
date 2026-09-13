-- Operations Center + multi-level CTV + automated incoming-payment pass.
-- ALL changes are ADDITIVE or constraint-replacing (no data loss):
--   1. Partner 5-level hierarchy (parentPartnerId, self-FK).
--   2. Commission multi-level: orderId unique → composite
--      (orderId, partnerId, level) + frozen-snapshot columns. ALL existing
--      Commission rows are preserved (legacy rows = level 1 / legacy rule).
--   3. Order: khqrMd5 (Bakong Open API reconciliation) + rateMarginSnapshot
--      (frozen baseRate/buy/sellMargin captured at Order creation).
--   4. PaymentAccount: verificationProvider/verificationBaseUrl (disabled by
--      default — manual Admin verification remains the behavior).
--   5. IncomingPaymentEvent durable provider-event model.
--   6. pg_trgm extension + trigram indexes for fuzzy Admin search (safe:
--      code falls back to exact/ILIKE-style matching when unavailable).
-- Fresh DB: works with `prisma migrate deploy`. No manual SQL.

-- 1. Partner hierarchy -------------------------------------------------------
ALTER TABLE "Partner" ADD COLUMN "parentPartnerId" TEXT;
CREATE INDEX "Partner_parentPartnerId_idx" ON "Partner"("parentPartnerId");
ALTER TABLE "Partner" ADD CONSTRAINT "Partner_parentPartnerId_fkey" FOREIGN KEY ("parentPartnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Commission multi-level ---------------------------------------------------
DROP INDEX IF EXISTS "Commission_orderId_key";
ALTER TABLE "Commission" ADD COLUMN "level" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Commission" ADD COLUMN "ruleVersion" TEXT;
ALTER TABLE "Commission" ADD COLUMN "hierarchySnapshot" JSONB;
ALTER TABLE "Commission" ADD COLUMN "spreadBasis" JSONB;
CREATE UNIQUE INDEX "Commission_orderId_partnerId_level_key" ON "Commission"("orderId", "partnerId", "level");
CREATE INDEX "Commission_orderId_idx" ON "Commission"("orderId");

-- 3. Order verification/reconciliation fields --------------------------------
ALTER TABLE "Order" ADD COLUMN "khqrMd5" TEXT;
ALTER TABLE "Order" ADD COLUMN "rateMarginSnapshot" JSONB;

-- 4. PaymentAccount verification provider ------------------------------------
ALTER TABLE "PaymentAccount" ADD COLUMN "verificationProvider" TEXT;
ALTER TABLE "PaymentAccount" ADD COLUMN "verificationBaseUrl" TEXT;

-- 5. IncomingPaymentEvent ------------------------------------------------------
CREATE TABLE "IncomingPaymentEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalTransactionId" TEXT NOT NULL,
    "paymentAccountId" TEXT,
    "matchedOrderId" TEXT,
    "currency" TEXT,
    "amount" DECIMAL(18,6),
    "memo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "rawMetadata" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncomingPaymentEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IncomingPaymentEvent_provider_externalTransactionId_key" ON "IncomingPaymentEvent"("provider", "externalTransactionId");
CREATE INDEX "IncomingPaymentEvent_status_receivedAt_idx" ON "IncomingPaymentEvent"("status", "receivedAt");

-- 6. pg_trgm fuzzy-search support ---------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "Customer_fullName_trgm_idx" ON "Customer" USING gin ("fullName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Customer_username_trgm_idx" ON "Customer" USING gin ("username" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Partner_displayName_trgm_idx" ON "Partner" USING gin ("displayName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Order_transferMemo_trgm_idx" ON "Order" USING gin ("transferMemo" gin_trgm_ops);
