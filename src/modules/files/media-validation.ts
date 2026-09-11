/**
 * Safe evidence media-type validation (requirement F — bill image rejection).
 *
 * ROOT CAUSE of valid customer bill images being rejected:
 * the previous implementation derived the MIME type EXCLUSIVELY from the
 * `Content-Type` header of the Telegram file-server download response
 * (`https://api.telegram.org/file/bot.../`). That endpoint frequently serves
 * `application/octet-stream` (especially for `document` uploads and for
 * photos without an original filename), so a perfectly valid image bill was
 * rejected with "Định dạng tệp không được hỗ trợ".
 *
 * FINAL PRECEDENCE (financial-safety audit — magic bytes are AUTHORITATIVE):
 *   1. Magic-byte sniffing of the downloaded bytes — if a recognizable file
 *      signature exists (JPEG/PNG/WEBP/GIF/PDF), it WINS over everything.
 *      Telegram metadata, filename and HTTP headers are fallback hints ONLY.
 *      So "metadata says JPEG but bytes are clearly PDF" resolves to PDF, and
 *      "header says image/* but bytes contradict it" trusts the BYTES.
 *   2. Telegram metadata (`ctx.message.document.mime_type`) — fallback hint.
 *   3. File extension of the Telegram `file_path` / document filename.
 *   4. Download response Content-Type — last-resort hint.
 * A Telegram compressed `photo` has no filename at all — absence of a
 * filename/extension is explicitly NOT a rejection reason.
 *
 * OCR/AI extraction is assistive only and NEVER participates in evidence
 * acceptance (requirement F).
 */

export const ALLOWED_EVIDENCE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf"
] as const;

export type MediaRejectionReason =
  | "NONE"
  | "UNSUPPORTED_TYPE"
  | "UNKNOWN_TYPE"
  | "EMPTY_FILE";

export interface MediaResolution {
  /** Accepted MIME (normalized) or the best-known candidate when rejected. */
  mimeType: string;
  accepted: boolean;
  reason: MediaRejectionReason;
}

/** Magic-byte sniffing. Returns null for unknown signatures. */
export function sniffMimeFromBytes(buffer: Buffer | null | undefined): string | null {
  if (!buffer || buffer.length < 4) return null;
  const b = buffer;

  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  // PDF: %PDF
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  // WEBP: RIFF....WEBP
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString("ascii") === "RIFF" &&
    b.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  // GIF (historically accepted by the storage layer as a safe image type)
  if (b.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";

  return null;
}

function mimeFromExtension(path: string | null | undefined): string | null {
  const ext = String(path || "").split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf"
  };
  return map[ext] || null;
}

function normalizeMime(raw: string | null | undefined): string | null {
  // Strict-null fix (noUncheckedIndexedAccess): split(";")[0] is
  // string | undefined — normalize through a deliberate empty fallback.
  const firstPart = String(raw || "").trim().toLowerCase().split(";")[0];
  const m = (firstPart ?? "").trim();
  if (!m || m === "application/octet-stream" || m === "binary/octet-stream") return null;
  // Telegram sometimes serves the nonstandard "image/jpg".
  if (m === "image/jpg") return "image/jpeg";
  return m;
}

/**
 * Resolve the authoritative evidence MIME type. `telegramMime` comes from
 * Telegram metadata (document.mime_type); `fileNameOrPath` may be empty (a
 * compressed Telegram photo has NO original filename — that must never reject).
 *
 * Precedence implemented below (bytes are AUTHORITATIVE):
 *   1. magic-byte sniffing of `input.buffer` — wins over every hint;
 *   2. Telegram metadata — fallback hint;
 *   3. filename/extension — fallback hint;
 *   4. HTTP Content-Type — last-resort hint.
 */
export function resolveEvidenceMime(input: {
  telegramMime?: string | null;
  fileNameOrPath?: string | null;
  responseMime?: string | null;
  buffer?: Buffer | null;
}): MediaResolution {
  // Strict-null fix (defect B): the byte source is `input.buffer`, NOT a bare
  // `buffer` variable. Sniffing runs FIRST — recognizable magic bytes are
  // authoritative and always beat metadata/extension/header hints.
  const sniffed = normalizeMime(sniffMimeFromBytes(input.buffer));
  const candidates = [
    normalizeMime(input.telegramMime),
    sniffed,
    mimeFromExtension(input.fileNameOrPath),
    normalizeMime(input.responseMime)
  ].filter((m): m is string => m !== null);

  if (!input.buffer || input.buffer.length === 0) {
    const fallback = candidates[0] ?? "application/octet-stream";
    return { mimeType: fallback, accepted: false, reason: "EMPTY_FILE" };
  }

  // 1. Magic bytes win over everything for known signatures.
  if (sniffed) {
    return {
      mimeType: sniffed,
      accepted: (ALLOWED_EVIDENCE_MIMES as readonly string[]).includes(sniffed) || sniffed.startsWith("image/"),
      reason: "NONE"
    };
  }

  // 2-4. Fallback hints only (Telegram metadata first, then extension, then
  // HTTP header). A known-safe hint is accepted; nothing else is invented.
  for (const candidate of candidates) {
    if ((ALLOWED_EVIDENCE_MIMES as readonly string[]).includes(candidate) || candidate.startsWith("image/")) {
      return { mimeType: candidate, accepted: true, reason: "NONE" };
    }
  }

  const firstCandidate = candidates[0];
  if (firstCandidate !== undefined) {
    // Known but unsupported declared type → reject with a stable reason code;
    // never turn unknown media into an accepted image.
    return { mimeType: firstCandidate, accepted: false, reason: "UNSUPPORTED_TYPE" };
  }
  return { mimeType: "application/octet-stream", accepted: false, reason: "UNKNOWN_TYPE" };
}

/**
 * Safe diagnostic payload for rejected/accepted evidence. Logs reason code
 * ONLY — never bank-sensitive extracted contents (requirement F).
 */
export function logEvidenceDiagnostics(
  logger: { info: (obj: any, msg?: string) => void },
  data: {
    event: string;
    orderRef: string;
    mediaType: string;
    mimeType: string;
    bytes: number;
    reason?: MediaRejectionReason;
  }
): void {
  logger.info(
    {
      event: data.event,
      orderRef: data.orderRef,
      mediaType: data.mediaType,
      mimeType: data.mimeType,
      bytes: data.bytes,
      reason: data.reason || "NONE"
    },
    "evidence media diagnostic"
  );
}