/**
 * JSON Schema → Zod.
 *
 * MCP servers describe their tools with draft-07-ish JSON Schema; the tool
 * registry and the AI SDK both want Zod. The conversion is deliberately
 * forgiving: anything unrecognised becomes `z.unknown()` rather than throwing,
 * because a partially-typed tool still works and a thrown conversion loses the
 * whole server.
 */
import { z } from "zod";

/** The subset of JSON Schema worth reading. Everything else is ignored. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  default?: unknown;
  [key: string]: unknown;
}

/** Guards against a server declaring a schema that references itself. */
const MAX_DEPTH = 12;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe<T extends z.ZodType>(schema: T, node: JsonSchema): T {
  return typeof node.description === "string" && node.description !== ""
    ? (schema.describe(node.description) as T)
    : schema;
}

function convertNode(node: JsonSchema, depth: number): z.ZodType {
  if (depth > MAX_DEPTH) return z.unknown();

  // A literal pins the value; an enum lists them. Both come before `type`,
  // since a server that gives both means the narrower one.
  if (node.const !== undefined) return z.literal(node.const as never);

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum;
    if (values.every((v) => typeof v === "string")) {
      return z.enum(values as [string, ...string[]]);
    }
    // A mixed-type enum has no Zod equivalent; validate by membership instead.
    return z.unknown().refine((v) => values.includes(v), {
      message: `expected one of: ${values.map((v) => JSON.stringify(v)).join(", ")}`,
    });
  }

  const union = node.anyOf ?? node.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    const options = union.filter(isSchema).map((s) => convertNode(s, depth + 1));
    if (options.length === 1) return options[0]!;
    if (options.length > 1) return z.union(options as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }

  // `allOf` of objects is an intersection. Merging property maps is close
  // enough and produces a far more useful schema for the model than z.unknown.
  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    const merged: JsonSchema = { type: "object", properties: {}, required: [] };
    for (const part of node.allOf.filter(isSchema)) {
      Object.assign(merged.properties!, part.properties ?? {});
      merged.required!.push(...(part.required ?? []));
    }
    return convertNode(merged, depth + 1);
  }

  // A union type (`["string", "null"]`) is one of each.
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  const nullable = Array.isArray(node.type) && node.type.includes("null");

  let schema: z.ZodType;
  switch (type) {
    case "string":
      schema = z.string();
      break;
    case "number":
      schema = z.number();
      break;
    case "integer":
      schema = z.number().int();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "null":
      schema = z.null();
      break;
    case "array": {
      // A tuple-form `items` array is rare enough to fall back on.
      const items = isSchema(node.items) ? convertNode(node.items, depth + 1) : z.unknown();
      schema = z.array(items);
      break;
    }
    case "object":
      schema = convertObject(node, depth);
      break;
    default:
      // No `type` at all, but properties present, still means an object.
      schema = node.properties ? convertObject(node, depth) : z.unknown();
  }

  if (nullable) schema = schema.nullable();
  return describe(schema, node);
}

function convertObject(node: JsonSchema, depth: number): z.ZodType {
  const properties = node.properties;
  if (!properties || Object.keys(properties).length === 0) {
    return z.looseObject({});
  }

  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const shape: Record<string, z.ZodType> = {};

  for (const [key, raw] of Object.entries(properties)) {
    if (!isSchema(raw)) continue;
    const converted = convertNode(raw, depth + 1);
    shape[key] = required.has(key) ? converted : converted.optional();
  }

  return z.object(shape);
}

/**
 * Convert a tool's `inputSchema` into the Zod object the registry expects.
 *
 * Always an object at the top level: MCP tool arguments are a named map, and
 * `ToolDefinition.parameters` is handed straight to the AI SDK, which requires
 * an object schema.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodType {
  if (!isSchema(schema)) return z.looseObject({});

  const converted = convertNode({ type: "object", ...schema }, 0);
  // A server that declared something exotic at the top level still needs to be
  // callable, so anything non-object degrades to a permissive object.
  return converted instanceof z.ZodObject ? converted : z.looseObject({});
}
