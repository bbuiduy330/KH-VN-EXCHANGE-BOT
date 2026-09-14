/**
 * Admin Partner/CTV panel (X). Permission-separated from financial actions:
 * uses "staff.manage" so CSKH never reaches partner management.
 * NO customer data is shown here (only aggregates + partner-owned payout
 * metadata the Admin needs to pay the partner).
 */
import { Composer, InlineKeyboard, InputFile } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requireRole } from "../middleware/permissions.js";
import { PartnerService } from "../../modules/partner/partner-service.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { startWizard, getAdminSession, isSessionExpired, clearWizard, updateWizard } from "./admin-session.js";
import { setAdminSearch } from "./admin-session.js";
import { shortOrderId } from "./admin-panel.js";
import {
  ADMIN_LIST_FETCH_TAKE,
  ADMIN_LIST_PAGE_SIZE,
  advanceAdminList,
  commitAdminListNext,
  decodeListCursor,
  encodeListCursor,
  ensureAdminListFilter,
  getAdminListState,
  listCursorWhere,
  retreatAdminList
} from "./admin-list-session.js";
import { getBotInstance, notifyPartnerSettlementPaid } from "../notifications.js";
import { MoneyService } from "../../modules/money/money-service.js";
import { formatAdminDateTime } from "../../shared/app-time.js";
import { prisma } from "../../database/client.js";
import { FileService } from "../../modules/files/file-service.js";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";

export const adminPartnersHandler = new Composer<BotContext>();

const usd = (d: any): string => `$${Number(d ?? 0).toFixed(2)}`;

function partnerLink(partner: any): string {
  const me = (getBotInstance() as any)?.botInfo?.username as string | undefined;
  return me ? `https://t.me/${me}?start=${PartnerService.referralPayload(partner)}` : "";
}

async function showPartners(ctx: BotContext, move?: "next" | "prev"): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  // 2 — belt-and-braces: opening the panel reconciles missing commissions and
  // materialises HELD→AVAILABLE (idempotent, DB-derived, audited).
  await PartnerService.reconcileAvailableCommissions().catch(() => {});
  await PartnerService.reconcileMissingCommissions().catch(() => {});
  const adminId = String(ctx.from?.id || "");

  // Cursor pagination (per admin + screen; createdAt DESC, id DESC keyset).
  ensureAdminListFilter(adminId, "partners", "");
  let cursorRaw = "";
  if (move === "next") {
    const next = advanceAdminList(adminId, "partners");
    if (next === null) {
      await ctx.answerCallbackQuery("Đã hết danh sách.").catch(() => {});
      return;
    }
    cursorRaw = next;
  } else if (move === "prev") {
    const prev = retreatAdminList(adminId, "partners");
    if (prev === null) return;
    cursorRaw = prev;
  }
  const cw = listCursorWhere(decodeListCursor(cursorRaw || null));
  const rows: any[] = await prisma.partner.findMany({
    ...(cw ? { where: cw } : {}),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ADMIN_LIST_FETCH_TAKE
  });
  const hasMore = rows.length > ADMIN_LIST_PAGE_SIZE;
  const partners = rows.slice(0, ADMIN_LIST_PAGE_SIZE);
  commitAdminListNext(adminId, "partners", hasMore && partners.length > 0 ? encodeListCursor(partners[partners.length - 1]) : null);

  const lines = ["🤝 <b>CỘNG TÁC VIÊN (CTV)</b>", `${partners.length} CTV gần nhất`, ""];
  const kb = new InlineKeyboard();
  if (partners.length === 0) {
    lines.push("Chưa có CTV nào.");
  } else {
    for (const p of partners) {
      const s = await PartnerService.partnerSummary(p.id);
      lines.push(...partnerRow(p), `   💵 HELD ${usd(s.held)} · AVAIL ${usd(s.available)} · PAID ${usd(s.paid)}`, "");
      kb.text(`👤 ${p.displayName}`, `ops:partner:detail:${p.id}`).row();
    }
  }
  // Page navigation (tiny callbacks; cursor state in per-admin session).
  const st = getAdminListState(adminId, "partners");
  const navRow = kb.row();
  if (st.pos > 0) navRow.text("⬅️ Trước", "ops:partners:page:prev");
  if (hasMore) navRow.text("Tiếp ➡️", "ops:partners:page:next");
  kb.text("➕ Thêm CTV", "ops:partner:add")
    .row()
    .text("🔎 Tìm CTV", "ops:partner:search")
    .row()
    .text("🏠 Menu Admin", "ops:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

/** PART B row: 🟢 Name · TG id / 🟡 unbound + Ref + Mã GT (no raw CUID primary). */
function partnerRow(p: any): string[] {
  if (p.telegramId) {
    return [`🟢 ${escapeHtml(p.displayName)} · TG <code>${escapeHtml(p.telegramId)}</code>`, `CTV Ref: <code>#${escapeHtml(p.id.slice(-6).toUpperCase())}</code>`, `Mã GT: <code>${escapeHtml(p.referralCode)}</code>`];
  }
  return [`🟡 Chưa liên kết Telegram`, `Tên: ${escapeHtml(p.displayName)}`, `Mã GT: <code>${escapeHtml(p.referralCode)}</code>`];
}

async function showPartnerDetail(ctx: BotContext, partnerId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const p = await PartnerService.getPartnerById(partnerId);
  if (!p) {
    await ctx.reply("❌ Không tìm thấy CTV.").catch(() => {});
    return;
  }
  const s = await PartnerService.partnerSummary(partnerId);
  const commissions = await PartnerService.listPartnerCommissions(partnerId, 5);
  const lines = [
    `🤝 <b>CTV: ${escapeHtml(p.displayName)}</b> · ${p.status === "ACTIVE" ? "🟢 ACTIVE" : "⛔ DISABLED"}`,
    `🔖 Code: <code>${p.referralCode}</code>`,
    p.telegramId ? `🆔 Telegram ID: <code>${p.telegramId}</code>` : "🆔 Telegram ID: (chưa gắn)",
    "",
    `📦 Đơn hoàn tất đủ điều kiện: <b>${s.eligibleCompleted}</b>`,
    `💵 HELD: <b>${usd(s.held)}</b> · AVAILABLE: <b>${usd(s.available)}</b> · PAID: <b>${usd(s.paid)}</b>`,
    p.payoutDestinationText
      ? `💳 <b>Thông tin nhận hoa hồng:</b>\n<code>${escapeHtml(p.payoutDestinationText.length > 400 ? `${p.payoutDestinationText.slice(0, 400)}…` : p.payoutDestinationText)}</code>`
      : p.payoutBankName
        ? `🏦 Chi trả cho CTV: ${escapeHtml(p.payoutBankName)} ••••${escapeHtml(String(p.payoutAccountNumber || "").slice(-4))} — ${escapeHtml(p.payoutAccountName || "")}`
        : "💳 CTV chưa nộp thông tin nhận hoa hồng",
    "",
    `<b>Hoa hồng gần nhất:</b>`
  ];
  const kb = new InlineKeyboard();
  for (const c of commissions) {
    const st = PartnerService.effectiveStatus(c);
    lines.push(`📦 ${c.orderId.slice(-6)} · ${usd(c.totalUsd)} · ${st}${c.riskFlag ? ` · ⚠️ ${c.riskFlag}` : ""}`);
    if (st === "HELD") {
      kb.text(`🔓 Mở ${c.orderId.slice(-6)}`, `ops:partner:release:${c.id}`).row();
    }
  }
  const link = partnerLink(p);
  if (link) lines.push("", `🔗 <code>${link}</code>`);

  // PART B — full CTV management actions:
  kb
    .text(p.telegramId ? "🔄 Đổi Telegram ID" : "🔗 Liên kết Telegram", `ops:partner:bind:${p.id}`)
    .row()
    .text("💰 Hoa hồng gần đây", `ops:partner:commissions:${p.id}`)
    .text("💸 Tất toán", `ops:partner:settle:${p.id}`)
    .row()
    .text("💸 Lịch sử thanh toán", `ops:partner:settlements:${p.id}`)
    .row()
    .text(p.status === "ACTIVE" ? "⛔ Tắt CTV" : "✅ Bật lại CTV", `ops:partner:toggle:${p.id}`)
    .row();
  if (p.payoutQrFileId) kb.text("🖼 Xem QR nhận HH", `ops:partner:payoutqr:${p.id}`).row();
  kb
    .text("⬅️ Danh sách CTV", "ops:partners")
    .text("🏠 Menu Admin", "ops:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

/** PART K — settlement history with exact GMT+7 timestamps (PART L). */
async function showPartnerSettlements(ctx: BotContext, partnerId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const p = await PartnerService.getPartnerById(partnerId);
  const settlements = await PartnerService.listPartnerSettlements(partnerId, 10);
  const lines = [`💸 <b>LỊCH SỬ THANH TOÁN — ${escapeHtml(p?.displayName || "")}</b>`, ""];
  const kb = new InlineKeyboard();
  if (settlements.length === 0) {
    lines.push("Chưa có đợt thanh toán nào.");
  } else {
    for (const s of settlements) {
      lines.push(
        `${s.status === "PAID" ? "✅" : "⏳"} ${formatAdminDateTime(s.createdAt)} · ${usd(s.totalUsd)} · ${s.itemCount} hoa hồng · ${s.status} · bởi ${s.createdBy}`
      );
      kb.text(`👁 Chi tiết #${s.id.slice(-6)}`, `ops:partner:settlement:detail:${s.id}`).row();
    }
  }
  kb.text("⬅️ Chi tiết CTV", `ops:partner:detail:${partnerId}`);
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

/** Commission list (💰) — safe business references only, cursor-paginated. */
async function showPartnerCommissions(ctx: BotContext, partnerId: string, move?: "next" | "prev"): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const adminId = String(ctx.from?.id || "");
  // Per-(admin, partner) list state; commission status filter is part of the
  // key context — changing it resets the cursor history.
  const screen = `pcom:${partnerId}`;
  const prior = getAdminListState(adminId, screen);
  const statusFilter = (["all", "HELD", "AVAILABLE", "PAID", "REVERSED"].includes(prior.filter) ? prior.filter : "all");
  // ensure… resets cursor history when the filter changed (never reuse stale cursor).
  ensureAdminListFilter(adminId, screen, statusFilter);
  const st = getAdminListState(adminId, screen);
  let cursorRaw = "";
  if (move === "next") {
    const next = advanceAdminList(adminId, screen);
    if (next === null) {
      await ctx.answerCallbackQuery("Đã hết danh sách.").catch(() => {});
      return;
    }
    cursorRaw = next;
  } else if (move === "prev") {
    const prev = retreatAdminList(adminId, screen);
    if (prev === null) return;
    cursorRaw = prev;
  }

  // A2 — ADMIN FULL TRACEABILITY: customer identity is deliberately VISIBLE to
  // Admin here (name + Telegram numeric ID + short ref) — the CTV /ctv view
  // remains privacy-safe and never receives any of this.
  const where: any = { partnerId };
  if (statusFilter !== "all") where.status = statusFilter;
  const cw = listCursorWhere(decodeListCursor(cursorRaw || null));
  if (cw) where.AND = [cw];
  const commissions: any[] = await prisma.commission.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ADMIN_LIST_FETCH_TAKE
  });
  const hasMore = commissions.length > ADMIN_LIST_PAGE_SIZE;
  const page = commissions.slice(0, ADMIN_LIST_PAGE_SIZE);
  commitAdminListNext(adminId, screen, hasMore && page.length > 0 ? encodeListCursor(page[page.length - 1]) : null);
  // Bounded customer join for EXACTLY this page (single in-clause query).
  const orderIds = [...new Set(page.map((c: any) => c.orderId))];
  const orders: any[] = orderIds.length
    ? await prisma.order.findMany({ where: { id: { in: orderIds } }, include: { customer: true } })
    : [];
  const orderById = new Map(orders.map((o: any) => [o.id, o]));

  const lines = [
    "💰 <b>HOA HỒNG — TRUY VẾT ĐẦY ĐỦ</b>",
    `${page.length} hoa hồng mới nhất${statusFilter !== "all" ? ` · ${statusFilter}` : ""}`,
    ""
  ];
  const kb = new InlineKeyboard();
  if (page.length === 0) {
    lines.push("Không có hoa hồng phù hợp.");
  } else {
    for (const c of page) {
      const order = orderById.get(c.orderId);
      const customer = order?.customer;
      const stt = PartnerService.effectiveStatus(c);
      const levelLabel = `L${c.level ?? 1}`;
      const fixed = `$${Number(c.baseCommissionUsd ?? 0).toFixed(2)}`;
      const spread = `$${Number(c.spreadBonusUsd ?? 0).toFixed(2)}`;
      const dir = order
        ? `${MoneyService.formatMoney(order.sourceAmount, order.sourceCurrency)} → ${MoneyService.formatMoney(order.targetAmount, order.targetCurrency)}`
        : "—";
      lines.push(
        `💰 <b>${usd(c.totalUsd)}</b> · ${levelLabel} · ${stt}${c.riskFlag ? ` · ⚠️ ${escapeHtml(c.riskFlag)}` : ""}`,
        `👤 Khách: ${escapeHtml(customer?.fullName || customer?.username || "—")}${customer?.telegramId ? ` · TG <code>${escapeHtml(customer.telegramId)}</code>` : ""}`,
        `📦 Đơn: <code>${shortOrderId(c.orderId)}</code> · ${escapeHtml(dir)}`,
        `${fixed} cố định + ${spread} chia sẻ tỷ giá`,
        `🕒 ${formatAdminDateTime(c.createdAt)}`,
        ""
      );
      kb.text(`📦 Mở giao dịch ${shortOrderId(c.orderId)}`, `ops:order:detail:${c.orderId}`).row();
    }
  }

  // Status filters (HELD/AVAILABLE/PAID/REVERSED) — filter change resets cursor.
  kb.row()
    .text("Tất cả", `ops:pcomf:${partnerId}:all`)
    .text("HELD", `ops:pcomf:${partnerId}:HELD`);
  kb.row()
    .text("AVAILABLE", `ops:pcomf:${partnerId}:AVAILABLE`)
    .text("PAID", `ops:pcomf:${partnerId}:PAID`)
    .text("REVERSED", `ops:pcomf:${partnerId}:REVERSED`);
  // Page navigation.
  const nav = kb.row();
  if (st.pos > 0) nav.text("⬅️ Trước", `ops:pcom:${partnerId}:prev`);
  if (hasMore) nav.text("Tiếp ➡️", `ops:pcom:${partnerId}:next`);
  // E1 — parent hierarchy assignment (Admin-only, cycle/depth validated).
  const partner = await PartnerService.getPartnerById(partnerId);
  lines.push(`🔗 CTV cha: ${partner?.parentPartnerId ? `<code>${escapeHtml(partner.parentPartnerId.slice(-6).toUpperCase())}</code>` : "— (L1)"}`);
  kb.row().text("🔗 Gán CTV cha", `ops:partner:parent:${partnerId}`);
  kb.row().text("⬅️ Chi tiết CTV", `ops:partner:detail:${partnerId}`).text("🏠 Menu Admin", "ops:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

// E1 — parent hierarchy assignment wizard: free-form (Telegram ID, mã GT, Ref).
export async function handlePartnerParentInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (session.wizard?.kind !== "partner_parent") return false;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên đã hết hạn.").catch(() => {});
    return true;
  }
  const partnerId = String(session.wizard.data?.partnerId || "");
  const raw = text.trim();
  if (raw.toLowerCase() === "xoa" || raw.toLowerCase() === "xóa" || raw === "-") {
    try {
      await PartnerService.setPartnerParent(adminId, partnerId, null);
      clearWizard(adminId);
      await ctx.reply("✅ Đã gỡ CTV cha — đây nay là CTV L1.").catch(() => {});
    } catch (err: any) {
      await ctx.reply(`❌ ${escapeHtml(err?.message || "Lỗi")}`).catch(() => {});
    }
    return true;
  }
  const matches = await PartnerService.searchPartners(raw);
  const parent = matches.find((p: any) => p.id !== partnerId);
  if (!parent) {
    await ctx.reply("❌ Không tìm thấy CTV cha phù hợp. Gửi lại, hoặc /cancel để hủy.").catch(() => {});
    return true;
  }
  try {
    await PartnerService.setPartnerParent(adminId, partnerId, parent.id);
    clearWizard(adminId);
    await ctx.reply(
      `✅ Đã gán CTV cha: <b>${escapeHtml(parent.displayName)}</b> (TG <code>${escapeHtml(parent.telegramId || "")}</code>).\n<i>Các hoa hồng ĐÃ TẠO không bị viết lại — snapshot đóng băng giữ nguyên.</i>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "Lỗi")}`).catch(() => {});
  }
  return true;
}

adminPartnersHandler.callbackQuery(/^ops:partner:parent:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const partnerId = ctx.match?.[1] || "";
  startWizard(String(ctx.from?.id || ""), "partner_parent", { partnerId });
  await ctx.reply(
    "🔗 <b>GÁN CTV CHA</b>\n\nGửi Telegram ID / mã GT / tên của CTV cha (tầng trên).\nGửi <code>xoa</code> để gỡ (thành CTV L1).\nTối đa 5 tầng chi trả — hệ thống chặn tự-parent/cycle/quá sâu.\n\nGửi /cancel để hủy.",
    { parse_mode: "HTML" }
  );
});

export async function handlePartnerAddInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (session.wizard?.kind !== "partner_add") return false;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên đã hết hạn.").catch(() => {});
    return true;
  }
  try {
    const p = await PartnerService.createPartner(adminId, text);
    clearWizard(adminId);
    const link = partnerLink(p);
    await ctx.reply(
      `✅ <b>ĐÃ TẠO CTV</b>\n\n👤 ${escapeHtml(p.displayName)}\n🔖 Code: <code>${p.referralCode}</code>\n` +
        (link ? `🔗 <code>${link}</code>` : "🔗 Link: cấu hình bot username rồi mở lại."),
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "Lỗi")}`).catch(() => {});
  }
  return true;
}

adminPartnersHandler.callbackQuery("ops:partners", (ctx) => showPartners(ctx));
// Cursor page navigation (tiny callbacks; cursor state in per-admin session).
adminPartnersHandler.callbackQuery("ops:partners:page:next", (ctx) => showPartners(ctx, "next"));
adminPartnersHandler.callbackQuery("ops:partners:page:prev", (ctx) => showPartners(ctx, "prev"));
adminPartnersHandler.callbackQuery(/^ops:partner:commissions:([a-zA-Z0-9_-]+)$/, (ctx) => showPartnerCommissions(ctx, ctx.match?.[1] || ""));
// Commission status filters (reset cursor) + cursor page navigation:
adminPartnersHandler.callbackQuery(/^ops:pcomf:([a-zA-Z0-9_-]+):(all|HELD|AVAILABLE|PAID|REVERSED)$/, async (ctx) => {
  const partnerId = ctx.match?.[1] || "";
  const status = ctx.match?.[2] || "all";
  ensureAdminListFilter(String(ctx.from?.id || ""), `pcom:${partnerId}`, status);
  await showPartnerCommissions(ctx, partnerId);
});
adminPartnersHandler.callbackQuery(/^ops:pcom:([a-zA-Z0-9_-]+):(next|prev)$/, (ctx) =>
  showPartnerCommissions(ctx, ctx.match?.[1] || "", ctx.match?.[2] as "next" | "prev"));
adminPartnersHandler.callbackQuery(/^ops:partner:settlements:([a-zA-Z0-9_-]+)$/, (ctx) => showPartnerSettlements(ctx, ctx.match?.[1] || ""));

// ---------------------------------------------------------------------------
// PART C — Telegram binding wizard: numeric ID only, preview → confirm,
// conflict-safe, audited. Rebinding requires the same explicit confirmation.
// ---------------------------------------------------------------------------
adminPartnersHandler.callbackQuery(/^ops:partner:bind:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const partnerId = ctx.match?.[1] || "";
  const p = await PartnerService.getPartnerById(partnerId);
  if (!p) return;
  startWizard(String(ctx.from?.id || ""), "partner_bind", { partnerId });
  await ctx.reply(
    `🔗 <b>${p.telegramId ? "ĐỔI TELEGRAM ID" : "LIÊN KẾT TELEGRAM"}</b>\n\n` +
      `CTV: <b>${escapeHtml(p.displayName)}</b>${p.telegramId ? `\nTelegram ID hiện tại: <code>${escapeHtml(p.telegramId)}</code>` : ""}\n\n` +
      `Gửi <b>Telegram ID dạng số</b> (4–20 chữ số) của tài khoản Telegram sẽ dùng để đăng nhập /ctv.\nLưu ý: một Telegram ID chỉ dùng cho MỘT CTV.\nGửi /cancel để hủy.`,
    { parse_mode: "HTML" }
  );
});

export async function handlePartnerBindInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (session.wizard?.kind !== "partner_bind") return false;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên đã hết hạn.").catch(() => {});
    return true;
  }
  const partnerId = String(session.wizard.data.partnerId || "");
  const partner = await PartnerService.getPartnerById(partnerId);
  if (!partner) {
    clearWizard(adminId);
    await ctx.reply("❌ Không tìm thấy CTV.").catch(() => {});
    return true;
  }
  const candidate = text.trim();
  if (candidate.startsWith("/")) return true; // /cancel handled elsewhere
  if (!PartnerService.isValidTelegramId(candidate)) {
    await ctx.reply("❌ Telegram ID phải là dãy số (4–20 chữ số). Gửi lại, hoặc /cancel để hủy.").catch(() => {});
    return true;
  }
  // Conflict preview BEFORE confirm (never silently reassign):
  const holder = await PartnerService.getPartnerByTelegramId(candidate);
  if (holder && holder.id !== partnerId) {
    clearWizard(adminId);
    await ctx.reply(
      `❌ <b>Telegram ID đã liên kết với CTV khác.</b>\n\nCTV: ${escapeHtml(holder.displayName)}\nCTV Ref: #${escapeHtml(holder.id.slice(-6).toUpperCase())}\n\nKhông thể gán trùng. Gửi 🔗/🔄 lại để dùng ID khác.`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return true;
  }
  updateWizard(adminId, { data: { candidateTelegramId: candidate } });
  const kb = new InlineKeyboard()
    .text("✅ Confirm", `ops:partner:bind:go:${partnerId}`)
    .text("↩️ Quay lại", `ops:partner:detail:${partnerId}`);
  await ctx.reply(
    `⚠️ <b>XÁC NHẬN LIÊN KẾT TELEGRAM</b>\n\nCTV:\n${escapeHtml(partner.displayName)}\n\nTelegram ID:\n<code>${escapeHtml(candidate)}</code>\n\nReferral:\n<code>${escapeHtml(partner.referralCode)}</code>${partner.telegramId ? `\n\n⚠️ CTV đã liên kết với <code>${escapeHtml(partner.telegramId)}</code> — xác nhận sẽ THAY THẾ.` : ""}`,
    { parse_mode: "HTML", reply_markup: kb }
  );
  return true;
}

adminPartnersHandler.callbackQuery(/^ops:partner:bind:go:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  const candidate = String(session.wizard?.data.candidateTelegramId || "");
  const partnerId = ctx.match?.[1] || "";
  if (!candidate || session.wizard?.data.partnerId !== partnerId) {
    await ctx.reply("⚠️ Không có phiên liên kết hợp lệ.").catch(() => {});
    return;
  }
  try {
    const { rebound, oldTelegramId } = await PartnerService.bindPartnerTelegram(adminId, partnerId, candidate);
    clearWizard(adminId);
    await ctx.reply(
      `✅ <b>${rebound ? "ĐÃ ĐỔI TELEGRAM ID" : "ĐÃ LIÊN KẾT TELEGRAM"}</b>${rebound && oldTelegramId ? `\nCũ: <code>${escapeHtml(oldTelegramId)}</code>` : ""}\nMới: <code>${escapeHtml(candidate)}</code>\n\nCTV giờ có thể dùng /ctv để xem dashboard.`
    ).catch(() => {});
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "Lỗi liên kết")}`).catch(() => {});
  }
});

adminPartnersHandler.callbackQuery("ops:partner:search", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  setAdminSearch(String(ctx.from?.id || ""), "partner");
  await ctx.reply("🔎 <b>Tìm CTV</b>\n\nGửi Telegram ID, mã GT, tên, hoặc Ref #xxxxxx.\nGửi /cancel để hủy.", { parse_mode: "HTML" });
});

/** PART M — partner search resolution (Telegram ID strongest identity). */
export async function runPartnerSearch(ctx: BotContext, query: string): Promise<void> {
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const matches = await PartnerService.searchPartners(query);
  if (matches.length === 0) {
    await ctx.reply("🔎 Không tìm thấy CTV nào khớp.");
    return;
  }
  if (matches.length === 1) {
    await showPartnerDetail(ctx, matches[0]!.id);
    return;
  }
  const lines = [`🔎 <b>Tìm thấy ${matches.length} CTV:</b>`, ""];
  const kb = new InlineKeyboard();
  for (const p of matches) {
    lines.push(...partnerRow(p));
    kb.text(`👤 ${p.displayName}${p.telegramId ? ` · TG ${p.telegramId}` : ""}`, `ops:partner:detail:${p.id}`).row();
  }
  kb.text("⬅️ Danh sách CTV", "ops:partners");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}
adminPartnersHandler.callbackQuery("ops:partner:add", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  startWizard(String(ctx.from?.id || ""), "partner_add", {});
  await ctx.reply("👤 Nhập <b>tên CTV</b> (tối thiểu 2 ký tự).\nGửi /cancel để hủy.", { parse_mode: "HTML" });
});
adminPartnersHandler.callbackQuery(/^ops:partner:detail:([a-zA-Z0-9_-]+)$/, (ctx) => showPartnerDetail(ctx, ctx.match?.[1] || ""));
adminPartnersHandler.callbackQuery(/^ops:partner:toggle:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const p = await PartnerService.getPartnerById(ctx.match?.[1] || "");
  if (!p) return;
  const next = p.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
  await PartnerService.setPartnerStatus(String(ctx.from?.id || ""), p.id, next);
  await showPartnerDetail(ctx, p.id);
});
adminPartnersHandler.callbackQuery(/^ops:partner:release:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  try {
    await PartnerService.releaseCommission(String(ctx.from?.id || ""), ctx.match?.[1] || "");
    await ctx.answerCallbackQuery({ text: "✅ Đã chuyển AVAILABLE." }).catch(() => {});
  } catch (err: any) {
    await ctx.answerCallbackQuery({ text: `❌ ${err?.message || "Lỗi"}`, show_alert: true }).catch(() => {});
  }
});
adminPartnersHandler.callbackQuery(/^ops:partner:settle:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const partnerId = ctx.match?.[1] || "";
  const s = await PartnerService.partnerSummary(partnerId);
  const kb = new InlineKeyboard()
    .text("✅ TẠO ĐỢT TẤT TOÁN", `ops:partner:settle:go:${partnerId}`)
    .row()
    .text("❌ KHÔNG", `ops:partner:detail:${partnerId}`);
  await ctx.reply(
    `💸 <b>XEM TRƯỚC TẤT TOÁN</b>\n\nSố hoa hồng AVAILABLE: <b>${usd(s.available)}</b>\nSau tạo: các hoa hồng vào đợt PENDING; bạn chuyển tiền thật rồi bấm ✅ ĐÃ CHUYỂN để đánh dấu PAID.`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});
adminPartnersHandler.callbackQuery(/^ops:partner:settle:go:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  try {
    const settlement = await PartnerService.createSettlement(String(ctx.from?.id || ""), ctx.match?.[1] || "");
    await ctx.reply(
      `🧾 <b>ĐỢT TẤT TOÁN #${settlement.id.slice(-6)} (PENDING)</b>\n💵 ${usd(settlement.totalUsd)} · ${settlement.itemCount} hoa hồng\n\nChuyển tiền cho CTV, nộp bằng chứng, rồi xác nhận PAID trong chi tiết đợt.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🧾 Mở đợt tất toán", `ops:partner:settlement:detail:${settlement.id}`).row()
      }
    );
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "Lỗi")}`).catch(() => {});
  }
});
adminPartnersHandler.callbackQuery(/^ops:partner:settle:paid:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const settlementId = ctx.match?.[1] || "";
  try {
    // Attach-then-confirm: a PENDING settlement needs the stored payout proof
    // BEFORE Admin confirms PAID. The Admin action itself remains authoritative.
    const existing = await prisma.partnerSettlement.findUnique({ where: { id: settlementId } });
    if (existing && existing.status !== "PAID" && !existing.payoutProofFileId) {
      await ctx.reply(
        `⚠️ <b>Chưa có bằng chứng chuyển tiền.</b>\nNộp ảnh/PDF bằng chứng trong chi tiết đợt tất toán trước khi xác nhận PAID.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🧾 Mở đợt tất toán", `ops:partner:settlement:detail:${settlementId}`) }
      );
      return;
    }
    const settlement = await PartnerService.markSettlementPaid(String(ctx.from?.id || ""), settlementId);
    const notify = await notifyPartnerSettlementPaid(settlement.id);
    await ctx.reply(
      `✅ <b>ĐỢT TẤT TOÁN PAID</b>\n💵 ${usd(settlement.totalUsd)} · ${settlement.itemCount} hoa hồng → PAID (audit ghi nhận).\n📩 Thông báo + bằng chứng cho CTV: ${notify.sent ? "✅ đã gửi" : `⚠️ chưa gửi (${notify.reason || "lỗi"})`}`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "Lỗi")}`).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PART J3 — Settlement detail: FROZEN destination snapshot, frozen payout QR,
// and Admin payout proof (image/PDF). The current live Partner payout fields
// are NEVER rendered as belonging to an old settlement.
// ---------------------------------------------------------------------------
function renderDestinationSnapshotText(snap: any): string {
  if (!snap) return "(không có)";
  const text = String(snap.text || "").trim();
  if (!text) return "(không có)";
  return escapeHtml(text.length > 400 ? `${text.slice(0, 400)}…` : text);
}

export async function showSettlementDetail(ctx: BotContext, settlementId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const s = await prisma.partnerSettlement.findUnique({ where: { id: settlementId }, include: { partner: true } });
  if (!s) {
    await ctx.reply("❌ Không tìm thấy đợt tất toán.").catch(() => {});
    return;
  }
  const snap = s.payoutDestinationSnapshot as any;
  const lines = [
    `🧾 <b>ĐỢT TẤT TOÁN #${s.id.slice(-6)}</b> · ${s.status === "PAID" ? "✅ PAID" : "⏳ PENDING"}`,
    `💵 <b>${usd(s.totalUsd)}</b> · ${s.itemCount} hoa hồng`,
    `👤 CTV: ${escapeHtml(s.partner?.displayName || "")}`,
    `🕒 Tạo: ${formatAdminDateTime(s.createdAt)} · bởi ${escapeHtml(s.createdBy)}${s.paidAt ? ` · PAID: ${formatAdminDateTime(s.paidAt)}` : ""}`,
    "",
    `💳 <b>Thông tin nhận hoa hồng (đóng băng lúc tạo):</b>`,
    renderDestinationSnapshotText(snap),
    `🖼 QR nhận tiền: ${snap?.qrFileId ? "✅ có" : "— không"}`,
    `🧾 Bằng chứng chuyển tiền: ${s.payoutProofFileId ? "✅ có" : "— chưa có"}`,
    "",
    "<i>Bằng chứng chỉ mang tính tham khảo — thao tác ✅ XÁC NHẬN ĐÃ CHUYỂN của Admin mới là xác nhận chính thức.</i>"
  ];
  const kb = new InlineKeyboard();
  if (snap?.qrFileId) kb.text("🖼 QR nhận tiền", `ops:partner:settlement:qr:${s.id}`).row();
  if (s.payoutProofFileId) kb.text("🧾 Xem bằng chứng CK", `ops:partner:settlement:proof:${s.id}`).row();
  if (s.status !== "PAID") {
    kb.text("📎 Nộp bằng chứng CK", `ops:partner:settlement:proofupload:${s.id}`).row();
    kb.text("✅ XÁC NHẬN ĐÃ CHUYỂN", `ops:partner:settle:paid:${s.id}`).row();
  }
  kb.text("⬅️ Lịch sử thanh toán", `ops:partner:settlements:${s.partnerId}`).row();
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

/** Send one stored FileEvidence: image → photo, PDF/other → document. */
async function sendEvidence(ctx: BotContext, evidenceId: string | null | undefined, caption: string): Promise<boolean> {
  if (!evidenceId) return false;
  const evidence = await prisma.fileEvidence.findUnique({ where: { id: evidenceId } });
  const buffer = evidence?.filePath ? await FileService.getFile(evidence.filePath) : null;
  if (!buffer || buffer.length === 0) {
    await ctx.reply("⚠️ Không đọc được tệp đã lưu (có thể đã bị xóa khỏi lưu trữ).").catch(() => {});
    return false;
  }
  const file = new InputFile(buffer, evidence!.fileName || `evidence_${evidenceId}`);
  if (String(evidence!.mimeType || "").startsWith("image/")) {
    await ctx.replyWithPhoto(file, { caption, parse_mode: "HTML" });
  } else {
    await ctx.replyWithDocument(file, { caption, parse_mode: "HTML" });
  }
  return true;
}

export async function viewSettlementQr(ctx: BotContext, settlementId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const s = await prisma.partnerSettlement.findUnique({ where: { id: settlementId } });
  if (!s) return;
  const snap = s.payoutDestinationSnapshot as any;
  await sendEvidence(ctx, snap?.qrFileId ?? null, "🖼 QR nhận tiền CTV (đóng băng lúc tạo đợt tất toán).");
}

export async function viewSettlementProof(ctx: BotContext, settlementId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const s = await prisma.partnerSettlement.findUnique({ where: { id: settlementId } });
  if (!s) return;
  await sendEvidence(ctx, s.payoutProofFileId, "🧾 Bằng chứng chuyển tiền hoa hồng (tham khảo — Admin xác nhận PAID mới là chính thức).");
}

export async function viewPartnerPayoutQr(ctx: BotContext, partnerId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const p = await PartnerService.getPartnerById(partnerId);
  if (!p) return;
  await sendEvidence(ctx, p.payoutQrFileId ?? null, "🖼 Ảnh QR nhận hoa hồng của CTV (tham khảo — Admin xem thủ công).");
}

export async function armSettlementProofUpload(ctx: BotContext, settlementId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const adminId = String(ctx.from?.id || "");
  const s = await prisma.partnerSettlement.findUnique({ where: { id: settlementId } });
  if (!s) {
    await ctx.reply("❌ Không tìm thấy đợt tất toán.").catch(() => {});
    return;
  }
  if (s.status === "PAID") {
    await ctx.reply("⚠️ Đợt này đã PAID — không thể nộp thêm bằng chứng.").catch(() => {});
    return;
  }
  startWizard(adminId, "settlement_proof", { settlementId });
  await ctx.reply(
    "📎 <b>NỘP BẰNG CHỨNG CHUYỂN TIỀN</b>\n\nGửi <b>ảnh hoặc PDF</b> bằng chứng chuyển tiền cho CTV vào khung chat.\n\n<i>Chỉ lưu tham khảo — không tự động xác nhận PAID.</i>\n\nGửi /cancel để hủy.",
    { parse_mode: "HTML" }
  );
}



/** Router-level Admin media intake for the settlement payout-proof wizard. */
export async function handleSettlementProofMedia(ctx: BotContext): Promise<boolean> {
  try {
    return await runSettlementProofMediaFlow(ctx);
  } catch (err: any) {
    logger.error({ err: err?.message }, "Settlement proof: unexpected failure during media intake");
    await ctx.reply(
      `❌ Có lỗi khi xử lý bằng chứng: ${escapeHtml(err?.message || "lỗi không xác định")}.\nVui lòng thử lại, hoặc /cancel để hủy.`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return true;
  }
}

async function runSettlementProofMediaFlow(ctx: BotContext): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (!session.wizard || session.wizard.kind !== "settlement_proof") return false;
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return true;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⌛️ Phiên đã hết hạn. Mở lại từ chi tiết đợt tất toán.").catch(() => {});
    return true;
  }
  const settlementId = String(session.wizard.data.settlementId || "");
  const settlement = await prisma.partnerSettlement.findUnique({ where: { id: settlementId } });
  if (!settlement) {
    clearWizard(adminId);
    await ctx.reply("❌ Không tìm thấy đợt tất toán.").catch(() => {});
    return true;
  }
  if (settlement.status === "PAID") {
    clearWizard(adminId);
    await ctx.reply("⚠️ Đợt này đã PAID — không thể nộp thêm bằng chứng.").catch(() => {});
    return true;
  }

  const MAX_BYTES = (env.MAX_UPLOAD_MB || 10) * 1024 * 1024;
  const photo = ctx.message?.photo?.length ? ctx.message.photo[ctx.message.photo.length - 1] : undefined;
  const doc = ctx.message?.document;
  if (!photo && !doc) {
    await ctx.reply("📎 Vui lòng gửi <b>ảnh hoặc PDF</b> bằng chứng, hoặc /cancel để hủy.", { parse_mode: "HTML" }).catch(() => {});
    return true;
  }
  if (doc?.file_size && doc.file_size > MAX_BYTES) {
    await ctx.reply(`⚠️ Tệp quá lớn (giới hạn ${env.MAX_UPLOAD_MB || 10}MB).`).catch(() => {});
    return true;
  }
  if (doc?.mime_type && !(doc.mime_type.startsWith("image/") || doc.mime_type === "application/pdf")) {
    await ctx.reply("❌ Vui lòng gửi <b>ảnh hoặc PDF</b> bằng chứng.").catch(() => {});
    return true;
  }

  try {
    const fileId = photo ? photo.file_id : doc!.file_id;
    const file = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tải tệp thất bại (HTTP ${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer || buffer.length === 0 || buffer.length > MAX_BYTES) {
      await ctx.reply("❌ Tệp không hợp lệ hoặc quá lớn.").catch(() => {});
      return true;
    }
    const mimeType = String(doc?.mime_type || res.headers.get("content-type") || "application/octet-stream");
    const ext = mimeType === "application/pdf" ? ".pdf" : mimeType === "image/png" ? ".png" : ".jpg";
    const evidence = await FileService.saveEvidenceFile(
      buffer,
      `settlement_proof_${settlementId}_${Date.now()}${ext}`,
      "PAYOUT_BILL",
      mimeType
    );
    await PartnerService.uploadSettlementProof(settlementId, evidence.id, adminId);
    clearWizard(adminId);
    await ctx.reply(
      `✅ <b>ĐÃ LƯU BẰNG CHỨNG CHUYỂN TIỀN</b>\n🧾 Đợt #${settlementId.slice(-6)} — vẫn PENDING cho tới khi bạn bấm ✅ XÁC NHẬN ĐÃ CHUYỂN.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🧾 Mở đợt tất toán", `ops:partner:settlement:detail:${settlementId}`).row() }
    );
  } catch (err: any) {
    // Wizard stays armed so Admin can simply resend.
    await ctx.reply(`❌ Không lưu được bằng chứng: ${escapeHtml(err?.message || "lỗi")}`).catch(() => {});
  }
  return true;
}

adminPartnersHandler.callbackQuery(/^ops:partner:settlement:detail:([a-zA-Z0-9_-]+)$/, (ctx) => showSettlementDetail(ctx, ctx.match?.[1] || ""));
adminPartnersHandler.callbackQuery(/^ops:partner:settlement:qr:([a-zA-Z0-9_-]+)$/, (ctx) => viewSettlementQr(ctx, ctx.match?.[1] || ""));
adminPartnersHandler.callbackQuery(/^ops:partner:settlement:proof:([a-zA-Z0-9_-]+)$/, (ctx) => viewSettlementProof(ctx, ctx.match?.[1] || ""));
adminPartnersHandler.callbackQuery(/^ops:partner:settlement:proofupload:([a-zA-Z0-9_-]+)$/, (ctx) => armSettlementProofUpload(ctx, ctx.match?.[1] || ""));
adminPartnersHandler.callbackQuery(/^ops:partner:payoutqr:([a-zA-Z0-9_-]+)$/, (ctx) => viewPartnerPayoutQr(ctx, ctx.match?.[1] || ""));
