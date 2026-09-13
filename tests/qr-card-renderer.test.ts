import { describe, it, expect, afterEach } from "vitest";
import {
  buildCardLayout,
  renderPaymentCard,
  renderPaymentCardSafe,
  setCardCanvasFactoryForTests,
  type CardCanvasFactory
} from "../src/modules/payment-qr/payment-qr-card-renderer.js";

/**
 * Part B — professional payment card renderer.
 *
 * Deterministic tests via a RECORDING canvas factory (pure JS): the QR matrix
 * itself is real (qrcode.create from the authoritative payload), only the
 * canvas backend is recorded. No fragile pixel-snapshot assertions.
 */

const vietqrInput = {
  provider: "VIETQR" as const,
  payload: "00020101021138540010A00000072701240006970418011088388319790208QRIBFTTA53037045802VN6304E72E",
  amountLine: "2,540,000 VND",
  memo: "A7K92 CK",
  recipientName: "CHE MINH QUANG",
  bankLine: "BIDV",
  accountLine: "8838831979"
};

const khqrInput = {
  provider: "KHQR" as const,
  payload: "00020101021130450016abaakhppxxx@abaa01091791681790208ABA Bank40390006abaP2P0112C7B3D112C50C02091791681795204000053038405802KH5911BUI DUY TON6010Phnom Penh630443AA",
  amountLine: "100.00 USD",
  memo: "TOMYPHAN",
  recipientName: "BUI DUY TON",
  bankLine: "ACLEDA",
  identityLine: "Bakong: khqr@aclb"
};

function makeRecordingCanvas() {
  const calls = {
    fillRect: [] as { x: number; y: number; w: number; h: number; style: string }[],
    fillText: [] as { text: string; style: string; font: string }[]
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    encode: async (kind: "png") => {
      expect(kind).toBe("png");
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG signature
    }
  };
  const ctx: any = {
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    lineWidth: 0,
    fillRect: (x: number, y: number, w: number, h: number) => {
      calls.fillRect.push({ x, y, w, h, style: ctx.fillStyle });
    },
    beginPath: () => {},
    moveTo: () => {},
    arcTo: () => {},
    closePath: () => {},
    fill: () => {},
    stroke: () => {},
    fillText: (text: string, _x: number, _y: number) => {
      calls.fillText.push({ text, style: ctx.fillStyle, font: ctx.font });
    }
  };
  const factory: CardCanvasFactory = (width, height) => {
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
  return { factory, calls };
}

afterEach(() => {
  setCardCanvasFactoryForTests(null);
});

describe("Card layout — pure, frozen-data only (B2/B3/B6)", () => {
  it("VietQR card carries bank/recipient/account/amount/memo from the FROZEN data", () => {
    const layout = buildCardLayout(vietqrInput);
    expect(layout.qrPayload).toBe(vietqrInput.payload); // payload passes through VERBATIM
    expect(layout.headerTitle).toBe("VIETQR");
    expect(layout.amountLine).toBe("2,540,000 VND");
    const values = layout.infoRows.map((r) => r.value);
    expect(values).toContain("CHE MINH QUANG");
    expect(values).toContain("BIDV");
    expect(values).toContain("8838831979");
    const memoRow = layout.infoRows.find((r) => r.label === "Nội dung");
    expect(memoRow?.value).toBe("A7K92 CK");
  });

  it("KHQR card carries merchant/bank/bakong identity, no VietQR account row", () => {
    const layout = buildCardLayout(khqrInput);
    expect(layout.qrPayload).toBe(khqrInput.payload);
    expect(layout.headerTitle).toBe("KHQR");
    expect(layout.amountLine).toBe("100.00 USD");
    const values = layout.infoRows.map((r) => r.value);
    expect(values).toContain("BUI DUY TON");
    expect(values).toContain("ACLEDA");
    expect(values).toContain("Bakong: khqr@aclb");
    expect(layout.infoRows.some((r) => r.label === "Số tài khoản")).toBe(false); // KHQR: no bank-account row
  });

  it("never invents identity: empty fields are omitted", () => {
    const layout = buildCardLayout({
      provider: "KHQR",
      payload: "P",
      amountLine: "1.00 USD",
      memo: "",
      recipientName: "",
      bankLine: ""
    });
    expect(layout.infoRows.length).toBe(0);
    expect(layout.qrPayload).toBe("P");
  });
});

describe("Card rendering — recording canvas (B5/B7)", () => {
  it("VietQR dynamic input produces a rendered card image containing the frozen metadata", async () => {
    const { factory, calls } = makeRecordingCanvas();
    setCardCanvasFactoryForTests(factory);
    const image = await renderPaymentCard(vietqrInput);
    // Structural PNG check:
    expect(Buffer.isBuffer(image)).toBe(true);
    expect(image.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // Card contains the frozen amount + memo + account:
    const texts = calls.fillText.map((f) => f.text);
    expect(texts).toContain("VIETQR");
    expect(texts).toContain("2,540,000 VND");
    expect(texts).toContain("CHE MINH QUANG");
    expect(texts).toContain("BIDV");
    expect(texts).toContain("8838831979");
    expect(texts).toContain("NỘI DỤNG");
    expect(texts).toContain("A7K92 CK");
    expect(texts).toContain("Powered by Victory Services");
  });

  it("KHQR dynamic input produces a KHQR-styled card image", async () => {
    const { factory, calls } = makeRecordingCanvas();
    setCardCanvasFactoryForTests(factory);
    const image = await renderPaymentCard(khqrInput);
    expect(Buffer.isBuffer(image)).toBe(true);
    const texts = calls.fillText.map((f) => f.text);
    expect(texts).toContain("KHQR");
    expect(texts).toContain("100.00 USD");
    expect(texts).toContain("BUI DUY TON");
    expect(texts).toContain("ACLEDA");
    expect(texts).toContain("Bakong: khqr@aclb");
  });

  it("QR modules are drawn with UNIFORM size on a white quiet zone (scan safety)", async () => {
    const { factory, calls } = makeRecordingCanvas();
    setCardCanvasFactoryForTests(factory);
    await renderPaymentCard(vietqrInput);
    const blackModules = calls.fillRect.filter((r) => r.style === "#000000");
    expect(blackModules.length).toBeGreaterThan(100); // real QR matrix drawn
    const widths = new Set(blackModules.map((r) => r.w));
    const heights = new Set(blackModules.map((r) => r.h));
    expect(widths.size).toBe(1); // uniform, non-distorted modules
    expect(heights.size).toBe(1);
    const moduleWidth = [...widths][0];
    expect(moduleWidth).toBeDefined();
    // QR area (21+ modules) stays large/scannable:
    expect(moduleWidth * 21).toBeGreaterThanOrEqual(400);
    expect(blackModules.every((r) => r.w === r.h)).toBe(true);
  });

  it("render failure falls back safely: renderPaymentCardSafe returns null (raw QR used)", async () => {
    setCardCanvasFactoryForTests(() => {
      throw new Error("no system fonts available — payment card rendering skipped");
    });
    const result = await renderPaymentCardSafe(vietqrInput);
    expect(result).toBeNull();
    // The throwing variant surfaces the error for callers that want it:
    await expect(renderPaymentCard(vietqrInput)).rejects.toThrow(/fonts/);
  });

  it("card renderer does NOT alter the authoritative payload", async () => {
    const { factory } = makeRecordingCanvas();
    setCardCanvasFactoryForTests(factory);
    const before = vietqrInput.payload;
    await renderPaymentCard(vietqrInput);
    expect(vietqrInput.payload).toBe(before); // input untouched
    expect(buildCardLayout(vietqrInput).qrPayload).toBe(before);
  });
});

