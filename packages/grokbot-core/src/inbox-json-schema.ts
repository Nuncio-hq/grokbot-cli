import {
  INBOX_ID_LENGTH,
  INBOX_JOB_MAX_LENGTH,
  INBOX_JOB_PATTERN,
  INBOX_KINDS,
  INBOX_LIMITS,
  INBOX_NEEDS,
  INBOX_NEXT_BY,
  INBOX_OUTCOMES,
  INBOX_PLACE_FIELDS,
  INBOX_PLACES,
  INBOX_SCHEMA_ID,
  INBOX_SEVERITIES,
  INBOX_STATUSES,
  INBOX_WORK_STATES,
  type InboxPlaceAt,
} from "./inbox-types.js";
import {
  SESSION_ADDRESS_MAX_LENGTH,
  SESSION_ADDRESS_PATTERN,
} from "./session-address.js";

type Schema = { readonly [key: string]: unknown };

const ISO_UTC = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$";
const ONE_LINE = "^[^\\r\\n]*$";
const AGENT_ID =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const line = (max: number, description?: string): Schema => ({
  type: "string",
  minLength: 1,
  maxLength: max,
  pattern: ONE_LINE,
  ...(description && { description }),
});
const block = (max: number, description?: string): Schema => ({
  type: "string",
  minLength: 1,
  maxLength: max,
  ...(description && { description }),
});
const lines = (items: number, each: number): Schema => ({
  type: "array",
  maxItems: items,
  items: block(each),
});
const iso = (description: string): Schema => ({
  type: "string",
  pattern: ISO_UTC,
  description,
});
const enumOf = (values: readonly string[], description?: string): Schema => ({
  type: "string",
  enum: values,
  ...(description && { description }),
});
const https = (description?: string): Schema => ({
  type: "string",
  maxLength: INBOX_LIMITS.url,
  pattern: "^https://[^\\s]+$",
  ...(description && { description }),
});

const PLACE_PROPERTIES: Schema = {
  at: enumOf(INBOX_PLACES, "Where it happens."),
  machine: {
    type: "object",
    description: "owner-computer only.",
    properties: {
      id: line(INBOX_LIMITS.machineField),
      label: line(INBOX_LIMITS.machineField),
    },
    required: ["id", "label"],
    additionalProperties: false,
  },
  agentId: { type: "string", pattern: AGENT_ID, description: "bot only." },
  cloudAgentId: {
    type: "string",
    pattern: "^bc-[A-Za-z0-9_-]{1,96}$",
    description: "cloud-agent only.",
  },
  path: {
    type: "string",
    minLength: 1,
    maxLength: INBOX_LIMITS.path,
    pattern: ONE_LINE,
    description:
      "owner-computer: absolute path; cloud-computer: absolute path under /workspace or /home.",
  },
  url: https("https URL; repo, web and cloud-agent."),
  branch: line(INBOX_LIMITS.branch),
  commit: { type: "string", pattern: "^[0-9a-fA-F]{7,64}$" },
  pr: https("https URL of a pull request."),
};

/** "If `condition` holds, `consequence` must too", as `not condition or consequence`. */
const implies = (condition: Schema, consequence: Schema): Schema => ({
  anyOf: [{ not: condition }, consequence],
});

/** Each kind of place refuses the fields it does not take. */
const placeRules = (): Schema[] =>
  INBOX_PLACES.map((at: InboxPlaceAt) =>
    implies(
      { properties: { at: { const: at } }, required: ["at"] },
      {
        properties: Object.fromEntries(
          Object.keys(PLACE_PROPERTIES)
            .filter(
              (key) =>
                key !== "at" &&
                !(INBOX_PLACE_FIELDS[at] as readonly string[]).includes(key),
            )
            .map((key) => [key, false]),
        ),
      },
    ),
  );

const place = (extra: Schema, required: readonly string[]): Schema => ({
  type: "object",
  properties: { ...PLACE_PROPERTIES, ...extra },
  required,
  additionalProperties: false,
  allOf: placeRules(),
});

const stamped = (schema: Schema): Schema => ({
  ...schema,
  readOnly: true,
});

/**
 * JSON Schema (2020-12) of one item file. A poster writes the draft: every property
 * not marked `readOnly`; grokbot stamps the others (and `severity` defaults to normal).
 * `inbox-post --file` adds `files`.
 */
export const INBOX_ITEM_JSON_SCHEMA: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "GrokBot inbox item",
  description:
    "One file of <slug>/open/ or <slug>/closed/. A draft holds the properties that are not readOnly.",
  type: "object",
  properties: {
    schema: stamped({ const: INBOX_SCHEMA_ID }),
    id: stamped({
      type: "string",
      pattern: `^[a-z0-9]{${INBOX_ID_LENGTH}}$`,
    }),
    project: line(INBOX_LIMITS.project, "Free text naming the project."),
    kind: enumOf(INBOX_KINDS),
    severity: {
      ...enumOf(INBOX_SEVERITIES),
      default: "normal",
    },
    title: line(INBOX_LIMITS.title, "One line."),
    startHere: block(
      INBOX_LIMITS.text,
      "The one command or URL to open first.",
    ),
    ask: {
      type: "object",
      properties: {
        doneWhen: block(
          INBOX_LIMITS.text,
          "What makes it done. Required for a bug and a task.",
        ),
        verify: block(INBOX_LIMITS.text),
        reply: block(INBOX_LIMITS.text),
        choices: {
          type: "array",
          minItems: INBOX_LIMITS.choicesMin,
          maxItems: INBOX_LIMITS.choicesMax,
          items: line(INBOX_LIMITS.choice),
          description: "Question only.",
        },
        blocking: block(INBOX_LIMITS.text),
      },
      additionalProperties: false,
    },
    details: {
      type: "object",
      properties: {
        summary: block(INBOX_LIMITS.summary),
        observed: block(INBOX_LIMITS.observed),
        expected: block(INBOX_LIMITS.expected),
        repro: lines(INBOX_LIMITS.listItems, INBOX_LIMITS.listItem),
        alreadyChecked: lines(INBOX_LIMITS.listItems, INBOX_LIMITS.listItem),
        firstSeenAt: iso("Bug only."),
        occurrences: {
          type: "integer",
          minimum: 1,
          description: "Bug only.",
        },
      },
      additionalProperties: false,
    },
    work: {
      type: "object",
      properties: {
        state: enumOf(INBOX_WORK_STATES),
        trail: {
          type: "array",
          maxItems: INBOX_LIMITS.trail,
          items: place(
            {
              did: line(INBOX_LIMITS.text, "What was done there."),
              asOf: iso("When."),
            },
            ["at", "did"],
          ),
        },
        latest: place({}, ["at"]),
        next: place(
          {
            by: enumOf(INBOX_NEXT_BY),
            action: block(INBOX_LIMITS.text),
            command: line(INBOX_LIMITS.command),
            needs: {
              type: "array",
              uniqueItems: true,
              items: enumOf(INBOX_NEEDS),
            },
          },
          ["at", "by"],
        ),
      },
      additionalProperties: false,
    },
    refs: {
      type: "array",
      maxItems: INBOX_LIMITS.refs,
      items: {
        type: "object",
        properties: {
          label: line(INBOX_LIMITS.refLabel),
          url: https(),
        },
        required: ["label", "url"],
        additionalProperties: false,
      },
    },
    files: stamped({
      type: "array",
      maxItems: INBOX_LIMITS.files,
      description: "Added by inbox-post --file.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          path: { type: "string", pattern: "^files/[a-z0-9]+/[^/]+$" },
          sizeBytes: { type: "integer", minimum: 0 },
          contentType: { type: "string", minLength: 1 },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
        required: ["name", "path", "sizeBytes", "contentType", "sha256"],
        additionalProperties: false,
      },
    }),
    replyTo: {
      type: "object",
      description: "Only when the answer should go to another bot.",
      properties: { agentId: { type: "string", pattern: AGENT_ID } },
      required: ["agentId"],
      additionalProperties: false,
    },
    to: {
      type: "object",
      description:
        "Only when one assistant session, or one job it sent, should pick it up. Set session, job, or both; copy each exactly from a message header.",
      properties: {
        session: {
          type: "string",
          maxLength: SESSION_ADDRESS_MAX_LENGTH,
          pattern: SESSION_ADDRESS_PATTERN,
          description: "<runtime>:<id>, for example omp:<id>.",
        },
        job: {
          type: "string",
          maxLength: INBOX_JOB_MAX_LENGTH,
          pattern: INBOX_JOB_PATTERN,
          description:
            "Only when the item answers one job a session sent: the Job copied exactly from a message header.",
        },
      },
      anyOf: [{ required: ["session"] }, { required: ["job"] }],
      additionalProperties: false,
    },
    relatesTo: {
      type: "array",
      maxItems: INBOX_LIMITS.relatesTo,
      items: { type: "string", pattern: `^[a-z0-9]{${INBOX_ID_LENGTH}}$` },
    },
    dedupeKey: {
      type: "string",
      minLength: 1,
      maxLength: INBOX_LIMITS.dedupeKey,
      pattern: "^[a-z0-9._-]+$",
      description:
        "Posting again with the same key in the same project updates the open item.",
    },
    from: stamped({
      type: "object",
      properties: {
        agentId: { type: "string", minLength: 1 },
        run: { type: "string", minLength: 1 },
        cwd: { type: "string", minLength: 1 },
        git: {
          type: "object",
          properties: {
            url: https(),
            branch: { type: "string", minLength: 1 },
            commit: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      required: ["agentId", "run", "cwd"],
      additionalProperties: false,
    }),
    createdAt: stamped(iso("When it was posted.")),
    updatedAt: stamped(iso("When it last changed.")),
    expiresAt: stamped(iso("When an open item is closed as expired.")),
    updates: stamped({
      type: "array",
      maxItems: INBOX_LIMITS.updates,
      items: {
        type: "object",
        properties: {
          at: iso("When."),
          run: { type: "string", minLength: 1 },
          note: block(INBOX_LIMITS.text),
        },
        required: ["at", "note"],
        additionalProperties: false,
      },
    }),
    status: stamped(enumOf(INBOX_STATUSES)),
    closed: stamped({
      type: "object",
      properties: {
        at: iso("When."),
        by: { type: "string", minLength: 1 },
        outcome: enumOf(INBOX_OUTCOMES),
        reason: block(INBOX_LIMITS.text),
        ref: https(),
      },
      required: ["at", "by", "outcome"],
      additionalProperties: false,
    }),
  },
  required: [
    "schema",
    "id",
    "project",
    "kind",
    "severity",
    "title",
    "from",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "status",
  ],
  additionalProperties: false,
  allOf: [
    implies(
      {
        properties: { kind: { enum: ["bug", "task"] } },
        required: ["kind"],
      },
      {
        required: ["ask"],
        properties: { ask: { required: ["doneWhen"] } },
      },
    ),
    implies(
      {
        not: {
          properties: { kind: { const: "question" } },
          required: ["kind"],
        },
      },
      { properties: { ask: { properties: { choices: false } } } },
    ),
    implies(
      { not: { properties: { kind: { const: "bug" } }, required: ["kind"] } },
      {
        properties: {
          details: { properties: { firstSeenAt: false, occurrences: false } },
        },
      },
    ),
    implies(
      { properties: { status: { const: "closed" } }, required: ["status"] },
      { required: ["closed"] },
    ),
    implies(
      {
        not: {
          properties: { status: { const: "closed" } },
          required: ["status"],
        },
      },
      { properties: { closed: false } },
    ),
  ],
};
