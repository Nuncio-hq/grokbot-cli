import type { ReplyCard } from "./reply-cards.js";
import type { Reply } from "./transcript.js";

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** `3 places`, `2 products`, or `3 places, 2 products`: how many entries the cards list. */
function describeCards(cards: readonly ReplyCard[]): string {
  let places = 0;
  let products = 0;
  for (const card of cards) {
    if (card.kind === "places") places += card.places.length;
    else products += card.products.length;
  }
  return [
    ...(places > 0 ? [count(places, "place", "places")] : []),
    ...(products > 0 ? [count(products, "product", "products")] : []),
  ].join(", ");
}

/**
 * One reply on one line, for `grokbot tail` and the MCP summaries: the text, then a tag
 * (`<file> [attachment]`, `<title> [visual]`, `<text> [3 places]`). Never a link: an
 * attachment's may be signed, and map and product links stay in `--json`.
 */
export function describeReply(reply: Reply): string {
  switch (reply.type) {
    case "text":
      return reply.cards
        ? `${reply.content} [${describeCards(reply.cards)}]`.trim()
        : reply.content;
    case "attachment":
      return `${reply.fileName} [attachment]`.trim();
    case "visualization":
      return `${reply.title} [visual]`.trim();
  }
}
