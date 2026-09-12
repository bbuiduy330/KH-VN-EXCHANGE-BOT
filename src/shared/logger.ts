import pino from "pino";
import { env } from "../config/env.js";
import { APP_TIMEZONE, APP_TIMEZONE_LABEL, formatIsoWithOffset } from "./app-time.js";

export const logger = pino({
  level: env.LOG_LEVEL || "info",
  // Machine timestamp stays canonical (epoch ISO, tooling-safe). The Human
  // GMT+7 wall-clock is ADDED as explicit fields via mixin — never ambiguous,
  // never hand-shifted (+7h arithmetic is forbidden; see app-time.ts).
  mixin() {
    return {
      localTime: formatIsoWithOffset(new Date()),
      timezone: APP_TIMEZONE,
      tzLabel: APP_TIMEZONE_LABEL
    };
  },
  transport:
    process.env.NODE_ENV !== "production"
      ? {
          target: "pino/file",
          options: { destination: 1 }
        }
      : undefined
});
