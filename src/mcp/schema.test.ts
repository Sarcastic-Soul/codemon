import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { jsonSchemaToZod } from "./schema.ts";

/** Parse `value` against the Zod built from `schema`. */
function check(schema: unknown, value: unknown) {
  return jsonSchemaToZod(schema).safeParse(value);
}

describe("JSON Schema to Zod", () => {
  test("scalar properties convert with the right types", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
        ratio: { type: "number" },
        flag: { type: "boolean" },
      },
      required: ["name", "count", "ratio", "flag"],
    };

    expect(check(schema, { name: "a", count: 1, ratio: 1.5, flag: true }).success).toBe(true);
    expect(check(schema, { name: "a", count: 1.5, ratio: 1.5, flag: true }).success).toBe(false);
    expect(check(schema, { name: 1, count: 1, ratio: 1.5, flag: true }).success).toBe(false);
  });

  test("required and optional are distinguished", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    };

    expect(check(schema, { a: "x" }).success).toBe(true);
    expect(check(schema, { b: "x" }).success).toBe(false);
  });

  test("nested objects convert", () => {
    const schema = {
      type: "object",
      properties: {
        owner: {
          type: "object",
          properties: { login: { type: "string" } },
          required: ["login"],
        },
      },
      required: ["owner"],
    };

    expect(check(schema, { owner: { login: "octocat" } }).success).toBe(true);
    expect(check(schema, { owner: {} }).success).toBe(false);
  });

  test("arrays convert, including arrays of objects", () => {
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        rows: {
          type: "array",
          items: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        },
      },
      required: ["tags", "rows"],
    };

    expect(check(schema, { tags: ["a"], rows: [{ id: 1 }] }).success).toBe(true);
    expect(check(schema, { tags: [1], rows: [] }).success).toBe(false);
    expect(check(schema, { tags: [], rows: [{}] }).success).toBe(false);
  });

  test("a string enum becomes a Zod enum", () => {
    const schema = {
      type: "object",
      properties: { state: { type: "string", enum: ["open", "closed"] } },
      required: ["state"],
    };

    expect(check(schema, { state: "open" }).success).toBe(true);
    expect(check(schema, { state: "merged" }).success).toBe(false);
  });

  test("a mixed-type enum validates by membership rather than failing to convert", () => {
    const schema = {
      type: "object",
      properties: { v: { enum: [1, "two", true] } },
      required: ["v"],
    };

    expect(check(schema, { v: "two" }).success).toBe(true);
    expect(check(schema, { v: 3 }).success).toBe(false);
  });

  test("anyOf and oneOf become unions", () => {
    const schema = {
      type: "object",
      properties: { id: { anyOf: [{ type: "string" }, { type: "integer" }] } },
      required: ["id"],
    };

    expect(check(schema, { id: "a" }).success).toBe(true);
    expect(check(schema, { id: 1 }).success).toBe(true);
    expect(check(schema, { id: true }).success).toBe(false);
  });

  test("a nullable type accepts null", () => {
    const schema = {
      type: "object",
      properties: { note: { type: ["string", "null"] } },
      required: ["note"],
    };

    expect(check(schema, { note: null }).success).toBe(true);
    expect(check(schema, { note: "x" }).success).toBe(true);
  });

  test("allOf of objects merges their properties", () => {
    const schema = {
      type: "object",
      properties: {
        thing: {
          allOf: [
            { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            { type: "object", properties: { b: { type: "integer" } }, required: ["b"] },
          ],
        },
      },
      required: ["thing"],
    };

    expect(check(schema, { thing: { a: "x", b: 1 } }).success).toBe(true);
    expect(check(schema, { thing: { a: "x" } }).success).toBe(false);
  });

  test("an unrecognised type degrades to unknown rather than throwing", () => {
    // A partially-typed tool still works; a thrown conversion loses the whole
    // server.
    const schema = {
      type: "object",
      properties: { weird: { type: "quaternion" } },
      required: ["weird"],
    };

    expect(() => jsonSchemaToZod(schema)).not.toThrow();
    expect(check(schema, { weird: { anything: true } }).success).toBe(true);
  });

  test("descriptions survive the conversion", () => {
    const zod = jsonSchemaToZod({
      type: "object",
      properties: { path: { type: "string", description: "File to read" } },
      required: ["path"],
    }) as z.ZodObject<{ path: z.ZodString }>;

    expect(zod.shape.path.description).toBe("File to read");
  });

  test("a schema with no properties accepts anything", () => {
    // Plenty of tools take no arguments and say so with an empty object.
    expect(check({ type: "object" }, {}).success).toBe(true);
    expect(check({ type: "object", properties: {} }, { extra: 1 }).success).toBe(true);
  });

  test("garbage input still yields a usable object schema", () => {
    expect(jsonSchemaToZod(null)).toBeInstanceOf(z.ZodObject);
    expect(jsonSchemaToZod("nonsense")).toBeInstanceOf(z.ZodObject);
    expect(jsonSchemaToZod(undefined)).toBeInstanceOf(z.ZodObject);
  });

  test("a self-referential schema terminates instead of recursing forever", () => {
    const node: Record<string, unknown> = { type: "object", properties: {} };
    (node.properties as Record<string, unknown>).self = node;

    expect(() => jsonSchemaToZod(node)).not.toThrow();
  });
});
