/**
 * QR IMPORT metadata extraction (Admin "📷 Nhập từ QR ngân hàng").
 *
 * Distinguishes KHQR (NBC / Bakong) from VietQR (NAPAS 247) by the ACTUAL
 * EMVCo payload structure — never from bank names, @suffixes, username or AI:
 *
 *   KHQR    : tag 29/30 with RID A000000727
 *             tag 29 sub: 01 = Bakong Account ID, 02 = Merchant Name, 03 = City
 *             tag 30 sub: 01 = Merchant ID,     02 = Acquiring Bank (MIS)
 *   VietQR  : tag 38 with RID A000000727
 *             tag 38 sub: 01 = Bank BIN, 02 = Consumer account number
 *
 * 6D — SOURCE AMOUNT/MEMO NEVER CONTAMINATE ACCOUNT CONFIG: tag 54 (fixed
 * amount) and tag 62 sub 05 (purpose/memo) of the source QR are captured ONLY
 * as `sourceAmount`/`sourceMemo` for preview transparency. They are NEVER
 * persisted to the PaymentAccount: runtime Order QR generation keeps using the
 * FROZEN Order amount + FROZEN Order.transferMemo (see PaymentQrService).
 *
 * 6E — PaymentAccount changes affect NEW Orders only; existing Orders keep
 * their frozen receivingAccountSnapshot (untouched by this module).
 */
import { BakongKHQR } from "bakong-khqr";

export interface ImportedQrMeta {
  provider: "KHQR" | "VIETQR";
  khqrMode?: "INDIVIDUAL" | "MERCHANT";
  khqrBakongAccountId?: string;
  khqrMerchantName?: string;
  khqrMerchantCity?: string;
  khqrMerchantId?: string;
  khqrAcquiringBank?: string;
  bankBin?: string;
  bankNumber?: string;
  /** Source-QR fixed amount — TRANSPARENCY ONLY, never saved as config (6D). */
  sourceAmount?: string;
  /** Source-QR purpose/memo — TRANSPARENCY ONLY, never saved as config (6D). */
  sourceMemo?: string;
  /** Official KHQR CRC verification result (best-effort, informational). */
  crcValid?: boolean;
}

/** Parse one EMVCo TLV payload (top-level, 2-digit length-prefixed). */
export function parseEmvTlv(payload: string): Map<string, string> {
  const tags = new Map<string, string>();
  let i = 0;
  const s = String(payload || "").trim();
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = parseInt(s.slice(i + 2, i + 4), 10);
    if (!/^\d{2}$/.test(tag) || Number.isNaN(len) || i + 4 + len > s.length) break;
    tags.set(tag, s.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return tags;
}

/** Parse the nested sub-TLVs inside a merchant-account-information tag. */
function parseNestedTlv(value: string): Map<string, string> {
  const tags = new Map<string, string>();
  let i = 0;
  while (i + 4 <= value.length) {
    const tag = value.slice(i, i + 2);
    const len = parseInt(value.slice(i + 2, i + 4), 10);
    if (!/^\d{2}$/.test(tag) || Number.isNaN(len) || i + 4 + len > value.length) break;
    tags.set(tag, value.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return tags;
}

/**
 * Build an EMVCo payload string from a flat tag map (test helper — lets tests
 * craft deterministic incomplete-KHQR fixtures without an image).
 */
export function buildEmvTlv(tags: Record<string, string>): string {
  let out = "";
  for (const tag of Object.keys(tags).sort()) {
    const value = String(tags[tag] ?? "");
    out += `${tag}${String(value.length).padStart(2, "0")}${value}`;
  }
  return out;
}

const KHQR_RID = "A000000727";
void KHQR_RID; // documentation anchor: the shared Bakong/NAPAS RID

/**
 * Classify + extract ACCOUNT metadata from a decoded QR payload string.
 * Returns null when the payload is neither KHQR nor VietQR.
 * Merchant mode is determined ONLY by the presence of the MIS tag (30) with
 * merchant fields — never inferred from the Bakong ID suffix or bank name.
 */
export function parseImportedQr(payload: string): ImportedQrMeta | null {
  const s = String(payload || "").trim();
  if (!s) return null;
  const tags = parseEmvTlv(s);
  if (tags.size === 0) return null;

  const meta: ImportedQrMeta = {} as ImportedQrMeta;

  // Source fixed amount (54) + purpose/memo (62 sub 05) — transparency only.
  meta.sourceAmount = tags.get("54") || undefined;
  const addData = tags.get("62");
  if (addData) {
    meta.sourceMemo = parseNestedTlv(addData).get("05") || undefined;
  }

  // --- KHQR: tag 29 (AIB / individual) and/or tag 30 (MIS / merchant) -------
  for (const t of ["29", "30"]) {
    const raw = tags.get(t);
    if (!raw) continue;
    const nested = parseNestedTlv(raw);
    if (nested.get("00") !== "A000000727") continue;
    if (t === "29") {
      meta.provider = "KHQR";
      meta.khqrBakongAccountId = nested.get("01") || undefined;
      meta.khqrMerchantName = nested.get("02") || undefined;
      meta.khqrMerchantCity = nested.get("03") || undefined;
    } else {
      // MIS present → genuine MERCHANT capability signal.
      meta.provider = "KHQR";
      meta.khqrMerchantId = nested.get("01") || undefined;
      meta.khqrAcquiringBank = nested.get("02") || undefined;
    }
  }

  // --- VietQR: tag 38 with RID A000000727 (bank BIN + account) --------------
  const t38raw = tags.get("38");
  if (t38raw) {
    const nested = parseNestedTlv(t38raw);
    if (nested.get("00") === "A000000727" && nested.get("01") && nested.get("02")) {
      // Tag 38 wins only when no KHQR account info was present.
      if (!meta.khqrBakongAccountId) {
        meta.provider = "VIETQR";
        meta.bankBin = nested.get("01");
        meta.bankNumber = nested.get("02");
      }
    }
  }

  if (meta.provider === "KHQR") {
    // Merchant mode determined ONLY from actual payload structure.
    meta.khqrMode =
      meta.khqrMerchantId && meta.khqrAcquiringBank ? "MERCHANT" : "INDIVIDUAL";
    // Official NBC CRC verification (best-effort, informational only).
    try {
      meta.crcValid = BakongKHQR.verify(s).isValid === true;
    } catch {
      meta.crcValid = false;
    }
  }

  return meta.provider ? meta : null;
}
