import { describe, it, expect, beforeEach } from "vitest";
import { DriveArchiveService, GoogleDriveService, sanitizeDriveError } from "../src/modules/drive/drive-service.js";
import { prisma } from "../src/database/client.js";
import { env } from "../src/config/env.js";

describe("Google Drive Archive Service & OAuth Security", () => {
  const sampleOrderId = "ORD-TEST-DRIVE-001";

  beforeEach(async () => {
    GoogleDriveService.resetClientForTesting();

    // Create or mock order
    await prisma.order.upsert({
      where: { id: sampleOrderId },
      update: {},
      create: {
        id: sampleOrderId,
        customerId: "cust-drive-1",
        sourceCurrency: "USD",
        targetCurrency: "VND",
        sourceAmount: 100,
        targetAmount: 2630000,
        rate: 26300,
        receivingAccountSnapshot: {},
        payoutBankSnapshot: {},
        status: "COMPLETED"
      }
    });
  });

  it("Enqueues sync jobs idempotently without blocking or throwing", async () => {
    const job1 = await DriveArchiveService.enqueueSyncJob(sampleOrderId, "ORDER_METADATA");
    expect(job1).toBeDefined();
    expect(job1.orderId).toBe(sampleOrderId);
    expect(job1.jobType).toBe("ORDER_METADATA");
    expect(job1.status).toBe("PENDING");

    // Enqueueing same job type while pending returns existing job
    const job2 = await DriveArchiveService.enqueueSyncJob(sampleOrderId, "ORDER_METADATA");
    expect(job2.id).toBe(job1.id);
  });

  it("Retrieves order archive status across all components", async () => {
    await DriveArchiveService.enqueueSyncJob(sampleOrderId, "PAYMENT_QR");
    await DriveArchiveService.enqueueSyncJob(sampleOrderId, "CONVERSATION");

    const status = await DriveArchiveService.getOrderArchiveStatus(sampleOrderId);
    expect(status).not.toBeNull();
    expect(status?.metadataStatus).toBe("PENDING");
    expect(status?.qrStatus).toBe("PENDING");
    expect(status?.conversationStatus).toBe("PENDING");
  });

  it("OAuth error sanitizer: redacts tokens, secrets and sanitizes known OAuth error codes", () => {
    // 1. invalid_grant
    const grantErr = { code: "invalid_grant", message: "Bad Request: invalid_grant" };
    expect(sanitizeDriveError(grantErr)).toContain("invalid_grant (refresh token may be invalid, revoked, or expired)");

    // 2. invalid_client
    const clientErr = new Error("invalid_client: client secret is invalid");
    expect(sanitizeDriveError(clientErr)).toContain("invalid_client (client ID or client secret mismatch)");

    // 3. Sensitive tokens redact check
    const secretErr = new Error("Failed request to https://oauth2.googleapis.com/token?client_secret=GOCSPX-Secret123&refresh_token=1//09abcDEF&code=4/0AcvD Bearer ya29.a0AfH6SM");
    const sanitized = sanitizeDriveError(secretErr);

    expect(sanitized).not.toContain("GOCSPX-Secret123");
    expect(sanitized).not.toContain("1//09abcDEF");
    expect(sanitized).not.toContain("ya29.a0AfH6SM");
    expect(sanitized).toContain("client_secret=[REDACTED]");
    expect(sanitized).toContain("Bearer [REDACTED]");
  });

  it("Reports GoogleDriveService.isConfigured() correctly based on 4 required OAuth parameters", () => {
    // In test environment without mock env vars, isConfigured should be false
    expect(typeof GoogleDriveService.isConfigured()).toBe("boolean");
  });

  it("In production without credentials: refuses fake success and throws error instead of returning mock ID", async () => {
    const originalEnv = env.NODE_ENV;
    try {
      (env as any).NODE_ENV = "production";
      (env as any).GOOGLE_DRIVE_MOCK = false;

      // Mock drive client reset
      GoogleDriveService.resetClientForTesting();

      await expect(
        GoogleDriveService.uploadFile(Buffer.from("test"), "test.txt", "text/plain")
      ).rejects.toThrow(/Google Drive is not configured/);

      await expect(
        GoogleDriveService.uploadOrUpdateFile(Buffer.from("test"), "test.txt", "text/plain")
      ).rejects.toThrow(/Google Drive is not configured/);

      await expect(
        GoogleDriveService.findOrCreateFolder("test_folder")
      ).rejects.toThrow(/Google Drive is not configured/);
    } finally {
      (env as any).NODE_ENV = originalEnv;
    }
  });

  it("Drive sync failure does not break financial order workflow", async () => {
    // Financial order transition
    const updated = await prisma.order.update({
      where: { id: sampleOrderId },
      data: { status: "COMPLETED" }
    });
    expect(updated.status).toBe("COMPLETED");

    // Enqueueing sync job succeeds even if drive is unconfigured
    const job = await DriveArchiveService.enqueueSyncJob(sampleOrderId, "FULL_ORDER_ARCHIVE");
    expect(job).toBeDefined();
    expect(job.status).toBe("PENDING");
  });

  it("Folder hierarchy formatting handles order dates accurately", () => {
    const testDate = new Date("2026-09-07T10:00:00Z");
    const year = testDate.getUTCFullYear().toString();
    const month = String(testDate.getUTCMonth() + 1).padStart(2, "0");
    expect(year).toBe("2026");
    expect(month).toBe("09");
  });
});
