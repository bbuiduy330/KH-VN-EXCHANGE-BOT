/**
 * PaymentQrService — DYNAMIC PAYMENT QR V1 (isolated feature module).
 *
 * Generates an Order-specific payment QR AFTER quote confirmation, using ONLY
 * FROZEN Order data (sourceAmount / sourceCurrency / transferMemo /
 * receivingAccountSnapshot) — NO quote/rate recalculation, NO fresh mutable
 * config, NO AI involvement (this module deliberately imports nothing from
 * the AI layer).
 *
 * Provider selection (pure, currency-driven):
 *   incoming USD + KHQR metadata  -> KHQR   (official NBC `bakong-khqr` SDK;
 *                                            currency USD; CRC by the SDK)
 *   incoming VND + bankBin        -> VIETQR (`vietnam-qr-pay` NAPAS EMV
 *                                            builder; CRC by the library)
 *   otherwise / metadata missing / generation failure -> STATIC fallback
 *   (configured PaymentAccount QR) -> text-only payment info.
 * Dynamic failure NEVER blocks Order creation; never sends empty/broken QR.
 *
 * Payload -> PNG via local `qrcode` (width 512). No external HTTP service.
 *
 * EXPIRATION: KHQR dynamic officially supports expirationTimestamp — set to
 * the authoritative UNPAID-ORDER AUTO-CANCEL window (AUTO_CANCEL_MIN from
 * payment-reminder-service; NOT the 10-minute quote validity). VietQR
 * dynamic payloads have no expiration field.
 */
import { Decimal } from "decimal.js";
import { BakongKHQR, IndividualInfo, MerchantInfo, khqrData } from "bakong-khqr";
import { QRPay } from "vietnam-qr-pay";
import QRCode from "qrcode";
import { logger } from "../../shared/logger.js";
import { OrderService } from "../orders/order-service.js";
import { FileService } from "../files/file-service.js";
import { AUTO_CANCEL_MIN } from "../orders/payment-reminder-service.js";

export type PaymentQrType = "KHQR" | "VIETQR" | "STATIC" | "EXPIRED" | "NONE";

export interface PaymentQrResult {
  type: PaymentQrType;
  /** QR image PNG buffer ready for Telegram sendPhoto (null for NONE). */
  imageBuffer: Buffer | null;
  /** Exact locked Order payment amount (string form; never recomputed). */
  amount: string;
  /** Order payment currency (= incoming currency). */
  currency: string;
  /** Exact FROZEN Order.transferMemo. */
  memo: string;
  /** Short order ref used in the customer card (#XXXXXX). */
  orderRef: string;
  /** Raw EMV payload (dynamic providers only). NEVER logged with metadata. */
  payload?: string;
  /** Non-fatal note when dynamic generation degraded to STATIC/NONE. */
  degradedReason?: string;
}

/** Normalized VND amount: integer string (VND has no minor units). */
export function normalizeVndAmountString(amountValue: unknown): string {
  return new Decimal(String(amountValue ?? 0))
    .toDecimalPlaces(0)
    .toString();
}

/** USD amount: precision-preserving string (no float math, no rounding). */
export function normalizeUsdAmountString(amountValue: unknown): string {
  return new Decimal(String(amountValue ?? 0)).toString();
}

// ---------------------------------------------------------------------------
// Capability detection — reads ONLY the Order's FROZEN receiving-account
// snapshot (keys populated at Order creation from PaymentAccount metadata):
//   KHQR:   khqrMode (INDIVIDUAL|MERCHANT), khqrBakongAccountId,
//           khqrMerchantName, khqrMerchantCity, khqrMerchantId?,
//           khqrAcquiringBank?   (MERCHANT requires merchantId + acquiringBank)
//   VIETQR: bankBin (+ snapshot accountNumber)
// ---------------------------------------------------------------------------
export interface KhqrCapability {
  mode: "INDIVIDUAL" | "MERCHANT";
  bakongAccountId: string;
  merchantName: string;
  merchantCity: string;
  merchantId?: string;
  acquiringBank?: string;
}

export interface VietQrCapability {
  bankBin: string;
  bankNumber: string;
}

function readSnapshot(snapshot: unknown): Record<string, unknown> {
  return snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>) : {};
}

export function detectKhqrCapability(snapshot: unknown): KhqrCapability | null {
  const s = readSnapshot(snapshot);
  const bakongAccountId = String(s.khqrBakongAccountId ?? "").trim();
  const merchantName = String(s.khqrMerchantName ?? "").trim();
  const merchantCity = String(s.khqrMerchantCity ?? "").trim();
  if (!bakongAccountId || !merchantName || !merchantCity) return null;
  const mode = String(s.khqrMode ?? "INDIVIDUAL").toUpperCase();
  if (mode !== "INDIVIDUAL" && mode !== "MERCHANT") return null;
  const merchantId = String(s.khqrMerchantId ?? "").trim();
  const acquiringBank = String(s.khqrAcquiringBank ?? "").trim();
  // MERCHANT mode requires merchantID + acquiringBank per the official SDK.
  if (mode === "MERCHANT" && (!merchantId || !acquiringBank)) return null;
  return {
    mode,
    bakongAccountId,
    merchantName,
    merchantCity,
    merchantId: merchantId || undefined,
    acquiringBank: acquiringBank || undefined
  };
}

export function detectVietQrCapability(snapshot: unknown): VietQrCapability | null {
  const s = readSnapshot(snapshot);
  const bankBin = String(s.bankBin ?? "").trim();
  const bankNumber = String(s.accountNumber ?? "").trim();
  if (!bankBin || !bankNumber) return null;
  return { bankBin, bankNumber };
}

// ---------------------------------------------------------------------------
// QR READINESS — shared Admin-facing explanation (single source of truth).
//
// Uses the EXACT SAME capability detectors as generateForOrder, so the Admin
// readiness screen can never disagree with actual runtime behavior. Accepts
// either a PaymentAccount row or a frozen receivingAccountSnapshot — both
// carry the same metadata keys.
// ---------------------------------------------------------------------------
export interface QrReadiness {
  provider: "KHQR" | "VIETQR" | "STATIC";
  ready: boolean;
  /** Human-readable list of missing metadata (Admin UI, Vietnamese). */
  missing: string[];
}

export function getQrReadiness(account: {
  currency?: string | null;
  qrProvider?: string | null;
  bankBin?: string | null;
  accountNumber?: string | null;
  khqrMode?: string | null;
  khqrBakongAccountId?: string | null;
  khqrMerchantName?: string | null;
  khqrMerchantCity?: string | null;
  khqrMerchantId?: string | null;
  khqrAcquiringBank?: string | null;
}): QrReadiness {
  const currency = String(account.currency ?? "").toUpperCase();
  const missing: string[] = [];

  if (currency === "USD") {
    const cap = detectKhqrCapability(account);
    const bakong = String(account.khqrBakongAccountId ?? "").trim();
    const name = String(account.khqrMerchantName ?? "").trim();
    const city = String(account.khqrMerchantCity ?? "").trim();
    const mode = String(account.khqrMode ?? "INDIVIDUAL").toUpperCase() === "MERCHANT" ? "MERCHANT" : "INDIVIDUAL";
    if (!bakong) missing.push("Bakong Account ID (name@bank)");
    if (!name) missing.push("Tên hiển thị");
    if (!city) missing.push("Thành phố");
    if (mode === "MERCHANT") {
      if (!String(account.khqrMerchantId ?? "").trim()) missing.push("Merchant ID");
      if (!String(account.khqrAcquiringBank ?? "").trim()) missing.push("Acquiring Bank");
    }
    return { provider: "KHQR", ready: cap !== null, missing };
  }

  if (currency === "VND") {
    const cap = detectVietQrCapability(account);
    if (!String(account.bankBin ?? "").trim()) missing.push("Bank BIN (VietQR)");
    if (!String(account.accountNumber ?? "").trim()) missing.push("Số tài khoản");
    return { provider: "VIETQR", ready: cap !== null, missing };
  }

  return { provider: "STATIC", ready: false, missing: [`Không hỗ trợ QR động cho tiền ${currency || "?"}`] };
}

/**
 * KHQR expiration correctness (final pass): the dynamic QR expiration is the
 * ORDER's original payment deadline — Order.createdAt + the authoritative
 * unpaid-order auto-cancel window (AUTO_CANCEL_MIN). It is NEVER
 * "now + window", because payinfo re-display must not extend the payment
 * lifetime. Single source of truth: AUTO_CANCEL_MIN (no second constant).
 */
export function computePaymentDeadlineMs(order: { createdAt: Date | string }): number {
  return new Date(order.createdAt).getTime() + AUTO_CANCEL_MIN * 60_000;
}

// ---------------------------------------------------------------------------
// Provider payload builders — OFFICIAL SDKs ONLY (CRC computed by the SDK/lib;
// never hand-rolled). Amount values come from the FROZEN Order; the amount
// encoded here is the SAME normalized string shown in the Telegram caption.
// ---------------------------------------------------------------------------

/** KHQR dynamic payload — official NBC `BakongKHQR` (currency = USD). */
export function buildKhqrPayload(
  cap: KhqrCapability,
  amountString: string,
  billNumber: string,
  /** Fixed per-Order expiration (epoch ms) — derived from createdAt, NEVER from
   *  the current time, so re-displaying the QR cannot extend payment lifetime. */
  expirationTimestampMs: number
): string {
  const optional = {
    currency: khqrData.currency.usd, // KHQR currency = USD for USD incoming
    amount: amountString, // dynamic QR: amount > 0 (official requirement)
    billNumber, // officially supported short reference field = transfer memo
    // Official dynamic-QR expiration — fixed payment deadline of THIS Order.
    expirationTimestamp: String(expirationTimestampMs)
  };
  const sdk = new BakongKHQR();
  const response =
    cap.mode === "MERCHANT"
      ? sdk.generateMerchant(
          new MerchantInfo(
            cap.bakongAccountId,
            cap.merchantName,
            cap.merchantCity,
            cap.merchantId!,
            cap.acquiringBank!,
            optional
          )
        )
      : sdk.generateIndividual(
          new IndividualInfo(cap.bakongAccountId, cap.merchantName, cap.merchantCity, optional)
        );

  const payload = String(response?.qr || "").trim();
  if (!payload) {
    // SDK returns { status: {...} } on validation failure — never a payload.
    throw new Error(`KHQR generation rejected by official SDK (mode: ${cap.mode})`);
  }
  // Official SDK checksum verification — never trust an invalid payload.
  if (!BakongKHQR.verify(payload).isValid) {
    throw new Error("KHQR payload failed official CRC validation");
  }
  return payload;
}

/** VietQR dynamic payload — `vietnam-qr-pay` (VND, integer-normalized). */
export function buildVietQrPayload(
  cap: VietQrCapability,
  amountString: string,
  purpose: string
): string {
  const qrPay = QRPay.initVietQR({
    bankBin: cap.bankBin,
    bankNumber: cap.bankNumber,
    amount: normalizeVndAmountString(amountString), // exact locked VND integer
    purpose // addInfo = FROZEN transfer memo
  });
  const payload = qrPay.build();
  if (!payload) throw new Error("VietQR build produced an empty payload");
  // Library-side CRC validation of the built payload.
  if (!new QRPay(payload).isValid) {
    throw new Error("VietQR payload failed library CRC validation");
  }
  return payload;
}

/** Local payload -> PNG buffer (`qrcode`, no external HTTP service). */
export async function renderQrPng(payload: string): Promise<Buffer> {
  const buffer = await QRCode.toBuffer(payload, {
    type: "png",
    width: 512,
    margin: 1,
    errorCorrectionLevel: "M"
  });
  if (!buffer || buffer.length === 0) throw new Error("QR rendering produced an empty buffer");
  return buffer;
}

export class PaymentQrService {
  /**
   * Generates the Order-specific payment QR. NEVER throws for generation
   * problems (degrades STATIC → NONE) and NEVER mutates the Order.
   * Returns null only when the Order does not exist / is not actively
   * awaiting payment (verified/cancelled orders are not presented as QR).
   */
  static async generateForOrder(orderId: string): Promise<PaymentQrResult | null> {
    const order = await OrderService.getOrder(orderId);
    if (!order || order.status !== "WAITING_PAYMENT") return null;

    const snapshot = readSnapshot(order.receivingAccountSnapshot);
    const amount = normalizeUsdAmountString(order.sourceAmount);
    const currency = String(order.sourceCurrency || "");
    // FROZEN Order.transferMemo (legacy-null fallback inside the accessor).
    const memo = await OrderService.getOrderTransferMemo(order);
    const orderRef = `#${order.id.slice(-6).toUpperCase()}`;
    const fileBuffer = snapshot.qrFilePath
      ? await FileService.getFile(String(snapshot.qrFilePath)).catch(() => null)
      : null;

    // 1. EXPIRED safety (final pass): once the Order payment deadline has
    // passed, NO payment method is presented — no dynamic QR, no static QR,
    // no normal payment-account text card. The scheduler remains authoritative
    // for the WAITING_PAYMENT → CANCELLED transition; this only closes the
    // scheduler-lag window. The Order is never mutated here and no new
    // quote/order is created.
    // Deadline derived ONCE from the FROZEN Order.createdAt — never from
    // Date.now() + timeout, so re-display cannot extend the payment lifetime.
    const paymentDeadlineMs = computePaymentDeadlineMs(order);
    if (Date.now() >= paymentDeadlineMs) {
      logger.info({ orderRef }, "PaymentQr: payment deadline reached — EXPIRED (no payment method presented)");
      return {
        type: "EXPIRED",
        imageBuffer: null,
        amount,
        currency,
        memo,
        orderRef,
        degradedReason: "PAYMENT_DEADLINE_REACHED"
      };
    }

    // 2. Dynamic generation by incoming payment currency.
    try {
      if (currency === "USD") {
        const cap = detectKhqrCapability(order.receivingAccountSnapshot);
        if (cap) {
          const payload = buildKhqrPayload(cap, amount, memo, paymentDeadlineMs);
          const imageBuffer = await renderQrPng(payload);
          return { type: "KHQR", imageBuffer, amount, currency, memo, orderRef, payload };
        }
      } else if (currency === "VND") {
        const cap = detectVietQrCapability(order.receivingAccountSnapshot);
        if (cap) {
          const amountString = normalizeVndAmountString(order.sourceAmount);
          const payload = buildVietQrPayload(cap, amountString, memo);
          const imageBuffer = await renderQrPng(payload);
          return { type: "VIETQR", imageBuffer, amount: amountString, currency, memo, orderRef, payload };
        }
      }
    } catch (err: any) {
      // Safe warning WITHOUT full account details or QR payloads.
      logger.warn(
        { err: err?.message, orderRef, currency },
        "PaymentQr: dynamic generation failed — falling back to configured static QR"
      );
      if (fileBuffer) {
        return { type: "STATIC", imageBuffer: fileBuffer, amount, currency, memo, orderRef, degradedReason: "DYNAMIC_FAILED" };
      }
      logger.warn({ orderRef }, "PaymentQr: static QR file missing — text payment info only");
      return { type: "NONE", imageBuffer: null, amount, currency, memo, orderRef, degradedReason: "DYNAMIC_FAILED_NO_STATIC" };
    }

    // 2b. No dynamic capability for this currency/account → STATIC fallback.
    if (fileBuffer) {
      return { type: "STATIC", imageBuffer: fileBuffer, amount, currency, memo, orderRef };
    }

    // 3. No QR available at all — Order survives with text payment info only.
    logger.warn({ orderRef }, "PaymentQr: no QR available — text payment info only");
    return { type: "NONE", imageBuffer: null, amount, currency, memo, orderRef, degradedReason: "NO_QR" };
  }
}

