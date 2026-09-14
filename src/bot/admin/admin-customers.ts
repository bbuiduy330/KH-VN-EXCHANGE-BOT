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
import { customerLabel, shortOrderId, timeAgo } from "./admin-panel.js";
import { customerIdentity } from "../notifications.js";
import { resolveCustomer } from "../../modules/customer/customer-resolver.js";
import { CustomerChatHistoryService } from "../../modules/chat/customer-chat-history-service.js";
import {
  ADMIN_LIST_FETCH_TAKE,
  ADMIN_LIST_PAGE_SIZE,
  advanceAdminList,
  commitAdminListNext,
  decodeListCursor,
  ensureAdminListFilter,
  getAdminListState,
  listCursorWhere,
  retreatAdminList
} from "./admin-list-session.js";
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
  kb.row().text("💬 Lịch sử chat", `ops:customer:chat:${customer.id}`);
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
  // Canonical resolver: accepts internal id, Telegram numeric ID or public
  // Customer Ref — ONE authoritative lookup path for all Admin entry points.
  const { customer } = await resolveCustomer(customerId);
  if (!customer) {
    await ctx.reply("❌ Không tìm thấy khách hàng.").catch(() => {});
    return;
  }
  customerId = customer.id;
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

export async function showCustomerList(ctx: BotContext, move?: "next" | "prev"): Promise<void> {
  if (!(await requirePermission(ctx, "customer.view"))) return;
  const adminId = String(ctx.from?.id || "");

  // Cursor pagination state (per admin + screen). Customers are ordered by
  // last ACTIVITY (updatedAt — any profile/bank/language touch refreshes it),
  // not creation date — closest operational equivalent on this model.
  ensureAdminListFilter(adminId, "customers", "");
  let cursorRaw = "";
  if (move === "next") {
    const next = advanceAdminList(adminId, "customers");
    if (next === null) {
      await ctx.answerCallbackQuery("Đã hết danh sách.").catch(() => {});
      return;
    }
    cursorRaw = next;
  } else if (move === "prev") {
    const prev = retreatAdminList(adminId, "customers");
    if (prev === null) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    cursorRaw = prev;
  }

  const cw = listCursorWhere(decodeListCursor(cursorRaw || null));
  const customers: any[] = await prisma.customer.findMany({
    ...(cw ? { where: cw } : {}),
    orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
    take: ADMIN_LIST_FETCH_TAKE
  });
  const hasMore = customers.length > ADMIN_LIST_PAGE_SIZE;
  const page = customers.slice(0, ADMIN_LIST_PAGE_SIZE);
  commitAdminListNext(adminId, "customers", hasMore && page.length > 0 ? encodeListCursor(page[page.length - 1]) : null);

  const lines = ["👥 <b>KHÁCH HÀNG</b>", `${page.length} khách (hoạt động gần nhất)`, ""];
  const kb = new InlineKeyboard();
  if (page.length === 0) {
    lines.push("Không có khách hàng phù hợp.");
  } else {
    for (const c of page) {
      // Display name + Telegram numeric ID + public Customer Ref + TRUE
      // last-activity context. NO internal Customer.id in the UI.
      const active = timeAgo(c.lastActivityAt || c.updatedAt || c.createdAt);
      lines.push(
        `👤 ${escapeHtml(customerLabel(c))}${c.telegramId ? ` · 🆔 <code>${c.telegramId}</code>` : ""} · 🔖 #${String(c.id).slice(-6).toUpperCase()} · 🌐 ${escapeHtml(c.language || "vi")} · 🕒 ${active}`
      );
      kb.row().text(`👤 ${escapeHtml(customerLabel(c))}`, `ops:customer:detail:${c.id}`);
    }
  }

  // Page navigation (tiny callbacks; cursor state in per-admin session).
  const state = getAdminListState(adminId, "customers");
  const navRow = kb.row();
  if (state.pos > 0) navRow.text("⬅️ Trước", "ops:customers:page:prev");
  if (hasMore) navRow.text("Tiếp ➡️", "ops:customers:page:next");

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
// Cursor page navigation (tiny callbacks; cursor state in per-admin session).
adminCustomersHandler.callbackQuery("ops:customers:page:next", (ctx) => showCustomerList(ctx, "next"));
adminCustomersHandler.callbackQuery("ops:customers:page:prev", (ctx) => showCustomerList(ctx, "prev"));
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
// 💬 DURABLE CHAT HISTORY (Part 2) — shared by Admin CRM + CSKH panels.
// Keyset pagination 25/page (createdAt DESC, id DESC); per-admin cursor state.
// NEVER displays the raw internal Customer.id; Admin/CSKH only (no CTV route).
// ---------------------------------------------------------------------------

const SENDER_LABELS: Record<string, string> = {
  CUSTOMER: "👤 Khách",
  BOT: "🤖 Bot",
  STAFF: "👨‍💼 CSKH",
  SYSTEM: "⚙️ Hệ thống"
};

function chatEntryLine(m: any): string {
  const time = formatAdminDateTime(m.createdAt).slice(11, 16); // GMT+7 HH:mm
  const who = SENDER_LABELS[m.senderType] || "💬";
  const staffTag = m.senderType === "STAFF" && m.staffTelegramId ? ` · ${m.staffTelegramId.slice(-4)}` : "";
  const media = m.contentType !== "TEXT" ? ` [${m.contentType}]` : "";
  const body = escapeHtml(String(m.text || m.caption || "")).slice(0, 300) || "(media)";
  return `${time} ${who}${staffTag}${media}\n${body}`;
}

export async function showCustomerChatHistory(ctx: BotContext, customerId: string, move?: "next" | "prev"): Promise<void> {
  if (!(await requirePermission(ctx, "customer.view"))) return;
  const adminId = String(ctx.from?.id || "");
  const { customer } = await resolveCustomer(customerId);
  if (!customer) {
    await ctx.reply("❌ Không tìm thấy khách hàng.").catch(() => {});
    return;
  }
  const screen = `chat:${customer.id}`;
  ensureAdminListFilter(adminId, screen, "");
  let cursorRaw = "";
  if (move === "next") {
    const next = advanceAdminList(adminId, screen);
    if (next === null) {
      await ctx.answerCallbackQuery("Đã hết lịch sử.").catch(() => {});
      return;
    }
    cursorRaw = next;
  } else if (move === "prev") {
    const prev = retreatAdminList(adminId, screen);
    if (prev === null) return;
    cursorRaw = prev;
  }

  const { messages, hasOlder, nextCursor } = await CustomerChatHistoryService.listPage(customer.id, cursorRaw || null);
  commitAdminListNext(adminId, screen, nextCursor);

  const lines = [
    "💬 <b>LỊCH SỬ TRÒ CHUYỆN</b>",
    "",
    `👤 ${escapeHtml(customerLabel(customer))}`,
    customer.telegramId ? `🆔 TG: <code>${customer.telegramId}</code>` : "",
    `🔖 Ref: #${String(customer.id).slice(-6).toUpperCase()}`,
    ""
  ];
  const kb = new InlineKeyboard();
  if (messages.length === 0) {
    lines.push("Chưa có nội dung trò chuyện nào.");
  } else {
    for (const m of messages) lines.push(chatEntryLine(m));
  }
  const st = getAdminListState(adminId, screen);
  const nav = kb.row();
  if (st.pos > 0) nav.text("⬅️ Cũ hơn", `ops:customer:chat:${customer.id}:prev`);
  if (hasOlder) nav.text("Mới hơn ➡️", `ops:customer:chat:${customer.id}:next`);
  kb.row().text("⬅️ Hồ sơ khách", `ops:customer:detail:${customer.id}`).text("🏠 Menu Admin", "ops:home");

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(lines.filter(Boolean).join("\n"), { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(lines.filter(Boolean).join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

adminCustomersHandler.callbackQuery(/^ops:customer:chat:([a-zA-Z0-9_-]+):(next|prev)$/, (ctx) =>
  showCustomerChatHistory(ctx, ctx.match?.[1] || "", ctx.match?.[2] as "next" | "prev"));
adminCustomersHandler.callbackQuery(/^ops:customer:chat:([a-zA-Z0-9_-]+)$/, (ctx) =>
  showCustomerChatHistory(ctx, ctx.match?.[1] || ""));

// ---------------------------------------------------------------------------
// Admin → customer direct support (reuses existing C3 claim/selected-chat)
// ---------------------------------------------------------------------------

export async function showCustomerSupport(ctx: BotContext, customerId: string): Promise<void> {
  if (!(await requirePermission(ctx, "customer.message"))) return;
  const adminId = String(ctx.from?.id || "");
  // Canonical resolver: callbacks carry the internal Customer.id; refs /
  // Telegram IDs still resolve safely instead of failing with "not found".
  const { customer } = await resolveCustomer(customerId);
  if (!customer) {
    await ctx.reply("❌ Không tìm thấy khách hàng.").catch(() => {});
    return;
  }
  customerId = customer.id;
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

// ROUTE ORDER MATTERS: claim/release MUST be registered (and excluded from)
// the generic support route — `ops:customer:support:(.+)` would otherwise
// swallow `ops:customer:support:claim:<id>` with capture "claim:<id>" and
// fail the customer lookup ("Không tìm thấy khách hàng").
export const CUSTOMER_SUPPORT_CLAIM_ROUTE = /^ops:customer:support:claim:(.+)$/;
export const CUSTOMER_SUPPORT_RELEASE_ROUTE = /^ops:customer:support:release:(.+)$/;
export const CUSTOMER_SUPPORT_ROUTE = /^ops:customer:support:(?!claim:|release:)(.+)$/;

adminCustomersHandler.callbackQuery(CUSTOMER_SUPPORT_ROUTE, (ctx) => showCustomerSupport(ctx, ctx.match?.[1] || ""));
adminCustomersHandler.callbackQuery(CUSTOMER_SUPPORT_CLAIM_ROUTE, (ctx) => claimCustomerAsAdmin(ctx, ctx.match?.[1] || ""));
adminCustomersHandler.callbackQuery(CUSTOMER_SUPPORT_RELEASE_ROUTE, (ctx) => releaseCustomerAsAdmin(ctx, ctx.match?.[1] || ""));

