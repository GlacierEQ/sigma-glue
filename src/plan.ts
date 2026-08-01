/** Values accepted by the canonical Sigma plan serializer. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export class CanonicalizationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/**
 * Serialize a plan into deterministic JSON.
 *
 * Guarantees:
 * - object keys are lexicographically sorted;
 * - array order is preserved;
 * - non-finite numbers and ambiguous JavaScript values are rejected;
 * - cyclic and non-plain objects are rejected;
 * - no mutation of the source value.
 */
export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>();
  return serialize(value, "$", ancestors);
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);

    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`Non-finite number at ${path}`);
      }
      return JSON.stringify(value);

    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      throw new CanonicalizationError(`Unsupported ${typeof value} at ${path}`);

    case "object":
      return serializeObject(value, path, ancestors);

    default:
      throw new CanonicalizationError(`Unsupported value at ${path}`);
  }
}

function serializeObject(value: object, path: string, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw new CanonicalizationError(`Cyclic value at ${path}`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertNoSymbolKeys(value, path);
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalizationError(`Sparse array entry at ${path}[${index}]`);
        }
        entries.push(serialize(value[index], `${path}[${index}]`, ancestors));
      }

      const unexpectedKeys = Object.keys(value).filter(
        (key) => !isCanonicalArrayIndex(key, value.length),
      );
      if (unexpectedKeys.length > 0) {
        throw new CanonicalizationError(`Unexpected array property at ${path}.${unexpectedKeys[0]}`);
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(`Non-plain object at ${path}`);
    }

    assertNoSymbolKeys(value, path);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodePoints);
    const fields = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new CanonicalizationError(`Accessor property at ${path}.${key}`);
      }
      const encodedKey = JSON.stringify(key);
      const encodedValue = serialize(descriptor.value, `${path}.${key}`, ancestors);
      return `${encodedKey}:${encodedValue}`;
    });
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNoSymbolKeys(value: object, path: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalizationError(`Symbol-keyed property at ${path}`);
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

import { createHash } from "node:crypto";

export const PLAN_FINGERPRINT_ALGORITHM = "sha256" as const;
export type PlanFingerprint = `sha256:${string}`;

/** Return the fingerprint that Gatekeeper approval must bind exactly. */
export function fingerprintPlan(plan: unknown): PlanFingerprint {
  const canonicalPlan = canonicalize(plan);
  const digest = createHash(PLAN_FINGERPRINT_ALGORITHM)
    .update(canonicalPlan, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export function isPlanFingerprint(value: string): value is PlanFingerprint {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}
