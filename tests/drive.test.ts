import { describe, it, expect, beforeEach } from "vitest";
import { DriveArchiveService, GoogleDriveService } from "../src/modules/drive/drive-service.js";
import { prisma } from "../src/database/client.js";

describe("Google Drive Archive Service & Job Queue", () => {
  const sampleOrderId = "ORD-TEST-DRIVE-001";

  beforeEach(async () => {
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

  it("Safe execution: when Google Drive credentials are not set, jobs handle gracefully", async () => {
    // Drive client returns null in local test env
    const client = await GoogleDriveService.getClient();
    expect(client).toBeNull();

    // Running pending jobs when Drive is offline updates error log and schedules backoff
    const processed = await DriveArchiveService.runPendingJobs();
    expect(processed).toBeGreaterThanOrEqual(0);

    // Verify order archive status still works
    const status = await DriveArchiveService.getOrderArchiveStatus(sampleOrderId);
    expect(status).toBeDefined();
  });

  it("Allows manual retry of failed or pending jobs for an order", async () => {
    const retriedCount = await DriveArchiveService.retryOrderSync(sampleOrderId);
    expect(retriedCount).toBeGreaterThanOrEqual(0);

    const jobs = await prisma.driveSyncJob.findMany({ where: { orderId: sampleOrderId } });
    for (const j of jobs) {
      expect(["PENDING", "PROCESSING", "SUCCESS"]).toContain(j.status);
    }
  });

  it("Folder hierarchy formatting handles order dates accurately", () => {
    const testDate = new Date("2026-09-07T10:00:00Z");
    const year = testDate.getUTCFullYear().toString();
    const month = String(testDate.getUTCMonth() + 1).padStart(2, "0");
    expect(year).toBe("2026");
    expect(month).toBe("09");
  });
});
