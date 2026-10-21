type Dict = { readonly [key: string]: unknown };

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isType(type: unknown, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isDict(value);
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

/**
 * The problems of `value` against `schema`: a checker for the JSON Schema keywords the inbox
 * schema uses (type, enum, const, required, properties, additionalProperties, items, size and
 * length limits, pattern, uniqueItems, allOf, anyOf, not, boolean schemas). It stands in for a
 * full validator, which the repo does not depend on.
 */
export function schemaErrors(
  schema: unknown,
  value: unknown,
  path = "$",
): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: is not allowed`];
  if (!isDict(schema)) return [`${path}: schema is not an object`];
  const out: string[] = [];
  const bad = (message: string) => out.push(`${path}: ${message}`);
  if ("type" in schema && !isType(schema.type, value)) {
    bad(`is not a ${String(schema.type)}`);
    return out;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    bad("is not one of the allowed values");
  if ("const" in schema && schema.const !== value) bad("is not the constant");
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength)
      bad("is too short");
    if (typeof schema.maxLength === "number" && length > schema.maxLength)
      bad("is too long");
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern).test(value)
    )
      bad(`does not match ${schema.pattern}`);
  }
  if (
    typeof value === "number" &&
    typeof schema.minimum === "number" &&
    value < schema.minimum
  )
    bad("is below the minimum");
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      bad("has too few items");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      bad("has too many items");
    if (schema.uniqueItems === true && new Set(value).size !== value.length)
      bad("has repeated items");
    if ("items" in schema)
      value.forEach((item, i) => {
        out.push(...schemaErrors(schema.items, item, `${path}[${i}]`));
      });
  }
  if (isDict(value)) {
    if (Array.isArray(schema.required))
      for (const key of schema.required)
        if (!(String(key) in value)) bad(`is missing ${String(key)}`);
    const properties = isDict(schema.properties) ? schema.properties : {};
    for (const [key, sub] of Object.entries(properties))
      if (key in value)
        out.push(...schemaErrors(sub, value[key], `${path}.${key}`));
    if (schema.additionalProperties === false)
      for (const key of Object.keys(value))
        if (!(key in properties)) bad(`has unknown property ${key}`);
  }
  if (Array.isArray(schema.allOf))
    for (const sub of schema.allOf) out.push(...schemaErrors(sub, value, path));
  if (
    Array.isArray(schema.anyOf) &&
    schema.anyOf.every((sub) => schemaErrors(sub, value, path).length > 0)
  )
    bad("matches none of the alternatives");
  if ("not" in schema && schemaErrors(schema.not, value, path).length === 0)
    bad("matches a schema it must not match");
  return out;
}
