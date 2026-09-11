/**
 * Admin order operations — Action Inbox, order list/filter/search/detail.
 * All UI text Vietnamese. No full Prisma CUID in normal UI (short IDs only).
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { prisma } from "../../database/client.js";
import { OrderService } from "../../modules/orders/order-service.js";
import { MoneyService } from "../../modules/money/money-service.js";
import { escapeHtml, STATUS_VI } from "../menus/cskh-panel.js";
import { customerLabel, shortOrderId, timeAgo, BILL_AWAITING_VERIFY_STATUSES, WARNING_REVIEW_STATUSES } from "./admin-panel.js";
import { setAdminSearch } from "./admin-session.js";

export const adminOrdersHandler = new Composer<BotContext>();

const NEED_ACTION_STATUSES = ["WAITING_ADMIN_VERIFY", "CUSTOMER_SENT_BILL", "MANUAL_REVIEW", "SUSPICIOUS", "WAITING_PAYOUT", "PAYOUT_SENT"];
const PROCESSING_STATUSES = ["WAITING_PAYMENT", "PAYMENT_CONFIRMED"];
const DONE_STATUSES = ["COMPLETED"];
const CANCELLED_STATUSES = ["CANCELLED"];

export type OrderGroup = "need_action" | "processing" | "done" | "cancelled";

export function statusesForGroup(group: OrderGroup): string[] {
  if (group === "need_action") return NEED_ACTION_STATUSES;
  if (group === "processing") return PROCESSING_STATUSES;
  if (group === "cancelled") return CANCELLED_STATUSES;
  return DONE_STATUSES;
}

export function orderStatusLabel(status: string): string {
  return STATUS_VI[status] || status;
}

/** One order → readable exchange line, e.g. "100 USD → 2 615 000 VND". */
export function orderExchangeLine(order: {
  sourceAmount: any;
  sourceCurrency: string;
  targetAmount: any;
  targetCurrency: string;
}): string {
  return `${MoneyService.formatMoney(order.sourceAmount, order.sourceCurrency)} → ${MoneyService.formatMoney(order.targetAmount, order.targetCurrency)}`;
}

/**
 * Resolve an admin search query to candidate orders.
 * Accepts: short order id (last 6), customer display name, @username,
 * Telegram id. Never returns a full-CUID assumption silently — callers decide
 * between a single match (detail) and multiple matches (selectable list).
 */
export async function searchOrders(query: string): Promise<any[]> {
  const q = String(query || "").trim();
  if (!q) return [];

  // Exact Telegram id match (advanced troubleshooting).
  const byTelegram = await prisma.order.findMany({
    where: { customer: { telegramId: q } },
    include: { customer: true },
    orderBy: { createdAt: "desc" },
    take: 20
  });
  if (byTelegram.length) return byTelegram;

  const needle = q.toLowerCase();
  const candidates = await prisma.order.findMany({
    include: { customer: true },
    orderBy: { createdAt: "desc" },
    take: 200
  });

  const matches = candidates.filter((o: any) => {
    if (o.id.toLowerCase().endsWith(needle)) return true;
    const username = (o.customer?.username || "").toLowerCase();
    const fullName = (o.customer?.fullName || "").toLowerCase();
    if (username && username.includes(needle)) return true;
    if (fullName && fullName.includes(needle)) return true;
    return false;
  });

  // De-duplicate by order id.
  const seen = new Set<string>();
  return matches.filter((o: any) => (seen.has(o.id) ? false : (seen.add(o.id), true))).slice(0, 20);
}

/** Resolve a short order id to candidates (may be ambiguous). */
export async function resolveOrderByShortId(shortId: string): Promise<any[]> {
  const q = String(shortId || "").replace(/^#/, "").trim().toLowerCase();
  if (!q) return [];
  return prisma.order.findMany({
    where: { id: { endsWith: q } },
    include: { customer: true },
    orderBy: { createdAt: "desc" },
    take: 20
  });
}

export function orderRowText(order: any): string {
  const lines = [
    `👤 ${escapeHtml(customerLabel(order.customer))}`,
    `💱 ${escapeHtml(orderExchangeLine(order))}`,
    `📦 ${shortOrderId(order.id)}`,
    `📍 ${orderStatusLabel(order.status)}`,
    `🕒 ${timeAgo(order.createdAt)}`
  ];
  return lines.join("\n");
}

export function renderOrderDetailText(order: any): string {
  const receiving = order.receivingAccountSnapshot as any;
  const payout = order.payoutBankSnapshot as any;
  const cust = order.customer;

  const lines: string[] = [
    `📦 <b>CHI TIẾT ĐƠN HÀNG</b> ${shortOrderId(order.id)}`,
    "",
    `👤 Khách: <b>${escapeHtml(customerLabel(cust))}</b>`,
    cust?.username ? `🔗 @${escapeHtml(cust.username)}` : "",
    `📦 Mã ngắn: ${shortOrderId(order.id)}`,
    "",
    `💱 Nguồn: <b>${escapeHtml(MoneyService.formatMoney(order.sourceAmount, order.sourceCurrency))}</b>`,
    `💰 Đích: <b>${escapeHtml(MoneyService.formatMoney(order.targetAmount, order.targetCurrency))}</b>`,
    `📊 Tỷ giá khóa: <b>${escapeHtml(MoneyService.formatEffectiveRate(order.sourceCurrency, order.targetCurrency, order.rate))}</b>`,
    `💵 Phí: ${escapeHtml(MoneyService.formatMoney(order.fee, order.feeCurrency))}`
  ];

  if (receiving) {
    lines.push(
      "",
      "🏦 <b>TÀI KHOẢN NHẬN (SYSTEM)</b>",
      `• ${escapeHtml(receiving.bankName || "")} · ${escapeHtml(receiving.accountNumber || "")} (${escapeHtml(receiving.accountName || "")})`
    );
  }
  if (payout) {
    lines.push(
      "",
      "💳 <b>KHÁCH NHẬN VỀ</b>",
      `• ${escapeHtml(payout.bankName || "")} · ${escapeHtml(payout.accountNumber || "")} (${escapeHtml(payout.accountName || "")})`
    );
  } else {
    lines.push("", "💳 <b>KHÁCH NHẬN VỀ</b>", "• Chưa có tài khoản nhận");
  }

  lines.push(
    "",
    `📷 Bill: ${order.customerBillFileId ? "Đã gửi" : "Chưa gửi"}`,
    `💸 Trạng thái: <b>${orderStatusLabel(order.status)}</b>`,
    "",
    `🕒 Tạo: ${timeAgo(order.createdAt)}`,
    order.verifiedAt ? `🕒 Xác nhận tiền: ${timeAgo(order.verifiedAt)}` : "",
    order.payoutAt ? `🕒 Chi tiền: ${timeAgo(order.payoutAt)}` : "",
    order.completedAt ? `🕒 Hoàn tất: ${timeAgo(order.completedAt)}` : ""
  );

  return lines.filter(Boolean).join("\n");
}

export function orderDetailKeyboard(order: any): InlineKeyboard {
  const kb = new InlineKeyboard();
  const status = order.status as string;

  if (order.customerBillFileId || order.payoutBillFileId) {
    kb.text("📷 Xem bill", `ops:bill:view:${order.id}`);
  }

  if (["WAITING_ADMIN_VERIFY", "CUSTOMER_SENT_BILL", "MANUAL_REVIEW", "SUSPICIOUS"].includes(status)) {
    kb.row().text("✅ Xác nhận đã nhận tiền", `ops:pay:preview:${order.id}`);
    kb.row().text("❌ Chưa nhận được tiền", `ops:pay:not_received:${order.id}`);
  } else if (status === "WAITING_PAYOUT") {
    kb.row().text("💸 Bắt đầu payout", `ops:payout:preview:${order.id}`);
  } else if (status === "PAYOUT_SENT") {
    kb.row().text("✅ Hoàn tất đơn", `ops:payout:complete:preview:${order.id}`);
  }

  kb.row().text("👤 Xem khách", `ops:customer:detail:${order.customerId}`);
  kb.row().text("🏠 Menu Admin", "ops:home");
  return kb;
}

async function showOrderDetail(ctx: BotContext, orderId: string): Promise<void> {
  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }
  const text = renderOrderDetailText(order);
  const kb = orderDetailKeyboard(order);
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
      return;
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

async function replyOrEdit(ctx: BotContext, text: string, kb: InlineKeyboard): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through to reply */
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function showActionInbox(ctx: BotContext): Promise<void> {
  if (!(await requirePermission(ctx, "order.view"))) return;

  const [billOrders, warningOrders, payoutOrders, waitingCskh] = await Promise.all([
    prisma.order.findMany({
      where: { status: { in: BILL_AWAITING_VERIFY_STATUSES } },
      include: { customer: true },
      orderBy: { createdAt: "asc" },
      take: 15
    }),
    prisma.order.findMany({
      where: { status: { in: WARNING_REVIEW_STATUSES } },
      include: { customer: true },
      orderBy: { createdAt: "asc" },
      take: 15
    }),
    prisma.order.findMany({
      where: { status: { in: ["WAITING_PAYOUT", "PAYOUT_SENT"] } },
      include: { customer: true },
      orderBy: { createdAt: "asc" },
      take: 15
    }),
    prisma.conversation.findMany({
      where: { mode: "HUMAN", claimedById: null },
      include: { customer: true },
      orderBy: { updatedAt: "asc" },
      take: 15
    })
  ]);

  const kb = new InlineKeyboard();
  const lines: string[] = ["🔴 <b>VIỆC CẦN XỬ LÝ</b>", ""];

  if (billOrders.length === 0 && warningOrders.length === 0 && payoutOrders.length === 0 && waitingCskh.length === 0) {
    lines.push("✅ Hiện không có việc nào cần xử lý.");
  }

  if (billOrders.length) {
    lines.push(`📷 <b>BILL CHỜ XÁC MINH (${billOrders.length})</b>`, "");
    for (const o of billOrders) {
      lines.push(
        `👤 ${escapeHtml(customerLabel(o.customer))}${o.customer?.username ? ` · @${escapeHtml(o.customer.username)}` : ""}`,
        `📦 ${shortOrderId(o.id)}`,
        `💱 ${escapeHtml(orderExchangeLine(o))}`,
        `🕒 ${timeAgo(o.updatedAt || o.createdAt)}`
      );
      kb.row().text(`📷 Xem bill ${shortOrderId(o.id)}`, `ops:bill:view:${o.id}`)
        .text(`📦 ${shortOrderId(o.id)}`, `ops:order:detail:${o.id}`);
      lines.push("");
    }
  }

  if (warningOrders.length) {
    lines.push(`⚠️ <b>CẦN KIỂM TRA (${warningOrders.length})</b>`, "");
    for (const o of warningOrders) {
      lines.push(
        `👤 ${escapeHtml(customerLabel(o.customer))}`,
        `📦 ${shortOrderId(o.id)} · ${orderStatusLabel(o.status)}`
      );
      kb.row().text(`📦 ${shortOrderId(o.id)}`, `ops:order:detail:${o.id}`);
      lines.push("");
    }
  }

  if (payoutOrders.length) {
    lines.push(`💸 <b>CẦN THANH TOÁN / HOÀN TẤT (${payoutOrders.length})</b>`, "");
    for (const o of payoutOrders) {
      lines.push(
        `👤 ${escapeHtml(customerLabel(o.customer))}`,
        `📦 ${shortOrderId(o.id)}`,
        `💰 ${escapeHtml(MoneyService.formatMoney(o.targetAmount, o.targetCurrency))} · ${orderStatusLabel(o.status)}`
      );
      kb.row().text(`📦 ${shortOrderId(o.id)}`, `ops:order:detail:${o.id}`);
      lines.push("");
    }
  }

  if (waitingCskh.length) {
    lines.push(`🔔 <b>KHÁCH CHỜ CSKH (${waitingCskh.length})</b>`, "");
    for (const c of waitingCskh) {
      lines.push(`👤 ${escapeHtml(customerLabel(c.customer))} · chờ ${timeAgo(c.updatedAt)}`);
      kb.row().text(`👤 ${escapeHtml(customerLabel(c.customer))}`, `ops:customer:detail:${c.customerId}`);
      lines.push("");
    }
  }

  kb.row().text("🏠 Menu Admin", "ops:home");
  await replyOrEdit(ctx, lines.join("\n"), kb);
}

export async function showOrderList(ctx: BotContext, group: OrderGroup = "need_action"): Promise<void> {
  if (!(await requirePermission(ctx, "order.view"))) return;

  const statuses = statusesForGroup(group);
  const orders = await prisma.order.findMany({
    where: { status: { in: statuses } },
    include: { customer: true },
    orderBy: { createdAt: "desc" },
    take: 20
  });

  const title =
    group === "need_action" ? "CẦN XỬ LÝ" :
    group === "processing" ? "ĐANG XỬ LÝ" :
    group === "cancelled" ? "ĐÃ HỦY" : "HOÀN THÀNH";
  const lines = [`📦 <b>ĐƠN HÀNG · ${title} (${orders.length})</b>`, ""];
  const kb = new InlineKeyboard();

  if (orders.length === 0) {
    lines.push("Không có đơn hàng nào.");
  } else {
    for (const o of orders) {
      lines.push(
        `👤 ${escapeHtml(customerLabel(o.customer))}`,
        `💱 ${escapeHtml(orderExchangeLine(o))}`,
        `📦 ${shortOrderId(o.id)} · 📍 ${orderStatusLabel(o.status)} · 🕒 ${timeAgo(o.createdAt)}`
      );
      kb.row().text(`📦 ${shortOrderId(o.id)}`, `ops:order:detail:${o.id}`);
      lines.push("");
    }
  }

  kb.row().text("🔴 Cần xử lý", "ops:orders:filter:need_action")
    .text("🟡 Đang xử lý", "ops:orders:filter:processing");
  kb.row().text("✅ Hoàn thành", "ops:orders:filter:done")
    .text("❌ Đã hủy", "ops:orders:filter:cancelled");
  kb.row().text("🔎 Tìm đơn", "ops:orders:search").text("🏠 Menu Admin", "ops:home");

  await replyOrEdit(ctx, lines.join("\n"), kb);
}

export async function runOrderSearch(ctx: BotContext, query: string): Promise<void> {
  const matches = await searchOrders(query);
  if (matches.length === 0) {
    await ctx.reply("🔎 Không tìm thấy đơn hàng nào khớp. Gửi mã ngắn, tên khách, @username hoặc Telegram ID.");
    return;
  }
  if (matches.length === 1) {
    await showOrderDetail(ctx, matches[0].id);
    return;
  }
  const lines = [`🔎 <b>Tìm thấy ${matches.length} đơn hàng:</b>`, ""];
  const kb = new InlineKeyboard();
  for (const o of matches) {
    lines.push(`👤 ${escapeHtml(customerLabel(o.customer))} · 📦 ${shortOrderId(o.id)} · ${orderStatusLabel(o.status)}`);
    kb.row().text(`📦 ${shortOrderId(o.id)} · ${escapeHtml(customerLabel(o.customer))}`, `ops:order:detail:${o.id}`);
  }
  kb.row().text("🏠 Menu Admin", "ops:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

adminOrdersHandler.callbackQuery("ops:inbox", (ctx) => showActionInbox(ctx));
adminOrdersHandler.callbackQuery("ops:orders", (ctx) => showOrderList(ctx, "need_action"));
adminOrdersHandler.callbackQuery(/^ops:orders:filter:(need_action|processing|done|cancelled)$/, async (ctx) => {
  const group = ctx.match?.[1] as OrderGroup;
  await showOrderList(ctx, group);
});
adminOrdersHandler.callbackQuery("ops:orders:search", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "order.view"))) return;
  setAdminSearch(String(ctx.from?.id || ""), "order");
  await ctx.reply("🔎 <b>Tìm đơn hàng</b>\n\nNhập mã ngắn (#xxxxxx), tên khách, @username hoặc Telegram ID.\n\nGửi /cancel để hủy.", {
    parse_mode: "HTML"
  });
});
adminOrdersHandler.callbackQuery(/^ops:order:detail:(.+)$/, async (ctx) => {
  if (!(await requirePermission(ctx, "order.view"))) return;
  await showOrderDetail(ctx, ctx.match?.[1] || "");
});



