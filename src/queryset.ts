/**
 * The QuerySet: immutable, lazy, chainable (design 5).
 *
 * Nothing touches the database until the queryset is *evaluated*. Chaining
 * methods (`filter`, `exclude`, `orderBy`, …) clone the AST and return a new
 * QuerySet synchronously. Evaluation triggers — the JS analogues of Django's —
 * are:
 *   - `await qs`                  -> rows array        (thenable; like `list(qs)`)
 *   - `for await (const x of qs)` -> async iteration   (like `for x in qs`)
 *   - `await qs.count()`          -> COUNT(*)          (like `len(qs)`)
 *   - `await qs.exists()`         -> bool              (like `bool(qs)`)
 *   - `qs.slice(5, 10)`           -> still lazy LIMIT/OFFSET
 *   - `await qs.first()/at(0)`    -> first row / index
 */
import type { ModelClass, ModelInstance } from "./types.ts";
import type { Backend } from "./backends/base.ts";
import {
  type QueryState,
  type OrderBy,
  type Condition,
  type SqlValue,
  emptyState,
  cloneState,
} from "./query/ast.ts";
import { toCondition, type QExpr, type AggregateExpr, type AnnotationExpr } from "./expressions.ts";
import type { FilterObject } from "./query/lookups.ts";
import { FieldError } from "./errors.ts";
import { getConnection } from "./connection.ts";
import { atomicOn } from "./transaction.ts";
import {
  compileSelect,
  compileCount,
  compileExists,
  compileUpdate,
  compileDelete,
  compileAggregate,
} from "./query/compiler.ts";

type Filterish = QExpr | FilterObject;

function parseOrderTokens(tokens: string[]): OrderBy[] {
  return tokens.map((t) =>
    t.startsWith("-") ? { field: t.slice(1), desc: true } : { field: t, desc: false },
  );
}

export class QuerySet<T = ModelInstance> implements PromiseLike<T[]>, AsyncIterable<T> {
  readonly model: ModelClass;
  private readonly state: QueryState;
  /** Pre-evaluated rows (set by prefetch). When present, fetch() skips the DB. */
  private readonly cached: T[] | null;
  constructor(model: ModelClass, state: QueryState = emptyState(), cached: T[] | null = null) {
    this.model = model;
    this.state = state;
    this.cached = cached;
  }

  private get backend(): Backend {
    return this.state.using ? getConnection(this.state.using) : this.model._backend();
  }

  private get meta() {
    return this.model.meta;
  }

  /** Route this queryset to a configured connection alias — Django's `using("replica")`. */
  using(alias: string): QuerySet<T> {
    return this.derive((s) => {
      s.using = alias;
    });
  }

  /** Immutable update: clone the state, apply a mutation, return a new queryset. */
  private derive<R = T>(mutate: (s: QueryState) => void): QuerySet<R> {
    const s = cloneState(this.state);
    mutate(s);
    return new QuerySet<R>(this.model, s);
  }

  /* ----- chainable (lazy) ------------------------------------------------ */

  /** Narrow the result set. Multiple filter() calls AND together (like Django). */
  filter(arg: Filterish): QuerySet<T> {
    return this.derive((s) => s.where.push(toCondition(arg)));
  }

  /** Negated filter — `WHERE NOT (...)`. */
  exclude(arg: Filterish): QuerySet<T> {
    return this.derive((s) => s.where.push({ kind: "not", child: toCondition(arg) }));
  }

  /** Internal: AND a pre-built condition node (used by M2M managers). */
  _filterCondition(cond: Condition): QuerySet<T> {
    return this.derive((s) => s.where.push(cond));
  }

  /** Load only these fields (+pk); the rest read as `undefined` — Django's `only()`. */
  only(...fieldNames: string[]): QuerySet<T> {
    return this.derive((s) => {
      s.only = fieldNames;
    });
  }

  /** Skip loading these fields; they read as `undefined` — Django's `defer()`. */
  defer(...fieldNames: string[]): QuerySet<T> {
    return this.derive((s) => {
      s.defer.push(...fieldNames);
    });
  }

  /**
   * Request `SELECT ... FOR UPDATE` row locks (design 8). SQLite has no row
   * locks (the whole database locks on write), so this is accepted and ignored
   * there; it matters for server backends.
   */
  selectForUpdate(): QuerySet<T> {
    return this.derive((s) => {
      s.forUpdate = true;
    });
  }

  /** Set ordering; `"-field"` means descending. Replaces any previous ordering. */
  orderBy(...fields: string[]): QuerySet<T> {
    return this.derive((s) => {
      s.order = parseOrderTokens(fields);
    });
  }

  /** Reverse the current (or model-default) ordering. */
  reverse(): QuerySet<T> {
    return this.derive((s) => {
      const base = s.order.length > 0 ? s.order : parseOrderTokens(this.meta.ordering);
      s.order = base.map((o) => ({ field: o.field, desc: !o.desc }));
    });
  }

  distinct(flag = true): QuerySet<T> {
    return this.derive((s) => {
      s.distinct = flag;
    });
  }

  /** An always-empty queryset that never hits the DB (Django's `none()`). */
  none(): QuerySet<T> {
    return this.derive((s) => {
      s.empty = true;
    });
  }

  /** A copy of this queryset (Django's `all()`); useful to detach from a manager. */
  all(): QuerySet<T> {
    return this.derive(() => {});
  }

  /**
   * Lazy LIMIT/OFFSET, composing with any existing slice. `qs.slice(5, 10)` is
   * the analogue of Django's `qs[5:10]`. Negative indexing is not supported.
   */
  slice(start: number, end?: number): QuerySet<T> {
    if (start < 0 || (end !== undefined && end < 0)) {
      throw new RangeError("Negative indexing is not supported on a QuerySet.");
    }
    return this.derive((s) => {
      s.offset += start;
      if (end !== undefined) {
        const wanted = Math.max(0, end - start);
        s.limit = s.limit === null ? wanted : Math.min(s.limit, wanted);
      }
    });
  }

  /** Lazy LIMIT only. */
  limit(n: number): QuerySet<T> {
    return this.slice(0, n);
  }

  /** Project to plain objects keyed by field name (Django's `values()`). */
  values(...fieldNames: string[]): QuerySet<Record<string, unknown>> {
    const keys = fieldNames.length > 0 ? fieldNames : this.meta.fieldList.map((f) => f.name);
    return this.derive<Record<string, unknown>>((s) => {
      s.resultMode = "values";
      s.selectFields = keys;
    });
  }

  /** Project to tuples (or scalars with `{ flat: true }`) — Django's `values_list()`. */
  valuesList(fieldNames: string[], opts: { flat?: boolean } = {}): QuerySet<unknown[] | unknown> {
    if (opts.flat && fieldNames.length !== 1) {
      throw new Error("valuesList(flat: true) requires exactly one field.");
    }
    return this.derive<unknown[] | unknown>((s) => {
      s.resultMode = opts.flat ? "flat" : "valuesList";
      s.selectFields = fieldNames;
    });
  }

  /**
   * Eager-load forward FK/O2O relations with a JOIN (Django's `select_related`).
   * Spanning is allowed: `selectRelated("author__publisher")`. After evaluation
   * the related instance is cached, so `await book.author.get()` issues no query.
   */
  selectRelated(...paths: string[]): QuerySet<T> {
    return this.derive((s) => {
      for (const p of paths) s.selectRelated.push(p.split("__"));
    });
  }

  /**
   * Batch-load reverse-FK relations in a second query (Django's `prefetch_related`),
   * avoiding N+1. After evaluation, `instance.<name>.all()` returns the cached set.
   */
  prefetchRelated(...names: string[]): QuerySet<T> {
    return this.derive((s) => {
      s.prefetchRelated.push(...names);
    });
  }

  /** Return a queryset that resolves to the given pre-evaluated rows (used by prefetch). */
  withCache(rows: T[]): QuerySet<T> {
    return new QuerySet<T>(this.model, cloneState(this.state), rows);
  }

  /**
   * Add computed columns per row (Django's `annotate`). Accepts aggregates
   * (grouped by PK), DB functions, `F` expressions, and window expressions; the
   * annotation appears as a property on each returned instance.
   *
   *   Author.objects.annotate({ numBooks: Count("books"), lower: Lower("name") })
   */
  annotate(annotations: Record<string, AnnotationExpr>): QuerySet<T> {
    return this.derive((s) => {
      Object.assign(s.annotations, annotations);
    });
  }

  /* ----- set operations (design 5.3) ------------------------------------ */

  /** SQL UNION (or UNION ALL) with another queryset over the same model. */
  union(other: QuerySet<T>, opts: { all?: boolean } = {}): CombinedQuerySet<T> {
    return new CombinedQuerySet<T>(
      this.model,
      [this._compiledForCombine(), other._compiledForCombine()],
      opts.all ? "UNION ALL" : "UNION",
    );
  }
  /** SQL INTERSECT with another queryset over the same model. */
  intersection(other: QuerySet<T>): CombinedQuerySet<T> {
    return new CombinedQuerySet<T>(
      this.model,
      [this._compiledForCombine(), other._compiledForCombine()],
      "INTERSECT",
    );
  }
  /** SQL EXCEPT — rows in this queryset that are not in `other`. */
  difference(other: QuerySet<T>): CombinedQuerySet<T> {
    return new CombinedQuerySet<T>(
      this.model,
      [this._compiledForCombine(), other._compiledForCombine()],
      "EXCEPT",
    );
  }

  /**
   * Compile this queryset as one arm of a set operation: instance columns only
   * (selectRelated/annotations are stripped so the arms' column lists line up).
   */
  _compiledForCombine(): { sql: string; params: SqlValue[] } {
    const s = cloneState(this.state);
    s.selectRelated = [];
    s.prefetchRelated = [];
    s.annotations = {};
    s.resultMode = "instances";
    s.selectFields = null;
    return compileSelect(this.meta, s, this.backend);
  }

  /* ----- evaluation (async) ---------------------------------------------- */

  /** Execute the SELECT and map rows according to the result mode. */
  private async fetch(): Promise<T[]> {
    if (this.cached) return this.cached;
    if (this.state.empty) return [];
    const { sql, params } = compileSelect(this.meta, this.state, this.backend);
    const rows = await this.backend.execute(sql, params);
    switch (this.state.resultMode) {
      case "instances": {
        const instances =
          this.state.selectRelated.length > 0
            ? rows.map((r) => this.model._hydrateRelated(r, this.state.selectRelated))
            : rows.map((r) => this.model._fromDbRow(r));
        const annNames = Object.keys(this.state.annotations);
        if (annNames.length > 0) {
          instances.forEach((inst, i) => {
            for (const name of annNames) (inst as Record<string, unknown>)[name] = rows[i]![name];
          });
        }
        if (this.state.prefetchRelated.length > 0) {
          await this.model._prefetch(instances, this.state.prefetchRelated);
        }
        return instances as T[];
      }
      case "values":
        // Spread to plain objects — the driver hands back null-prototype rows.
        return rows.map((r) => ({ ...r })) as unknown as T[];
      case "valuesList": {
        const keys = this.state.selectFields ?? [];
        return rows.map((r) => keys.map((k) => r[k])) as unknown as T[];
      }
      case "flat": {
        const key = this.state.selectFields?.[0] ?? "";
        return rows.map((r) => r[key]) as unknown as T[];
      }
    }
  }

  /** Thenable: `await qs` resolves to the rows array (Django's `list(qs)`). */
  then<R1 = T[], R2 = never>(
    onFulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.fetch().then(onFulfilled, onRejected);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (const row of await this.fetch()) yield row;
  }

  async count(): Promise<number> {
    if (this.state.empty) return 0;
    const { sql, params } = compileCount(this.meta, this.state, this.backend);
    const rows = await this.backend.execute(sql, params);
    return Number((rows[0] as { n: number }).n);
  }

  async exists(): Promise<boolean> {
    if (this.state.empty) return false;
    const { sql, params } = compileExists(this.meta, this.state, this.backend);
    const rows = await this.backend.execute(sql, params);
    return rows.length > 0;
  }

  /**
   * Fetch exactly one row. Raises the model's `DoesNotExist` if none match and
   * `MultipleObjectsReturned` if more than one does — exactly like Django.
   */
  async get(arg?: Filterish): Promise<T> {
    const qs = arg ? this.filter(arg) : this;
    const limited = qs.derive((s) => {
      s.limit = s.limit === null ? 2 : Math.min(s.limit, 2);
    });
    const rows = await limited.fetch();
    if (rows.length === 0) {
      throw new this.model.DoesNotExist(`${this.meta.modelName} matching query does not exist.`);
    }
    if (rows.length > 1) {
      throw new this.model.MultipleObjectsReturned(
        `get() returned more than one ${this.meta.modelName}.`,
      );
    }
    return rows[0]!;
  }

  /** First row by current/default/pk ordering, or null. */
  async first(): Promise<T | null> {
    const ordered = this.ensureOrdering();
    const rows = await ordered.slice(0, 1).fetch();
    return rows.length > 0 ? rows[0]! : null;
  }

  /** Last row by current/default/pk ordering, or null. */
  async last(): Promise<T | null> {
    const rows = await this.ensureOrdering().reverse().slice(0, 1).fetch();
    return rows.length > 0 ? rows[0]! : null;
  }

  /** Row at index `i`, or null (Django's `qs[i]`). */
  async at(i: number): Promise<T | null> {
    const rows = await this.slice(i, i + 1).fetch();
    return rows.length > 0 ? rows[0]! : null;
  }

  /** first()/last() need a deterministic order; fall back to the primary key. */
  private ensureOrdering(): QuerySet<T> {
    if (this.state.order.length > 0 || this.meta.ordering.length > 0) return this;
    return this.orderBy("pk");
  }

  /** Bulk UPDATE over the matched rows; returns the number of rows changed. */
  async update(values: Record<string, unknown>): Promise<number> {
    if (this.state.empty) return 0;
    const { sql, params } = compileUpdate(this.meta, this.state, values, this.backend);
    const { changes } = await this.backend.run(sql, params);
    return changes;
  }

  /** Bulk DELETE over the matched rows; returns the number of rows deleted. */
  async delete(): Promise<{ count: number }> {
    if (this.state.empty) return { count: 0 };
    const { sql, params } = compileDelete(this.meta, this.state, this.backend);
    const { changes } = await this.backend.run(sql, params);
    return { count: changes };
  }

  /**
   * Compute aggregates over the whole (filtered) queryset (Django's `aggregate`).
   * Returns a single plain object keyed by the names you pass.
   *
   *   const { avgAge } = await Author.objects.aggregate({ avgAge: Avg("age") });
   */
  async aggregate(aggregates: Record<string, AggregateExpr>): Promise<Record<string, unknown>> {
    if (this.state.empty) return Object.fromEntries(Object.keys(aggregates).map((k) => [k, null]));
    const { sql, params } = compileAggregate(this.meta, this.state, aggregates, this.backend);
    const rows = await this.backend.execute(sql, params);
    return { ...rows[0] };
  }

  /**
   * Fetch rows keyed by a unique field into a Map (Django's `in_bulk`).
   * `inBulk([1, 3])` -> Map(1 -> obj, 3 -> obj); no ids = the whole queryset.
   */
  async inBulk(ids?: unknown[], opts: { field?: string } = {}): Promise<Map<unknown, T>> {
    const field = opts.field ?? "pk";
    const attname = field === "pk" ? this.meta.pk.attname : field;
    const qs = ids !== undefined ? this.filter({ [`${field}__in`]: ids }) : this;
    const rows = await qs.fetch();
    const out = new Map<unknown, T>();
    for (const r of rows) out.set((r as Record<string, unknown>)[attname], r);
    return out;
  }

  /** Async-iterate the results (Django's `iterator()`). */
  async *iterator(): AsyncIterableIterator<T> {
    for (const row of await this.fetch()) yield row;
  }

  /** The database's query plan for this queryset (Django's `explain()`). */
  async explain(): Promise<string> {
    const { sql, params } = compileSelect(this.meta, this.state, this.backend);
    const rows = await this.backend.execute(this.backend.sqlExplain(sql), params);
    return rows.map((r) => String(r.detail ?? Object.values(r).join(" | "))).join("\n");
  }

  /**
   * Persist the listed fields of already-modified instances in one transaction
   * (Django's `bulk_update`). Returns the number of rows updated.
   */
  async bulkUpdate(objs: T[], fieldNames: string[]): Promise<number> {
    if (fieldNames.length === 0)
      throw new FieldError("bulkUpdate() requires at least one field name.");
    if (objs.length === 0) return 0;
    const q = (s: string) => this.backend.quoteName(s);
    const fields = fieldNames.map((name) => {
      const f = this.meta.fields.get(name) ?? this.meta.fieldList.find((x) => x.attname === name);
      if (!f)
        throw new FieldError(`Unknown field "${name}" in bulkUpdate() on ${this.meta.modelName}.`);
      return f;
    });
    const setSql = fields.map((f) => `${q(f.column)} = ?`).join(", ");
    const sql = `UPDATE ${q(this.meta.dbTable)} SET ${setSql} WHERE ${q(this.meta.pk.column)} = ?`;
    let count = 0;
    await atomicOn(this.backend, async () => {
      for (const obj of objs) {
        const bag = obj as Record<string, unknown>;
        const params = fields.map((f) => f.toDb(bag[f.attname]));
        params.push(this.meta.pk.toDb((obj as unknown as ModelInstance).pk));
        const { changes } = await this.backend.run(sql, params);
        count += changes;
      }
    });
    return count;
  }

  /** Materialize all rows (Django's `list(qs)`; same as `await qs`). */
  async toArray(): Promise<T[]> {
    return this.fetch();
  }
}

/* ----------------------------------------------------------------------------
 * Set-operation querysets — the result of union()/intersection()/difference().
 *
 * Wraps each arm as `SELECT * FROM (arm)` so inner ORDER BY/LIMIT stay legal,
 * joins them with the operator, and supports ordering by attribute name (the
 * arms alias every column to its attname), slicing, and evaluation. Further
 * filtering is not supported (matches Django's restrictions after a combinator).
 * ------------------------------------------------------------------------- */

export class CombinedQuerySet<T = ModelInstance> implements PromiseLike<T[]>, AsyncIterable<T> {
  readonly model: ModelClass;
  private readonly parts: Array<{ sql: string; params: SqlValue[] }>;
  private readonly op: "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT";
  private readonly order: OrderBy[];
  private readonly limitN: number | null;
  private readonly offsetN: number;

  constructor(
    model: ModelClass,
    parts: Array<{ sql: string; params: SqlValue[] }>,
    op: "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT",
    order: OrderBy[] = [],
    limitN: number | null = null,
    offsetN = 0,
  ) {
    this.model = model;
    this.parts = parts;
    this.op = op;
    this.order = order;
    this.limitN = limitN;
    this.offsetN = offsetN;
  }

  private get backend(): Backend {
    return this.model._backend();
  }

  /** Order by attribute names of the combined rows (`"-name"` for descending). */
  orderBy(...fields: string[]): CombinedQuerySet<T> {
    const order = fields.map((t) =>
      t.startsWith("-") ? { field: t.slice(1), desc: true } : { field: t, desc: false },
    );
    return new CombinedQuerySet<T>(
      this.model,
      this.parts,
      this.op,
      order,
      this.limitN,
      this.offsetN,
    );
  }

  slice(start: number, end?: number): CombinedQuerySet<T> {
    const offset = this.offsetN + start;
    const limit = end !== undefined ? Math.max(0, end - start) : this.limitN;
    return new CombinedQuerySet<T>(this.model, this.parts, this.op, this.order, limit, offset);
  }
  limit(n: number): CombinedQuerySet<T> {
    return this.slice(0, n);
  }

  private compiled(): { sql: string; params: SqlValue[] } {
    const q = (s: string) => this.backend.quoteName(s);
    // Derived tables need aliases on Postgres/MySQL (harmless on SQLite).
    let sql = this.parts
      .map((p, i) => `SELECT * FROM (${p.sql}) ${q(`U${i}`)}`)
      .join(` ${this.op} `);
    const params: SqlValue[] = this.parts.flatMap((p) => p.params);
    if (this.order.length > 0) {
      sql +=
        " ORDER BY " + this.order.map((o) => `${q(o.field)} ${o.desc ? "DESC" : "ASC"}`).join(", ");
    }
    if (this.limitN !== null) {
      sql += " LIMIT ?";
      params.push(this.limitN);
    } else if (this.offsetN > 0) {
      sql += " LIMIT -1";
    }
    if (this.offsetN > 0) {
      sql += " OFFSET ?";
      params.push(this.offsetN);
    }
    return { sql, params };
  }

  private async fetch(): Promise<T[]> {
    const { sql, params } = this.compiled();
    const rows = await this.backend.execute(sql, params);
    return rows.map((r) => this.model._fromDbRow(r)) as T[];
  }

  then<R1 = T[], R2 = never>(
    onFulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.fetch().then(onFulfilled, onRejected);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (const row of await this.fetch()) yield row;
  }

  async toArray(): Promise<T[]> {
    return this.fetch();
  }

  async count(): Promise<number> {
    const { sql, params } = this.compiled();
    const rows = await this.backend.execute(
      `SELECT COUNT(*) AS n FROM (${sql}) ${this.backend.quoteName("UC")}`,
      params,
    );
    return Number((rows[0] as { n: number }).n);
  }

  async exists(): Promise<boolean> {
    return (await this.count()) > 0;
  }

  async first(): Promise<T | null> {
    const rows = await this.slice(0, 1).fetch();
    return rows.length > 0 ? rows[0]! : null;
  }
}
