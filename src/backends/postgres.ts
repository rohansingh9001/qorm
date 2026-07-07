/**
 * PostgreSQL backend, built on the `pg` driver (optional dependency — this
 * module is only imported when `engine: "postgres"` is configured).
 *
 * Uses a single pinned client so `transaction.atomic()` semantics match the
 * other backends (top-level atomics serialize through the backend lock).
 * The compiler emits `?` placeholders; they are rewritten to `$1..$n` here —
 * safe because generated SQL never contains a literal `?` inside a string.
 */
import pg from "pg";
import type { Backend, RunResult, SchemaEditor } from "./base.ts";
import { mapOnDelete } from "./base.ts";
import type { SqlValue } from "../query/ast.ts";
import type { ModelMeta } from "../types.ts";
import { ForeignKey, ManyToManyField, type Field } from "../fields.ts";
import { FieldError } from "../errors.ts";

// int8 (COUNT, bigserial pks) → Number; date → plain "YYYY-MM-DD" string.
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1082, (v: string) => v);

function toPgPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** Render a JS literal as a SQL DEFAULT literal. */
function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replace(/'/g, "''")}'`;
}

class PostgresSchemaEditor implements SchemaEditor {
  private readonly backend: PostgresBackend;
  private sink: string[] | null = null;

  constructor(backend: PostgresBackend) {
    this.backend = backend;
  }

  private async ddl(sql: string): Promise<void> {
    if (this.sink) this.sink.push(sql);
    else await this.backend.exec(sql);
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
    await this.ddl(`CREATE TABLE ${q(table)} (\n  ${lines.join(",\n  ")}\n)`);

    if (opts.indexes !== false) {
      for (const f of concrete) {
        if (f.dbIndex && !f.unique && !f.primaryKey) {
          await this.ddl(`CREATE INDEX ${q(`idx_${table}_${f.column}`)} ON ${q(table)} (${q(f.column)})`);
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
    await this.ddl(`DROP TABLE ${opts.ifExists ? "IF EXISTS " : ""}${q(meta.dbTable)} CASCADE`);
  }

  async addColumn(meta: ModelMeta, field: Field): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    let def = this.columnDef(field);
    if (!field.nullable && !field.primaryKey) {
      if (!field.hasDefault() || typeof field.options.default === "function") {
        throw new FieldError(
          `Cannot add NOT NULL column ${meta.dbTable}.${field.column} without a literal default. ` +
            `Give the field a serializable default or null: true.`,
        );
      }
      def += ` DEFAULT ${sqlLiteral(field.getDefault())}`;
    }
    await this.ddl(`ALTER TABLE ${q(meta.dbTable)} ADD COLUMN ${def}`);
    if (field.dbIndex && !field.unique) {
      await this.ddl(`CREATE INDEX ${q(`idx_${meta.dbTable}_${field.column}`)} ON ${q(meta.dbTable)} (${q(field.column)})`);
    }
  }

  async removeColumn(meta: ModelMeta, field: Field): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    await this.ddl(`ALTER TABLE ${q(meta.dbTable)} DROP COLUMN ${q(field.column)}`);
  }

  /** Native ALTERs — no rebuild dance on Postgres. */
  async alterColumn(newMeta: ModelMeta, oldField: Field, newField: Field): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    const table = q(newMeta.dbTable);
    const col = q(newField.column);
    const oldType = oldField.dbType("postgres");
    const newType = newField.dbType("postgres");
    if (oldType !== newType) {
      await this.ddl(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${newType} USING ${col}::${newType}`);
    }
    if (oldField.nullable !== newField.nullable) {
      await this.ddl(`ALTER TABLE ${table} ALTER COLUMN ${col} ${newField.nullable ? "DROP" : "SET"} NOT NULL`);
    }
    if (!oldField.unique && newField.unique) {
      await this.ddl(`CREATE UNIQUE INDEX ${q(`idx_${newMeta.dbTable}_${newField.column}_uniq`)} ON ${table} (${col})`);
    } else if (oldField.unique && !newField.unique) {
      await this.ddl(`DROP INDEX IF EXISTS ${q(`idx_${newMeta.dbTable}_${newField.column}_uniq`)}`);
    }
  }

  async renameColumn(table: string, oldColumn: string, newColumn: string): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    await this.ddl(`ALTER TABLE ${q(table)} RENAME COLUMN ${q(oldColumn)} TO ${q(newColumn)}`);
  }

  async renameTable(oldName: string, newName: string): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    await this.ddl(`ALTER TABLE ${q(oldName)} RENAME TO ${q(newName)}`);
  }

  async createManyToMany(meta: ModelMeta, field: Field): Promise<void> {
    const m2m = field as ManyToManyField;
    const q = (s: string) => this.backend.quoteName(s);
    const target = m2m.getRelatedModel().meta;
    await this.ddl(
      `CREATE TABLE ${q(m2m.throughTable())} (\n` +
        `  ${q("id")} BIGSERIAL PRIMARY KEY,\n` +
        `  ${q(m2m.ownerColumn())} BIGINT NOT NULL REFERENCES ${q(meta.dbTable)} (${q(meta.pk.column)}) ON DELETE CASCADE,\n` +
        `  ${q(m2m.targetColumn())} BIGINT NOT NULL REFERENCES ${q(target.dbTable)} (${q(target.pk.column)}) ON DELETE CASCADE,\n` +
        `  UNIQUE (${q(m2m.ownerColumn())}, ${q(m2m.targetColumn())})\n` +
        `)`,
    );
  }

  async dropManyToMany(_meta: ModelMeta, field: Field, opts: { ifExists?: boolean } = {}): Promise<void> {
    const m2m = field as ManyToManyField;
    const q = (s: string) => this.backend.quoteName(s);
    await this.ddl(`DROP TABLE ${opts.ifExists ? "IF EXISTS " : ""}${q(m2m.throughTable())} CASCADE`);
  }

  private columnDef(f: Field): string {
    const q = (s: string) => this.backend.quoteName(s);
    let def = `${q(f.column)} ${f.dbType("postgres")}`;
    if (f.primaryKey) def += " PRIMARY KEY"; // serial/bigserial carry the auto-increment
    else {
      if (f.unique) def += " UNIQUE";
      if (!f.nullable) def += " NOT NULL";
    }
    return def;
  }
}

export interface PostgresConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database: string;
}

export class PostgresBackend implements Backend {
  readonly vendor = "postgres";
  readonly schema: SchemaEditor;
  private readonly client: pg.Client;
  private connected: Promise<void> | null = null;

  constructor(cfg: PostgresConfig) {
    this.client = new pg.Client({
      host: cfg.host ?? "127.0.0.1",
      port: cfg.port ?? 5432,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
    });
    this.schema = new PostgresSchemaEditor(this);
  }

  private ensureConnected(): Promise<void> {
    if (!this.connected) this.connected = this.client.connect().then(() => undefined);
    return this.connected;
  }

  quoteName(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  async execute(sql: string, params: SqlValue[] = []): Promise<Record<string, unknown>[]> {
    await this.ensureConnected();
    const r = await this.client.query(toPgPlaceholders(sql), params as unknown[]);
    return r.rows as Record<string, unknown>[];
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    await this.ensureConnected();
    const r = await this.client.query(toPgPlaceholders(sql), params as unknown[]);
    return { changes: r.rowCount ?? 0, lastInsertRowid: 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.ensureConnected();
    await this.client.query(sql);
  }

  /* ----- dialect surface --------------------------------------------------- */

  async runInsert(sql: string, params: SqlValue[], pkColumn: string): Promise<{ insertedPk: unknown; changes: number }> {
    await this.ensureConnected();
    const r = await this.client.query(`${toPgPlaceholders(sql)} RETURNING ${this.quoteName(pkColumn)}`, params as unknown[]);
    return { insertedPk: (r.rows[0] as Record<string, unknown>)[pkColumn], changes: r.rowCount ?? 0 };
  }
  sqlInsertIgnore(table: string, columns: string[]): string {
    const cols = columns.map((c) => this.quoteName(c)).join(", ");
    const ph = columns.map(() => "?").join(", ");
    return `INSERT INTO ${this.quoteName(table)} (${cols}) VALUES (${ph}) ON CONFLICT DO NOTHING`;
  }
  sqlEmptyInsert(table: string): string {
    return `INSERT INTO ${this.quoteName(table)} DEFAULT VALUES`;
  }
  sqlNow(): string {
    return "NOW()";
  }
  sqlRegex(column: string, placeholder: string, caseInsensitive: boolean): string {
    return `${column}::text ${caseInsensitive ? "~*" : "~"} ${placeholder}`;
  }
  sqlDateOnly(column: string, placeholder: string): string {
    return `${column}::date = ${placeholder}::date`;
  }
  sqlDatePart(part: "year" | "month" | "day", column: string): string {
    return `EXTRACT(${part.toUpperCase()} FROM ${column})::int`;
  }
  sqlSensitiveLike(): string {
    return "LIKE";
  }
  sqlLikeEscape(): string {
    return " ESCAPE '\\'";
  }
  sqlConcat(parts: string[]): string {
    return "(" + parts.map((p) => `(${p})::text`).join(" || ") + ")";
  }
  sqlLimitForOffsetOnly(): string | null {
    return null; // OFFSET without LIMIT is fine on Postgres
  }
  sqlExplain(sql: string): string {
    return `EXPLAIN ${sql}`;
  }
  sqlForUpdate(): string {
    return " FOR UPDATE";
  }
  sqlAutoPkDdl(): string {
    return `${this.quoteName("id")} BIGSERIAL PRIMARY KEY`;
  }
  async disableForeignKeys(): Promise<void> {
    // Postgres has transactional DDL and native ALTERs — no rebuild dance, no toggle needed.
  }
  async enableForeignKeys(): Promise<void> {}

  /* ----- transactions ------------------------------------------------------ */

  async begin(): Promise<void> {
    await this.exec("BEGIN");
  }
  async commit(): Promise<void> {
    await this.exec("COMMIT");
  }
  async rollback(): Promise<void> {
    await this.exec("ROLLBACK");
  }
  async savepoint(name: string): Promise<void> {
    await this.exec(`SAVEPOINT ${this.quoteName(name)}`);
  }
  async releaseSavepoint(name: string): Promise<void> {
    await this.exec(`RELEASE SAVEPOINT ${this.quoteName(name)}`);
  }
  async rollbackToSavepoint(name: string): Promise<void> {
    await this.exec(`ROLLBACK TO SAVEPOINT ${this.quoteName(name)}`);
  }

  private lockChain: Promise<unknown> = Promise.resolve();
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockChain.then(fn);
    this.lockChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    if (this.connected) await this.client.end();
  }
}
