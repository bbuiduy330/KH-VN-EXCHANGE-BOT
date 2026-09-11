/**
 * Admin customer view — recent list, search, detail. No full CUID in UI.
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { prisma } from "../../database/client.js";
import { OrderService } from "../../modules/orders/order-service.js";
import { QuoteService } from "../../modules/quotes/quote-service.js";
import { MoneyService } from "../../modules/money/money-service.js";
import { escapeHtml, staffDisplayName } from "../menus/cskh-panel.js";
import { customerLabel, shortCustomerId, shortOrderId } from "./admin-panel.js";
import { setAdminSearch } from "./admin-session.js";

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
    `👤 ${escapeHtml(customerLabel(customer))}`,
    customer.username ? `🔗 @${escapeHtml(customer.username)}` : "",
    `🆔 ${shortCustomerId(customer.id)}`,
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
  lines.push("", `🕒 Gia nhập: ${escapeHtml(new Date(customer.createdAt).toLocaleDateString("vi-VN"))}`);

  return lines.join("\n");
}

export function customerDetailKeyboard(customer: any, latestOrder: any): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (latestOrder) {
    kb.text("📦 Xem đơn", `ops:order:detail:${latestOrder.id}`);
  }
  kb.row().text("🕘 Lịch sử", `ops:customer:history:${customer.id}`);
  kb.row().text("🏠 Menu Admin", "ops:home");
  return kb;
}

export async function showCustomerDetail(ctx: BotContext, customerId: string): Promise<void> {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    await ctx.reply("❌ Không tìm thấy khách hàng.").catch(() => {});
    return;
  }
  const [conv, latestOrder, latestQuote] = await Promise.all([
    prisma.conversation.findUnique({ where: { customerId } }),
    OrderService.getLatestActiveOrderForCustomer(customerId),
    QuoteService.getLatestActiveQuote(customerId)
  ]);

  const text = renderCustomerDetailText(customer, conv, latestOrder, latestQuote);
  const kb = customerDetailKeyboard(customer, latestOrder);

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

export async function showCustomerHistory(ctx: BotContext, customerId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  const orders = await prisma.order.findMany({
    where: { customerId },
    orderBy: { createdAt: "desc" },
    take: 10
  });
  const lines = ["🕘 <b>LỊCH SỬ ĐƠN HÀNG</b>", ""];
  const kb = new InlineKeyboard();
  if (orders.length === 0) {
    lines.push("Chưa có đơn hàng nào.");
  } else {
    for (const o of orders) {
      lines.push(`📦 ${shortOrderId(o.id)} · ${MoneyService.formatMoney(o.sourceAmount, o.sourceCurrency)} → ${MoneyService.formatMoney(o.targetAmount, o.targetCurrency)}`);
      kb.row().text(`📦 ${shortOrderId(o.id)}`, `ops:order:detail:${o.id}`);
    }
  }
  kb.row().text("🏠 Menu Admin", "ops:home");
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
      lines.push(`👤 ${escapeHtml(customerLabel(c))} · 🆔 ${shortCustomerId(c.id)}`);
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
    lines.push(`👤 ${escapeHtml(customerLabel(c))} · 🆔 ${shortCustomerId(c.id)}`);
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
adminCustomersHandler.callbackQuery(/^ops:customer:history:(.+)$/, (ctx) => showCustomerHistory(ctx, ctx.match?.[1] || ""));

