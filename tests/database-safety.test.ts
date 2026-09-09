import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Database initialization safety tests.
 *
 * Contract:
 * - Non-production (dev/test) may fall back to the in-memory mock.
 * - Production must NEVER silently fall back to the mock and must abort
 *   startup when Prisma/PostgreSQL initialization fails.
 */
describe("database client production safety", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    vi.resetModules();
  });

  it("allows the in-memory mock in the test environment", async () => {
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL; // force the no-DB path regardless of local .env
    vi.resetModules();

    const { prisma } = await import("../src/database/client.js");
    const created = await (prisma as any).systemSetting.create({
      data: { key: "safety-test", value: "1" }
    });

    expect(String(created.id)).toMatch(/^mock-/);
  });

  it("refuses to fall back to the mock in production when a query fails", async () => {
    process.env.NODE_ENV = "production";
    // Port 9 (discard protocol) is closed -> connection fails fast
    process.env.DATABASE_URL = "postgresql://exchange:redacted@127.0.0.1:9/exchange?connect_timeout=1";
    vi.resetModules();

    const { prisma, isRealPrismaClient } = await import("../src/database/client.js");
    expect(isRealPrismaClient()).toBe(true);
    await expect((prisma as any).systemSetting.findMany()).rejects.toThrow();
  });

  it("aborts module initialization in production without DATABASE_URL (startup fails)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    vi.resetModules();

    await expect(import("../src/database/client.js")).rejects.toThrow(
      /DATABASE_URL is required in production/
    );
  });
});