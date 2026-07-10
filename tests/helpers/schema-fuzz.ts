/**
 * Schema introspection helpers shared by the transport-realism fuzz test and
 * the enum-drift snapshot test. Everything here works off the JSON Schema a
 * tool actually advertises over the wire (tools/list), not its zod internals,
 * so it reflects exactly what a real MCP client sees.
 */

export interface JsonSchemaLike {
  type?: string;
  enum?: unknown[];
  anyOf?: JsonSchemaLike[];
  const?: unknown;
  default?: unknown;
  items?: JsonSchemaLike;
  minItems?: number;
  minimum?: number;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
}

/** True if a param's wire schema is a plain boolean or the sanctioned boolish() union. */
export function isBooleanLike(schema: JsonSchemaLike | undefined): boolean {
  if (!schema) return false;
  if (schema.type === "boolean") return true;
  if (schema.anyOf) return schema.anyOf.some((s) => s.type === "boolean");
  return false;
}

/** True if a param's wire schema is EXACTLY a plain boolean (no stringified escape hatch). */
export function isPlainBoolean(schema: JsonSchemaLike | undefined): boolean {
  return !!schema && schema.type === "boolean";
}

export function isNumberLike(schema: JsonSchemaLike | undefined): boolean {
  if (!schema) return false;
  if (schema.type === "number" || schema.type === "integer") return true;
  if (schema.anyOf) return schema.anyOf.some((s) => s.type === "number" || s.type === "integer");
  return false;
}

/** A minimal valid value for a param's wire schema - recurses into arrays/objects. */
export function sampleValue(schema: JsonSchemaLike | undefined): unknown {
  if (!schema) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (schema.anyOf && schema.anyOf.length > 0) return sampleValue(schema.anyOf[0]);
  if (schema.const !== undefined) return schema.const;
  switch (schema.type) {
    case "string":
      return "test-value";
    case "number":
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return true;
    case "array": {
      const item = schema.items ? sampleValue(schema.items) : "test-value";
      const count = schema.minItems && schema.minItems > 0 ? schema.minItems : 0;
      return Array.from({ length: count }, () => item);
    }
    case "object": {
      const props = schema.properties ?? {};
      const required = schema.required ?? [];
      const obj: Record<string, unknown> = {};
      for (const key of required) obj[key] = sampleValue(props[key]);
      return obj;
    }
    default:
      return null;
  }
}

/** The stringified form a scalar-stringifying MCP client would send for this param, or undefined if not applicable. */
export function stringifiedVariant(schema: JsonSchemaLike | undefined, validValue: unknown): string | undefined {
  if (isBooleanLike(schema)) return validValue === false ? "false" : "true";
  if (isNumberLike(schema) && typeof validValue === "number") return String(validValue);
  return undefined;
}

/** A compact, description-free summary of one tool's schema, for enum-drift snapshotting. */
export function summarizeToolSchema(name: string, schema: JsonSchemaLike): unknown {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return {
    name,
    required: [...required].sort(),
    params: Object.fromEntries(
      Object.entries(props)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([paramName, paramSchema]) => [paramName, summarizeParamShape(paramSchema)]),
    ),
  };
}

function summarizeParamShape(schema: JsonSchemaLike): unknown {
  if (schema.enum) return { enum: [...schema.enum].sort() };
  if (schema.anyOf) return { anyOf: schema.anyOf.map(summarizeParamShape) };
  return { type: schema.type ?? "unknown" };
}

/** True if a CallToolResult represents a schema/input-validation failure, not a business-logic error. */
export function isSchemaValidationFailure(result: { isError?: boolean; content?: Array<{ type: string; text?: string }> }): boolean {
  if (!result.isError) return false;
  const text = result.content?.map((c) => c.text ?? "").join("\n") ?? "";
  return text.includes("Input validation error");
}
