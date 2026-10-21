import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What one extracted Grok Bot app tree (the contents of `Contents/Resources/app.asar`)
 * says about GrokBot's API, read from its minified bundles. Used by app-update-check.ts;
 * every pattern here matches the shipped code's shape, so a bundle that no longer fits
 * fails loudly instead of reading as "nothing changed".
 */
export interface AppSchema {
  /** `aiserver.v1.X` service -> method name -> `Request -> Response (kind)`. */
  readonly services: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Message name -> descriptor `Name|1 field 9|2 other #Message*`, references resolved to names. */
  readonly messages: ReadonlyMap<string, string>;
  /** Bot tool name -> same name. */
  readonly tools: ReadonlyMap<string, string>;
  /** Box Gateway method -> how the app routes it (`person` or `background`). */
  readonly gateway: ReadonlyMap<string, string>;
  /** Client gate -> `client:1 default:0`, or `config` for dynamic-config gates. */
  readonly gates: ReadonlyMap<string, string>;
  /** Message references the bundles did not let us resolve to a name. */
  readonly unresolved: number;
}

export interface AppSources {
  /** `dist/electron-main/proto.cjs`: all seven services and most messages. */
  readonly proto: string;
  /** `dist/node-agent-coordinator/main.cjs`: more messages, and the Box Gateway method table. */
  readonly coordinator: string;
  /** `dist/local-exec-daemon/main.cjs`: more messages. */
  readonly daemon: string;
  /** `dist/electron-main/main-core.cjs`: the bot tool registry. */
  readonly mainCore: string;
  /** `dist/electron-main/main-app.cjs`: the client gate registry. */
  readonly mainApp: string;
}

const CLASS = /(?<![\w$.])([\w$]+)=class(?: ([\w$]+))? extends [\w$]+\{/g;
const DESCRIPTOR = /static \$\(\)\{return\["([^"]*)"((?:,[\w$]+)*)\]\}/g;
const ENUM = /(?<![\w$.])([\w$]+)=[\w$]+\([\w$]+,[\w$]+,"([\w.]+)",\[\[/g;
const WELL_KNOWN = /(?<![\w$.])([\w$]+)\.typeName="(google\.protobuf\.\w+)"/g;
const SERVICE = /\{typeName:"([\w.]+)",methods:\{/g;
const METHOD =
  /[\w$]+:\{name:"(\w+)",I:([\w$]+),O:([\w$]+),kind:[\w$]+\.(\w+)\},?/y;
const GATE =
  /(?:"([^"]+)"|([A-Za-z_$][\w$]*)):\{client:!([01])(?:,default:!([01]))?(?:,requiresAuthenticatedBootstrap:!([01]))?(,fallbackValues:)?/g;

interface ProtoClass {
  readonly start: number;
  readonly variable: string;
  /** The class's own name inside its body: how a message refers to itself. */
  readonly inner: string | undefined;
}

interface ProtoBundle {
  readonly messages: Map<string, string>;
  readonly services: Map<string, Map<string, string>>;
  unresolved: number;
}

/** The class declared last before `position`: the owner of a descriptor found there. */
function ownerOf(classes: readonly ProtoClass[], position: number): ProtoClass {
  let low = 0;
  let high = classes.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((classes[mid]?.start ?? 0) < position) low = mid;
    else high = mid - 1;
  }
  const owner = classes[low];
  if (!owner) throw new Error("A message descriptor has no class before it.");
  return owner;
}

/** Messages and services of one bundle. Variable names are minified per bundle. */
function parseProtoBundle(source: string, label: string): ProtoBundle {
  const classes: ProtoClass[] = [...source.matchAll(CLASS)].map((m) => ({
    start: m.index,
    variable: m[1] ?? "",
    inner: m[2],
  }));
  const descriptors = [...source.matchAll(DESCRIPTOR)].map((m) => ({
    owner: ownerOf(classes, m.index),
    name: (m[1] ?? "").split("|", 1)[0] ?? "",
    text: m[1] ?? "",
    refs: (m[2] ?? "").split(",").filter((ref) => ref !== ""),
  }));
  if (descriptors.length === 0) {
    throw new Error(`${label}: no message descriptors found.`);
  }
  const names = new Map<string, string>();
  for (const { owner, name } of descriptors) names.set(owner.variable, name);
  for (const m of source.matchAll(WELL_KNOWN)) {
    if (!names.has(m[1] ?? "")) names.set(m[1] ?? "", m[2] ?? "");
  }
  const enums = new Map<string, string>();
  for (const m of source.matchAll(ENUM)) enums.set(m[1] ?? "", m[2] ?? "");

  const bundle: ProtoBundle = {
    messages: new Map(),
    services: new Map(),
    unresolved: 0,
  };
  const resolve = (variable: string, self?: ProtoClass, own = ""): string => {
    const name =
      self && variable === self.inner
        ? own
        : (names.get(variable) ?? enums.get(variable));
    if (name === undefined) bundle.unresolved++;
    return name ?? "?";
  };
  for (const { owner, name, text, refs } of descriptors) {
    const [, ...fields] = text.split("|");
    const resolved = fields.map((field) =>
      field.replace(/#(\d+)/g, (_, index: string) => {
        const ref = refs[Number(index)];
        return `#${ref === undefined ? "?" : resolve(ref, owner, name)}`;
      }),
    );
    if (!bundle.messages.has(name)) {
      bundle.messages.set(name, [name, ...resolved].join("|"));
    }
  }
  for (const service of source.matchAll(SERVICE)) {
    const methods = new Map<string, string>();
    METHOD.lastIndex = service.index + service[0].length;
    for (let m = METHOD.exec(source); m; m = METHOD.exec(source)) {
      methods.set(
        m[1] ?? "",
        `${resolve(m[2] ?? "")} -> ${resolve(m[3] ?? "")} (${m[4]})`,
      );
    }
    bundle.services.set(service[1] ?? "", methods);
  }
  return bundle;
}

/** The `{...}` object literal with no nested braces that contains `anchor`. */
function objectAround(source: string, anchor: string, what: string): string {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`${what}: anchor ${anchor} not found.`);
  return source.slice(source.lastIndexOf("{", at), source.indexOf("}", at) + 1);
}

/** Minified booleans: `!0` is true and `!1` is false. */
const minifiedBoolean = (digit: string | undefined): string =>
  digit === "0" ? "true" : digit === "1" ? "false" : "?";

function parseGates(source: string): Map<string, string> {
  const gates = new Map<string, string>();
  for (const m of source.matchAll(GATE)) {
    const state = m[6] ? "config" : `default:${minifiedBoolean(m[4])}`;
    const bootstrap =
      m[5] === undefined ? "" : ` bootstrap:${minifiedBoolean(m[5])}`;
    gates.set(
      m[1] ?? m[2] ?? "",
      `client:${minifiedBoolean(m[3])} ${state}${bootstrap}`,
    );
  }
  if (gates.size === 0) throw new Error("main-app.cjs: no client gates found.");
  return gates;
}

/** Reads the schema facts out of the five bundles' source text. */
export function parseAppSchema(sources: AppSources): AppSchema {
  const bundles = [
    parseProtoBundle(sources.proto, "proto.cjs"),
    parseProtoBundle(sources.coordinator, "node-agent-coordinator"),
    parseProtoBundle(sources.daemon, "local-exec-daemon"),
  ];
  const messages = new Map<string, string>();
  const services = new Map<string, Map<string, string>>();
  for (const bundle of bundles) {
    for (const [name, text] of bundle.messages) {
      if (!messages.has(name)) messages.set(name, text);
    }
    for (const [name, methods] of bundle.services) {
      if (!services.has(name)) services.set(name, methods);
    }
  }
  if (services.size === 0) throw new Error("No services found in the bundles.");
  const tools = new Map(
    [
      ...objectAround(
        sources.mainCore,
        'CreateTask:"CreateTask"',
        "bot tool registry",
      ).matchAll(/([\w$]+):"[\w$]+"/g),
    ].map((m) => [m[1] ?? "", m[1] ?? ""]),
  );
  const gateway = new Map(
    [
      ...objectAround(
        sources.coordinator,
        'callMcpAppTool:"person"',
        "Box Gateway method table",
      ).matchAll(/([\w$]+):"(\w+)"/g),
    ].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
  return {
    services,
    messages,
    tools,
    gateway,
    gates: parseGates(sources.mainApp),
    unresolved: bundles.reduce((sum, bundle) => sum + bundle.unresolved, 0),
  };
}

/** Reads the bundles of an extracted app.asar (its root holds `dist/`). */
export async function readAppSchema(root: string): Promise<AppSchema> {
  const read = (path: string) => readFile(join(root, "dist", path), "utf8");
  const [proto, coordinator, daemon, mainCore, mainApp] = await Promise.all([
    read("electron-main/proto.cjs"),
    read("node-agent-coordinator/main.cjs"),
    read("local-exec-daemon/main.cjs"),
    read("electron-main/main-core.cjs"),
    read("electron-main/main-app.cjs"),
  ]);
  return parseAppSchema({ proto, coordinator, daemon, mainCore, mainApp });
}

export interface Entry {
  readonly name: string;
  readonly value: string;
}

export interface Change {
  readonly name: string;
  readonly before: string;
  readonly after: string;
}

/** What changed between two name -> value maps. */
export interface MapDiff {
  readonly before: number;
  readonly after: number;
  readonly added: readonly Entry[];
  readonly removed: readonly Entry[];
  readonly changed: readonly Change[];
}

export interface ServiceDiff extends MapDiff {
  readonly service: string;
}

export interface MessageDiff {
  readonly before: number;
  readonly after: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Each changed message with one line per field added (`+`), removed (`-`) or modified (`~`). */
  readonly changed: readonly { name: string; fields: readonly string[] }[];
}

export interface SchemaDiff {
  readonly services: readonly ServiceDiff[];
  readonly tools: MapDiff;
  readonly gateway: MapDiff;
  readonly gates: MapDiff;
  readonly messages: MessageDiff;
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function diffMaps(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): MapDiff {
  const added: Entry[] = [];
  const changed: Change[] = [];
  for (const [name, value] of after) {
    const old = before.get(name);
    if (old === undefined) added.push({ name, value });
    else if (old !== value) changed.push({ name, before: old, after: value });
  }
  const removed = [...before]
    .filter(([name]) => !after.has(name))
    .map(([name, value]) => ({ name, value }));
  return {
    before: before.size,
    after: after.size,
    added: added.sort(byName),
    removed: removed.sort(byName),
    changed: changed.sort(byName),
  };
}

/** A message descriptor's fields by number: `name type`. */
function fieldsOf(descriptor: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const field of descriptor.split("|").slice(1)) {
    const space = field.indexOf(" ");
    fields.set(
      space < 0 ? field : field.slice(0, space),
      space < 0 ? "" : field.slice(space + 1),
    );
  }
  return fields;
}

function describeFieldChanges(before: string, after: string): string[] {
  const old = fieldsOf(before);
  const next = fieldsOf(after);
  const lines: string[] = [];
  for (const [no, field] of next) {
    const was = old.get(no);
    if (was === undefined) lines.push(`+${no} ${field}`);
    else if (was !== field) lines.push(`~${no} ${field} (was ${was})`);
  }
  for (const [no, field] of old) {
    if (!next.has(no)) lines.push(`-${no} ${field}`);
  }
  return lines;
}

function diffMessages(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): MessageDiff {
  const diff = diffMaps(before, after);
  return {
    before: diff.before,
    after: diff.after,
    added: diff.added.map((entry) => entry.name),
    removed: diff.removed.map((entry) => entry.name),
    changed: diff.changed.map(({ name, before: was, after: now }) => ({
      name,
      fields: describeFieldChanges(was, now),
    })),
  };
}

/** What the app changed from `before` to `after`. */
export function diffSchemas(before: AppSchema, after: AppSchema): SchemaDiff {
  const none: ReadonlyMap<string, string> = new Map();
  const names = [
    ...new Set([...before.services.keys(), ...after.services.keys()]),
  ];
  return {
    services: names.sort().map((service) => ({
      service,
      ...diffMaps(
        before.services.get(service) ?? none,
        after.services.get(service) ?? none,
      ),
    })),
    tools: diffMaps(before.tools, after.tools),
    gateway: diffMaps(before.gateway, after.gateway),
    gates: diffMaps(before.gates, after.gates),
    messages: diffMessages(before.messages, after.messages),
  };
}

/** What the tools-and-API catalog does not match in the app. */
export interface CatalogGaps {
  /** GrokBotService methods the app has and the catalog lacks. */
  readonly methodsMissingFromCatalog: readonly string[];
  /** Catalog methods the app's GrokBotService no longer has. */
  readonly catalogMethodsGone: readonly string[];
  /** Registry tools the catalog lacks. */
  readonly toolsMissingFromCatalog: readonly string[];
}

/** `value[key]` when `value` is an object that has it, else undefined; checked, never cast. */
export function member(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined;
}

function catalogNames(catalog: unknown, key: "methods" | "tools"): string[] {
  const list = member(catalog, key);
  if (!Array.isArray(list)) throw new Error(`The catalog has no ${key}[].`);
  return list.map((entry: unknown) => {
    const name = member(entry, "name");
    if (typeof name !== "string") {
      throw new Error(`A catalog ${key} entry has no name.`);
    }
    return name;
  });
}

/** Compares the app's GrokBotService methods and bot tool registry with the catalog. */
export function catalogGaps(catalog: unknown, app: AppSchema): CatalogGaps {
  const service = app.services.get("aiserver.v1.GrokBotService");
  if (!service) throw new Error("The app has no aiserver.v1.GrokBotService.");
  const methods = new Set(catalogNames(catalog, "methods"));
  const tools = new Set(catalogNames(catalog, "tools"));
  return {
    methodsMissingFromCatalog: [...service.keys()]
      .filter((name) => !methods.has(name))
      .sort(),
    catalogMethodsGone: [...methods]
      .filter((name) => !service.has(name))
      .sort(),
    toolsMissingFromCatalog: [...app.tools.keys()]
      .filter((name) => !tools.has(name))
      .sort(),
  };
}
