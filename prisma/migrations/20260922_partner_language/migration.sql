-- ===========================================================================
-- 20260922 — CTV / PARTNER UI LANGUAGE (vi | en)
-- ADDITIVE ONLY. Nullable column: existing Partners stay valid and get the
-- VI/EN language picker on their next /ctv. Partner language is INDEPENDENT
-- from Customer.language (a person may be a km customer and an en partner).
-- No data backfill: there is no reliable authority for a Partner's language.
-- ===========================================================================
ALTER TABLE "Partner" ADD COLUMN IF NOT EXISTS "language" TEXT;