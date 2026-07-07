/**
 * Parsing of Django-style double-underscore lookups into the condition AST.
 *
 *   { age__gte: 18, name__icontains: "smith" }
 *     -> AND( lookup(age, gte, 18), lookup(name, icontains, "smith") )
 *
 *   { author__name: "Tolkien" }
 *     -> lookup(["author","name"], exact, "Tolkien")   // relation spanning
 *
 * The rule matches Django: split on "__"; if the final segment is a known lookup
 * name it becomes the lookup and the rest is the field path, otherwise the whole
 * key is a field path with an implicit `exact`.
 */
import type { Condition, LookupNode } from "./ast.ts";

/** The supported field lookups. */
export const KNOWN_LOOKUPS = new Set([
  "exact",
  "iexact",
  "contains",
  "icontains",
  "in",
  "gt",
  "gte",
  "lt",
  "lte",
  "startswith",
  "istartswith",
  "endswith",
  "iendswith",
  "range",
  "date",
  "year",
  "month",
  "day",
  "isnull",
  "regex",
  "iregex",
]);

/** A plain filter object: `{ "name__icontains": "x", age__gte: 18 }`. */
export type FilterObject = Record<string, unknown>;

export function parseLookupKey(key: string): { path: string[]; lookup: string } {
  const parts = key.split("__").filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(`Empty lookup key: ${JSON.stringify(key)}`);
  }
  const last = parts[parts.length - 1]!;
  if (parts.length > 1 && KNOWN_LOOKUPS.has(last)) {
    return { path: parts.slice(0, -1), lookup: last };
  }
  return { path: parts, lookup: "exact" };
}

/** Turn a single filter object into a flat list of lookup nodes (to be AND-ed). */
export function lookupsFromObject(obj: FilterObject): LookupNode[] {
  return Object.entries(obj).map(([key, value]) => {
    const { path, lookup } = parseLookupKey(key);
    return { kind: "lookup", path, lookup, value };
  });
}

/** AND a filter object's lookups into a single condition (the unit a filter() call adds). */
export function conditionFromObject(obj: FilterObject): Condition {
  const nodes = lookupsFromObject(obj);
  if (nodes.length === 1) return nodes[0]!;
  return { kind: "and", children: nodes };
}
