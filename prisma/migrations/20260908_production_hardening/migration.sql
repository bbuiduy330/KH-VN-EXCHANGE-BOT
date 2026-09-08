-- Migration: 20260908_production_hardening
-- Create QuoteStatus Enum
CREATE TYPE "QuoteStatus" AS ENUM ('PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED');

-- CreateTable Quote
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sourceCurrency" TEXT NOT NULL,
    "targetCurrency" TEXT NOT NULL,
    "sourceAmount" DECIMAL(18,6) NOT NULL,
    "targetAmount" DECIMAL(18,6) NOT NULL,
    "effectiveRate" DECIMAL(18,6) NOT NULL,
    "baseRate" DECIMAL(18,6) NOT NULL,
    "fee" DECIMAL(18,6) NOT NULL,
    "feeCurrency" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable SystemSetting
CREATE TABLE "SystemSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable AdminInputSession
CREATE TABLE "AdminInputSession" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "payload" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminInputSession_pkey" PRIMARY KEY ("id")
);

-- AlterTable Message
ALTER TABLE "Message" ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'SENT';
ALTER TABLE "Message" ADD COLUMN "telegramMessageId" INTEGER;
ALTER TABLE "Message" ADD COLUMN "deliveryError" TEXT;

-- AlterTable BackupRun
ALTER TABLE "BackupRun" ADD COLUMN "requestedBy" TEXT NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE "BackupRun" ADD COLUMN "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "BackupRun" ADD COLUMN "backupType" TEXT NOT NULL DEFAULT 'FULL';
ALTER TABLE "BackupRun" ADD COLUMN "repositoryType" TEXT NOT NULL DEFAULT 'RESTIC';
ALTER TABLE "BackupRun" ALTER COLUMN "status" SET DEFAULT 'QUEUED';

-- CreateIndexes
CREATE INDEX "Quote_customerId_status_idx" ON "Quote"("customerId", "status");
CREATE INDEX "Quote_expiresAt_idx" ON "Quote"("expiresAt");
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");
CREATE UNIQUE INDEX "AdminInputSession_staffId_key" ON "AdminInputSession"("staffId");
CREATE INDEX "AdminInputSession_staffId_idx" ON "AdminInputSession"("staffId");
CREATE INDEX "AdminInputSession_expiresAt_idx" ON "AdminInputSession"("expiresAt");
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
