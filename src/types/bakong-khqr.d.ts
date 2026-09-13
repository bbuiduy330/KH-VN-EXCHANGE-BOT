/**
 * Ambient type declarations for `bakong-khqr` (official NBC KHQR JavaScript
 * SDK, npm v1.0.20 — repo gitlab.nbc.gov.kh:khqr/sdk-javascript).
 * The package ships CommonJS JS only (no .d.ts); this declaration mirrors the
 * ACTUAL exported API inspected from src/index.js and src/model/information.js:
 *   module.exports = { BakongKHQR, khqrData, SourceInfo, IndividualInfo, MerchantInfo }
 * CRC/checksum is computed internally by generateKHQR — never hand-rolled.
 */
declare module "bakong-khqr" {
  export interface KhqrOptionalData {
    accountInformation?: string;
    acquiringBank?: string;
    /** "USD" | "KHR" (khqrData.currency) — defaults to KHR when omitted. */
    currency?: string;
    /** Dynamic KHQR requires amount > 0. */
    amount?: string | number;
    billNumber?: string;
    storeLabel?: string;
    terminalLabel?: string;
    mobileNumber?: string;
    purposeOfTransaction?: string;
    languagePreference?: string;
    merchantNameAlternateLanguage?: string;
    merchantCityAlternateLanguage?: string;
    upiMerchantAccount?: string;
    /** Epoch milliseconds — official dynamic-QR expiration support. */
    expirationTimestamp?: string | number;
    merchantCategoryCode?: string;
  }

  export declare class IndividualInfo {
    bakongAccountID: string;
    currency: string;
    amount?: string | number;
    merchantName: string;
    merchantCity: string;
    billNumber?: string;
    expirationTimestamp?: string | number;
    constructor(
      bakongAccountID: string,
      merchantName: string,
      merchantCity: string,
      optional?: KhqrOptionalData
    );
  }

  export declare class MerchantInfo extends IndividualInfo {
    merchantID: string;
    acquiringBank: string;
    constructor(
      bakongAccountID: string,
      merchantName: string,
      merchantCity: string,
      merchantID: string,
      acquiringBank: string,
      optional?: KhqrOptionalData
    );
  }

  /**
   * RUNTIME shape (VPS-verified): generateIndividual/generateMerchant return
   * { status: { code }, data: { qr } } — success when status.code === 0 and
   * data.qr carries the payload. A top-level `qr` is kept optional for the
   * decode() APIs but is NOT the generate() success contract.
   */
  export interface KHQRResponse {
    status?: {
      /** 0 = success. */
      code: number;
      errorCode?: number | string;
      message?: string;
    };
    data?: {
      qr?: string;
      md5?: string;
    };
    /** Legacy/decode surface — not the generate() success contract. */
    qr?: string;
    md5?: string;
  }

  export interface CRCValidation {
    isValid: boolean;
  }

  export declare const khqrData: {
    currency: { usd: string; khr: string };
    merchantType: { individual: string; merchant: string };
  };

  export declare class BakongKHQR {
    constructor();
    generateIndividual(individualInfo: IndividualInfo): KHQRResponse;
    generateMerchant(merchantInfo: MerchantInfo): KHQRResponse;
    static verify(KHQRString: string): CRCValidation;
    static decode(KHQRString: string): KHQRResponse;
    static decodeNonKhqr(content: string): KHQRResponse;
    static generateDeepLink(url: string, qr: string, sourceInfo?: unknown): Promise<KHQRResponse>;
    static checkBakongAccount(url: string, bakongID: string): Promise<KHQRResponse>;
  }
}
