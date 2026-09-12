/**
 * QR IMPORT metadata extraction (Admin "📷 Nhập từ QR ngân hàng").
 *
 * Distinguishes KHQR (NBC / Bakong) from VietQR (NAPAS 247) by the ACTUAL
 * EMVCo payload structure — never from bank names, @suffixes, username or AI:
 *
 *   KHQR    : tag 29 (AIB / individual) or tag 30 (MIS / merchant), in BOTH
 *             real templates — GUID-first (00 = A000000727, 01 = Bakong ID,
 *             02 = name, 03 = city) AND Bakong-ID-first (00 = xxx@yyy,
 *             01 = merchant/account ID, 02 = acquiring bank; 59/60 = name/city,
 *             58 = KH). KHQR detection NEVER requires A000000727.
 *   VietQR  : tag 38 with GUID A000000727, parsed via `vietnam-qr-pay` plus
 *             explicit nested-TLV extraction (38/01 can be ITSELF a nested
 *             TLV: {00: BIN, 01: account}; 38/02 = service "QRIBFTTA").
 *             See the detailed docstring on parseImportedQr.
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
import { QRPay } from "vietnam-qr-pay";

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
  /** VietQR service code (e.g. "QRIBFTTA") — informational, never persisted. */
  service?: string;
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
void KHQR_RID; // documentation anchor: the shared Bakong/NAPAS GUID

/**
 * Deterministic EMVCo CRC-16/CCITT-FALSE check (the CRC both KHQR and VietQR
 * payloads carry in tag 63). The 4-char checksum is the LAST 4 characters; the
 * CRC is computed over everything before them (including the "6304" tag).
 */
function crc16CcittFalse(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function isEmvCrcValid(payload: string): boolean {
  const s = String(payload || "").trim();
  if (s.length < 8 || !/6304[0-9A-Fa-f]{4}$/.test(s)) return false;
  const expected = s.slice(-4).toUpperCase();
  return crc16CcittFalse(s.slice(0, s.length - 4)) === expected;
}

/**
 * Classify + extract ACCOUNT metadata from a decoded QR payload string.
 * Returns null when the payload is neither KHQR nor VietQR.
 *
 * KHQR (Bakong/NBC) is detected by the ACTUAL KHQR structure — it NEVER
 * requires the VietQR/NAPAS GUID A000000727:
 *   - Standard template (tag 29 AIB / tag 30 MIS), GUID-first:
 *       00 = A000000727, 01 = Bakong Account ID, 02 = name, 03 = city
 *   - Bank-real template (real ABA/USD QRs), Bakong-ID-first:
 *       00 = Bakong Account ID (xxx@yyy), 01 = merchant/account ID,
 *       02 = acquiring bank (+ EMVCo tags 59 name / 60 city, 58 = KH)
 * Merchant mode follows NBC semantics: tag 30 (MIS) with merchant ID +
 * acquiring bank ⇒ MERCHANT; tag 29 (AIB) ⇒ INDIVIDUAL. Never guessed.
 *
 * VietQR (NAPAS 247) is detected by tag 38 with GUID A000000727 and parsed
 * with the installed `vietnam-qr-pay` parser where authoritative; explicit
 * nested-TLV extraction handles the real bank layouts the flat parser got
 * wrong (tag 38/01 is ITSELF a nested TLV — never 38/01-as-BIN, never
 * 38/02-as-account).
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
    const first = nested.get("00") || "";
    if (first === "A000000727") {
      // Standard GUID-first KHQR template.
      meta.provider = "KHQR";
      meta.khqrBakongAccountId = nested.get("01") || undefined;
      meta.khqrMerchantName = nested.get("02") || undefined;
      meta.khqrMerchantCity = nested.get("03") || undefined;
    } else if (first.includes("@") && tags.get("58") === "KH") {
      // Bank-real Bakong-ID-first template (e.g. real ABA/USD KHQR):
      // 00 = Bakong Account ID, 01 = merchant/account ID, 02 = acquiring bank.
      meta.provider = "KHQR";
      meta.khqrBakongAccountId = first;
      meta.khqrMerchantId = nested.get("01") || undefined;
      meta.khqrAcquiringBank = nested.get("02") || undefined;
    }
  }

  if (meta.provider === "KHQR") {
    // Human merchant name / city: template fields first, EMVCo 59/60 fallback.
    meta.khqrMerchantName = meta.khqrMerchantName || tags.get("59") || undefined;
    meta.khqrMerchantCity = meta.khqrMerchantCity || tags.get("60") || undefined;
    // Mode per NBC KHQR semantics (never guessed from names/suffixes).
    meta.khqrMode =
      meta.khqrMerchantId && meta.khqrAcquiringBank ? "MERCHANT" : "INDIVIDUAL";
    // CRC: installed Bakong SDK first; deterministic EMVCo CRC-16 fallback so
    // a CRC-valid bank-real template is never wrongly flagged by SDK strictness.
    let crcValid: boolean | undefined;
    try {
      crcValid = BakongKHQR.verify(s).isValid === true;
    } catch {
      crcValid = undefined;
    }
    if (crcValid !== true) crcValid = isEmvCrcValid(s);
    meta.crcValid = crcValid;
  }

  // --- VietQR: tag 38 with provider GUID A000000727 (NAPAS 247) --------------
  // Detected + parsed with the installed `vietnam-qr-pay` parser where
  // authoritative; explicit nested-TLV extraction handles the real bank
  // layouts the flat parse got wrong (38/01 is ITSELF a nested TLV — never
  // 38/01-as-BIN, never 38/02-as-account).
  const t38raw = tags.get("38");
  if (t38raw && !meta.khqrBakongAccountId) {
    const nested = parseNestedTlv(t38raw);
    if (nested.get("00") === "A000000727") {
      const s1 = nested.get("01") || "";
      const s2 = nested.get("02") || "";
      const n1 = parseNestedTlv(s1);
      const n2 = parseNestedTlv(s2);

      let bankBin: string | undefined;
      let bankNumber: string | undefined;
      let service: string | undefined;

      // 1) Authoritative `vietnam-qr-pay` parse — accepted only when the BIN
      //    passes a sanity check (a flat mis-read of a nested 38/01 yields a
      //    ~24-digit string that is rejected here).
      try {
        const qrPay = new QRPay(s);
        const consumerBin = String(qrPay.consumer?.bankBin ?? "");
        const consumerNum = String(qrPay.consumer?.bankNumber ?? "");
        if (consumerBin && consumerNum && /^\d{4,8}$/.test(consumerBin)) {
          bankBin = consumerBin;
          bankNumber = consumerNum;
        }
      } catch {
        // fall through to the explicit nested-TLV extraction
      }

      // 2) Explicit nested-TLV extraction for real bank layouts.
      if (!bankBin || !bankNumber) {
        if (n1.get("00") && n1.get("01")) {
          // Bank-real layout (e.g. BIDV): 38/01 = nested {00: BIN, 01: account},
          // 38/02 = service ("QRIBFTTA").
          bankBin = n1.get("00");
          bankNumber = n1.get("01");
          service = s2 || undefined;
        } else if (n2.get("01") && n2.get("02")) {
          // NAPAS template: 38/01 = service, 38/02 = nested {01: BIN, 02: account}.
          bankBin = n2.get("01");
          bankNumber = n2.get("02");
          service = s1 || undefined;
        } else if (n1.get("01") && n1.get("02")) {
          // Alternative nested consumer template inside 38/01.
          bankBin = n1.get("01");
          bankNumber = n1.get("02");
          service = s2 || undefined;
        } else if (/^\d{4,8}$/.test(s1) && s2) {
          // Plain layout (38/01 = BIN, 38/02 = account) — legacy/simple QRs.
          bankBin = s1;
          bankNumber = s2;
        }
      } else {
        // Library succeeded — recover the service code when present.
        if (n1.get("00") && n1.get("01")) service = s2 || undefined;
        else if ((n2.get("01") && n2.get("02")) || (n1.get("01") && n1.get("02"))) service = s1 || undefined;
        else if (/^QR[A-Z0-9]{2,14}$/.test(s2)) service = s2;
        else if (/^QR[A-Z0-9]{2,14}$/.test(s1)) service = s1;
      }

      if (bankBin && bankNumber) {
        meta.provider = "VIETQR";
        meta.bankBin = bankBin;
        meta.bankNumber = bankNumber;
        meta.service = service;
      }
    }
  }

  return meta.provider ? meta : null;
}
