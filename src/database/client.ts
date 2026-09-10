import { logger } from "../shared/logger.js";
import { PrismaPg } from "@prisma/adapter-pg";

let PrismaClientConstructor: any = null;
try {
  const prismaModule = await import("@prisma/client");
  PrismaClientConstructor = (prismaModule as any).PrismaClient;
} catch {
  // Prisma client not yet generated or failed to load
}

// Safe in-memory fallback store for unit tests or environments without a running Postgres
const inMemoryStore = {
  exchangeRates: new Map<string, any>([
    [
      "USD/VND",
      {
        id: "rate-usd-vnd",
        pair: "USD/VND",
        baseRate: 25400,
        buyMargin: 50,
        sellMargin: 50,
        fee: 2,
        feeCurrency: "USD",
        updatedBy: "system",
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ],
    [
      "USD/KHR",
      {
        id: "rate-usd-khr",
        pair: "USD/KHR",
        baseRate: 4080,
        buyMargin: 10,
        sellMargin: 10,
        fee: 2,
        feeCurrency: "USD",
        updatedBy: "system",
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ],
    [
      "VND/KHR",
      {
        id: "rate-vnd-khr",
        pair: "VND/KHR",
        baseRate: 0.16,
        buyMargin: 0.002,
        sellMargin: 0.002,
        fee: 50000,
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
        isDefault: true,
        priority: 10,
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
        isDefault: true,
        priority: 10,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ]
  ]),
  paymentAccountVersions: new Map<string, any>(),
  customers: new Map<string, any>(),
  payoutBanks: new Map<string, any>(),
  orders: new Map<string, any>(),
  orderStateHistories: new Map<string, any>(),
  orderBillEvidence: new Map<string, any>(),
  conversations: new Map<string, any>(),
  messages: new Map<string, any>(),
  notes: new Map<string, any>(),
  staffUsers: new Map<string, any>(),
  staffInvites: new Map<string, any>(),
  backupRuns: new Map<string, any>(),
  auditLogs: new Map<string, any>(),
  fileEvidence: new Map<string, any>(),
  systemSecrets: new Map<string, any>(),
  quotes: new Map<string, any>(),
  systemSettings: new Map<string, any>(),
  adminInputSessions: new Map<string, any>()
};

function matchesWhere(item: any, where?: any): boolean {
  if (!where || !item) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (k === "OR" && Array.isArray(v)) {
      const orMatched = v.some((cond) => matchesWhere(item, cond));
      if (!orMatched) return false;
      continue;
    }
    if (k === "AND" && Array.isArray(v)) {
      const andMatched = v.every((cond) => matchesWhere(item, cond));
      if (!andMatched) return false;
      continue;
    }
    if (v !== null && typeof v === "object") {
      if ("in" in (v as any) && Array.isArray((v as any).in)) {
        if (!(v as any).in.includes(item[k])) return false;
        continue;
      }
      if ("not" in (v as any)) {
        if (item[k] === (v as any).not) return false;
        continue;
      }
      // Order comparators (gt/gte/lt/lte) — used by QuoteService.getLatestActiveQuote
      // (expiresAt: { gt: now }). Test-only surface: production always uses the real DB.
      let matchedComparator = false;
      for (const op of ["gt", "gte", "lt", "lte"] as const) {
        if (op in (v as any)) {
          matchedComparator = true;
          const threshold = new Date((v as any)[op]).getTime();
          const value = new Date(item[k]).getTime();
          const ok =
            op === "gt"
              ? value > threshold
              : op === "gte"
                ? value >= threshold
                : op === "lt"
                  ? value < threshold
                  : value <= threshold;
          if (!ok) return false;
        }
      }
      if (matchedComparator) continue;
    }
    if (item[k] !== v) return false;
  }
  return true;
}

function createMockCollection(store: Map<string, any>, keyField: string = "id") {
  const attachRelations = (item: any, include?: any) => {
    if (!item || !include) return item;
    const cloned = { ...item };
    if (include.customer && cloned.customerId) {
      cloned.customer = inMemoryStore.customers.get(cloned.customerId) ||
        Array.from(inMemoryStore.customers.values()).find((c) => c.id === cloned.customerId) || null;
    }
    if (include.versions && cloned.id) {
      cloned.versions = Array.from(inMemoryStore.paymentAccountVersions.values()).filter(
        (v) => v.paymentAccountId === cloned.id
      );
    }
    return cloned;
  };

  return {
    findMany: async (args?: any) => {
      let items = Array.from(store.values());
      if (args?.where) {
        items = items.filter((item) => matchesWhere(item, args.where));
      }

      if (args?.orderBy) {
        const orderBys = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
        items.sort((a, b) => {
          for (const ob of orderBys) {
            for (const [key, dir] of Object.entries(ob)) {
              const valA = a[key];
              const valB = b[key];
              const asc = (dir as string).toLowerCase() === "asc";
              if (valA === valB) continue;
              if (valA === undefined || valA === null) return asc ? -1 : 1;
              if (valB === undefined || valB === null) return asc ? 1 : -1;
              if (typeof valA === "boolean") {
                return asc ? (valA ? 1 : -1) : (valA ? -1 : 1);
              }
              if (valA > valB) return asc ? 1 : -1;
              if (valA < valB) return asc ? -1 : 1;
            }
          }
          return 0;
        });
      }

      if (args?.take && typeof args.take === "number") {
        items = items.slice(0, args.take);
      }

      return items.map((item) => attachRelations(item, args?.include));
    },

    findUnique: async (args: any) => {
      if (!args?.where) return null;
      if (args.where.id && store.has(args.where.id)) {
        const item = store.get(args.where.id);
        if (matchesWhere(item, args.where)) return attachRelations(item, args.include);
      }
      for (const item of store.values()) {
        if (matchesWhere(item, args.where)) return attachRelations(item, args.include);
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
      return attachRelations(doc, args.include);
    },

    upsert: async (args: any) => {
      const existing = await createMockCollection(store, keyField).findUnique(args);
      if (existing) {
        const updated = { ...existing, ...args.update, updatedAt: new Date() };
        const storeKey = existing[keyField] || existing.id;
        store.set(storeKey, updated);
        return attachRelations(updated, args.include);
      }
      return createMockCollection(store, keyField).create({ data: args.create, include: args.include });
    },

    update: async (args: any) => {
      const existing = await createMockCollection(store, keyField).findUnique(args);
      if (!existing) throw new Error("Record not found in mock store");
      const updated = { ...existing, ...args.data, updatedAt: new Date() };
      const storeKey = existing[keyField] || existing.id;
      store.set(storeKey, updated);
      return attachRelations(updated, args.include);
    },

    updateMany: async (args: any) => {
      let count = 0;
      for (const item of Array.from(store.values())) {
        if (matchesWhere(item, args?.where)) {
          const updated = { ...item, ...args.data, updatedAt: new Date() };
          const storeKey = updated[keyField] || updated.id;
          store.set(storeKey, updated);
          count++;
        }
      }
      return { count };
    },

    delete: async (args: any) => {
      const key = args.where?.[keyField] || args.where?.id;
      store.delete(key);
      return { success: true };
    },

    deleteMany: async (args?: any) => {
      let count = 0;
      for (const [k, item] of Array.from(store.entries())) {
        if (matchesWhere(item, args?.where)) {
          store.delete(k);
          count++;
        }
      }
      return { count };
    }
  };
}

const isProductionEnv = process.env.NODE_ENV === "production";

/**
 * Prisma / pg errors can embed the connection URL (which contains credentials).
 * Strip every scheme://... fragment before logging anything so DATABASE_URL and
 * its password can never leak into logs. Tokens/API keys are never logged here.
 */
export function sanitizeDatabaseError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"']+/g, "<redacted-url>");
}

const mockMap: Record<string, { store: Map<string, any>; key: string }> = {
  exchangeRate: { store: inMemoryStore.exchangeRates, key: "pair" },
  paymentAccount: { store: inMemoryStore.paymentAccounts, key: "id" },
  paymentAccountVersion: { store: inMemoryStore.paymentAccountVersions, key: "id" },
  customer: { store: inMemoryStore.customers, key: "telegramId" },
  customerPayoutBank: { store: inMemoryStore.payoutBanks, key: "id" },
  order: { store: inMemoryStore.orders, key: "id" },
  orderStateHistory: { store: inMemoryStore.orderStateHistories, key: "id" },
  orderBillEvidence: { store: inMemoryStore.orderBillEvidence, key: "id" },
  conversation: { store: inMemoryStore.conversations, key: "id" },
  message: { store: inMemoryStore.messages, key: "id" },
  internalNote: { store: inMemoryStore.notes, key: "id" },
  staffUser: { store: inMemoryStore.staffUsers, key: "telegramId" },
  staffInvite: { store: inMemoryStore.staffInvites, key: "code" },
  backupRun: { store: inMemoryStore.backupRuns, key: "id" },
  auditLog: { store: inMemoryStore.auditLogs, key: "id" },
  fileEvidence: { store: inMemoryStore.fileEvidence, key: "id" },
  systemSecret: { store: inMemoryStore.systemSecrets, key: "key" },
  quote: { store: inMemoryStore.quotes, key: "id" },
  systemSetting: { store: inMemoryStore.systemSettings, key: "key" },
  adminInputSession: { store: inMemoryStore.adminInputSessions, key: "staffId" }
};

let prismaClientInstance: any;
let isRealClient = false;

try {
  if (!PrismaClientConstructor) {
    throw new Error("Generated PrismaClient not found (run `prisma generate`)");
  }
  if (isProductionEnv && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production");
  }
  // Prisma 7 requires a driver adapter and the connection string must be
  // provided here in application code (the schema datasource has no url; the
  // CLI reads it from prisma.config.ts, which is why `migrate deploy` works
  // while a bare `new PrismaClient()` cannot connect). PrismaPg connects lazily.
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });
  const realPrisma = new PrismaClientConstructor({ adapter });

  // Create a proxy that wraps real Prisma calls and falls back to in-memory store if DB is unreachable
  prismaClientInstance = new Proxy(realPrisma, {
    get(target: any, prop: string | symbol) {
      if (typeof prop !== "string") return target[prop];
      if (prop === "$connect" || prop === "$disconnect") return target[prop].bind(target);
      if (prop === "$transaction") {
        return async (arg: any) => {
          try {
            if (process.env.DATABASE_URL && typeof target.$transaction === "function") {
              return await target.$transaction(arg);
            }
          } catch (e) {
            if (isProductionEnv) {
              // Financial data must never silently divert to the in-memory mock
              throw e;
            }
            logger.warn({ error: sanitizeDatabaseError(e) }, "[DB] $transaction failed on real DB, falling back to mock (non-production only)");
          }
          if (typeof arg === "function") {
            return await arg(prismaClientInstance);
          }
          if (Array.isArray(arg)) {
            return await Promise.all(arg);
          }
          return arg;
        };
      }

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
                if (isProductionEnv) {
                  // No mock fallback in production: surface the real DB error
                  throw e;
                }
                logger.warn({ error: sanitizeDatabaseError(e) }, `[DB] Database call failed on ${prop}.${method}, falling back to mock (non-production only)`);
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
  isRealClient = true;
} catch (initError) {
  if (isProductionEnv) {
    logger.error(
      { error: sanitizeDatabaseError(initError) },
      "[DB] FATAL: PrismaClient initialization failed in production — refusing to fall back to in-memory mock. Startup will abort."
    );
    throw initError;
  }
  logger.warn({ error: sanitizeDatabaseError(initError) }, "[DB] PrismaClient initialization failed — using standalone in-memory mock (non-production only)");
  prismaClientInstance = {
    exchangeRate: createMockCollection(inMemoryStore.exchangeRates, "pair"),
    paymentAccount: createMockCollection(inMemoryStore.paymentAccounts, "id"),
    paymentAccountVersion: createMockCollection(inMemoryStore.paymentAccountVersions, "id"),
    customer: createMockCollection(inMemoryStore.customers, "telegramId"),
    customerPayoutBank: createMockCollection(inMemoryStore.payoutBanks, "id"),
    order: createMockCollection(inMemoryStore.orders, "id"),
    orderStateHistory: createMockCollection(inMemoryStore.orderStateHistories, "id"),
    orderBillEvidence: createMockCollection(inMemoryStore.orderBillEvidence, "id"),
    conversation: createMockCollection(inMemoryStore.conversations, "id"),
    message: createMockCollection(inMemoryStore.messages, "id"),
    internalNote: createMockCollection(inMemoryStore.notes, "id"),
    staffUser: createMockCollection(inMemoryStore.staffUsers, "telegramId"),
    staffInvite: createMockCollection(inMemoryStore.staffInvites, "code"),
    backupRun: createMockCollection(inMemoryStore.backupRuns, "id"),
    auditLog: createMockCollection(inMemoryStore.auditLogs, "id"),
    fileEvidence: createMockCollection(inMemoryStore.fileEvidence, "id"),
    systemSecret: createMockCollection(inMemoryStore.systemSecrets, "key"),
    quote: createMockCollection(inMemoryStore.quotes, "id"),
    systemSetting: createMockCollection(inMemoryStore.systemSettings, "key"),
    adminInputSession: createMockCollection(inMemoryStore.adminInputSessions, "staffId"),
    $connect: async () => {},
    $disconnect: async () => {},
    $transaction: async (arg: any) => {
      if (typeof arg === "function") return await arg(prismaClientInstance);
      if (Array.isArray(arg)) return await Promise.all(arg);
      return arg;
    }
  };
}

export const prisma = prismaClientInstance;
export { inMemoryStore };

/**
 * True when `prisma` is backed by a real PrismaClient connected through the pg
 * driver adapter. False when the standalone in-memory mock is in use
 * (non-production/test only). Used by /health and the startup gate so a mock
 * database can never be reported as a healthy PostgreSQL.
 */
export function isRealPrismaClient(): boolean {
  return isRealClient;
}
