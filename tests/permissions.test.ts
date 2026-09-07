import { describe, it, expect, beforeEach } from "vitest";
import { PermissionService } from "../src/modules/permissions/permission-service.js";
import { env } from "../src/config/env.js";

describe("Staff Management & PermissionService", () => {
  const superAdminId = env.SUPER_ADMIN_TELEGRAM_ID || "super-admin";
  const testAdminId = "999000111";
  const testCskhId = "999000222";

  beforeEach(async () => {
    // Setup test admin
    await PermissionService.inviteStaff({
      telegramId: testAdminId,
      name: "Test Admin",
      role: "ADMIN"
    });

    // Setup test CSKH
    await PermissionService.inviteStaff({
      telegramId: testCskhId,
      name: "Test CSKH",
      role: "CSKH"
    });
  });

  it("Super Admin has all permissions unconditionally", async () => {
    expect(await PermissionService.hasPermission(superAdminId, "payment.verify")).toBe(true);
    expect(await PermissionService.hasPermission(superAdminId, "rate.edit")).toBe(true);
    expect(await PermissionService.hasPermission(superAdminId, "staff.manage")).toBe(true);
    expect(await PermissionService.hasPermission(superAdminId, "permission.manage")).toBe(true);
    expect(await PermissionService.isSuperAdmin(superAdminId)).toBe(true);
  });

  it("Enforces default role permissions: CSKH cannot verify payments or edit rates", async () => {
    expect(await PermissionService.hasPermission(testCskhId, "customer.view")).toBe(true);
    expect(await PermissionService.hasPermission(testCskhId, "customer.message")).toBe(true);
    expect(await PermissionService.hasPermission(testCskhId, "conversation.claim")).toBe(true);

    expect(await PermissionService.hasPermission(testCskhId, "payment.verify")).toBe(false);
    expect(await PermissionService.hasPermission(testCskhId, "payout.approve")).toBe(false);
    expect(await PermissionService.hasPermission(testCskhId, "rate.edit")).toBe(false);
    expect(await PermissionService.hasPermission(testCskhId, "staff.manage")).toBe(false);
  });

  it("Enforces default role permissions: ADMIN can view orders and verify payments, but cannot manage staff without explicit permission or SuperAdmin", async () => {
    expect(await PermissionService.hasPermission(testAdminId, "order.view")).toBe(true);
    expect(await PermissionService.hasPermission(testAdminId, "payment.verify")).toBe(true);
    expect(await PermissionService.hasPermission(testAdminId, "payout.approve")).toBe(true);
  });

  it("Allows Super Admin or authorized Admin to grant and revoke granular permissions", async () => {
    // Initially CSKH cannot verify payment
    expect(await PermissionService.hasPermission(testCskhId, "payment.verify")).toBe(false);

    // Super Admin toggles payment.verify on for this CSKH
    const updated = await PermissionService.togglePermission(superAdminId, testCskhId, "payment.verify");
    expect(updated.permissions.includes("payment.verify")).toBe(true);
    expect(await PermissionService.hasPermission(testCskhId, "payment.verify")).toBe(true);

    // Toggle off again
    const revoked = await PermissionService.togglePermission(superAdminId, testCskhId, "payment.verify");
    expect(revoked.permissions.includes("payment.verify")).toBe(false);
    expect(await PermissionService.hasPermission(testCskhId, "payment.verify")).toBe(false);
  });

  it("Creates a one-time staff invite code with expiry and enforces claim flow", async () => {
    const invite = await PermissionService.createInvite(superAdminId, "CSKH", 24);
    expect(invite.code).toMatch(/^STAFF-[A-Z0-9]{5}$/);
    expect(invite.role).toBe("CSKH");
    expect(invite.status).toBe("PENDING");

    // Claim invite
    const candidateTelegramId = "888111222";
    const result = await PermissionService.claimInvite(invite.code, candidateTelegramId, "New Trainee CSKH");
    expect(result.staff.status).toBe("PENDING");
    expect(result.staff.role).toBe("CSKH");

    // Re-claiming the same code must fail (one-time use)
    await expect(
      PermissionService.claimInvite(invite.code, "777333444", "Another Person")
    ).rejects.toThrow(/đã được sử dụng/);

    // Approving the candidate activates them
    const pendingList = await PermissionService.getPendingApprovals();
    expect(pendingList.some((p: any) => p.telegramId === candidateTelegramId)).toBe(true);

    const approved = await PermissionService.approveStaff(superAdminId, candidateTelegramId, true);
    expect(approved.status).toBe("ACTIVE");
    expect(await PermissionService.hasPermission(candidateTelegramId, "customer.view")).toBe(true);
  });

  it("Allows disabling and re-enabling staff members", async () => {
    const toggled = await PermissionService.toggleStaffStatus(superAdminId, testCskhId);
    expect(toggled.status).toBe("DISABLED");

    // Disabled staff cannot perform actions
    expect(await PermissionService.hasPermission(testCskhId, "customer.view")).toBe(false);

    // Re-enable
    const reEnabled = await PermissionService.toggleStaffStatus(superAdminId, testCskhId);
    expect(reEnabled.status).toBe("ACTIVE");
    expect(await PermissionService.hasPermission(testCskhId, "customer.view")).toBe(true);
  });

  it("Prevents modifying or disabling Super Admin", async () => {
    await expect(PermissionService.toggleStaffStatus(superAdminId, superAdminId)).rejects.toThrow();
    await expect(
      PermissionService.togglePermission(superAdminId, superAdminId, "rate.edit")
    ).rejects.toThrow();
  });
});
