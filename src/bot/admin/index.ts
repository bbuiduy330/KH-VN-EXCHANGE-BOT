/**
 * Admin Operations Center — Phase 2 entrypoint.
 *
 * Combines the sub-composers, wires the persistent-keyboard reserved controls,
 * per-admin input sessions and multi-step wizards, and exposes the precedence
 * helpers used by the main router so Admin private-chat text/media is NEVER
 * forwarded to a selected customer before reserved controls / sessions are
 * handled.
 */
import { Composer } from "grammy";
import { BotContext } from "../middleware/identity.js";
import {
  ADMIN_CONTROL_CSKH,
  ADMIN_CONTROL_CUSTOMERS,
  ADMIN_CONTROL_HOME,
  ADMIN_CONTROL_INBOX,
  ADMIN_CONTROL_ORDERS,
  ADMIN_CONTROL_RATES,
  isAdminContext,
  isAdminReservedControl,
  showOperationsCenter
} from "./admin-panel.js";
import { clearAdminSession, getAdminSession } from "./admin-session.js";
import { adminOrdersHandler, runOrderSearch, showActionInbox, showOrderList } from "./admin-orders.js";
import { adminActionsHandler, handleAdminPayoutEvidenceMedia, handleCancelReasonInput } from "./admin-actions.js";
import { adminCustomersHandler, runCustomerSearch, showCustomerList } from "./admin-customers.js";
import { adminCskhHandler, showCskhOverview } from "./admin-cskh.js";
import { adminScreensHandler } from "./admin-screens.js";
import { adminRatesHandler, showRateManagement, handleRateWizardInput } from "./admin-rates.js";
import { adminAccountsHandler, handleAccountWizardInput, handlePriorityInput, handleAccountAddQrMedia, handleAccountQrUpdateMedia } from "./admin-accounts.js";
import { adminStaffHandler, handleStaffWizardInput, handleStaffNameInput } from "./admin-staff.js";
import { adminAiHandler, handleAiKeyInput, handleAiModelInput, handleAiVoiceTestMedia } from "./admin-ai.js";
import { adminConfigHandler, handleConfigInput } from "./admin-config.js";
import { adminAuditHandler } from "./admin-audit.js";

export const adminOperationsHandler = new Composer<BotContext>();

export { handleAdminPayoutEvidenceMedia, handleAiVoiceTestMedia, showOperationsCenter, handleAccountAddQrMedia, handleAccountQrUpdateMedia };

adminOperationsHandler.use(adminOrdersHandler);
adminOperationsHandler.use(adminActionsHandler);
adminOperationsHandler.use(adminCustomersHandler);
adminOperationsHandler.use(adminCskhHandler);
adminOperationsHandler.use(adminScreensHandler);
adminOperationsHandler.use(adminRatesHandler);
adminOperationsHandler.use(adminAccountsHandler);
adminOperationsHandler.use(adminStaffHandler);
adminOperationsHandler.use(adminAiHandler);
adminOperationsHandler.use(adminConfigHandler);
adminOperationsHandler.use(adminAuditHandler);

adminOperationsHandler.callbackQuery("ops:home", (ctx) => showOperationsCenter(ctx));

adminOperationsHandler.command("cancel", async (ctx) => {
  if (!isAdminContext(ctx)) return;
  clearAdminSession(String(ctx.from?.id || ""));
  await ctx.reply("Đã hủy thao tác.").catch(() => {});
});

/** Reserved persistent-keyboard controls — must win over CSKH forwarding. */
export async function handleAdminReservedText(ctx: BotContext, text: string): Promise<boolean> {
  if (!isAdminContext(ctx)) return false;
  if (!isAdminReservedControl(text)) return false;

  const trimmed = text.trim();
  if (trimmed === ADMIN_CONTROL_HOME) {
    await showOperationsCenter(ctx);
  } else if (trimmed === ADMIN_CONTROL_INBOX) {
    await showActionInbox(ctx);
  } else if (trimmed === ADMIN_CONTROL_ORDERS) {
    await showOrderList(ctx, "need_action");
  } else if (trimmed === ADMIN_CONTROL_RATES) {
    await showRateManagement(ctx);
  } else if (trimmed === ADMIN_CONTROL_CUSTOMERS) {
    await showCustomerList(ctx);
  } else if (trimmed === ADMIN_CONTROL_CSKH) {
    await showCskhOverview(ctx);
  } else {
    return false;
  }
  return true;
}

/** Active per-admin input session (search + multi-step wizards). */
export async function handleAdminSessionText(ctx: BotContext, text: string): Promise<boolean> {
  if (!isAdminContext(ctx)) return false;

  const telegramId = String(ctx.from?.id || "");
  const session = getAdminSession(telegramId);

  // 1. Multi-step wizard input takes precedence.
  if (session.wizard) {
    const kind = session.wizard.kind;
    if (kind === "rate_edit") return handleRateWizardInput(ctx, text);
    if (kind === "account_add") return handleAccountWizardInput(ctx, text);
    if (kind === "account_priority") return handlePriorityInput(ctx, text);
    if (kind === "staff_add") return handleStaffWizardInput(ctx, text);
    if (kind === "staff_name_edit") return handleStaffNameInput(ctx, text);
    if (kind === "ai_key_input") return handleAiKeyInput(ctx, text);
    if (kind === "ai_text_model" || kind === "ai_stt_model") return handleAiModelInput(ctx, text);
    if (kind === "config_edit") return handleConfigInput(ctx, text);
    if (kind === "order_cancel_reason") return handleCancelReasonInput(ctx, text);
    if (kind === "account_qr") {
      await ctx.reply("📷 Vui lòng gửi <b>ảnh QR</b> vào khung chat, hoặc gửi /cancel để hủy.", { parse_mode: "HTML" });
      return true;
    }
  }

  // 2. Search session.
  if (session.mode === "search" && session.searchType) {
    if (text.trim() === "/cancel") {
      clearAdminSession(telegramId);
      await ctx.reply("Đã hủy tìm kiếm.").catch(() => {});
      return true;
    }
    if (session.searchType === "order") {
      clearAdminSession(telegramId);
      await runOrderSearch(ctx, text);
      return true;
    }
    if (session.searchType === "customer") {
      clearAdminSession(telegramId);
      await runCustomerSearch(ctx, text);
      return true;
    }
  }

  return false;
}
