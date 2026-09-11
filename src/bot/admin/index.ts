/**
 * Admin Operations Center — Phase 1 entrypoint.
 *
 * Combines the sub-composers, wires the persistent-keyboard reserved controls
 * and per-admin input sessions, and exposes the precedence helpers used by the
 * main router so Admin private-chat text is NEVER forwarded to a selected
 * customer before reserved controls / input sessions are handled.
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
import { adminActionsHandler, handleAdminPayoutEvidenceMedia } from "./admin-actions.js";
import { adminCustomersHandler, runCustomerSearch, showCustomerList } from "./admin-customers.js";
import { adminCskhHandler, showCskhOverview } from "./admin-cskh.js";
import { adminScreensHandler, showRateScreen } from "./admin-screens.js";

export const adminOperationsHandler = new Composer<BotContext>();

export { handleAdminPayoutEvidenceMedia };

adminOperationsHandler.use(adminOrdersHandler);
adminOperationsHandler.use(adminActionsHandler);
adminOperationsHandler.use(adminCustomersHandler);
adminOperationsHandler.use(adminCskhHandler);
adminOperationsHandler.use(adminScreensHandler);

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
    await showRateScreen(ctx);
  } else if (trimmed === ADMIN_CONTROL_CUSTOMERS) {
    await showCustomerList(ctx);
  } else if (trimmed === ADMIN_CONTROL_CSKH) {
    await showCskhOverview(ctx);
  } else {
    return false;
  }
  return true;
}

/** Active per-admin input session (search / future rate input). */
export async function handleAdminSessionText(ctx: BotContext, text: string): Promise<boolean> {
  if (!isAdminContext(ctx)) return false;

  const telegramId = String(ctx.from?.id || "");
  const session = getAdminSession(telegramId);
  if (session.mode !== "search" || !session.searchType) return false;

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

  return false;
}
