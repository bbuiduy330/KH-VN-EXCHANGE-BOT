/**
 * Admin Operations Center — persistent keyboard + dashboard + shared helpers.
 *
 * Pure helpers and rendering live here so they can be unit-tested without a
 * running Telegram bot or live database. Query callbacks live in the sibling
 * modules (admin-orders, admin-actions, admin-customers, admin-cskh,
 * admin-screens).
 */
import { InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { prisma } from "../../database/client.js";
import { MoneyService } from "../../modules/money/money-service.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { clearAdminSession } from "./admin-session.js";

// ---------------------------------------------------------------------------
// Persistent keyboard (authorized Admin PRIVATE chat only)
// ---------------------------------------------------------------------------

export const ADMIN_CONTROL_HOME = "🏠 Menu Admin";
export const ADMIN_CONTROL_INBOX = "🔴 Việc cần xử lý";
export const ADMIN_CONTROL_ORDERS = "📦 Đơn hàng";
export const ADMIN_CONTROL_RATES = "💱 Tỷ giá";
export const ADMIN_CONTROL_CUSTOMERS = "👥 Khách hàng";
export const ADMIN_CONTROL_CSKH = "💬 CSKH";

/** Text labels that must be intercepted BEFORE CSKH selected-chat forwarding. */
export const ADMIN_RESERVED_CONTROLS: readonly string[] = [
  ADMIN_CONTROL_HOME,
  ADMIN_CONTROL_INBOX,
  ADMIN_CONTROL_ORDERS,
  ADMIN_CONTROL_RATES,
  ADMIN_CONTROL_CUSTOMERS,
  ADMIN_CONTROL_CSKH
];

export function getAdminPersistentKeyboard() {
  return {
    keyboard: [
      [{ text: ADMIN_CONTROL_HOME }, { text: ADMIN_CONTROL_INBOX }],
      [{ text: ADMIN_CONTROL_ORDERS }, { text: ADMIN_CONTROL_RATES }],
      [{ text: ADMIN_CONTROL_CUSTOMERS }, { text: ADMIN_CONTROL_CSKH }]
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false
  };
}

export function isAdminReservedControl(text: string): boolean {
  return ADMIN_RESERVED_CONTROLS.includes(text.trim());
}

export function isAdminContext(ctx: BotContext): boolean {
  const ut = ctx.identity?.userType;
  return ut === "ADMIN" || ut === "SUPER_ADMIN";
}

// ---------------------------------------------------------------------------
// Short IDs & masking (no full Prisma CUID in normal Admin UI)
// ---------------------------------------------------------------------------

export function shortOrderId(orderId: string): string {
  return `#${String(orderId || "").slice(-6)}`;
}

export function shortCustomerId(customerId: string): string {
  return `#${String(customerId || "").slice(-6)}`;
}

/** Mask a bank account number: **** + last 4 (never the full number in lists). */
export function maskAccountNumber(accountNumber: string): string {
  const n = String(accountNumber || "");
  if (n.length <= 4) return "****";
  return `****${n.slice(-4)}`;
}

/** Humanized relative time in Vietnamese. */
export function timeAgo(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return "vừa xong";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

export function customerLabel(customer: { username?: string | null; fullName?: string | null; id?: string } | null | undefined): string {
  if (!customer) return "Khách";
  if (customer.username) return `@${customer.username}`;
  const name = (customer.fullName || "").trim();
  if (name) return name;
  return `Khách ${customer.id ? shortCustomerId(customer.id) : ""}`;
}

// ---------------------------------------------------------------------------
// Operations Center dashboard
// ---------------------------------------------------------------------------

export interface OperationsCenterCounts {
  /** Orders with a submitted bill genuinely awaiting Admin verification. */
  billAwaitingVerify: number;
  /** Orders in manual-review / suspicious flag states (may or may not have a bill). */
  warningReviews: number;
  /** Orders ready for Admin to pay the customer. */
  awaitingPayout: number;
  /** Conversations in HUMAN mode with no claimed staff. */
  waitingCskh: number;
  /** Orders still moving through the lifecycle (not COMPLETED / CANCELLED). */
  processingOrders: number;
}

export interface RateDisplay {
  usdToVnd: string;
  vndToUsd: string;
  updatedAt: Date | null;
  updatedBy: string | null;
}

// Bill verification counter: only states where a bill is genuinely awaiting
// Admin verification. MANUAL_REVIEW / SUSPICIOUS are *flag* states (may or may
// not carry a bill — e.g. manual override) and are counted separately.
export const BILL_AWAITING_VERIFY_STATUSES = ["WAITING_ADMIN_VERIFY", "CUSTOMER_SENT_BILL"];
export const WARNING_REVIEW_STATUSES = ["MANUAL_REVIEW", "SUSPICIOUS"];
const PROCESSING_STATUSES = [
  "WAITING_PAYMENT",
  "CUSTOMER_SENT_BILL",
  "WAITING_ADMIN_VERIFY",
  "PAYMENT_CONFIRMED",
  "WAITING_PAYOUT",
  "PAYOUT_SENT",
  "PAYMENT_MISMATCH",
  "MANUAL_REVIEW",
  "SUSPICIOUS"
];

export async function loadOperationsCenterCounts(): Promise<OperationsCenterCounts> {
  const [billAwaitingVerify, warningReviews, awaitingPayout, waitingCskh, processingOrders] = await Promise.all([
    prisma.order.count({ where: { status: { in: BILL_AWAITING_VERIFY_STATUSES } } }),
    prisma.order.count({ where: { status: { in: WARNING_REVIEW_STATUSES } } }),
    prisma.order.count({ where: { status: "WAITING_PAYOUT" } }),
    prisma.conversation.count({ where: { mode: "HUMAN", claimedById: null } }),
    prisma.order.count({ where: { status: { in: PROCESSING_STATUSES } } })
  ]);
  return { billAwaitingVerify, warningReviews, awaitingPayout, waitingCskh, processingOrders };
}

export async function loadRateDisplay(): Promise<RateDisplay | null> {
  const usdVnd = await prisma.exchangeRate.findUnique({ where: { pair: "USD/VND" } });
  if (!usdVnd) return null;
  const { effectiveBuy, effectiveSell } = MoneyService.calculateEffectiveRates(
    usdVnd.baseRate,
    usdVnd.buyMargin,
    usdVnd.sellMargin
  );
  return {
    usdToVnd: MoneyService.formatAmount(effectiveBuy, "VND"),
    vndToUsd: MoneyService.formatAmount(effectiveSell, "VND"),
    updatedAt: usdVnd.updatedAt,
    updatedBy: usdVnd.updatedBy
  };
}

export function renderOperationsCenterText(
  staffName: string,
  counts: OperationsCenterCounts,
  rate: RateDisplay | null
): string {
  const lines: string[] = [
    "🛡 <b>TRUNG TÂM QUẢN TRỊ</b>",
    "",
    "🔴 <b>VIỆC CẦN XỬ LÝ</b>",
    `📷 Bill chờ xác minh: <b>${counts.billAwaitingVerify}</b>`,
    `⚠️ Cần kiểm tra: <b>${counts.warningReviews}</b>`,
    `💸 Chờ payout: <b>${counts.awaitingPayout}</b>`,
    `🔔 Khách chờ CSKH: <b>${counts.waitingCskh}</b>`,
    `📦 Đơn đang xử lý: <b>${counts.processingOrders}</b>`,
    "",
    "💱 <b>TỶ GIÁ</b>"
  ];

  if (rate) {
    lines.push(`USD → VND: <b>1 USD = ${escapeHtml(rate.usdToVnd)} VND</b>`);
    lines.push(`VND → USD: <b>1 USD = ${escapeHtml(rate.vndToUsd)} VND</b>`);
    lines.push(`🕒 Cập nhật: ${rate.updatedAt ? timeAgo(rate.updatedAt) : "—"}`);
  } else {
    lines.push("Chưa cấu hình cặp USD/VND.");
  }

  lines.push("", `👨‍💼 <b>${escapeHtml(staffName)}</b>`);
  return lines.join("\n");
}

export function getOperationsCenterKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔴 Việc cần xử lý", "ops:inbox")
    .text("📦 Đơn hàng", "ops:orders")
    .row()
    .text("👥 Khách hàng", "ops:customers")
    .text("💬 CSKH", "ops:cskh")
    .row()
    .text("💱 Tỷ giá", "ops:rates")
    .text("🏦 Tài khoản thanh toán", "ops:accounts")
    .row()
    .text("👨‍💼 Nhân viên", "ops:staff")
    .text("🤖 AI", "ops:ai")
    .row()
    .text("⚙️ Cấu hình", "ops:config")
    .text("📜 Nhật ký", "ops:audit")
    .row()
    .text("❓ Hướng dẫn", "ops:help")
    .text("⌨️ Lệnh nâng cao", "ops:advanced");
}

/**
 * Render the Operations Center. For a fresh message this also (re-)establishes
 * the persistent reply keyboard; for a callback it re-renders the inline panel.
 */
export async function showOperationsCenter(ctx: BotContext): Promise<void> {
  if (!isAdminContext(ctx)) {
    await ctx.reply("⛔ Bạn không có quyền truy cập chức năng này.").catch(() => {});
    return;
  }

  clearAdminSession(String(ctx.from?.id || ""));

  const staff = ctx.identity?.staff;
  const staffName = staff?.name || (ctx.identity?.userType === "SUPER_ADMIN" ? "Super Admin" : "Quản trị viên");

  const [counts, rate] = await Promise.all([loadOperationsCenterCounts(), loadRateDisplay()]);
  const text = renderOperationsCenterText(staffName, counts, rate);
  const inlineKb = getOperationsCenterKeyboard();

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: inlineKb });
    } catch {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: inlineKb });
    }
    return;
  }

  // Fresh entry: establish the persistent keyboard (under the input) and show
  // the inline control panel. Two messages — reply keyboard + inline keyboard
  // cannot coexist on a single Telegram message.
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: getAdminPersistentKeyboard() });
  await ctx.reply("📋 Chọn chức năng:", { reply_markup: inlineKb });
}

