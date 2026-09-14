/**
 * CANONICAL PUBLIC ORDER REFERENCE (single source of truth).
 *
 * Identity semantics:
 *   Order.id    = internal DB primary key (callbacks / FK only — never UI).
 *   publicRef   = the ONE human-friendly public Order reference shown to
 *                 customer / Admin / CSKH / CTV commission rows.
 *   transferMemo= bank transfer memo (payment matching) — NEVER an Order ref.
 *
 * publicRef is generated once at Order creation (UPPER(RIGHT(id,6)) preferred
 * for UX continuity) with bounded disambiguation on the rare suffix collision
 * (6 → 8 → 12 chars → full id). It is UNIQUE and IMMUTABLE — never rewritten.
 */
export interface OrderRefLike {
  publicRef?: string | null;
  id: string;
}

/** Raw public ref (no "#"): stored publicRef, or the legacy derived suffix. */
export function orderPublicRef(order: OrderRefLike): string {
  const stored = String(order.publicRef || "").trim();
  if (stored) return stored.toUpperCase();
  return String(order.id || "").slice(-6).toUpperCase();
}

/** THE canonical display form: "#N-5OQL". */
export function formatPublicOrderRef(order: OrderRefLike | string): string {
  if (typeof order === "string") return `#${String(order).slice(-6).toUpperCase()}`;
  return `#${orderPublicRef(order)}`;
}

/**
 * Candidate public refs, in the documented UX order:
 *   RIGHT(id,6) → RIGHT(id,8) → RIGHT(id,12) → full id.
 * Short ids collapse into fewer distinct candidates (Set dedupe); a
 * missing/blank id yields no candidate at all.
 */
export function candidatePublicRefs(orderId: string): string[] {
  const raw = String(orderId || "").trim().toUpperCase();
  if (!raw) return [];
  return [...new Set([raw.slice(-6), raw.slice(-8), raw.slice(-12), raw])];
}

/**
 * Generate a collision-safe public Order reference inside the caller's
 * transaction. Candidates are tried in the documented UX order; the final
 * full ID is retained as a deterministic fallback for malformed/short IDs.
 */
export async function generateOrderRef(
  prisma: {
    order: {
      /**
       * Structural view of the Order delegate — satisfied by both the
       * PrismaClient and a Prisma transaction client, so callers pass
       * whatever client their transaction is running on.
       */
      findFirst(args: { where: { publicRef: string }; select: { id: true } }): Promise<any>;
    };
  },
  orderId: string
): Promise<string> {
  for (const candidate of candidatePublicRefs(orderId)) {
    const clash = await prisma.order.findFirst({
      where: { publicRef: candidate },
      select: { id: true }
    });
    if (!clash) return candidate;
  }

  // A full ID is unique by the Order.id constraint, but retain the defensive
  // loop for callers that may be using a non-standard Prisma adapter.
  const fallback = String(orderId || "").toUpperCase();
  const fallbackClash = await prisma.order.findFirst({
    where: { publicRef: fallback },
    select: { id: true }
  });
  if (!fallbackClash) return fallback;
  throw new Error(`Unable to generate a unique public ref for order ${orderId}`);
}

