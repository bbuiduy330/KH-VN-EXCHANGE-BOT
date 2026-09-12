import { describe, it, expect } from "vitest";
import QRCode from "qrcode";
import {
  decodeQrImagePayload,
  resampleRgba
} from "../src/modules/payment-qr/qr-image-decode.js";

/**
 * Focused tests for the LOCAL QR image decoder used by the Admin
 * "📷 Nhập từ QR ngân hàng" flow (dynamic QR end-to-end, decode stage).
 *
 * The payload content is arbitrary here — these tests cover the IMAGE decode
 * stage only. Payload classification (KHQR/VietQR) is covered in
 * qr-import.test.ts; end-to-end import in qr-import-runtime.test.ts.
 */

const PAYLOAD = "00020101021102930004A0000007270293TEST-PAYLOAD-DECODE-6304ABCD";

async function qrPngBuffer(payload: string, width: number): Promise<Buffer> {
  return QRCode.toBuffer(payload, {
    type: "png",
    width,
    margin: 1,
    errorCorrectionLevel: "M"
  });
}

/** Paste a QR PNG centered into a much larger white canvas (photo-like frame). */
async function embedInLargeCanvas(qrPng: Buffer, canvasSize: number): Promise<Buffer> {
  const pngMod: any = await import("pngjs");
  const PNG = pngMod.PNG ?? pngMod.default?.PNG;
  const qr = PNG.sync.read(qrPng);
  const canvas = new PNG({ width: canvasSize, height: canvasSize });
  canvas.data.fill(0xff); // white frame
  const ox = Math.floor((canvasSize - qr.width) / 2);
  const oy = Math.floor((canvasSize - qr.height) / 2);
  for (let y = 0; y < qr.height; y++) {
    for (let x = 0; x < qr.width; x++) {
      const si = (y * qr.width + x) * 4;
      const di = ((oy + y) * canvasSize + (ox + x)) * 4;
      canvas.data[di] = qr.data[si];
      canvas.data[di + 1] = qr.data[si + 1];
      canvas.data[di + 2] = qr.data[si + 2];
      canvas.data[di + 3] = qr.data[si + 3];
    }
  }
  return PNG.sync.write(canvas);
}

describe("QR image decode — import reliability (local, multi-scale)", () => {
  it("decodes a normal QR PNG (native scale)", async () => {
    const png = await qrPngBuffer(PAYLOAD, 512);
    const payload = await decodeQrImagePayload(png);
    expect(payload).toBe(PAYLOAD);
  });

  it("decodes a QR that is SMALL inside a LARGE photo-like frame (resample ladder)", async () => {
    // 240px QR inside a 1600px white frame — the classic bank-QR screenshot
    // shape that a single native-scale jsQR attempt frequently fails.
    const qrPng = await qrPngBuffer(PAYLOAD, 240);
    const framed = await embedInLargeCanvas(qrPng, 1600);
    const payload = await decodeQrImagePayload(framed);
    expect(payload).toBe(PAYLOAD);
  });

  it("returns null (never throws, never silence) for a valid image with NO QR", async () => {
    const pngMod: any = await import("pngjs");
    const PNG = pngMod.PNG ?? pngMod.default?.PNG;
    const blank = new PNG({ width: 400, height: 400 });
    blank.data.fill(0xff);
    const buffer = PNG.sync.write(blank);
    const payload = await decodeQrImagePayload(buffer);
    expect(payload).toBeNull();
  });

  it("rejects non-image uploads with an explicit Vietnamese error (never silence)", async () => {
    await expect(
      decodeQrImagePayload(Buffer.from("definitely-not-an-image"))
    ).rejects.toThrow(/PNG hoặc JPG/);
  });
});

describe("resampleRgba — deterministic downscale helper", () => {
  it("downscales dimensions to the target max side", () => {
    const data = new Uint8ClampedArray(64 * 4);
    data.fill(200);
    const out = resampleRgba({ data, width: 64, height: 64 }, 32);
    expect(out.width).toBe(32);
    expect(out.height).toBe(32);
    expect(out.data.length).toBe(32 * 32 * 4);
  });

  it("box-averages a uniform color exactly (no color drift)", () => {
    const data = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 10; data[i + 1] = 20; data[i + 2] = 30; data[i + 3] = 255;
    }
    const out = resampleRgba({ data, width: 8, height: 8 }, 4);
    expect(out.width).toBe(4);
    expect(out.data[0]).toBe(10);
    expect(out.data[1]).toBe(20);
    expect(out.data[2]).toBe(30);
    expect(out.data[3]).toBe(255);
  });

  it("never upscales (target above native keeps native size)", () => {
    const data = new Uint8ClampedArray(16 * 4);
    data.fill(255);
    const out = resampleRgba({ data, width: 2, height: 8 }, 100);
    expect(out.width).toBe(2);
    expect(out.height).toBe(8);
  });
});
