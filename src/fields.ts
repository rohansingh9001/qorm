/**
 * Field descriptors.
 *
 * A field is a declarative descriptor: it knows its DB type, how to convert
 * values to/from the database, and its options (null/unique/default/…). It does
 * NOT hold a value — instance values live on the instance (see `model.ts`). This
 * is the static-declaration / instance-value split called out in design 4.2.
 *
 * Mirrors `django.db.models.*Field`: scalar fields, `ForeignKey`/`OneToOneField`,
 * and `ManyToManyField` (auto through-table; custom `through` models are not yet
 * supported).
 */
import type { SqlValue } from "./query/ast.ts";
import type { ModelClass } from "./types.ts";
import { FieldError } from "./errors.ts";
import { getModel } from "./registry.ts";

export type OnDelete = "CASCADE" | "PROTECT" | "SET_NULL" | "SET_DEFAULT" | "DO_NOTHING";

export type Choice = readonly [value: unknown, label: string];

export interface FieldOptions {
  /** Whether the DB column is nullable (Django's `null`). */
  null?: boolean;
  /** Validation-only "may be empty" (Django's `blank`). Not enforced at the DB level. */
  blank?: boolean;
  /** A default value, or a zero-arg factory for one. */
  default?: unknown | (() => unknown);
  unique?: boolean;
  dbIndex?: boolean;
  primaryKey?: boolean;
  choices?: ReadonlyArray<Choice>;
  /** Override the generated column name. */
  dbColumn?: string;
  editable?: boolean;
  verboseName?: string;
  helpText?: string;
  validators?: Array<(value: unknown) => void>;
}

/** Plain, comparable form of a field for migration state (see `Field.serialize`). */
export interface SerializedField {
  type: string;
  options: Record<string, unknown>;
  /** Related model name for ForeignKey / OneToOneField / ManyToManyField. */
  to?: string;
}

function lcFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Marker so we never confuse a Field with a plain options object during registration. */
const FIELD_BRAND = Symbol.for("dorm.Field");

export abstract class Field {
  readonly [FIELD_BRAND] = true;
  abstract readonly fieldType: string;

  /** JS attribute name on the model; set during registration via `bind()`. */
  name = "";
  /** DB column name; derived from `name` unless `dbColumn` overrides it. */
  column = "";
  /** Owning model name, for error messages. */
  modelName = "";

  readonly options: FieldOptions;

  constructor(options: FieldOptions = {}) {
    this.options = options;
  }

  /** The attribute that holds this field's scalar value. Equals `name` except for relations. */
  get attname(): string {
    return this.name;
  }

  get isRelation(): boolean {
    return false;
  }
  get isAuto(): boolean {
    return false;
  }
  get primaryKey(): boolean {
    return this.options.primaryKey === true;
  }
  get nullable(): boolean {
    return this.options.null === true;
  }
  get unique(): boolean {
    return this.options.unique === true || this.primaryKey;
  }
  get dbIndex(): boolean {
    return this.options.dbIndex === true;
  }
  /** Whether the field is user-editable; auto-managed fields override this to false. */
  get editable(): boolean {
    return this.options.editable !== false;
  }
  /** Whether the field maps to a real column on the model's table (M2M does not). */
  get concrete(): boolean {
    return true;
  }
  get isM2M(): boolean {
    return false;
  }

  bind(name: string, modelName: string): void {
    this.name = name;
    this.modelName = modelName;
    this.column = this.options.dbColumn ?? this.defaultColumn(name);
  }
  protected defaultColumn(name: string): string {
    return name;
  }

  /** SQL column type for the given backend vendor. */
  abstract dbType(vendor: string): string;

  hasDefault(): boolean {
    return this.options.default !== undefined;
  }
  getDefault(): unknown {
    const d = this.options.default;
    return typeof d === "function" ? (d as () => unknown)() : d;
  }

  /** JS value -> SQL parameter. Override per type; null/undefined always map to SQL NULL. */
  toDb(value: unknown): SqlValue {
    if (value === null || value === undefined) return null;
    return value as SqlValue;
  }

  /** SQL row value -> JS value. */
  fromDb(value: unknown): unknown {
    return value;
  }

  /**
   * Serialize to a plain, comparable, code-emittable form for the migration
   * state (Django's `field.deconstruct()`). Functions can't round-trip: a
   * callable `default` is recorded as a marker (`__functionDefault`) and
   * validators are dropped — neither affects the schema.
   */
  serialize(): SerializedField {
    const options: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.options)) {
      if (v === undefined || k === "validators") continue;
      if (typeof v === "function") {
        if (k === "default") options.__functionDefault = true;
        continue;
      }
      options[k] = v;
    }
    return { type: this.fieldType, options };
  }

  /** Throw on invalid value. Runs choices + null + per-type checks. */
  validate(value: unknown): void {
    if (value === null || value === undefined) {
      if (!this.nullable && !this.primaryKey && this.options.blank !== true && !this.hasDefault()) {
        throw new FieldError(`${this.modelName}.${this.name} cannot be null.`);
      }
      return;
    }
    if (this.options.choices) {
      const ok = this.options.choices.some(([v]) => v === value);
      if (!ok) throw new FieldError(`${value} is not a valid choice for ${this.modelName}.${this.name}.`);
    }
    for (const v of this.options.validators ?? []) v(value);
  }
}

export function isField(value: unknown): value is Field {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[FIELD_BRAND] === true;
}

/* ----------------------------------------------------------------------------
 * Numeric / auto fields
 * ------------------------------------------------------------------------- */

export class AutoField extends Field {
  readonly fieldType: string = "AutoField";
  constructor(options: FieldOptions = {}) {
    super({ primaryKey: true, ...options });
  }
  override get isAuto(): boolean {
    return true;
  }
  override get editable(): boolean {
    return false;
  }
  dbType(vendor: string): string {
    if (vendor === "postgres") return "serial";
    if (vendor === "mysql") return "INT";
    return "INTEGER";
  }
  override fromDb(value: unknown): unknown {
    return value === null || value === undefined ? value : Number(value);
  }
}

export class BigAutoField extends AutoField {
  override readonly fieldType = "BigAutoField";
  override dbType(vendor: string): string {
    if (vendor === "postgres") return "bigserial";
    if (vendor === "mysql") return "BIGINT";
    return "INTEGER";
  }
}

export class IntegerField extends Field {
  readonly fieldType = "IntegerField";
  dbType(vendor: string): string {
    if (vendor === "postgres") return "integer";
    if (vendor === "mysql") return "INT";
    return "INTEGER";
  }
  override fromDb(value: unknown): unknown {
    return value === null || value === undefined ? value : Number(value);
  }
}

export class BigIntegerField extends Field {
  readonly fieldType = "BigIntegerField";
  dbType(vendor: string): string {
    if (vendor === "postgres") return "bigint";
    if (vendor === "mysql") return "BIGINT";
    return "INTEGER";
  }
}

export class FloatField extends Field {
  readonly fieldType = "FloatField";
  dbType(vendor: string): string {
    if (vendor === "postgres") return "double precision";
    if (vendor === "mysql") return "DOUBLE";
    return "REAL";
  }
  override fromDb(value: unknown): unknown {
    return value === null || value === undefined ? value : Number(value);
  }
}

export class DecimalField extends Field {
  readonly fieldType = "DecimalField";
  readonly maxDigits: number;
  readonly decimalPlaces: number;
  constructor(options: FieldOptions & { maxDigits: number; decimalPlaces: number }) {
    super(options);
    if (options.maxDigits == null || options.decimalPlaces == null) {
      throw new FieldError("DecimalField requires { maxDigits, decimalPlaces }.");
    }
    this.maxDigits = options.maxDigits;
    this.decimalPlaces = options.decimalPlaces;
  }
  dbType(vendor: string): string {
    if (vendor === "postgres") return `numeric(${this.maxDigits}, ${this.decimalPlaces})`;
    if (vendor === "mysql") return `DECIMAL(${this.maxDigits}, ${this.decimalPlaces})`;
    return "TEXT";
  }
  // String-backed to avoid float drift (design 4.3).
  override toDb(value: unknown): SqlValue {
    if (value === null || value === undefined) return null;
    return String(value);
  }
  override fromDb(value: unknown): unknown {
    return value === null || value === undefined ? value : String(value);
  }
}

/* ----------------------------------------------------------------------------
 * Text fields
 * ------------------------------------------------------------------------- */

export class CharField extends Field {
  readonly fieldType: string = "CharField";
  readonly maxLength: number;
  constructor(options: FieldOptions & { maxLength: number }) {
    super(options);
    if (options.maxLength == null) {
      throw new FieldError("CharField requires { maxLength }.");
    }
    this.maxLength = options.maxLength;
  }
  dbType(vendor: string): string {
    if (vendor === "postgres") return `varchar(${this.maxLength})`;
    if (vendor === "mysql") return `VARCHAR(${this.maxLength})`;
    return "TEXT";
  }
  override validate(value: unknown): void {
    super.validate(value);
    if (typeof value === "string" && value.length > this.maxLength) {
      throw new FieldError(
        `${this.modelName}.${this.name}: value exceeds maxLength=${this.maxLength} (${value.length}).`,
      );
    }
  }
}

export class TextField extends Field {
  readonly fieldType = "TextField";
  dbType(): string {
    return "TEXT";
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class EmailField extends CharField {
  override readonly fieldType = "EmailField";
  constructor(options: FieldOptions & { maxLength?: number } = {}) {
    super({ maxLength: 254, ...options });
  }
  override validate(value: unknown): void {
    super.validate(value);
    if (typeof value === "string" && !EMAIL_RE.test(value)) {
      throw new FieldError(`${this.modelName}.${this.name}: "${value}" is not a valid email address.`);
    }
  }
}

export class UUIDField extends Field {
  readonly fieldType = "UUIDField";
  dbType(vendor: string): string {
    if (vendor === "postgres") return "uuid";
    if (vendor === "mysql") return "CHAR(36)";
    return "TEXT";
  }
}

/* ----------------------------------------------------------------------------
 * Boolean / date / json fields
 * ------------------------------------------------------------------------- */

export class BooleanField extends Field {
  readonly fieldType = "BooleanField";
  dbType(vendor: string): string {
    if (vendor === "postgres") return "boolean";
    if (vendor === "mysql") return "TINYINT(1)";
    return "INTEGER";
  }
  // Bind real booleans; backends without a boolean type coerce to 1/0 themselves.
  override toDb(value: unknown): SqlValue {
    if (value === null || value === undefined) return null;
    return Boolean(value);
  }
  override fromDb(value: unknown): unknown {
    return value === null || value === undefined ? value : Boolean(value);
  }
}

export class DateField extends Field {
  readonly fieldType = "DateField";
  readonly autoNow: boolean;
  readonly autoNowAdd: boolean;
  constructor(options: FieldOptions & { autoNow?: boolean; autoNowAdd?: boolean } = {}) {
    super(options);
    this.autoNow = options.autoNow === true;
    this.autoNowAdd = options.autoNowAdd === true;
  }
  override get editable(): boolean {
    return this.autoNow || this.autoNowAdd ? false : this.options.editable !== false;
  }
  dbType(vendor: string): string {
    if (vendor === "postgres") return "date";
    if (vendor === "mysql") return "DATE";
    return "TEXT";
  }
  override toDb(value: unknown): SqlValue {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value);
  }
  // Always an ISO "YYYY-MM-DD" string in JS (drivers may hand back Date objects).
  override fromDb(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (value instanceof Date) {
      const y = value.getFullYear();
      const m = String(value.getMonth() + 1).padStart(2, "0");
      const d = String(value.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    return String(value);
  }
}

export class DateTimeField extends Field {
  readonly fieldType = "DateTimeField";
  readonly autoNow: boolean;
  readonly autoNowAdd: boolean;
  constructor(options: FieldOptions & { autoNow?: boolean; autoNowAdd?: boolean } = {}) {
    super(options);
    this.autoNow = options.autoNow === true;
    this.autoNowAdd = options.autoNowAdd === true;
  }
  override get editable(): boolean {
    return this.autoNow || this.autoNowAdd ? false : this.options.editable !== false;
  }
  dbType(vendor: string): string {
    if (vendor === "postgres") return "timestamptz";
    if (vendor === "mysql") return "DATETIME(6)";
    return "TEXT";
  }
  // Bind a real Date: drivers serialize it in their own dialect (MySQL rejects
  // ISO-8601 strings); the SQLite backend converts Dates to ISO text itself.
  override toDb(value: unknown): SqlValue {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value;
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed;
  }
  override fromDb(value: unknown): unknown {
    return value === null || value === undefined ? value : new Date(value as string);
  }
}

export class JSONField extends Field {
  readonly fieldType = "JSONField";
  dbType(vendor: string): string {
    if (vendor === "postgres") return "jsonb";
    if (vendor === "mysql") return "JSON";
    return "TEXT";
  }
  override toDb(value: unknown): SqlValue {
    if (value === undefined) return null;
    return JSON.stringify(value);
  }
  override fromDb(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    return typeof value === "string" ? JSON.parse(value) : value;
  }
}

/* ----------------------------------------------------------------------------
 * Relations
 * ------------------------------------------------------------------------- */

export type RelatedRef = (() => ModelClass) | string;

export interface ForeignKeyOptions extends FieldOptions {
  onDelete?: OnDelete;
  relatedName?: string;
  /** Target column on the related model; defaults to its primary key. */
  toField?: string;
}

export class ForeignKey extends Field {
  readonly fieldType: string = "ForeignKey";
  readonly to: RelatedRef;
  readonly onDelete: OnDelete;
  readonly relatedName: string | undefined;
  private resolved: ModelClass | undefined;

  constructor(to: RelatedRef, options: ForeignKeyOptions = {}) {
    super(options);
    this.to = to;
    this.onDelete = options.onDelete ?? "CASCADE";
    this.relatedName = options.relatedName;
  }

  override get isRelation(): boolean {
    return true;
  }
  /** Scalar attribute holding the FK value: `author` -> `authorId` (Django's `author_id`). */
  override get attname(): string {
    return `${this.name}Id`;
  }
  protected override defaultColumn(name: string): string {
    return `${name}Id`;
  }
  /** The FK column's type mirrors the target PK's storage type. */
  dbType(vendor: string): string {
    let targetPk: Field | undefined;
    try {
      targetPk = this.getRelatedModel().meta.pk;
    } catch {
      targetPk = undefined; // target not registered yet; assume the default auto pk
    }
    if (!targetPk || targetPk.isAuto) {
      // serial/bigserial columns are plain integer/bigint on the referencing side.
      const big = !targetPk || targetPk.fieldType === "BigAutoField";
      if (vendor === "postgres") return big ? "bigint" : "integer";
      if (vendor === "mysql") return big ? "BIGINT" : "INT";
      return "INTEGER";
    }
    return targetPk.dbType(vendor);
  }

  /** Drivers may return bigint pks as strings; normalize numeric forms. */
  override fromDb(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
    return value;
  }

  /** Resolve the thunk / string ref to the related model class (cached). */
  getRelatedModel(): ModelClass {
    if (this.resolved) return this.resolved;
    this.resolved = typeof this.to === "string" ? getModel(this.to) : this.to();
    return this.resolved;
  }

  /** The related model's name without forcing full resolution through the registry. */
  targetModelName(): string {
    return typeof this.to === "string" ? this.to : this.to().modelName;
  }

  override serialize(): SerializedField {
    return { ...super.serialize(), to: this.targetModelName() };
  }

  /** Accept either a related instance or a raw pk; store the pk. */
  override toDb(value: unknown): SqlValue {
    if (value === null || value === undefined) return null;
    if (typeof value === "object" && value !== null && "pk" in value) {
      return (value as { pk: SqlValue }).pk;
    }
    return value as SqlValue;
  }
}

export class OneToOneField extends ForeignKey {
  override readonly fieldType: string = "OneToOneField";
  constructor(to: RelatedRef, options: ForeignKeyOptions = {}) {
    super(to, { unique: true, ...options });
  }
}

export interface ManyToManyOptions extends FieldOptions {
  relatedName?: string;
  /** Custom through model — not supported yet; the auto through-table is always used. */
  through?: string;
}

/**
 * ManyToManyField (design 6.2). No column lives on the model's table; rows live
 * in an auto-generated through-table named `<table>_<field>` (e.g. `post_tags`)
 * with `<owner>Id` / `<target>Id` FK columns (`from<X>Id`/`to<X>Id` when
 * self-referential, like Django's `from_x_id`/`to_x_id`).
 */
export class ManyToManyField extends Field {
  readonly fieldType = "ManyToManyField";
  readonly to: RelatedRef;
  readonly relatedName: string | undefined;
  readonly through: string | undefined;
  /** Owner model's db table; set at registration (names the auto through-table). */
  ownerDbTable = "";
  private resolved: ModelClass | undefined;

  constructor(to: RelatedRef, options: ManyToManyOptions = {}) {
    super(options);
    this.to = to;
    this.relatedName = options.relatedName;
    this.through = options.through;
  }

  override get isRelation(): boolean {
    return true;
  }
  override get isM2M(): boolean {
    return true;
  }
  override get concrete(): boolean {
    return false;
  }

  dbType(): string {
    throw new FieldError(`${this.modelName}.${this.name}: ManyToManyField has no database column.`);
  }

  getRelatedModel(): ModelClass {
    if (this.resolved) return this.resolved;
    this.resolved = typeof this.to === "string" ? getModel(this.to) : this.to();
    return this.resolved;
  }

  targetModelName(): string {
    return typeof this.to === "string" ? this.to : this.to().modelName;
  }

  isSelfReferential(): boolean {
    return this.targetModelName() === this.modelName;
  }

  /** Auto through-table name, Django-style `<table>_<field>` (e.g. "post_tags"). */
  throughTable(): string {
    return `${this.ownerDbTable}_${this.name}`;
  }
  /** Through-table column pointing at the owning model. */
  ownerColumn(): string {
    return this.isSelfReferential() ? `from${this.modelName}Id` : `${lcFirst(this.modelName)}Id`;
  }
  /** Through-table column pointing at the target model. */
  targetColumn(): string {
    const t = this.targetModelName();
    return this.isSelfReferential() ? `to${t}Id` : `${lcFirst(t)}Id`;
  }

  override serialize(): SerializedField {
    return { ...super.serialize(), to: this.targetModelName() };
  }
}

/* ----------------------------------------------------------------------------
 * Public factory namespace — `fields.CharField({ ... })` (design 4.2/4.3)
 * ------------------------------------------------------------------------- */

export const fields = {
  AutoField: (o?: FieldOptions) => new AutoField(o),
  BigAutoField: (o?: FieldOptions) => new BigAutoField(o),
  IntegerField: (o?: FieldOptions) => new IntegerField(o),
  BigIntegerField: (o?: FieldOptions) => new BigIntegerField(o),
  FloatField: (o?: FieldOptions) => new FloatField(o),
  DecimalField: (o: FieldOptions & { maxDigits: number; decimalPlaces: number }) => new DecimalField(o),
  CharField: (o: FieldOptions & { maxLength: number }) => new CharField(o),
  TextField: (o?: FieldOptions) => new TextField(o),
  EmailField: (o?: FieldOptions & { maxLength?: number }) => new EmailField(o),
  UUIDField: (o?: FieldOptions) => new UUIDField(o),
  BooleanField: (o?: FieldOptions) => new BooleanField(o),
  DateField: (o?: FieldOptions & { autoNow?: boolean; autoNowAdd?: boolean }) => new DateField(o),
  DateTimeField: (o?: FieldOptions & { autoNow?: boolean; autoNowAdd?: boolean }) => new DateTimeField(o),
  JSONField: (o?: FieldOptions) => new JSONField(o),
  ForeignKey: (to: RelatedRef, o?: ForeignKeyOptions) => new ForeignKey(to, o),
  OneToOneField: (to: RelatedRef, o?: ForeignKeyOptions) => new OneToOneField(to, o),
  ManyToManyField: (to: RelatedRef, o?: ManyToManyOptions) => new ManyToManyField(to, o),
};

/* ----------------------------------------------------------------------------
 * Deserialization — rebuild a Field from its serialized form (migration state).
 * ------------------------------------------------------------------------- */

const SCALAR_CTORS: Record<string, (o: Record<string, unknown>) => Field> = {
  AutoField: (o) => new AutoField(o as FieldOptions),
  BigAutoField: (o) => new BigAutoField(o as FieldOptions),
  IntegerField: (o) => new IntegerField(o as FieldOptions),
  BigIntegerField: (o) => new BigIntegerField(o as FieldOptions),
  FloatField: (o) => new FloatField(o as FieldOptions),
  DecimalField: (o) => new DecimalField(o as unknown as FieldOptions & { maxDigits: number; decimalPlaces: number }),
  CharField: (o) => new CharField(o as unknown as FieldOptions & { maxLength: number }),
  TextField: (o) => new TextField(o as FieldOptions),
  EmailField: (o) => new EmailField(o as FieldOptions & { maxLength?: number }),
  UUIDField: (o) => new UUIDField(o as FieldOptions),
  BooleanField: (o) => new BooleanField(o as FieldOptions),
  DateField: (o) => new DateField(o as FieldOptions),
  DateTimeField: (o) => new DateTimeField(o as FieldOptions),
  JSONField: (o) => new JSONField(o as FieldOptions),
};

/**
 * Rebuild a Field instance from a serialized def. Relations resolve their target
 * through `resolve`, so migration state models (not the live registry) can be
 * the universe a historical field points into.
 */
export function deserializeField(def: SerializedField, resolve: (name: string) => ModelClass): Field {
  const opts = def.options;
  switch (def.type) {
    case "ForeignKey":
      return new ForeignKey(() => resolve(def.to!), opts as ForeignKeyOptions);
    case "OneToOneField":
      return new OneToOneField(() => resolve(def.to!), opts as ForeignKeyOptions);
    case "ManyToManyField":
      return new ManyToManyField(() => resolve(def.to!), opts as ManyToManyOptions);
    default: {
      const ctor = SCALAR_CTORS[def.type];
      if (!ctor) throw new FieldError(`Unknown field type "${def.type}" in migration state.`);
      return ctor(opts);
    }
  }
}
