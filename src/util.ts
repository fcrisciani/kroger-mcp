import type { Cadence, UsualItem } from "./types.js";

export const cadenceDays: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

const MS_PER_DAY = 86_400_000;

// Grace window so a "weekly" order on day 6 still counts as due — humans don't
// hit a precise 7-day cadence, and skipping a week because we're 12 hours short
// is annoying.
const GRACE_DAYS = 1;

export function isDue(item: UsualItem, now = Date.now()): boolean {
  if (!item.lastOrdered) return true;
  const last = Date.parse(item.lastOrdered);
  if (Number.isNaN(last)) return true;
  const dueAt = last + (cadenceDays[item.cadence] - GRACE_DAYS) * MS_PER_DAY;
  return now >= dueAt;
}

export interface PriceableProduct {
  regularPrice?: number;
  promoPrice?: number;
  onSale: boolean;
}

export function priceLine(p: PriceableProduct): string {
  // Use typeof checks so a legitimate $0.00 (free / loyalty-credit item) is
  // rendered as a price rather than "price unavailable".
  if (
    p.onSale &&
    typeof p.promoPrice === "number" &&
    typeof p.regularPrice === "number"
  ) {
    return `$${p.promoPrice.toFixed(2)} (sale, was $${p.regularPrice.toFixed(2)})`;
  }
  if (typeof p.regularPrice === "number") return `$${p.regularPrice.toFixed(2)}`;
  return "price unavailable at this location";
}

// Kroger runs many banner stores, each with its own e-commerce site. Items
// added against a banner's locationId land in that banner's cart, not
// kroger.com — so the checkout link has to follow the store. This maps the
// `chain` value from the Locations API to the banner's domain. Anything not
// listed (or a missing chain) falls back to kroger.com.
const BANNER_HOSTS: Record<string, string> = {
  KROGER: "www.kroger.com",
  KINGSOOPERS: "www.kingsoopers.com",
  FREDMEYER: "www.fredmeyer.com",
  RALPHS: "www.ralphs.com",
  FRYS: "www.frysfood.com",
  QFC: "www.qfc.com",
  SMITHS: "www.smithsfoodanddrug.com",
  DILLONS: "www.dillons.com",
  BAKERS: "www.bakersplus.com",
  CITYMARKET: "www.citymarket.com",
  GERBES: "www.gerbes.com",
  PAYLESS: "www.pay-less.com",
  OWENS: "www.owensmarket.com",
  JAYC: "www.jaycfoods.com",
  HARRISTEETER: "www.harristeeter.com",
  MARIANOS: "www.marianos.com",
  METROMARKET: "www.metromarket.net",
  PICKNSAVE: "www.picknsave.com",
  COPPS: "www.copps.com",
  FOODSCO: "www.foodsco.net",
  FOOD4LESS: "www.food4less.com",
};

export function bannerHost(chain?: string | null): string {
  if (!chain) return "www.kroger.com";
  return BANNER_HOSTS[chain.toUpperCase()] ?? "www.kroger.com";
}

export function cartUrl(chain?: string | null): string {
  return `https://${bannerHost(chain)}/cart`;
}

// Words that signal the query is *not* asking for plain fresh produce — if any
// of these appear, we leave Kroger's ordering alone.
const PROCESSED_HINTS = /\b(frozen|canned|dried|dehydrated|instant|jarred|bottled|powder|powdered|mix|snack|chips?|bar|bars|juice|sauce|paste|puree|cup|cups|meal|meals|pie|cake|cookie|cereal|flavou?red)\b/i;
const FRESH_CATEGORY = /\bproduce\b|fresh\s+(fruit|veget)/i;
const PROCESSED_CATEGORY = /\bfrozen\b|\bsnack|\bcandy\b|\bcereal\b|\bbakery\b|\bdeli\b|canned|jarred/i;

interface RankableProduct {
  brand?: string;
  categories?: string[];
}

// Kroger's `filter.term` relevance is rough — "banana" can surface peach cups,
// "zucchini" a frozen Smart Ones meal. When the query has no brand or
// processing signal (i.e. it reads like "I want the fresh thing"), nudge
// fresh-produce candidates to the front and demote obviously off-category
// (frozen/snack/etc.) ones. This is a stable sort, so within each bucket
// Kroger's original order is preserved. It only reorders — it never drops
// anything.
export function reorderForRelevance<T extends RankableProduct>(query: string, products: T[]): T[] {
  if (products.length < 2) return products;
  // If the query mentions a brand we recognize in the results, or a processing
  // word, the user isn't asking for "the fresh one" — don't second-guess.
  const q = query.toLowerCase();
  if (PROCESSED_HINTS.test(q)) return products;
  const mentionsAKnownBrand = products.some(
    (p) => p.brand && q.includes(p.brand.toLowerCase()),
  );
  if (mentionsAKnownBrand) return products;
  // Only bother if there's actually a fresh-vs-processed split to act on.
  const cats = (p: T) => (p.categories ?? []).join(" ");
  const hasFresh = products.some((p) => FRESH_CATEGORY.test(cats(p)));
  if (!hasFresh) return products;
  const rank = (p: T): number => {
    const c = cats(p);
    if (FRESH_CATEGORY.test(c)) return 0;
    if (PROCESSED_CATEGORY.test(c)) return 2;
    return 1;
  };
  return products
    .map((p, i) => ({ p, i, r: rank(p) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p);
}

