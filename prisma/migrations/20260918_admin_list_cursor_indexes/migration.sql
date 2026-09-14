-- Admin scalable lists — keyset (cursor) pagination indexes.
-- ADDITIVE ONLY: no column/table changes, no data changes. Idempotent.
-- Query pattern (all admin lists):
--   ORDER BY <sort> DESC, id DESC  WHERE (<sort>, id) < cursor  TAKE 21

CREATE INDEX IF NOT EXISTS "Order_createdAt_id_idx" ON "Order"("createdAt", "id");
CREATE INDEX IF NOT EXISTS "Order_status_createdAt_idx" ON "Order"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "Customer_updatedAt_id_idx" ON "Customer"("updatedAt", "id");
CREATE INDEX IF NOT EXISTS "Partner_createdAt_id_idx" ON "Partner"("createdAt", "id");
CREATE INDEX IF NOT EXISTS "Commission_partnerId_createdAt_idx" ON "Commission"("partnerId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_id_idx" ON "AuditLog"("createdAt", "id");
