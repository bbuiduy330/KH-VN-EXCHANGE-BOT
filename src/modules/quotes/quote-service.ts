import { Decimal } from "decimal.js";
import { prisma } from "../../database/client.js";
import { env } from "../../config/env.js";

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
    return prisma.exchangeRate.upsert({
      where: { pair: normalizedPair },
      update: {
        baseRate: new Decimal(baseRate),
        buyMargin: new Decimal(buyMargin),
        sellMargin: new Decimal(sellMargin),
        fee: new Decimal(fee),
        feeCurrency: feeCurrency.toUpperCase(),
        updatedBy,
        updatedAt: new Date()
      },
      create: {
        pair: normalizedPair,
        baseRate: new Decimal(baseRate),
        buyMargin: new Decimal(buyMargin),
        sellMargin: new Decimal(sellMargin),
        fee: new Decimal(fee),
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
    return prisma.exchangeRate.findMany();
  }

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
      // Customer sells source, applies buyMargin
      const margin = new Decimal(rateDirect.buyMargin);
      effectiveRate = baseRate.minus(margin);
      fee = new Decimal(rateDirect.fee);
      feeCurrency = rateDirect.feeCurrency;
    } else if (rateInverse) {
      baseRate = new Decimal(rateInverse.baseRate);
      // Customer buys target, inverse rate applies sellMargin
      const margin = new Decimal(rateInverse.sellMargin);
      const denominator = baseRate.plus(margin);
      effectiveRate = new Decimal(1).dividedBy(denominator);
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

    const expiresAt = new Date(Date.now() + env.QUOTE_EXPIRY_MINUTES * 60 * 1000);

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
}
