-- Migration to update OrderStatus enum, add OrderStateHistory, PaymentAccountVersion, OrderBillEvidence, and multiple QR support

-- Update OrderStatus enum safely
DO $$ BEGIN
  CREATE TYPE "OrderStatus_new" AS ENUM (
    'WAITING_PAYMENT',
    'CUSTOMER_SENT_BILL',
    'WAITING_ADMIN_VERIFY',
    'PAYMENT_CONFIRMED',
    'WAITING_PAYOUT',
    'PAYOUT_SENT',
    'COMPLETED',
    'CANCELLED',
    'PAYMENT_MISMATCH',
    'MANUAL_REVIEW',
    'SUSPICIOUS'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "OrderStatus_new" USING (
  CASE "status"::text
    WHEN 'PENDING_PAYMENT' THEN 'WAITING_PAYMENT'::"OrderStatus_new"
    ELSE "status"::text::"OrderStatus_new"
  END
);
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'WAITING_PAYMENT'::"OrderStatus_new";
DROP TYPE IF EXISTS "OrderStatus";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";

-- PaymentAccount updates
ALTER TABLE "PaymentAccount" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PaymentAccount" ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "PaymentAccount_currency_isActive_idx" ON "PaymentAccount"("currency", "isActive");
CREATE INDEX IF NOT EXISTS "PaymentAccount_isDefault_idx" ON "PaymentAccount"("isDefault");

-- PaymentAccountVersion
CREATE TABLE IF NOT EXISTS "PaymentAccountVersion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "paymentAccountId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "qrFileId" TEXT NOT NULL,
  "qrFilePath" TEXT NOT NULL,
  "qrSha256" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentAccountVersion_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "PaymentAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentAccountVersion_paymentAccountId_version_key" ON "PaymentAccountVersion"("paymentAccountId", "version");
CREATE INDEX IF NOT EXISTS "PaymentAccountVersion_paymentAccountId_idx" ON "PaymentAccountVersion"("paymentAccountId");

-- OrderStateHistory
CREATE TABLE IF NOT EXISTS "OrderStateHistory" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "fromStatus" "OrderStatus" NOT NULL,
  "toStatus" "OrderStatus" NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "reason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderStateHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "OrderStateHistory_orderId_idx" ON "OrderStateHistory"("orderId");

-- OrderBillEvidence
CREATE TABLE IF NOT EXISTS "OrderBillEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "fileId" TEXT NOT NULL,
  "filePath" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "extracted" JSONB,
  "uploadedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderBillEvidence_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "OrderBillEvidence_orderId_idx" ON "OrderBillEvidence"("orderId");
CREATE INDEX IF NOT EXISTS "OrderBillEvidence_sha256_idx" ON "OrderBillEvidence"("sha256");

-- Additional Indexes
CREATE INDEX IF NOT EXISTS "Order_status_idx" ON "Order"("status");
CREATE INDEX IF NOT EXISTS "Order_customerId_idx" ON "Order"("customerId");
CREATE INDEX IF NOT EXISTS "FileEvidence_sha256_idx" ON "FileEvidence"("sha256");
CREATE INDEX IF NOT EXISTS "DriveSyncJob_status_idx" ON "DriveSyncJob"("status");
