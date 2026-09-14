/**
 * CANONICAL CUSTOMER RESOLVER (single source of truth for cross-entry lookup).
 *
 * Identity rules:
 *   - Telegram numeric ID : authoritative Telegram identity.
 *   - Customer.id         : internal DB primary key (callback/session state).
 *   - Customer Ref        : public short reference (#last6 of Customer.id).
 *   - username            : DISPLAY ONLY — never authoritative (can change).
 *
 * Resolves, without ambiguity, in priority order:
 *   1. full internal Customer.id (cuid)
 *   2. Telegram numeric ID
 *   3. Customer Ref (#last6, case-insensitive so legacy lowercase refs work)
 * Ambiguous Refs (2+ candidates) resolve to null — nothing is guessed.
 * Handlers MUST use this resolver instead of scattered ad-hoc Prisma lookups.
 */
import { prisma } from "../../database/client.js";

export type CustomerMatchKind = "id" | "telegramId" | "ref";

export interface CustomerResolution {
  customer: any | null;
  matchedBy: CustomerMatchKind | null;
}

const CUID_RE = /^c[a-z0-9]{24,}$/;

export async function resolveCustomer(rawInput: string): Promise<CustomerResolution> {
  const raw = String(rawInput || "").trim();
  if (!raw) return { customer: null, matchedBy: null };

  // 1. Full internal Customer.id (cuid shape).
  if (CUID_RE.test(raw)) {
    const customer = await prisma.customer.findUnique({ where: { id: raw } });
    if (customer) return { customer, matchedBy: "id" };
  }

  // 2. Telegram numeric ID (exact — never interpreted as any other number).
  if (/^\d{4,20}$/.test(raw)) {
    const customer = await prisma.customer.findUnique({ where: { telegramId: raw } });
    if (customer) return { customer, matchedBy: "telegramId" };
  }

  // 3. Public Customer Ref (#last6). Uppercase in the UI, but stored ids are
  // lowercase — compare case-insensitively so legacy refs still resolve.
  // Username is deliberately NOT a lookup key here (mutable, non-authoritative).
  const ref = raw.replace(/^#/, "");
  if (/^[a-zA-Z0-9_-]{4,10}$/.test(ref)) {
    const candidates: any[] = await prisma.customer.findMany({
      where: { id: { endsWith: ref.toLowerCase() } },
      take: 2
    });
    if (candidates.length === 1) return { customer: candidates[0], matchedBy: "ref" };
    if (candidates.length > 1) return { customer: null, matchedBy: null }; // ambiguous
  }

  // 4. Exact non-cuid internal id fallback (legacy/test fixtures).
  if (/^[a-zA-Z0-9_-]{6,}$/.test(raw)) {
    const customer = await prisma.customer.findUnique({ where: { id: raw } });
    if (customer) return { customer, matchedBy: "id" };
  }

  return { customer: null, matchedBy: null };
}
