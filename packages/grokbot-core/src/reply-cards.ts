import type { JsonObject } from "./contracts.js";

/** A place of a `places` card: the subset grokbot keeps. `mapsUrl` is a public link. */
export interface PlaceSummary {
  readonly name: string;
  readonly address?: string;
  /** 0 to 5. */
  readonly rating?: number;
  readonly mapsUrl?: string;
}

/**
 * A product of a `shopping` card, read from its selected (else first) variant's first
 * offer. `merchant` is the offer's seller and `url` its public product link.
 */
export interface ProductSummary {
  readonly name: string;
  readonly price?: { readonly amount: number; readonly currency: string };
  readonly merchant?: string;
  readonly url?: string;
}

/** One card a bot attached to a text reply (0.72.0 `message.cards`). */
export type ReplyCard =
  | { readonly kind: "places"; readonly places: readonly PlaceSummary[] }
  | { readonly kind: "shopping"; readonly products: readonly ProductSummary[] };

// These helpers stay local: transcript.ts imports this file, so importing its helpers
// back would make a cycle.
const record = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const text = (o: JsonObject, key: string): string | undefined => {
  const value = o[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** The app only sends https links, so any other scheme is dropped, not kept. */
const link = (o: JsonObject, key: string): string | undefined => {
  const value = text(o, key);
  return value !== undefined &&
    /^https:\/\//i.test(value) &&
    URL.canParse(value)
    ? value
    : undefined;
};

const rating = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 5
    ? value
    : undefined;

function price(value: unknown): ProductSummary["price"] {
  const money = record(value);
  if (!money) return undefined;
  const { amount, currency } = money;
  return typeof amount === "number" &&
    Number.isFinite(amount) &&
    amount >= 0 &&
    typeof currency === "string" &&
    /^[A-Z]{3}$/.test(currency)
    ? { amount, currency }
    : undefined;
}

function parsePlace(raw: unknown): PlaceSummary | undefined {
  const place = record(raw);
  const name = place && text(place, "name");
  if (!place || name === undefined) return undefined;
  const address = text(place, "address");
  const stars = rating(place.rating);
  const mapsUrl = link(place, "mapsUrl");
  return {
    name,
    ...(address !== undefined && { address }),
    ...(stars !== undefined && { rating: stars }),
    ...(mapsUrl !== undefined && { mapsUrl }),
  };
}

function parseProduct(raw: unknown): ProductSummary | undefined {
  const product = record(raw);
  const name = product && (text(product, "title") ?? text(product, "name"));
  if (!product || name === undefined) return undefined;
  const variants = Array.isArray(product.variants)
    ? product.variants.map(record)
    : [];
  const variant = variants.find((v) => v?.selected === true) ?? variants[0];
  const offer = record(
    Array.isArray(variant?.offers) ? variant.offers[0] : undefined,
  );
  const cost = offer && price(offer.price);
  const merchant = offer && text(offer, "seller");
  const url = offer && link(offer, "url");
  return {
    name,
    ...(cost !== undefined && { price: cost }),
    ...(merchant !== undefined && { merchant }),
    ...(url !== undefined && { url }),
  };
}

function parseCard(raw: unknown): ReplyCard | undefined {
  const card = record(record(raw)?.card);
  if (!card) return undefined;
  if (card.kind === "places" && Array.isArray(card.places)) {
    const places = card.places.flatMap((p) => parsePlace(p) ?? []);
    return places.length > 0 ? { kind: "places", places } : undefined;
  }
  if (
    card.kind === "shopping" &&
    typeof card.v === "number" &&
    card.v >= 2 &&
    Array.isArray(card.products)
  ) {
    const products = card.products.flatMap((p) => parseProduct(p) ?? []);
    return products.length > 0 ? { kind: "shopping", products } : undefined;
  }
  return undefined;
}

/**
 * Reads a text reply's `message.cards` (`{items: [{card}], start}`). Tolerant: a card of
 * an unknown kind or version, a place or product without a name, and any field of the
 * wrong type are skipped, never an error. Undefined when no card survives.
 */
export function parseReplyCards(
  raw: unknown,
): readonly ReplyCard[] | undefined {
  const items = record(raw)?.items;
  if (!Array.isArray(items)) return undefined;
  const cards = items.flatMap((item) => parseCard(item) ?? []);
  return cards.length === 0 ? undefined : cards;
}
