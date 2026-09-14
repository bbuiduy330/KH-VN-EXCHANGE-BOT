/**
 * ADMIN SCALABLE LISTS — keyset (cursor) pagination core.
 *
 * Shared by Orders / Customers / Partners / Commissions / Activity screens:
 *   - SERVER-SIDE cursor pagination: ORDER BY createdAt DESC, id DESC,
 *     WHERE (createdAt, id) < cursor — TAKE page+1; the +1 sentinel row only
 *     decides "has next". No total COUNT(*), no deep OFFSET.
 *   - Deterministic secondary ordering by id: concurrent inserts above the
 *     cursor can never duplicate or skip rows.
 *   - Cursor payload is the MINIMAL safe state (ISO timestamp + id), base64url
 *     encoded — no private/business data inside callback_data.
 *   - Backward navigation via per-admin cursor HISTORY in session state
 *     (never large JSON in callback_data). History is bounded.
 *   - State scoped by `${telegramId}|${screen}`: Admin A never affects Admin B;
 *     screens ("orders" / "customers" / ...) and their active filters are part
 *     of the key context.
 *   - Stale/corrupt cursor (restart, expired): decode returns null and callers
 *     gracefully render the first page.
 *   - Filter change: cursor history RESET — a stale cursor from a previous
 *     filter is never reused.
 */

export const ADMIN_LIST_PAGE_SIZE = 20;
/** DB fetch = page size + 1 sentinel row (existence of next page). */
export const ADMIN_LIST_FETCH_TAKE = ADMIN_LIST_PAGE_SIZE + 1;
/** Bounded backward history per (admin, screen). */
export const ADMIN_LIST_MAX_HISTORY = 100;
/** Raw scan cap for feeds that post-filter in JS (bounded per page request). */
export const ADMIN_LIST_SCAN_CAP = 200;
/** Activity incremental scan: raw rows per batch / hard cap per page request. */
export const ADMIN_LIST_SCAN_BATCH = 100;
export const ADMIN_LIST_RAW_SCAN_CAP = 1000;

/**
 * First raw-scan batch starts strictly after the PAGE cursor (or from the top).
 */
export function scanCursorForBatch(pageCursor: { createdAt: Date; id: string } | null): { createdAt: Date; id: string } | null {
  return pageCursor;
}

export interface ListCursor {
  createdAt: Date;
  id: string;
}

/** Encode the minimal safe cursor (base64url, tiny — callback-safe). */
export function encodeListCursor(c: { createdAt: Date | string; id: string }): string {
  const iso = c.createdAt instanceof Date ? c.createdAt.toISOString() : new Date(c.createdAt).toISOString();
  return Buffer.from(`${iso}|${c.id}`, "utf8").toString("base64url");
}

/** Decode a cursor; null when absent/corrupt (callers reset to first page). */
export function decodeListCursor(raw: string | null | undefined): ListCursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.indexOf("|");
    if (sep <= 0) return null;
    const createdAt = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Compound keyset predicate: (createdAt, id) strictly BEFORE the cursor.
 *   createdAt < c OR (createdAt = c AND id < c.id)
 * Returns null when no cursor (first page).
 */
export function listCursorWhere(cursor: ListCursor | null): { OR: Record<string, unknown>[] } | null {
  if (!cursor) return null;
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } }
    ]
  };
}

// ---------------------------------------------------------------------------
// Per-admin, per-screen list state (process memory — no schema change)
// ---------------------------------------------------------------------------

export interface AdminListState {
  /** Active filter key (order group / commission status / activity section). */
  filter: string;
  /** history[i] = cursor used to render page i ("" = first page). */
  history: string[];
  /** Current page index within history. */
  pos: number;
  /** Cursor for the NEXT page, or null when the current page is the last. */
  nextCursor: string | null;
}

const lists = new Map<string, AdminListState>();

function keyOf(adminId: string, screen: string): string {
  return `${String(adminId || "").trim()}|${screen}`;
}

function emptyListState(filter: string): AdminListState {
  return { filter, history: [""], pos: 0, nextCursor: null };
}

/** The isolated list state for one admin + screen (created on demand). */
export function getAdminListState(adminId: string, screen: string): AdminListState {
  const key = keyOf(adminId, screen);
  let state = lists.get(key);
  if (!state) {
    state = emptyListState("");
    lists.set(key, state);
  }
  return state;
}

/**
 * Ensure the state matches the requested filter. A DIFFERENT filter resets
 * the cursor history (stale cursors from a previous filter are never reused).
 */
export function ensureAdminListFilter(adminId: string, screen: string, filter: string): AdminListState {
  const key = keyOf(adminId, screen);
  const state = lists.get(key);
  if (!state || state.filter !== filter) {
    const fresh = emptyListState(filter);
    lists.set(key, fresh);
    return fresh;
  }
  return state;
}

/** Store the next-page cursor after a page was rendered. */
export function commitAdminListNext(adminId: string, screen: string, nextCursor: string | null): void {
  const state = getAdminListState(adminId, screen);
  state.nextCursor = nextCursor || null;
}

/** Move to the NEXT page using the stored next cursor. Returns null at the end. */
export function advanceAdminList(adminId: string, screen: string): string | null {
  const state = getAdminListState(adminId, screen);
  if (!state.nextCursor) return null;
  const history = [...state.history.slice(0, state.pos + 1), state.nextCursor].slice(-ADMIN_LIST_MAX_HISTORY);
  state.history = history;
  state.pos = history.length - 1;
  return state.nextCursor;
}

/** Move to the PREVIOUS page via cursor history. Returns null on the first page. */
export function retreatAdminList(adminId: string, screen: string): string | null {
  const state = getAdminListState(adminId, screen);
  if (state.pos <= 0) return null;
  state.pos -= 1;
  return state.history[state.pos] || "";
}

/** Reset one list (screen switch / explicit back-to-first-page). */
export function resetAdminList(adminId: string, screen: string, filter: string = ""): void {
  lists.set(keyOf(adminId, screen), emptyListState(filter));
}
