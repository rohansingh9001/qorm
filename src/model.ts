/**
 * The Model layer: the base `Model` class, instance lifecycle (save/delete/
 * refresh), and the registration that wires fields, the `objects` manager, and
 * the per-model exception classes onto a model.
 *
 * Django uses a metaclass to do this implicitly; JS has none, so registration is
 * explicit via `defineModel(...)` (preferred — best inference) or `Model.register()`
 * for the static-property class style (design 4.2/4.4). Both build the same
 * internal `ModelMeta`.
 *
 * The static field declaration is only a *descriptor*; instance values live as
 * own properties on the instance, with original-value snapshots (for dirty
 * tracking) kept in a side WeakMap so they never pollute enumeration.
 */
import type { ModelClass, ModelInstance, ModelMeta } from "./types.ts";
import type { Backend } from "./backends/base.ts";
import {
  Field,
  ForeignKey,
  ManyToManyField,
  BigAutoField,
  DateField,
  DateTimeField,
  isField,
} from "./fields.ts";
import type {
  AutoField,
  BooleanField,
  CharField,
  TextField,
  UUIDField,
  DecimalField,
  FloatField,
  BigIntegerField,
  IntegerField,
  JSONField,
} from "./fields.ts";
import { Manager, RelatedManager, ManyRelatedManager } from "./manager.ts";
import { QuerySet } from "./queryset.ts";
import { registerModel, allModels } from "./registry.ts";
import { getConnection } from "./connection.ts";
import { DoesNotExist, MultipleObjectsReturned, FieldError, NotSupportedError } from "./errors.ts";
import { expandRelationPaths, relatedColumnAlias } from "./query/compiler.ts";
import { registerReverseRelation, getReverseRelation } from "./relations.ts";
import { signals } from "./signals.ts";

/* ----------------------------------------------------------------------------
 * Per-instance state (dirty tracking), kept off the instance itself.
 * ------------------------------------------------------------------------- */

interface InstanceState {
  isNew: boolean;
  /** Snapshot of attribute values as last loaded/saved, keyed by attname. */
  original: Record<string, unknown>;
}

const STATE = new WeakMap<object, InstanceState>();

function snapshot(instance: ModelInstance, meta: ModelMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of meta.fieldList) {
    if (f.concrete) out[f.attname] = (instance as Record<string, unknown>)[f.attname];
  }
  return out;
}

function equalish(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) return false;
  if (a && b && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** Apply `auto_now` / `auto_now_add` on save (design 7). */
function applyAutoNow(f: Field, instance: ModelInstance, creating: boolean): void {
  if (f instanceof DateField || f instanceof DateTimeField) {
    if ((creating && (f.autoNowAdd || f.autoNow)) || (!creating && f.autoNow)) {
      (instance as Record<string, unknown>)[f.attname] = new Date();
    }
  }
}

/* ----------------------------------------------------------------------------
 * Forward relation descriptor (FK / O2O): `await book.author.get()` (design 6.1).
 * ------------------------------------------------------------------------- */

class ForwardRelation {
  private readonly instance: ModelInstance;
  private readonly field: ForeignKey;
  constructor(instance: ModelInstance, field: ForeignKey) {
    this.instance = instance;
    this.field = field;
  }

  /** Fetch the related instance (or null). Uses the cache populated by a setter. */
  async get(): Promise<ModelInstance | null> {
    const bag = this.instance as Record<string, unknown>;
    const fkValue = bag[this.field.attname];
    if (fkValue === null || fkValue === undefined) return null;
    const cached = bag[`__rel_${this.field.name}`] as ModelInstance | undefined;
    if (cached && cached.pk === fkValue) return cached;
    const related = this.field.getRelatedModel();
    const obj = await related.objects.get({ pk: fkValue });
    bag[`__rel_${this.field.name}`] = obj;
    return obj;
  }

  /** The raw foreign-key value without a query. */
  get id(): unknown {
    return (this.instance as Record<string, unknown>)[this.field.attname];
  }

  /** The related instance if already loaded (e.g. via selectRelated), else undefined. */
  get cached(): ModelInstance | null | undefined {
    return (this.instance as Record<string, unknown>)[`__rel_${this.field.name}`] as
      ModelInstance | null | undefined;
  }
}

function defineForwardRelation(proto: object, field: ForeignKey): void {
  Object.defineProperty(proto, field.name, {
    configurable: true,
    enumerable: false,
    get(this: ModelInstance) {
      return new ForwardRelation(this, field);
    },
    set(this: ModelInstance, value: unknown) {
      const bag = this as Record<string, unknown>;
      if (value !== null && value !== undefined && typeof value === "object" && "pk" in value) {
        bag[field.attname] = (value as { pk: unknown }).pk;
        bag[`__rel_${field.name}`] = value;
      } else {
        bag[field.attname] = value;
        delete bag[`__rel_${field.name}`];
      }
    },
  });
}

/* ----------------------------------------------------------------------------
 * Reverse relations: `author.books` (design 6.1). FK targets are lazy thunks, so
 * we (re)run resolution after every registration; try/catch skips not-yet-defined
 * targets, and the second of two mutually-referencing models wires up both sides.
 * ------------------------------------------------------------------------- */

const installedAccessors = new Set<string>();

/** Reverse accessor name: explicit `relatedName`, else `<sourcemodel>Set` (Django's `_set`). */
function reverseAccessorName(fk: ForeignKey, sourceModelName: string): string {
  return fk.relatedName ?? `${sourceModelName.toLowerCase()}Set`;
}

function resolveRelations(): void {
  for (const model of allModels()) {
    for (const f of model.meta.fieldList) {
      if (!(f instanceof ForeignKey) && !(f instanceof ManyToManyField)) continue;
      let target: ModelClass;
      try {
        target = f.getRelatedModel();
      } catch {
        continue; // target not registered yet; a later registration will pick it up
      }
      const accessor =
        f instanceof ForeignKey
          ? reverseAccessorName(f, model.modelName)
          : (f.relatedName ?? `${model.modelName.toLowerCase()}Set`);
      const key = `${target.modelName}.${accessor}`;
      if (installedAccessors.has(key)) continue;

      if (target.meta.fields.has(accessor)) {
        throw new FieldError(
          `Reverse accessor ${target.modelName}.${accessor} (from ${model.modelName}.${f.name}) ` +
            `clashes with a field of the same name. Set a different relatedName.`,
        );
      }

      if (f instanceof ForeignKey) {
        registerReverseRelation(target.modelName, {
          kind: "fk",
          sourceModel: model,
          field: f,
          accessorName: accessor,
        });
        Object.defineProperty(target.prototype, accessor, {
          configurable: true,
          enumerable: false,
          get(this: ModelInstance) {
            return new RelatedManager(model, f, this, accessor);
          },
        });
      } else {
        const m2m = f;
        registerReverseRelation(target.modelName, {
          kind: "m2m",
          sourceModel: model,
          field: m2m,
          accessorName: accessor,
        });
        Object.defineProperty(target.prototype, accessor, {
          configurable: true,
          enumerable: false,
          get(this: ModelInstance) {
            // Reverse side: match on the target column, yield rows from the owner column.
            return new ManyRelatedManager(
              model,
              {
                table: m2m.throughTable(),
                ownerCol: m2m.targetColumn(),
                targetCol: m2m.ownerColumn(),
                field: m2m,
              },
              this,
              accessor,
            );
          },
        });
      }
      installedAccessors.add(key);
    }
  }
}

/**
 * Batch-load one M2M relation for a set of instances: one query over the
 * through-table, one over the far model, then an in-memory group-by.
 */
async function prefetchM2M(
  ctor: ModelClass,
  instances: ModelInstance[],
  pks: unknown[],
  name: string,
  spec: { model: ModelClass; table: string; matchCol: string; farCol: string },
): Promise<void> {
  const backend = ctor._backend();
  const q = (s: string) => backend.quoteName(s);
  let pairs: Array<{ owner: unknown; far: unknown }> = [];
  if (pks.length > 0) {
    const rows = await backend.execute(
      `SELECT ${q(spec.matchCol)} AS owner, ${q(spec.farCol)} AS far FROM ${q(spec.table)} ` +
        `WHERE ${q(spec.matchCol)} IN (${pks.map(() => "?").join(", ")})`,
      pks as never,
    );
    pairs = rows as Array<{ owner: unknown; far: unknown }>;
  }
  const farIds = [...new Set(pairs.map((p) => p.far))];
  const farById = new Map<unknown, ModelInstance>();
  if (farIds.length > 0) {
    for (const obj of await spec.model.objects.filter({ pk__in: farIds })) {
      farById.set(obj.pk, obj);
    }
  }
  const groups = new Map<unknown, ModelInstance[]>();
  for (const p of pairs) {
    const far = farById.get(p.far);
    if (!far) continue;
    const bucket = groups.get(p.owner);
    if (bucket) bucket.push(far);
    else groups.set(p.owner, [far]);
  }
  for (const inst of instances) {
    (inst as Record<string, unknown>)[`__prefetch_${name}`] = groups.get(inst.pk) ?? [];
  }
}

/** Install the forward M2M accessor (`post.tags`) on the owning model's prototype. */
function defineM2MRelation(proto: object, field: ManyToManyField): void {
  Object.defineProperty(proto, field.name, {
    configurable: true,
    enumerable: false,
    get(this: ModelInstance) {
      return new ManyRelatedManager(
        field.getRelatedModel(),
        {
          table: field.throughTable(),
          ownerCol: field.ownerColumn(),
          targetCol: field.targetColumn(),
          field,
        },
        this,
        field.name,
      );
    },
  });
}

/** Build an instance from row columns aliased under `prefixSegs`; null if the PK column is null. */
function hydratePlain(
  modelClass: ModelClass,
  row: Record<string, unknown>,
  prefixSegs: string[],
): ModelInstance | null {
  const meta = modelClass.meta;
  const pkVal = row[relatedColumnAlias(prefixSegs, meta.pk.attname)];
  if (pkVal === null || pkVal === undefined) return null; // LEFT JOIN with no match
  const instance = Object.create(modelClass.prototype) as ModelInstance;
  const bag = instance as unknown as Record<string, unknown>;
  for (const f of meta.fieldList) {
    if (!f.concrete) continue;
    bag[f.attname] = f.fromDb(row[relatedColumnAlias(prefixSegs, f.attname)]);
  }
  STATE.set(instance, { isNew: false, original: snapshot(instance, meta) });
  return instance;
}

/** Attach the selectRelated instance for one (already-prefix-expanded) path. */
function attachRelated(
  root: ModelInstance,
  rootCtor: ModelClass,
  path: string[],
  row: Record<string, unknown>,
): void {
  let parentInst: ModelInstance | null = root;
  let parentMeta = rootCtor.meta;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    const fk = parentMeta.fields.get(seg) as ForeignKey;
    parentInst = parentInst
      ? (((parentInst as Record<string, unknown>)[`__rel_${seg}`] as ModelInstance | null) ?? null)
      : null;
    parentMeta = fk.getRelatedModel().meta;
    if (!parentInst) return; // an intermediate relation was null; nothing deeper to attach
  }
  const leaf = path[path.length - 1]!;
  const fk = parentMeta.fields.get(leaf) as ForeignKey;
  (parentInst as Record<string, unknown>)[`__rel_${leaf}`] = hydratePlain(
    fk.getRelatedModel(),
    row,
    path,
  );
}

/* ----------------------------------------------------------------------------
 * Instance initialization
 * ------------------------------------------------------------------------- */

function initInstance(
  instance: ModelInstance,
  ctor: ModelClass,
  data: Record<string, unknown>,
): void {
  const meta = ctor.meta;
  const bag = instance as Record<string, unknown>;
  for (const f of meta.fieldList) {
    if (f.isM2M) {
      if (f.name in data) {
        throw new FieldError(
          `${meta.modelName}.${f.name} is a ManyToManyField; save the instance first, then use ` +
            `.${f.name}.add(...) / .set(...).`,
        );
      }
      continue; // no per-instance value; the prototype accessor handles it
    }
    if (f instanceof ForeignKey) {
      // The relation name (e.g. "author") routes through the prototype setter;
      // the attname (e.g. "authorId") sets the scalar directly.
      if (f.name in data) (instance as Record<string, unknown>)[f.name] = data[f.name];
      else if (f.attname in data) bag[f.attname] = data[f.attname];
      else if (f.hasDefault()) bag[f.attname] = f.getDefault();
      else bag[f.attname] = undefined;
    } else {
      const key = f.attname;
      if (key in data) bag[key] = data[key];
      else if (f.hasDefault()) bag[key] = f.getDefault();
      else bag[key] = f.isAuto ? undefined : f.nullable ? null : undefined;
    }
  }
  STATE.set(instance, { isNew: true, original: snapshot(instance, meta) });
}

/* ----------------------------------------------------------------------------
 * The base Model
 * ------------------------------------------------------------------------- */

export interface Meta {
  dbTable?: string;
  ordering?: string[];
  using?: string;
}

export interface RegisterOptions extends Meta {
  name?: string;
}

export class Model {
  constructor(data: Record<string, unknown> = {}) {
    const ctor = new.target as unknown as ModelClass;
    if (!ctor || !("meta" in ctor) || !ctor.meta) {
      throw new FieldError(
        `${new.target?.name ?? "Model"} is not registered. Call defineModel(...) or YourModel.register() first.`,
      );
    }
    initInstance(this as unknown as ModelInstance, ctor, data);
  }

  /** The primary-key value (Django's `instance.pk`). */
  get pk(): unknown {
    const meta = (this.constructor as unknown as ModelClass).meta;
    return (this as Record<string, unknown>)[meta.pk.attname];
  }
  set pk(value: unknown) {
    const meta = (this.constructor as unknown as ModelClass).meta;
    (this as Record<string, unknown>)[meta.pk.attname] = value;
  }

  /** INSERT a new row or UPDATE changed fields (dirty tracking); design 7. */
  async save(opts: { updateFields?: string[] } = {}): Promise<this> {
    const ctor = this.constructor as unknown as ModelClass;
    const meta = ctor.meta;
    const backend = ctor._backend();
    const q = (s: string) => backend.quoteName(s);
    const bag = this as unknown as Record<string, unknown>;
    const state = STATE.get(this) ?? { isNew: true, original: {} };
    const instance = this as unknown as ModelInstance;

    await signals.preSave.send(ctor, {
      instance,
      created: state.isNew,
      updateFields: opts.updateFields,
    });

    if (state.isNew) {
      const cols: string[] = [];
      const placeholders: string[] = [];
      const params: unknown[] = [];
      for (const f of meta.fieldList) {
        if (!f.concrete) continue;
        applyAutoNow(f, instance, true);
        if (f === meta.pk && f.isAuto) {
          const v = bag[f.attname];
          if (v === undefined || v === null) continue; // let the DB autogenerate
        }
        cols.push(q(f.column));
        placeholders.push("?");
        params.push(f.toDb(bag[f.attname]));
      }
      const sql =
        cols.length === 0
          ? backend.sqlEmptyInsert(meta.dbTable)
          : `INSERT INTO ${q(meta.dbTable)} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`;
      if (meta.pk.isAuto && (bag[meta.pk.attname] === undefined || bag[meta.pk.attname] === null)) {
        const res = await backend.runInsert(sql, params as never, meta.pk.column);
        bag[meta.pk.attname] = meta.pk.fromDb(res.insertedPk);
      } else {
        await backend.run(sql, params as never);
      }
    } else {
      const dirty: Field[] = [];
      const limit = opts.updateFields ? new Set(opts.updateFields) : null;
      for (const f of meta.fieldList) {
        if (f === meta.pk || !f.concrete) continue;
        applyAutoNow(f, instance, false);
        if (limit) {
          if (limit.has(f.name) || (f.isRelation && limit.has(f.attname))) dirty.push(f);
        } else if (!equalish(bag[f.attname], state.original[f.attname])) {
          dirty.push(f);
        }
      }
      if (dirty.length > 0) {
        const set = dirty.map((f) => `${q(f.column)} = ?`);
        const params: unknown[] = dirty.map((f) => f.toDb(bag[f.attname]));
        params.push(meta.pk.toDb(this.pk));
        const sql = `UPDATE ${q(meta.dbTable)} SET ${set.join(", ")} WHERE ${q(meta.pk.column)} = ?`;
        await backend.run(sql, params as never);
      }
    }

    const created = state.isNew;
    STATE.set(this, { isNew: false, original: snapshot(instance, meta) });
    await signals.postSave.send(ctor, { instance, created, updateFields: opts.updateFields });
    return this;
  }

  /** DELETE this row. Returns `{ count }` (rows removed). */
  async delete(): Promise<{ count: number }> {
    const ctor = this.constructor as unknown as ModelClass;
    const meta = ctor.meta;
    const backend = ctor._backend();
    if (this.pk === undefined || this.pk === null) {
      throw new FieldError(
        `Cannot delete a ${meta.modelName} that has no primary key (not saved).`,
      );
    }
    const instance = this as unknown as ModelInstance;
    await signals.preDelete.send(ctor, { instance });
    const sql = `DELETE FROM ${backend.quoteName(meta.dbTable)} WHERE ${backend.quoteName(meta.pk.column)} = ?`;
    const res = await backend.run(sql, [meta.pk.toDb(this.pk)] as never);
    STATE.set(this, { isNew: true, original: {} });
    await signals.postDelete.send(ctor, { instance });
    return { count: res.changes };
  }

  /** Reload all fields from the database (Django's `refresh_from_db`). */
  async refreshFromDb(): Promise<this> {
    const ctor = this.constructor as unknown as ModelClass;
    const meta = ctor.meta;
    const fresh = (await ctor.objects.get({ pk: this.pk })) as unknown as Record<string, unknown>;
    const bag = this as unknown as Record<string, unknown>;
    for (const f of meta.fieldList) bag[f.attname] = fresh[f.attname];
    STATE.set(this, { isNew: false, original: snapshot(this as unknown as ModelInstance, meta) });
    return this;
  }

  /** Run field validators and an optional `clean()` hook (Django's `full_clean`). */
  async fullClean(): Promise<void> {
    const ctor = this.constructor as unknown as ModelClass;
    const bag = this as unknown as Record<string, unknown>;
    // Like Django, non-editable fields (auto pk, auto_now/auto_now_add) are excluded.
    for (const f of ctor.meta.fieldList) {
      if (f.editable && f.concrete) f.validate(bag[f.attname]);
    }
    const clean = (this as unknown as { clean?: () => unknown }).clean;
    if (typeof clean === "function") await clean.call(this);
  }

  /** Hydrate an instance from a DB row (keyed by attname). Bypasses the constructor. */
  static _hydrate(ctor: ModelClass, row: Record<string, unknown>): ModelInstance {
    return hydratePlain(ctor, row, [])!;
  }

  /** Hydrate the root instance plus any selectRelated nested instances from a joined row. */
  static _hydrateRelated(
    ctor: ModelClass,
    row: Record<string, unknown>,
    paths: string[][],
  ): ModelInstance {
    const root = hydratePlain(ctor, row, [])!;
    for (const path of expandRelationPaths(paths)) attachRelated(root, ctor, path, row);
    return root;
  }

  /** Batch-load reverse / M2M relations onto already-fetched instances (prefetch; design 6.3). */
  static async _prefetchInto(
    ctor: ModelClass,
    instances: ModelInstance[],
    names: string[],
  ): Promise<void> {
    const pks = instances.map((i) => i.pk).filter((v) => v !== null && v !== undefined);
    for (const name of names) {
      // Forward M2M field (`post.tags`)?
      const ownField = ctor.meta.fields.get(name);
      if (ownField instanceof ManyToManyField) {
        await prefetchM2M(ctor, instances, pks, name, {
          model: ownField.getRelatedModel(),
          table: ownField.throughTable(),
          matchCol: ownField.ownerColumn(),
          farCol: ownField.targetColumn(),
        });
        continue;
      }
      const rel = getReverseRelation(ctor.modelName, name);
      if (!rel) {
        throw new NotSupportedError(
          `prefetchRelated("${name}") on ${ctor.modelName}: not a reverse relation or M2M field.`,
        );
      }
      if (rel.kind === "m2m") {
        // Reverse M2M (`tag.posts`): match through.targetCol, fetch the declaring side.
        await prefetchM2M(ctor, instances, pks, name, {
          model: rel.sourceModel,
          table: rel.field.throughTable(),
          matchCol: rel.field.targetColumn(),
          farCol: rel.field.ownerColumn(),
        });
        continue;
      }
      const children =
        pks.length > 0
          ? await rel.sourceModel.objects.filter({ [`${rel.field.attname}__in`]: pks })
          : [];

      const groups = new Map<unknown, ModelInstance[]>();
      for (const child of children) {
        const key = (child as Record<string, unknown>)[rel.field.attname];
        const bucket = groups.get(key);
        if (bucket) bucket.push(child);
        else groups.set(key, [child]);
      }
      for (const inst of instances) {
        (inst as Record<string, unknown>)[`__prefetch_${name}`] = groups.get(inst.pk) ?? [];
      }
    }
  }

  /**
   * Register a static-property model (design 4.2). Reads static `Field` props,
   * an optional static `meta`, and binds everything. Prefer `defineModel` when
   * you want strong instance typing.
   */
  static register(opts: RegisterOptions = {}): void {
    const ctor = this as unknown as ModelClass & Record<string, unknown>;
    const fieldDefs: Record<string, Field> = {};
    for (const key of Object.getOwnPropertyNames(ctor)) {
      const value = ctor[key];
      if (isField(value)) fieldDefs[key] = value;
    }
    const staticMeta = (ctor.meta as Meta | undefined) ?? {};
    const looksInternal = staticMeta && typeof staticMeta === "object" && "fields" in staticMeta;
    const metaSource: Meta = looksInternal ? {} : staticMeta;
    const name =
      opts.name ?? (ctor as { modelName?: string }).modelName ?? (this as { name?: string }).name;
    if (typeof name !== "string" || name.length === 0) {
      throw new FieldError(
        'register() could not infer a model name; pass register({ name: "..." }).',
      );
    }
    buildModel(ctor as unknown as ModelClass, name, fieldDefs, { ...metaSource, ...opts });
  }
}

/* ----------------------------------------------------------------------------
 * Registration core
 * ------------------------------------------------------------------------- */

function buildModel(
  ctor: ModelClass,
  modelName: string,
  fieldDefs: Record<string, Field>,
  metaOpts: Meta,
): void {
  const fieldsMap = new Map<string, Field>();
  const fieldList: Field[] = [];

  const entries = Object.entries(fieldDefs);
  let pk: Field | undefined = entries.map(([, f]) => f).find((f) => f.primaryKey);

  // Auto-add an `id` BigAutoField PK when none was declared (Django's default).
  if (!pk) {
    pk = new BigAutoField();
    pk.bind("id", modelName);
    fieldsMap.set("id", pk);
    fieldList.push(pk);
  }

  for (const [name, f] of entries) {
    if (fieldsMap.has(name)) throw new FieldError(`Duplicate field "${name}" on ${modelName}.`);
    f.bind(name, modelName);
    fieldsMap.set(name, f);
    fieldList.push(f);
  }

  const meta: ModelMeta = {
    modelName,
    dbTable: metaOpts.dbTable ?? modelName.toLowerCase(),
    fields: fieldsMap,
    fieldList,
    pk,
    ordering: metaOpts.ordering ?? [],
    connectionAlias: metaOpts.using ?? "default",
  };

  const target = ctor as unknown as Record<string, unknown>;
  target.modelName = modelName;
  target.meta = meta;
  target.DoesNotExist = class extends DoesNotExist {};
  target.MultipleObjectsReturned = class extends MultipleObjectsReturned {};
  target.objects = new Manager(ctor);
  target._backend = (): Backend => getConnection(meta.connectionAlias);
  target._fromDbRow = (row: Record<string, unknown>): ModelInstance => Model._hydrate(ctor, row);
  target._hydrateRelated = (row: Record<string, unknown>, paths: string[][]): ModelInstance =>
    Model._hydrateRelated(ctor, row, paths);
  target._prefetch = (instances: ModelInstance[], names: string[]): Promise<void> =>
    Model._prefetchInto(ctor, instances, names);
  target.getQuerySet = (): QuerySet => new QuerySet(ctor);

  for (const f of fieldList) {
    if (f instanceof ForeignKey) defineForwardRelation(ctor.prototype, f);
    if (f instanceof ManyToManyField) {
      if (f.through) {
        throw new NotSupportedError(
          `${modelName}.${f.name}: custom "through" models are not supported yet; ` +
            `remove the option to use the auto-generated through-table.`,
        );
      }
      f.ownerDbTable = meta.dbTable;
      defineM2MRelation(ctor.prototype, f);
    }
  }

  registerModel(ctor);
  // FK targets are lazy; (re)resolve reverse relations now that this model exists.
  resolveRelations();
  // A self-referential thunk (`() => Person` inside Person's own definition) is
  // still in its temporal dead zone during the synchronous pass above — retry on
  // a microtask, by which point the const is assigned. Errors here would have
  // already surfaced in the synchronous pass for any resolvable relation.
  void Promise.resolve().then(() => {
    try {
      resolveRelations();
    } catch {
      /* surfaced by the synchronous pass or `dorm check` */
    }
  });
}

/* ----------------------------------------------------------------------------
 * defineModel factory (design 4.4) — the preferred, best-typed entry point.
 * ------------------------------------------------------------------------- */

// Maps a field descriptor to the JS type of its instance value (design 11).
// Order matters: subclasses (EmailField<:CharField, BigAutoField<:AutoField) must
// be matched by their base where they share a value type.
type FieldValue<F extends Field> = F extends BooleanField
  ? boolean
  : F extends DateTimeField
    ? Date
    : F extends DateField
      ? string
      : F extends DecimalField
        ? string
        : F extends CharField
          ? string
          : F extends TextField
            ? string
            : F extends UUIDField
              ? string
              : F extends FloatField
                ? number
                : F extends BigIntegerField
                  ? number
                  : F extends IntegerField
                    ? number
                    : F extends AutoField
                      ? number
                      : F extends JSONField
                        ? unknown
                        : unknown;

/** Awaitable forward-relation descriptor (`await book.author.get()`; design 6.1). */
export interface ForwardRelationAccessor<R = ModelInstance> {
  get(): Promise<R | null>;
  readonly id: unknown;
}

/** Value-typed non-relation fields. */
type InferScalars<F extends Record<string, Field>> = {
  [K in keyof F as F[K] extends ForeignKey ? never : K]: FieldValue<F[K]>;
};
/** Forward relation accessors for FK/O2O fields. */
type InferRelations<F extends Record<string, Field>> = {
  [K in keyof F as F[K] extends ForeignKey ? K : never]: ForwardRelationAccessor;
};
/** The scalar `<name>Id` attribute that backs each FK/O2O field. */
type InferFkIds<F extends Record<string, Field>> = {
  [K in keyof F as F[K] extends ForeignKey ? `${K & string}Id` : never]: number;
};

/** Full inferred instance shape for a defined model. */
export type InferInstance<F extends Record<string, Field>> = Model &
  InferScalars<F> &
  InferRelations<F> &
  InferFkIds<F> &
  ModelInstance;

export interface DefinedModel<I extends ModelInstance> {
  new (data?: Record<string, unknown>): I;
  readonly modelName: string;
  readonly meta: ModelMeta;
  readonly objects: Manager<I>;
  readonly DoesNotExist: new (message?: string) => Error;
  readonly MultipleObjectsReturned: new (message?: string) => Error;
  _fromDbRow(row: Record<string, unknown>): I;
  _hydrateRelated(row: Record<string, unknown>, paths: string[][]): I;
  _prefetch(instances: ModelInstance[], names: string[]): Promise<void>;
  _backend(): Backend;
  getQuerySet(): QuerySet<I>;
}

/**
 * Define and register a model from a field map (design 4.4).
 *
 *   const Author = defineModel("Author", {
 *     name: fields.CharField({ maxLength: 100 }),
 *     email: fields.EmailField({ unique: true }),
 *   }, { ordering: ["name"], dbTable: "authors" });
 */
export function defineModel<F extends Record<string, Field>>(
  name: string,
  fieldDefs: F,
  metaOpts: Meta = {},
): DefinedModel<InferInstance<F>> {
  class Defined extends Model {}
  Object.defineProperty(Defined, "name", { value: name, configurable: true });
  buildModel(Defined as unknown as ModelClass, name, fieldDefs, metaOpts);
  return Defined as unknown as DefinedModel<InferInstance<F>>;
}
