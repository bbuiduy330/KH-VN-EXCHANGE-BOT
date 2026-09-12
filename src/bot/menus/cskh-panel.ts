/**
 * C1 — CSKH Control Panel: pure, testable helpers + keyboards.
 *
 * Design constraints:
 * - NO new Prisma models, NO lifecycle changes. "Waiting" = HUMAN + unclaimed,
 *   "Active" = HUMAN + claimed (existing ConversationService semantics).
 * - Callback payloads carry only conversation/customer IDs + page numbers.
 * - Every screen offers ⬅️ back and/or 🏠 home exits (no trapped states).
 * - Vietnamese-only staff UI (customer multilingual UI untouched).
 * - Full reply-mode/selected-chat state belongs to C2/C3 — intentionally absent.
 */
import { InlineKeyboard } from "grammy";
import { formatAdminTime } from "../../shared/app-time.js";
import { Conversation, Customer, Quote, Order } from "@prisma/client";
import { MoneyService } from "../../modules/money/money-service.js";

export const CSKH_PAGE_SIZE = 5;

export type ConversationWithCustomer = Conversation & { customer: Customer };

/** Short readable identifier: @username, name, or #last6 of the id. */
export function shortCustomerLabel(customer: Pick<Customer, "id" | "username" | "fullName">): string {
  if (customer.username) return `@${customer.username}`;
  const name = (customer.fullName || "").trim();
  if (name) return name;
  return `Khách #${customer.id.slice(-6)}`;
}

/** Short exchange need text from an active quote, e.g. "100 USD → VND". */
export function quoteNeedText(quote: Pick<Quote, "sourceAmount" | "sourceCurrency" | "targetAmount" | "targetCurrency">): string {
  return `${MoneyService.formatAmount(quote.sourceAmount, quote.sourceCurrency)} ${quote.sourceCurrency} → ${MoneyService.formatAmount(quote.targetAmount, quote.targetCurrency)} ${quote.targetCurrency}`;
}

export const STATUS_VI: Record<string, string> = {
  WAITING_PAYMENT: "Chờ thanh toán",
  CUSTOMER_SENT_BILL: "Đã gửi bill",
  WAITING_ADMIN_VERIFY: "Chờ đối soát",
  PAYMENT_CONFIRMED: "Đã xác nhận tiền",
  WAITING_PAYOUT: "Chờ giải ngân",
  PAYOUT_SENT: "Đã chi tiền",
  MANUAL_REVIEW: "Đang xem xét",
  SUSPICIOUS: "Cần kiểm tra",
  COMPLETED: "Hoàn tất",
  CANCELLED: "Đã hủy"
};

/** Short order context text, e.g. "Đơn 100 USD → VND (Chờ thanh toán)". */
export function orderContextText(order: Pick<Order, "sourceAmount" | "sourceCurrency" | "targetAmount" | "targetCurrency" | "status">): string {
  const statusLabel = STATUS_VI[order.status] || order.status;
  return `Đơn ${quoteNeedText(order)} (${statusLabel})`;
}

/** Row text for a waiting (HUMAN + unclaimed) conversation. */
export function waitingRowText(conv: ConversationWithCustomer, need?: string, waitedMinutes?: number): string {
  const wait = waitedMinutes !== undefined ? ` · chờ ${waitedMinutes}p` : "";
  return `🟡 ${shortCustomerLabel(conv.customer)}${wait}${need ? ` · ${need}` : ""}`;
}

/** Row text for an active (HUMAN + claimed) conversation. */
export function activeRowText(
  conv: ConversationWithCustomer,
  opts: { need?: string; isMine?: boolean; ownerLabel?: string } = {}
): string {
  const owner = opts.isMine ? "· của bạn" : opts.ownerLabel ? `· 👨‍💼 ${opts.ownerLabel}` : "· đang hỗ trợ";
  return `🟢 ${shortCustomerLabel(conv.customer)} ${owner}${opts.need ? ` · ${opts.need}` : ""}`;
}
/** Slice one list into a Telegram-safe page. */
export function paginate<T>(items: T[], page: number, pageSize: number = CSKH_PAGE_SIZE): { pageItems: T[]; totalPages: number } {
  const total = Math.max(1, Math.ceil(items.length / pageSize));
  const safe = Math.min(Math.max(1, page), total);
  const start = (safe - 1) * pageSize;
  return { pageItems: items.slice(start, start + pageSize), totalPages: total };
}

/** Pagination footer: ⬅️ ➡️ 🏠 (buttons only when they do something). */
export function paginationKeyboard(prefix: string, page: number, totalPages: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (page > 1) kb.text("⬅️", `${prefix}:page:${page - 1}`);
  if (page < totalPages) kb.text("➡️", `${prefix}:page:${page + 1}`);
  kb.text("🏠 Menu CSKH", "cskh:home");
  return kb;
}

/** 🏠 CSKH home keyboard (C1: no giant slash-command list). */
export function getCskhHomeKeyboard(counts: { waiting?: number; active?: number } = {}): InlineKeyboard {
  const kb = new InlineKeyboard();
  const waiting = counts.waiting !== undefined ? ` (${counts.waiting})` : "";
  const active = counts.active !== undefined ? ` (${counts.active})` : "";
  kb.text(`🔔 Khách đang chờ${waiting}`, "cskh:waiting:1")
    .text(`💬 Đang hỗ trợ${active}`, "cskh:active:1")
    .row()
    .text("🕘 Lịch sử", "cskh:menu:mytickets")
    .text("🔎 Tìm khách", "cskh:menu:find_customer")
    .row()
    .text("❓ Hướng dẫn", "cskh:menu:help");
  return kb;
}

export function renderCskhHomeText(staffName: string): string {
  return (
    `🎧 <b>BÀN CSKH</b>\n\n` +
    `Xin chào <b>${staffName || "Nhân viên CSKH"}</b>.\n` +
    `Chọn một chức năng bên dưới.`
  );
}

/** Basic customer preview card (C1) — claim + exits, no reply-mode yet. */
export function renderCustomerPreviewText(conv: ConversationWithCustomer, context: { need?: string; order?: string } = {}): string {
  const c = conv.customer;
  const lines = [
    `👤 <b>Khách</b>: ${shortCustomerLabel(c)}`,
    c.telegramId
      ? `🆔 Telegram ID: <code>${c.telegramId}</code>`
      : `🆔 Ref: <code>#${c.id.slice(-6).toUpperCase()}</code>`,
    `💬 Trạng thái hỗ trợ: ${conv.mode === "HUMAN" ? (conv.claimedById ? "Đang được nhân viên hỗ trợ" : "Đang chờ nhân viên") : "AI tự động"}`
  ];
  if (conv.claimedById) lines.push(`👨‍💼 Người phụ trách: <code>${conv.claimedById}</code>`);
  if (context.need) lines.push(`💱 Nhu cầu: ${context.need}`);
  if (context.order) lines.push(`📦 Đơn hàng: ${context.order}`);
  return lines.join("\n");
}

/** Preview actions: claim (when legally claimable) + exits. */
export function getCustomerPreviewKeyboard(conv: Pick<Conversation, "mode" | "claimedById" | "customerId">): InlineKeyboard {
  const kb = new InlineKeyboard();
  const claimable = conv.mode !== "HUMAN" || !conv.claimedById;
  if (claimable) kb.text("✅ Nhận khách", `cskh:ticket:claim:${conv.customerId}`);
  kb.row().text("⬅️ Quay lại danh sách", "cskh:waiting:1").text("🏠 Menu CSKH", "cskh:home");
  return kb;
}
/**
 * C2 — customer detail, history, search and action helpers.
 * All read-only UX; financial actions remain untouched.
 */

const SENDER_LABEL: Record<string, string> = {
  CUSTOMER: "👤 Khách",
  AI: "🤖 Bot",
  BOT: "🤖 Bot",
  CSKH: "👨‍💼 CSKH",
  ADMIN: "👨‍💼 CSKH",
  SYSTEM: "🛎 Hệ thống"
};

export function senderLabel(senderType: string): string {
  return SENDER_LABEL[senderType] || "🛎 Hệ thống";
}

/** Minimal HTML-escape so user/recorded text never breaks Telegram HTML. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Short time like "09:41" — CANONICAL APP TIMEZONE (Asia/Ho_Chi_Minh). */
export function shortTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  return formatAdminTime(d);
}

/** Resolve a staff owner display label: "Name (ROLE)" with graceful fallback. */
export function staffDisplayName(staff: { name?: string | null; role?: string | null } | null | undefined, fallbackId?: string | null): string {
  if (!staff) return fallbackId ? `#${fallbackId.slice(-6)}` : "Chưa phân công";
  const name = (staff.name || "").trim() || (fallbackId ? `#${fallbackId.slice(-6)}` : "Chưa rõ");
  return staff.role ? `${name} (${staff.role})` : name;
}

/** One history line: sender + time + truncated content. */
export function messageLine(m: { senderType: string; content: string; createdAt: string | Date }): string {
  const content = escapeHtml((m.content || "").trim()).slice(0, 180);
  const time = shortTime(m.createdAt);
  return `${senderLabel(m.senderType)}: <i>${content}</i>${time ? ` <code>${time}</code>` : ""}`;
}

/** Operational customer detail card (C2 supersedes the C1 preview). */
export function renderCustomerDetailText(
  conv: ConversationWithCustomer,
  opts: { owner?: string; need?: string; order?: string; lastSeen?: string } = {}
): string {
  const c = conv.customer;
  const lines: string[] = [
    `👤 <b>Khách</b>: ${escapeHtml(shortCustomerLabel(c))}`
  ];
  if (c.username) lines.push(`🔗 @${escapeHtml(c.username)}`);
  if (c.telegramId) {
    lines.push(`🆔 Telegram ID: <code>${c.telegramId}</code>`);
  }
  lines.push(`🔖 Ref: <code>#${c.id.slice(-6).toUpperCase()}</code>`);
  lines.push(`💬 Trạng thái hỗ trợ: ${conv.mode === "HUMAN" ? (conv.claimedById ? "Đang được nhân viên hỗ trợ" : "Đang chờ nhân viên") : "AI tự động"}`);
  lines.push(`👨‍💼 Người phụ trách: ${opts.owner || "Chưa phân công"}`);
  if (opts.need) lines.push(`💱 Nhu cầu / báo giá: ${opts.need}`);
  if (opts.order) lines.push(`📦 Đơn hàng: ${opts.order}`);
  if (opts.lastSeen) lines.push(`🕒 Cập nhật gần nhất: ${opts.lastSeen}`);
  return lines.join("\n");
}

/** Detail action keyboard — only actions valid for the current state. */
export function getCustomerDetailKeyboard(
  conv: Pick<Conversation, "mode" | "claimedById" | "customerId">,
  opts: { isMine?: boolean } = {}
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const claimable = conv.mode !== "HUMAN" || !conv.claimedById;
  if (claimable) {
    kb.text("✅ Nhận khách", `cskh:ticket:claim:${conv.customerId}`);
  } else if (opts.isMine) {
    kb.text("💬 Trả lời khách", `cskh:reply:${conv.customerId}`)
      .text("↩️ Trả khách (kết thúc hỗ trợ)", `cskh:ticket:release:${conv.customerId}`);
  }
  kb.row()
    .text("📦 Xem đơn", `cskh:order:${conv.customerId}`)
    .text("📊 Xem báo giá", `cskh:quote:${conv.customerId}`);
  kb.row()
    .text("🕘 Lịch sử", `cskh:history:${conv.customerId}:1`)
    .text("⬅️ Danh sách", "cskh:waiting:1");
  kb.row().text("🏠 Menu CSKH", "cskh:home");
  return kb;
}

/** History screen text (paginated, newest-first). */
export function renderHistoryText(
  customerLabel: string,
  messages: { senderType: string; content: string; createdAt: string | Date }[],
  page: number,
  totalPages: number
): string {
  const header = `🕘 <b>Lịch sử ${escapeHtml(customerLabel)}</b> — trang ${page}/${totalPages}`;
  if (messages.length === 0) return `${header}\n\n<i>Không có tin nhắn nào.</i>`;
  return `${header}\n\n${messages.map(messageLine).join("\n")}`;
}

/** History navigation keyboard: back to detail + home (+ page arrows). */
export function getHistoryKeyboard(customerId: string, page: number, totalPages: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (page > 1) kb.text("⬅️", `cskh:history:${customerId}:${page - 1}`);
  if (page < totalPages) kb.text("➡️", `cskh:history:${customerId}:${page + 1}`);
  kb.row().text("⬅️ Quay lại", `cskh:preview:${customerId}`).text("🏠 Menu CSKH", "cskh:home");
  return kb;
}

/** C3 — reply-mode (selected-chat) screen. */
export function renderReplyModeText(
  conv: ConversationWithCustomer,
  context: { need?: string; order?: string } = {}
): string {
  const c = conv.customer;
  const name = `${shortCustomerLabel(c)}${c.username ? ` (@${escapeHtml(c.username)})` : ""}`;
  const lines = [
    "🎧 <b>ĐANG TRẢ LỜI KHÁCH</b>\n",
    `👤 <b>${escapeHtml(name)}</b>`,
    c.telegramId
      ? `🆔 Telegram ID: <code>${c.telegramId}</code>`
      : `🆔 Ref: <code>#${c.id.slice(-6).toUpperCase()}</code>`
  ];
  if (context.need) lines.push(`💱 ${escapeHtml(context.need)}`);
  if (context.order) lines.push(`📦 ${escapeHtml(context.order)}`);
  lines.push(
    "\n✍️ Anh/chị có thể gửi trực tiếp:\n• Tin nhắn\n• Ảnh\n• Voice\n• File\n\n" +
      "<i>Tin nhắn/media gửi tiếp theo sẽ đến đúng khách này.</i>"
  );
  return lines.join("\n");
}

export function getReplyModeKeyboard(customerId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🕘 Lịch sử", `cskh:history:${customerId}:1`)
    .text("🔄 Chọn khách khác", "cskh:reply_switch")
    .row()
    .text("↩️ Thoát trả lời", "cskh:exit_reply")
    .text("🏠 Menu CSKH", "cskh:home");
}

