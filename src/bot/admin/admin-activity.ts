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
import {
  ADMIN_LIST_FETCH_TAKE,
  ADMIN_LIST_PAGE_SIZE,
  ADMIN_LIST_RAW_SCAN_CAP,
  ADMIN_LIST_SCAN_BATCH,
  advanceAdminList,
  commitAdminListNext,
  decodeListCursor,
  encodeListCursor,
  ensureAdminListFilter,
  getAdminListState,
  listCursorWhere,
  retreatAdminList,
  scanCursorForBatch
} from "./admin-list-session.js";

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

export async function showActivityFeed(ctx: BotContext, filter: string = "all", move?: "next" | "prev"): Promise<void> {
  if (!(await requirePermission(ctx, "audit.view"))) return;
  const adminId = String(ctx.from?.id || "");

  // Per-admin cursor state; a category change resets the cursor history.
  ensureAdminListFilter(adminId, "activity", filter);
  let cursorRaw = "";
  if (move === "next") {
    const next = advanceAdminList(adminId, "activity");
    if (next === null) {
      await ctx.answerCallbackQuery("Đã hết danh sách.").catch(() => {});
      return;
    }
    cursorRaw = next;
  } else if (move === "prev") {
    const prev = retreatAdminList(adminId, "activity");
    if (prev === null) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    cursorRaw = prev;
  }

  // BOUNDED INCREMENTAL KEYSET SCAN: fetch raw AuditLog in batches of 100,
  // classify/dedupe each batch, continue until (a) 21 business events are
  // collected (20 displayed + 1 NEXT-page sentinel), (b) raw rows are
  // exhausted, or (c) the HARD raw cap (1000) is reached. Never a full-table
  // load, never OFFSET, never COUNT, never unbounded. The next-page cursor is
  // the LAST RAW ROW EXAMINED (not the last displayed business event), so
  // heavily-noised stretches never lose business events that appear later.
  const scanStart = decodeListCursor(cursorRaw || null);
  const business: any[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let lastRaw: { createdAt: Date; id: string } | null = null;
  let batchCursor = scanCursorForBatch(scanStart);

  while (scanned < ADMIN_LIST_RAW_SCAN_CAP && business.length < ADMIN_LIST_FETCH_TAKE) {
    const cw = listCursorWhere(batchCursor);
    const batch: any[] = await prisma.auditLog.findMany({
      ...(cw ? { where: cw } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ADMIN_LIST_SCAN_BATCH
    });
    if (batch.length === 0) break;
    for (const l of batch) {
      scanned++;
      lastRaw = { createdAt: l.createdAt, id: l.id };
      if (NOISE_ACTIONS.test(l.action || "")) continue;
      const cls = classify(l.action || "");
      if (!cls) continue;
      const sectionFilter = SECTION_FILTERS[filter];
      if (sectionFilter && !sectionFilter.test(l.action || "")) continue;
      const key = `${l.action}|${l.targetId || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      business.push({ ...l, _cls: cls });
      if (business.length >= ADMIN_LIST_FETCH_TAKE) break;
    }
    // Deterministic continuation: next batch starts strictly AFTER the last
    // raw row of THIS batch (keyset, no OFFSET).
    const lastOfBatch = batch[batch.length - 1];
    batchCursor = { createdAt: new Date(lastOfBatch.createdAt), id: String(lastOfBatch.id) };
    if (batch.length < ADMIN_LIST_SCAN_BATCH) break; // raw stream exhausted
  }
  // 21-event sentinel: 20 shown + the 21st proves a next page exists. If only
  // ≤20 collected, no next page (stream exhausted or raw cap hit).
  const hasMore = business.length > ADMIN_LIST_PAGE_SIZE && lastRaw !== null;
  // Next-page cursor = the LAST RAW AuditLog row actually examined (not the
  // last displayed business event) — never skips or duplicates raw rows.
  commitAdminListNext(
    adminId,
    "activity",
    hasMore && lastRaw ? encodeListCursor(lastRaw) : null
  );

  // Display ONLY the first 20; the 21st (when present) is sentinel-only.
  const displayed = business.slice(0, ADMIN_LIST_PAGE_SIZE);

  const custMap = await resolveAuditCustomers(displayed);
  const lines: string[] = ["📋 <b>HOẠT ĐỘNG</b>", `${displayed.length} sự kiện gần nhất`, ""];
  if (displayed.length === 0) {
    lines.push("Chưa có hoạt động phù hợp.");
  } else {
    for (const l of displayed) {
      const cust = custMap.get(String(l.targetId || "")) || custMap.get(String(l.actorId || "")) || null;
      const who = cust ? auditCustomerName(cust) : "";
      const ref = /order|payment|payout|commission/i.test(l.action || "") && l.targetId ? shortOrderId(l.targetId) : "";
      lines.push(
        `${formatAdminDateTime(l.createdAt)} ${l._cls.icon}${ref ? ` ${ref}` : ""}${who ? ` · ${escapeHtml(who)}` : ""} · ${escapeHtml(l._cls.verb)}`
      );
    }
  }

  const kb = new InlineKeyboard();
  const st = getAdminListState(adminId, "activity");
  const nav = kb.row();
  if (st.pos > 0) nav.text("⬅️ Trước", "ops:activity:page:prev");
  if (hasMore) nav.text("Tiếp ➡️", "ops:activity:page:next");
  kb.row()
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
// Cursor page navigation (tiny callbacks; cursor state in per-admin session):
adminActivityHandler.callbackQuery("ops:activity:page:next", (ctx) => {
  const st = getAdminListState(String(ctx.from?.id || ""), "activity");
  return showActivityFeed(ctx, st.filter || "all", "next");
});
adminActivityHandler.callbackQuery("ops:activity:page:prev", (ctx) => {
  const st = getAdminListState(String(ctx.from?.id || ""), "activity");
  return showActivityFeed(ctx, st.filter || "all", "prev");
});

