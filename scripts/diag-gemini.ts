import { SystemSecretService } from "../src/modules/system-config/system-secret-service.js";
import { EncryptionService } from "../src/modules/security/encryption-service.js";
import { AiProvider } from "../src/modules/ai/ai-provider.js";
import { GeminiModelStrategy } from "../src/modules/ai/gemini-models.js";

async function runDiagnostic() {
  console.log("==================================================");
  console.log("         GEMINI STANDALONE DIAGNOSTIC             ");
  console.log("==================================================");

  try {
    const resolved = await SystemSecretService.resolveGeminiApiKey();
    const primaryModel = GeminiModelStrategy.getPrimaryModel();
    const maskedKey = EncryptionService.maskApiKey(resolved.key);

    console.log(`Config source: ${resolved.source}`);
    console.log(`Key preview:   ${maskedKey}`);
    console.log(`Primary model: ${primaryModel}`);

    if (!resolved.key) {
      console.log("Connection:    ERROR");
      console.log("Details:       API Key is not configured in ENCRYPTED_DB or ENV");
      console.log("==================================================");
      process.exit(1);
    }

    console.log("\nPinging Gemini API with safe fallback chain...");
    const testResult = await AiProvider.testGeminiConnection();

    if (testResult.ok) {
      console.log(`Connection:    OK`);
      console.log(`Fallback used: ${testResult.fallbackUsed ? "YES" : "NO"}`);
      console.log(`Actual model:  ${testResult.actualModel}`);
      console.log(`Latency:       ${testResult.latencyMs} ms`);
      console.log(`Response:      ${testResult.reply || "OK"}`);
      console.log("==================================================");
      console.log("Status:        SUCCESS (Diagnostic Passed)");
      process.exit(0);
    } else {
      console.log(`Connection:    ERROR`);
      console.log(`Fallback used: ${testResult.fallbackUsed ? "YES" : "NO"}`);
      console.log(`Actual model:  ${testResult.actualModel || "None"}`);
      console.log(`Latency:       ${testResult.latencyMs} ms`);
      console.log(`Error category:${testResult.errorCategory || "UNKNOWN"}`);
      console.log(`Error details: ${testResult.error}`);
      console.log("==================================================");
      console.log("Status:        FAILURE (Diagnostic Failed)");
      process.exit(1);
    }
  } catch (err: any) {
    console.error("Diagnostic execution error:", err?.message || err);
    console.log("==================================================");
    process.exit(1);
  }
}

runDiagnostic();
