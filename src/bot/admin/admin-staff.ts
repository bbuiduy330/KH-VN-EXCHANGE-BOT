/**
 * Admin staff management — list, detail, add wizard, enable/disable, and
 * granular permission toggles. Reuses authoritative PermissionService and the
 * real role/permission model (StaffRole enum, ALL_PERMISSIONS).
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { prisma } from "../../database/client.js";
import { PermissionService, ALL_PERMISSIONS } from "../../modules/permissions/permission-service.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { clearWizard, consumePendingAction, getAdminSession, isSessionExpired, setPendingAction, startWizard, updateWizard } from "./admin-session.js";

export const adminStaffHandler = new Composer<BotContext>();

export const PERMISSION_LABELS: Record<string, string> = {
  "customer.view": "Xem khách",
  "customer.message": "Nhắn khách",
  "customer.edit_bank": "Sửa ngân hàng khách",
  "conversation.view": "Xem hội thoại",
  "conversation.claim": "Nhận khách (claim)",
  "conversation.takeover": "Chiếm quyền hỗ trợ",
  "order.view": "Xem đơn",
  "order.create_quote": "Tạo báo giá",
  "order.view_bill": "Xem bill",
  "payment.verify": "Xác nhận tiền vào",
  "payout.approve": "Duyệt payout",
  "rate.view": "Xem tỷ giá",
  "rate.edit": "Sửa tỷ giá",
  "payment_account.view": "Xem tài khoản nhận",
  "payment_account.edit": "Sửa tài khoản nhận",
  "profit.view": "Xem lợi nhuận",
  "staff.manage": "Quản lý nhân sự",
  "permission.manage": "Quản lý phân quyền",
  "audit.view": "Xem nhật ký",
  "data.export": "Xuất dữ liệu"
};

const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: "Super Admin", ADMIN: "Admin", CSKH: "CSKH" };
const STATUS_LABEL: Record<string, string> = { ACTIVE: "🟢 Hoạt động", PENDING: "🟡 Chờ duyệt", DISABLED: "⚪ Vô hiệu" };

export async function showStaffList(ctx: BotContext): Promise<void> {
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  const staff = await prisma.staffUser.findMany({ orderBy: { createdAt: "asc" }, take: 50 });
  const lines = ["👨‍💼 <b>NHÂN VIÊN</b>", ""];
  const kb = new InlineKeyboard();
  if (staff.length === 0) {
    lines.push("Chưa có nhân sự nào.");
  } else {
    for (const s of staff) {
      lines.push(`👤 <b>${escapeHtml(s.name)}</b> · 🎭 ${ROLE_LABEL[s.role] || s.role} · ${STATUS_LABEL[s.status] || s.status}`);
      kb.row().text(`👤 ${escapeHtml(s.name)}`, `ops:staff:detail:${s.telegramId}`);
    }
  }
  kb.row().text("➕ Thêm nhân viên", "ops:staff:add").text("🏠 Menu Admin", "ops:home");
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

export async function showStaffDetail(ctx: BotContext, telegramId: string): Promise<void> {
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  const s = await prisma.staffUser.findUnique({ where: { telegramId } });
  if (!s) {
    await ctx.reply("❌ Không tìm thấy nhân viên.").catch(() => {});
    return;
  }
  const perms = (s.permissions || []).map((p) => PERMISSION_LABELS[p] || p).join(", ");
  const lines = [
    `👤 <b>NHÂN VIÊN</b>`,
    "",
    `Tên: <b>${escapeHtml(s.name)}</b>`,
    `Telegram: <code>${escapeHtml(s.telegramId)}</code>`,
    `Vai trò: ${ROLE_LABEL[s.role] || s.role}`,
    `Trạng thái: ${STATUS_LABEL[s.status] || s.status}`,
    `Quyền: ${perms || "—"}`
  ];
  const kb = new InlineKeyboard();
  kb.row().text("✏️ Sửa tên", `ops:staff:name:${s.telegramId}`)
    .text("🎭 Đổi vai trò", `ops:staff:role:${s.telegramId}`);
  kb.row().text("🔐 Phân quyền", `ops:staff:perms:${s.telegramId}`);
  kb.row().text(s.status === "ACTIVE" ? "⚪ Vô hiệu hóa" : "🟢 Kích hoạt", `ops:staff:toggle:preview:${s.telegramId}`);
  kb.row().text("⬅️ Quay lại", "ops:staff").text("🏠 Menu Admin", "ops:home");

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

// ---------------------------------------------------------------------------
// Add staff wizard (Telegram ID → name → role → preview → confirm)
// ---------------------------------------------------------------------------

export async function startStaffAdd(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  startWizard(String(ctx.from?.id || ""), "staff_add", {});
  await ctx.reply(`👤 <b>THÊM NHÂN VIÊN — BƯỚC 1/3</b>\n\nNhập Telegram ID của nhân viên.\n\nGửi /cancel để hủy.`, { parse_mode: "HTML" });
}

export async function handleStaffWizardInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || wizard.kind !== "staff_add") return false;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên thêm nhân viên đã hết hạn.").catch(() => {});
    return true;
  }
  const value = text.trim();
  if (!value) {
    await ctx.reply("Vui lòng nhập giá trị.").catch(() => {});
    return true;
  }
  if (wizard.step === 1) {
    updateWizard(adminId, { step: 2, data: { telegramId: value } });
    await ctx.reply(`📝 <b>BƯỚC 2/3</b>\n\nNhập tên hiển thị:`).catch(() => {});
  } else if (wizard.step === 2) {
    updateWizard(adminId, { step: 3, data: { name: value } });
    const kb = new InlineKeyboard().text("🎭 CSKH", "ops:staff:add:role:CSKH").row().text("🎭 ADMIN", "ops:staff:add:role:ADMIN");
    await ctx.reply(`🎭 <b>BƯỚC 3/3</b>\n\nChọn vai trò:`, { parse_mode: "HTML", reply_markup: kb });
  }
  return true;
}

export async function chooseStaffRole(ctx: BotContext, role: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || wizard.kind !== "staff_add") {
    await ctx.reply("⚠️ Không có phiên thêm nhân viên.").catch(() => {});
    return;
  }
  // Privilege escalation guard: only SUPER_ADMIN may create ADMIN-level staff.
  if (role === "ADMIN" && ctx.identity?.userType !== "SUPER_ADMIN") {
    clearWizard(adminId);
    await ctx.reply("⛔ Chỉ Super Admin mới có quyền tạo nhân viên vai trò ADMIN.").catch(() => {});
    return;
  }
  updateWizard(adminId, { step: 4, data: { role } });
  const d = getAdminSession(adminId).wizard?.data || {};
  const text =
    `⚠️ <b>XÁC NHẬN THÊM NHÂN VIÊN</b>\n\n` +
    `Telegram: <code>${escapeHtml(d.telegramId)}</code>\n` +
    `Tên: <b>${escapeHtml(d.name)}</b>\n` +
    `Vai trò: ${ROLE_LABEL[role] || role}`;
  const kb = new InlineKeyboard().text("✅ LƯU", "ops:staff:add:confirm").row().text("❌ HỦY", "ops:staff:cancel");
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function confirmStaffAdd(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  const adminId = String(ctx.from?.id || "");
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên thêm nhân viên đã hết hạn.").catch(() => {});
    return;
  }
  const d = getAdminSession(adminId).wizard?.data;
  if (!d || d.role !== "ADMIN" && d.role !== "CSKH") {
    await ctx.reply("⚠️ Phiên thêm nhân viên không hợp lệ.").catch(() => {});
    return;
  }
  if (d.role === "ADMIN" && ctx.identity?.userType !== "SUPER_ADMIN") {
    clearWizard(adminId);
    await ctx.reply("⛔ Chỉ Super Admin mới có quyền tạo nhân viên vai trò ADMIN.").catch(() => {});
    return;
  }
  try {
    const staff = await PermissionService.inviteStaff({ telegramId: d.telegramId, name: d.name, role: d.role });
    clearWizard(adminId);
    await ctx.reply(`✅ <b>ĐÃ THÊM NHÂN VIÊN</b>\n\n👤 ${escapeHtml(staff.name)} · 🎭 ${ROLE_LABEL[staff.role] || staff.role}`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ Thêm thất bại: ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function cancelStaffWizard(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  clearWizard(String(ctx.from?.id || ""));
  await ctx.reply("Đã hủy thao tác nhân viên.").catch(() => {});
}

export async function showStaffPerms(ctx: BotContext, telegramId: string): Promise<void> {
  if (!(await requirePermission(ctx, "permission.manage"))) return;
  const s = await prisma.staffUser.findUnique({ where: { telegramId } });
  if (!s) {
    await ctx.reply("❌ Không tìm thấy nhân viên.").catch(() => {});
    return;
  }
  const current = new Set(s.permissions || []);
  const kb = new InlineKeyboard();
  for (const p of ALL_PERMISSIONS) {
    const on = current.has(p);
    kb.text(`${on ? "✅" : "⬜"} ${PERMISSION_LABELS[p] || p}`, `ops:staff:perm:preview:${telegramId}:${p}`);
    if ((ALL_PERMISSIONS.indexOf(p) + 1) % 2 === 0) kb.row();
  }
  kb.row().text("⬅️ Quay lại", `ops:staff:detail:${telegramId}`);
  const text = `🔐 <b>PHÂN QUYỀN — ${escapeHtml(s.name)}</b>\n\nBấm để bật/tắt quyền.`;
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

export async function previewStaffPerm(ctx: BotContext, telegramId: string, perm: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "permission.manage"))) return;
  const s = await prisma.staffUser.findUnique({ where: { telegramId } });
  if (!s) {
    await ctx.reply("❌ Không tìm thấy nhân viên.").catch(() => {});
    return;
  }
  setPendingAction(String(ctx.from?.id || ""), "staff_perm", `${telegramId}:${perm}`);
  const has = (s.permissions || []).includes(perm);
  const text =
    `⚠️ <b>XÁC NHẬN THAY ĐỔI QUYỀN</b>\n\n` +
    `Nhân viên: <b>${escapeHtml(s.name)}</b>\n` +
    `Quyền: ${escapeHtml(PERMISSION_LABELS[perm] || perm)}\n` +
    `Hiện tại: ${has ? "✅ Đang bật" : "⬜ Đang tắt"}\n` +
    `Thay đổi dự kiến: ${has ? "⬜ Tắt" : "✅ Bật"}`;
  const kb = new InlineKeyboard()
    .text("✅ XÁC NHẬN", `ops:staff:perm:confirm:${telegramId}:${perm}`)
    .row()
    .text("❌ HỦY", `ops:staff:perms:${telegramId}`);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function confirmStaffPerm(ctx: BotContext, telegramId: string, perm: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "permission.manage"))) return;
  const adminId = String(ctx.from?.id || "");
  const pending = consumePendingAction(adminId, "staff_perm", `${telegramId}:${perm}`);
  if (pending.expired) {
    await ctx.reply("⏱ Thao tác đã hết hạn. Vui lòng thực hiện lại từ đầu.").catch(() => {});
    return;
  }
  if (!pending.valid) {
    await ctx.reply("⚠️ Không có thao tác đang chờ xác nhận.").catch(() => {});
    return;
  }
  try {
    await PermissionService.togglePermission(adminId, telegramId, perm);
    await showStaffPerms(ctx, telegramId);
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function previewToggleStaff(ctx: BotContext, telegramId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  const s = await prisma.staffUser.findUnique({ where: { telegramId } });
  if (!s) {
    await ctx.reply("❌ Không tìm thấy nhân viên.").catch(() => {});
    return;
  }
  const disabling = s.status === "ACTIVE";
  let warn = "";
  if (disabling) {
    const claimed = await prisma.conversation.count({ where: { claimedById: telegramId, mode: "HUMAN" } });
    if (claimed > 0) {
      warn = `\n\n⚠️ Nhân viên này đang hỗ trợ <b>${claimed}</b> hội thoại. Khi vô hiệu hóa, các hội thoại đó vẫn giữ trạng thái đang hỗ trợ (không bị xóa).\nBạn có thể bấm "🔄 Giải phóng hội thoại" để trả các hội thoại về chế độ tự động.`;
    }
  }
  const text =
    `⚠️ <b>${disabling ? "VÔ HIỆU HÓA" : "KÍCH HOẠT"} NHÂN VIÊN</b>\n\n` +
    `👤 ${escapeHtml(s.name)} · ${ROLE_LABEL[s.role] || s.role}\n` +
    `Trạng thái hiện tại: ${STATUS_LABEL[s.status] || s.status}\n` +
    `Sau xác nhận: ${disabling ? "⚪ Vô hiệu" : "🟢 Hoạt động"}` +
    warn;

  setPendingAction(String(ctx.from?.id || ""), "staff_status", telegramId);
  const kb = new InlineKeyboard().text("✅ XÁC NHẬN", `ops:staff:toggle:confirm:${telegramId}`).row().text("❌ HỦY", "ops:home");
  if (disabling) {
    kb.row().text("🔄 Giải phóng hội thoại", `ops:staff:reset:${telegramId}`);
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function confirmToggleStaff(ctx: BotContext, telegramId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  const adminId = String(ctx.from?.id || "");
  const pending = consumePendingAction(adminId, "staff_status", telegramId);
  if (pending.expired) {
    await ctx.reply("⏱ Thao tác đã hết hạn. Vui lòng thực hiện lại từ đầu.").catch(() => {});
    return;
  }
  if (!pending.valid) {
    await ctx.reply("⚠️ Không có thao tác đang chờ xác nhận.").catch(() => {});
    return;
  }
  try {
    const updated = await PermissionService.toggleStaffStatus(adminId, telegramId);
    await ctx.reply(`✅ Đã ${updated.status === "ACTIVE" ? "kích hoạt" : "vô hiệu hóa"} nhân viên <b>${escapeHtml(updated.name)}</b>.`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function resetStaffConvs(ctx: BotContext, telegramId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  try {
    const res = await PermissionService.resetStaffConversations(String(ctx.from?.id || ""), telegramId);
    await ctx.reply(`✅ Đã giải phóng <b>${res.resetCount}</b> hội thoại.`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function startStaffNameEdit(ctx: BotContext, telegramId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  startWizard(String(ctx.from?.id || ""), "staff_name_edit", { telegramId });
  await ctx.reply(`✏️ <b>SỬA TÊN NHÂN VIÊN</b>\n\nNhập tên hiển thị mới.\n\nGửi /cancel để hủy.`, { parse_mode: "HTML" });
}

export async function handleStaffNameInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || wizard.kind !== "staff_name_edit") return false;
  const name = text.trim();
  if (!name) {
    await ctx.reply("❌ Tên không được để trống.").catch(() => {});
    return true;
  }
  updateWizard(adminId, { step: 2, data: { name } });
  const telegramId = String(wizard.data.telegramId);
  const kb = new InlineKeyboard().text("✅ LƯU", `ops:staff:name:confirm:${telegramId}`).row().text("❌ HỦY", `ops:staff:detail:${telegramId}`);
  await ctx.reply(`⚠️ <b>XÁC NHẬN SỬA TÊN</b>\n\nTên mới: <b>${escapeHtml(name)}</b>`, { parse_mode: "HTML", reply_markup: kb });
  return true;
}

export async function confirmStaffNameEdit(ctx: BotContext, telegramId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  const adminId = String(ctx.from?.id || "");
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên sửa tên đã hết hạn.").catch(() => {});
    return;
  }
  const name = getAdminSession(adminId).wizard?.data?.name;
  if (!name) {
    await ctx.reply("⚠️ Không có tên mới để lưu.").catch(() => {});
    return;
  }
  try {
    const updated = await PermissionService.updateStaffName(adminId, telegramId, name);
    clearWizard(adminId);
    await ctx.reply(`✅ Đã đổi tên thành <b>${escapeHtml(updated.name)}</b>.`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function startStaffRoleEdit(ctx: BotContext, telegramId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  startWizard(String(ctx.from?.id || ""), "staff_role_edit", { telegramId });
  const kb = new InlineKeyboard().text("🎭 CSKH", `ops:staff:role:choose:${telegramId}:CSKH`).row().text("🎭 ADMIN", `ops:staff:role:choose:${telegramId}:ADMIN`);
  await ctx.reply(`🎭 <b>ĐỔI VAI TRÒ</b>\n\nChọn vai trò mới:`, { parse_mode: "HTML", reply_markup: kb });
}

export async function chooseStaffRoleEdit(ctx: BotContext, telegramId: string, role: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  const adminId = String(ctx.from?.id || "");
  const s = await prisma.staffUser.findUnique({ where: { telegramId } });
  if (!s) {
    await ctx.reply("❌ Không tìm thấy nhân viên.").catch(() => {});
    return;
  }
  if (role === "ADMIN" && ctx.identity?.userType !== "SUPER_ADMIN") {
    clearWizard(adminId);
    await ctx.reply("⛔ Chỉ Super Admin mới có quyền cấp vai trò ADMIN.").catch(() => {});
    return;
  }
  setPendingAction(adminId, "staff_role", telegramId);
  const text =
    `⚠️ <b>XÁC NHẬN ĐỔI VAI TRÒ</b>\n\n` +
    `👤 ${escapeHtml(s.name)}\n` +
    `Hiện tại: ${ROLE_LABEL[s.role] || s.role}\n` +
    `Mới: ${ROLE_LABEL[role] || role}\n\n` +
    `Quyền sẽ được đặt lại theo vai trò mới.`;
  const kb = new InlineKeyboard().text("✅ XÁC NHẬN", `ops:staff:role:confirm:${telegramId}:${role}`).row().text("❌ HỦY", `ops:staff:detail:${telegramId}`);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function confirmStaffRoleEdit(ctx: BotContext, telegramId: string, role: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  if (role !== "ADMIN" && role !== "CSKH") {
    await ctx.reply("❌ Vai trò không hợp lệ.").catch(() => {});
    return;
  }
  const adminId = String(ctx.from?.id || "");
  const pending = consumePendingAction(adminId, "staff_role", telegramId);
  if (pending.expired) {
    await ctx.reply("⏱ Thao tác đã hết hạn. Vui lòng thực hiện lại từ đầu.").catch(() => {});
    return;
  }
  if (!pending.valid) {
    await ctx.reply("⚠️ Không có thao tác đang chờ xác nhận.").catch(() => {});
    return;
  }
  try {
    const updated = await PermissionService.updateStaffRole(adminId, telegramId, role as "ADMIN" | "CSKH");
    clearWizard(adminId);
    await ctx.reply(`✅ Đã đổi vai trò thành <b>${ROLE_LABEL[updated.role] || updated.role}</b>.`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

adminStaffHandler.callbackQuery("ops:staff", (ctx) => showStaffList(ctx));
adminStaffHandler.callbackQuery(/^ops:staff:detail:(.+)$/, (ctx) => showStaffDetail(ctx, ctx.match?.[1] || ""));
adminStaffHandler.callbackQuery("ops:staff:add", (ctx) => startStaffAdd(ctx));
adminStaffHandler.callbackQuery(/^ops:staff:add:role:(CSKH|ADMIN)$/, (ctx) => chooseStaffRole(ctx, ctx.match?.[1] || "CSKH"));
adminStaffHandler.callbackQuery("ops:staff:add:confirm", (ctx) => confirmStaffAdd(ctx));
adminStaffHandler.callbackQuery("ops:staff:cancel", (ctx) => cancelStaffWizard(ctx));
adminStaffHandler.callbackQuery(/^ops:staff:name:(.+)$/, (ctx) => startStaffNameEdit(ctx, ctx.match?.[1] || ""));
adminStaffHandler.callbackQuery(/^ops:staff:name:confirm:(.+)$/, (ctx) => confirmStaffNameEdit(ctx, ctx.match?.[1] || ""));
adminStaffHandler.callbackQuery(/^ops:staff:role:(.+)$/, (ctx) => startStaffRoleEdit(ctx, ctx.match?.[1] || ""));
adminStaffHandler.callbackQuery(/^ops:staff:role:choose:(.+):(CSKH|ADMIN)$/, (ctx) => chooseStaffRoleEdit(ctx, ctx.match?.[1] || "", ctx.match?.[2] || "CSKH"));
adminStaffHandler.callbackQuery(/^ops:staff:role:confirm:(.+):(CSKH|ADMIN)$/, (ctx) => confirmStaffRoleEdit(ctx, ctx.match?.[1] || "", ctx.match?.[2] || "CSKH"));
adminStaffHandler.callbackQuery(/^ops:staff:perms:(.+)$/, (ctx) => showStaffPerms(ctx, ctx.match?.[1] || ""));
adminStaffHandler.callbackQuery(/^ops:staff:perm:preview:(.+):([a-z_.]+)$/, (ctx) => previewStaffPerm(ctx, ctx.match?.[1] || "", ctx.match?.[2] || ""));
adminStaffHandler.callbackQuery(/^ops:staff:perm:confirm:(.+):([a-z_.]+)$/, (ctx) => confirmStaffPerm(ctx, ctx.match?.[1] || "", ctx.match?.[2] || ""));
adminStaffHandler.callbackQuery(/^ops:staff:toggle:preview:(.+)$/, (ctx) => previewToggleStaff(ctx, ctx.match?.[1] || ""));
adminStaffHandler.callbackQuery(/^ops:staff:toggle:confirm:(.+)$/, (ctx) => confirmToggleStaff(ctx, ctx.match?.[1] || ""));
adminStaffHandler.callbackQuery(/^ops:staff:reset:(.+)$/, (ctx) => resetStaffConvs(ctx, ctx.match?.[1] || ""));


