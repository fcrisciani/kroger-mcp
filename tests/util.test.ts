import { describe, expect, it } from "vitest";
import { cadenceDays, isDue, priceLine } from "../src/util.js";
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
});
