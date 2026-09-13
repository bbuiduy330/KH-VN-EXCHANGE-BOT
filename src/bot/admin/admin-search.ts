/**
 * PART C — 🔎 Tìm kiếm (unified Google-like Admin search UI).
 * One free-form query → ranked customers/orders/CTV results with direct
 * click-through to the existing detail screens. Optional structured hints
 * are parsed from the query itself (amount+currency, direction, status:).
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requireRole } from "../middleware/permissions.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { clearWizard, getAdminSession, isSessionExpired, startWizard } from "./admin-session.js";
import { unifiedSearch } from "../../modules/search/unified-search.js";

export const adminSearchHandler = new Composer<BotContext>();

export async function showSearchEntry(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requireRole(ctx, ["ADMIN", "SUPER_ADMIN"]))) return;
  startWizard(String(ctx.from?.id || ""), "unified_search", {});
  await ctx.reply(
    "🔎 <b>TÌM KIẾM TỔNG HỢP</b>\n\nGửi MỘT từ khóa — tên, @username, một phần Telegram ID, mã đơn (#xxxxxx), số tiền (<code>100 usd</code>), chiều (<code>usd2vnd</code>), hoặc kèm <code>status:completed</code>.\n\nVí dụ: <code>zico</code>, <code>8274</code>, <code>100 usd</code>, <code>duy status:completed</code>\n\nGửi /cancel để hủy.",
    { parse_mode: "HTML" }
  );
}

export async function handleUnifiedSearchText(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (session.wizard?.kind !== "unified_search") return false;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⌛️ Phiên đã hết hạn. Mở lại từ 🔎 Tìm kiếm.").catch(() => {});
    return true;
  }
  clearWizard(adminId);
  const results = await unifiedSearch(text);
  const lines = [`🔎 <b>KẾT QUẢ CHO:</b> ${escapeHtml(text.trim())}`, ""];
  const kb = new InlineKeyboard();
  let n = 0;

  if (results.customers.length === 0 && results.orders.length === 0 && results.partners.length === 0) {
    lines.push("Không tìm thấy kết quả nào phù hợp.");
  }
  if (results.customers.length > 0) {
    lines.push("👤 <b>KHÁCH HÀNG</b>");
    for (const m of results.customers) {
      n++;
      lines.push(`${n}. ${escapeHtml(m.title)} · ${escapeHtml(m.subtitle)}`);
      kb.text(`${n}`, `ops:customer:detail:${m.id}`);
    }
    kb.row();
  }
  if (results.orders.length > 0) {
    lines.push("📦 <b>GIAO DỊCH</b>");
    for (const m of results.orders) {
      n++;
      lines.push(`${n}. ${escapeHtml(m.title)} · ${escapeHtml(m.subtitle)}`);
      kb.text(`${n}`, `ops:order:detail:${m.id}`);
    }
    kb.row();
  }
  if (results.partners.length > 0) {
    lines.push("🤝 <b>CTV</b>");
    for (const m of results.partners) {
      n++;
      lines.push(`${n}. ${escapeHtml(m.title)} · ${escapeHtml(m.subtitle)}`);
      kb.text(`${n}`, `ops:partner:detail:${m.id}`);
    }
    kb.row();
  }
  kb.text("🔎 Tìm lại", "ops:search").text("🏠 Menu Admin", "ops:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
  return true;
}

adminSearchHandler.callbackQuery("ops:search", (ctx) => showSearchEntry(ctx));
