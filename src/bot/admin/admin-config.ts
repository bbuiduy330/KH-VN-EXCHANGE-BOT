/**
 * Admin operational config UI. Only exposes REAL, safe runtime settings.
 * Quote validity is NOT editable (fixed 10 minutes by business rule).
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { SystemConfigService } from "../../modules/system-config/system-config-service.js";
import { validateTransferMemoTemplate, generateTransferMemo } from "../../modules/orders/transfer-memo.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { clearWizard, getAdminSession, isSessionExpired, startWizard, updateWizard } from "./admin-session.js";

export const adminConfigHandler = new Composer<BotContext>();

export async function showConfig(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const cfg = SystemConfigService.getConfig();
  // Live preview of the transfer-reference template (sample data).
  const memoPreview = validateTransferMemoTemplate(cfg.transferMemoTemplate).ok
    ? generateTransferMemo(cfg.transferMemoTemplate, {
        orderId: "ORD-SAMPLE12-AB34CD",
        username: "sample_user",
        telegramId: "123456789"
      })
    : "⚠️ template hiện tại không hợp lệ";
  const lines = [
    "⚙️ <b>CẤU HÌNH</b>",
    "",
    `🔔 Kênh thông báo Admin: <code>${escapeHtml(cfg.adminNotificationChatId || "chưa cấu hình")}</code>`,
    `💾 Sao lưu tự động: ${cfg.backupEnabled ? "BẬT" : "TẮT"}`,
    `⏱ Quote hết hạn: <b>${cfg.quoteExpiryMinutes} phút</b> (cố định — không chỉnh sửa)`,
    `🔖 Mẫu nội dung chuyển tiền: <code>${escapeHtml(cfg.transferMemoTemplate)}</code>`,
    `   ↳ Ví dụ sinh ra: <code>${escapeHtml(memoPreview)}</code>`
  ];
  const kb = new InlineKeyboard()
    .text("🔔 Đổi kênh thông báo", "ops:config:edit:notify_chat")
    .text("🔖 Đổi mẫu nội dung", "ops:config:edit:transfer_memo")
    .row()
    .text("💾 Bật/Tắt sao lưu", "ops:config:backup:toggle")
    .row()
    .text("🏠 Menu Admin", "ops:home");

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

const CONFIG_LABEL: Record<string, string> = {
  notify_chat: "Kênh thông báo Admin",
  transfer_memo: "Mẫu nội dung chuyển tiền (transfer reference)"
};

export async function startConfigEdit(ctx: BotContext, key: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  startWizard(String(ctx.from?.id || ""), "config_edit", { key });
  const label = CONFIG_LABEL[key] || key;
  const hint =
    key === "transfer_memo"
      ? `\n\nBiến cho phép: <code>{username}</code>, <code>{shortOrder}</code>, <code>{telegramShort}</code>.\n` +
        `Ví dụ: <code>{shortOrder} CK</code> hoặc <code>{username} {shortOrder}</code>.\n` +
        `Nội dung sinh ra sẽ được làm sạch, giới hạn độ dài và <b>không bao gồm dữ liệu ngân hàng</b>.`
      : "";
  await ctx.reply(`⚙️ <b>${escapeHtml(label)}</b>\n\nNhập giá trị mới.${hint}\n\nGửi /cancel để hủy.`, { parse_mode: "HTML" });
}

export async function handleConfigInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || wizard.kind !== "config_edit") return false;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên cấu hình đã hết hạn.").catch(() => {});
    return true;
  }
  const key = wizard.data.key;
  const value = text.trim();
  if (key === "notify_chat") {
    if (!/^-?\d+$/.test(value)) {
      await ctx.reply("❌ Chat ID phải là số (ví dụ: -100123456789).").catch(() => {});
      return true;
    }
    updateWizard(adminId, { step: 2, data: { value } });
  } else if (key === "transfer_memo") {
    const check = validateTransferMemoTemplate(value);
    if (!check.ok) {
      await ctx.reply(`❌ ${escapeHtml(check.error || "Template không hợp lệ.")}`, { parse_mode: "HTML" }).catch(() => {});
      return true;
    }
    // Preview BEFORE saving: the Admin sees exactly what customers will get.
    const preview = generateTransferMemo(value, {
      orderId: "ORD-SAMPLE12-AB34CD",
      username: "sample_user",
      telegramId: "123456789"
    });
    updateWizard(adminId, { step: 2, data: { value, preview } });
  } else {
    await ctx.reply("❌ Không hỗ trợ chỉnh sửa mục này.").catch(() => {});
    return true;
  }
  const label = CONFIG_LABEL[key] || key;
  const session = getAdminSession(adminId).wizard;
  const extra =
    key === "transfer_memo" && session?.data.preview
      ? `\n\n🔖 <b>Xem trước (khách sẽ thấy nội dung này):</b>\n<code>${escapeHtml(String(session.data.preview))}</code>`
      : "";
  const kb = new InlineKeyboard().text("✅ LƯU", "ops:config:confirm").row().text("❌ HỦY", "ops:config:cancel");
  await ctx.reply(
    `⚠️ <b>XÁC NHẬN</b>\n\n${escapeHtml(label)}: <b>${escapeHtml(String(session?.data.value))}</b>${extra}`,
    { parse_mode: "HTML", reply_markup: kb }
  );
  return true;
}

export async function confirmConfigSave(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  const adminId = String(ctx.from?.id || "");
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên cấu hình đã hết hạn.").catch(() => {});
    return;
  }
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || wizard.kind !== "config_edit") {
    await ctx.reply("⚠️ Không có phiên cấu hình.").catch(() => {});
    return;
  }
  const key = wizard.data.key;
  const value = wizard.data.value;
  if (key === "notify_chat") {
    await SystemConfigService.updateConfig({ adminNotificationChatId: value }, adminId);
  } else if (key === "transfer_memo") {
    await SystemConfigService.setTransferMemoTemplate(String(value), adminId);
  }
  clearWizard(adminId);
  await ctx.reply(`✅ <b>ĐÃ LƯU</b>\n\n${escapeHtml(CONFIG_LABEL[key] || key)}: <b>${escapeHtml(String(value))}</b>`, { parse_mode: "HTML" });
}

export async function cancelConfigWizard(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  clearWizard(String(ctx.from?.id || ""));
  await ctx.reply("Đã hủy thao tác cấu hình.").catch(() => {});
}

export async function toggleBackup(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  const next = !SystemConfigService.isBackupEnabled();
  await SystemConfigService.updateConfig({ backupEnabled: next }, String(ctx.from?.id || ""));
  await ctx.reply(`✅ Đã ${next ? "BẬT" : "TẮT"} sao lưu tự động.`).catch(() => {});
}

adminConfigHandler.callbackQuery("ops:config", (ctx) => showConfig(ctx));
adminConfigHandler.callbackQuery("ops:config:edit:notify_chat", (ctx) => startConfigEdit(ctx, "notify_chat"));
adminConfigHandler.callbackQuery("ops:config:confirm", (ctx) => confirmConfigSave(ctx));
adminConfigHandler.callbackQuery("ops:config:cancel", (ctx) => cancelConfigWizard(ctx));
adminConfigHandler.callbackQuery("ops:config:backup:toggle", (ctx) => toggleBackup(ctx));
