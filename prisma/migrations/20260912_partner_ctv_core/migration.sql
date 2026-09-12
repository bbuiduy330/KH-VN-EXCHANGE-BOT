-- Partner / CTV core (additive, safe for existing production rows).
-- All new Customer/Order columns are NULLable — no backfill, no rewrites,
-- no drops. New tables are independent.

CREATE TABLE "Partner" (
    "id" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "telegramId" TEXT,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "baseCommissionUsd" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "spreadSharePercent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "holdHours" INTEGER NOT NULL DEFAULT 72,
    "payoutBankName" TEXT,
    "payoutAccountNumber" TEXT,
    "payoutAccountName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Commission" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "baseCommissionUsd" DECIMAL(18,6) NOT NULL,
    "spreadBonusUsd" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "totalUsd" DECIMAL(18,6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "availableAt" TIMESTAMP(3),
    "riskFlag" TEXT,
    "settlementId" TEXT,
    "paidAt" TIMESTAMP(3),
    "reversedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Commission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PartnerSettlement" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "totalUsd" DECIMAL(18,6) NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerSettlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Partner_referralCode_key" ON "Partner"("referralCode");
CREATE UNIQUE INDEX "Partner_telegramId_key" ON "Partner"("telegramId");

CREATE UNIQUE INDEX "Commission_orderId_key" ON "Commission"("orderId");
CREATE INDEX "Commission_partnerId_status_idx" ON "Commission"("partnerId", "status");

ALTER TABLE "Commission" ADD CONSTRAINT "Commission_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "PartnerSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PartnerSettlement" ADD CONSTRAINT "PartnerSettlement_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Attribution columns (nullable snapshots; existing rows keep NULL = unattributed)
ALTER TABLE "Customer" ADD COLUMN "partnerId" TEXT;
ALTER TABLE "Customer" ADD COLUMN "partnerAssignedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "partnerId" TEXT;

CREATE INDEX "Order_partnerId_idx" ON "Order"("partnerId");
