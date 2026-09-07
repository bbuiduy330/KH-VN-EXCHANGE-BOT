import { PermissionService, Permission } from "../../modules/permissions/permission-service.js";
import { BotContext } from "./identity.js";

export async function hasStaffPermission(telegramId: string, permission: Permission): Promise<boolean> {
  return PermissionService.hasPermission(telegramId, permission);
}

export async function requirePermission(ctx: BotContext, permission: Permission): Promise<boolean> {
  const telegramId = String(ctx.from?.id || "");
  if (!telegramId) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "⛔ Bạn không có quyền truy cập chức năng này.", show_alert: true }).catch(() => {});
    } else {
      await ctx.reply("⛔ Bạn không có quyền truy cập chức năng này.").catch(() => {});
    }
    return false;
  }

  const allowed = await PermissionService.hasPermission(telegramId, permission);
  if (!allowed) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "⛔ Bạn không có quyền truy cập chức năng này.", show_alert: true }).catch(() => {});
    } else {
      await ctx.reply("⛔ Bạn không có quyền truy cập chức năng này.").catch(() => {});
    }
    return false;
  }

  return true;
}

export async function requireRole(ctx: BotContext, allowedRoles: string[]): Promise<boolean> {
  const userType = ctx.identity?.userType;
  if (!userType || !allowedRoles.includes(userType)) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "⛔ Bạn không có quyền truy cập chức năng này.", show_alert: true }).catch(() => {});
    } else {
      await ctx.reply("⛔ Bạn không có quyền truy cập chức năng này.").catch(() => {});
    }
    return false;
  }
  return true;
}
