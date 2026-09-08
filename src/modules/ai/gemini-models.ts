import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";

export type GeminiErrorCategory =
  | "AUTHENTICATION"
  | "PERMISSION"
  | "SAFETY"
  | "INVALID_REQUEST"
  | "MODEL_NOT_FOUND"
  | "RATE_LIMIT"
  | "SERVER_ERROR"
  | "NETWORK_ERROR"
  | "UNKNOWN";

export interface GeminiErrorClassification {
  category: GeminiErrorCategory;
  canFallback: boolean;
  statusCode?: number;
  message: string;
  isAuthError: boolean;
}

export interface ModelExecutionResult<T> {
  result: T;
  requestedModel: string;
  actualModel: string;
  latencyMs: number;
  attempts: Array<{
    model: string;
    latencyMs: number;
    error?: GeminiErrorClassification;
  }>;
}

export class GeminiModelStrategy {
  static getPrimaryModel(): string {
    return env.GEMINI_PRIMARY_MODEL || "gemini-3.8-flash";
  }

  static getFallbackModel(): string {
    return env.GEMINI_FALLBACK_MODEL || "gemini-3.6-flash";
  }

  static getLiteModel(): string {
    return env.GEMINI_LITE_MODEL || "gemini-3.5-flash-lite";
  }

  /**
   * Returns deduplicated ordered chain of text models: [Primary, Fallback, Lite]
   */
  static getTextModelChain(primaryOverride?: string): string[] {
    const primary = primaryOverride?.trim() || this.getPrimaryModel();
    const defaultModels = [this.getPrimaryModel(), this.getFallbackModel(), this.getLiteModel()];

    return Array.from(new Set([primary, ...defaultModels].filter(Boolean)));
  }

  /**
   * Returns multimodal chain (Gemini 3.8 Flash primary multimodal model per Req 15)
   */
  static getMultimodalModelChain(primaryOverride?: string): string[] {
    const primary = primaryOverride?.trim() || this.getPrimaryModel();
    const fallback = this.getFallbackModel();
    const lite = this.getLiteModel();

    return Array.from(new Set([primary, fallback, lite].filter(Boolean)));
  }

  /**
   * Returns transcription model chain
   */
  static getTranscribeModelChain(primaryOverride?: string): string[] {
    const primary = primaryOverride?.trim() || this.getPrimaryModel();
    const fallback = this.getFallbackModel();
    const lite = this.getLiteModel();

    return Array.from(new Set([primary, fallback, lite].filter(Boolean)));
  }

  /**
   * Classifies any error into bounded fallback categories according to Requirement 2:
   * Fallback to another model ONLY for:
   * - 404 MODEL_NOT_FOUND / MODEL_UNAVAILABLE
   * - 429 RATE_LIMIT / RESOURCE_EXHAUSTED
   * - 500, 502, 503, 504 SERVER_ERROR
   * - NETWORK_ERROR
   *
   * Do NOT fallback for:
   * - 400 INVALID_REQUEST
   * - 401 AUTHENTICATION
   * - 403 PERMISSION
   * - SAFETY rejection
   * - Schema errors
   */
  static classifyError(error: any): GeminiErrorClassification {
    const rawMsg = String(error?.message || error || "");
    const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);

    // 1. Authentication (401 / API Key invalid)
    if (
      status === 401 ||
      /API_KEY_INVALID|UNAUTHENTICATED|API key not valid|invalid api key/i.test(rawMsg)
    ) {
      return {
        category: "AUTHENTICATION",
        canFallback: false,
        statusCode: 401,
        message: "Gemini API key is invalid or unauthenticated",
        isAuthError: true
      };
    }

    // 2. Permission (403)
    if (status === 403 || /PERMISSION_DENIED|forbidden/i.test(rawMsg)) {
      return {
        category: "PERMISSION",
        canFallback: false,
        statusCode: 403,
        message: "Access forbidden / permission denied",
        isAuthError: false
      };
    }

    // 3. Safety rejections
    if (/SAFETY|HARM_CATEGORY|BLOCKED|blocked due to safety/i.test(rawMsg)) {
      return {
        category: "SAFETY",
        canFallback: false,
        statusCode: 400,
        message: "Content blocked due to safety policy",
        isAuthError: false
      };
    }

    // 4. Invalid request / Schema errors (400)
    if (status === 400 || /INVALID_ARGUMENT|INVALID_REQUEST|JSON schema|bad request/i.test(rawMsg)) {
      return {
        category: "INVALID_REQUEST",
        canFallback: false,
        statusCode: 400,
        message: "Invalid request parameters or schema violation",
        isAuthError: false
      };
    }

    // 5. Model not found / unavailable (404) -> SAFE TO FALLBACK
    if (
      status === 404 ||
      /NOT_FOUND|MODEL_NOT_FOUND|model.*not found|is not supported|not available/i.test(rawMsg)
    ) {
      return {
        category: "MODEL_NOT_FOUND",
        canFallback: true,
        statusCode: 404,
        message: "Model not found or unavailable for project",
        isAuthError: false
      };
    }

    // 6. Rate Limit (429) -> SAFE TO FALLBACK
    if (
      status === 429 ||
      /RESOURCE_EXHAUSTED|quota|rate limit|too many requests/i.test(rawMsg)
    ) {
      return {
        category: "RATE_LIMIT",
        canFallback: true,
        statusCode: 429,
        message: "Rate limit reached or quota exhausted",
        isAuthError: false
      };
    }

    // 7. Server errors (500, 502, 503, 504) -> SAFE TO FALLBACK
    if ([500, 502, 503, 504].includes(status) || /INTERNAL|UNAVAILABLE|overloaded|server error/i.test(rawMsg)) {
      return {
        category: "SERVER_ERROR",
        canFallback: true,
        statusCode: status || 503,
        message: "Google server error or temporarily unavailable",
        isAuthError: false
      };
    }

    // 8. Network / Connection errors -> SAFE TO FALLBACK
    if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|network error|fetch failed/i.test(rawMsg)) {
      return {
        category: "NETWORK_ERROR",
        canFallback: true,
        message: "Network timeout or connection failure to Gemini API",
        isAuthError: false
      };
    }

    // Default: unknown error, do not blindly fallback
    const sanitizedMsg = rawMsg.replace(/AIza[0-9A-Za-z_-]{15,}/g, "[REDACTED_KEY]");
    return {
      category: "UNKNOWN",
      canFallback: false,
      statusCode: status || undefined,
      message: sanitizedMsg || "Unknown Gemini error",
      isAuthError: false
    };
  }

  /**
   * Executes an operation with bounded fallback across the model chain.
   * Maximum 1 attempt per model. No indefinite retry.
   */
  static async executeWithFallback<T>(
    models: string[],
    runner: (model: string) => Promise<T>,
    options?: {
      contextName?: string;
      onAuthError?: (errClassification: GeminiErrorClassification) => Promise<void> | void;
    }
  ): Promise<ModelExecutionResult<T>> {
    const requestedModel = models[0] || this.getPrimaryModel();
    const attempts: ModelExecutionResult<T>["attempts"] = [];

    let lastErrorClassification: GeminiErrorClassification | null = null;

    for (let i = 0; i < models.length; i++) {
      const currentModel: string = models[i] || this.getPrimaryModel();
      const startTime = Date.now();

      try {
        const result = await runner(currentModel);
        const latencyMs = Date.now() - startTime;

        attempts.push({
          model: currentModel,
          latencyMs
        });

        // Observability log (sanitized, no customer payment data, Requirement 17)
        logger.info(
          {
            provider: "Google Gemini",
            context: options?.contextName || "GeminiExecution",
            requestedModel,
            actualModel: currentModel,
            latencyMs,
            success: true,
            attemptsCount: attempts.length,
            timestamp: new Date().toISOString()
          },
          "Gemini API request succeeded"
        );

        return {
          result,
          requestedModel,
          actualModel: currentModel,
          latencyMs,
          attempts
        };
      } catch (err: any) {
        const latencyMs = Date.now() - startTime;
        const classification = this.classifyError(err);
        lastErrorClassification = classification;

        attempts.push({
          model: currentModel,
          latencyMs,
          error: classification
        });

        logger.warn(
          {
            provider: "Google Gemini",
            context: options?.contextName || "GeminiExecution",
            requestedModel,
            actualModel: currentModel,
            latencyMs,
            success: false,
            errorCategory: classification.category,
            statusCode: classification.statusCode,
            canFallback: classification.canFallback,
            timestamp: new Date().toISOString()
          },
          `Gemini call failed on model ${currentModel}: ${classification.message}`
        );

        // Surfacing authentication errors immediately (Requirement 2 & 10)
        if (classification.isAuthError && options?.onAuthError) {
          try {
            await options.onAuthError(classification);
          } catch (handlerErr) {
            logger.error({ handlerErr }, "Error executing onAuthError callback");
          }
        }

        // Bounded fallback check: only fallback if canFallback is true and there are more models
        if (!classification.canFallback || i === models.length - 1) {
          throw new Error(
            `Gemini execution failed (${classification.category}): ${classification.message} [Model: ${currentModel}]`
          );
        }

        logger.info(
          {
            fromModel: currentModel,
            nextModel: models[i + 1],
            reason: classification.category
          },
          "Triggering safe model fallback"
        );
      }
    }

    throw new Error(
      `All Gemini candidate models failed. Last error: ${lastErrorClassification?.category || "UNKNOWN"}`
    );
  }
}
