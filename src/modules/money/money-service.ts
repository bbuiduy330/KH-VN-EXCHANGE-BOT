import { Decimal } from "decimal.js";

export class MoneyService {
  private static readonly CURRENCY_DECIMALS: Record<string, number> = {
    USD: 2,
    VND: 0,
    KHR: 0
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
   * VND -> 0 decimals
   * KHR -> 0 decimals
   */
  static roundTargetAmount(amount: Decimal | number | string, currency: string): Decimal {
    const dec = new Decimal(amount);
    const decimalPlaces = this.getDecimals(currency);
    return dec.toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_UP);
  }

  /**
   * Human-friendly formatted string with thousands separator
   */
  static formatAmount(amount: Decimal | number | string, currency: string): string {
    const rounded = this.roundTargetAmount(amount, currency);
    const decimals = this.getDecimals(currency);
    const parts = rounded.toFixed(decimals).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  }
}
