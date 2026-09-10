/**
 * C3 — per-staff selected-chat state.
 *
 * SAFETY: scoped by staff Telegram id. Never a global currentCustomerId.
 *
 * Storage: process-memory Map. On restart, all selections are lost and staff
 * are told "Bạn chưa chọn khách để trả lời." — we never guess/recover a
 * customer across restarts. No Prisma schema change.
 */

const selectedChat = new Map<string, string>();

/** Staff enters reply mode for a specific customer. */
export function setSelectedCustomer(staffTelegramId: string, customerId: string): void {
  const tid = String(staffTelegramId || "").trim();
  if (!tid) return;
  selectedChat.set(tid, customerId);
}

/** Return the customer id this staff is currently replying to, if any. */
export function getSelectedCustomer(staffTelegramId: string): string | undefined {
  return selectedChat.get(String(staffTelegramId || "").trim());
}

/** Staff exits reply mode / switches away. */
export function clearSelectedCustomer(staffTelegramId: string): void {
  selectedChat.delete(String(staffTelegramId || "").trim());
}
