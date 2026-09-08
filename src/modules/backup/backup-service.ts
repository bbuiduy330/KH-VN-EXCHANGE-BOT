import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { prisma } from "../../database/client.js";
import { RuntimeConfigService } from "../system-config/runtime-config-service.js";

const execAsync = promisify(exec);

export interface BackupExecutionResult {
  success: boolean;
  message: string;
  runId: string;
  status: "SUCCESS" | "FAILED";
  snapshotId?: string;
  error?: string;
  durationSeconds?: number;
}

export class BackupService {
  private static schedulerInterval: NodeJS.Timeout | null = null;
  private static isExecuting = false;

  /**
   * Enqueues a new backup run request in the database.
   * Status starts at "QUEUED".
   */
  static async requestBackup(requestedBy: string = "TELEGRAM_ADMIN", backupType: string = "FULL"): Promise<any> {
    const run = await prisma.backupRun.create({
      data: {
        requestedBy,
        requestedAt: new Date(),
        status: "QUEUED",
        backupType,
        repositoryType: "RESTIC"
      }
    });

    logger.info({ runId: run.id, requestedBy }, "Created QUEUED backup run");
    return run;
  }

  /**
   * Executes a backup run.
   * NEVER returns fake success. Returns SUCCESS only when real backup command/snapshot succeeds.
   */
  static async executeBackupRun(runId: string): Promise<BackupExecutionResult> {
    if (this.isExecuting) {
      return {
        success: false,
        message: "Tiến trình sao lưu khác đang chạy. Vui lòng chờ.",
        runId,
        status: "FAILED",
        error: "CONCURRENT_BACKUP_RUNNING"
      };
    }

    this.isExecuting = true;
    const startTime = Date.now();

    await prisma.backupRun.update({
      where: { id: runId },
      data: {
        status: "RUNNING",
        startedAt: new Date()
      }
    });

    const rootDir = env.STORAGE_ROOT || "./data/KH-VN-EXCHANGE";
    const scriptPath = path.resolve("./scripts/backup-storage.sh");

    try {
      logger.info({ runId }, "Starting real backup execution...");

      let snapshotId = `SNAP-${Date.now()}`;
      let commandOutput = "";

      // 1. If dedicated backup script exists, execute it
      if (fs.existsSync(scriptPath)) {
        const { stdout } = await execAsync(`bash "${scriptPath}"`, {
          timeout: 180000,
          env: {
            ...process.env,
            RUN_ID: runId,
            STORAGE_ROOT: rootDir
          }
        });
        commandOutput = stdout;
        // Parse snapshot ID if restic outputs one
        const match = stdout.match(/snapshot\s+([a-f0-9]+)\s+saved/i);
        if (match && match[1]) {
          snapshotId = match[1];
        }
      } else {
        // Fallback to strict tar archive verification if restic script is not yet configured
        const backupDir = path.join(rootDir, "_backup", "snapshots");
        if (!fs.existsSync(backupDir)) {
          fs.mkdirSync(backupDir, { recursive: true });
        }

        const tarFileName = `snapshot_${runId}_${Date.now()}.tar.gz`;
        const tarFilePath = path.join(backupDir, tarFileName);

        // Run tar - must exit cleanly
        await execAsync(`tar --exclude='_backup' -czf "${tarFilePath}" -C "${rootDir}" .`, {
          timeout: 120000
        });

        // Strict verification: file must exist and be > 0 bytes
        if (!fs.existsSync(tarFilePath)) {
          throw new Error("Tệp snapshot tar.gz không được tạo thành công trên hệ thống tệp.");
        }
        const stat = fs.statSync(tarFilePath);
        if (stat.size === 0) {
          throw new Error("Tệp snapshot rỗng (0 bytes). Sao lưu không hợp lệ.");
        }
        snapshotId = path.basename(tarFilePath);
      }

      const duration = Math.round((Date.now() - startTime) / 1000);

      await prisma.backupRun.update({
        where: { id: runId },
        data: {
          status: "SUCCESS",
          finishedAt: new Date(),
          snapshotId
        }
      });

      this.isExecuting = false;
      return {
        success: true,
        message: `Sao lưu hoàn tất thành công trong ${duration}s. Snapshot: ${snapshotId}`,
        runId,
        status: "SUCCESS",
        snapshotId,
        durationSeconds: duration
      };
    } catch (err: any) {
      const duration = Math.round((Date.now() - startTime) / 1000);
      const errMsg = err?.message || "Lỗi không xác định khi thực hiện sao lưu";

      logger.error({ runId, error: errMsg, duration }, "Backup run FAILED");

      await prisma.backupRun.update({
        where: { id: runId },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          error: errMsg
        }
      });

      this.isExecuting = false;
      return {
        success: false,
        message: `Sao lưu thất bại: ${errMsg}`,
        runId,
        status: "FAILED",
        error: errMsg,
        durationSeconds: duration
      };
    }
  }

  /**
   * Convenience method called by Admin Bot button: creates QUEUED run and executes it immediately
   */
  static async runBackupNow(requestedBy: string = "TELEGRAM_ADMIN"): Promise<BackupExecutionResult> {
    const run = await this.requestBackup(requestedBy, "FULL");
    return this.executeBackupRun(run.id);
  }

  static async getLatestRuns(limit: number = 10) {
    return prisma.backupRun.findMany({
      take: limit,
      orderBy: { createdAt: "desc" }
    });
  }

  static startScheduler(): void {
    if (this.schedulerInterval) return;

    this.schedulerInterval = setInterval(async () => {
      try {
        if (!RuntimeConfigService.isBackupEnabled()) return;
        const hours = RuntimeConfigService.getBackupScheduleHours();
        logger.info({ hours }, "Scheduled backup check triggered");
        await this.runBackupNow("CRON_SCHEDULER");
      } catch (err: any) {
        logger.error({ error: err?.message }, "Scheduled backup error");
      }
    }, 60 * 60 * 1000); // Check every hour
  }

  static stopScheduler(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
  }
}
