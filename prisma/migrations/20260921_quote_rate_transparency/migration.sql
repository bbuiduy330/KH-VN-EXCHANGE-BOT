-- ===========================================================================
-- 20260921 — TRANSPARENT QUOTE BREAKDOWN (rate source + fixed side).
-- ADDITIVE ONLY. Historical Quote/Order financial amounts are NEVER rewritten:
-- every new column is NULLABLE and a NULL row keeps its original rendering.
--   Quote.rateSide         : 'SOURCE_FIXED' | 'TARGET_FIXED' | NULL (legacy)
--   Quote.displayRate      : AUTHORITATIVE frozen display rate (VND per USD)
--   Quote.conversionUsd    : pure FX conversion in USD BEFORE the service fee
--   Quote.feeUsd           : service fee in USD (positive magnitude)
--   Quote.payerAmountExact : exact payer amount before currency rounding
-- No backfill: a legacy row's fixed side cannot be reconstructed reliably, and
-- inventing one would risk rewriting historical financial meaning.
-- Note: no unique constraint is added — Quote has no public reference of its
-- own; customer-facing Quote/Order identity comes from canonical Order.publicRef.
-- ===========================================================================
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "rateSide" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "displayRate" DECIMAL(18, 6);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "conversionUsd" DECIMAL(18, 6);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "feeUsd" DECIMAL(18, 6);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "payerAmountExact" DECIMAL(18, 6);