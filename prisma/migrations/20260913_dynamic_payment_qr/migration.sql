-- Dynamic Payment QR V1 — ADDITIVE ONLY.
-- Every new column is NULLable: existing production rows remain valid and
-- default to the existing STATIC QR behavior. No DROP, no destructive ALTER,
-- no data rewrite. DO NOT EXECUTE from this branch without the standard
-- precheck (migrate status / _prisma_migrations / object existence).

ALTER TABLE "PaymentAccount" ADD COLUMN "qrProvider" TEXT;
ALTER TABLE "PaymentAccount" ADD COLUMN "bankBin" TEXT;
ALTER TABLE "PaymentAccount" ADD COLUMN "khqrMode" TEXT;
ALTER TABLE "PaymentAccount" ADD COLUMN "khqrBakongAccountId" TEXT;
ALTER TABLE "PaymentAccount" ADD COLUMN "khqrMerchantName" TEXT;
ALTER TABLE "PaymentAccount" ADD COLUMN "khqrMerchantCity" TEXT;
ALTER TABLE "PaymentAccount" ADD COLUMN "khqrMerchantId" TEXT;
ALTER TABLE "PaymentAccount" ADD COLUMN "khqrAcquiringBank" TEXT;

ALTER TABLE "Order" ADD COLUMN "transferMemo" TEXT;
