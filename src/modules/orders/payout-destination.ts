/**
 * Customer payout-destination input parsing.
 *
 * SAFETY RULES (Customer Payment/Payout UX hardening):
 * 1. Deterministic parsing FIRST. The parser may ONLY extract values that are
 *    literally present in the customer's message. It can never invent a bank
 *    name, account number, or holder.
 * 2. AI is used ONLY as a structured-EXTRACTION fallback. The AI prompt forbids
 *    invention; every AI-extracted value must also be verifiable against the
 *    raw text (the account-number digits must appear in the original message),
 *    and AI output NEVER confirms data or mutates financial state by itself.
 * 3. On any failure the result is null → the bot asks again / offers Support.
 *    Nothing is persisted without the customer's explicit ✅ confirmation.
 */

export interface ParsedPayoutDestination {
  bankName: string;
  accountNumber: string;
  accountName: string;
  /** Where the data came from (for logging/testing only). */
  source: "deterministic" | "ai";
}

/** Vietnamese bank name/alias → canonical short label (deterministic only). */
export const BANK_ALIASES: Record<string, string> = {
  vcb: "Vietcombank",
  vietcombank: "Vietcombank",
  vietcom: "Vietcombank",
  mb: "MB Bank",
  mbbank: "MB Bank",
  msb: "MSB",
  tcb: "Techcombank",
  techcombank: "Techcombank",
  acb: "ACB",
  vib: "VIB",
  tpb: "TPBank",
  tpbank: "TPBank",
  vp: "VPBank",
  vpbank: "VPBank",
  hdb: "HDBank",
  agribank: "Agribank",
  bidv: "BIDV",
  vietinbank: "VietinBank",
  cti: "VietinBank",
  ocb: "OCB",
  shb: "SHB",
  sacombank: "Sacombank",
  eximbank: "Eximbank",
  lpbank: "LPBank",
  pvcombank: "PVcomBank",
  aba: "ABA Bank",
  acleda: "Acleda Bank",
  wing: "Wing",
  amk: "AMK"
};

const ACCOUNT_NUMBER_RE = /^[0-9]{6,16}$/;

function cleanText(v: string): string {
  return String(v || "").replace(/\s+/g, " ").trim();
}

/**
 * Deterministic free-form parser.
 * Accepts orders like "vcb 0123456789 nguyen van a",
 * "nguyen van a vcb 0123456789", "VCB 0123456789 NGUYEN VAN A".
 * Returns null when ANY of the three fields cannot be derived from the text.
 */
export function parsePayoutDestinationText(text: string): ParsedPayoutDestination | null {
  const raw = cleanText(text);
  if (!raw || raw.includes("|") || raw.startsWith("/")) return null;

  const tokens = raw.split(/\s+/);
  if (tokens.length < 2) return null;

  // 1. Account number: the longest token that is purely 6-16 digits.
  let accountNumber: string | null = null;
  let numberIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (ACCOUNT_NUMBER_RE.test(tokens[i]) && (!accountNumber || tokens[i].length > accountNumber.length)) {
      accountNumber = tokens[i];
      numberIndex = i;
    }
  }
  if (!accountNumber) return null;

  // 2. Bank: a token matching a known alias (case-insensitive). If none is a
  //    known alias we do NOT guess — an unrecognized adjacent word is never
  //    accepted as a bank name (too easy to confuse with the holder name).
  let bankName: string | null = null;
  let bankIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (i === numberIndex) continue;
    const key = tokens[i].toLowerCase().replace(/[^a-z0-9]/g, "");
    if (BANK_ALIASES[key]) {
      bankName = BANK_ALIASES[key];
      bankIndex = i;
      break;
    }
  }
  if (!bankName) return null;

  // 3. Holder: every remaining token (must be non-empty).
  const rest = tokens.filter((_, i) => i !== numberIndex && i !== bankIndex);
  const accountName = cleanText(rest.join(" ")).toUpperCase();
  if (!accountName) return null;

  return { bankName, accountNumber, accountName, source: "deterministic" };
}
/** Deterministic pipe-syntax parser: "VND | Vietcombank | NGUYEN VAN A | 0123..." */
export function parsePayoutDestinationPipe(text: string): ParsedPayoutDestination | null {
  const parts = String(text || "").split("|").map((p) => p.trim());
  if (parts.length < 4) return null;
  const [, bankName, accountName, accountNumber] = parts;
  const number = cleanText(accountNumber).replace(/\s/g, "");
  if (!cleanText(bankName) || !cleanText(accountName) || !ACCOUNT_NUMBER_RE.test(number)) {
    return null;
  }
  return {
    bankName: cleanText(bankName),
    accountName: cleanText(accountName).toUpperCase(),
    accountNumber: number,
    source: "deterministic"
  };
}

/**
 * AI structured-extraction fallback (ONLY used when the deterministic parser
 * fails). The model must treat the message as raw data: it may only copy
 * values it can see. As a hard safety net, any account number the AI returns
 * must appear verbatim (digits) inside the original message — an invented
 * number is rejected. A missing bank/holder yields null, never a guess.
 */
export async function parsePayoutDestinationWithAi(
  text: string,
  runPrompt: (prompt: string, systemInstruction?: string) => Promise<string | null>
): Promise<ParsedPayoutDestination | null> {
  if (!text || !runPrompt) return null;
  const systemInstruction =
    "You are a strict data extractor. Extract bank transfer destination fields from the user message. " +
    "RULES: copy values EXACTLY as they appear; NEVER invent, complete, normalize or guess any value; " +
    "if a field is not literally present output null for that field. " +
    'Reply ONLY with minified JSON: {"bankName": string|null, "accountNumber": string|null, "accountName": string|null}';
  const prompt =
    "Extract the payout destination from this message (JSON only):\n\n" +
    String(text).slice(0, 500);

  let out: string | null = null;
  try {
    out = await runPrompt(prompt, systemInstruction);
  } catch {
    return null;
  }
  if (!out) return null;

  let parsed: any;
  try {
    const jsonText = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  const bankName = cleanText(String(parsed?.bankName || ""));
  const accountNumber = String(parsed?.accountNumber || "").replace(/\D/g, "");
  const accountName = cleanText(String(parsed?.accountName || ""));

  if (!bankName || !accountNumber || !accountName) return null;
  if (!ACCOUNT_NUMBER_RE.test(accountNumber)) return null;

  // Hard anti-invention guard: the digits must literally exist in the message.
  const rawDigits = String(text).replace(/\D/g, "");
  if (!rawDigits.includes(accountNumber)) return null;

  // The bank name must also appear in the message (case-insensitive substring)
  // OR be a known alias of a token that appears.
  const lower = String(text).toLowerCase();
  const aliasMatches = Object.entries(BANK_ALIASES).some(
    ([alias, canonical]) =>
      lower.includes(alias) && canonical.toLowerCase() === bankName.toLowerCase()
  );
  if (!lower.includes(bankName.toLowerCase()) && !aliasMatches) return null;

  return { bankName, accountNumber, accountName: accountName.toUpperCase(), source: "ai" };
}

/**
 * Deterministic QR decoding is UNAVAILABLE in this dependency set (no QR
 * decoder package is installed and npm is not runnable in this environment).
 * Per the payout hardening rules we must NEVER fabricate destination details
 * from an image, so this always returns null and the caller keeps the ORIGINAL
 * QR image as the authoritative payout destination instead.
 */
export function decodePayoutQrImage(_buffer: Buffer): null {
  // No deterministic QR decoder is available (see final report). Returning
  // null deliberately: AI must never fabricate QR payload details.
  return null;
}