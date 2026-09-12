/**
 * Admin audit log — readable recent operational events with category filters.
 * Rendering is SYNCED with the shared audit view (audit-view.ts): exact
 * Asia/Ho_Chi_Minh timestamp primary (relative age only secondary), human
 * customer identity (display name + Telegram numeric ID) where available,
 * short internal Order refs, and 👤 Xem khách shortcuts. AuditLog storage and
 * historical timestamps are never altered.
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { prisma } from "../../database/client.js";
import { renderAuditRows } from "./audit-view.js";

export const adminAuditHandler = new Composer<BotContext>();

const AUDIT_FILTERS: { id: string; label: string; match: RegExp }[] = [
  { id: "all", label: "📜 Tất cả", match: /./ },
  { id: "rate", label: "💱 Tỷ giá", match: /rate/i },
  { id: "order", label: "💰 Giao dịch", match: /order|payment|payout/i },
  { id: "staff", label: "👨‍💼 Nhân viên", match: /staff|permission/i },
  { id: "account", label: "🏦 Tài khoản", match: /account/i },
  { id: "ai", label: "🤖 AI", match: /gemini|ai/i },
  { id: "config", label: "⚙️ Cấu hình", match: /config|setting|backup/i }
];

export async function showAudit(ctx: BotContext, filter: string = "all"): Promise<void> {
  if (!(await requirePermission(ctx, "audit.view"))) return;
  const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 40 });
  const cfg = AUDIT_FILTERS.find((f) => f.id === filter) || AUDIT_FILTERS[0]!;
  const filtered = logs.filter((l: any) => cfg.match.test(l.action || ""));

  const kb = new InlineKeyboard();
  const lines = ["📜 <b>NHẬT KÝ</b>", ""];
  if (filtered.length === 0) {
    lines.push("Không có bản ghi nào.");
  } else {
    // Shared rendering: exact GMT+7 time primary, customer name + Telegram ID,
    // short ref, action summary, 👤 Xem khách buttons (appended into kb).
    lines.push(...(await renderAuditRows(filtered, kb)));
  }

  for (let i = 0; i < AUDIT_FILTERS.length; i++) {
    const f = AUDIT_FILTERS[i]!;
    kb.text(f.label, `ops:audit:filter:${f.id}`);
    if ((i + 1) % 2 === 0) kb.row();
  }
  kb.row().text("🏠 Menu Admin", "ops:home");

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

adminAuditHandler.callbackQuery("ops:audit", (ctx) => showAudit(ctx, "all"));
adminAuditHandler.callbackQuery(/^ops:audit:filter:(all|rate|order|staff|account|ai|config)$/, (ctx) => showAudit(ctx, ctx.match?.[1] || "all"));
