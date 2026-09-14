import { describe, it, expect, beforeAll, vi } from "vitest";
import { prisma } from "../src/database/client.js";
import {
  ADMIN_LIST_FETCH_TAKE,
  ADMIN_LIST_PAGE_SIZE,
  advanceAdminList,
  commitAdminListNext,
  decodeListCursor,
  encodeListCursor,
  ensureAdminListFilter,
  getAdminListState,
  listCursorWhere,
  retreatAdminList
} from "../src/bot/admin/admin-list-session.js";
import { searchOrders } from "../src/bot/admin/admin-orders.js";

/**
 * ADMIN SCALABLE LISTS — keyset (cursor) pagination core.
 *
 * Covers: bounded first page, next/prev, no duplicates, stable compound
 * ordering, 20/21 boundary, filter reset + persistence, per-admin isolation,
 * stale-cursor reset, deep-page traversal under concurrent inserts, empty
 * state, bounded queries (take <= 21), and unchanged search behavior.
 */

const RUN = Date.now().toString(36);

// ---------------------------------------------------------------------------
// Pure cursor helpers
// ---------------------------------------------------------------------------

describe("cursor helpers (encode/decode/predicate)", () => {
  it("J. corrupt/stale cursor decodes to null (graceful first-page reset)", () => {
    expect(decodeListCursor(null)).toBeNull();
    expect(decodeListCursor("")).toBeNull();
    expect(decodeListCursor("garbage!!!")).toBeNull();
    expect(decodeListCursor(Buffer.from("not-a-date|x", "utf8").toString("base64url"))).toBeNull();
  });

  it("E. cursor roundtrip + compound predicate (createdAt, id) DESC keyset", () => {
    const at = new Date("2026-09-14T03:00:00.000Z");
    const raw = encodeListCursor({ createdAt: at, id: "ORD-A" });
    const c = decodeListCursor(raw);
    expect(c?.createdAt.getTime()).toBe(at.getTime());
    expect(c?.id).toBe("ORD-A");
    expect(listCursorWhere(c)).toEqual({
      OR: [
        { createdAt: { lt: at } },
        { createdAt: at, id: { lt: "ORD-A" } }
      ]
    });
    expect(listCursorWhere(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session state semantics
// ---------------------------------------------------------------------------

describe("per-admin list session state", () => {
  it("G. changing the filter RESETS cursor history and position", () => {
    const admin = `pgA-${RUN}`;
    ensureAdminListFilter(admin, "orders", "need_action");
    commitAdminListNext(admin, "orders", encodeListCursor({ createdAt: new Date(), id: "ORD-1" }));
    advanceAdminList(admin, "orders");
    expect(getAdminListState(admin, "orders").pos).toBe(1);
    // Different filter → fresh state (stale cursor never reused):
    const st = ensureAdminListFilter(admin, "orders", "done");
    expect(st.filter).toBe("done");
    expect(st.history).toEqual([""]);
    expect(st.pos).toBe(0);
    expect(st.nextCursor).toBeNull();
  });

  it("H. the filter persists while paging (same filter keeps position)", () => {
    const admin = `pgB-${RUN}`;
    ensureAdminListFilter(admin, "orders", "processing");
    commitAdminListNext(admin, "orders", encodeListCursor({ createdAt: new Date(), id: "ORD-X" }));
    expect(advanceAdminList(admin, "orders")).not.toBeNull();
    const st = getAdminListState(admin, "orders");
    expect(st.filter).toBe("processing"); // unchanged while paging
    expect(st.pos).toBe(1);
  });

  it("I. Admin A pagination state never affects Admin B", () => {
    const a = `pgIso-A-${RUN}`;
    const b = `pgIso-B-${RUN}`;
    ensureAdminListFilter(a, "customers", "");
    commitAdminListNext(a, "customers", encodeListCursor({ createdAt: new Date(), id: "C-1" }));
    advanceAdminList(a, "customers");
    // B has its own isolated state:
    expect(getAdminListState(b, "customers").pos).toBe(0);
    expect(retreatAdminList(b, "customers")).toBeNull();
    expect(getAdminListState(a, "customers").pos).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DB-backed keyset traversal (Orders — the pattern shared by all 5 lists)
// ---------------------------------------------------------------------------

const PG = 45;

describe("keyset pagination over Orders (bounded keyset queries)", () => {
  let customerId = "";

  beforeAll(async () => {
    const c = await prisma.customer.create({
      data: { telegramId: `${RUN}${Math.floor(Math.random() * 1e6)}`.slice(0, 20) }
    });
    customerId = c.id;
    const rows = Array.from({ length: PG }, (_, i) => ({
      id: `ORD-PGTEST-${RUN}-${String(i).padStart(3, "0")}`,
      customerId,
      sourceCurrency: "USD",
      targetCurrency: "VND",
      sourceAmount: 1,
      targetAmount: 25000,
      rate: 25000,
      fee: 0,
      feeCurrency: "USD",
      status: "COMPLETED",
      createdAt: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 1000)
    }));
    await prisma.order.createMany({ data: rows as any });
  });

  /** Mirrors showOrderList's EXACT query shape (bounded, keyset, no OFFSET). */
  async function page(cursorRaw: string | null) {
    const where: any = { status: { in: ["COMPLETED"] } };
    const cw = listCursorWhere(decodeListCursor(cursorRaw || null));
    if (cw) where.AND = [cw];
    return prisma.order.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ADMIN_LIST_FETCH_TAKE
    });
  }

  /** Scope-bounded variant (per-fixture-customer — robust on a shared DB). */
  async function pageFor(scopeCustomerId: string, cursorRaw: string | null) {
    const where: any = { customerId: scopeCustomerId };
    const cw = listCursorWhere(decodeListCursor(cursorRaw || null));
    if (cw) where.AND = [cw];
    return prisma.order.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ADMIN_LIST_FETCH_TAKE
    });
  }

  it("N. every page fetch is bounded (take = 21, no OFFSET/SKIP)", async () => {
    const spy = vi.spyOn(prisma.order, "findMany");
    await page(null);
    const last = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as any;
    expect(last.take).toBe(ADMIN_LIST_FETCH_TAKE);
    expect(last.take).toBe(21);
    expect(last.skip).toBeUndefined(); // NO deep OFFSET/SKIP pagination
    spy.mockRestore();
  });

  it("A/B/D. first page = 20 + sentinel; next continues; no duplicates", async () => {
    const first = await page("");
    expect(first.length).toBe(ADMIN_LIST_FETCH_TAKE); // 20 + 1 sentinel
    const p1 = first.slice(0, ADMIN_LIST_PAGE_SIZE);
    expect(p1.length).toBe(20);
    const cursor = encodeListCursor(p1[p1.length - 1]);

    const second = await page(cursor);
    expect(second.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(first.slice(0, ADMIN_LIST_PAGE_SIZE).map((o: any) => o.id));
    for (const o of second) expect(ids.has(o.id)).toBe(false); // D
  });

  it("F. 45 fixture rows traverse as 20+20+5 (no total COUNT needed)", async () => {
    let cursor = "";
    const seen: string[] = [];
    for (;;) {
      const rows = await pageFor(customerId, cursor);
      const isFull = rows.length > ADMIN_LIST_PAGE_SIZE;
      for (const o of rows.slice(0, ADMIN_LIST_PAGE_SIZE)) seen.push(o.id);
      if (!isFull) break;
      cursor = encodeListCursor(rows[ADMIN_LIST_PAGE_SIZE - 1]);
      if (seen.length > 200) throw new Error("runaway pagination");
    }
    expect(seen.length).toBe(PG); // all fixture rows exactly once
    expect(new Set(seen).size).toBe(PG); // no duplicates across pages

    // Exactly-20 total for one scope ⇒ fetch returns 20, NO sentinel, no next.
    const cust2 = await prisma.customer.create({ data: { telegramId: `${RUN}x` } });
    for (let i = 0; i < 20; i++) {
      await prisma.order.create({
        data: {
          id: `ORD-PGEXACT-${RUN}-${i}`, customerId: cust2.id, sourceCurrency: "USD",
          targetCurrency: "VND", sourceAmount: 1, targetAmount: 25000, rate: 25000,
          fee: 0, feeCurrency: "USD", status: "COMPLETED",
          createdAt: new Date(Date.parse("2026-01-01T00:00:00Z") - 1000 - i)
        } as any
      });
    }
    const exact = await pageFor(cust2.id, "");
    expect(exact.length).toBe(ADMIN_LIST_PAGE_SIZE); // boundary: no 21st row
  });

  it("L. a new order inserted after page 1 does NOT corrupt page-2 traversal", async () => {
    const first = await page("");
    const p1ids = new Set(first.slice(0, ADMIN_LIST_PAGE_SIZE).map((o: any) => o.id));
    const cursor = encodeListCursor(first[ADMIN_LIST_PAGE_SIZE - 1]);

    // Concurrent insert lands ABOVE the cursor (newest):
    await prisma.order.create({
      data: {
        id: `ORD-PGNEW-${RUN}`, customerId, sourceCurrency: "USD",
        targetCurrency: "VND", sourceAmount: 1, targetAmount: 25000, rate: 25000,
        fee: 0, feeCurrency: "USD", status: "COMPLETED",
        createdAt: new Date(Date.parse("2026-01-01T00:00:00Z") + 60_000)
      } as any
    });

    const second = await page(cursor);
    const p2 = second.slice(0, ADMIN_LIST_PAGE_SIZE);
    for (const o of p2) expect(p1ids.has(o.id)).toBe(false); // no duplicates
    // Deterministic secondary ordering by id — stable traversal:
    for (let i = 1; i < p2.length; i++) {
      const prev = p2[i - 1] as any, cur = p2[i] as any;
      const ordered = prev.createdAt.getTime() > cur.createdAt.getTime() ||
        (prev.createdAt.getTime() === cur.createdAt.getTime() && prev.id > cur.id);
      expect(ordered).toBe(true);
    }
  });

  it("M. empty state: filter matching nothing yields an empty page", async () => {
    const rows = await prisma.order.findMany({
      where: { status: { in: ["MANUAL_REVIEW"] }, customerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ADMIN_LIST_FETCH_TAKE
    });
    expect(rows.length).toBe(0); // screen renders "Không có giao dịch phù hợp."
  });

  it("O. fuzzy search is separate from pagination and still resolves", async () => {
    const fullId = `ORD-PGTEST-${RUN}-044`;
    const matches = await searchOrders(fullId);
    expect(matches.some((o: any) => o.id === fullId)).toBe(true);
  });
});

