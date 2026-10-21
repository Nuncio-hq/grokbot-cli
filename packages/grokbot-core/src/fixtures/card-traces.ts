import {
  sendMessageRow,
  textReplyRow,
  userRow,
  type WireEntry,
  withEntryId,
} from "./wire-entries.js";

export const BLUE_MESSAGE_ID = "8980adbc-0000-4000-8000-000000000000";
export const GREEN_MESSAGE_ID = "58d5b4ce-0000-4000-8000-000000000000";
const WIDGET_PROMPT = "Which color do you pick?";
const COLOR_ASK =
  "Use your question widget to ask me to pick a color from Red, Blue, Green. Do not answer it yourself.";
export const COLOR_WIDGET = {
  type: "widget",
  widget: {
    prompt: WIDGET_PROMPT,
    options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
  },
};

const card = (
  seq: number,
  id: string,
  message: Record<string, unknown>,
  requestId: string,
  closed?: { readonly updatedSeq: number } & Record<string, unknown>,
) => {
  const { updatedSeq = seq, ...fields } = closed ?? {};
  return withEntryId(
    sendMessageRow(seq, message, requestId, updatedSeq, fields),
    id,
  );
};

/**
 * Redacted replay of the 15 Oct question-widget runs on Primary Test (#141 to #150).
 * The card keeps the echo's requestId; RespondGrokBotWidget adds `respondedValue` to it
 * (a newer version, updatedSeq 145) and the reply lands in a new run whose row id `t51s1`
 * continues the card's server turn `t51`. Seqs 143 and 148 never show in the transcript.
 */
export const WIDGET_TRACE = {
  blueEcho: withEntryId(
    userRow(141, COLOR_ASK, {
      clientNonce: BLUE_MESSAGE_ID,
      requestId: "0a80c5a7",
    }),
    "t51u",
  ),
  blueCard: card(142, "t51s0", COLOR_WIDGET, "0a80c5a7"),
  blueAnswered: card(142, "t51s0", COLOR_WIDGET, "0a80c5a7", {
    updatedSeq: 145,
    respondedValue: "Blue",
  }),
  blueReply: withEntryId(
    textReplyRow(144, "You picked Blue.", "286281d4"),
    "t51s1",
  ),
  greenEcho: withEntryId(
    userRow(146, COLOR_ASK, {
      clientNonce: GREEN_MESSAGE_ID,
      requestId: "f2dbbea1",
    }),
    "t52u",
  ),
  greenCard: card(147, "t52s0", COLOR_WIDGET, "f2dbbea1"),
  greenAnswered: card(147, "t52s0", COLOR_WIDGET, "f2dbbea1", {
    updatedSeq: 150,
    respondedValue: "Green",
  }),
  greenReply: withEntryId(
    textReplyRow(149, "You picked Green.", "5bef422d"),
    "t52s1",
  ),
} satisfies Record<string, WireEntry>;

export const SIZE_MESSAGE_ID = "f0f0f445-0000-4000-8000-000000000000";
const SIZE_WIDGET = {
  type: "widget",
  widget: {
    prompt: "Which size?",
    options: [{ label: "Small" }, { label: "Large" }],
  },
};

/**
 * 14 Oct #10 to #14 on Primary Test: DismissGrokBotWidget set `widgetDismissed` and
 * `widgetSkipped`. The live bot posted nothing after it; `reply` is synthesized.
 */
export const DISMISSED_TRACE = {
  echo: withEntryId(
    userRow(10, "Ask me with your question widget: Which size?", {
      clientNonce: SIZE_MESSAGE_ID,
      requestId: "148850c1",
    }),
    "t3u",
  ),
  card: card(11, "t3s0", SIZE_WIDGET, "148850c1"),
  dismissed: card(11, "t3s0", SIZE_WIDGET, "148850c1", {
    updatedSeq: 14,
    widgetDismissed: true,
    widgetSkipped: true,
  }),
  reply: withEntryId(
    textReplyRow(12, "OK, I'll pick Small for you.", "9d1f0c2a"),
    "t3s1",
  ),
} satisfies Record<string, WireEntry>;

export const SECRET_MESSAGE_ID = "0fbb36e1-0000-4000-8000-000000000000";
const SECRET_CARD = {
  type: "secret-request",
  secretRequest: {
    label: "Dummy test token",
    description: "Test value only; I'll just report its length.",
    target: { kind: "box-env", name: "TEST_DUMMY_TOKEN", platform: "box" },
  },
};

/** 14 Oct #13 to #18 on Primary Test: SubmitGrokBotSecret set `secretProvided`; the reply ran in a new run. */
export const SECRET_TRACE = {
  echo: withEntryId(
    userRow(
      13,
      "Use your secret request card to ask me for TEST_DUMMY_TOKEN.",
      {
        clientNonce: SECRET_MESSAGE_ID,
        requestId: "cbf59d10",
      },
    ),
    "t4u",
  ),
  card: card(15, "t4s0", SECRET_CARD, "cbf59d10"),
  provided: card(15, "t4s0", SECRET_CARD, "cbf59d10", {
    updatedSeq: 18,
    secretProvided: true,
  }),
  reply: withEntryId(
    textReplyRow(
      17,
      "Got it. `TEST_DUMMY_TOKEN` is set, and it's 11 characters long.",
      "a18999f1",
    ),
    "t4s1",
  ),
} satisfies Record<string, WireEntry>;
