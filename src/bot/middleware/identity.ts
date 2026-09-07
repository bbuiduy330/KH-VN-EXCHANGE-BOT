import { Context, NextFunction } from "grammy";
import { prisma } from "../../database/client.js";
import { PermissionService, ALL_PERMISSIONS } from "../../modules/permissions/permission-service.js";

export type UserType = "CUSTOMER" | "CSKH" | "ADMIN" | "SUPER_ADMIN";

export interface UserIdentity {
  telegramId: string;
  userType: UserType;
  staff?: any | null;
  status: "ACTIVE" | "PENDING" | "DISABLED";
  permissions: string[];
}

export type BotContext = Context & {
  identity?: UserIdentity;
};

export async function resolveUserIdentity(telegramId: string): Promise<UserIdentity> {
  const tid = String(telegramId || "").trim();
  if (!tid) {
    return {
      telegramId: "",
      userType: "CUSTOMER",
      status: "ACTIVE",
      permissions: []
    };
  }

  // 1. Super Admin check
  if (PermissionService.isSuperAdmin(tid)) {
    return {
      telegramId: tid,
      userType: "SUPER_ADMIN",
      status: "ACTIVE",
      staff: {
        id: "super-admin",
        telegramId: tid,
        name: "Super Admin",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        permissions: [...ALL_PERMISSIONS]
      },
      permissions: [...ALL_PERMISSIONS]
    };
  }

  // 2. Check StaffUser table
  const staff = await prisma.staffUser.findUnique({
    where: { telegramId: tid }
  });

  if (!staff) {
    // Unknown Telegram ID → CUSTOMER
    return {
      telegramId: tid,
      userType: "CUSTOMER",
      status: "ACTIVE",
      permissions: []
    };
  }

  const role = staff.role as UserType;
  const permissions = Array.isArray(staff.permissions) ? staff.permissions : [];

  return {
    telegramId: tid,
    userType: role,
    status: (staff.status as any) || "ACTIVE",
    staff,
    permissions
  };
}

export async function identityMiddleware(ctx: BotContext, next: NextFunction) {
  const telegramId = String(ctx.from?.id || "");
  if (telegramId) {
    ctx.identity = await resolveUserIdentity(telegramId);
  }
  await next();
}
