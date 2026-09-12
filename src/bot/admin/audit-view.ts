/**
 * Shared Admin AUDIT ROW rendering (identity + exact GMT+7 time).
 *
 * HUMAN-FACING IDENTITY + EXACT TIME (Admin operations UX):
 *  - Customer-related entries resolve the actor/target to the real customer:
 *    display name + Telegram numeric ID — a long raw CUID is never the
 *    primary identity (DB ids remain untouched in storage).
 *  - Timestamps are EXACT Asia/Ho_Chi_Minh (shared app-time helper) with the
 *    relative age only as a secondary hint. No DB timestamp is altered.
 *  - Adds a 👤 Xem khách button per resolved customer → Admin customer detail
 *    + transaction history (never make Admin copy a long UUID).
 *
 * NOTE: `admin-audit.ts` (the ops:audit screen) is currently FILE-LOCKED by an
 * external process on this machine and could not be rewritten; it still works
 * with its previous rendering. All editable audit/history surfaces import the
 * shared helpers below. When the lock releases, admin-audit.ts should adopt
 * renderAuditRows too.
 */
import { InlineKeyboard } from "grammy";
import { prisma } from "../../database/client.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { shortOrderId, timeAgo } from "./admin-panel.js";
import { formatAdminDateTime } from "../../shared/app-time.js";

function shortRef(action: string, targetId: string): string {
  const lower = action.toLowerCase();
  if (lower.includes("order") || lower.includes("payment") || lower.includes("payout")) {
    return shortOrderId(targetId);
  }
  return "";
}

/**
 * Resolve human identity for audit rows: matches BOTH Customer.id (CUID,
 * used by order-creation actors) and Customer.telegramId (used by bill
 * submissions). Returns a map keyed by BOTH id and telegramId for O(1)
 * lookup. Internal IDs are never removed from storage — display only.
 */
export async function resolveAuditCustomers(logs: any[]): Promise<Map<string, any>> {
  const ids = new Set<string>();
  for (const l of logs) {
    if (l.actorId) ids.add(String(l.actorId));
    if (l.targetId) ids.add(String(l.targetId));
  }
  const list = [...ids].filter((v) => v && v.length >= 4);
  if (list.length === 0) return new Map();
  const customers = await prisma.customer.findMany({
    where: { OR: [{ id: { in: [...ids] } }, { telegramId: { in: [...ids] } }] }
  });
  const map = new Map<string, any>();
  for (const c of customers) {
    map.set(c.id, c);
    map.set(c.telegramId, c);
  }
  return map;
}

/** Short human label for a resolved audit customer. */
export function auditCustomerName(c: any): string {
  return (c?.fullName || "").trim() || (c?.username ? `@${c.username}` : "Khách");
}

/**
 * ONE audit row: EXACT GMT+7 timestamp primary (relative only secondary),
 * preferred human identity for customers (name + Telegram ID), short Order
 * reference for order-related entries. Storage/DB ids untouched.
 */
export function auditRowText(
  l: any,
  actorCustomer: any | null,
  targetCustomer: any | null,
  includeDetails: boolean = false
): string {
  const parts: string[] = [
    `${formatAdminDateTime(l.createdAt)} · ${timeAgo(l.createdAt)}`,
    `${escapeHtml(l.actorRole || "")} ${escapeHtml(l.action || "")}`
  ];
  if (actorCustomer) {
    parts.push(
      `👤 ${escapeHtml(auditCustomerName(actorCustomer))} · 🆔 TG <code>${escapeHtml(actorCustomer.telegramId || "")}</code>`
    );
  } else if (l.actorId) {
    const raw = String(l.actorId);
    parts.push(escapeHtml(raw.length > 20 ? `Ref #${raw.slice(-6)}` : raw));
  }
  const ref = shortRef(l.action, l.targetId);
  if (ref) parts.push(`📦 ${ref}`);
  if (includeDetails && l.details && Object.keys(l.details).length > 0) {
    parts.push(escapeHtml(JSON.stringify(l.details)));
  }
  return parts.join(" · ");
}

/**
 * Render filtered audit logs into lines + per-customer 👤 Xem khách buttons
 * (shared by every Admin audit/history screen so identity and exact time are
 * consistent everywhere).
 */
export async function renderAuditRows(
  logs: any[],
  kb: InlineKeyboard,
  maxCustomerButtons: number = 10,
  includeDetails: boolean = false
): Promise<string[]> {
  const custMap = await resolveAuditCustomers(logs);
  const lines: string[] = [];
  let customerButtons = 0;
  for (const l of logs) {
    const targetCustomer =
      l.targetType === "ORDER" || /order|payment|payout/i.test(l.action || "")
        ? custMap.get(String(l.targetId || "")) || null
        : null;
    const actorCustomer = custMap.get(String(l.actorId || "")) || null;
    lines.push(auditRowText(l, actorCustomer, targetCustomer, includeDetails));
    // 👤 Xem khách → customer Admin detail + transaction history. Never make
    // the Admin copy a long UUID manually.
    const linked = targetCustomer || actorCustomer;
    if (linked && customerButtons < maxCustomerButtons) {
      kb.text(`👤 Xem khách: ${auditCustomerName(linked)}`, `ops:customer:detail:${linked.id}`).row();
      customerButtons++;
    }
  }
  return lines;
}
