/**
 * Admin CSKH overview — waiting & active support sessions. Read-only;
 * does not modify C3 selected-chat ownership semantics.
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { prisma } from "../../database/client.js";
import { PermissionService } from "../../modules/permissions/permission-service.js";
import { escapeHtml, staffDisplayName } from "../menus/cskh-panel.js";
import { customerLabel, timeAgo } from "./admin-panel.js";

export const adminCskhHandler = new Composer<BotContext>();

export async function showCskhOverview(ctx: BotContext): Promise<void> {
  if (!(await requirePermission(ctx, "conversation.view"))) return;

  const [waiting, active] = await Promise.all([
    prisma.conversation.findMany({
      where: { mode: "HUMAN", claimedById: null },
      include: { customer: true },
      orderBy: { updatedAt: "asc" },
      take: 20
    }),
    prisma.conversation.findMany({
      where: { mode: "HUMAN", claimedById: { not: null } },
      include: { customer: true },
      orderBy: { updatedAt: "asc" },
      take: 20
    })
  ]);

  const lines = ["💬 <b>CSKH</b>", "", `🔔 Khách đang chờ: <b>${waiting.length}</b>`, `💬 Đang hỗ trợ: <b>${active.length}</b>`, ""];
  const kb = new InlineKeyboard();

  if (waiting.length) {
    lines.push("🟡 <b>CHỜ HỖ TRỢ</b>");
    for (const c of waiting) {
      lines.push(`👤 ${escapeHtml(customerLabel(c.customer))} · chờ ${timeAgo(c.updatedAt)}`);
      kb.row().text(`👀 ${escapeHtml(customerLabel(c.customer))}`, `ops:customer:detail:${c.customerId}`);
    }
    lines.push("");
  }

  if (active.length) {
    lines.push("🟢 <b>ĐANG HỖ TRỢ</b>");
    for (const c of active) {
      const owner = await PermissionService.getStaffUser(c.claimedById || "");
      lines.push(`👤 ${escapeHtml(customerLabel(c.customer))} · 👨‍💼 ${escapeHtml(staffDisplayName(owner, c.claimedById))}`);
      kb.row().text(`👀 ${escapeHtml(customerLabel(c.customer))}`, `ops:customer:detail:${c.customerId}`);
    }
    lines.push("");
  }

  if (waiting.length === 0 && active.length === 0) {
    lines.push("Không có phiên hỗ trợ nào.");
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

adminCskhHandler.callbackQuery("ops:cskh", (ctx) => showCskhOverview(ctx));
