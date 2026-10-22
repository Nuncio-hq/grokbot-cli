import type { ReplyCard, ShipmentStage } from "./reply-cards.js";
import type { Reply } from "./transcript.js";

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** A card's words come from the bot: keep each on one line, as the summary is one. */
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

const STAGE_WORDS: Record<ShipmentStage, string> = {
  placed: "placed",
  in_transit: "in transit",
  arriving_today: "arriving today",
  delivered: "delivered",
  delayed: "delayed",
  cancelled: "cancelled",
};

/** `3 places`, `2 products`, or `3 places, 2 products`: how many entries the cards list. */
function countEntries(cards: readonly ReplyCard[]): string {
  let places = 0;
  let products = 0;
  for (const card of cards) {
    if (card.kind === "places") places += card.places.length;
    else if (card.kind === "shopping") products += card.products.length;
  }
  return [
    ...(places > 0 ? [count(places, "place", "places")] : []),
    ...(products > 0 ? [count(products, "product", "products")] : []),
  ].join(", ");
}

/**
 * What a weather, shipment or purchase card says, in a few words: `weather: Berlin, 18 °C`,
 * `shipment: Acme order 123, in transit`, `purchase: placed, order 123` or
 * `purchase: failed: card declined`. Undefined for the cards `countEntries` counts.
 */
function describeReplyCard(card: ReplyCard): string | undefined {
  switch (card.kind) {
    case "weather": {
      const place = `weather: ${oneLine(card.locationLabel)}`;
      const { temperatureC } = card;
      if (temperatureC === undefined) return place;
      // temperatureC is always Celsius; the card's own scale is the one the owner sees.
      return card.temperatureScale === "fahrenheit"
        ? `${place}, ${Math.round((temperatureC * 9) / 5 + 32)} °F`
        : `${place}, ${Math.round(temperatureC)} °C`;
    }
    case "shipment":
      return `shipment: ${oneLine(card.merchant)} order ${oneLine(card.orderNumber)}, ${STAGE_WORDS[card.stage]}`;
    case "purchase": {
      if (card.outcome === "placed") {
        return card.orderNumber === undefined
          ? "purchase: placed"
          : `purchase: placed, order ${oneLine(card.orderNumber)}`;
      }
      return card.reason === undefined
        ? "purchase: failed"
        : `purchase: failed: ${oneLine(card.reason)}`;
    }
    default:
      return undefined;
  }
}

/** The bracketed tags after a text: the entry count, then one for each weather, shipment or purchase card. */
function describeCards(cards: readonly ReplyCard[]): string[] {
  const entries = countEntries(cards);
  return [
    ...(entries === "" ? [] : [entries]),
    ...cards.flatMap((card) => describeReplyCard(card) ?? []),
  ];
}

/**
 * One reply on one line, for `grokbot tail` and the MCP summaries: the text, then a tag
 * for its cards (`<file> [attachment]`, `<title> [visual]`, `<text> [3 places]`,
 * `<text> [weather: Berlin, 18 °C]`). Never a link: an attachment's may be signed, and
 * map, product, tracking and attribution links stay in `--json`.
 */
export function describeReply(reply: Reply): string {
  switch (reply.type) {
    case "text": {
      const tags = reply.cards ? describeCards(reply.cards) : [];
      return tags.length === 0
        ? reply.content
        : [reply.content, ...tags.map((tag) => `[${tag}]`)].join(" ").trim();
    }
    case "attachment":
      return `${reply.fileName} [attachment]`.trim();
    case "visualization":
      return `${reply.title} [visual]`.trim();
  }
}
