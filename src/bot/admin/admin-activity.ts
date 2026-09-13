/**
 * PART B — ADMIN OPERATIONS CENTER UX.
 *
 * Two SEPARATE concepts over the SAME authoritative AuditLog storage:
 *  1. 📋 HOẠT ĐỘNG (this screen) — business-operations feed: only meaningful
 *     business events, newest first, deduplicated by (action, targetId) so
 *     low-level duplicate internal events never flood the view.
 *  2. 🔧 AUDIT KỸ THUẬT (admin-audit.ts, unchanged storage) — full technical
 *     audit for scheduler/callback/permission/QR/AI/config entries.
 *
 * Nothing is ever deleted from AuditLog; this is a presentation filter.
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { prisma } from "../../database/client.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { shortOrderId } from "./admin-panel.js";
import { formatAdminDateTime } from "../../shared/app-time.js";
import { resolveAuditCustomers, auditCustomerName } from "./audit-view.js";

export const adminActivityHandler = new Composer<BotContext>();

/** B1 — business-event whitelist: icon + friendly verb per action family. */
const ACTIVITY_MAP: { match: RegExp; icon: string; verb: string }[] = [
  { match: /ORDER_AUTO_CANCELLED/, icon: "⏰", verb: "Hết hạn thanh toán — tự động hủy" },
  { match: /ORDER_CANCELLED/, icon: "❌", verb: "Đã hủy đơn" },
  { match: /PAYMENT_VERIFIED|PAYMENT_CONFIRMED/, icon: "✅", verb: "Xác nhận tiền vào" },
  { match: /ORDER_COMPLETED/, icon: "✅", verb: "Hoàn tất đơn" },
  { match: /PAYOUT/, icon: "💸", verb: "Đã gửi payout" },
  { match: /BILL|MISMATCH|SUSPICIOUS|MANUAL_REVIEW/, icon: "🧾", verb: "Bill/kiểm tra giao dịch" },
  { match: /ORDER_CREATED|ORDER_QUOTE/, icon: "📦", verb: "Tạo đơn" },
  { match: /PARTNER_COMMISSION_CREATED/, icon: "💰", verb: "Tạo hoa hồng CTV" },
  { match: /PARTNER_HIERARCHY_UPDATED/, icon: "🤝", verb: "Cập nhật hierarchy CTV" },
  { match: /PARTNER_SETTLEMENT_PAID/, icon: "💸", verb: "Tất toán CTV — PAID" },
  { match: /PARTNER_SETTLEMENT_CREATED/, icon: "🧾", verb: "Tạo đợt tất toán CTV" },
  { match: /PARTNER_PAYOUT_UPDATED|PARTNER_PAYOUT_QR_UPDATED/, icon: "🏦", verb: "CTV cập nhật nhận hoa hồng" },
  { match: /BROADCAST_CAMPAIGN_CONFIRMED/, icon: "📣", verb: "Broadcast — xác nhận gửi" },
  { match: /BROADCAST_CAMPAIGN_COMPLETED/, icon: "📣", verb: "Broadcast — hoàn tất" },
  { match: /BROADCAST_CAMPAIGN_(CREATED|CANCELLED)/, icon: "📣", verb: "Broadcast — tạo/hủy chiến dịch" },
  { match: /INCOMING_PAYMENT_(CONFIRMED|MISMATCH)/, icon: "💵", verb: "Xác nhận tiền tự động" },
  { match: /CONFIG|SETTING|GEMINI|AI_|STAFF|PERMISSION|BACKUP/, icon: "⚙️", verb: "Thay đổi cấu hình hệ thống" }
];

/** Low-value internal bookkeeping — suppressed as primary rows (B1). */
const NOISE_ACTIONS = /RECONCILED|AUTO_AVAILABLE|SENDING_STARTED|BROADCAST_CAMPAIGN_CREATED|PROOF_UPLOADED|PAYOUT_UPDATED/;

const SECTION_FILTERS: Record<string, RegExp | null> = {
  all: null,
  order: /order|payment|payout|bill/i,
  customer: /customer|order/i,
  ctv: /partner|commission|settlement/i,
  broadcast: /broadcast/i,
  system: /config|setting|gemini|ai|staff|permission|backup|incoming/i
};

function classify(action: string): { icon: string; verb: string } | null {
  for (const entry of ACTIVITY_MAP) {
    if (entry.match.test(action)) return { icon: entry.icon, verb: entry.verb };
  }
  return null;
}

export async function showActivityFeed(ctx: BotContext, filter: string = "all"): Promise<void> {
  if (!(await requirePermission(ctx, "audit.view"))) return;
  const logs: any[] = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 });

  // B1 — business events only, deduplicated by (action, targetId): the first
  // (newest) occurrence wins; pure bookkeeping actions are suppressed.
  const seen = new Set<string>();
  const business: any[] = [];
  for (const l of logs) {
    if (NOISE_ACTIONS.test(l.action || "")) continue;
    const cls = classify(l.action || "");
    if (!cls) continue;
    const sectionFilter = SECTION_FILTERS[filter];
    if (sectionFilter && !sectionFilter.test(l.action || "")) continue;
    const key = `${l.action}|${l.targetId || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    business.push({ ...l, _cls: cls });
    if (business.length >= 25) break;
  }

  const custMap = await resolveAuditCustomers(business);
  const lines: string[] = ["📋 <b>HOẠT ĐỘNG</b>", ""];
  if (business.length === 0) {
    lines.push("Chưa có hoạt động nào.");
  } else {
    for (const l of business) {
      const cust = custMap.get(String(l.targetId || "")) || custMap.get(String(l.actorId || "")) || null;
      const who = cust ? auditCustomerName(cust) : "";
      const ref = /order|payment|payout|commission/i.test(l.action || "") && l.targetId ? shortOrderId(l.targetId) : "";
      lines.push(
        `${formatAdminDateTime(l.createdAt)} ${l._cls.icon}${ref ? ` ${ref}` : ""}${who ? ` · ${escapeHtml(who)}` : ""} · ${escapeHtml(l._cls.verb)}`
      );
    }
  }

  const kb = new InlineKeyboard()
    .text("📦 Giao dịch", "ops:activity:filter:order")
    .text("👤 Khách hàng", "ops:activity:filter:customer")
    .row()
    .text("🤝 CTV", "ops:activity:filter:ctv")
    .text("📣 Broadcast", "ops:activity:filter:broadcast")
    .row()
    .text("⚙️ Hệ thống", "ops:activity:filter:system")
    .text("📋 Tất cả", "ops:activity:filter:all")
    .row()
    .text("🔧 Audit kỹ thuật", "ops:audit")
    .row()
    .text("🏠 Menu Admin", "ops:home");

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

adminActivityHandler.callbackQuery("ops:activity", (ctx) => showActivityFeed(ctx, "all"));
adminActivityHandler.callbackQuery(/^ops:activity:filter:(all|order|customer|ctv|broadcast|system)$/, (ctx) =>
  showActivityFeed(ctx, ctx.match?.[1] || "all"));

