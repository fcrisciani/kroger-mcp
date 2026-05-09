import type { Cadence, UsualItem } from "./types.js";

export const cadenceDays: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

// Grace window so a "weekly" order on day 6 still counts as due — humans don't
// hit a precise 7-day cadence, and skipping a week because we're 12 hours short
// is annoying.
const GRACE_DAYS = 1;

export function isDue(item: UsualItem, now = Date.now()): boolean {
  if (!item.lastOrdered) return true;
  const last = Date.parse(item.lastOrdered);
  if (Number.isNaN(last)) return true;
  const dueAt = last + (cadenceDays[item.cadence] - GRACE_DAYS) * 86_400_000;
  return now >= dueAt;
}

export interface PriceableProduct {
  regularPrice?: number;
  promoPrice?: number;
  onSale: boolean;
}

export function priceLine(p: PriceableProduct): string {
  if (p.onSale && p.promoPrice && p.regularPrice) {
    return `$${p.promoPrice.toFixed(2)} (sale, was $${p.regularPrice.toFixed(2)})`;
  }
  if (p.regularPrice) return `$${p.regularPrice.toFixed(2)}`;
  return "price unavailable at this location";
}
