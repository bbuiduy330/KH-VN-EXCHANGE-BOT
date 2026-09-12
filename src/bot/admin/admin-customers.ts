/**
 * Admin customer view — recent list, search, detail. No full CUID in UI.
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { prisma } from "../../database/client.js";
import { OrderService } from "../../modules/orders/order-service.js";
import { QuoteService } from "../../modules/quotes/quote-service.js";
import { ConversationService } from "../../modules/conversation/conversation-service.js";
import { PermissionService } from "../../modules/permissions/permission-service.js";
import { MoneyService } from "../../modules/money/money-service.js";
import { escapeHtml, staffDisplayName } from "../menus/cskh-panel.js";
import { customerLabel, shortOrderId } from "./admin-panel.js";
import { customerIdentity } from "../notifications.js";
import { setAdminSearch } from "./admin-session.js";
import { clearSelectedCustomer, getSelectedCustomer, setSelectedCustomer } from "../state/staff-chat-session.js";
import { formatAdminDate, formatAdminDateTime } from "../../shared/app-time.js";
import {
  computeCrmStats,
  computeCompletedVolume,
  computeRiskLevel,
  orderStatusIcon
} from "../../modules/crm/customer-crm.js";

export const adminCustomersHandler = new Composer<BotContext>();

export async function searchCustomers(query: string): Promise<any[]> {
  const q = String(query || "").trim();
  if (!q) return [];

  const byTelegram = await prisma.customer.findMany({ where: { telegramId: q }, take: 10 });
  if (byTelegram.length) return byTelegram;

  const needle = q.toLowerCase();
  const candidates = await prisma.customer.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return candidates
    .filter((c: any) => {
      if (c.id.toLowerCase().endsWith(needle)) return true;
      if ((c.username || "").toLowerCase().includes(needle)) return true;
      if ((c.fullName || "").toLowerCase().includes(needle)) return true;
      return false;
    })
    .slice(0, 10);
}

export function renderCustomerDetailText(customer: any, conv: any, latestOrder: any, latestQuote: any): string {
  const lines = [
    `👤 <b>KHÁCH HÀNG</b>`,
    "",
    customerIdentity(customer),
    `🌐 ${escapeHtml(customer.language || "vi")}`,
    ""
  ];

  if (latestOrder) {
    lines.push(
      "📦 <b>Đơn hiện tại</b>",
      `${shortOrderId(latestOrder.id)} · ${MoneyService.formatMoney(latestOrder.sourceAmount, latestOrder.sourceCurrency)} → ${MoneyService.formatMoney(latestOrder.targetAmount, latestOrder.targetCurrency)}`
    );
  }
  if (latestQuote) {
    lines.push(
      "💱 <b>Báo giá mới nhất</b>",
      `${MoneyService.formatMoney(latestQuote.sourceAmount, latestQuote.sourceCurrency)} → ${MoneyService.formatMoney(latestQuote.targetAmount, latestQuote.targetCurrency)}`
    );
  }
  if (conv) {
    lines.push(`💬 <b>Hỗ trợ</b>: ${conv.mode === "HUMAN" ? "Đang hỗ trợ" : "AI tự động"}`);
    if (conv.claimedById) {
      lines.push(`👨‍💼 CSKH: ${escapeHtml(staffDisplayName(null, conv.claimedById))}`);
    }
  }
  lines.push("", `🕒 Gia nhập: ${escapeHtml(formatAdminDate(customer.createdAt))} (GMT+7)`);

  return lines.join("\n");
}

export function customerDetailKeyboard(customer: any, latestOrder: any): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.row().text("💬 Hỗ trợ khách", `ops:customer:support:${customer.id}`);
  if (latestOrder) {
    kb.text("📦 Xem đơn", `ops:order:detail:${latestOrder.id}`);
  }
  kb.row().text("🕘 Lịch sử", `ops:customer:history:${customer.id}`);
  kb.row().text("🏠 Menu Admin", "ops:home");
  return kb;
}

/**
 * Customer mini-CRM overview (Part B) — computed on demand from authoritative
 * DB rows; advisory UI only (never blocks an Order, never financial authority).
 */
export function renderCrmOverview(orders: any[], lastTransactionAt: Date | string | null): string {
  const stats = computeCrmStats(orders);
  const rate = stats.cancellationRatePct === null ? "—" : `${stats.cancellationRatePct}%`;
  const vol = computeCompletedVolume(orders);
  const risk = computeRiskLevel(orders);
  const riskLabel =
    risk.level === "HIGH" ? "🔴 Rủi ro cao" : risk.level === "WATCH" ? "🟡 Cần theo dõi" : "🟢 Bình thường";
  const lines = [
    "📊 <b>GIAO DỊCH</b>",
    `✅ Hoàn tất: <b>${stats.completed}</b> · ❌ Đã hủy: <b>${stats.cancelled}</b> · ⏳ Active: <b>${stats.active}</b>`,
    `📉 Tỷ lệ hủy: <b>${rate}</b>`,
    "",
    "💰 <b>Khối lượng hoàn tất</b>",
    `USD → VND: <b>${vol.usdToVnd ? `${MoneyService.formatAmount(vol.usdToVnd, "USD")} USD` : "—"}</b>`,
    `VND → USD: <b>${vol.vndToUsd ? `${MoneyService.formatAmount(vol.vndToUsd, "VND")} VND` : "—"}</b>`,
    "",
    riskLabel,
    ...risk.reasons.map((r) => `• ${escapeHtml(r)}`),
    "",
    `🕒 Giao dịch gần nhất: ${lastTransactionAt ? escapeHtml(formatAdminDateTime(lastTransactionAt)) : "—"}`
  ];
  return lines.join("\n");
}

export async function showCustomerDetail(ctx: BotContext, customerId: string): Promise<void> {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    await ctx.reply("❌ Không tìm thấy khách hàng.").catch(() => {});
    return;
  }
  const [conv, latestOrder, latestQuote, crmOrders] = await Promise.all([
    prisma.conversation.findUnique({ where: { customerId } }),
    OrderService.getLatestActiveOrderForCustomer(customerId),
    QuoteService.getLatestActiveQuote(customerId),
    prisma.order.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { status: true, sourceCurrency: true, sourceAmount: true, createdAt: true }
    })
  ]);
  const lastTransactionAt = crmOrders.length > 0 ? crmOrders[0].createdAt : null;

  const text =
    renderCustomerDetailText(customer, conv, latestOrder, latestQuote) +
    "\n\n" +
    renderCrmOverview(crmOrders, lastTransactionAt);
  const kb = customerDetailKeyboard(customer, latestOrder);
  // 📨 Gửi thông báo → Broadcast composer preselected for THIS customer (C11).
  kb.row().text("📨 Gửi thông báo", `ops:bcast:one:${customer.id}`);

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function showCustomerHistory(
  ctx: BotContext,
  customerId: string,
  filter: string = "all"
): Promise<void> {
  await ctx.answerCallbackQuery();
  const where: any = { customerId };
  if (filter === "completed") where.status = "COMPLETED";
  else if (filter === "cancelled") where.status = "CANCELLED";
  else if (filter === "active") {
    where.status = {
      in: ["WAITING_PAYMENT", "CUSTOMER_SENT_BILL", "WAITING_ADMIN_VERIFY", "PAYMENT_CONFIRMED", "WAITING_PAYOUT", "PAYOUT_SENT", "PAYMENT_MISMATCH", "MANUAL_REVIEW", "SUSPICIOUS"]
    };
  }
  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 10
  });
  const filterLabel = filter === "completed" ? "✅ Thành công" : filter === "cancelled" ? "❌ Đã hủy" : filter === "active" ? "⏳ Đang xử lý" : "📦 Tất cả";
  const lines = [`🕘 <b>LỊCH SỬ ĐƠN HÀNG</b> · ${filterLabel}`, ""];
  const kb = new InlineKeyboard();
  if (orders.length === 0) {
    lines.push("Chưa có đơn hàng nào.");
  } else {
    for (const o of orders) {
      // Compact row: status visible WITHOUT opening the detail (B4).
      lines.push(
        `${orderStatusIcon(o.status)} ${formatAdminDateTime(o.createdAt)} · ${shortOrderId(o.id)} · ${MoneyService.formatMoney(o.sourceAmount, o.sourceCurrency)} → ${MoneyService.formatMoney(o.targetAmount, o.targetCurrency)}`
      );
      kb.row().text(`${orderStatusIcon(o.status)} ${shortOrderId(o.id)}`, `ops:order:detail:${o.id}`);
    }
  }
  kb.row()
    .text(`⏳ Đang xử lý`, `ops:customer:history:${customerId}:active`)
    .text(`✅ Thành công`, `ops:customer:history:${customerId}:completed`)
    .row()
    .text(`❌ Đã hủy`, `ops:customer:history:${customerId}:cancelled`)
    .text(`📦 Tất cả`, `ops:customer:history:${customerId}:all`)
    .row()
    .text("⬅️ Chi tiết khách", `ops:customer:detail:${customerId}`)
    .text("🏠 Menu Admin", "ops:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

export async function showCustomerList(ctx: BotContext): Promise<void> {
  if (!(await requirePermission(ctx, "customer.view"))) return;
  const customers = await prisma.customer.findMany({ orderBy: { createdAt: "desc" }, take: 10 });

  const lines = ["👥 <b>KHÁCH HÀNG GẦN ĐÂY</b>", ""];
  const kb = new InlineKeyboard();
  if (customers.length === 0) {
    lines.push("Chưa có khách hàng nào.");
  } else {
    for (const c of customers) {
      lines.push(`👤 ${escapeHtml(customerLabel(c))}${c.telegramId ? ` · 🆔 <code>${c.telegramId}</code>` : ""} · 🔖 #${String(c.id).slice(-6).toUpperCase()}`);
      kb.row().text(`👤 ${escapeHtml(customerLabel(c))}`, `ops:customer:detail:${c.id}`);
    }
  }
  kb.row().text("🔎 Tìm khách", "ops:customers:search").text("🏠 Menu Admin", "ops:home");
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

export async function runCustomerSearch(ctx: BotContext, query: string): Promise<void> {
  const matches = await searchCustomers(query);
  if (matches.length === 0) {
    await ctx.reply("🔎 Không tìm thấy khách hàng nào khớp.");
    return;
  }
  if (matches.length === 1) {
    await showCustomerDetail(ctx, matches[0].id);
    return;
  }
  const lines = [`🔎 <b>Tìm thấy ${matches.length} khách:</b>`, ""];
  const kb = new InlineKeyboard();
  for (const c of matches) {
    lines.push(`👤 ${escapeHtml(customerLabel(c))}${c.telegramId ? ` · 🆔 <code>${c.telegramId}</code>` : ""} · 🔖 #${String(c.id).slice(-6).toUpperCase()}`);
    kb.row().text(`👤 ${escapeHtml(customerLabel(c))}`, `ops:customer:detail:${c.id}`);
  }
  kb.row().text("🏠 Menu Admin", "ops:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

adminCustomersHandler.callbackQuery("ops:customers", (ctx) => showCustomerList(ctx));
adminCustomersHandler.callbackQuery("ops:customers:search", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "customer.view"))) return;
  setAdminSearch(String(ctx.from?.id || ""), "customer");
  await ctx.reply("🔎 <b>Tìm khách hàng</b>\n\nNhập tên, @username, Telegram ID hoặc mã ngắn.\n\nGửi /cancel để hủy.", { parse_mode: "HTML" });
});
adminCustomersHandler.callbackQuery(/^ops:customer:detail:(.+)$/, async (ctx) => {
  if (!(await requirePermission(ctx, "customer.view"))) return;
  await showCustomerDetail(ctx, ctx.match?.[1] || "");
});
adminCustomersHandler.callbackQuery(/^ops:customer:history:(.+)$/, (ctx) => {
  const raw = ctx.match?.[1] || "";
  const sep = raw.lastIndexOf(":");
  const hasFilter = ["active", "completed", "cancelled", "all"].includes(raw.slice(sep + 1));
  const customerId = hasFilter ? raw.slice(0, sep) : raw;
  const filter = hasFilter ? raw.slice(sep + 1) : "all";
  return showCustomerHistory(ctx, customerId, filter);
});

// ---------------------------------------------------------------------------
// Admin → customer direct support (reuses existing C3 claim/selected-chat)
// ---------------------------------------------------------------------------

export async function showCustomerSupport(ctx: BotContext, customerId: string): Promise<void> {
  if (!(await requirePermission(ctx, "customer.message"))) return;
  const adminId = String(ctx.from?.id || "");
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    await ctx.reply("❌ Không tìm thấy khách hàng.").catch(() => {});
    return;
  }
  const conv = await ConversationService.getOrCreateConversation(customerId);
  const lines = ["💬 <b>HỖ TRỢ KHÁCH</b>", "", `👤 ${escapeHtml(customerLabel(customer))}`];
  const kb = new InlineKeyboard();
  if (conv.claimedById === adminId) {
    lines.push("Bạn đang hỗ trợ khách này.");
    kb.row().text("↩️ Kết thúc hỗ trợ", `ops:customer:support:release:${customerId}`);
  } else if (conv.claimedById) {
    const owner = await PermissionService.getStaffUser(conv.claimedById);
    lines.push(`👨‍💼 Đang hỗ trợ: ${escapeHtml(staffDisplayName(owner, conv.claimedById))}`);
    kb.row().text("🔄 Chiếm quyền hỗ trợ", `ops:customer:support:claim:${customerId}`);
  } else {
    lines.push("Chưa có ai hỗ trợ.");
    kb.row().text("✅ Nhận khách", `ops:customer:support:claim:${customerId}`);
  }
  kb.row().text("⬅️ Quay lại", `ops:customer:detail:${customerId}`).text("🏠 Menu Admin", "ops:home");

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

export async function claimCustomerAsAdmin(ctx: BotContext, customerId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "customer.message"))) return;
  const adminId = String(ctx.from?.id || "");
  try {
    const conv = await ConversationService.getOrCreateConversation(customerId);
    if (conv.claimedById && conv.claimedById !== adminId) {
      await ConversationService.release(customerId, adminId, "ADMIN", ctx.identity?.staff?.permissions || []);
    }
    await ConversationService.claim(customerId, adminId, "ADMIN");
    setSelectedCustomer(adminId, customerId);
    await ctx.reply("✅ Đã nhận hỗ trợ khách. Gửi tin nhắn để trả lời (chế độ riêng cho bạn).", { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function releaseCustomerAsAdmin(ctx: BotContext, customerId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "customer.message"))) return;
  const adminId = String(ctx.from?.id || "");
  try {
    await ConversationService.release(customerId, adminId, "ADMIN", ctx.identity?.staff?.permissions || []);
    clearSelectedCustomer(adminId);
    await ctx.reply("✅ Đã kết thúc hỗ trợ.").catch(() => {});
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

adminCustomersHandler.callbackQuery(/^ops:customer:support:(.+)$/, (ctx) => showCustomerSupport(ctx, ctx.match?.[1] || ""));
adminCustomersHandler.callbackQuery(/^ops:customer:support:claim:(.+)$/, (ctx) => claimCustomerAsAdmin(ctx, ctx.match?.[1] || ""));
adminCustomersHandler.callbackQuery(/^ops:customer:support:release:(.+)$/, (ctx) => releaseCustomerAsAdmin(ctx, ctx.match?.[1] || ""));

