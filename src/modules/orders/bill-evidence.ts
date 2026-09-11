/**
 * ONE authoritative reader for the customer's payment bill/evidence (G).
 *
 * Competing storage paths existed historically:
 *  - Order.customerBillFileId        (promoted primary reference -> FileEvidence)
 *  - OrderBillEvidence rows          (evidence table; re-uploads only land here)
 *
 * Readers must NEVER depend on which path the current upload populated.
 * This helper returns the actual latest/current customer payment evidence
 * regardless of legacy vs current storage. It NEVER duplicates evidence and
 * NEVER returns Admin payout evidence as the customer bill.
 */
import { prisma } from "../../database/client.js";
import { logger } from "../../shared/logger.js";

export interface CustomerBillEvidence {
  /** FileEvidence row id (same id space as Order.customerBillFileId). */
  evidenceId: string;
  fileName: string | null;
  filePath: string | null;
  mimeType: string | null;
  sha256: string | null;
  /** Where the evidence reference was found (for diagnostics only). */
  source: "primary" | "evidence-table";
}

export async function getCustomerBillEvidence(orderId: string): Promise<CustomerBillEvidence | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { bills: { orderBy: { createdAt: "desc" }, take: 1 } }
  });
  if (!order) return null;

  // 1. Promoted primary reference (authoritative when present).
  if (order.customerBillFileId) {
    const evidence = await prisma.fileEvidence.findUnique({ where: { id: order.customerBillFileId } });
    if (evidence) {
      return {
        evidenceId: evidence.id,
        fileName: evidence.fileName || null,
        filePath: evidence.filePath || null,
        mimeType: evidence.mimeType || null,
        sha256: evidence.sha256 || null,
        source: "primary"
      };
    }
    logger.warn({ orderRef: orderId.slice(-6) }, "customerBillFileId set but FileEvidence row missing — falling back to evidence table");
  }

  // 2. Latest evidence-table row (covers re-uploads / legacy splits).
  const latest = order.bills?.[0];
  if (latest) {
    const evidence = await prisma.fileEvidence.findUnique({ where: { id: latest.fileId } });
    if (evidence) {
      return {
        evidenceId: evidence.id,
        fileName: evidence.fileName || null,
        filePath: evidence.filePath || latest.filePath || null,
        mimeType: evidence.mimeType || null,
        sha256: evidence.sha256 || latest.sha256 || null,
        source: "evidence-table"
      };
    }
    // Evidence row carries its own path even without a FileEvidence row.
    if (latest.filePath) {
      return {
        evidenceId: latest.id,
        fileName: null,
        filePath: latest.filePath,
        mimeType: null,
        sha256: latest.sha256 || null,
        source: "evidence-table"
      };
    }
  }

  return null;
}

/** Cheap boolean for keyboards/lists: does THIS order have customer bill evidence? */
export function hasCustomerBillEvidence(order: { customerBillFileId?: string | null; bills?: { id: string }[] } | null | undefined): boolean {
  if (!order) return false;
  return Boolean(order.customerBillFileId) || (Array.isArray(order.bills) && order.bills.length > 0);
}
