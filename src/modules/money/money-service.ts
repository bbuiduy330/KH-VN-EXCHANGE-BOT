import { Decimal } from "decimal.js";

export class MoneyService {
  private static readonly CURRENCY_DECIMALS: Record<string, number> = {
    USD: 2,
    VND: 0,
    KHR: 0
  };

  // Human amount multipliers (normalized: lowercase, no diacritics).
  // "k" is ALWAYS a multiplier, never a currency.
  private static readonly AMOUNT_MULTIPLIERS: Record<string, number> = {
    m: 1000000,
    tr: 1000000,
    trieu: 1000000,
    k: 1000,
    nghin: 1000,
    ngan: 1000
  };

  /**
   * Returns decimal places allowed for the currency (default 2)
   */
  static getDecimals(currency: string): number {
    const code = currency.toUpperCase().trim();
    return this.CURRENCY_DECIMALS[code] ?? 2;
  }

  /**
   * Validates margins:
   * buyMargin >= 0 (subtracted from base)
   * sellMargin >= 0 (added to base)
   */
  static validateMargins(buyMargin: Decimal | number | string, sellMargin: Decimal | number | string): void {
    const buy = new Decimal(buyMargin);
    const sell = new Decimal(sellMargin);

    if (buy.lessThan(0)) {
      throw new Error("buyMargin phải lớn hơn hoặc bằng 0 (giá trị trừ khỏi base rate)");
    }
    if (sell.lessThan(0)) {
      throw new Error("sellMargin phải lớn hơn hoặc bằng 0 (giá trị cộng vào base rate)");
    }
  }

  /**
   * Standard Rate Semantics:
   * base: e.g. 26300
   * buyMargin: 50 -> effectiveBuy = base - buyMargin = 26250
   * sellMargin: 100 -> effectiveSell = base + sellMargin = 26400
   */
  static calculateEffectiveRates(
    baseRate: Decimal | number | string,
    buyMargin: Decimal | number | string,
    sellMargin: Decimal | number | string
  ): {
    effectiveBuy: Decimal;
    effectiveSell: Decimal;
    base: Decimal;
    buyMargin: Decimal;
    sellMargin: Decimal;
  } {
    const base = new Decimal(baseRate);
    const buy = new Decimal(buyMargin);
    const sell = new Decimal(sellMargin);

    this.validateMargins(buy, sell);

    const effectiveBuy = base.minus(buy);
    const effectiveSell = base.plus(sell);

    if (effectiveBuy.lessThanOrEqualTo(0)) {
      throw new Error("Tỷ giá mua hiệu dụng (base - buyMargin) phải lớn hơn 0");
    }

    return {
      base,
      buyMargin: buy,
      sellMargin: sell,
      effectiveBuy,
      effectiveSell
    };
  }

  /**
   * Rounds target amounts consistently using Decimal per currency configuration:
   * USD -> 2 decimals
   * VND -> nearest 100 (normal half-up rounding)
   * KHR -> 0 decimals
   */
  static roundTargetAmount(amount: Decimal | number | string, currency: string): Decimal {
    const dec = new Decimal(amount);
    const code = currency.toUpperCase().trim();
    if (code === "VND") {
      return this.roundVnd(dec);
    }
    const decimalPlaces = this.getDecimals(code);
    return dec.toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_UP);
  }

  /**
   * Rounds VND to the nearest 100 (normal half-up rounding).
   * 2635742 -> 2635700, 2635750 -> 2635800
   */
  static roundVnd(amount: Decimal | number | string): Decimal {
    // Explicit nearest-100 rounding (does not rely on negative decimal places).
    return new Decimal(amount).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(100);
  }

  /**
   * Parses a human-friendly amount expression.
   * Supports: "2M", "2m", "2 triệu", "2 trieu", "2tr", "100k", "500k",
   * "1 nghìn", "1 ngàn", "1 000 000", "100", "1000", "100.50", "100,50", "100.5", "100,5".
   * Rejects ambiguous forms (e.g. "1.000.000", "1,000,000", "1.000,50", "1,000.50", "1.000", "1,000").
   * Returns null for zero, negative, NaN, Infinity, or unrecognized input.
   */
  static parseHumanAmount(input: string): number | null {
    const raw = String(input || "").trim().toLowerCase();
    if (!raw) return null;

    // Normalize diacritics (idempotent for already-normalized input)
    const normalized = raw
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d");

    if (normalized.startsWith("-")) return null;

    // Match: number part + optional multiplier suffix
    const match = normalized.match(/^(\d[\d\s.,]*?)\s*(m|tr|trieu|k|nghin|ngan)?$/);
    if (!match || !match[1]) return null;

    const numberPart = (match[1] || "").trim();
    const multiplier = match[2] || undefined;

    let value: number;

    // Space-grouped thousands: "1 000 000"
    if (numberPart.includes(" ")) {
      const groups = numberPart.split(/\s+/);
      if (groups.length < 2) return null;
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if (!g || !/^\d+$/.test(g)) return null;
        if (i > 0 && g.length !== 3) return null;
      }
      value = parseFloat(groups.join(""));
    } else if (numberPart.includes(".") && numberPart.includes(",")) {
      return null; // mixed separators -> ambiguous
    } else if (numberPart.includes(".")) {
      const parts = numberPart.split(".");
      if (parts.length > 2) return null; // "1.000.000" -> ambiguous
      const [intPart, decPart] = parts;
      if (!intPart || !decPart || !/^\d+$/.test(intPart) || !/^\d{1,2}$/.test(decPart)) return null;
      value = parseFloat(`${intPart}.${decPart}`);
    } else if (numberPart.includes(",")) {
      const parts = numberPart.split(",");
      if (parts.length > 2) return null; // "1,000,000" -> ambiguous
      const [intPart, decPart] = parts;
      if (!intPart || !decPart || !/^\d+$/.test(intPart) || !/^\d{1,2}$/.test(decPart)) return null;
      value = parseFloat(`${intPart}.${decPart}`);
    } else {
      if (!/^\d+$/.test(numberPart)) return null;
      value = parseFloat(numberPart);
    }

    if (!isFinite(value) || value <= 0) return null;

    if (multiplier && this.AMOUNT_MULTIPLIERS[multiplier]) {
      value *= this.AMOUNT_MULTIPLIERS[multiplier];
    }

    return value;
  }

  /**
   * Formats a monetary value for customer-facing display (number only, no currency code).
   * VND: space thousands, no decimals.
   * USD: space thousands, comma decimal separator, at most 2 meaningful decimals.
   * Other currencies: fallback to existing behavior.
   * Handlers append the currency code separately.
   */
  static formatAmount(amount: Decimal | number | string, currency: string): string {
    const code = currency.toUpperCase().trim();
    const dec = new Decimal(amount);

    if (code === "VND") {
      // Display only: do NOT apply business rounding (nearest 100).
      // The stored value is already rounded by roundTargetAmount in calculateQuote.
      return this.groupThousands(dec.toFixed(0));
    }

    if (code === "USD") {
      const rounded = dec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const fixed = rounded.toFixed(2).replace(/\.?0+$/, "");
      const [intPart = fixed, decPart] = fixed.split(".");
      const grouped = this.groupThousands(intPart);
      return decPart ? `${grouped},${decPart}` : grouped;
    }

    // Fallback for other currencies (e.g. historical KHR data)
    const decimalPlaces = this.getDecimals(code);
    const rounded = dec.toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_UP);
    return this.groupThousands(rounded.toFixed(decimalPlaces));
  }

  /**
   * Formats a monetary value with the currency code appended.
   * VND: "2 635 700 VND", USD: "1 234,5 USD"
   */
  static formatMoney(amount: Decimal | number | string, currency: string): string {
    const code = currency.toUpperCase().trim();
    return `${this.formatAmount(amount, code)} ${code}`;
  }

  /**
   * Formats VND: space thousands, no decimals, " VND" suffix.
   * 2000000 -> "2 000 000 VND", 2635742 -> "2 635 742 VND" (display only, no rounding)
   */
  static formatVnd(amount: Decimal | number | string): string {
    return `${this.formatAmount(amount, "VND")} VND`;
  }

  /**
   * Formats USD: space thousands, comma decimal separator, at most 2 meaningful decimals.
   * 100 -> "100 USD", 100.5 -> "100,5 USD", 1234.5 -> "1 234,5 USD"
   */
  static formatUsd(amount: Decimal | number | string): string {
    return `${this.formatAmount(amount, "USD")} USD`;
  }

  /**
   * Groups integer digits with spaces as thousands separators.
   * "2635700" -> "2 635 700"
   */
  /**
   * Formats an effective quote rate in an intuitive customer form.
   * Never shows VND->USD as "0.0000": both directions are presented as
   * "1 USD = xx xxx VND" using the directional effective rate.
   */
  static formatEffectiveRate(sourceCurrency: string, targetCurrency: string, effectiveRate: Decimal | number | string): string {
    const src = sourceCurrency.toUpperCase().trim();
    const tgt = targetCurrency.toUpperCase().trim();
    const rate = new Decimal(effectiveRate);

    if (src === "USD" && tgt === "VND") {
      return `1 USD = ${this.formatAmount(rate, "VND")} VND`;
    }
    if (src === "VND" && tgt === "USD") {
      // Inverse direction: present the intuitive USD->VND customer form.
      const usdToVnd = new Decimal(1).dividedBy(rate);
      return `1 USD = ${this.formatAmount(usdToVnd, "VND")} VND`;
    }
    // Fallback (historical pairs): keep a readable 4-decimal form.
    return `1 ${src} = ${rate.toFixed(4)} ${tgt}`;
  }

  private static groupThousands(intPart: string): string {
    return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  }
}
