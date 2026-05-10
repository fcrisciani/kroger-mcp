import { describe, expect, it } from "vitest";
import { bannerHost, cadenceDays, cartUrl, isDue, priceLine, reorderForRelevance } from "../src/util.js";
import type { UsualItem } from "../src/types.js";

const DAY = 86_400_000;

function item(overrides: Partial<UsualItem> = {}): UsualItem {
  return {
    productId: "0001111041700",
    name: "Whole Milk, 1 gal",
    defaultQty: 1,
    cadence: "weekly",
    timesOrdered: 0,
    ...overrides,
  };
}

describe("isDue", () => {
  it("treats never-ordered items as due", () => {
    expect(isDue(item({ lastOrdered: undefined }))).toBe(true);
  });

  it("treats unparseable dates as due (defensive against bad KV data)", () => {
    expect(isDue(item({ lastOrdered: "not-a-date" }))).toBe(true);
  });

  it("is not due 1 day after a weekly order", () => {
    const now = Date.now();
    const lastOrdered = new Date(now - 1 * DAY).toISOString();
    expect(isDue(item({ cadence: "weekly", lastOrdered }), now)).toBe(false);
  });

  it("is due exactly at the cadence boundary minus the grace day", () => {
    const now = Date.now();
    const lastOrdered = new Date(now - 6 * DAY).toISOString();
    expect(isDue(item({ cadence: "weekly", lastOrdered }), now)).toBe(true);
  });

  it("respects biweekly and monthly cadences", () => {
    const now = Date.now();
    expect(
      isDue(item({ cadence: "biweekly", lastOrdered: new Date(now - 10 * DAY).toISOString() }), now),
    ).toBe(false);
    expect(
      isDue(item({ cadence: "biweekly", lastOrdered: new Date(now - 13 * DAY).toISOString() }), now),
    ).toBe(true);
    expect(
      isDue(item({ cadence: "monthly", lastOrdered: new Date(now - 20 * DAY).toISOString() }), now),
    ).toBe(false);
    expect(
      isDue(item({ cadence: "monthly", lastOrdered: new Date(now - 29 * DAY).toISOString() }), now),
    ).toBe(true);
  });

  it("cadenceDays exposes the right day counts", () => {
    expect(cadenceDays).toEqual({ weekly: 7, biweekly: 14, monthly: 30 });
  });
});

describe("priceLine", () => {
  it("renders a sale price with the original struck-through context", () => {
    expect(priceLine({ regularPrice: 4.99, promoPrice: 3.49, onSale: true })).toBe(
      "$3.49 (sale, was $4.99)",
    );
  });

  it("renders just the regular price when not on sale", () => {
    expect(priceLine({ regularPrice: 4.99, onSale: false })).toBe("$4.99");
  });

  it("falls back to a friendly string when no price is available", () => {
    expect(priceLine({ onSale: false })).toBe("price unavailable at this location");
  });

  it("ignores onSale=true if promo or regular price is missing (bad upstream data)", () => {
    expect(priceLine({ regularPrice: 4.99, onSale: true })).toBe("$4.99");
  });

  it("renders a legitimate $0.00 regular price instead of falling back", () => {
    expect(priceLine({ regularPrice: 0, onSale: false })).toBe("$0.00");
  });
});

describe("bannerHost / cartUrl", () => {
  it("maps known banner codes to their domains", () => {
    expect(bannerHost("KINGSOOPERS")).toBe("www.kingsoopers.com");
    expect(bannerHost("FREDMEYER")).toBe("www.fredmeyer.com");
    expect(bannerHost("KROGER")).toBe("www.kroger.com");
    expect(bannerHost("RALPHS")).toBe("www.ralphs.com");
  });

  it("is case-insensitive", () => {
    expect(bannerHost("kingsoopers")).toBe("www.kingsoopers.com");
    expect(bannerHost("KingSoopers")).toBe("www.kingsoopers.com");
  });

  it("falls back to kroger.com for unknown or missing chains", () => {
    expect(bannerHost("SOMENEWBANNER")).toBe("www.kroger.com");
    expect(bannerHost(undefined)).toBe("www.kroger.com");
    expect(bannerHost(null)).toBe("www.kroger.com");
    expect(bannerHost("")).toBe("www.kroger.com");
  });

  it("cartUrl builds the /cart link for the banner", () => {
    expect(cartUrl("KINGSOOPERS")).toBe("https://www.kingsoopers.com/cart");
    expect(cartUrl(undefined)).toBe("https://www.kroger.com/cart");
  });
});

describe("reorderForRelevance", () => {
  const fresh = (n: string) => ({ description: n, categories: ["Produce", "Fresh Vegetables"] });
  const frozen = (n: string) => ({ description: n, categories: ["Frozen", "Frozen Meals"] });
  const snack = (n: string) => ({ description: n, categories: ["Snacks", "Cookies & Crackers"] });
  const branded = (n: string, brand: string) => ({ description: n, brand, categories: ["Pantry"] });

  it("pushes fresh produce ahead of a frozen meal for a bare produce query", () => {
    const out = reorderForRelevance("zucchini", [frozen("Smart Ones Zucchini Bake"), fresh("Zucchini Squash")]);
    expect(out[0]?.description).toBe("Zucchini Squash");
    expect(out[1]?.description).toBe("Smart Ones Zucchini Bake");
  });

  it("pushes fresh produce ahead of a snack cup for 'banana'", () => {
    const out = reorderForRelevance("banana", [snack("Peach Fruit Cups"), fresh("Bananas")]);
    expect(out[0]?.description).toBe("Bananas");
  });

  it("is a stable sort within a bucket — Kroger's order is preserved", () => {
    const out = reorderForRelevance("apple", [fresh("Gala Apples"), fresh("Honeycrisp Apples"), frozen("Apple Pie")]);
    expect(out.map((p) => p.description)).toEqual(["Gala Apples", "Honeycrisp Apples", "Apple Pie"]);
  });

  it("leaves the order alone when the query has a processing word", () => {
    const input = [frozen("Frozen Mango Chunks"), fresh("Fresh Mango")];
    expect(reorderForRelevance("frozen mango", input)).toBe(input);
  });

  it("leaves the order alone when the query names a brand present in the results", () => {
    const input = [branded("Smart Ones Mac & Cheese", "Smart Ones"), fresh("Macaroni")];
    expect(reorderForRelevance("smart ones mac and cheese", input)).toBe(input);
  });

  it("leaves the order alone when there's no fresh-vs-processed split to act on", () => {
    const input = [branded("Barilla Penne", "Barilla"), branded("Ronzoni Penne", "Ronzoni")];
    expect(reorderForRelevance("penne", input)).toBe(input);
  });

  it("no-ops on lists of 0 or 1", () => {
    expect(reorderForRelevance("x", [])).toEqual([]);
    const one = [fresh("Bananas")];
    expect(reorderForRelevance("banana", one)).toBe(one);
  });
});
