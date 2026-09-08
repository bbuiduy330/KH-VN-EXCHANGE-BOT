import { prisma } from "../../database/client.js";
import { logger } from "../../shared/logger.js";

export type AuditMode = "BEST_EFFORT" | "STRICT";

export interface AuditLogData {
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: any;
}

export class AuditService {
  /**
   * Records an audit log entry.
   * If mode is STRICT (mandatory for all financial operations):
   * An error will throw and abort so the database transaction rolls back.
   * If mode is BEST_EFFORT:
   * Logs error and returns null without throwing.
   */
  static async log(
    data: AuditLogData,
    tx?: any,
    mode: AuditMode = "BEST_EFFORT"
  ) {
    logger.info(
      data,
      `[AUDIT ${mode}] ${data.actorRole} ${data.actorId} executed ${data.action} on ${data.targetType} ${data.targetId}`
    );

    const client = tx || prisma;

    try {
      return await client.auditLog.create({
        data: {
          actorId: data.actorId,
          actorRole: data.actorRole,
          action: data.action,
          targetType: data.targetType,
          targetId: data.targetId,
          details: data.details || {}
        }
      });
    } catch (err: any) {
      logger.error(
        { error: err?.message, action: data.action, targetId: data.targetId, mode },
        "[AUDIT ERROR] Failed to write audit log"
      );

      if (mode === "STRICT") {
        throw new Error(
          `[STRICT AUDIT ABORT] Failed to persist critical financial audit record for ${data.action}: ${err?.message}`
        );
      }

      return null;
    }
  }

  /**
   * Helper specifically for financial operations, state machine transitions, and security overrides.
   * Will ALWAYS throw on audit failure, aborting any active transaction.
   */
  static async logStrict(data: AuditLogData, tx?: any) {
    return this.log(data, tx, "STRICT");
  }

  static async record(data: AuditLogData, tx?: any) {
    return this.log(data, tx, "BEST_EFFORT");
  }

  static async getLogs(targetType?: string, limit: number = 50) {
    return prisma.auditLog.findMany({
      where: targetType ? { targetType } : undefined,
      take: limit,
      orderBy: { createdAt: "desc" }
    });
  }
}
