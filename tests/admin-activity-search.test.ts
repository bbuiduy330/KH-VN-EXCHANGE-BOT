import { describe, it, expect } from "vitest";
import { parseQueryHints, rankTextMatch, bigramSimilarity } from "../src/modules/search/unified-search.js";
import { orderStatusIcon } from "../src/modules/crm/customer-crm.js";

/**
 * PART B/C — activity-feed classification + unified-search ranking (pure).
 */
describe("Part C — search ranking + hints", () => {
  it("ranks exact > prefix > contains > fuzzy; non-match = 0", () => {
    expect(rankTextMatch("ziconat", "ziconat")).toBe(100);
    expect(rankTextMatch("zic", "ziconat")).toBe(80);
    expect(rankTextMatch("conat", "ziconat")).toBe(60);
    expect(rankTextMatch("zicnat", "ziconat")).toBeGreaterThan(0); // typo/fuzzy
    expect(rankTextMatch("xyz", "ziconat")).toBe(0);
  });

  it("numeric queries rank Telegram IDs / refs through the same ranker", () => {
    expect(rankTextMatch("8274", "8274294903")).toBe(80); // prefix of TG id
    expect(rankTextMatch("3300", "K-3300")).toBe(60);
  });

  it("bigram similarity is typo-tolerant and deterministic", () => {
    expect(bigramSimilarity("zicnat", "ziconat")).toBeGreaterThan(0.5);
    expect(bigramSimilarity("zicnat", "zicnat")).toBe(1);
    expect(bigramSimilarity("", "abc")).toBe(0);
  });

  it("parses amount+currency, direction and status hints from one query", () => {
    const hints = parseQueryHints("100 usd status:completed usd2vnd");
    expect(hints.amount).toBe(100);
    expect(hints.currency).toBe("USD");
    expect(hints.status).toBe("completed");
    expect(hints.directionUsdToVnd).toBe(true);
    expect(parseQueryHints("duy").amount).toBeNull();
  });
});

describe("Part B — activity/status presentation consistency", () => {
  it("status icons align with the CRM mapping used by the feed", () => {
    expect(orderStatusIcon("COMPLETED")).toBe("✅");
    expect(orderStatusIcon("SUSPICIOUS")).toBe("🚨");
  });
});
