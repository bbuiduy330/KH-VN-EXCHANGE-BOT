import crypto from "node:crypto";
import { prisma } from "../../database/client.js";
import { env } from "../../config/env.js";
import { AuditService } from "../audit/audit-service.js";

export const ALL_PERMISSIONS = [
  "customer.view",
  "customer.message",
  "customer.edit_bank",
  "conversation.view",
  "conversation.claim",
  "conversation.takeover",
  "order.view",
  "order.create_quote",
  "order.view_bill",
  "payment.verify",
  "payout.approve",
  "rate.view",
  "rate.edit",
  "payment_account.view",
  "payment_account.edit",
  "profit.view",
  "staff.manage",
  "permission.manage",
  "audit.view",
  "data.export"
] as const;

export type Permission = typeof ALL_PERMISSIONS[number] | string;

export const DEFAULT_CSKH_PERMISSIONS: Permission[] = [
  "customer.view",
  "customer.message",
  "customer.edit_bank",
  "conversation.view",
  "conversation.claim",
  "order.view",
  "order.create_quote",
  "order.view_bill",
  "rate.view",
  "payment_account.view"
];

export const FORBIDDEN_CSKH_DEFAULTS: Permission[] = [
  "payment.verify",
  "payout.approve",
  "rate.edit",
  "profit.view",
  "staff.manage",
  "permission.manage",
  "data.export"
];

export const DEFAULT_ADMIN_PERMISSIONS: Permission[] = [
  "customer.view",
  "customer.message",
  "customer.edit_bank",
  "conversation.view",
  "conversation.claim",
  "conversation.takeover",
  "order.view",
  "order.create_quote",
  "order.view_bill",
  "payment.verify",
  "payout.approve",
  "rate.view",
  "rate.edit",
  "payment_account.view",
  "payment_account.edit",
  "profit.view",
  "audit.view",
  "data.export"
];

export class PermissionService {
  static isSuperAdmin(telegramId: string): boolean {
    const tid = String(telegramId || "").trim();
    if (!tid) return false;
    if (env.SUPER_ADMIN_TELEGRAM_ID && env.SUPER_ADMIN_TELEGRAM_ID === tid) {
      return true;
    }
    return tid === "super-admin";
  }

  static async bootstrapSuperAdmin() {
    const superAdminId = env.SUPER_ADMIN_TELEGRAM_ID?.trim();
    if (!superAdminId) return null;

    return prisma.staffUser.upsert({
      where: { telegramId: superAdminId },
      update: {
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        permissions: [...ALL_PERMISSIONS]
      },
      create: {
        telegramId: superAdminId,
        name: "Super Admin",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        permissions: [...ALL_PERMISSIONS]
      }
    });
  }

  static async getStaffUser(telegramId: string) {
    const tid = String(telegramId);
    if (this.isSuperAdmin(tid)) {
      return {
        id: "super-admin",
        telegramId: tid,
        name: "Super Admin",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        permissions: [...ALL_PERMISSIONS],
        createdAt: new Date("2026-01-01T00:00:00Z")
      };
    }
    return prisma.staffUser.findUnique({
      where: { telegramId: tid }
    });
  }

  static async hasPermission(telegramId: string, permission: Permission): Promise<boolean> {
    const tid = String(telegramId);
    if (this.isSuperAdmin(tid)) return true;

    const staff = await prisma.staffUser.findUnique({
      where: { telegramId: tid }
    });

    if (!staff || staff.status !== "ACTIVE") return false;

    // Normalizing legacy permission aliases
    const normalizedPerm = this.normalizePermission(permission);

    if (staff.role === "SUPER_ADMIN") return true;

    const assigned = (staff.permissions || []).map((p: string) => this.normalizePermission(p));

    if (staff.role === "ADMIN") {
      // High-privilege permissions require explicit assignment or super admin
      if (normalizedPerm === "permission.manage") {
        return assigned.includes("permission.manage");
      }
      if (normalizedPerm === "staff.manage") {
        return assigned.includes("staff.manage");
      }
      // If admin has an explicit permissions array with items, check it or allow default admin set
      if (assigned.length > 0) {
        return assigned.includes(normalizedPerm) || DEFAULT_ADMIN_PERMISSIONS.includes(normalizedPerm);
      }
      return DEFAULT_ADMIN_PERMISSIONS.includes(normalizedPerm);
    }

    if (staff.role === "CSKH") {
      // Default CSKH strictly cannot verify payment, payout, edit rates, view profit, or manage staff/perms
      // UNLESS explicitly granted in their assigned permissions
      if (FORBIDDEN_CSKH_DEFAULTS.includes(normalizedPerm)) {
        return assigned.includes(normalizedPerm);
      }
      // Allowed if in assigned or in default CSKH permissions
      if (assigned.length > 0) {
        return assigned.includes(normalizedPerm);
      }
      return DEFAULT_CSKH_PERMISSIONS.includes(normalizedPerm);
    }

    return false;
  }

  static normalizePermission(perm: string): string {
    if (perm === "rates.manage") return "rate.edit";
    if (perm === "accounts.manage") return "payment_account.edit";
    if (perm === "payout.process") return "payout.approve";
    if (perm === "cskh.reply") return "customer.message";
    return perm;
  }

  static async canManageStaff(actorTelegramId: string): Promise<boolean> {
    return this.hasPermission(actorTelegramId, "staff.manage");
  }

  static async canManagePermissions(actorTelegramId: string): Promise<boolean> {
    return this.hasPermission(actorTelegramId, "permission.manage");
  }

  static async getAllStaff(page: number = 1, pageSize: number = 5) {
    const skip = (page - 1) * pageSize;
    const all = await prisma.staffUser.findMany({
      orderBy: { createdAt: "desc" }
    });
    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const items = all.slice(skip, skip + pageSize);
    return {
      items,
      total,
      page,
      pageSize,
      totalPages
    };
  }

  static async togglePermission(
    actorTelegramId: string,
    targetTelegramId: string,
    permission: Permission
  ) {
    const canManage = await this.canManagePermissions(actorTelegramId);
    if (!canManage) {
      throw new Error("UNAUTHORIZED: Bạn không có quyền 'permission.manage' để sửa phân quyền.");
    }

    if (this.isSuperAdmin(targetTelegramId)) {
      throw new Error("Không thể thay đổi quyền hạn của Super Admin.");
    }

    const targetStaff = await prisma.staffUser.findUnique({
      where: { telegramId: String(targetTelegramId) }
    });

    if (!targetStaff) {
      throw new Error("Không tìm thấy nhân viên.");
    }

    const currentPermissions: string[] = targetStaff.permissions && targetStaff.permissions.length > 0
      ? [...targetStaff.permissions]
      : (targetStaff.role === "ADMIN" ? [...DEFAULT_ADMIN_PERMISSIONS] : [...DEFAULT_CSKH_PERMISSIONS]);

    const oldValue = currentPermissions.includes(permission);
    const newValue = !oldValue;

    let updatedPermissions: string[];
    if (newValue) {
      updatedPermissions = Array.from(new Set([...currentPermissions, permission]));
    } else {
      updatedPermissions = currentPermissions.filter((p) => p !== permission);
    }

    await prisma.staffUser.update({
      where: { telegramId: String(targetTelegramId) },
      data: { permissions: updatedPermissions }
    });

    const actor = await this.getStaffUser(actorTelegramId);

    await AuditService.log({
      actorId: String(actorTelegramId),
      actorRole: (actor?.role as any) || "ADMIN",
      action: "PERMISSION_CHANGED",
      targetType: "STAFF",
      targetId: String(targetTelegramId),
      details: {
        permission,
        oldValue,
        newValue,
        timestamp: new Date().toISOString()
      }
    });

    return {
      success: true,
      permission,
      oldValue,
      newValue,
      permissions: updatedPermissions,
      updatedPermissions
    };
  }

  static async toggleStaffStatus(actorTelegramId: string, targetTelegramId: string) {
    const canManage = await this.canManageStaff(actorTelegramId);
    if (!canManage) {
      throw new Error("UNAUTHORIZED: Bạn không có quyền 'staff.manage' để thay đổi trạng thái nhân sự.");
    }

    if (this.isSuperAdmin(targetTelegramId)) {
      throw new Error("Không thể khóa tài khoản của Super Admin.");
    }

    const staff = await prisma.staffUser.findUnique({
      where: { telegramId: String(targetTelegramId) }
    });

    if (!staff) throw new Error("Không tìm thấy nhân viên.");

    const newStatus = staff.status === "ACTIVE" ? "DISABLED" : "ACTIVE";

    const updated = await prisma.staffUser.update({
      where: { telegramId: String(targetTelegramId) },
      data: { status: newStatus }
    });

    const actor = await this.getStaffUser(actorTelegramId);
    await AuditService.log({
      actorId: String(actorTelegramId),
      actorRole: (actor?.role as any) || "ADMIN",
      action: "STAFF_STATUS_CHANGED",
      targetType: "STAFF",
      targetId: String(targetTelegramId),
      details: {
        oldStatus: staff.status,
        newStatus,
        timestamp: new Date().toISOString()
      }
    });

    return updated;
  }

  static async resetStaffConversations(actorTelegramId: string, targetTelegramId: string) {
    const canManage = (await this.canManageStaff(actorTelegramId)) || (await this.hasPermission(actorTelegramId, "conversation.takeover"));
    if (!canManage) {
      throw new Error("UNAUTHORIZED: Yêu cầu quyền 'staff.manage' hoặc 'conversation.takeover'.");
    }

    const claimedConvs = await prisma.conversation.findMany({
      where: { claimedById: String(targetTelegramId) }
    });

    for (const c of claimedConvs) {
      await prisma.conversation.update({
        where: { id: c.id },
        data: {
          claimedById: null,
          claimedAt: null,
          mode: "AUTO"
        }
      });
    }

    const actor = await this.getStaffUser(actorTelegramId);
    await AuditService.log({
      actorId: String(actorTelegramId),
      actorRole: (actor?.role as any) || "ADMIN",
      action: "STAFF_CONVERSATION_RESET",
      targetType: "STAFF",
      targetId: String(targetTelegramId),
      details: {
        resetCount: claimedConvs.length,
        timestamp: new Date().toISOString()
      }
    });

    return { resetCount: claimedConvs.length };
  }

  // --- STAFF INVITE FLOW ---

  static async createInvite(
    actorTelegramId: string,
    role: "ADMIN" | "CSKH" = "CSKH",
    expiryHours: number = 24
  ) {
    const canManage = await this.canManageStaff(actorTelegramId);
    if (!canManage) {
      throw new Error("UNAUTHORIZED: Bạn không có quyền 'staff.manage' để tạo mã mời nhân sự.");
    }

    const randomStr = crypto.randomBytes(3).toString("hex").toUpperCase().slice(0, 5);
    const code = `STAFF-${randomStr}`;
    const expiresAt = new Date(Date.now() + expiryHours * 3600 * 1000);

    const invite = await prisma.staffInvite.create({
      data: {
        code,
        role,
        createdBy: String(actorTelegramId),
        status: "PENDING",
        expiresAt
      }
    });

    const actor = await this.getStaffUser(actorTelegramId);
    await AuditService.log({
      actorId: String(actorTelegramId),
      actorRole: (actor?.role as any) || "ADMIN",
      action: "STAFF_INVITE_CREATED",
      targetType: "STAFF_INVITE",
      targetId: code,
      details: { role, expiresAt: expiresAt.toISOString() }
    });

    return invite;
  }

  static async claimInvite(
    code: string,
    telegramId: string,
    fullName: string
  ) {
    const tid = String(telegramId);
    const invite = await prisma.staffInvite.findUnique({
      where: { code: code.trim() }
    });

    if (!invite) {
      throw new Error("Mã mời không tồn tại.");
    }

    if (invite.status !== "PENDING") {
      throw new Error("Mã mời này đã được sử dụng hoặc không còn hiệu lực.");
    }

    if (new Date() > new Date(invite.expiresAt)) {
      await prisma.staffInvite.update({
        where: { code: invite.code },
        data: { status: "EXPIRED" }
      });
      throw new Error("Mã mời đã hết hạn.");
    }

    const existingStaff = await prisma.staffUser.findUnique({
      where: { telegramId: tid }
    });

    if (existingStaff && existingStaff.status === "ACTIVE") {
      throw new Error("Tài khoản Telegram của bạn đã là nhân sự đang hoạt động trong hệ thống.");
    }

    // Mark invite as claimed, pending admin approval
    await prisma.staffInvite.update({
      where: { code: invite.code },
      data: {
        status: "CLAIMED_PENDING_APPROVAL",
        claimedByTelegramId: tid,
        claimedByName: fullName
      }
    });

    // Create or update StaffUser in PENDING state
    const staff = await prisma.staffUser.upsert({
      where: { telegramId: tid },
      update: {
        name: fullName,
        role: invite.role,
        status: "PENDING",
        permissions: invite.role === "ADMIN" ? [...DEFAULT_ADMIN_PERMISSIONS] : [...DEFAULT_CSKH_PERMISSIONS]
      },
      create: {
        telegramId: tid,
        name: fullName,
        role: invite.role,
        status: "PENDING",
        permissions: invite.role === "ADMIN" ? [...DEFAULT_ADMIN_PERMISSIONS] : [...DEFAULT_CSKH_PERMISSIONS]
      }
    });

    await AuditService.log({
      actorId: tid,
      actorRole: "STAFF",
      action: "STAFF_INVITE_CLAIMED",
      targetType: "STAFF_INVITE",
      targetId: invite.code,
      details: { telegramId: tid, name: fullName, role: invite.role }
    });

    return { invite, staff };
  }

  static async approveStaff(
    actorTelegramId: string,
    targetTelegramId: string,
    approved: boolean
  ) {
    const canManage = await this.canManageStaff(actorTelegramId);
    if (!canManage) {
      throw new Error("UNAUTHORIZED: Bạn không có quyền 'staff.manage' để duyệt nhân sự.");
    }

    const tid = String(targetTelegramId);
    const staff = await prisma.staffUser.findUnique({
      where: { telegramId: tid }
    });

    if (!staff) {
      throw new Error("Không tìm thấy hồ sơ nhân sự.");
    }

    const newStatus = approved ? "ACTIVE" : "DISABLED";
    const defaultPerms = staff.role === "ADMIN" ? [...DEFAULT_ADMIN_PERMISSIONS] : [...DEFAULT_CSKH_PERMISSIONS];

    const updated = await prisma.staffUser.update({
      where: { telegramId: tid },
      data: {
        status: newStatus,
        permissions: staff.permissions && staff.permissions.length > 0 ? staff.permissions : defaultPerms
      }
    });

    // Update invite status if found
    const invite = await prisma.staffInvite.findFirst({
      where: { claimedByTelegramId: tid, status: "CLAIMED_PENDING_APPROVAL" }
    });

    if (invite) {
      await prisma.staffInvite.update({
        where: { code: invite.code },
        data: { status: approved ? "APPROVED" : "REJECTED" }
      });
    }

    const actor = await this.getStaffUser(actorTelegramId);
    await AuditService.log({
      actorId: String(actorTelegramId),
      actorRole: (actor?.role as any) || "ADMIN",
      action: approved ? "STAFF_APPROVED" : "STAFF_REJECTED",
      targetType: "STAFF",
      targetId: tid,
      details: { approved, role: staff.role }
    });

    return updated;
  }

  static async getPendingApprovals() {
    return prisma.staffUser.findMany({
      where: { status: "PENDING" }
    });
  }

  static async inviteStaff(data: {
    telegramId: string;
    name: string;
    role: "ADMIN" | "CSKH";
    permissions?: string[];
  }) {
    const tid = String(data.telegramId);
    return prisma.staffUser.upsert({
      where: { telegramId: tid },
      update: {
        name: data.name,
        role: data.role,
        status: "ACTIVE",
        permissions: data.permissions || (data.role === "ADMIN" ? [...DEFAULT_ADMIN_PERMISSIONS] : [...DEFAULT_CSKH_PERMISSIONS])
      },
      create: {
        telegramId: tid,
        name: data.name,
        role: data.role,
        status: "ACTIVE",
        permissions: data.permissions || (data.role === "ADMIN" ? [...DEFAULT_ADMIN_PERMISSIONS] : [...DEFAULT_CSKH_PERMISSIONS])
      }
    });
  }

  static async setStaffStatus(telegramId: string, status: "ACTIVE" | "DISABLED" | "PENDING") {
    return prisma.staffUser.update({
      where: { telegramId: String(telegramId) },
      data: { status }
    });
  }

  /**
   * Focused staff name edit (authoritative; no raw Prisma in callback handlers).
   */
  static async updateStaffName(actorTelegramId: string, targetTelegramId: string, name: string) {
    const canManage = await this.canManageStaff(actorTelegramId);
    if (!canManage) {
      throw new Error("UNAUTHORIZED: Bạn không có quyền 'staff.manage' để sửa tên nhân sự.");
    }
    if (this.isSuperAdmin(targetTelegramId)) {
      throw new Error("Không thể sửa thông tin Super Admin.");
    }
    const trimmed = (name || "").trim();
    if (!trimmed) throw new Error("Tên hiển thị không được để trống.");

    const updated = await prisma.staffUser.update({
      where: { telegramId: String(targetTelegramId) },
      data: { name: trimmed }
    });

    const actor = await this.getStaffUser(actorTelegramId);
    await AuditService.log({
      actorId: String(actorTelegramId),
      actorRole: (actor?.role as any) || "ADMIN",
      action: "STAFF_NAME_UPDATED",
      targetType: "STAFF",
      targetId: String(targetTelegramId),
      details: { timestamp: new Date().toISOString() }
    });

    return updated;
  }

  /**
   * Focused staff role edit with privilege-escalation protection:
   * - only staff.manage holders may act
   * - Super Admin role is never changeable
   * - only SUPER_ADMIN may grant the ADMIN role
   * - demotion resets permissions to the role's safe defaults
   */
  static async updateStaffRole(actorTelegramId: string, targetTelegramId: string, role: "ADMIN" | "CSKH") {
    const canManage = await this.canManageStaff(actorTelegramId);
    if (!canManage) {
      throw new Error("UNAUTHORIZED: Bạn không có quyền 'staff.manage' để đổi vai trò nhân sự.");
    }
    if (this.isSuperAdmin(targetTelegramId)) {
      throw new Error("Không thể đổi vai trò Super Admin.");
    }
    if (role === "ADMIN" && !this.isSuperAdmin(actorTelegramId)) {
      throw new Error("Chỉ Super Admin mới có quyền cấp vai trò ADMIN.");
    }

    const staff = await prisma.staffUser.findUnique({ where: { telegramId: String(targetTelegramId) } });
    if (!staff) throw new Error("Không tìm thấy nhân viên.");

    const defaultPerms = role === "ADMIN" ? [...DEFAULT_ADMIN_PERMISSIONS] : [...DEFAULT_CSKH_PERMISSIONS];

    const updated = await prisma.staffUser.update({
      where: { telegramId: String(targetTelegramId) },
      data: { role, permissions: defaultPerms }
    });

    const actor = await this.getStaffUser(actorTelegramId);
    await AuditService.log({
      actorId: String(actorTelegramId),
      actorRole: (actor?.role as any) || "ADMIN",
      action: "STAFF_ROLE_UPDATED",
      targetType: "STAFF",
      targetId: String(targetTelegramId),
      details: { oldRole: staff.role, newRole: role, timestamp: new Date().toISOString() }
    });

    return updated;
  }
}
