/**
 * Shared structural interfaces.
 *
 * This module has NO runtime imports — everything here is `import type`-only —
 * so fields / model / queryset / registry can all refer to these shapes without
 * creating runtime import cycles.
 */
import type { Field } from "./fields.ts";
import type { QuerySet } from "./queryset.ts";
import type { Manager } from "./manager.ts";
import type { Backend } from "./backends/base.ts";

/** A model instance: the dynamic field bag plus the lifecycle methods. */
export interface ModelInstance {
  /** Primary-key value (alias for the pk field's attribute). */
  readonly pk: unknown;
  save(opts?: { updateFields?: string[] }): Promise<this>;
  delete(): Promise<{ count: number }>;
  refreshFromDb(): Promise<this>;
  // Field values live as own properties; typed loosely on the base interface.
  [key: string]: unknown;
}

/** Per-model metadata assembled at registration (Django's `Meta` + `_meta`). */
export interface ModelMeta {
  modelName: string;
  dbTable: string;
  fields: Map<string, Field>;
  /** Insertion-ordered field list, the canonical column order. */
  fieldList: Field[];
  pk: Field;
  ordering: string[];
  connectionAlias: string;
}

/** The static side of a model class (what `class X extends Model` exposes). */
export interface ModelClass {
  new (data?: Record<string, unknown>): ModelInstance;
  readonly modelName: string;
  readonly meta: ModelMeta;
  readonly objects: Manager;
  readonly DoesNotExist: new (message?: string) => Error;
  readonly MultipleObjectsReturned: new (message?: string) => Error;
  /** Build an instance from a raw DB row (used by the QuerySet to hydrate results). */
  _fromDbRow(row: Record<string, unknown>): ModelInstance;
  /** Build an instance plus its selectRelated nested instances from a joined row. */
  _hydrateRelated(row: Record<string, unknown>, paths: string[][]): ModelInstance;
  /** Batch-load reverse relations onto already-fetched instances (prefetch). */
  _prefetch(instances: ModelInstance[], names: string[]): Promise<void>;
  /** Resolve the backend this model reads/writes through. */
  _backend(): Backend;
  getQuerySet(): QuerySet;
}
