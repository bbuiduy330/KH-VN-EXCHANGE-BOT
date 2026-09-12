-- ===========================================================================
-- TEST-DATA CLEANUP — SAFE PRODUCTION STARTING POINT
-- =============================================================================
-- STATUS: PREPARED ONLY — DO NOT EXECUTE WITHOUT READING THE NOTES BELOW.
--
-- Purpose: this database currently contains TEST DATA only. This script
-- removes all test/business data while preserving every row required for bot
-- startup and operations.
--
-- SAFETY RULES
-- 1. Take a backup FIRST:  pg_dump -Fc "$DATABASE_URL" > pre-clean.dump
-- 2. Run inside the explicit transaction provided (BEGIN … COMMIT). Any error
--    rolls back everything.
-- 3. Never run against a production DATABASE_URL. Verify the target first:
--      SELECT current_database();
--      SELECT count(*) FROM "StaffUser";   -- must match your test admin set
-- 4. prisma migrate reset is FORBIDDEN — this script is the replacement.
-- 5. Physical evidence FILES on disk (LocalStorageService STORAGE_ROOT,
--    default ./data/KH-VN-EXCHANGE) are NOT touched by this script. After
--    COMMIT, remove test bill/payout/voice/QR files from that folder manually
--    if desired (only the DB metadata rows are deleted here).
--
-- DELETION ORDER follows the REAL FK graph (from prisma/schema.prisma):
--   Quote.customerId              -> Customer          ON DELETE CASCADE
--   CustomerPayoutBank.customerId -> Customer          ON DELETE CASCADE
--   Order.customerId              -> Customer          ON DELETE RESTRICT  (parent last)
--   OrderStateHistory.orderId     -> Order             ON DELETE CASCADE
--   OrderBillEvidence.orderId     -> Order             ON DELETE CASCADE
--   Conversation.customerId       -> Customer          ON DELETE CASCADE
--   Message.conversationId        -> Conversation      ON DELETE CASCADE
--   InternalNote.conversationId   -> Conversation      ON DELETE RESTRICT  (parent last)
--   Commission.partnerId          -> Partner           ON DELETE RESTRICT
--   Commission.settlementId       -> PartnerSettlement ON DELETE SET NULL
--   PartnerSettlement.partnerId   -> Partner           ON DELETE RESTRICT
--   Customer.partnerId / Order.partnerId: plain TEXT columns, NO FK.
--
-- SEQUENCES: nothing to reset — every primary key is an application-generated
-- cuid (Prisma @default(cuid())); the schema contains no serial/identity
-- columns. CUID generation is process-local and needs no DB sequence.
-- =============================================================================

BEGIN;

-- =============================================================================
-- DELETIONS (FK-safe order: children -> parents)
-- Total: 18 targeted DELETE statements (17 business-data tables + the
-- CSKH/test-staff StaffUser cleanup at the very end).
-- =============================================================================

-- --- Partner / CTV test data (children before Partner: RESTRICT FKs) --------
-- Commission references Partner (RESTRICT) and PartnerSettlement (SET NULL):
-- delete commissions FIRST so deleting settlements/partners cannot violate
-- anything and no silent SET NULL side effects occur.
DELETE FROM "Commission";
DELETE FROM "PartnerSettlement";
DELETE FROM "Partner";

-- --- Order chain (children cascade with Order; deleted explicitly first) ----
DELETE FROM "OrderBillEvidence";
DELETE FROM "OrderStateHistory";
DELETE FROM "Order";

-- --- Quotes (cascade with Customer; explicit for clarity) -------------------
DELETE FROM "Quote";

-- --- Customer payout banks (cascade with Customer) --------------------------
DELETE FROM "CustomerPayoutBank";

-- --- Support / CSKH: internal notes (RESTRICT FK -> BEFORE conversations) ---
DELETE FROM "InternalNote";

-- --- Support / CSKH: customer/admin message records (cascade w/ convo) ------
DELETE FROM "Message";

-- --- Support / CSKH: sessions/claims ----------------------------------------
DELETE FROM "Conversation";

-- --- Customers (now childless; the RESTRICT FK from Order is satisfied) -----
DELETE FROM "Customer";

-- --- Bill / payment / payout / voice / QR evidence METADATA -----------------
-- (Order.customerBillFileId / payoutBillFileId / OrderBillEvidence.fileId /
--  Message.originalAudioFileId are plain string references — no FK blocks.)
DELETE FROM "FileEvidence";

-- --- Ratings (AuditLog CUSTOMER_RATING) + other test audit records ----------
DELETE FROM "AuditLog";

-- --- Backup scheduler test runs ---------------------------------------------
DELETE FROM "BackupRun";

-- --- Test staff invites (invite artifacts only; staff identity cleanup is
-- --- the final statement below — only ADMIN/SUPER_ADMIN will remain) -------
DELETE FROM "StaffInvite";

-- --- Transient admin input sessions (operational junk, safe at any time) ----
DELETE FROM "AdminInputSession";

-- --- Staff identities: keep ONLY ADMIN / SUPER_ADMIN ------------------------
-- CSKH / support / test StaffUser rows are removed for a clean production
-- starting state. Ordering is already satisfied: by this point every row that
-- can reference staff has been removed (AuditLog, Conversation.claimedById,
-- Order.verifiedByAdminId / payoutByAdminId, StaffInvite.claimedByTelegramId,
-- AdminInputSession.staffId — all plain string references with NO FK), so
-- this filtered DELETE cannot orphan anything. StaffUser rows with
-- role = 'ADMIN' or 'SUPER_ADMIN' are preserved untouched.
DELETE FROM "StaffUser"
WHERE "role" NOT IN ('ADMIN', 'SUPER_ADMIN');

-- =============================================================================
-- PRESERVED (intentionally NO delete statements):
--   "StaffUser" (filtered) – ONLY role = 'ADMIN' / 'SUPER_ADMIN' identities
--                            (CSKH / support / test staff deleted above)
--   "SystemSecret"      – encrypted runtime secrets / Gemini API keys
--   "SystemSetting"     – runtime config (adminNotificationChatId,
--                         transferMemoTemplate, gemini models, backup cfg)
--   "ExchangeRate"      – exchange-rate configuration (USD/VND, USD/KHR, ...)
--   "PaymentAccount"    – SYSTEM receiving payment accounts (incl. QR refs)
--   "PaymentAccountVersion" – receiving-account QR version history (config)
-- =============================================================================

COMMIT;

-- =============================================================================
-- VERIFICATION (run AFTER COMMIT — read-only SELECTs)
-- =============================================================================
-- Staff identities: ONLY ADMIN / SUPER_ADMIN remain (CSKH/test staff gone):
--   SELECT id, "telegramId", name, role, status
--   FROM "StaffUser"
--   ORDER BY role, id;
--   → expect ONLY role = 'ADMIN' / 'SUPER_ADMIN' rows (zero 'CSKH').
--   Permissions non-empty:
--   SELECT "telegramId", array_length(permissions, 1) AS perm_count
--   FROM "StaffUser" WHERE role = 'SUPER_ADMIN';

-- Encrypted secrets / settings / rates / accounts preserved:
--   SELECT key FROM "SystemSecret";
--   SELECT key, "updatedBy" FROM "SystemSetting";
--   SELECT pair, "baseRate" FROM "ExchangeRate";
--   SELECT id, currency, "bankName", "isActive" FROM "PaymentAccount";

-- Test business data = 0:
--   SELECT count(*) AS customers     FROM "Customer";           -- expect 0
--   SELECT count(*) AS orders        FROM "Order";              -- expect 0
--   SELECT count(*) AS quotes        FROM "Quote";              -- expect 0
--   SELECT count(*) AS partners      FROM "Partner";            -- expect 0
--   SELECT count(*) AS commissions   FROM "Commission";         -- expect 0
--   SELECT count(*) AS settlements   FROM "PartnerSettlement";  -- expect 0
--   SELECT count(*) AS conversations FROM "Conversation";       -- expect 0
--   SELECT count(*) AS messages      FROM "Message";            -- expect 0
--   SELECT count(*) AS order_history FROM "OrderStateHistory";  -- expect 0
--   SELECT count(*) AS bill_evidence FROM "OrderBillEvidence";  -- expect 0
--   SELECT count(*) AS file_evidence FROM "FileEvidence";       -- expect 0
--   SELECT count(*) AS audit         FROM "AuditLog";           -- expect 0
--   SELECT count(*) AS payout_banks  FROM "CustomerPayoutBank"; -- expect 0
--   SELECT count(*) AS invites       FROM "StaffInvite";        -- expect 0
--   SELECT count(*) AS sessions      FROM "AdminInputSession";  -- expect 0
--   SELECT count(*) AS backups       FROM "BackupRun";          -- expect 0
--
-- One-shot summary:
--   SELECT
--     (SELECT count(*) FROM "Customer")       AS customers,      -- 0
--     (SELECT count(*) FROM "Order")          AS orders,         -- 0
--     (SELECT count(*) FROM "Quote")          AS quotes,         -- 0
--     (SELECT count(*) FROM "Partner")        AS partners,       -- 0
--     (SELECT count(*) FROM "Commission")     AS commissions,    -- 0
--     (SELECT count(*) FROM "StaffUser")      AS admin_staff_only,   -- ADMIN/SUPER_ADMIN only
--     (SELECT count(*) FROM "StaffUser" WHERE role = 'CSKH') AS cskh_left, -- 0
--     (SELECT count(*) FROM "SystemSecret")   AS secrets_preserved,
--     (SELECT count(*) FROM "SystemSetting")  AS settings_preserved,
--     (SELECT count(*) FROM "ExchangeRate")   AS rates_preserved,
--     (SELECT count(*) FROM "PaymentAccount") AS accounts_preserved;
-- =============================================================================

-- =============================================================================
-- ROLLBACK / SAFETY NOTES
-- =============================================================================
-- * Pre-EXECUTION rollback: simply do not run it.
-- * Mid-transaction error: PostgreSQL auto-aborts the whole BEGIN..COMMIT
--   block; you may also issue an explicit ROLLBACK.
-- * AFTER COMMIT there is no in-database undo — restore the pre-clean dump:
--     pg_restore -d "$DATABASE_URL" --clean pre-clean.dump
-- * If any DELETE fails with an FK violation, the ENTIRE transaction aborts.
--   Do NOT "fix" it with TRUNCATE ... CASCADE (forbidden — it would also wipe
--   the preserved tables). The stated order already satisfies every FK above.
-- * If any real (non-test) Customer must survive, this script cannot be used
--   as-is: deleting a Customer cascades its Conversation/Quote/PayoutBank and
--   is RESTRICT-blocked while its Orders exist. Selective per-customer
--   retention would need parameterised per-customer deletes — intentionally
--   NOT provided, because the stated premise is a test-only database.
-- * Bot startup after cleanup is unaffected: RuntimeConfigService reads
--   SystemSetting (with safe defaults), the Super Admin is re-bootstrapped
--   idempotently from env, and no business rows are required at boot.
-- =============================================================================
