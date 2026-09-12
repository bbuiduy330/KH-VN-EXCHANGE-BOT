-- BASELINE INIT MIGRATION (fresh-DB path, PART T).
--
-- The historical migrations (20260907+) ALTER core tables that were originally
-- created against a manually bootstrapped database — NO baseline existed, so
-- `prisma migrate deploy` on a brand-new empty PostgreSQL FAILED.
--
-- This ADDITIVE baseline (lexicographically first → runs before 20260907)
-- creates the pre-20260907 base schema ONLY: no destructive statements, no
-- data rewrites. Existing volumes are untouched. After this runs, the
-- historical migrations apply cleanly to reach the current schema.

-- Enums (OrderStatus carries the LEGACY value PENDING_PAYMENT — the 20260907
-- migration converts it to WAITING_PAYMENT via the CASE below).
DO $$ BEGIN
  CREATE TYPE "OrderStatus" AS ENUM (
    'PENDING_PAYMENT',
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
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ConversationMode" AS ENUM ('AUTO', 'HUMAN');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "StaffRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'CSKH');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "StaffStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "ExchangeRate" (
  "id" TEXT NOT NULL,
  "pair" TEXT NOT NULL,
  "baseRate" DECIMAL(18,6) NOT NULL,
  "buyMargin" DECIMAL(18,6) NOT NULL,
  "sellMargin" DECIMAL(18,6) NOT NULL,
  "fee" DECIMAL(18,6) NOT NULL,
  "feeCurrency" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ExchangeRate_pair_key" ON "ExchangeRate"("pair");

CREATE TABLE IF NOT EXISTS "Customer" (
  "id" TEXT NOT NULL,
  "telegramId" TEXT NOT NULL,
  "username" TEXT,
  "fullName" TEXT,
  "phone" TEXT,
  "language" TEXT NOT NULL DEFAULT 'vi',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Customer_telegramId_key" ON "Customer"("telegramId");

CREATE TABLE IF NOT EXISTS "CustomerPayoutBank" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "bankName" TEXT NOT NULL,
  "accountName" TEXT NOT NULL,
  "accountNumber" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerPayoutBank_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Order" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "sourceCurrency" TEXT NOT NULL,
  "targetCurrency" TEXT NOT NULL,
  "sourceAmount" DECIMAL(18,6) NOT NULL,
  "targetAmount" DECIMAL(18,6) NOT NULL,
  "rate" DECIMAL(18,6) NOT NULL,
  "fee" DECIMAL(18,6) NOT NULL,
  "feeCurrency" TEXT NOT NULL,
  "receivingAccountId" TEXT,
  "receivingAccountSnapshot" JSONB,
  "payoutBankSnapshot" JSONB,
  "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  "customerBillFileId" TEXT,
  "customerBillSha256" TEXT,
  "aiExtractedData" JSONB,
  "payoutBillFileId" TEXT,
  "payoutBillSha256" TEXT,
  "verifiedByAdminId" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "payoutByAdminId" TEXT,
  "payoutAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "storageFolder" TEXT,
  "archiveStatus" TEXT DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Order_status_idx" ON "Order"("status");
CREATE INDEX IF NOT EXISTS "Order_customerId_idx" ON "Order"("customerId");

CREATE TABLE IF NOT EXISTS "PaymentAccount" (
  "id" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "bankName" TEXT NOT NULL,
  "accountName" TEXT NOT NULL,
  "accountNumber" TEXT NOT NULL,
  "tag" TEXT NOT NULL DEFAULT 'default',
  "qrFileId" TEXT,
  "qrFilePath" TEXT,
  "qrSha256" TEXT,
  "qrVersion" INTEGER NOT NULL DEFAULT 1,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentAccount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PaymentAccount_currency_isActive_idx" ON "PaymentAccount"("currency", "isActive");
CREATE INDEX IF NOT EXISTS "PaymentAccount_isDefault_idx" ON "PaymentAccount"("isDefault");

CREATE TABLE IF NOT EXISTS "Conversation" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "mode" "ConversationMode" NOT NULL DEFAULT 'AUTO',
  "claimedById" TEXT,
  "claimedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_customerId_key" ON "Conversation"("customerId");

CREATE TABLE IF NOT EXISTS "Message" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "senderType" TEXT NOT NULL,
  "senderId" TEXT,
  "content" TEXT NOT NULL,
  "originalAudioFileId" TEXT,
  "originalAudioSha256" TEXT,
  "translatedContent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
-- NOTE: "Message_conversationId_idx" is intentionally NOT created here.
-- 20260908_production_hardening creates it with a plain (non-idempotent)
-- CREATE INDEX; creating it in the baseline as well would make that
-- historical migration fail with `relation already exists` on a fresh DB.

CREATE TABLE IF NOT EXISTS "InternalNote" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InternalNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StaffUser" (
  "id" TEXT NOT NULL,
  "telegramId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" "StaffRole" NOT NULL DEFAULT 'CSKH',
  "status" "StaffStatus" NOT NULL DEFAULT 'PENDING',
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StaffUser_telegramId_key" ON "StaffUser"("telegramId");

CREATE TABLE IF NOT EXISTS "StaffInvite" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "role" "StaffRole" NOT NULL DEFAULT 'CSKH',
  "createdBy" TEXT NOT NULL,
  "claimedByTelegramId" TEXT,
  "claimedByName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StaffInvite_code_key" ON "StaffInvite"("code");

CREATE TABLE IF NOT EXISTS "AuditLog" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FileEvidence" (
  "id" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "filePath" TEXT NOT NULL,
  "storageRelativePath" TEXT,
  "fileType" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FileEvidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "FileEvidence_sha256_idx" ON "FileEvidence"("sha256");

-- HISTORICAL TABLE (pre-20260907 state — commit 21d1e29 schema evidence).
-- DriveSyncJob existed in the manually-bootstrapped database BEFORE the
-- 20260907 migration ran (which creates "DriveSyncJob_status_idx" on it).
-- It was later REMOVED from the schema by the local-storage transition
-- (commit a118417); 20260914_drop_legacy_drive_sync_job performs that
-- historical removal so the chain ends at the current prisma/schema.prisma.
-- EXACT historical shape (no invented fields — from 21d1e29:prisma/schema.prisma):
CREATE TABLE IF NOT EXISTS "DriveSyncJob" (
  "id" TEXT NOT NULL,
  "orderId" TEXT,
  "jobType" TEXT NOT NULL,
  "fileEvidenceId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "lastError" TEXT,
  "nextRetryAt" TIMESTAMP(3),
  "driveFileId" TEXT,
  "driveFolderId" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DriveSyncJob_pkey" PRIMARY KEY ("id")
);

-- BackupRun base shape: requestedBy/requestedAt/backupType/repositoryType are
-- ADDED by 20260908_production_hardening (plain ADD COLUMN — must NOT pre-exist
-- here). startedAt/finishedAt + the status index belong to the local-storage
-- transition (a118417) that no historical migration covers → created here.
CREATE TABLE IF NOT EXISTS "BackupRun" (
  "id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "snapshotId" TEXT,
  "filesCount" INTEGER,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BackupRun_status_idx" ON "BackupRun"("status");

CREATE TABLE IF NOT EXISTS "SystemSecret" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "encryptedValue" TEXT NOT NULL,
  "iv" TEXT NOT NULL,
  "authTag" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedBy" TEXT NOT NULL,
  CONSTRAINT "SystemSecret_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SystemSecret_key_key" ON "SystemSecret"("key");

-- Foreign keys (reference only tables created above)
DO $$ BEGIN
  ALTER TABLE "CustomerPayoutBank" ADD CONSTRAINT "CustomerPayoutBank_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; WHEN undefined_table THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; WHEN undefined_table THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; WHEN undefined_table THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; WHEN undefined_table THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; WHEN undefined_table THEN null; END $$;