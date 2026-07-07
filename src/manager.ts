/**
 * Manager — the entry point to a model's querysets (Django's `objects`).
 *
 * A manager is a thin facade over a fresh `QuerySet`: most methods just delegate
 * so `Author.objects.filter(...)` reads like `Author.objects.all().filter(...)`.
 * It owns the row-producing helpers that aren't queryset transforms — `create`,
 * `getOrCreate` — and is the seam where `RelatedManager`/`ManyRelatedManager`
 * hook in for reverse and M2M relations.
 */
import { QuerySet } from "./queryset.ts";
import type { ModelClass, ModelInstance } from "./types.ts";
import type { QExpr, AnnotationExpr, AggregateExpr } from "./expressions.ts";
import type { FilterObject } from "./query/lookups.ts";
import type { ForeignKey, ManyToManyField } from "./fields.ts";
import type { SqlValue } from "./query/ast.ts";
import { FieldError } from "./errors.ts";
import { signals } from "./signals.ts";

type Filterish = QExpr | FilterObject;

export class Manager<T extends ModelInstance = ModelInstance> {
  protected readonly model: ModelClass;
  constructor(model: ModelClass) {
    this.model = model;
  }

  /** A fresh, unfiltered queryset bound to this model. */
  getQuerySet(): QuerySet<T> {
    return new QuerySet<T>(this.model);
  }

  all(): QuerySet<T> {
    return this.getQuerySet();
  }
  filter(arg: Filterish): QuerySet<T> {
    return this.getQuerySet().filter(arg);
  }
  exclude(arg: Filterish): QuerySet<T> {
    return this.getQuerySet().exclude(arg);
  }
  orderBy(...fields: string[]): QuerySet<T> {
    return this.getQuerySet().orderBy(...fields);
  }
  distinct(flag = true): QuerySet<T> {
    return this.getQuerySet().distinct(flag);
  }
  none(): QuerySet<T> {
    return this.getQuerySet().none();
  }
  values(...fieldNames: string[]): QuerySet<Record<string, unknown>> {
    return this.getQuerySet().values(...fieldNames);
  }
  valuesList(fieldNames: string[], opts?: { flat?: boolean }): QuerySet<unknown[] | unknown> {
    return this.getQuerySet().valuesList(fieldNames, opts);
  }
  slice(start: number, end?: number): QuerySet<T> {
    return this.getQuerySet().slice(start, end);
  }
  limit(n: number): QuerySet<T> {
    return this.getQuerySet().limit(n);
  }
  selectRelated(...paths: string[]): QuerySet<T> {
    return this.getQuerySet().selectRelated(...paths);
  }
  prefetchRelated(...names: string[]): QuerySet<T> {
    return this.getQuerySet().prefetchRelated(...names);
  }
  annotate(annotations: Record<string, AnnotationExpr>): QuerySet<T> {
    return this.getQuerySet().annotate(annotations);
  }
  aggregate(aggregates: Record<string, AggregateExpr>): Promise<Record<string, unknown>> {
    return this.getQuerySet().aggregate(aggregates);
  }
  only(...fieldNames: string[]): QuerySet<T> {
    return this.getQuerySet().only(...fieldNames);
  }
  defer(...fieldNames: string[]): QuerySet<T> {
    return this.getQuerySet().defer(...fieldNames);
  }
  selectForUpdate(): QuerySet<T> {
    return this.getQuerySet().selectForUpdate();
  }
  using(alias: string): QuerySet<T> {
    return this.getQuerySet().using(alias);
  }
  inBulk(ids?: unknown[], opts?: { field?: string }): Promise<Map<unknown, T>> {
    return this.getQuerySet().inBulk(ids, opts);
  }
  iterator(): AsyncIterableIterator<T> {
    return this.getQuerySet().iterator();
  }
  explain(): Promise<string> {
    return this.getQuerySet().explain();
  }
  bulkUpdate(objs: T[], fieldNames: string[]): Promise<number> {
    return this.getQuerySet().bulkUpdate(objs, fieldNames);
  }

  get(arg?: Filterish): Promise<T> {
    return this.getQuerySet().get(arg);
  }
  first(): Promise<T | null> {
    return this.getQuerySet().first();
  }
  last(): Promise<T | null> {
    return this.getQuerySet().last();
  }
  count(): Promise<number> {
    return this.getQuerySet().count();
  }
  exists(): Promise<boolean> {
    return this.getQuerySet().exists();
  }

  /** Build, save, and return a new instance (Django's `Model.objects.create`). */
  async create(data: Record<string, unknown> = {}): Promise<T> {
    const instance = new this.model(data) as T;
    await instance.save();
    return instance;
  }

  /**
   * Look up by `lookup`; if absent, create using `lookup` merged with `defaults`.
   * Returns `[instance, created]`, mirroring Django's `get_or_create`.
   */
  async getOrCreate(
    lookup: Record<string, unknown>,
    opts: { defaults?: Record<string, unknown> } = {},
  ): Promise<[T, boolean]> {
    try {
      return [await this.get(lookup), false];
    } catch (e) {
      if (e instanceof this.model.DoesNotExist) {
        return [await this.create({ ...lookup, ...(opts.defaults ?? {}) }), true];
      }
      throw e;
    }
  }

  /**
   * Look up by `lookup`; create or update so the row matches `defaults`.
   * Returns `[instance, created]`, mirroring Django's `update_or_create`.
   */
  async updateOrCreate(
    lookup: Record<string, unknown>,
    opts: { defaults?: Record<string, unknown> } = {},
  ): Promise<[T, boolean]> {
    const defaults = opts.defaults ?? {};
    try {
      const obj = await this.get(lookup);
      Object.assign(obj, defaults);
      await obj.save();
      return [obj, false];
    } catch (e) {
      if (e instanceof this.model.DoesNotExist) {
        return [await this.create({ ...lookup, ...defaults }), true];
      }
      throw e;
    }
  }

  /** Insert many rows. Returns the created instances (PKs populated per row). */
  async bulkCreate(rows: Array<Record<string, unknown>>): Promise<T[]> {
    const out: T[] = [];
    for (const data of rows) out.push(await this.create(data));
    return out;
  }
}

/**
 * The manager returned by a reverse relation accessor — `author.books` (design 6.1).
 * Every queryset it produces is pre-filtered to the owning instance, and `create`/
 * `add`/`set`/`remove`/`clear` maintain the foreign key for you.
 */
export class RelatedManager<T extends ModelInstance = ModelInstance> extends Manager<T> {
  protected readonly fkField: ForeignKey;
  protected readonly owner: ModelInstance;
  protected readonly accessorName: string;

  constructor(model: ModelClass, fkField: ForeignKey, owner: ModelInstance, accessorName: string) {
    super(model);
    this.fkField = fkField;
    this.owner = owner;
    this.accessorName = accessorName;
  }

  override getQuerySet(): QuerySet<T> {
    return super.getQuerySet().filter({ [this.fkField.attname]: this.owner.pk }) as QuerySet<T>;
  }

  /** Like `all()`, but returns the prefetched cache when one is present. */
  override all(): QuerySet<T> {
    const cache = (this.owner as Record<string, unknown>)[`__prefetch_${this.accessorName}`] as
      T[] | undefined;
    const qs = this.getQuerySet();
    return cache ? qs.withCache(cache) : qs;
  }

  override async create(data: Record<string, unknown> = {}): Promise<T> {
    return super.create({ ...data, [this.fkField.name]: this.owner });
  }

  /** Attach existing instances by pointing their FK at the owner. */
  async add(...objs: ModelInstance[]): Promise<void> {
    for (const o of objs) {
      (o as Record<string, unknown>)[this.fkField.name] = this.owner;
      await o.save({ updateFields: [this.fkField.name] });
    }
  }

  /** Detach instances by nulling their FK (requires a nullable FK). */
  async remove(...objs: ModelInstance[]): Promise<void> {
    this.assertNullable("remove");
    for (const o of objs) {
      (o as Record<string, unknown>)[this.fkField.attname] = null;
      await o.save({ updateFields: [this.fkField.name] });
    }
  }

  /** Detach all currently-related instances (requires a nullable FK). */
  async clear(): Promise<void> {
    this.assertNullable("clear");
    await this.getQuerySet().update({ [this.fkField.attname]: null });
  }

  /** Replace the related set with exactly `objs`. */
  async set(objs: ModelInstance[]): Promise<void> {
    await this.clear();
    await this.add(...objs);
  }

  private assertNullable(op: string): void {
    if (!this.fkField.nullable) {
      throw new FieldError(
        `Cannot ${op}() on ${this.fkField.modelName}.${this.fkField.name}: the foreign key is not nullable.`,
      );
    }
  }
}

/**
 * How a ManyRelatedManager reads/writes the through-table. For the forward
 * accessor (`post.tags`) `ownerCol` is the declaring side; for the reverse
 * accessor (`tag.posts`) the columns swap roles.
 */
export interface M2MBinding {
  table: string;
  /** Through column matching the accessor's owner instance. */
  ownerCol: string;
  /** Through column pointing at the rows this manager yields. */
  targetCol: string;
  field: ManyToManyField;
}

/**
 * Manager returned by an M2M accessor — `post.tags` / `tag.posts` (design 6.2).
 * Querysets are scoped through the through-table; `add`/`remove`/`set`/`clear`
 * mutate it and fire the `m2mChanged` signal.
 */
export class ManyRelatedManager<T extends ModelInstance = ModelInstance> extends Manager<T> {
  private readonly binding: M2MBinding;
  private readonly owner: ModelInstance;
  private readonly accessorName: string;

  constructor(model: ModelClass, binding: M2MBinding, owner: ModelInstance, accessorName: string) {
    super(model);
    this.binding = binding;
    this.owner = owner;
    this.accessorName = accessorName;
  }

  private get backend() {
    return this.model._backend();
  }

  private ownerPk(): SqlValue {
    const pk = this.owner.pk;
    if (pk === null || pk === undefined) {
      throw new FieldError(
        `Cannot use the "${this.accessorName}" relation on an unsaved instance.`,
      );
    }
    return pk as SqlValue;
  }

  override getQuerySet(): QuerySet<T> {
    const q = (s: string) => this.backend.quoteName(s);
    const b = this.binding;
    return super.getQuerySet()._filterCondition({
      kind: "insub",
      path: ["pk"],
      sql: `SELECT ${q(b.targetCol)} FROM ${q(b.table)} WHERE ${q(b.ownerCol)} = ?`,
      params: [this.ownerPk()],
    });
  }

  /** Like `all()`, but returns the prefetched cache when one is present. */
  override all(): QuerySet<T> {
    const cache = (this.owner as Record<string, unknown>)[`__prefetch_${this.accessorName}`] as
      T[] | undefined;
    const qs = this.getQuerySet();
    return cache ? qs.withCache(cache) : qs;
  }

  private pkOf(obj: ModelInstance | number | string): SqlValue {
    if (typeof obj === "object") return obj.pk as SqlValue;
    return obj;
  }

  /** Link the given instances (or pks). Duplicates are ignored, like Django. */
  async add(...objs: Array<ModelInstance | number | string>): Promise<void> {
    const b = this.binding;
    const owner = this.ownerPk();
    const pks = objs.map((o) => this.pkOf(o));
    const sql = this.backend.sqlInsertIgnore(b.table, [b.ownerCol, b.targetCol]);
    for (const pk of pks) {
      await this.backend.run(sql, [owner, pk]);
    }
    await signals.m2mChanged.send(this.model, { instance: this.owner, action: "add", pks });
  }

  /** Unlink the given instances (or pks). Rows in the through-table are deleted. */
  async remove(...objs: Array<ModelInstance | number | string>): Promise<void> {
    if (objs.length === 0) return;
    const q = (s: string) => this.backend.quoteName(s);
    const b = this.binding;
    const pks = objs.map((o) => this.pkOf(o));
    await this.backend.run(
      `DELETE FROM ${q(b.table)} WHERE ${q(b.ownerCol)} = ? AND ${q(b.targetCol)} IN (${pks.map(() => "?").join(", ")})`,
      [this.ownerPk(), ...pks],
    );
    await signals.m2mChanged.send(this.model, { instance: this.owner, action: "remove", pks });
  }

  /** Unlink everything. */
  async clear(): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    const b = this.binding;
    await this.backend.run(`DELETE FROM ${q(b.table)} WHERE ${q(b.ownerCol)} = ?`, [
      this.ownerPk(),
    ]);
    await signals.m2mChanged.send(this.model, { instance: this.owner, action: "clear", pks: [] });
  }

  /** Replace the related set with exactly `objs` (fires "clear" then "add"). */
  async set(objs: Array<ModelInstance | number | string>): Promise<void> {
    await this.clear();
    if (objs.length > 0) await this.add(...objs);
  }

  /** Create a target instance and link it. */
  override async create(data: Record<string, unknown> = {}): Promise<T> {
    const obj = await super.create(data);
    await this.add(obj);
    return obj;
  }
}
