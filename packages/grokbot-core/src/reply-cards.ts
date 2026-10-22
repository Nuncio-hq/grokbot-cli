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

/** Where a `shipment` card says the order is. */
const SHIPMENT_STAGES = [
  "placed",
  "in_transit",
  "arriving_today",
  "delivered",
  "delayed",
  "cancelled",
] as const;
export type ShipmentStage = (typeof SHIPMENT_STAGES)[number];

/** The subset of a `weather` card grokbot keeps. `attributionUrl` is a public link. */
export interface WeatherSummary {
  /** What the bot called the place, e.g. "Berlin". */
  readonly locationLabel: string;
  /** The scale the card shows; `temperatureC` itself is always Celsius. */
  readonly temperatureScale?: "celsius" | "fahrenheit";
  readonly conditionCode?: string;
  /** The current temperature in Celsius. */
  readonly temperatureC?: number;
  readonly attributionUrl?: string;
}

/** One line item of a `shipment` card. */
export interface ShipmentItem {
  readonly title: string;
  readonly quantity?: number;
}

/** A `shipment` card: a placed order and where it is. `tracking.url` is a public link. */
export interface ShipmentSummary {
  readonly merchant: string;
  readonly orderNumber: string;
  readonly stage: ShipmentStage;
  readonly status?: string;
  /** `YYYY-MM-DD`. */
  readonly expectedDeliveryDate?: string;
  readonly items?: readonly ShipmentItem[];
  readonly tracking?: { readonly url: string; readonly carrier?: string };
}

/** A `purchase` card: whether the bot's checkout went through. */
export interface PurchaseSummary {
  readonly orderId: string;
  readonly outcome: "placed" | "failed";
  readonly orderNumber?: string;
  readonly reason?: string;
}

/**
 * One card a bot attached to a text reply (`message.cards`: places and shopping since
 * 0.72.0, weather, shipment and purchase since 0.75.0).
 */
export type ReplyCard =
  | { readonly kind: "places"; readonly places: readonly PlaceSummary[] }
  | { readonly kind: "shopping"; readonly products: readonly ProductSummary[] }
  | ({ readonly kind: "weather" } & WeatherSummary)
  | ({ readonly kind: "shipment" } & ShipmentSummary)
  | ({ readonly kind: "purchase" } & PurchaseSummary);

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

/** A real calendar day written `YYYY-MM-DD`. */
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value);
}

function parseWeather(card: JsonObject): ReplyCard | undefined {
  const weather = record(card.weather);
  const locationLabel = weather && text(weather, "locationLabel");
  if (!weather || locationLabel === undefined) return undefined;
  const scale = weather.temperatureScale;
  const temperatureScale =
    scale === "celsius" || scale === "fahrenheit" ? scale : undefined;
  const current = record(weather.current);
  const conditionCode = current && text(current, "conditionCode");
  const celsius = current?.temperatureC;
  const temperatureC =
    typeof celsius === "number" && Number.isFinite(celsius)
      ? celsius
      : undefined;
  const attributionUrl = link(weather, "attributionUrl");
  return {
    kind: "weather",
    locationLabel,
    ...(temperatureScale !== undefined && { temperatureScale }),
    ...(conditionCode !== undefined && { conditionCode }),
    ...(temperatureC !== undefined && { temperatureC }),
    ...(attributionUrl !== undefined && { attributionUrl }),
  };
}

function parseShipmentItem(raw: unknown): ShipmentItem | undefined {
  const item = record(raw);
  const title = item && text(item, "title");
  if (!item || title === undefined) return undefined;
  const { quantity } = item;
  const count =
    typeof quantity === "number" && Number.isInteger(quantity) && quantity >= 1
      ? quantity
      : undefined;
  return { title, ...(count !== undefined && { quantity: count }) };
}

function parseShipment(card: JsonObject): ReplyCard | undefined {
  const merchant = record(card.merchant);
  const merchantName = merchant && text(merchant, "name");
  const orderNumber = text(card, "orderNumber");
  const stage = SHIPMENT_STAGES.find((s) => s === card.stage);
  if (
    typeof card.v !== "number" ||
    card.v < 1 ||
    merchantName === undefined ||
    orderNumber === undefined ||
    stage === undefined
  )
    return undefined;
  const status = text(card, "status");
  const day = text(card, "expectedDeliveryDate");
  const expectedDeliveryDate =
    day !== undefined && isCalendarDay(day) ? day : undefined;
  const items = Array.isArray(card.items)
    ? card.items.flatMap((i) => parseShipmentItem(i) ?? [])
    : [];
  const tracking = record(card.tracking);
  const trackingUrl = tracking && link(tracking, "url");
  const carrier = tracking && text(tracking, "carrier");
  return {
    kind: "shipment",
    merchant: merchantName,
    orderNumber,
    stage,
    ...(status !== undefined && { status }),
    ...(expectedDeliveryDate !== undefined && { expectedDeliveryDate }),
    ...(items.length > 0 && { items }),
    ...(trackingUrl !== undefined && {
      tracking: {
        url: trackingUrl,
        ...(carrier !== undefined && { carrier }),
      },
    }),
  };
}

function parsePurchase(card: JsonObject): ReplyCard | undefined {
  const orderId = text(card, "orderId");
  const { outcome } = card;
  if (
    typeof card.v !== "number" ||
    card.v < 1 ||
    orderId === undefined ||
    (outcome !== "placed" && outcome !== "failed")
  )
    return undefined;
  const orderNumber = text(card, "orderNumber");
  const reason = text(card, "reason");
  return {
    kind: "purchase",
    orderId,
    outcome,
    ...(orderNumber !== undefined && { orderNumber }),
    ...(reason !== undefined && { reason }),
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
  if (card.kind === "weather") return parseWeather(card);
  if (card.kind === "shipment") return parseShipment(card);
  if (card.kind === "purchase") return parsePurchase(card);
  return undefined;
}

/**
 * Reads a text reply's `message.cards` (`{items: [{card}], start}`). Tolerant: a card of
 * an unknown kind or version, a place or product without a name, a weather card without
 * a location, a shipment or purchase without its order, and any field of the wrong type
 * are skipped, never an error. Undefined when no card survives.
 */
export function parseReplyCards(
  raw: unknown,
): readonly ReplyCard[] | undefined {
  const items = record(raw)?.items;
  if (!Array.isArray(items)) return undefined;
  const cards = items.flatMap((item) => parseCard(item) ?? []);
  return cards.length === 0 ? undefined : cards;
}
