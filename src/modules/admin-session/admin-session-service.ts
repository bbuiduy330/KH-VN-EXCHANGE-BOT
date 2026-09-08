import { prisma } from "../../database/client.js";
import { logger } from "../../shared/logger.js";

export interface InputSessionData {
  id: string;
  staffId: string;
  action: string;
  step: string;
  payload: any;
  expiresAt: Date;
}

export class AdminSessionService {
  private static readonly DEFAULT_EXPIRY_MINUTES = 10;

  /**
   * Starts or replaces an active input session for a staff member.
   * Only one active session per staff.
   */
  static async setSession(
    staffId: string,
    action: string,
    step: string = "INIT",
    payload: any = {},
    expiryMinutes: number = this.DEFAULT_EXPIRY_MINUTES
  ): Promise<InputSessionData> {
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    const session = await prisma.adminInputSession.upsert({
      where: { staffId },
      update: {
        action,
        step,
        payload: payload || {},
        expiresAt,
        updatedAt: new Date()
      },
      create: {
        staffId,
        action,
        step,
        payload: payload || {},
        expiresAt
      }
    });

    return session as InputSessionData;
  }

  /**
   * Retrieves active session for staff. If expired, deletes it and returns null.
   */
  static async getSession(staffId: string): Promise<InputSessionData | null> {
    const session = await prisma.adminInputSession.findUnique({
      where: { staffId }
    });

    if (!session) return null;

    if (new Date() > new Date(session.expiresAt)) {
      await this.clearSession(staffId);
      return null;
    }

    return session as InputSessionData;
  }

  /**
   * Updates current session step and merged payload
   */
  static async updateStep(
    staffId: string,
    step: string,
    additionalPayload: any = {}
  ): Promise<InputSessionData | null> {
    const current = await this.getSession(staffId);
    if (!current) return null;

    const mergedPayload = {
      ...(current.payload || {}),
      ...additionalPayload
    };

    const expiresAt = new Date(Date.now() + this.DEFAULT_EXPIRY_MINUTES * 60 * 1000);

    const updated = await prisma.adminInputSession.update({
      where: { staffId },
      data: {
        step,
        payload: mergedPayload,
        expiresAt,
        updatedAt: new Date()
      }
    });

    return updated as InputSessionData;
  }

  /**
   * Clears the active session for a staff member
   */
  static async clearSession(staffId: string): Promise<void> {
    try {
      await prisma.adminInputSession.deleteMany({
        where: { staffId }
      });
    } catch (err: any) {
      logger.warn({ staffId, error: err?.message }, "Could not clear admin input session");
    }
  }

  /**
   * Maintenance: prune all expired sessions
   */
  static async pruneExpired(): Promise<number> {
    try {
      const res = await prisma.adminInputSession.deleteMany({
        where: { expiresAt: { lt: new Date() } }
      });
      return res.count;
    } catch {
      return 0;
    }
  }
}
