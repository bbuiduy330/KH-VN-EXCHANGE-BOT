/**
 * PART C — GOOGLE-LIKE UNIFIED ADMIN SEARCH.
 *
 * ONE query box across CUSTOMERS / ORDERS / CTV-PARTNERS with ranked results:
 *   1. exact match → 2. prefix → 3. contains → 4. fuzzy (bigram similarity).
 * Numeric queries strongly prefer Telegram ID / Order Ref / amount matches.
 *
 * NO banking secrets / payment-evidence content is ever searched or shown.
 * pg_trgm indexes are provisioned by the migration for SQL-level acceleration;
 * the matching below is bounded + deterministic (JS bigram fallback) so the
 * Admin search keeps working even when the extension is unavailable.
 */

export type SearchKind = "customer" | "order" | "partner";

export interface SearchMatch {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  rank: number;
}

/** Character-bigram similarity (0..1) — deterministic fuzzy fallback. */
export function bigramSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sa = norm(a);
  const sb = norm(b);
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(sa);
  const gb = grams(sb);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

/**
 * Rank ONE candidate's searchable text against the query.
 * 0 = no match; exact 100 > prefix 80 > contains 60 > fuzzy (≤50).
 */
export function rankTextMatch(query: string, text: string | null | undefined): number {
  const q = query.toLowerCase().trim();
  const t = String(text ?? "").toLowerCase();
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 60;
  if (q.length >= 3) {
    const sim = bigramSimilarity(q, t);
    if (sim >= 0.34) return Math.round(40 * sim);
  }
  return 0;
}

/** Best rank across several fields of one candidate record. */
export function rankFields(query: string, fields: (string | null | undefined)[]): number {
  let best = 0;
  for (const f of fields) {
    const r = rankTextMatch(query, f);
    if (r > best) best = r;
  }
  return best;
}

/** Parsed structured hints from a free-form query (C4 lightweight subset). */
export interface QueryHints {
  raw: string;
  amount: number | null;
  currency: "USD" | "VND" | null;
  directionUsdToVnd?: boolean;
  directionVndToUsd?: boolean;
  status?: string | null;
}

export function parseQueryHints(rawQuery: string): QueryHints {
  let q = String(rawQuery || "").trim();
  const hints: QueryHints = { raw: q, amount: null, currency: null };
  const statusMatch = /(?:status[:=])(completed|cancelled|active)/i.exec(q);
  if (statusMatch) {
    hints.status = statusMatch[1]?.toLowerCase() ?? null;
    q = q.replace(statusMatch[0], " ").trim();
  }
  if (/usd2vnd|usd\s*(?:->|→)\s*vnd/i.test(q)) {
    hints.directionUsdToVnd = true;
    q = q.replace(/usd2vnd|usd\s*(?:->|→)\s*vnd/i, " ").trim();
  }
  if (/vnd2usd|vnd\s*(?:->|→)\s*usd/i.test(q)) {
    hints.directionVndToUsd = true;
    q = q.replace(/vnd2usd|vnd\s*(?:->|→)\s*usd/i, " ").trim();
  }
  const amountMatch = /(\d+(?:[.,]\d+)?)\s*(usd|vnd|\$|đ|đô)?/i.exec(q);
  if (amountMatch && /^\d/.test(amountMatch[0] ?? "")) {
    const value = parseFloat(amountMatch[1]?.replace(/,/g, "") ?? "");
    if (Number.isFinite(value) && value > 0) {
      hints.amount = value;
      const cur = (amountMatch[2] || "").toLowerCase();
      if (cur === "usd" || cur === "$") hints.currency = "USD";
      else if (cur === "vnd" || cur === "đ" || cur === "đô") hints.currency = "VND";
    }
  }
  return hints;
}

export interface UnifiedSearchResults {
  customers: SearchMatch[];
  orders: SearchMatch[];
  partners: SearchMatch[];
}

const SECTION_CAP = 5;
const SCAN_CAP = 1000;

/**
 * Bounded, dependency-free unified search.pg_trgm GIN indexes (provisioned by
 * the migration) accelerate the equivalent SQL ILIKE/similarity lookups in
 * production; this bounded matcher keeps identical semantics everywhere.
 */
export async function unifiedSearch(rawQuery: string): Promise<UnifiedSearchResults> {
  const { prisma } = await import("../../database/client.js");
  const hints = parseQueryHints(rawQuery);
  const q = hints.raw;
  const empty: UnifiedSearchResults = { customers: [], orders: [], partners: [] };
  if (!q) return empty;

  // --- Customers (name / username / Telegram numeric ID / short Ref) --------
  const customers: SearchMatch[] = [];
  const customerRows: any[] = await prisma.customer.findMany({
    orderBy: { createdAt: "desc" },
    take: SCAN_CAP,
    select: { id: true, fullName: true, username: true, telegramId: true, createdAt: true }
  });
  for (const c of customerRows) {
    const shortRef = String(c.id || "").slice(-6).toUpperCase();
    const rank = Math.max(
      rankFields(q, [c.fullName, c.username ? `@${c.username}` : null]),
      /^\d+$/.test(q) ? rankTextMatch(q, String(c.telegramId ?? "")) : 0,
      rankTextMatch(q, shortRef)
    );
    if (rank > 0) {
      customers.push({
        kind: "customer",
        id: c.id,
        title: `${c.fullName || c.username || "Khách"} · TG ${c.telegramId ?? "—"}`,
        subtitle: `#KH-${shortRef}`,
        rank
      });
    }
  }
  customers.sort((a, b) => b.rank - a.rank);

  // --- Orders (Ref / customer identity / amount / memo / direction) ---------
  const orders: SearchMatch[] = [];
  const orderRows: any[] = await prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    take: SCAN_CAP,
    select: {
      id: true, customerId: true, sourceAmount: true, targetAmount: true,
      sourceCurrency: true, targetCurrency: true, status: true, transferMemo: true
    }
  });
  const customerById = new Map(customerRows.map((c: any) => [c.id, c]));
  for (const o of orderRows) {
    const customer: any = customerById.get(o.customerId);
    const ref = String(o.id || "").slice(-6).toUpperCase();
    let rank = Math.max(
      rankTextMatch(q, ref),
      rankTextMatch(q, String(o.transferMemo ?? "")),
      rankTextMatch(q, String(o.id || "")),
      customer ? rankFields(q, [customer.fullName, customer.username]) : 0,
      customer && /^\d+$/.test(q) ? rankTextMatch(q, String(customer.telegramId ?? "")) : 0
    );
    // Amount search: strong preference when a numeric amount is queried.
    if (hints.amount !== null) {
      const sourceMatch = o.sourceCurrency === (hints.currency ?? o.sourceCurrency) &&
        Number(o.sourceAmount) === hints.amount;
      const targetMatch = o.targetCurrency === (hints.currency ?? o.targetCurrency) &&
        Number(o.targetAmount) === hints.amount;
      if (sourceMatch || targetMatch) rank = Math.max(rank, 95);
      else if (hints.currency) continue; // explicit currency filter, no match
    }
    if (hints.status && o.status.toLowerCase() !== hints.status) continue;
    if (hints.directionUsdToVnd && !(o.sourceCurrency === "USD" && o.targetCurrency === "VND")) continue;
    if (hints.directionVndToUsd && !(o.sourceCurrency === "VND" && o.targetCurrency === "USD")) continue;
    if (rank > 0) {
      const who = customer ? customer.fullName || customer.username || customer.telegramId : "—";
      orders.push({
        kind: "order",
        id: o.id,
        title: `#${ref} · ${who} · ${Number(o.sourceAmount)} ${o.sourceCurrency} → ${Number(o.targetAmount)} ${o.targetCurrency}`,
        subtitle: o.status,
        rank
      });
    }
  }
  orders.sort((a, b) => b.rank - a.rank);

  // --- Partners / CTV (display name / Telegram ID / referral code) ----------
  const partners: SearchMatch[] = [];
  const partnerRows: any[] = await prisma.partner.findMany({
    orderBy: { createdAt: "desc" },
    take: SCAN_CAP,
    select: { id: true, displayName: true, telegramId: true, referralCode: true }
  });
  for (const p of partnerRows) {
    const rank = Math.max(
      rankFields(q, [p.displayName, p.referralCode]),
      /^\d+$/.test(q) ? rankTextMatch(q, String(p.telegramId ?? "")) : 0
    );
    if (rank > 0) {
      partners.push({
        kind: "partner",
        id: p.id,
        title: `${p.displayName || "CTV"}${p.telegramId ? ` · TG ${p.telegramId}` : ""}`,
        subtitle: `Mã GT: ${p.referralCode ?? "—"}`,
        rank
      });
    }
  }
  partners.sort((a, b) => b.rank - a.rank);

  return {
    customers: customers.slice(0, SECTION_CAP),
    orders: orders.slice(0, SECTION_CAP),
    partners: partners.slice(0, SECTION_CAP)
  };
}

