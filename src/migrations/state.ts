/**
 * Migration project state (design §10.3).
 *
 * A `ProjectState` is the serialized shape of every model at a point in the
 * migration history. `makemigrations` replays all migration files into a state,
 * builds a second state from the live registry, and diffs the two. The executor
 * also synthesizes runnable `ModelMeta`s ("historical models") from a state so
 * DDL is generated against what the schema looked like *then*, not now.
 */
import {
  Field,
  ManyToManyField,
  deserializeField,
  type SerializedField,
} from "../fields.ts";
import type { ModelClass, ModelMeta } from "../types.ts";
import { FieldError } from "../errors.ts";

export interface ModelState {
  name: string;
  dbTable: string;
  ordering: string[];
  /** Field name -> serialized def, in declaration order. */
  fields: Array<[string, SerializedField]>;
}

export class ProjectState {
  readonly models = new Map<string, ModelState>();

  clone(): ProjectState {
    const next = new ProjectState();
    for (const [name, m] of this.models) {
      next.models.set(name, {
        name: m.name,
        dbTable: m.dbTable,
        ordering: [...m.ordering],
        fields: m.fields.map(([n, def]) => [n, structuredClone(def)]),
      });
    }
    return next;
  }

  getModel(name: string): ModelState {
    const m = this.models.get(name);
    if (!m) {
      throw new FieldError(
        `Migration state has no model "${name}". Known: ${[...this.models.keys()].join(", ") || "(none)"}.`,
      );
    }
    return m;
  }

  /** Snapshot the live registry (the "current models" side of the diff). */
  static fromModels(models: ModelClass[]): ProjectState {
    const state = new ProjectState();
    for (const model of models) {
      state.models.set(model.modelName, {
        name: model.modelName,
        dbTable: model.meta.dbTable,
        ordering: [...model.meta.ordering],
        fields: model.meta.fieldList.map((f) => [f.name, f.serialize()]),
      });
    }
    return state;
  }
}

/* ----------------------------------------------------------------------------
 * Historical models: synthesize ModelMeta (+ lightweight fake classes for
 * relation thunks) from a ProjectState, so the schema editor can run against
 * past schema shapes without the live registry.
 * ------------------------------------------------------------------------- */

interface FakeModelClass {
  modelName: string;
  meta: ModelMeta;
  prototype: object;
}

export class StateApps {
  private readonly state: ProjectState;
  private readonly cache = new Map<string, FakeModelClass>();

  constructor(state: ProjectState) {
    this.state = state;
  }

  /** The synthesized meta for a state model (cached; cycles are safe). */
  metaFor(name: string): ModelMeta {
    return this.classFor(name).meta;
  }

  private classFor(name: string): FakeModelClass {
    let fake = this.cache.get(name);
    if (fake) return fake;
    const ms = this.state.getModel(name);

    // Seed the cache before building fields so circular FKs resolve.
    fake = { modelName: name, meta: undefined as unknown as ModelMeta, prototype: {} };
    this.cache.set(name, fake);

    const resolve = (n: string): ModelClass => this.classFor(n) as unknown as ModelClass;
    const fieldsMap = new Map<string, Field>();
    const fieldList: Field[] = [];
    let pk: Field | undefined;
    for (const [fname, def] of ms.fields) {
      const field = deserializeField(def, resolve);
      field.bind(fname, name);
      if (field instanceof ManyToManyField) field.ownerDbTable = ms.dbTable;
      fieldsMap.set(fname, field);
      fieldList.push(field);
      if (field.primaryKey) pk = field;
    }
    if (!pk) throw new FieldError(`State model "${name}" has no primary key field.`);

    fake.meta = {
      modelName: name,
      dbTable: ms.dbTable,
      fields: fieldsMap,
      fieldList,
      pk,
      ordering: [...ms.ordering],
      connectionAlias: "default",
    };
    return fake;
  }
}
