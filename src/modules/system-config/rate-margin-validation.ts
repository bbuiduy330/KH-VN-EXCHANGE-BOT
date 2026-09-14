import { Decimal } from "decimal.js";

/**
 * Pure margin validation — NO Telegram/grammY/Admin UI dependencies.
 *
 * Shared by BOTH:
 *   - RuntimeConfigService setters (domain layer)
 *   - Admin margin input flow (bot layer, via import)
 *
 * Allowed dependency direction:
 *   bot/admin/*  ──►  modules/system-config/rate-margin-validation.ts
 *   modules/system-config/*  ──►  modules/system-config/rate-margin-validation.ts
 *
 * Forbidden:
 *   modules/system-config/*  ──►  bot/admin/*
 */

export interface MarginValidationResult {
  success: boolean;
  value: number | null;
  error: string | null;
}

const MAX_MARGIN_VND = 10000;

/**
 * Validate margin input: integer VND units only.
 *
 * Rejects:
 *   - empty / whitespace-only
 *   - NaN / Infinity
 *   - negative values
 *   - decimal values (e.g. "200.5")
 *   - thousands separators (e.g. "1.000", "1,000")
 *   - arbitrary text
 *   - values > 10,000 VND
 *
 * For BUY margin with a known baseRate, also enforces:
 *   baseRate - buyMargin > 0
 *
 * Does NOT round or truncate.
 */
export function parseAndValidateMargin(
  raw: string,
  baseRate?: number,
  isBuy?: boolean
): MarginValidationResult {
  const rawTrimmed = raw.trim();

  // Reject empty
  if (!rawTrimmed) {
    return { success: false, value: null, error: "Không được để trống" };
  }

  // Reject NaN/Infinity explicitly
  if (!Number.isFinite(Number(rawTrimmed))) {
    return { success: false, value: null, error: "Không phải số hợp lệ (NaN/Infinity)" };
  }

  // Reject non-integer: decimal points or thousands separators
  if (/[.,]/.test(rawTrimmed)) {
    return { success: false, value: null, error: "Chỉ chấp nhận số nguyên (không dấu thập phân)" };
  }

  const digitsOnly = rawTrimmed.replace(/\s+/g, "");
  if (!/^\d+$/.test(digitsOnly)) {
    return { success: false, value: null, error: "Chỉ chấp nhận số nguyên" };
  }

  const value = Number(digitsOnly);
  if (!Number.isFinite(value)) {
    return { success: false, value: null, error: "Không phải số hợp lệ" };
  }

  // Negative
  if (value < 0) {
    return { success: false, value: null, error: "Không được âm" };
  }

  // > 10,000 VND
  if (value > MAX_MARGIN_VND) {
    return { success: false, value: null, error: `Giá trị tối đa ${MAX_MARGIN_VND.toLocaleString()} VND` };
  }

  // For BUY margin: baseRate - buyMargin must be > 0
  if (isBuy === true && baseRate !== undefined && baseRate !== null) {
    const effective = baseRate - value;
    if (effective <= 0) {
      return {
        success: false,
        value: null,
        error: `baseRate (${baseRate}) − buyMargin (${value}) = ${effective} ≤ 0. Effective buy rate phải > 0.`
      };
    }
  }

  return { success: true, value, error: null };
}