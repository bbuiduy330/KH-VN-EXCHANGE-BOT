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
 * Box-average downscale of an RGBA image so the longest side == targetMaxDim.
 * Used by the decode ladder: bank-QR photos usually have the QR occupying a
 * small fraction of a large frame — jsQR often fails at native scale but
 * decodes reliably at a resampled scale. Pure JS, still 100% local.
 */
export function resampleRgba(pixels: ImagePixels, targetMaxDim: number): ImagePixels {
  const scale = Math.min(1, targetMaxDim / Math.max(pixels.width, pixels.height));
  const tw = Math.max(1, Math.round(pixels.width * scale));
  const th = Math.max(1, Math.round(pixels.height * scale));
  const out = new Uint8ClampedArray(tw * th * 4);
  const xRatio = pixels.width / tw;
  const yRatio = pixels.height / th;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(pixels.height, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(pixels.width, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const idx = (yy * pixels.width + xx) * 4;
          r += pixels.data[idx];
          g += pixels.data[idx + 1];
          b += pixels.data[idx + 2];
          a += pixels.data[idx + 3];
          count++;
        }
      }
      const o = (y * tw + x) * 4;
      out[o] = r / count;
      out[o + 1] = g / count;
      out[o + 2] = b / count;
      out[o + 3] = a / count;
    }
  }
  return { data: out, width: tw, height: th };
}

/** Downscale ladder: native first, then progressively smaller resamples. */
const DECODE_LADDER_MAX_DIMS = [1024, 768, 560, 400, 260];

/**
 * Decode a QR payload string from a PNG/JPEG image buffer.
 * Tries the native resolution first, then a resample ladder — a QR that is
 * small inside a large photo frame usually only decodes after downscaling.
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
  if (typeof jsQR !== "function") {
    throw new Error("Thư viện giải mã QR cục bộ (jsqr) không hợp lệ.");
  }

  const maxDim = Math.max(pixels.width, pixels.height);
  const candidates: ImagePixels[] = [pixels];
  for (const target of DECODE_LADDER_MAX_DIMS) {
    if (target < maxDim) candidates.push(resampleRgba(pixels, target));
  }

  for (const candidate of candidates) {
    let decoded: any;
    try {
      decoded = jsQR(candidate.data, candidate.width, candidate.height, { inversionAttempts: "attemptBoth" });
    } catch {
      // A single failing scale must not abort the ladder.
      continue;
    }
    if (decoded?.data) {
      const payload = String(decoded.data || "").trim();
      if (payload) {
        logger.info(
          { scale: `${candidate.width}x${candidate.height}`, native: `${pixels.width}x${pixels.height}` },
          "QR import: QR symbol decoded"
        );
        return payload;
      }
    }
  }
  logger.info(
    { bytes: buffer.length, attempts: candidates.length },
    "QR import: no QR symbol found in uploaded image (native + resample ladder)"
  );
  return null;
}
