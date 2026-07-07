import type { AnnotationExpr } from "../expressions.ts";

/**
 * The internal query representation.
 *
 * A `QueryState` is the immutable AST that a `QuerySet` carries around. Chaining
 * methods (`filter`, `orderBy`, …) clone the state and return a new QuerySet; the
 * compiler (`query/compiler.ts`) turns a `QueryState` + a model into parameterized
 * SQL. Keeping this purely declarative is what makes querysets lazy and reusable.
 */

/** A value that can be bound as a SQL parameter by the backends we support. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array | Date;

/**
 * A single field lookup, e.g. `name__icontains: "smith"` parses to
 * `{ kind: "lookup", path: ["name"], lookup: "icontains", value: "smith" }`.
 * `path` has length > 1 only for relation spanning (`author__name`), which the
 * Phase 1 compiler does not yet resolve.
 */
export interface LookupNode {
  kind: "lookup";
  path: string[];
  lookup: string;
  value: unknown;
}

export interface AndNode {
  kind: "and";
  children: Condition[];
}

export interface OrNode {
  kind: "or";
  children: Condition[];
}

export interface NotNode {
  kind: "not";
  child: Condition;
}

/**
 * `column IN (subquery)` with pre-built SQL — used internally by M2M managers
 * to scope a queryset through the relation's through-table.
 */
export interface InSubNode {
  kind: "insub";
  path: string[];
  sql: string;
  params: SqlValue[];
}

/** The recursive WHERE-clause condition tree. */
export type Condition = LookupNode | AndNode | OrNode | NotNode | InSubNode;

export interface OrderBy {
  field: string;
  desc: boolean;
}

/** How rows are projected once fetched. */
export type ResultMode = "instances" | "values" | "valuesList" | "flat";

export interface QueryState {
  /** Top-level conditions, implicitly AND-ed together (one entry per filter/exclude call). */
  where: Condition[];
  order: OrderBy[];
  limit: number | null;
  offset: number;
  distinct: boolean;
  /** Restricts selected columns for `values`/`valuesList`/`only`; null = all fields. */
  selectFields: string[] | null;
  resultMode: ResultMode;
  /** Set to true by `none()` — short-circuits to an empty result without hitting the DB. */
  empty: boolean;
  /** Forward FK/O2O relation paths to LEFT JOIN and hydrate (design §6.3). Each path is its segments. */
  selectRelated: string[][];
  /** Reverse-FK / M2M accessor names to batch-load in a second query (design §6.3). */
  prefetchRelated: string[];
  /** Per-row annotations (aggregates, DB functions, F, windows); keyed by output name. */
  annotations: Record<string, AnnotationExpr>;
  /** Restrict loaded fields to these (+pk) — Django's `only()`. Null = no restriction. */
  only: string[] | null;
  /** Exclude these fields from loading — Django's `defer()`. */
  defer: string[];
  /** SELECT ... FOR UPDATE row locks; a no-op on SQLite (whole-file locking). */
  forUpdate: boolean;
  /** Connection alias override for this queryset — Django's `using("replica")`. */
  using: string | null;
}

/** A fresh, unfiltered query state. */
export function emptyState(): QueryState {
  return {
    where: [],
    order: [],
    limit: null,
    offset: 0,
    distinct: false,
    selectFields: null,
    resultMode: "instances",
    empty: false,
    selectRelated: [],
    prefetchRelated: [],
    annotations: {},
    only: null,
    defer: [],
    forUpdate: false,
    using: null,
  };
}

/** Structurally clone a query state so chaining stays immutable. */
export function cloneState(s: QueryState): QueryState {
  return {
    where: s.where.map(cloneCondition),
    order: s.order.map((o) => ({ ...o })),
    limit: s.limit,
    offset: s.offset,
    distinct: s.distinct,
    selectFields: s.selectFields ? [...s.selectFields] : null,
    resultMode: s.resultMode,
    empty: s.empty,
    selectRelated: s.selectRelated.map((p) => [...p]),
    prefetchRelated: [...s.prefetchRelated],
    annotations: { ...s.annotations },
    only: s.only ? [...s.only] : null,
    defer: [...s.defer],
    forUpdate: s.forUpdate,
    using: s.using,
  };
}

export function cloneCondition(c: Condition): Condition {
  switch (c.kind) {
    case "lookup":
      return { kind: "lookup", path: [...c.path], lookup: c.lookup, value: c.value };
    case "and":
      return { kind: "and", children: c.children.map(cloneCondition) };
    case "or":
      return { kind: "or", children: c.children.map(cloneCondition) };
    case "not":
      return { kind: "not", child: cloneCondition(c.child) };
    case "insub":
      return { kind: "insub", path: [...c.path], sql: c.sql, params: [...c.params] };
  }
}
