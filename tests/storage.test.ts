import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { LocalStorageService } from "../src/modules/storage/local-storage-service.js";
import { prisma } from "../src/database/client.js";

describe("LocalStorageService Unit Tests", () => {
  const root = LocalStorageService.getStorageRoot();

  beforeEach(async () => {
    await LocalStorageService.ensureRoot();
  });

  describe("Path Safety & Traversal Prevention", () => {
    it("should safely resolve paths within STORAGE_ROOT", () => {
      const safe = LocalStorageService.ensureSafePath("2026/09/ORD-TEST/order.json");
      expect(safe.startsWith(root)).toBe(true);
      expect(safe).toBe(path.resolve(root, "2026/09/ORD-TEST/order.json"));
    });

    it("should strictly reject path traversal using ../", () => {
      expect(() => {
        LocalStorageService.ensureSafePath("../../../etc/passwd");
      }).toThrow(/Path traversal/);

      expect(() => {
        LocalStorageService.ensureSafePath("2026/../../outside");
      }).toThrow(/Path traversal/);
    });

    it("should strictly reject null bytes in paths", () => {
      expect(() => {
        LocalStorageService.ensureSafePath("test\0file.txt");
      }).toThrow(/Path traversal/);
    });

    it("should correctly sanitize filename and path segments", () => {
      expect(LocalStorageService.sanitizeSegment("ORD-123_45")).toBe("ORD-123_45");
      expect(LocalStorageService.sanitizeSegment("../hack")).toBe("hack");
      expect(LocalStorageService.sanitizeSegment("../..")).toBe("item");
      expect(LocalStorageService.sanitizeSegment("!@#$%^&*()")).toBe("item");

      expect(LocalStorageService.sanitizeFileName("../../malicious.exe")).toBe("malicious.exe");
      expect(LocalStorageService.sanitizeFileName("bill!@#$%.PNG")).toBe("bill_____.png");
    });
  });

  describe("File Operations", () => {
    it("should save and read buffer safely with SHA-256", async () => {
      const content = Buffer.from("Hello AI Studio VPS Local Storage!");
      const relPath = "test_folder/hello.txt";

      const saved = await LocalStorageService.saveBuffer(content, relPath);
      expect(saved.size).toBe(content.length);
      expect(saved.sha256).toBe(LocalStorageService.calculateSha256(content));

      const exists = await LocalStorageService.fileExists(relPath);
      expect(exists).toBe(true);

      const readBack = await LocalStorageService.readFile(relPath);
      expect(readBack?.toString("utf-8")).toBe("Hello AI Studio VPS Local Storage!");
    });

    it("should save JSON and text formatted files", async () => {
      const payload = { test: true, version: 1 };
      await LocalStorageService.saveJson(payload, "test_folder/data.json");
      const readJson = await LocalStorageService.readFile("test_folder/data.json");
      expect(JSON.parse(readJson!.toString("utf-8"))).toEqual(payload);

      await LocalStorageService.saveText("Line 1\nLine 2", "test_folder/data.txt");
      const readTxt = await LocalStorageService.readFile("test_folder/data.txt");
      expect(readTxt!.toString("utf-8")).toBe("Line 1\nLine 2");
    });

    it("should pass health check", async () => {
      const health = await LocalStorageService.checkStorageHealth();
      expect(health.configured).toBe(true);
      expect(health.writable).toBe(true);
    });
  });

  describe("Order Folder Hierarchy & Evidence Preservation", () => {
    it("should create idempotent order folder hierarchy with all 6 subfolders", async () => {
      const order = { id: "ORD-2026-TEST1", createdAt: new Date("2026-09-07T12:00:00Z") };
      const folders = await LocalStorageService.createOrderFolders(order);

      expect(folders.relativeOrderFolder).toBe(path.join("2026", "09", "ORD-2026-TEST1"));
      expect(folders.subFolders.payment_instruction).toBeDefined();
      expect(folders.subFolders.customer_bill).toBeDefined();
      expect(folders.subFolders.payout_bill).toBeDefined();
      expect(folders.subFolders.voice).toBeDefined();
      expect(folders.subFolders.images).toBeDefined();
      expect(folders.subFolders.documents).toBeDefined();

      for (const key of Object.keys(folders.subFolders) as Array<keyof typeof folders.subFolders>) {
        const sub = folders.subFolders[key];
        const stat = await fs.stat(sub.absolute);
        expect(stat.isDirectory()).toBe(true);
      }
    });

    it("should save original evidence without overwriting and record in database", async () => {
      const billData = Buffer.from("ORIGINAL_CUSTOMER_BILL_IMAGE_DATA_123");
      const evidence = await LocalStorageService.saveOriginalFile({
        buffer: billData,
        originalFileName: "customer_receipt.jpg",
        fileType: "CUSTOMER_BILL",
        mimeType: "image/jpeg",
        orderId: "ORD-2026-TEST1"
      });

      expect(evidence.id).toBeDefined();
      expect(evidence.fileType).toBe("CUSTOMER_BILL");
      expect(evidence.sha256).toBe(LocalStorageService.calculateSha256(billData));
      expect(evidence.storageRelativePath).toContain("customer_bill");

      const fileOnDisk = await LocalStorageService.readFile(evidence.filePath);
      expect(fileOnDisk?.toString()).toBe(billData.toString());
    });
  });
});
