/**
 * Admin Partner/CTV panel (X). Permission-separated from financial actions:
 * uses "staff.manage" so CSKH never reaches partner management.
 * NO customer data is shown here (only aggregates + partner-owned payout
 * metadata the Admin needs to pay the partner).
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requireRole } from "../middleware/permissions.js";
import { PartnerService } from "../../modules/partner/partner-service.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { startWizard, getAdminSession, isSessionExpired, clearWizard, updateWizard } from "./admin-session.js";
import { setAdminSearch } from "./admin-session.js";
import { getBotInstance } from "../notifications.js";
import { formatAdminDateTime } from "../../shared/app-time.js";

export const adminPartnersHandler = new Composer<BotContext>();

const usd = (d: any): string => `$${Number(d ?? 0).toFixed(2)}`;

function partnerLink(partner: any): string {
  const me = (getBotInstance() as any)?.botInfo?.username as string | undefined;
  return me ? `https://t.me/${me}?start=${PartnerService.referralPayload(partner)}` : "";
}

async function showPartners(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  // 2 — belt-and-braces: opening the panel reconciles missing commissions and
  // materialises HELD→AVAILABLE (idempotent, DB-derived, audited).
  await PartnerService.reconcileAvailableCommissions().catch(() => {});
  await PartnerService.reconcileMissingCommissions().catch(() => {});
  const partners = await PartnerService.listPartners();
  const lines = ["🤝 <b>CỘNG TÁC VIÊN (CTV)</b>", ""];
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
    return [`🟢 ${escapeHtml(p.displayName)} · TG <code>${escapeHtml(p.telegramId)}</code>`, `Ref: <code>#${escapeHtml(p.id.slice(-6))}</code>`, `Mã GT: <code>${escapeHtml(p.referralCode)}</code>`];
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
    p.payoutBankName ? `🏦 Chi trả cho CTV: ${escapeHtml(p.payoutBankName)} ••••${escapeHtml(String(p.payoutAccountNumber || "").slice(-4))} — ${escapeHtml(p.payoutAccountName || "")}` : "🏦 CTV chưa nộp thông tin chi trả",
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
    .row()
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
  if (settlements.length === 0) {
    lines.push("Chưa có đợt thanh toán nào.");
  } else {
    for (const s of settlements) {
      lines.push(
        `${s.status === "PAID" ? "✅" : "⏳"} ${formatAdminDateTime(s.createdAt)} · ${usd(s.totalUsd)} · ${s.itemCount} hoa hồng · ${s.status} · bởi ${s.createdBy}`
      );
    }
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ Chi tiết CTV", `ops:partner:detail:${partnerId}`) });
}

/** Commission list (💰) — safe business references only. */
async function showPartnerCommissions(ctx: BotContext, partnerId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const commissions = await PartnerService.listPartnerCommissions(partnerId, 15);
  const lines = ["💰 <b>HOA HỒNG GẦN NHẤT</b> (khách hàng được ẩn)", ""];
  if (commissions.length === 0) {
    lines.push("Chưa có hoa hồng nào.");
  } else {
    for (const c of commissions) {
      const st = PartnerService.effectiveStatus(c);
      lines.push(`${formatAdminDateTime(c.createdAt)} · Giao dịch #${c.orderId.slice(-6)} · ${usd(c.totalUsd)} · ${st}${c.riskFlag ? ` · ⚠️ ${c.riskFlag}` : ""}`);
    }
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ Chi tiết CTV", `ops:partner:detail:${partnerId}`) });
}

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
adminPartnersHandler.callbackQuery(/^ops:partner:commissions:([a-zA-Z0-9_-]+)$/, (ctx) => showPartnerCommissions(ctx, ctx.match?.[1] || ""));
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
      `❌ <b>Telegram ID đã liên kết với CTV khác.</b>\n\nCTV: ${escapeHtml(holder.displayName)}\nRef: #${escapeHtml(holder.id.slice(-6))}\n\nKhông thể gán trùng. Gửi 🔗/🔄 lại để dùng ID khác.`,
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
      `🧾 <b>ĐỢT TẤT TOÁN #${settlement.id.slice(-6)} (PENDING)</b>\n💵 ${usd(settlement.totalUsd)} · ${settlement.itemCount} hoa hồng\n\nChuyển tiền cho CTV rồi bấm ✅ ĐÃ CHUYỂN.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("✅ ĐÃ CHUYỂN", `ops:partner:settle:paid:${settlement.id}`).row()
      }
    );
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "Lỗi")}`).catch(() => {});
  }
});
adminPartnersHandler.callbackQuery(/^ops:partner:settle:paid:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  try {
    const settlement = await PartnerService.markSettlementPaid(String(ctx.from?.id || ""), ctx.match?.[1] || "");
    await ctx.reply(`✅ <b>ĐỢT TẤT TOÁN PAID</b>\n💵 ${usd(settlement.totalUsd)} · ${settlement.itemCount} hoa hồng → PAID (audit ghi nhận).`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "Lỗi")}`).catch(() => {});
  }
});
