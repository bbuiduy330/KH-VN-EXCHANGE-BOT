/**
 * CANONICAL APPLICATION TIMEZONE (single source of truth).
 *
 * All human-facing (Telegram-visible) timestamps and application log time
 * representations are rendered in Asia/Ho_Chi_Minh (UTC+07:00) — for BOTH the
 * Vietnam and Cambodia operations. Storage is NOT affected: every Prisma
 * DateTime / audit / scheduler timestamp remains an absolute Date; business
 * and financial deadline math stays pure epoch arithmetic and never uses this
 * module. Only DISPLAY goes through here.
 *
 * Implementation: Intl.DateTimeFormat with an explicit `timeZone` — no manual
 * "+7 hours" arithmetic anywhere, no new dependency. Formatters are created
 * once and reused (Intl.DateTimeFormat is reusable for repeated formatting).
 */

export const APP_TIMEZONE = "Asia/Ho_Chi_Minh";
export const APP_TIMEZONE_OFFSET = "+07:00";
export const APP_TIMEZONE_LABEL = "GMT+7 (Asia/Ho_Chi_Minh)";

/** Reusable part extractor (hourCycle h23 → never "24" for midnight). */
const partFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

/** Extract the GMT+7 wall-clock parts of an absolute Date. */
function hcmParts(date: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of partFormatter.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

function safeDate(date: Date | string | number | null | undefined): Date | null {
  if (date === null || date === undefined) return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "12/09/2026 14:35" — Admin-facing full timestamp (GMT+7, 24h). */
export function formatAdminDateTime(date: Date | string | number | null | undefined): string {
  const d = safeDate(date);
  if (!d) return "N/A";
  const p = hcmParts(d);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** "12/09 14:35" — compact list rows (GMT+7). */
export function formatShortDateTime(date: Date | string | number | null | undefined): string {
  const d = safeDate(date);
  if (!d) return "N/A";
  const p = hcmParts(d);
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

/** "12/09/2026" — date only (GMT+7). */
export function formatAdminDate(date: Date | string | number | null | undefined): string {
  const d = safeDate(date);
  if (!d) return "N/A";
  const p = hcmParts(d);
  return `${p.day}/${p.month}/${p.year}`;
}

/** "14:35" — time only (GMT+7). */
export function formatAdminTime(date: Date | string | number | null | undefined): string {
  const d = safeDate(date);
  if (!d) return "N/A";
  const p = hcmParts(d);
  return `${p.hour}:${p.minute}`;
}

/**
 * Localized human timestamp with the CANONICAL timezone forced
 * ("12/09/2026, 14:35" for vi-VN). Locale changes wording, never the zone.
 */
export function formatDateTime(date: Date | string | number | null | undefined, locale: string = "vi-VN"): string {
  const d = safeDate(date);
  if (!d) return "N/A";
  return new Intl.DateTimeFormat(locale, {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(d);
}

/**
 * ISO-like local timestamp with an explicit offset for LOGS:
 * "2026-09-12T14:35:20+07:00".
 * Built from calendar parts in APP_TIMEZONE — never by shifting the epoch.
 */
export function formatIsoWithOffset(date: Date | string | number | null | undefined): string {
  const d = safeDate(date);
  if (!d) return "N/A";
  const p = hcmParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${APP_TIMEZONE_OFFSET}`;
}
