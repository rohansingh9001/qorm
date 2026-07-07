/**
 * Reverse-relation registry.
 *
 * Holds the metadata for reverse foreign-key accessors (e.g. `author.books`), keyed
 * by target model + accessor name. It lives in its own module — importing only
 * types — so both `model.ts` (which installs the prototype accessors) and
 * `query/compiler.ts` (which plans reverse JOINs for annotate/spanning) can read it
 * without a runtime import cycle.
 */
import type { ModelClass } from "./types.ts";
import type { ForeignKey, ManyToManyField } from "./fields.ts";

export type ReverseRelation =
  | { kind: "fk"; sourceModel: ModelClass; field: ForeignKey; accessorName: string }
  | { kind: "m2m"; sourceModel: ModelClass; field: ManyToManyField; accessorName: string };

const reverseRelations = new Map<string, Map<string, ReverseRelation>>();

export function registerReverseRelation(targetModelName: string, rel: ReverseRelation): void {
  let byAccessor = reverseRelations.get(targetModelName);
  if (!byAccessor) {
    byAccessor = new Map();
    reverseRelations.set(targetModelName, byAccessor);
  }
  byAccessor.set(rel.accessorName, rel);
}

export function getReverseRelation(targetModelName: string, accessor: string): ReverseRelation | undefined {
  return reverseRelations.get(targetModelName)?.get(accessor);
}
