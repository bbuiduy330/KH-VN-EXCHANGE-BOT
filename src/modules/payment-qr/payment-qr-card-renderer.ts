/**
 * PROFESSIONAL PAYMENT QR CARD RENDERER (presentation only).
 *
 * Flow: authoritative payload → raw QR → professional payment card → Telegram.
 *
 * HARD RULES:
 *  - PRESENTATION ONLY: the QR payload/bank/amount/memo/CRC are NEVER modified;
 *    the QR is re-rendered locally from the SAME authoritative payload string.
 *  - Card content comes from FROZEN Order data (amount/memo) and the FROZEN
 *    receiving-account snapshot — never from live PaymentAccount rows.
 *  - 100% local rendering (@napi-rs/canvas + system DejaVu fonts from the
 *    Docker image). No external HTTP rendering services. No scraped logos:
 *    provider branding is text-only; "Powered by Victory Services" appears
 *    subtly in the footer.
 *  - Any rendering failure is surfaced to the caller (which falls back to the
 *    raw QR) — a card problem can NEVER block or corrupt a payment.
 */
import { logger } from "../../shared/logger.js";

export type CardProvider = "VIETQR" | "KHQR";

export interface PaymentCardInput {
  provider: CardProvider;
  /** Authoritative dynamic payload — rendered verbatim, never modified. */
  payload: string;
  /** Pre-formatted amount line from the FROZEN Order (MoneyService). */
  amountLine: string;
  /** FROZEN Order transferMemo. */
  memo: string;
  /** FROZEN receiving-account snapshot fields. */
  recipientName: string;
  bankLine: string;
  accountLine?: string;
  identityLine?: string;
}

export interface CardInfoRow {
  label: string;
  value: string;
  bold: boolean;
  mono: boolean;
}

export interface PaymentCardLayout {
  width: number;
  height: number;
  headerBg: string;
  headerTitle: string;
  headerSubtitle: string;
  qrPayload: string;
  qrArea: { x: number; y: number; size: number };
  amountLine: string;
  infoRows: CardInfoRow[];
  footer: string;
}

const CARD_WIDTH = 900;
const CARD_HEIGHT = 1500;
const HEADER_H = 170;
const QR_AREA_SIZE = 660;
const QUIET_ZONE_MODULES = 4;

/** Truncate long values to keep the card layout stable (display only). */
function cardText(value: string, max: number): string {
  const s = String(value || "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * PURE layout builder — everything on the card is decided here so it is fully
 * testable without a canvas backend. Values come ONLY from the caller's
 * FROZEN Order/snapshot data; `qrPayload` passes through VERBATIM.
 */
export function buildCardLayout(input: PaymentCardInput): PaymentCardLayout {
  const isKhqr = input.provider === "KHQR";
  const headerBg = isKhqr ? "#C8102E" : "#0B4F9E";
  const headerTitle = isKhqr ? "KHQR" : "VIETQR";
  const headerSubtitle = isKhqr ? "Scan to Pay · Thanh toán" : "Thanh toán";

  const infoRows: CardInfoRow[] = [];
  if (input.recipientName) {
    infoRows.push({ label: "Người nhận", value: cardText(input.recipientName, 42), bold: true, mono: false });
  }
  if (input.bankLine) {
    infoRows.push({
      label: isKhqr ? "Ngân hàng thụ hưởng" : "Ngân hàng",
      value: cardText(input.bankLine, 42),
      bold: false,
      mono: false
    });
  }
  if (!isKhqr && input.accountLine) {
    infoRows.push({ label: "Số tài khoản", value: cardText(input.accountLine, 28), bold: true, mono: true });
  }
  if (isKhqr && input.identityLine) {
    infoRows.push({ label: "", value: cardText(input.identityLine, 42), bold: false, mono: true });
  }
  if (input.memo) {
    infoRows.push({ label: "Nội dung", value: cardText(input.memo, 42), bold: false, mono: true });
  }

  return {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    headerBg,
    headerTitle,
    headerSubtitle,
    // VERBATIM authoritative payload — the renderer only draws it, never edits it:
    qrPayload: input.payload,
    qrArea: {
      x: Math.floor((CARD_WIDTH - QR_AREA_SIZE) / 2),
      y: 40 + HEADER_H + 30,
      size: QR_AREA_SIZE
    },
    amountLine: cardText(input.amountLine, 30),
    infoRows,
    footer: "Powered by Victory Services"
  };
}

// ---------------------------------------------------------------------------
// Canvas backend (injectable for tests; default = @napi-rs/canvas)
// ---------------------------------------------------------------------------
export interface CardCanvasLike {
  width: number;
  height: number;
  getContext(): any;
  encode(kind: "png"): Promise<Buffer>;
}

export type CardCanvasFactory = (width: number, height: number) => CardCanvasLike;

let canvasFactoryOverride: CardCanvasFactory | null = null;

/** Test-only injection. Pass null to restore the real backend. */
export function setCardCanvasFactoryForTests(factory: CardCanvasFactory | null): void {
  canvasFactoryOverride = factory;
}

async function loadCanvasFactory(): Promise<CardCanvasFactory> {
  if (canvasFactoryOverride) return canvasFactoryOverride;
  const mod = await import("@napi-rs/canvas");
  // No system fonts in the container ⇒ text would render as boxes; skip the
  // card entirely and let the caller fall back to the raw QR.
  if (!mod.GlobalFonts || mod.GlobalFonts.families.length === 0) {
    throw new Error("no system fonts available — payment card rendering skipped");
  }
  return (width: number, height: number) => {
    const canvas = mod.createCanvas(width, height);
    return {
      width,
      height,
      getContext: () => canvas.getContext("2d"),
      encode: (kind) => canvas.encode(kind)
    };
  };
}

function fillRoundRect(ctx: any, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

/**
 * Render the professional payment card PNG. Throws on ANY failure — callers
 * use renderPaymentCardSafe() which falls back to the raw QR.
 */
export async function renderPaymentCard(input: PaymentCardInput): Promise<Buffer> {
  const factory = await loadCanvasFactory();
  const layout = buildCardLayout(input);
  const card = factory(layout.width, layout.height);
  const ctx = card.getContext();

  // --- Background + outer card frame ---------------------------------------
  ctx.fillStyle = "#F4F5F7"; // subtle page background around the card
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.fillStyle = "#FFFFFF";
  fillRoundRect(ctx, 24, 24, layout.width - 48, layout.height - 48, 36);
  ctx.strokeStyle = "#D9DCE1";
  ctx.lineWidth = 2;
  ctx.stroke();

  // --- Header band (provider identity — text-only, no unauthorized assets) --
  ctx.fillStyle = layout.headerBg;
  fillRoundRect(ctx, 40, 40, layout.width - 80, HEADER_H, 28);
  ctx.fillStyle = "#FFFFFF";
  ctx.textBaseline = "alphabetic";
  ctx.font = 'bold 64px "DejaVu Sans", sans-serif';
  ctx.textAlign = "left";
  ctx.fillText(layout.headerTitle, 76, 40 + 78);
  ctx.font = '28px "DejaVu Sans", sans-serif';
  ctx.textAlign = "right";
  ctx.fillText(layout.headerSubtitle, layout.width - 76, 40 + 112);

  // --- QR: large, centered, uniform modules, generous quiet zone ------------
  const QRCode = (await import("qrcode")).default;
  const qr = QRCode.create(layout.qrPayload, { errorCorrectionLevel: "M" });
  const modules = qr.modules.size;
  const moduleSize = Math.floor(layout.qrArea.size / (modules + QUIET_ZONE_MODULES * 2));
  const qrPixels = moduleSize * modules;
  const qrX = layout.qrArea.x + Math.floor((layout.qrArea.size - qrPixels) / 2);
  const qrY = layout.qrArea.y + Math.floor((layout.qrArea.size - qrPixels) / 2);
  // White quiet-zone surface (no decorations behind/over the matrix):
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(qrX - moduleSize * QUIET_ZONE_MODULES, qrY - moduleSize * QUIET_ZONE_MODULES, qrPixels + moduleSize * QUIET_ZONE_MODULES * 2, qrPixels + moduleSize * QUIET_ZONE_MODULES * 2);
  ctx.fillStyle = "#000000";
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.modules.data[row * modules + col]) {
        ctx.fillRect(qrX + col * moduleSize, qrY + row * moduleSize, moduleSize, moduleSize);
      }
    }
  }

  // --- Amount (large, centered, below the QR) -------------------------------
  const amountY = layout.qrArea.y + layout.qrArea.size + 90;
  ctx.fillStyle = "#111111";
  ctx.font = 'bold 58px "DejaVu Sans", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(layout.amountLine, layout.width / 2, amountY);

  ctx.strokeStyle = "#E3E5E8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(120, amountY + 36);
  ctx.lineTo(layout.width - 120, amountY + 36);
  ctx.stroke();

  // --- Info rows -------------------------------------------------------------
  let y = amountY + 96;
  for (const row of layout.infoRows) {
    if (row.label) {
      ctx.fillStyle = "#7A818C";
      ctx.font = '26px "DejaVu Sans", sans-serif';
      ctx.textAlign = "left";
      ctx.fillText(row.label.toUpperCase(), 120, y);
      y += 38;
    }
    ctx.fillStyle = row.bold ? "#111111" : "#3A4048";
    ctx.font = `${row.bold ? "bold " : ""}${row.mono ? '30px "DejaVu Sans Mono", "DejaVu Sans", sans-serif' : '36px "DejaVu Sans", sans-serif'}`;
    ctx.textAlign = "left";
    ctx.fillText(row.value, 120, y);
    y += row.label ? 26 : 62;
  }

  // --- Footer (subtle Victory Services branding — identity stays primary) ---
  ctx.fillStyle = "#9AA0A8";
  ctx.font = '24px "DejaVu Sans", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(layout.footer, layout.width / 2, layout.height - 60);

  return card.encode("png");
}

/**
 * SAFE wrapper for the Telegram flow: any renderer/canvas/font failure is
 * logged (sanitized, no payload) and reported as null so the caller falls back
 * to the raw QR — a card problem can never block or corrupt a payment.
 */
export async function renderPaymentCardSafe(input: PaymentCardInput): Promise<Buffer | null> {
  try {
    return await renderPaymentCard(input);
  } catch (err) {
    logger.warn(
      {
        provider: input.provider,
        err: String((err as { message?: string })?.message || "unknown card render failure")
      },
      "Payment card rendering failed — falling back to raw QR"
    );
    return null;
  }
}

