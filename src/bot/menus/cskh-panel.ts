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
    `🆔 ID ngắn: <code>${c.id.slice(-6)}</code>`,
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
