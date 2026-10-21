import { describe, expect, it } from "vitest";
import {
  type AppSources,
  catalogGaps,
  diffSchemas,
  parseAppSchema,
} from "./app-schema.js";

interface Shape {
  readonly methods: readonly string[];
  /** Extra descriptor text for PingRequest's fields. */
  readonly requestFields?: string;
  readonly tools?: readonly string[];
  readonly gateway?: readonly string[];
  readonly gates?: readonly string[];
}

/** A minimal bundle set in the shape of the minified app: names differ per bundle. */
function sources(shape: Shape): AppSources {
  const methods = shape.methods
    .map(
      (name) => `${name.toLowerCase()}:{name:"${name}",I:Q,O:R,kind:i.Unary}`,
    )
    .join(",");
  const proto = [
    `var Q=class e extends B{static $(){return["PingRequest|${shape.requestFields ?? "1 id 9"}"]}},`,
    `R=class e extends B{static $(){return["PingResponse|1 echo #0|2 kind #1|3 self #2",Q,K,e]}},`,
    `K=a(s,y,"Kind",[[0,"UNSPECIFIED"],[1,"LOUD"]],1);`,
    `var S={typeName:"aiserver.v1.GrokBotService",methods:{${methods}}};`,
  ].join("");
  const gateway = (shape.gateway ?? ["listAgents"])
    .map((name) => `${name}:"background"`)
    .concat('callMcpAppTool:"person"')
    .join(",");
  const tools = [...(shape.tools ?? ["Read"]), "CreateTask"]
    .map((name) => `${name}:"${name}"`)
    .join(",");
  const gates = (shape.gates ?? ["gate_a:{client:!0,default:!1}"]).join(",");
  const other = `var X=class e extends B{static $(){return["OnlyHere|1 v 5"]}};`;
  return {
    proto,
    coordinator: `${other}var G={${gateway}};`,
    daemon: other,
    mainCore: `var T={${tools}};`,
    mainApp: `var Gates={${gates}};`,
  };
}

const base: Shape = { methods: ["Ping", "Gone"] };

describe("parseAppSchema", () => {
  const schema = parseAppSchema(sources(base));

  it("lists each service's methods with request and response names", () => {
    expect(schema.services.get("aiserver.v1.GrokBotService")).toStrictEqual(
      new Map([
        ["Ping", "PingRequest -> PingResponse (Unary)"],
        ["Gone", "PingRequest -> PingResponse (Unary)"],
      ]),
    );
  });

  it("resolves message, enum and self references to names", () => {
    expect(schema.messages.get("PingResponse")).toBe(
      "PingResponse|1 echo #PingRequest|2 kind #Kind|3 self #PingResponse",
    );
    expect(schema.unresolved).toBe(0);
  });

  it("merges messages from every bundle", () => {
    expect([...schema.messages.keys()].sort()).toStrictEqual([
      "OnlyHere",
      "PingRequest",
      "PingResponse",
    ]);
  });

  it("reads the bot tools, the gateway table and the client gates", () => {
    expect([...schema.tools.keys()].sort()).toStrictEqual([
      "CreateTask",
      "Read",
    ]);
    expect(schema.gateway.get("callMcpAppTool")).toBe("person");
    expect(schema.gates.get("gate_a")).toBe("client:true default:false");
  });

  it("fails loudly when a bundle no longer has the expected shape", () => {
    const good = sources(base);
    expect(() =>
      parseAppSchema({ ...good, mainCore: "var T={Read:'Read'};" }),
    ).toThrow("bot tool registry");
    expect(() =>
      parseAppSchema({ ...good, coordinator: "var nothing=1;" }),
    ).toThrow("no message descriptors");
    expect(() => parseAppSchema({ ...good, mainApp: "var x=1;" })).toThrow(
      "no client gates",
    );
  });
});

describe("diffSchemas", () => {
  const before = parseAppSchema(sources(base));
  const after = parseAppSchema(
    sources({
      methods: ["Ping", "Fresh"],
      requestFields: "1 id 9|2 note 9?",
      tools: ["Read", "Visualize"],
      gateway: ["listAgents", "createThread"],
      gates: ["gate_a:{client:!0,default:!0}", "gate_b:{client:!0,default:!1}"],
    }),
  );
  const diff = diffSchemas(before, after);

  it("reports added and removed methods with counts per service", () => {
    const [service] = diff.services;
    expect(service?.service).toBe("aiserver.v1.GrokBotService");
    expect([service?.before, service?.after]).toStrictEqual([2, 2]);
    expect(service?.added.map((entry) => entry.name)).toStrictEqual(["Fresh"]);
    expect(service?.removed.map((entry) => entry.name)).toStrictEqual(["Gone"]);
  });

  it("reports message fields added to an existing message", () => {
    expect(diff.messages.changed).toStrictEqual([
      { name: "PingRequest", fields: ["+2 note 9?"] },
    ]);
    expect(diff.messages.added).toStrictEqual([]);
  });

  it("reports tools, gateway methods and gates, including a flipped default", () => {
    expect(diff.tools.added.map((entry) => entry.name)).toStrictEqual([
      "Visualize",
    ]);
    expect(diff.gateway.added.map((entry) => entry.name)).toStrictEqual([
      "createThread",
    ]);
    expect(diff.gateway.removed).toStrictEqual([]);
    expect(diff.gates.added.map((entry) => entry.name)).toStrictEqual([
      "gate_b",
    ]);
    expect(diff.gates.changed).toStrictEqual([
      {
        name: "gate_a",
        before: "client:true default:false",
        after: "client:true default:true",
      },
    ]);
  });

  it("reports no change between identical apps", () => {
    const same = diffSchemas(before, before);
    expect(same.tools.added).toStrictEqual([]);
    expect(same.messages.changed).toStrictEqual([]);
    expect(
      same.services.every((s) => s.added.length + s.removed.length === 0),
    ).toBe(true);
  });

  it("reports a field removed or retyped", () => {
    const retyped = parseAppSchema(
      sources({ methods: ["Ping"], requestFields: "1 id 5" }),
    );
    expect(diffSchemas(before, retyped).messages.changed).toStrictEqual([
      { name: "PingRequest", fields: ["~1 id 5 (was id 9)"] },
    ]);
    const dropped = parseAppSchema(
      sources({ methods: ["Ping"], requestFields: "2 x 9" }),
    );
    expect(diffSchemas(before, dropped).messages.changed).toStrictEqual([
      { name: "PingRequest", fields: ["+2 x 9", "-1 id 9"] },
    ]);
  });
});

describe("catalogGaps", () => {
  const app = parseAppSchema(
    sources({ methods: ["Ping", "Fresh"], tools: ["Read", "Visualize"] }),
  );
  const entries = (...names: string[]) => names.map((name) => ({ name }));

  it("lists methods and tools the catalog lacks and methods the app dropped", () => {
    const gaps = catalogGaps(
      {
        methods: entries("Ping", "Gone"),
        tools: entries("Read", "CreateTask"),
      },
      app,
    );
    expect(gaps).toStrictEqual({
      methodsMissingFromCatalog: ["Fresh"],
      catalogMethodsGone: ["Gone"],
      toolsMissingFromCatalog: ["Visualize"],
    });
  });

  it("finds no gap when the catalog matches", () => {
    expect(
      catalogGaps(
        {
          methods: entries("Ping", "Fresh"),
          tools: entries("Read", "Visualize", "CreateTask", "Await"),
        },
        app,
      ),
    ).toStrictEqual({
      methodsMissingFromCatalog: [],
      catalogMethodsGone: [],
      toolsMissingFromCatalog: [],
    });
  });

  it("rejects a catalog without methods[] or tools[]", () => {
    expect(() => catalogGaps({ tools: [] }, app)).toThrow("no methods[]");
    expect(() => catalogGaps({ methods: [] }, app)).toThrow("no tools[]");
  });
});
