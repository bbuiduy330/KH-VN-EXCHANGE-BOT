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
import { startWizard, getAdminSession, isSessionExpired, clearWizard } from "./admin-session.js";
import { getBotInstance } from "../notifications.js";

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
      lines.push(
        `👤 ${escapeHtml(p.displayName)} · ${p.status === "ACTIVE" ? "🟢" : "⛔"} · code <code>${p.referralCode}</code>`,
        `   💵 HELD ${usd(s.held)} · AVAIL ${usd(s.available)} · PAID ${usd(s.paid)}`
      );
      kb.text(`👤 ${p.displayName}`, `ops:partner:detail:${p.id}`).row();
    }
  }
  kb.text("➕ Thêm CTV", "ops:partner:add").row().text("🏠 Menu Admin", "ops:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
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

  kb.text(p.status === "ACTIVE" ? "⛔ Vô hiệu hoá" : "🟢 Kích hoạt", `ops:partner:toggle:${p.id}`)
    .row()
    .text("💸 Tất toán AVAILABLE", `ops:partner:settle:${p.id}`)
    .row()
    .text("⬅️ Danh sách CTV", "ops:partners")
    .text("🏠 Menu Admin", "ops:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
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
