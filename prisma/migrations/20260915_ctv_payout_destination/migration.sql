-- CTV payout destination V2 — ADDITIVE ONLY.
-- Every new column is NULLable: existing production rows remain valid.
-- No DROP, no destructive ALTER, no data rewrite. Legacy Partner payout
-- bank/account/holder columns are intentionally KEPT (fallback snapshot
-- source for settlements created before the free-form flow).
-- Fresh DB: works with `prisma migrate deploy`. No manual SQL.

ALTER TABLE "Partner" ADD COLUMN "payoutDestinationText" TEXT;
ALTER TABLE "Partner" ADD COLUMN "payoutQrFileId" TEXT;

ALTER TABLE "PartnerSettlement" ADD COLUMN "payoutDestinationSnapshot" JSONB;
ALTER TABLE "PartnerSettlement" ADD COLUMN "payoutProofFileId" TEXT;
