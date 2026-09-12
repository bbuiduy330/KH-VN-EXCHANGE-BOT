/**
 * Broadcast Center (Part C) — ADMIN / SUPER_ADMIN only.
 * 📣 Chăm sóc khách hàng: audiences (all / filter / list / one), composer,
 * preview + test-send (never mass-sends), explicit confirm, durable delivery
 * via BroadcastService, and campaign history. CTV/CSKH never reach this
 * composer (role-gated).
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requireRole } from "../middleware/permissions.js";
import { prisma } from "../../database/client.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { clearWizard, getAdminSession, isSessionExpired, startWizard, updateWizard } from "./admin-session.js";
import {
  BROADCAST_CTA_BUTTONS,
  BroadcastAudienceFilter,
  BroadcastAudienceType,
  BroadcastContent,
  cancelCampaign,
  confirmCampaign,
  countEligible,
  createCampaign,
  listCampaigns,
  renderBroadcastText,
  sendTestToAdmin
} from "../../modules/broadcast/broadcast-service.js";
import { MoneyService } from "../../modules/money/money-service.js";
import { formatAdminDateTime } from "../../shared/app-time.js";
import { shortCustomerId } from "./admin-panel.js";

export const adminBroadcastHandler = new Composer<BotContext>();

function composerSession(ctx: BotContext): any | null {
  const session = getAdminSession(String(ctx.from?.id || ""));
  if (!session.wizard || session.wizard.kind !== "broadcast_compose") return null;
  return session.wizard;
}

async function eligibleCount(data: any): Promise<number> {
  try {
    const ids = data.audienceType === "ONE_CUSTOMER" || data.audienceType === "LIST"
      ? data.selectedIds || []
      : undefined;
    return await countEligible(data.audienceType as BroadcastAudienceType, data.filter || null, ids);
  } catch {
    return 0;
  }
}

function audienceLabel(data: any): string {
  switch (data.audienceType) {
    case "ALL": return "👥 Tất cả khách đủ điều kiện";
    case "FILTER": return "🎯 Nhóm khách theo bộ lọc";
    case "LIST": return `☑️ Chọn từ danh sách (${(data.selectedIds || []).length} đã chọn)`;
    case "ONE_CUSTOMER": return "👤 Một khách cụ thể";
    default: return String(data.audienceType || "");
  }
}

function describeFilter(f: BroadcastAudienceFilter | null | undefined): string {
  if (!f) return "—";
  const parts: string[] = [];
  if (f.locale) parts.push(`Ngôn ngữ: ${f.locale.toUpperCase()}`);
  if (f.hasCompletedOrder) parts.push("Đã có giao dịch hoàn tất");
  if (f.directionUsdToVnd) parts.push("Chiều USD → VND");
  if (f.directionVndToUsd) parts.push("Chiều VND → USD");
  if (f.activity === "LAST_7D") parts.push("Hoạt động 7 ngày qua");
  if (f.activity === "LAST_30D") parts.push("Hoạt động 30 ngày qua");
  if (f.activity === "LAST_90D") parts.push("Hoạt động 90 ngày qua");
  if (f.activity === "INACTIVE_30D") parts.push("Ngừng hoạt động > 30 ngày");
  if (f.excludeRisk) parts.push("Loại SUSPICIOUS");
  return parts.length ? parts.join(" · ") : "—";
}

function contentSummary(content: BroadcastContent): string {
  const bits: string[] = [];
  if (content.text) bits.push(`✍️ Text: <code>${escapeHtml(content.text.slice(0, 120))}${content.text.length > 120 ? "…" : ""}</code>`);
  if (content.photoFileId) bits.push(`🖼 Ảnh: ✅${content.caption ? ` (caption: <code>${escapeHtml(content.caption.slice(0, 80))}</code>)` : ""}`);
  bits.push(`🔘 CTA: ${content.cta ? "Bật (Đổi tiền ngay / Hỗ trợ)" : "Tắt"}`);
  return bits.join("\n");
}

async function replyWithMenu(ctx: BotContext, text: string, kb: InlineKeyboard): Promise<void> {
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function showBroadcastMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const lines = [
    "📣 <b>CHĂM SÓC KHÁCH HÀNG</b>",
    "",
    "Gửi thông báo cho khách Telegram đã tương tác với bot.",
    "<i>Khách đã tắt 🔔 Thông báo ưu đãi hoặc không thể nhận tin sẽ bị loại tự động.</i>"
  ];
  const kb = new InlineKeyboard()
    .text("👥 Tất cả khách", "ops:broadcast:all")
    .text("🎯 Chọn nhóm khách", "ops:broadcast:filter")
    .row()
    .text("☑️ Chọn từ danh sách", "ops:broadcast:list")
    .text("👤 Gửi 1 khách", "ops:broadcast:one")
    .row()
    .text("🕘 Lịch sử gửi", "ops:broadcast:history")
    .row()
    .text("🏠 Menu Admin", "ops:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

function newComposeSession(adminId: string, data: Record<string, any>): void {
  startWizard(adminId, "broadcast_compose", { page: 0, ...data });
}

export async function startComposeAll(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  newComposeSession(String(ctx.from?.id || ""), { audienceType: "ALL", content: {} });
  await showComposer(ctx);
}

export async function startComposeFilter(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  newComposeSession(String(ctx.from?.id || ""), { audienceType: "FILTER", filter: {}, content: {}, stage: "filter" });
  await showFilterBuilder(ctx);
}

export async function startComposeList(ctx: BotContext, page: number = 0): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const adminId = String(ctx.from?.id || "");
  const w = composerSession(ctx);
  if (!w || w.data.audienceType !== "LIST") {
    newComposeSession(adminId, { audienceType: "LIST", selectedIds: [], page, content: {}, stage: "list" });
  } else {
    updateWizard(adminId, { data: { page } });
  }
  await showListSelection(ctx);
}

export async function startComposeOne(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  newComposeSession(String(ctx.from?.id || ""), {
    audienceType: "ONE_CUSTOMER", stage: "awaiting_tg", content: {}, selectedIds: []
  });
  await ctx.reply(
    "👤 <b>GỬI 1 KHÁCH</b>\n\nNhập <b>số Telegram ID</b> của khách:\n\nGửi /cancel để hủy.",
    { parse_mode: "HTML" }
  );
}

export async function startOneCustomerPreset(ctx: BotContext, customerId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    await ctx.reply("❌ Không tìm thấy khách.").catch(() => {});
    return;
  }
  newComposeSession(String(ctx.from?.id || ""), {
    audienceType: "ONE_CUSTOMER",
    stage: "compose",
    content: {},
    selectedIds: [customerId]
  });
  await showComposer(ctx);
}

export async function startComposeRatePrefill(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const usdVnd = await prisma.exchangeRate.findUnique({ where: { pair: "USD/VND" } });
  let rateLine = "Tỷ giá hiện tại: (chưa cấu hình — hãy sửa trước khi gửi)";
  if (usdVnd) {
    const eff = MoneyService.calculateEffectiveRates(usdVnd.baseRate, usdVnd.buyMargin, usdVnd.sellMargin);
    rateLine =
      `💱 Tỷ giá hôm nay:\n` +
      `USD → VND: <b>${MoneyService.formatAmount(eff.effectiveBuy, "VND")} VND</b>\n` +
      `VND → USD: <b>${MoneyService.formatAmount(eff.effectiveSell, "VND")} VND</b>`;
  }
  newComposeSession(String(ctx.from?.id || ""), {
    audienceType: "ALL",
    content: { text: rateLine, cta: true }
  });
  await showComposer(ctx);
}


// --- Filter builder ---------------------------------------------------------
export async function showFilterBuilder(ctx: BotContext): Promise<void> {
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const adminId = String(ctx.from?.id || "");
  const w = composerSession(ctx);
  if (!w || w.data.audienceType !== "FILTER") {
    newComposeSession(adminId, { audienceType: "FILTER", filter: {}, content: {}, stage: "filter" });
  } else {
    updateWizard(adminId, { data: { stage: "filter" } });
  }
  const f: BroadcastAudienceFilter = (getAdminSession(adminId).wizard as any).data.filter || {};
  const localeLabel = f.locale ? f.locale.toUpperCase() : "—";
  const dir = f.directionUsdToVnd ? "USD → VND" : f.directionVndToUsd ? "VND → USD" : "—";
  const act = f.activity === "LAST_7D" ? "7 ngày" : f.activity === "LAST_30D" ? "30 ngày" : f.activity === "LAST_90D" ? "90 ngày" : f.activity === "INACTIVE_30D" ? "> 30 ngày" : "—";
  const lines = [
    "🎯 <b>CHỌN NHÓM KHÁCH</b>",
    "",
    `🌐 Ngôn ngữ: <b>${localeLabel}</b>`,
    `🔁 Chiều giao dịch: <b>${dir}</b>`,
    `✅ Chỉ khách có đơn hoàn tất: <b>${f.hasCompletedOrder ? "BẬT" : "TẮT"}</b>`,
    `🕒 Hoạt động: <b>${act}</b>`,
    `🚨 Loại SUSPICIOUS: <b>${f.excludeRisk ? "BẬT" : "TẮT"}</b>`
  ];
  const kb = new InlineKeyboard()
    .text("🌐 Ngôn ngữ", "ops:bcast:f:locmenu")
    .text("🔁 Chiều", "ops:bcast:f:dirmenu")
    .row()
    .text("🕒 Hoạt động", "ops:bcast:f:actmenu")
    .text(`✅ Đơn hoàn tất: ${f.hasCompletedOrder ? "BẬT" : "TẮT"}`, "ops:bcast:f:cmpl")
    .row()
    .text(`🚨 Loại SUSPICIOUS: ${f.excludeRisk ? "BẬT" : "TẮT"}`, "ops:bcast:f:risk")
    .row()
    .text("✅ Xong → Soạn nội dung", "ops:bcast:f:apply")
    .row()
    .text("❌ Hủy", "ops:bcast:cancel")
    .text("🏠 Menu Admin", "ops:home");
  await replyWithMenu(ctx, lines.join("\n"), kb);
}

function filterSubmenuKeyboard(kind: "loc" | "dir" | "act"): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (kind === "loc") {
    kb.text("🇻🇳 VI", "ops:bcast:f:loc:vi").text("🇬🇧 EN", "ops:bcast:f:loc:en").row();
    kb.text("🇰🇭 KM", "ops:bcast:f:loc:km").text("🇨🇳 ZH", "ops:bcast:f:loc:zh").row();
    kb.text("— Bỏ lọc", "ops:bcast:f:loc:off");
  } else if (kind === "dir") {
    kb.text("USD → VND", "ops:bcast:f:dir:usd2vnd").text("VND → USD", "ops:bcast:f:dir:vnd2usd").row();
    kb.text("— Bỏ lọc", "ops:bcast:f:dir:off");
  } else {
    kb.text("7 ngày", "ops:bcast:f:act:LAST_7D").text("30 ngày", "ops:bcast:f:act:LAST_30D").row();
    kb.text("90 ngày", "ops:bcast:f:act:LAST_90D").text("Ngừng > 30 ngày", "ops:bcast:f:act:INACTIVE_30D").row();
    kb.text("— Bỏ lọc", "ops:bcast:f:act:off");
  }
  kb.row().text("⬅️ Bộ lọc", "ops:broadcast:filter");
  return kb;
}

export async function showFilterSubmenu(ctx: BotContext, kind: "loc" | "dir" | "act"): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  await replyWithMenu(ctx, "🎯 <b>Chọn giá trị lọc</b>", filterSubmenuKeyboard(kind));
}

export async function applyFilterToggle(ctx: BotContext, kind: string, value: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const adminId = String(ctx.from?.id || "");
  const w = composerSession(ctx);
  if (!w) return;
  const f: BroadcastAudienceFilter = { ...(w.data.filter || {}) };
  if (kind === "loc") f.locale = value === "off" ? null : (value as any);
  else if (kind === "dir") {
    f.directionUsdToVnd = value === "usd2vnd";
    f.directionVndToUsd = value === "vnd2usd";
    if (value === "off") { f.directionUsdToVnd = false; f.directionVndToUsd = false; }
  } else if (kind === "act") {
    f.activity = value === "off" ? null : (value as any);
  } else if (kind === "cmpl") {
    f.hasCompletedOrder = !f.hasCompletedOrder;
  } else if (kind === "risk") {
    f.excludeRisk = !f.excludeRisk;
  }
  updateWizard(adminId, { data: { filter: f } });
  await showFilterBuilder(ctx);
}


// --- List selection ---------------------------------------------------------
async function showListSelection(ctx: BotContext): Promise<void> {
  const adminId = String(ctx.from?.id || "");
  const w = getAdminSession(adminId).wizard as any;
  const page = Math.max(0, Number(w.data.page || 0));
  const selected: string[] = w.data.selectedIds || [];
  const customers: any[] = await prisma.customer.findMany({
    orderBy: { createdAt: "desc" },
    skip: page * 10,
    take: 10
  });
  const lines = [
    "☑️ <b>CHỌN KHÁCH TỪ DANH SÁCH</b>",
    "",
    `Đã chọn: <b>${selected.length}</b>`,
    ...customers.map((c) => {
      const mark = selected.includes(c.id) ? "☑️" : "⬜️";
      return `${mark} ${escapeHtml(c.fullName || c.username || "Khách")} · 🆔 <code>${escapeHtml(c.telegramId || "")}</code> · 🔖 <code>${shortCustomerId(c)}</code>`;
    })
  ];
  const kb = new InlineKeyboard();
  for (const c of customers) {
    const mark = selected.includes(c.id) ? "☑️" : "⬜️";
    kb.text(`${mark} ${(c.fullName || c.username || "Khách").slice(0, 20)}`, `ops:bcast:sel:${c.id}`).row();
  }
  kb.text("⬅️ Trước", `ops:bcast:sel:page:${Math.max(0, page - 1)}`)
    .text("Sau ➡️", `ops:bcast:sel:page:${page + 1}`)
    .row();
  kb.text("✅ Xong → Soạn nội dung", "ops:bcast:sel:done").row();
  kb.text("❌ Hủy", "ops:bcast:cancel").text("🏠 Menu Admin", "ops:home");
  await replyWithMenu(ctx, lines.join("\n"), kb);
}

export async function toggleListSelection(ctx: BotContext, customerId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const adminId = String(ctx.from?.id || "");
  const w = composerSession(ctx);
  if (!w) return;
  const selected: string[] = [...(w.data.selectedIds || [])];
  const idx = selected.indexOf(customerId);
  if (idx >= 0) selected.splice(idx, 1);
  else selected.push(customerId);
  updateWizard(adminId, { data: { selectedIds: selected } });
  await showListSelection(ctx);
}

// --- Composer ---------------------------------------------------------------
export async function showComposer(ctx: BotContext): Promise<void> {
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const adminId = String(ctx.from?.id || "");
  const w = composerSession(ctx);
  if (!w) return;
  updateWizard(adminId, { data: { stage: "compose" } });
  const data = (getAdminSession(adminId).wizard as any).data;
  const content: BroadcastContent = data.content || {};
  const count = await eligibleCount(data);
  const lines = [
    "📝 <b>SOẠN THÔNG BÁO</b>",
    "",
    `👥 Nhóm: <b>${escapeHtml(audienceLabel(data))}</b>`,
    data.audienceType === "FILTER" ? `🎛 Bộ lọc: <b>${escapeHtml(describeFilter(data.filter))}</b>` : "",
    `🔢 Khách đủ điều kiện: <b>${count}</b>`,
    "",
    contentSummary(content),
    "",
    "<i>Kiểm tra bằng Gửi thử trước khi Xác nhận gửi.</i>"
  ];
  const kb = new InlineKeyboard()
    .text("✍️ Nhập nội dung", "ops:bcast:text")
    .text("🖼 Gửi ảnh", "ops:bcast:photo")
    .row()
    .text(`🔘 CTA: ${content.cta ? "BẬT" : "TẮT"}`, "ops:bcast:cta")
    .row()
    .text("👁 Gửi thử cho Admin", "ops:bcast:test")
    .row()
    .text("✅ XÁC NHẬN GỬI", "ops:bcast:confirm")
    .row()
    .text("❌ Hủy", "ops:bcast:cancel")
    .text("🏠 Menu Admin", "ops:home");
  await replyWithMenu(ctx, lines.filter(Boolean).join("\n"), kb);
}

export async function toggleCta(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const adminId = String(ctx.from?.id || "");
  const w = composerSession(ctx);
  if (!w) return;
  const content: BroadcastContent = { ...(w.data.content || {}) };
  content.cta = !content.cta;
  updateWizard(adminId, { data: { content } });
  await showComposer(ctx);
}

export async function promptText(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const adminId = String(ctx.from?.id || "");
  const w = composerSession(ctx);
  if (!w) return;
  updateWizard(adminId, { data: { stage: "text" } });
  await ctx.reply(
    "✍️ Gửi <b>nội dung thông báo</b> (HTML được hỗ trợ):\n\nGửi /cancel để hủy.",
    { parse_mode: "HTML" }
  );
}

export async function promptPhoto(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const adminId = String(ctx.from?.id || "");
  const w = composerSession(ctx);
  if (!w) return;
  updateWizard(adminId, { data: { stage: "photo" } });
  await ctx.reply(
    "🖼 Gửi <b>ảnh</b> (caption sẽ làm nội dung đính kèm ảnh):\n\nGửi /cancel để hủy.",
    { parse_mode: "HTML" }
  );
}

export async function cancelCompose(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  clearWizard(String(ctx.from?.id || ""));
  await ctx.reply("❌ Đã hủy soạn thông báo.").catch(() => {});
}


/** Composer text intake: "one customer" stage resolves the target, otherwise text. */
export async function handleBroadcastComposerText(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (session.wizard?.kind !== "broadcast_compose") return false;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⌛️ Phiên đã hết hạn. Mở lại từ 📣 Chăm sóc khách hàng.").catch(() => {});
    return true;
  }
  const data = session.wizard.data as any;
  const content: BroadcastContent = { ...(data.content || {}) };

  if (data.stage === "awaiting_tg") {
    const tg = text.trim();
    const customer = await prisma.customer.findUnique({ where: { telegramId: tg } });
    if (!customer) {
      await ctx.reply("❌ Không tìm thấy khách với Telegram ID này. Gửi lại hoặc /cancel.").catch(() => {});
      return true;
    }
    if (customer.marketingEnabled === false) {
      await ctx.reply("🔕 Khách này đã TẮT 🔔 Thông báo ưu đãi — không thể gửi broadcast. Gửi /cancel.").catch(() => {});
      return true;
    }
    if (customer.telegramReachable === false) {
      await ctx.reply("🚫 Khách này được đánh dấu KHÔNG thể nhận tin (blocked). Gửi /cancel.").catch(() => {});
      return true;
    }
    updateWizard(adminId, { data: { selectedIds: [customer.id], stage: "compose" } });
    await showComposer(ctx);
    return true;
  }

  // Default: the text becomes the message content.
  const cleaned = String(text || "").trim();
  if (!cleaned) {
    await ctx.reply("⚠️ Nội dung trống. Gửi lại hoặc /cancel.").catch(() => {});
    return true;
  }
  if (cleaned.length > 3500) {
    await ctx.reply("⚠️ Nội dung quá dài (tối đa 3500 ký tự).").catch(() => {});
    return true;
  }
  content.text = cleaned;
  updateWizard(adminId, { data: { content, stage: "compose" } });
  await showComposer(ctx);
  return true;
}

/** Composer photo intake (called from the Admin photo router). */
export async function handleBroadcastComposerPhoto(ctx: BotContext): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (!session.wizard || session.wizard.kind !== "broadcast_compose") return false;
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return true;
  const photo = ctx.message?.photo?.length ? ctx.message.photo[ctx.message.photo.length - 1] : undefined;
  const doc = (ctx.message as any)?.document as any;
  const fileId = photo ? photo.file_id : doc?.file_id;
  if (!fileId) {
    await ctx.reply("📷 Vui lòng gửi ảnh, hoặc /cancel để hủy.").catch(() => {});
    return true;
  }
  const content: BroadcastContent = { ...(session.wizard.data.content || {}) };
  content.photoFileId = fileId;
  content.caption = String(ctx.message?.caption || content.caption || "").slice(0, MAX_CONTENT_CAPTION_LEN);
  updateWizard(adminId, { data: { content, stage: "compose" } });
  await showComposer(ctx);
  return true;
}

export async function testSendComposer(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const w = composerSession(ctx);
  if (!w) return;
  const content: BroadcastContent = w.data.content || {};
  try {
    await sendTestToAdmin(String(ctx.from?.id || ""), content);
    await ctx.reply("✅ Đã gửi THỬ cho bạn. Kiểm tra tin nhắn trước khi Xác nhận gửi.").catch(() => {});
  } catch (err: any) {
    await ctx.reply(`❌ Gửi thử thất bại: ${escapeHtml(err?.message || "lỗi")}`).catch(() => {});
  }
}

export async function confirmComposer(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const adminId = String(ctx.from?.id || "");
  const w = composerSession(ctx);
  if (!w) return;
  const data = w.data;
  const count = await eligibleCount(data);
  if (count === 0) {
    await ctx.reply("⚠️ Không có khách nào đủ điều kiện trong nhóm đã chọn — không gửi.").catch(() => {});
    return;
  }
  try {
    const campaign = await createCampaign({
      createdByTelegramId: adminId,
      audienceType: data.audienceType as BroadcastAudienceType,
      audienceFilter: data.filter || null,
      customerIds: data.audienceType === "ONE_CUSTOMER" || data.audienceType === "LIST" ? data.selectedIds || [] : undefined,
      content: data.content || {}
    });
    const { campaign: confirmed, totalRecipients } = await confirmCampaign(adminId, campaign.id);
    clearWizard(adminId);
    await ctx.reply(
      `✅ <b>ĐÃ XÁC NHẬN GỬI</b>\n\n🆔 Chiến dịch: <code>${confirmed.id.slice(-6)}</code>\n👥 Người nhận: <b>${totalRecipients}</b>\n📤 Hệ thống gửi theo lô nhỏ trong nền (an toàn, restart-safe).`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  } catch (err: any) {
    await ctx.reply(`❌ Không xác nhận được: ${escapeHtml(err?.message || "lỗi")}`).catch(() => {});
  }
}


// --- History / detail --------------------------------------------------------
export async function showBroadcastHistory(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const campaigns = await listCampaigns(10);
  const lines = ["🕘 <b>LỊCH SỬ GỬI THÔNG BÁO</b>", ""];
  const kb = new InlineKeyboard();
  if (campaigns.length === 0) {
    lines.push("Chưa có chiến dịch nào.");
  } else {
    for (const c of campaigns) {
      const icon = c.status === "COMPLETED" ? "✅" : c.status === "SENDING" ? "📤" : c.status === "READY" ? "🟢" : c.status === "FAILED" ? "❌" : "⚪️";
      lines.push(
        `${icon} ${escapeHtml(c.title || c.id.slice(-6))} · ${formatAdminDateTime(c.createdAt as any)} · 👥 ${c.totalRecipients ?? 0} · ✅ ${c.sentCount ?? 0} · 🚫 ${c.blockedCount ?? 0} · ❌ ${c.failedCount ?? 0} · ${c.status}`
      );
      kb.text(`👁 ${(c.title || c.id.slice(-6)).slice(0, 24)}`, `ops:bcast:detail:${c.id}`).row();
    }
  }
  kb.text("⬅️ Chăm sóc khách hàng", "ops:broadcast").row();
  kb.text("🏠 Menu Admin", "ops:home");
  await replyWithMenu(ctx, lines.join("\n"), kb);
}

export async function showBroadcastDetail(ctx: BotContext, campaignId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  const campaign: any = await prisma.broadcastCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) {
    await ctx.reply("❌ Không tìm thấy chiến dịch.").catch(() => {});
    return;
  }
  const content: BroadcastContent = campaign.content || {};
  const lines = [
    `📣 <b>CHIẾN DỊCH #${campaign.id.slice(-6)}</b> · ${campaign.status}`,
    `🕒 Tạo: ${formatAdminDateTime(campaign.createdAt)}${campaign.completedAt ? ` · Xong: ${formatAdminDateTime(campaign.completedAt)}` : ""}`,
    `👤 Bởi Admin: <code>${escapeHtml(campaign.createdByTelegramId)}</code>`,
    `👥 Nhóm: <b>${escapeHtml(campaign.audienceType)}</b> · Bộ lọc: ${escapeHtml(describeFilter(campaign.audienceFilter))}`,
    `🎯 Snapshot: <b>${campaign.totalRecipients ?? 0}</b> người nhận (đóng băng trước khi gửi)`,
    `✅ Sent: <b>${campaign.sentCount ?? 0}</b> · 🚫 Blocked: <b>${campaign.blockedCount ?? 0}</b> · ❌ Failed: <b>${campaign.failedCount ?? 0}</b>`,
    "",
    "📝 <b>Nội dung:</b>",
    content.photoFileId ? "🖼 Ảnh kèm caption" : `<pre>${escapeHtml(renderBroadcastText(content).slice(0, 800) || "—")}</pre>`,
    `🔘 CTA: ${content.cta ? BROADCAST_CTA_BUTTONS.map((b) => b.text).join(" / ") : "Tắt"}`,
    "",
    "<i>Không hiển thị dữ liệu ngân hàng / thanh toán của khách.</i>"
  ];
  const kb = new InlineKeyboard();
  if (["DRAFT", "READY"].includes(campaign.status)) {
    kb.text("🚫 Hủy chiến dịch", `ops:bcast:campaigncancel:${campaign.id}`).row();
  }
  kb.text("⬅️ Lịch sử", "ops:broadcast:history").row();
  kb.text("🏠 Menu Admin", "ops:home");
  await replyWithMenu(ctx, lines.filter(Boolean).join("\n"), kb);
}


export async function cancelCampaignAction(ctx: BotContext, campaignId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  try {
    await cancelCampaign(String(ctx.from?.id || ""), campaignId);
    await ctx.reply("🚫 Đã hủy chiến dịch.").catch(() => {});
    await showBroadcastDetail(ctx, campaignId);
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "lỗi")}`).catch(() => {});
  }
}

// --- Callback registrations --------------------------------------------------
adminBroadcastHandler.callbackQuery("ops:broadcast", (ctx) => showBroadcastMenu(ctx));
adminBroadcastHandler.callbackQuery("ops:broadcast:all", (ctx) => startComposeAll(ctx));
adminBroadcastHandler.callbackQuery("ops:broadcast:filter", (ctx) => showFilterBuilder(ctx));
adminBroadcastHandler.callbackQuery("ops:broadcast:list", (ctx) => startComposeList(ctx, 0));
adminBroadcastHandler.callbackQuery("ops:broadcast:one", (ctx) => startComposeOne(ctx));
adminBroadcastHandler.callbackQuery("ops:broadcast:history", (ctx) => showBroadcastHistory(ctx));
adminBroadcastHandler.callbackQuery("ops:broadcast:rate", (ctx) => startComposeRatePrefill(ctx));

adminBroadcastHandler.callbackQuery(/^ops:bcast:f:(loc|dir|act)menu$/, (ctx) =>
  showFilterSubmenu(ctx, (ctx.match?.[1] || "loc") as "loc" | "dir" | "act"));
adminBroadcastHandler.callbackQuery(/^ops:bcast:f:loc:(vi|en|km|zh|off)$/, (ctx) => applyFilterToggle(ctx, "loc", ctx.match?.[1] || "off"));
adminBroadcastHandler.callbackQuery(/^ops:bcast:f:dir:(usd2vnd|vnd2usd|off)$/, (ctx) => applyFilterToggle(ctx, "dir", ctx.match?.[1] || "off"));
adminBroadcastHandler.callbackQuery(/^ops:bcast:f:act:(LAST_7D|LAST_30D|LAST_90D|INACTIVE_30D|off)$/, (ctx) => applyFilterToggle(ctx, "act", ctx.match?.[1] || "off"));
adminBroadcastHandler.callbackQuery("ops:bcast:f:cmpl", (ctx) => applyFilterToggle(ctx, "cmpl", ""));
adminBroadcastHandler.callbackQuery("ops:bcast:f:risk", (ctx) => applyFilterToggle(ctx, "risk", ""));
adminBroadcastHandler.callbackQuery("ops:bcast:f:apply", (ctx) => showComposer(ctx));

adminBroadcastHandler.callbackQuery(/^ops:bcast:sel:page:(\d+)$/, (ctx) => startComposeList(ctx, Number(ctx.match?.[1] || 0)));
adminBroadcastHandler.callbackQuery("ops:bcast:sel:done", (ctx) => showComposer(ctx));
adminBroadcastHandler.callbackQuery(/^ops:bcast:sel:([a-zA-Z0-9_-]+)$/, (ctx) => toggleListSelection(ctx, ctx.match?.[1] || ""));

adminBroadcastHandler.callbackQuery("ops:bcast:cta", (ctx) => toggleCta(ctx));
adminBroadcastHandler.callbackQuery("ops:bcast:text", (ctx) => promptText(ctx));
adminBroadcastHandler.callbackQuery("ops:bcast:photo", (ctx) => promptPhoto(ctx));
adminBroadcastHandler.callbackQuery("ops:bcast:test", (ctx) => testSendComposer(ctx));
adminBroadcastHandler.callbackQuery("ops:bcast:confirm", (ctx) => confirmComposer(ctx));
adminBroadcastHandler.callbackQuery("ops:bcast:cancel", (ctx) => cancelCompose(ctx));

adminBroadcastHandler.callbackQuery(/^ops:bcast:one:([a-zA-Z0-9_-]+)$/, (ctx) => startOneCustomerPreset(ctx, ctx.match?.[1] || ""));
adminBroadcastHandler.callbackQuery(/^ops:bcast:detail:([a-zA-Z0-9_-]+)$/, (ctx) => showBroadcastDetail(ctx, ctx.match?.[1] || ""));
adminBroadcastHandler.callbackQuery(/^ops:bcast:campaigncancel:([a-zA-Z0-9_-]+)$/, (ctx) => cancelCampaignAction(ctx, ctx.match?.[1] || ""));

