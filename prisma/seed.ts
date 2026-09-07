import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");
  try {
    // Seed rates
    const rates = [
      {
        pair: "USD/VND",
        baseRate: 25450,
        buyMargin: 50,
        sellMargin: 100,
        fee: 2,
        feeCurrency: "USD",
        updatedBy: "system"
      },
      {
        pair: "USD/KHR",
        baseRate: 4080,
        buyMargin: 20,
        sellMargin: 30,
        fee: 2,
        feeCurrency: "USD",
        updatedBy: "system"
      },
      {
        pair: "VND/KHR",
        baseRate: 0.1605,
        buyMargin: 0.002,
        sellMargin: 0.003,
        fee: 50000,
        feeCurrency: "VND",
        updatedBy: "system"
      }
    ];

    for (const r of rates) {
      await prisma.exchangeRate.upsert({
        where: { pair: r.pair },
        update: r,
        create: r
      });
    }

    // Seed default receiving accounts
    const accounts = [
      {
        currency: "USD",
        bankName: "ABA Bank",
        accountName: "EXCHANGE DESK USD",
        accountNumber: "001234567",
        tag: "default",
        qrVersion: 1
      },
      {
        currency: "VND",
        bankName: "Vietcombank",
        accountName: "EXCHANGE DESK VND",
        accountNumber: "9988776655",
        tag: "default",
        qrVersion: 1
      },
      {
        currency: "KHR",
        bankName: "ABA Bank",
        accountName: "EXCHANGE DESK KHR",
        accountNumber: "009876543",
        tag: "default",
        qrVersion: 1
      }
    ];

    for (const acc of accounts) {
      const existing = await prisma.paymentAccount.findFirst({
        where: { currency: acc.currency, accountNumber: acc.accountNumber }
      });
      if (!existing) {
        await prisma.paymentAccount.create({ data: acc });
      }
    }

    console.log("Database seeded successfully!");
  } catch (err) {
    console.warn("Seeding failed or database unreachable:", (err as Error).message);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
