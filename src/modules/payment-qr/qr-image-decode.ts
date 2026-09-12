/**
 * LOCAL QR image decoder for the Admin "📷 Nhập từ QR ngân hàng" flow.
 *
 * ARCHITECTURE RULES:
 *  - 100% LOCAL: the uploaded bank-QR image is decoded in-process and is
 *    NEVER uploaded to any external/HTTP decoding service.
 *  - Minimal scope: `jsqr` (pure-JS QR symbol decoder) + `pngjs` (PNG) +
 *    `jpeg-js` (JPEG) — all pure JavaScript, no native build, no network.
 *  - Dependencies are imported DYNAMICALLY so a missing install degrades to
 *    a clear Admin-facing error instead of crashing the bot process.
 */
import { logger } from "../../shared/logger.js";

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length > 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  );
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

interface ImagePixels {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

async function decodePng(buffer: Buffer): Promise<ImagePixels> {
  let PNGmod: any;
  try {
    PNGmod = await import("pngjs");
  } catch {
    throw new Error("Thiếu thư viện giải mã PNG cục bộ (pngjs). Vui lòng cài dependencies.");
  }
  const PNG = PNGmod.PNG ?? PNGmod.default?.PNG;
  if (!PNG) throw new Error("Thư viện pngjs không hợp lệ.");
  const png = PNG.sync.read(buffer);
  return { data: png.data, width: png.width, height: png.height };
}

async function decodeJpeg(buffer: Buffer): Promise<ImagePixels> {
  let jpegMod: any;
  try {
    jpegMod = await import("jpeg-js");
  } catch {
    throw new Error("Thiếu thư viện giải mã JPEG cục bộ (jpeg-js). Vui lòng cài dependencies.");
  }
  const jpeg = jpegMod.decode ?? jpegMod.default?.decode;
  if (!jpeg) throw new Error("Thư viện jpeg-js không hợp lệ.");
  // useTArray → Uint8Array RGBA output; tolerantTruncation accepts bank-scan JPEGs.
  const img = jpeg(buffer, { useTArray: true, tolerantTruncation: true });
  if (!img?.data) throw new Error("Không giải mã được ảnh JPEG.");
  return { data: img.data, width: img.width, height: img.height };
}

/**
 * Decode a QR payload string from a PNG/JPEG image buffer.
 * Returns null when the image is valid but contains NO readable QR symbol.
 * Throws a user-safe error message when decoders/dependencies are unusable.
 */
export async function decodeQrImagePayload(buffer: Buffer): Promise<string | null> {
  if (!buffer || buffer.length === 0) throw new Error("Ảnh trống.");

  let pixels: ImagePixels;
  if (isPng(buffer)) {
    pixels = await decodePng(buffer);
  } else if (isJpeg(buffer)) {
    pixels = await decodeJpeg(buffer);
  } else {
    throw new Error("Định dạng ảnh không được hỗ trợ. Vui lòng gửi ảnh PNG hoặc JPG.");
  }

  let jsQR: any;
  try {
    jsQR = (await import("jsqr")).default ?? (await import("jsqr"));
  } catch {
    throw new Error("Thiếu thư viện giải mã QR cục bộ (jsqr). Vui lòng cài dependencies.");
  }
  if (typeof jsQR !== "function") {
    jsQR = (jsQR as any)?.default ?? (jsQR as any)?.jsQR;
  }

  const decoded = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
  if (!decoded?.data) {
    logger.info({ bytes: buffer.length }, "QR import: no QR symbol found in uploaded image");
    return null;
  }
  return String(decoded.data || "").trim() || null;
}
