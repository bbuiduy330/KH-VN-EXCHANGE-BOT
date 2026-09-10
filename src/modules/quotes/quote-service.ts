import { Decimal } from "decimal.js";
import { prisma } from "../../database/client.js";
import { RuntimeConfigService } from "../system-config/runtime-config-service.js";
import { MoneyService } from "../money/money-service.js";

export interface QuoteCalculation {
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: Decimal;
  targetAmount: Decimal;
  effectiveRate: Decimal;
  baseRate: Decimal;
  fee: Decimal;
  feeCurrency: string;
  expiresAt: Date;
}

export class QuoteService {
  static async setRate(
    pair: string,
    baseRate: number | string,
    buyMargin: number | string,
    sellMargin: number | string,
    fee: number | string,
    feeCurrency: string,
    updatedBy: string
  ) {
    const normalizedPair = pair.toUpperCase().trim();
    const base = new Decimal(baseRate);
    const buy = new Decimal(buyMargin);
    const sell = new Decimal(sellMargin);
    const feeDec = new Decimal(fee);

    MoneyService.validateMargins(buy, sell);

    return prisma.exchangeRate.upsert({
      where: { pair: normalizedPair },
      update: {
        baseRate: base,
        buyMargin: buy,
        sellMargin: sell,
        fee: feeDec,
        feeCurrency: feeCurrency.toUpperCase(),
        updatedBy,
        updatedAt: new Date()
      },
      create: {
        pair: normalizedPair,
        baseRate: base,
        buyMargin: buy,
        sellMargin: sell,
        fee: feeDec,
        feeCurrency: feeCurrency.toUpperCase(),
        updatedBy
      }
    });
  }

  static async getRate(pair: string) {
    const normalizedPair = pair.toUpperCase().trim();
    return prisma.exchangeRate.findUnique({
      where: { pair: normalizedPair }
    });
  }

  static async getAllRates() {
    return prisma.exchangeRate.findMany({
      orderBy: { pair: "asc" }
    });
  }

  /**
   * Pure deterministic calculation of quote using Decimal and MoneyService
   */
  static async calculateQuote(
    sourceCurrency: string,
    targetCurrency: string,
    sourceAmountInput: number | string
  ): Promise<QuoteCalculation> {
    const src = sourceCurrency.toUpperCase().trim();
    const tgt = targetCurrency.toUpperCase().trim();
    const pairDirect = `${src}/${tgt}`;
    const pairInverse = `${tgt}/${src}`;

    const rateDirect = await prisma.exchangeRate.findUnique({ where: { pair: pairDirect } });
    const rateInverse = await prisma.exchangeRate.findUnique({ where: { pair: pairInverse } });

    const sourceAmount = new Decimal(sourceAmountInput);
    if (sourceAmount.lessThanOrEqualTo(0)) {
      throw new Error("Số tiền phải lớn hơn 0");
    }

    let effectiveRate: Decimal;
    let baseRate: Decimal;
    let fee: Decimal;
    let feeCurrency: string;

    if (rateDirect) {
      baseRate = new Decimal(rateDirect.baseRate);
      // Customer sells source to buy target: applies buyMargin (subtracted)
      const { effectiveBuy } = MoneyService.calculateEffectiveRates(
        baseRate,
        rateDirect.buyMargin,
        rateDirect.sellMargin
      );
      effectiveRate = effectiveBuy;
      fee = new Decimal(rateDirect.fee);
      feeCurrency = rateDirect.feeCurrency;
    } else if (rateInverse) {
      baseRate = new Decimal(rateInverse.baseRate);
      // Inverse pair: Customer buys target, denominator applies sellMargin (added)
      const { effectiveSell } = MoneyService.calculateEffectiveRates(
        baseRate,
        rateInverse.buyMargin,
        rateInverse.sellMargin
      );
      effectiveRate = new Decimal(1).dividedBy(effectiveSell);
      fee = new Decimal(rateInverse.fee);
      feeCurrency = rateInverse.feeCurrency;
    } else {
      throw new Error(`Chưa thiết lập tỷ giá cho cặp tiền tệ ${src}/${tgt}`);
    }

    let targetAmount = sourceAmount.times(effectiveRate);
    if (feeCurrency === tgt) {
      targetAmount = targetAmount.minus(fee);
    } else if (feeCurrency === src) {
      const feeInTgt = fee.times(effectiveRate);
      targetAmount = targetAmount.minus(feeInTgt);
    }

    if (targetAmount.lessThanOrEqualTo(0)) {
      throw new Error("Số tiền sau khi trừ phí không hợp lệ");
    }

    // Apply currency-specific rounding
    targetAmount = MoneyService.roundTargetAmount(targetAmount, tgt);

    const expiryMinutes = RuntimeConfigService.getQuoteExpiryMinutes();
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    return {
      sourceCurrency: src,
      targetCurrency: tgt,
      sourceAmount,
      targetAmount,
      effectiveRate,
      baseRate,
      fee,
      feeCurrency,
      expiresAt
    };
  }

  /**
   * Creates a persisted Quote in the database.
   * Survives server restart.
   */
  static async createQuote(
    customerId: string,
    sourceCurrency: string,
    targetCurrency: string,
    sourceAmountInput: number | string
  ) {
    const calc = await this.calculateQuote(sourceCurrency, targetCurrency, sourceAmountInput);

    const quote = await prisma.quote.create({
      data: {
        customerId,
        sourceCurrency: calc.sourceCurrency,
        targetCurrency: calc.targetCurrency,
        sourceAmount: calc.sourceAmount,
        targetAmount: calc.targetAmount,
        effectiveRate: calc.effectiveRate,
        baseRate: calc.baseRate,
        fee: calc.fee,
        feeCurrency: calc.feeCurrency,
        status: "PENDING",
        expiresAt: calc.expiresAt
      }
    });

    return quote;
  }
  /**
   * Target-amount quoting ("doi VND lay 100 USD"): computes the SOURCE amount
   * the customer must send in order to RECEIVE the requested target amount.
   * Reuses the exact same rate/margin/fee rules as calculateQuote (inverted);
   * no new rounding or business rules are introduced.
   */
  static async calculateQuoteFromTarget(
    sourceCurrency: string,
    targetCurrency: string,
    targetAmountInput: number | string
  ): Promise<QuoteCalculation> {
    const src = sourceCurrency.toUpperCase().trim();
    const tgt = targetCurrency.toUpperCase().trim();
    const pairDirect = `${src}/${tgt}`;
    const pairInverse = `${tgt}/${src}`;

    const rateDirect = await prisma.exchangeRate.findUnique({ where: { pair: pairDirect } });
    const rateInverse = await prisma.exchangeRate.findUnique({ where: { pair: pairInverse } });

    const desiredTarget = new Decimal(targetAmountInput);
    if (desiredTarget.lessThanOrEqualTo(0)) {
      throw new Error("Số tiền phải lớn hơn 0");
    }

    let effectiveRate: Decimal;
    let baseRate: Decimal;
    let fee: Decimal;
    let feeCurrency: string;

    if (rateDirect) {
      baseRate = new Decimal(rateDirect.baseRate);
      // Same side as calculateQuote: customer sells source, buyMargin applies.
      const { effectiveBuy } = MoneyService.calculateEffectiveRates(
        baseRate,
        rateDirect.buyMargin,
        rateDirect.sellMargin
      );
      effectiveRate = effectiveBuy;
      fee = new Decimal(rateDirect.fee);
      feeCurrency = rateDirect.feeCurrency;
    } else if (rateInverse) {
      baseRate = new Decimal(rateInverse.baseRate);
      // Same side as calculateQuote: denominator pair, sellMargin applies.
      const { effectiveSell } = MoneyService.calculateEffectiveRates(
        baseRate,
        rateInverse.buyMargin,
        rateInverse.sellMargin
      );
      effectiveRate = effectiveSell;
      fee = new Decimal(rateInverse.fee);
      feeCurrency = rateInverse.feeCurrency;
    } else {
      throw new Error(`Chưa thiết lập tỷ giá cho cặp tiền tệ ${src}/${tgt}`);
    }

    // Forward formula mirrored EXACTLY from calculateQuote:
    // fee subtracted as-is when feeCurrency === tgt, converted at the effective
    // rate when feeCurrency === src, and not applied for any other currency
    // (same conditional structure as calculateQuote).
    const forwardTarget = (source: Decimal): Decimal => {
      const raw = rateDirect ? source.times(effectiveRate) : source.div(effectiveRate);
      if (feeCurrency === tgt) return raw.minus(fee);
      if (feeCurrency === src) return raw.minus(fee.times(effectiveRate));
      return raw;
    };

    // Closed-form inversion of the forward formula (same three cases).
    let sourceAmount = rateDirect
      ? feeCurrency === tgt
        ? desiredTarget.plus(fee).div(effectiveRate)
        : feeCurrency === src
          ? desiredTarget.div(effectiveRate).plus(fee)
          : desiredTarget.div(effectiveRate)
      : feeCurrency === tgt
        ? desiredTarget.plus(fee).times(effectiveRate)
        : feeCurrency === src
          ? desiredTarget.plus(fee.times(effectiveRate)).times(effectiveRate)
          : desiredTarget.times(effectiveRate);

    // Round the source UP onto the currency grid, then bump by one grid step
    // until the forward result covers the requested target (rounding-safe).
    sourceAmount = MoneyService.roundSourceAmount(sourceAmount, src);
    const step = new Decimal(src === "USD" ? "0.01" : "1");
    let guard = 0;
    while (forwardTarget(sourceAmount).lessThan(desiredTarget) && guard < 10000) {
      sourceAmount = sourceAmount.plus(step);
      guard++;
    }
    if (forwardTarget(sourceAmount).lessThan(desiredTarget)) {
      throw new Error("Không thể tính số tiền cần chuyển với tỷ giá hiện tại. Vui lòng thử lại sau.");
    }

    const expiryMinutes = RuntimeConfigService.getQuoteExpiryMinutes();
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    return {
      sourceCurrency: src,
      targetCurrency: tgt,
      sourceAmount,
      targetAmount: MoneyService.roundTargetAmount(forwardTarget(sourceAmount), tgt),
      effectiveRate,
      baseRate,
      fee,
      feeCurrency,
      expiresAt
    };
  }

  /**
   * Creates a persisted Quote from a TARGET amount ("nhan 100 USD").
   * Survives server restart, same as createQuote.
   */
  static async createQuoteFromTarget(
    customerId: string,
    sourceCurrency: string,
    targetCurrency: string,
    targetAmountInput: number | string
  ) {
    const calc = await this.calculateQuoteFromTarget(sourceCurrency, targetCurrency, targetAmountInput);

    const quote = await prisma.quote.create({
      data: {
        customerId,
        sourceCurrency: calc.sourceCurrency,
        targetCurrency: calc.targetCurrency,
        sourceAmount: calc.sourceAmount,
        targetAmount: calc.targetAmount,
        effectiveRate: calc.effectiveRate,
        baseRate: calc.baseRate,
        fee: calc.fee,
        feeCurrency: calc.feeCurrency,
        status: "PENDING",
        expiresAt: calc.expiresAt
      }
    });

    return quote;
  }

  static async getQuoteById(quoteId: string) {
    return prisma.quote.findUnique({
      where: { id: quoteId },
      include: { customer: true }
    });
  }

  /**
   * Returns the customer's most recent PENDING, unexpired quote (or null).
   * Used to resume an in-flight quote instead of showing a generic welcome.
   */
  static async getLatestActiveQuote(customerId: string) {
    return prisma.quote.findFirst({
      where: {
        customerId,
        status: "PENDING",
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: "desc" }
    });
  }

  /**
   * Atomically confirms a quote:
   * 1. Validates quote exists
   * 2. Belongs to customer
   * 3. Status is PENDING
   * 4. expiresAt > now
   * Conditional update prevents double confirmation.
   */
  static async confirmQuote(quoteId: string, customerId: string) {
    return prisma.$transaction(async (tx: any) => {
      const quote = await tx.quote.findUnique({
        where: { id: quoteId }
      });

      if (!quote) {
        throw new Error("Báo giá không tồn tại trên hệ thống.");
      }

      if (quote.customerId !== customerId) {
        throw new Error("Báo giá này không thuộc về tài khoản của bạn.");
      }

      if (quote.status !== "PENDING") {
        throw new Error("Báo giá này đã được sử dụng hoặc không còn hiệu lực.");
      }

      if (new Date() > new Date(quote.expiresAt)) {
        await tx.quote.update({
          where: { id: quoteId },
          data: { status: "EXPIRED" }
        });
        throw new Error("Báo giá đã hết hạn. Vui lòng tạo yêu cầu báo giá mới.");
      }

      const result = await tx.quote.updateMany({
        where: {
          id: quoteId,
          customerId,
          status: "PENDING"
        },
        data: {
          status: "CONFIRMED",
          confirmedAt: new Date()
        }
      });

      if (result.count !== 1) {
        throw new Error("Không thể xác nhận báo giá. Đã có thao tác xác nhận đồng thời.");
      }

      return tx.quote.findUnique({
        where: { id: quoteId }
      });
    });
  }
}
