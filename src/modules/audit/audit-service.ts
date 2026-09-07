import { prisma } from "../../database/client.js";
import { logger } from "../../shared/logger.js";

export class AuditService {
  static async log(
    data: {
      actorId: string;
      actorRole: string;
      action: string;
      targetType: string;
      targetId: string;
      details?: any;
    },
    tx?: any
  ) {
    logger.info(data, `[AUDIT] ${data.actorRole} ${data.actorId} executed ${data.action} on ${data.targetType} ${data.targetId}`);
    try {
      const client = tx || prisma;
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
    } catch (err) {
      logger.error({ err }, "Failed to write audit log");
      return null;
    }
  }

  static async record(
    data: {
      actorId: string;
      actorRole: string;
      action: string;
      targetType: string;
      targetId: string;
      details?: any;
    },
    tx?: any
  ) {
    return this.log(data, tx);
  }

  static async getLogs(targetType?: string, limit: number = 50) {
    return prisma.auditLog.findMany({
      where: targetType ? { targetType } : undefined,
      take: limit,
      orderBy: { createdAt: "desc" }
    });
  }
}
