/**
 * Migration operations (design 10.2) — `createModel`, `addField`, `alterField`,
 * `runSql`, `runJs`, … Each operation knows how to:
 *   - mutate a ProjectState        (`stateForwards`)
 *   - emit DDL/DML for a backend   (`databaseForwards`)
 *   - produce its inverse          (`inverse`, for `migrate <backward-target>`)
 *   - print itself                 (`describe`)
 *   - serialize itself to code     (`toCode`, used by the writer)
 *
 * Migration files receive this module's `ops` namespace, so they need no imports:
 *
 *   export default {
 *     dependencies: [],
 *     operations: (ops) => [
 *       ops.createModel("Author", { id: ops.fields.BigAutoField(), ... }, { dbTable: "authors" }),
 *     ],
 *   };
 */
import { Field, fields as fieldFactories, isField, type SerializedField } from "../fields.ts";
import type { Backend } from "../backends/base.ts";
import { ProjectState, StateApps, type ModelState } from "./state.ts";
import { FieldError, NotSupportedError } from "../errors.ts";

/** What `databaseForwards` runs against. `exec` respects sqlmigrate's collect mode. */
export interface OpContext {
  backend: Backend;
  exec(sql: string): Promise<void>;
  collecting: boolean;
}

export class IrreversibleError extends NotSupportedError {}

export interface Operation {
  readonly kind: string;
  describe(): string;
  stateForwards(state: ProjectState): void;
  databaseForwards(
    ctx: OpContext,
    stateBefore: ProjectState,
    stateAfter: ProjectState,
  ): Promise<void>;
  /** The operation that undoes this one, given the state before it ran. */
  inverse(stateBefore: ProjectState): Operation;
  /** Code for the migration writer. Throws for hand-written-only ops (runJs). */
  toCode(): string;
}

/* ----------------------------------------------------------------------------
 * Serialization helpers
 * ------------------------------------------------------------------------- */

function asSerialized(def: Field | SerializedField): SerializedField {
  return isField(def) ? def.serialize() : structuredClone(def);
}

/** Emit a JS object literal with unquoted identifier keys (option objects). */
function literal(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      return `${key}: ${literal(v)}`;
    });
    return `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(value);
}

function fieldCode(def: SerializedField): string {
  const opts = Object.keys(def.options).length > 0 ? literal(def.options) : "";
  if (def.to !== undefined) {
    return `ops.fields.${def.type}(${JSON.stringify(def.to)}${opts ? `, ${opts}` : ""})`;
  }
  // CharField/DecimalField factories require their options object.
  return `ops.fields.${def.type}(${opts})`;
}

/** Schema-affecting equality: two defs are "equal" if their serialized forms match. */
export function sameFieldDef(a: SerializedField, b: SerializedField): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ----------------------------------------------------------------------------
 * Model-level operations
 * ------------------------------------------------------------------------- */

export interface ModelOptions {
  dbTable?: string;
  ordering?: string[];
}

class CreateModel implements Operation {
  readonly kind = "createModel";
  readonly name: string;
  readonly fieldDefs: Array<[string, SerializedField]>;
  readonly options: ModelOptions;

  constructor(
    name: string,
    fieldDefs: Record<string, Field | SerializedField>,
    options: ModelOptions = {},
  ) {
    this.name = name;
    this.fieldDefs = Object.entries(fieldDefs).map(([n, d]) => [n, asSerialized(d)]);
    this.options = options;
  }

  describe(): string {
    return `Create model ${this.name}`;
  }

  stateForwards(state: ProjectState): void {
    if (state.models.has(this.name))
      throw new FieldError(`createModel: "${this.name}" already exists in state.`);
    state.models.set(this.name, {
      name: this.name,
      dbTable: this.options.dbTable ?? this.name.toLowerCase(),
      ordering: this.options.ordering ?? [],
      fields: this.fieldDefs.map(([n, d]) => [n, structuredClone(d)]),
    });
  }

  async databaseForwards(
    ctx: OpContext,
    _before: ProjectState,
    after: ProjectState,
  ): Promise<void> {
    const apps = new StateApps(after);
    await ctx.backend.schema.createTable(apps.metaFor(this.name));
  }

  inverse(): Operation {
    return new DeleteModel(this.name);
  }

  toCode(): string {
    const fieldsCode = this.fieldDefs.map(([n, d]) => `      ${n}: ${fieldCode(d)},`).join("\n");
    const opts = Object.keys(this.options).length > 0 ? `, ${literal(this.options)}` : "";
    return `ops.createModel(${JSON.stringify(this.name)}, {\n${fieldsCode}\n    }${opts})`;
  }
}

class DeleteModel implements Operation {
  readonly kind = "deleteModel";
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }

  describe(): string {
    return `Delete model ${this.name}`;
  }

  stateForwards(state: ProjectState): void {
    state.getModel(this.name);
    state.models.delete(this.name);
  }

  async databaseForwards(ctx: OpContext, before: ProjectState): Promise<void> {
    const apps = new StateApps(before);
    await ctx.backend.schema.dropTable(apps.metaFor(this.name));
  }

  inverse(stateBefore: ProjectState): Operation {
    const old = stateBefore.getModel(this.name);
    return new CreateModel(this.name, Object.fromEntries(old.fields), {
      dbTable: old.dbTable,
      ordering: old.ordering,
    });
  }

  toCode(): string {
    return `ops.deleteModel(${JSON.stringify(this.name)})`;
  }
}

class RenameModel implements Operation {
  readonly kind = "renameModel";
  readonly oldName: string;
  readonly newName: string;
  constructor(oldName: string, newName: string) {
    this.oldName = oldName;
    this.newName = newName;
  }

  describe(): string {
    return `Rename model ${this.oldName} -> ${this.newName}`;
  }

  stateForwards(state: ProjectState): void {
    const old = state.getModel(this.oldName);
    const derived = old.dbTable === this.oldName.toLowerCase();
    state.models.delete(this.oldName);
    state.models.set(this.newName, {
      ...old,
      name: this.newName,
      dbTable: derived ? this.newName.toLowerCase() : old.dbTable,
    });
    // Repoint relations that referenced the old name.
    for (const m of state.models.values()) {
      for (const [, def] of m.fields) {
        if (def.to === this.oldName) def.to = this.newName;
      }
    }
  }

  async databaseForwards(ctx: OpContext, before: ProjectState, after: ProjectState): Promise<void> {
    const oldTable = before.getModel(this.oldName).dbTable;
    const newTable = after.getModel(this.newName).dbTable;
    if (oldTable !== newTable) await ctx.backend.schema.renameTable(oldTable, newTable);
  }

  inverse(): Operation {
    return new RenameModel(this.newName, this.oldName);
  }

  toCode(): string {
    return `ops.renameModel(${JSON.stringify(this.oldName)}, ${JSON.stringify(this.newName)})`;
  }
}

class AlterModelTable implements Operation {
  readonly kind = "alterModelTable";
  readonly name: string;
  readonly dbTable: string;
  constructor(name: string, dbTable: string) {
    this.name = name;
    this.dbTable = dbTable;
  }

  describe(): string {
    return `Alter table name of ${this.name} -> ${this.dbTable}`;
  }

  stateForwards(state: ProjectState): void {
    state.getModel(this.name).dbTable = this.dbTable;
  }

  async databaseForwards(ctx: OpContext, before: ProjectState): Promise<void> {
    const oldTable = before.getModel(this.name).dbTable;
    if (oldTable !== this.dbTable) await ctx.backend.schema.renameTable(oldTable, this.dbTable);
  }

  inverse(stateBefore: ProjectState): Operation {
    return new AlterModelTable(this.name, stateBefore.getModel(this.name).dbTable);
  }

  toCode(): string {
    return `ops.alterModelTable(${JSON.stringify(this.name)}, ${JSON.stringify(this.dbTable)})`;
  }
}

class AlterModelOptions implements Operation {
  readonly kind = "alterModelOptions";
  readonly name: string;
  readonly options: { ordering?: string[] };
  constructor(name: string, options: { ordering?: string[] }) {
    this.name = name;
    this.options = options;
  }

  describe(): string {
    return `Alter options of ${this.name}`;
  }

  stateForwards(state: ProjectState): void {
    const m = state.getModel(this.name);
    if (this.options.ordering !== undefined) m.ordering = [...this.options.ordering];
  }

  async databaseForwards(): Promise<void> {
    // Ordering is query-time only; nothing to do in the database.
  }

  inverse(stateBefore: ProjectState): Operation {
    return new AlterModelOptions(this.name, { ordering: stateBefore.getModel(this.name).ordering });
  }

  toCode(): string {
    return `ops.alterModelOptions(${JSON.stringify(this.name)}, ${literal(this.options)})`;
  }
}

/* ----------------------------------------------------------------------------
 * Field-level operations
 * ------------------------------------------------------------------------- */

function findField(m: ModelState, fieldName: string): [number, SerializedField] {
  const i = m.fields.findIndex(([n]) => n === fieldName);
  if (i < 0)
    throw new FieldError(`Model "${m.name}" has no field "${fieldName}" in migration state.`);
  return [i, m.fields[i]![1]];
}

/** Build the bound runtime Field for one state field (for column DDL). */
function boundField(state: ProjectState, modelName: string, fieldName: string): Field {
  const apps = new StateApps(state);
  const meta = apps.metaFor(modelName);
  const f = meta.fields.get(fieldName);
  if (!f) throw new FieldError(`State model "${modelName}" has no field "${fieldName}".`);
  return f;
}

class AddField implements Operation {
  readonly kind = "addField";
  readonly model: string;
  readonly fieldName: string;
  readonly def: SerializedField;
  constructor(model: string, fieldName: string, def: Field | SerializedField) {
    this.model = model;
    this.fieldName = fieldName;
    this.def = asSerialized(def);
  }

  describe(): string {
    return `Add field ${this.fieldName} to ${this.model}`;
  }

  stateForwards(state: ProjectState): void {
    const m = state.getModel(this.model);
    if (m.fields.some(([n]) => n === this.fieldName)) {
      throw new FieldError(`addField: ${this.model}.${this.fieldName} already exists in state.`);
    }
    m.fields.push([this.fieldName, structuredClone(this.def)]);
  }

  async databaseForwards(
    ctx: OpContext,
    _before: ProjectState,
    after: ProjectState,
  ): Promise<void> {
    const apps = new StateApps(after);
    const meta = apps.metaFor(this.model);
    const field = meta.fields.get(this.fieldName)!;
    if (field.isM2M) await ctx.backend.schema.createManyToMany(meta, field);
    else await ctx.backend.schema.addColumn(meta, field);
  }

  inverse(): Operation {
    return new RemoveField(this.model, this.fieldName);
  }

  toCode(): string {
    return `ops.addField(${JSON.stringify(this.model)}, ${JSON.stringify(this.fieldName)}, ${fieldCode(this.def)})`;
  }
}

class RemoveField implements Operation {
  readonly kind = "removeField";
  readonly model: string;
  readonly fieldName: string;
  constructor(model: string, fieldName: string) {
    this.model = model;
    this.fieldName = fieldName;
  }

  describe(): string {
    return `Remove field ${this.fieldName} from ${this.model}`;
  }

  stateForwards(state: ProjectState): void {
    const m = state.getModel(this.model);
    const [i] = findField(m, this.fieldName);
    m.fields.splice(i, 1);
  }

  async databaseForwards(ctx: OpContext, before: ProjectState): Promise<void> {
    const apps = new StateApps(before);
    const meta = apps.metaFor(this.model);
    const field = meta.fields.get(this.fieldName)!;
    if (field.isM2M) await ctx.backend.schema.dropManyToMany(meta, field);
    else await ctx.backend.schema.removeColumn(meta, field);
  }

  inverse(stateBefore: ProjectState): Operation {
    const [, def] = findField(stateBefore.getModel(this.model), this.fieldName);
    return new AddField(this.model, this.fieldName, def);
  }

  toCode(): string {
    return `ops.removeField(${JSON.stringify(this.model)}, ${JSON.stringify(this.fieldName)})`;
  }
}

class AlterField implements Operation {
  readonly kind = "alterField";
  readonly model: string;
  readonly fieldName: string;
  readonly def: SerializedField;
  constructor(model: string, fieldName: string, def: Field | SerializedField) {
    this.model = model;
    this.fieldName = fieldName;
    this.def = asSerialized(def);
  }

  describe(): string {
    return `Alter field ${this.fieldName} on ${this.model}`;
  }

  stateForwards(state: ProjectState): void {
    const m = state.getModel(this.model);
    const [i] = findField(m, this.fieldName);
    if (this.def.type === "ManyToManyField" || m.fields[i]![1].type === "ManyToManyField") {
      throw new NotSupportedError(
        `alterField cannot change ManyToManyField ${this.model}.${this.fieldName}.`,
      );
    }
    m.fields[i] = [this.fieldName, structuredClone(this.def)];
  }

  async databaseForwards(ctx: OpContext, before: ProjectState, after: ProjectState): Promise<void> {
    const apps = new StateApps(after);
    const oldField = boundField(before, this.model, this.fieldName);
    const newField = boundField(after, this.model, this.fieldName);
    await ctx.backend.schema.alterColumn(apps.metaFor(this.model), oldField, newField);
  }

  inverse(stateBefore: ProjectState): Operation {
    const [, oldDef] = findField(stateBefore.getModel(this.model), this.fieldName);
    return new AlterField(this.model, this.fieldName, oldDef);
  }

  toCode(): string {
    return `ops.alterField(${JSON.stringify(this.model)}, ${JSON.stringify(this.fieldName)}, ${fieldCode(this.def)})`;
  }
}

class RenameField implements Operation {
  readonly kind = "renameField";
  readonly model: string;
  readonly oldName: string;
  readonly newName: string;
  constructor(model: string, oldName: string, newName: string) {
    this.model = model;
    this.oldName = oldName;
    this.newName = newName;
  }

  describe(): string {
    return `Rename field ${this.model}.${this.oldName} -> ${this.newName}`;
  }

  stateForwards(state: ProjectState): void {
    const m = state.getModel(this.model);
    const [i, def] = findField(m, this.oldName);
    m.fields[i] = [this.newName, def];
  }

  async databaseForwards(ctx: OpContext, before: ProjectState, after: ProjectState): Promise<void> {
    const oldField = boundField(before, this.model, this.oldName);
    const newField = boundField(after, this.model, this.newName);
    if (oldField.isM2M) {
      // Renaming an M2M field renames its auto through-table.
      await ctx.backend.schema.renameTable(
        (oldField as { throughTable(): string } & Field).throughTable(),
        (newField as { throughTable(): string } & Field).throughTable(),
      );
      return;
    }
    const table = after.getModel(this.model).dbTable;
    await ctx.backend.schema.renameColumn(table, oldField.column, newField.column);
  }

  inverse(): Operation {
    return new RenameField(this.model, this.newName, this.oldName);
  }

  toCode(): string {
    return `ops.renameField(${JSON.stringify(this.model)}, ${JSON.stringify(this.oldName)}, ${JSON.stringify(this.newName)})`;
  }
}

/* ----------------------------------------------------------------------------
 * Escape hatches
 * ------------------------------------------------------------------------- */

class RunSql implements Operation {
  readonly kind = "runSql";
  readonly forward: string[];
  readonly backward: string[] | null;

  constructor(sql: string | string[], reverseSql?: string | string[]) {
    this.forward = Array.isArray(sql) ? sql : [sql];
    this.backward =
      reverseSql === undefined ? null : Array.isArray(reverseSql) ? reverseSql : [reverseSql];
  }

  describe(): string {
    return "Raw SQL";
  }

  stateForwards(): void {
    // Raw SQL doesn't change the tracked model state.
  }

  async databaseForwards(ctx: OpContext): Promise<void> {
    for (const sql of this.forward) await ctx.exec(sql);
  }

  inverse(): Operation {
    if (this.backward === null) {
      throw new IrreversibleError(
        "This runSql operation has no reverse SQL and cannot be unapplied.",
      );
    }
    return new RunSql(this.backward, this.forward);
  }

  toCode(): string {
    const fwd = literal(this.forward.length === 1 ? this.forward[0] : this.forward);
    if (this.backward === null) return `ops.runSql(${fwd})`;
    return `ops.runSql(${fwd}, ${literal(this.backward.length === 1 ? this.backward[0] : this.backward)})`;
  }
}

export interface RunJsHelpers {
  /** The live backend — execute/run/exec parameterized SQL for data migrations. */
  db: Backend;
}

type RunJsFn = (helpers: RunJsHelpers) => Promise<void> | void;

class RunJs implements Operation {
  readonly kind = "runJs";
  readonly forward: RunJsFn;
  readonly backward: RunJsFn | undefined;
  constructor(forward: RunJsFn, backward?: RunJsFn) {
    this.forward = forward;
    this.backward = backward;
  }

  describe(): string {
    return "Custom JS (data migration)";
  }

  stateForwards(): void {
    // Data migrations don't change the tracked model state.
  }

  async databaseForwards(ctx: OpContext): Promise<void> {
    if (ctx.collecting) {
      await ctx.exec("-- runJs(...) data migration (not representable as SQL)");
      return;
    }
    await this.forward({ db: ctx.backend });
  }

  inverse(): Operation {
    if (!this.backward) {
      throw new IrreversibleError(
        "This runJs operation has no backward function and cannot be unapplied.",
      );
    }
    return new RunJs(this.backward, this.forward);
  }

  toCode(): string {
    throw new NotSupportedError(
      "runJs operations are hand-written; the autodetector never generates them.",
    );
  }
}

/* ----------------------------------------------------------------------------
 * The `ops` namespace passed to migration files (and used by the autodetector).
 * ------------------------------------------------------------------------- */

export const ops = {
  createModel: (
    name: string,
    fieldDefs: Record<string, Field | SerializedField>,
    options?: ModelOptions,
  ) => new CreateModel(name, fieldDefs, options),
  deleteModel: (name: string) => new DeleteModel(name),
  renameModel: (oldName: string, newName: string) => new RenameModel(oldName, newName),
  alterModelTable: (name: string, dbTable: string) => new AlterModelTable(name, dbTable),
  alterModelOptions: (name: string, options: { ordering?: string[] }) =>
    new AlterModelOptions(name, options),
  addField: (model: string, fieldName: string, def: Field | SerializedField) =>
    new AddField(model, fieldName, def),
  removeField: (model: string, fieldName: string) => new RemoveField(model, fieldName),
  alterField: (model: string, fieldName: string, def: Field | SerializedField) =>
    new AlterField(model, fieldName, def),
  renameField: (model: string, oldName: string, newName: string) =>
    new RenameField(model, oldName, newName),
  runSql: (sql: string | string[], reverseSql?: string | string[]) => new RunSql(sql, reverseSql),
  runJs: (forward: RunJsFn, backward?: RunJsFn) => new RunJs(forward, backward),
  /** Field factories for migration files (`ops.fields.CharField({ ... })`). */
  fields: fieldFactories,
};

export type Ops = typeof ops;
