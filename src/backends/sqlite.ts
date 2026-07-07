/**
 * SQLite backend, built on Node's built-in `node:sqlite` (no external driver).
 *
 * The driver is synchronous; we wrap it in the async `Backend` interface so the
 * public API is uniform (design open-question §3 → "async-only for parity"). A
 * `regexp` function is registered so the `regex`/`iregex` lookups work, since
 * SQLite has no built-in REGEXP operator.
 */
import { DatabaseSync } from "node:sqlite";
import type { Backend, RunResult, SchemaEditor } from "./base.ts";
import { mapOnDelete } from "./base.ts";
import type { SqlValue } from "../query/ast.ts";
import type { ModelMeta } from "../types.ts";
import { ForeignKey, ManyToManyField, type Field } from "../fields.ts";
import { FieldError } from "../errors.ts";

type SqliteParam = string | number | bigint | null | Uint8Array;

/** Render a JS literal as a SQL DEFAULT literal (for ADD COLUMN backfills). */
function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

class SqliteSchemaEditor implements SchemaEditor {
  private readonly backend: SqliteBackend;
  /** When set, DDL is recorded here instead of executed (sqlmigrate). */
  private sink: string[] | null = null;

  constructor(backend: SqliteBackend) {
    this.backend = backend;
  }

  /** Route every DDL statement through the sink when collecting. */
  private ddl(sql: string): void {
    if (this.sink) this.sink.push(sql);
    else this.backend.exec(sql);
  }

  async collect(fn: (editor: SchemaEditor) => Promise<void>): Promise<string[]> {
    this.sink = [];
    try {
      await fn(this);
      return this.sink;
    } finally {
      this.sink = null;
    }
  }

  async createTable(
    meta: ModelMeta,
    opts: { indexes?: boolean; through?: boolean; tableName?: string } = {},
  ): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    const table = opts.tableName ?? meta.dbTable;
    const concrete = meta.fieldList.filter((f) => f.concrete);
    const lines: string[] = concrete.map((f) => this.columnDef(f));

    for (const f of concrete) {
      if (f instanceof ForeignKey) {
        const target = f.getRelatedModel().meta;
        lines.push(
          `FOREIGN KEY (${q(f.column)}) REFERENCES ${q(target.dbTable)} (${q(target.pk.column)}) ` +
            `ON DELETE ${mapOnDelete(f.onDelete)}`,
        );
      }
    }

    this.ddl(`CREATE TABLE ${q(table)} (\n  ${lines.join(",\n  ")}\n)`);

    if (opts.indexes !== false) {
      for (const f of concrete) {
        if (f.dbIndex && !f.unique && !f.primaryKey) {
          this.ddl(`CREATE INDEX ${q(`idx_${table}_${f.column}`)} ON ${q(table)} (${q(f.column)})`);
        }
      }
    }
    if (opts.through !== false) {
      for (const f of meta.fieldList) {
        if (f instanceof ManyToManyField) await this.createManyToMany(meta, f);
      }
    }
  }

  async dropTable(meta: ModelMeta, opts: { ifExists?: boolean } = {}): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    for (const f of meta.fieldList) {
      if (f instanceof ManyToManyField) await this.dropManyToMany(meta, f, { ifExists: true });
    }
    this.ddl(`DROP TABLE ${opts.ifExists ? "IF EXISTS " : ""}${q(meta.dbTable)}`);
  }

  async addColumn(meta: ModelMeta, field: Field): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    // SQLite's ADD COLUMN can't add UNIQUE inline — emit a unique index instead.
    let def = `${q(field.column)} ${field.dbType("sqlite")}`;
    if (!field.nullable) {
      if (!field.hasDefault() || typeof field.options.default === "function") {
        throw new FieldError(
          `Cannot add NOT NULL column ${meta.dbTable}.${field.column} without a literal default. ` +
            `Give the field a serializable default or null: true.`,
        );
      }
      def += ` NOT NULL DEFAULT ${sqlLiteral(field.getDefault())}`;
    } else if (field.hasDefault() && typeof field.options.default !== "function") {
      def += ` DEFAULT ${sqlLiteral(field.getDefault())}`;
    }
    this.ddl(`ALTER TABLE ${q(meta.dbTable)} ADD COLUMN ${def}`);
    if (field.unique) {
      this.ddl(`CREATE UNIQUE INDEX ${q(`idx_${meta.dbTable}_${field.column}_uniq`)} ON ${q(meta.dbTable)} (${q(field.column)})`);
    } else if (field.dbIndex) {
      this.ddl(`CREATE INDEX ${q(`idx_${meta.dbTable}_${field.column}`)} ON ${q(meta.dbTable)} (${q(field.column)})`);
    }
  }

  async removeColumn(meta: ModelMeta, field: Field): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    const sql = `ALTER TABLE ${q(meta.dbTable)} DROP COLUMN ${q(field.column)}`;
    if (this.sink) {
      this.sink.push(sql);
      return;
    }
    try {
      this.backend.exec(sql);
    } catch {
      // DROP COLUMN refuses indexed/unique/PK columns — rebuild without it instead.
      await this.rebuildTable(meta, { excludeColumns: [field.column] });
    }
  }

  async alterColumn(newMeta: ModelMeta, _oldField: Field, _newField: Field): Promise<void> {
    // SQLite cannot ALTER a column's type/constraints — rebuild the table with
    // the new definitions and copy the data over (design §10.4).
    await this.rebuildTable(newMeta, {});
  }

  async renameColumn(table: string, oldColumn: string, newColumn: string): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    this.ddl(`ALTER TABLE ${q(table)} RENAME COLUMN ${q(oldColumn)} TO ${q(newColumn)}`);
  }

  async renameTable(oldName: string, newName: string): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    this.ddl(`ALTER TABLE ${q(oldName)} RENAME TO ${q(newName)}`);
  }

  async createManyToMany(meta: ModelMeta, field: Field): Promise<void> {
    const m2m = field as ManyToManyField;
    const q = (s: string) => this.backend.quoteName(s);
    const target = m2m.getRelatedModel().meta;
    const table = m2m.throughTable();
    const ownerCol = m2m.ownerColumn();
    const targetCol = m2m.targetColumn();
    this.ddl(
      `CREATE TABLE ${q(table)} (\n` +
        `  ${q("id")} INTEGER PRIMARY KEY AUTOINCREMENT,\n` +
        `  ${q(ownerCol)} INTEGER NOT NULL REFERENCES ${q(meta.dbTable)} (${q(meta.pk.column)}) ON DELETE CASCADE,\n` +
        `  ${q(targetCol)} INTEGER NOT NULL REFERENCES ${q(target.dbTable)} (${q(target.pk.column)}) ON DELETE CASCADE,\n` +
        `  UNIQUE (${q(ownerCol)}, ${q(targetCol)})\n` +
        `)`,
    );
  }

  async dropManyToMany(_meta: ModelMeta, field: Field, opts: { ifExists?: boolean } = {}): Promise<void> {
    const m2m = field as ManyToManyField;
    const q = (s: string) => this.backend.quoteName(s);
    this.ddl(`DROP TABLE ${opts.ifExists ? "IF EXISTS " : ""}${q(m2m.throughTable())}`);
  }

  /**
   * The SQLite rebuild dance: CREATE new table → INSERT...SELECT the common
   * columns → DROP old → RENAME new into place → recreate indexes. The executor
   * turns foreign_keys OFF around migrations so the swap is safe.
   */
  private async rebuildTable(newMeta: ModelMeta, opts: { excludeColumns?: string[] }): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    const table = newMeta.dbTable;
    const tmp = `${table}__dorm_new`;
    const exclude = new Set(opts.excludeColumns ?? []);

    const keptFields = newMeta.fieldList.filter((f) => f.concrete && !exclude.has(f.column));
    const keptMeta: ModelMeta = { ...newMeta, fieldList: keptFields, fields: newMeta.fields };
    await this.createTable(keptMeta, { indexes: false, through: false, tableName: tmp });

    // Copy whichever of the kept columns already exist on the old table.
    // (When only collecting SQL, assume all kept columns exist — representative output.)
    const oldCols = this.existingColumns(table);
    const copy = this.sink
      ? keptFields.map((f) => f.column)
      : keptFields.map((f) => f.column).filter((c) => oldCols.has(c));
    if (copy.length > 0) {
      const colsSql = copy.map((c) => q(c)).join(", ");
      this.ddl(`INSERT INTO ${q(tmp)} (${colsSql}) SELECT ${colsSql} FROM ${q(table)}`);
    }
    this.ddl(`DROP TABLE ${q(table)}`);
    this.ddl(`ALTER TABLE ${q(tmp)} RENAME TO ${q(table)}`);
    for (const f of keptFields) {
      if (f.dbIndex && !f.unique && !f.primaryKey) {
        this.ddl(`CREATE INDEX ${q(`idx_${table}_${f.column}`)} ON ${q(table)} (${q(f.column)})`);
      }
    }
  }

  /** Column names currently on a table (empty when collecting SQL only). */
  private existingColumns(table: string): Set<string> {
    if (this.sink) return new Set<string>();
    const rows = this.backend.pragmaTableInfo(table);
    return new Set(rows.map((r) => String(r.name)));
  }

  private columnDef(f: Field): string {
    const q = (s: string) => this.backend.quoteName(s);
    let def = `${q(f.column)} ${f.dbType("sqlite")}`;
    if (f.primaryKey) {
      // INTEGER PRIMARY KEY AUTOINCREMENT is SQLite's rowid-backed auto pk.
      def += f.isAuto ? " PRIMARY KEY AUTOINCREMENT" : " PRIMARY KEY";
    } else {
      if (f.unique) def += " UNIQUE";
      if (!f.nullable) def += " NOT NULL";
    }
    return def;
  }
}

export class SqliteBackend implements Backend {
  readonly vendor = "sqlite";
  readonly schema: SchemaEditor;
  private readonly db: DatabaseSync;

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.registerRegexp();
    this.schema = new SqliteSchemaEditor(this);
  }

  quoteName(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /** Run raw DDL / pragmas (no parameters). */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** `PRAGMA table_info(...)` rows for a table (used by the schema editor & inspectdb). */
  pragmaTableInfo(table: string): Array<Record<string, unknown>> {
    const stmt = this.db.prepare(`PRAGMA table_info(${this.quoteName(table)})`);
    return stmt.all() as Array<Record<string, unknown>>;
  }

  async execute(sql: string, params: SqlValue[] = []): Promise<Record<string, unknown>[]> {
    const stmt = this.db.prepare(sql);
    return stmt.all(...this.coerce(params)) as Record<string, unknown>[];
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const stmt = this.db.prepare(sql);
    const r = stmt.run(...this.coerce(params));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  /* ----- dialect surface --------------------------------------------------- */

  async runInsert(sql: string, params: SqlValue[], _pkColumn: string): Promise<{ insertedPk: unknown; changes: number }> {
    const r = await this.run(sql, params);
    return { insertedPk: Number(r.lastInsertRowid), changes: r.changes };
  }
  sqlInsertIgnore(table: string, columns: string[]): string {
    const cols = columns.map((c) => this.quoteName(c)).join(", ");
    const ph = columns.map(() => "?").join(", ");
    return `INSERT OR IGNORE INTO ${this.quoteName(table)} (${cols}) VALUES (${ph})`;
  }
  sqlEmptyInsert(table: string): string {
    return `INSERT INTO ${this.quoteName(table)} DEFAULT VALUES`;
  }
  sqlNow(): string {
    return "datetime('now')";
  }
  sqlRegex(column: string, placeholder: string, caseInsensitive: boolean): string {
    return caseInsensitive ? `iregexp(${placeholder}, ${column})` : `${column} REGEXP ${placeholder}`;
  }
  sqlDateOnly(column: string, placeholder: string): string {
    return `date(${column}) = ${placeholder}`;
  }
  sqlDatePart(part: "year" | "month" | "day", column: string): string {
    const fmt = { year: "%Y", month: "%m", day: "%d" }[part];
    return `CAST(strftime('${fmt}', ${column}) AS INTEGER)`;
  }
  sqlSensitiveLike(): string {
    return "LIKE";
  }
  sqlLikeEscape(): string {
    return " ESCAPE '\\'";
  }
  sqlConcat(parts: string[]): string {
    return "(" + parts.join(" || ") + ")";
  }
  sqlLimitForOffsetOnly(): string | null {
    return "-1"; // SQLite requires a LIMIT before OFFSET
  }
  sqlExplain(sql: string): string {
    return `EXPLAIN QUERY PLAN ${sql}`;
  }
  sqlForUpdate(): string {
    return ""; // SQLite locks the whole database on write; no row locks
  }
  sqlAutoPkDdl(): string {
    return `${this.quoteName("id")} INTEGER PRIMARY KEY AUTOINCREMENT`;
  }
  async disableForeignKeys(): Promise<void> {
    this.db.exec("PRAGMA foreign_keys = OFF");
  }
  async enableForeignKeys(): Promise<void> {
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  /* ----- transactions ------------------------------------------------------ */

  async begin(): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
  }
  async commit(): Promise<void> {
    this.db.exec("COMMIT");
  }
  async rollback(): Promise<void> {
    this.db.exec("ROLLBACK");
  }
  async savepoint(name: string): Promise<void> {
    this.db.exec(`SAVEPOINT ${this.quoteName(name)}`);
  }
  async releaseSavepoint(name: string): Promise<void> {
    this.db.exec(`RELEASE SAVEPOINT ${this.quoteName(name)}`);
  }
  async rollbackToSavepoint(name: string): Promise<void> {
    this.db.exec(`ROLLBACK TO SAVEPOINT ${this.quoteName(name)}`);
  }

  /** Simple promise-chain mutex serializing top-level atomic blocks. */
  private lockChain: Promise<unknown> = Promise.resolve();
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockChain.then(fn, fn);
    this.lockChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /** node:sqlite accepts string|number|bigint|null|Uint8Array; coerce booleans and Dates. */
  private coerce(params: SqlValue[]): SqliteParam[] {
    return params.map((p) => {
      if (typeof p === "boolean") return p ? 1 : 0;
      if (p instanceof Date) return p.toISOString();
      return p;
    });
  }

  private registerRegexp(): void {
    const matcher = (flags: string) => (pattern: unknown, value: unknown): number => {
      if (value === null || value === undefined) return 0;
      try {
        return new RegExp(String(pattern), flags).test(String(value)) ? 1 : 0;
      } catch {
        return 0;
      }
    };
    // SQLite maps `value REGEXP pattern` to the call `regexp(pattern, value)`.
    this.db.function("regexp", matcher(""));
    // `iregexp(pattern, value)` is our own helper for the case-insensitive `iregex` lookup.
    this.db.function("iregexp", matcher("i"));
  }
}
