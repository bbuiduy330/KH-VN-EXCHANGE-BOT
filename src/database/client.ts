import { PrismaClient } from "@prisma/client";
import { logger } from "../shared/logger.js";
import { Decimal } from "decimal.js";

// In-memory backing stores for offline/sandboxed development
const inMemoryStore = {
  exchangeRates: new Map<string, any>([
    [
      "USD/VND",
      {
        id: "rate-1",
        pair: "USD/VND",
        baseRate: new Decimal(25450),
        buyMargin: new Decimal(50),
        sellMargin: new Decimal(100),
        fee: new Decimal(2),
        feeCurrency: "USD",
        updatedBy: "system",
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ],
    [
      "USD/KHR",
      {
        id: "rate-2",
        pair: "USD/KHR",
        baseRate: new Decimal(4080),
        buyMargin: new Decimal(20),
        sellMargin: new Decimal(30),
        fee: new Decimal(2),
        feeCurrency: "USD",
        updatedBy: "system",
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ],
    [
      "VND/KHR",
      {
        id: "rate-3",
        pair: "VND/KHR",
        baseRate: new Decimal(0.1605),
        buyMargin: new Decimal(0.002),
        sellMargin: new Decimal(0.003),
        fee: new Decimal(50000),
        feeCurrency: "VND",
        updatedBy: "system",
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ]
  ]),
  paymentAccounts: new Map<string, any>([
    [
      "acc-1",
      {
        id: "acc-1",
        currency: "USD",
        bankName: "ABA Bank",
        accountName: "EXCHANGE DESK USD",
        accountNumber: "001234567",
        tag: "default",
        qrVersion: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ],
    [
      "acc-2",
      {
        id: "acc-2",
        currency: "VND",
        bankName: "Vietcombank",
        accountName: "EXCHANGE DESK VND",
        accountNumber: "9988776655",
        tag: "default",
        qrVersion: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ]
  ]),
  customers: new Map<string, any>(),
  payoutBanks: new Map<string, any>(),
  orders: new Map<string, any>(),
  conversations: new Map<string, any>(),
  messages: new Map<string, any>(),
  notes: new Map<string, any>(),
  staffUsers: new Map<string, any>(),
  staffInvites: new Map<string, any>(),
  driveSyncJobs: new Map<string, any>(),
  auditLogs: new Map<string, any>(),
  fileEvidence: new Map<string, any>()
};

function createMockCollection(store: Map<string, any>, keyField: string = "id") {
  return {
    findMany: async (args?: any) => {
      let items = Array.from(store.values());
      if (args?.where) {
        items = items.filter((item) => {
          for (const [k, v] of Object.entries(args.where)) {
            if (v === undefined) continue;
            if (v !== null && typeof v === "object" && "in" in (v as any) && Array.isArray((v as any).in)) {
              if (!(v as any).in.includes(item[k])) return false;
              continue;
            }
            if (v !== null && typeof v === "object" && "not" in (v as any)) {
              if (item[k] === (v as any).not) return false;
              continue;
            }
            if (item[k] !== v) return false;
          }
          return true;
        });
      }
      return items;
    },
    findUnique: async (args: any) => {
      if (!args?.where) return null;
      if (args.where.id && store.has(args.where.id)) return store.get(args.where.id);
      for (const item of store.values()) {
        let match = true;
        for (const [k, v] of Object.entries(args.where)) {
          if (item[k] !== v) {
            match = false;
            break;
          }
        }
        if (match) return item;
      }
      return null;
    },
    findFirst: async (args?: any) => {
      const items = await createMockCollection(store, keyField).findMany(args);
      return items[0] ?? null;
    },
    create: async (args: any) => {
      const id = args.data?.id || `mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const doc = {
        id,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.data
      };
      const mapKey = doc[keyField] || id;
      store.set(mapKey, doc);
      return doc;
    },
    upsert: async (args: any) => {
      const existing = await createMockCollection(store, keyField).findUnique(args);
      if (existing) {
        const updated = { ...existing, ...args.update, updatedAt: new Date() };
        const storeKey = existing[keyField] || existing.id;
        store.set(storeKey, updated);
        return updated;
      }
      return createMockCollection(store, keyField).create({ data: args.create });
    },
    update: async (args: any) => {
      const existing = await createMockCollection(store, keyField).findUnique(args);
      if (!existing) throw new Error("Record not found in mock store");
      const updated = { ...existing, ...args.data, updatedAt: new Date() };
      const storeKey = existing[keyField] || existing.id;
      store.set(storeKey, updated);
      return updated;
    },
    delete: async (args: any) => {
      const key = args.where?.[keyField] || args.where?.id;
      store.delete(key);
      return { success: true };
    }
  };
}

let prismaClientInstance: any;

try {
  const realPrisma = new PrismaClient();
  
  // Create a proxy that wraps real Prisma calls and falls back to in-memory store if DB is unreachable
  prismaClientInstance = new Proxy(realPrisma, {
    get(target: any, prop: string | symbol) {
      if (typeof prop !== "string") return target[prop];
      if (prop === "$connect" || prop === "$disconnect") return target[prop].bind(target);
      
      const mockMap: Record<string, { store: Map<string, any>; key: string }> = {
        exchangeRate: { store: inMemoryStore.exchangeRates, key: "pair" },
        paymentAccount: { store: inMemoryStore.paymentAccounts, key: "id" },
        customer: { store: inMemoryStore.customers, key: "telegramId" },
        customerPayoutBank: { store: inMemoryStore.payoutBanks, key: "id" },
        order: { store: inMemoryStore.orders, key: "id" },
        conversation: { store: inMemoryStore.conversations, key: "id" },
        message: { store: inMemoryStore.messages, key: "id" },
        internalNote: { store: inMemoryStore.notes, key: "id" },
        staffUser: { store: inMemoryStore.staffUsers, key: "telegramId" },
        staffInvite: { store: inMemoryStore.staffInvites, key: "code" },
        driveSyncJob: { store: inMemoryStore.driveSyncJobs, key: "id" },
        auditLog: { store: inMemoryStore.auditLogs, key: "id" },
        fileEvidence: { store: inMemoryStore.fileEvidence, key: "id" }
      };

      const mock = mockMap[prop];
      if (mock) {
        const mockDelegate = createMockCollection(mock.store, mock.key);
        const realDelegate = target[prop];
        return new Proxy(realDelegate || {}, {
          get(delegateTarget, method: string) {
            return async (...args: any[]) => {
              try {
                if (process.env.DATABASE_URL && delegateTarget && typeof delegateTarget[method] === "function") {
                  return await delegateTarget[method](...args);
                }
              } catch (e) {
                logger.warn({ error: (e as Error).message }, `[AI Studio] Database call failed on ${prop}.${method}, falling back to mock`);
              }
              if (mockDelegate && typeof (mockDelegate as any)[method] === "function") {
                return await (mockDelegate as any)[method](...args);
              }
              return null;
            };
          }
        });
      }
      return target[prop];
    }
  });
} catch {
  logger.warn("[AI Studio] PrismaClient initialization failed — using standalone in-memory mock");
  prismaClientInstance = {
    exchangeRate: createMockCollection(inMemoryStore.exchangeRates, "pair"),
    paymentAccount: createMockCollection(inMemoryStore.paymentAccounts, "id"),
    customer: createMockCollection(inMemoryStore.customers, "telegramId"),
    customerPayoutBank: createMockCollection(inMemoryStore.payoutBanks, "id"),
    order: createMockCollection(inMemoryStore.orders, "id"),
    conversation: createMockCollection(inMemoryStore.conversations, "id"),
    message: createMockCollection(inMemoryStore.messages, "id"),
    internalNote: createMockCollection(inMemoryStore.notes, "id"),
    staffUser: createMockCollection(inMemoryStore.staffUsers, "telegramId"),
    staffInvite: createMockCollection(inMemoryStore.staffInvites, "code"),
    driveSyncJob: createMockCollection(inMemoryStore.driveSyncJobs, "id"),
    auditLog: createMockCollection(inMemoryStore.auditLogs, "id"),
    fileEvidence: createMockCollection(inMemoryStore.fileEvidence, "id"),
    $connect: async () => {},
    $disconnect: async () => {}
  };
}

export const prisma = prismaClientInstance;
export { inMemoryStore };
