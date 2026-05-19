import type { AgentRole } from "../../types/entities";
import { shouldValidateFsiOutput } from "./fsi-config";
import { loadFsiManifest } from "./fsi-manifest-loader";
import type { FsiOutputValidationResult } from "./fsi-types";

type JsonSchema = Record<string, unknown>;

function schemaType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateValue(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: string[]
): unknown {
  const t = schema["type"];
  if (typeof t === "string") {
    const actual = schemaType(value);
    if (actual !== t) {
      errors.push(`${path}: expected ${t}, got ${actual}`);
      return value;
    }
  }

  if (t === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const obj = { ...(value as Record<string, unknown>) };
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !(key in obj)) {
          errors.push(`${path}.${key}: required field missing`);
        }
      }
    }
    const props = schema["properties"] as Record<string, JsonSchema> | undefined;
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (!(key in obj)) continue;
        obj[key] = validateValue(obj[key], sub, `${path}.${key}`, errors);
      }
    }
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(obj)) {
        if (props && key in props) continue;
        delete obj[key];
      }
    }
    return obj;
  }

  if (t === "array" && Array.isArray(value)) {
    const items = schema["items"] as JsonSchema | undefined;
    const maxItems = schema["maxItems"];
    let arr = value;
    if (typeof maxItems === "number" && arr.length > maxItems) {
      errors.push(`${path}: array length ${arr.length} exceeds maxItems ${maxItems}`);
      arr = arr.slice(0, maxItems);
    }
    if (items) {
      return arr.map((item, i) => validateValue(item, items, `${path}[${i}]`, errors));
    }
    return arr;
  }

  if (t === "number" && typeof value === "number") {
    const min = schema["minimum"];
    const max = schema["maximum"];
    let n = value;
    if (typeof min === "number" && n < min) {
      errors.push(`${path}: ${n} < minimum ${min}`);
      n = min;
    }
    if (typeof max === "number" && n > max) {
      errors.push(`${path}: ${n} > maximum ${max}`);
      n = max;
    }
    return n;
  }

  if (t === "string" && typeof value === "string") {
    const maxLength = schema["maxLength"];
    const en = schema["enum"];
    if (Array.isArray(en) && !en.includes(value)) {
      errors.push(`${path}: value not in enum`);
    }
    if (typeof maxLength === "number" && [...value].length > maxLength) {
      errors.push(`${path}: string exceeds maxLength ${maxLength}`);
      return [...value].slice(0, maxLength).join("");
    }
    const pattern = schema["pattern"];
    if (typeof pattern === "string") {
      try {
        const re = new RegExp(pattern);
        if (!re.test(value)) errors.push(`${path}: pattern mismatch`);
      } catch {
        /* ignore invalid pattern in manifest */
      }
    }
    return value;
  }

  return value;
}

export async function validateFsiRoleOutput(
  role: AgentRole,
  parsed: Record<string, unknown>
): Promise<FsiOutputValidationResult> {
  if (!shouldValidateFsiOutput()) {
    return { valid: true, errors: [], sanitized: parsed };
  }
  const manifest = await loadFsiManifest();
  const schema = manifest.outputSchemas[role];
  if (!schema) {
    return { valid: true, errors: [], sanitized: parsed };
  }
  const errors: string[] = [];
  const sanitized = validateValue(parsed, schema, "$", errors) as Record<string, unknown>;
  return { valid: errors.length === 0, errors, sanitized };
}
