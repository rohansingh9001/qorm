/**
 * MySQL backend, built on the `mysql2` driver (optional dependency — this
 * module is only imported when `engine: "mysql"` is configured).
 *
 * Single pinned connection so `transaction.atomic()` semantics match the other
 * backends. `?` placeholders are native. Identifiers quote with backticks.
 * MySQL quirks handled here: case-insensitive LIKE (→ LIKE BINARY for the
 * sensitive lookups), `||` is not concat (→ CONCAT()), no DDL transactions
 * (migrations still run; MySQL auto-commits DDL — same caveat as Django).
 */
import mysql from "mysql2/promise";
import type { Backend, RunResult, SchemaEditor } from "./base.ts";
import { mapOnDelete } from "./base.ts";
import type { SqlValue } from "../query/ast.ts";
import type { ModelMeta } from "../types.ts";
import { ForeignKey, ManyToManyField, type Field } from "../fields.ts";
import { FieldError } from "../errors.ts";

/** Render a JS literal as a SQL DEFAULT literal. */
function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

class MysqlSchemaEditor implements SchemaEditor {
  private readonly backend: MysqlBackend;
  private sink: string[] | null = null;

  constructor(backend: MysqlBackend) {
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
          await this.ddl(
            `CREATE INDEX ${q(`idx_${table}_${f.column}`)} ON ${q(table)} (${q(f.column)})`,
          );
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
    await this.ddl(`DROP TABLE ${opts.ifExists ? "IF EXISTS " : ""}${q(meta.dbTable)}`);
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
      await this.ddl(
        `CREATE INDEX ${q(`idx_${meta.dbTable}_${field.column}`)} ON ${q(meta.dbTable)} (${q(field.column)})`,
      );
    }
  }

  async removeColumn(meta: ModelMeta, field: Field): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    await this.ddl(`ALTER TABLE ${q(meta.dbTable)} DROP COLUMN ${q(field.column)}`);
  }

  /** MySQL alters with MODIFY COLUMN carrying the full new definition. */
  async alterColumn(newMeta: ModelMeta, oldField: Field, newField: Field): Promise<void> {
    const q = (s: string) => this.backend.quoteName(s);
    await this.ddl(
      `ALTER TABLE ${q(newMeta.dbTable)} MODIFY COLUMN ${this.columnDef(newField, { inAlter: true })}`,
    );
    if (!oldField.unique && newField.unique) {
      await this.ddl(
        `CREATE UNIQUE INDEX ${q(`idx_${newMeta.dbTable}_${newField.column}_uniq`)} ON ${q(newMeta.dbTable)} (${q(newField.column)})`,
      );
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
        `  ${q("id")} BIGINT AUTO_INCREMENT PRIMARY KEY,\n` +
        `  ${q(m2m.ownerColumn())} BIGINT NOT NULL,\n` +
        `  ${q(m2m.targetColumn())} BIGINT NOT NULL,\n` +
        `  UNIQUE (${q(m2m.ownerColumn())}, ${q(m2m.targetColumn())}),\n` +
        `  FOREIGN KEY (${q(m2m.ownerColumn())}) REFERENCES ${q(meta.dbTable)} (${q(meta.pk.column)}) ON DELETE CASCADE,\n` +
        `  FOREIGN KEY (${q(m2m.targetColumn())}) REFERENCES ${q(target.dbTable)} (${q(target.pk.column)}) ON DELETE CASCADE\n` +
        `)`,
    );
  }

  async dropManyToMany(
    _meta: ModelMeta,
    field: Field,
    opts: { ifExists?: boolean } = {},
  ): Promise<void> {
    const m2m = field as ManyToManyField;
    const q = (s: string) => this.backend.quoteName(s);
    await this.ddl(`DROP TABLE ${opts.ifExists ? "IF EXISTS " : ""}${q(m2m.throughTable())}`);
  }

  private columnDef(f: Field, opts: { inAlter?: boolean } = {}): string {
    const q = (s: string) => this.backend.quoteName(s);
    let def = `${q(f.column)} ${f.dbType("mysql")}`;
    if (f.primaryKey) {
      def += f.isAuto ? " AUTO_INCREMENT PRIMARY KEY" : " PRIMARY KEY";
    } else {
      // UNIQUE inline is fine in CREATE TABLE; in MODIFY COLUMN it would re-add a key.
      if (f.unique && !opts.inAlter) def += " UNIQUE";
      if (!f.nullable) def += " NOT NULL";
    }
    return def;
  }
}

export interface MysqlConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database: string;
}

export class MysqlBackend implements Backend {
  readonly vendor = "mysql";
  readonly schema: SchemaEditor;
  private readonly cfg: MysqlConfig;
  private conn: mysql.Connection | null = null;

  constructor(cfg: MysqlConfig) {
    this.cfg = cfg;
    this.schema = new MysqlSchemaEditor(this);
  }

  private async connection(): Promise<mysql.Connection> {
    if (!this.conn) {
      this.conn = await mysql.createConnection({
        host: this.cfg.host ?? "127.0.0.1",
        port: this.cfg.port ?? 3306,
        user: this.cfg.user,
        password: this.cfg.password,
        database: this.cfg.database,
        // DATE as "YYYY-MM-DD" strings (lossless); DATETIME stays a JS Date.
        dateStrings: ["DATE"],
      });
    }
    return this.conn;
  }

  quoteName(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
  }

  async execute(sql: string, params: SqlValue[] = []): Promise<Record<string, unknown>[]> {
    const conn = await this.connection();
    const [rows] = await conn.query(sql, params as unknown[]);
    return rows as Record<string, unknown>[];
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const conn = await this.connection();
    const [result] = await conn.query(sql, params as unknown[]);
    const header = result as mysql.ResultSetHeader;
    return { changes: header.affectedRows ?? 0, lastInsertRowid: header.insertId ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    const conn = await this.connection();
    await conn.query(sql);
  }

  /* ----- dialect surface --------------------------------------------------- */

  async runInsert(
    sql: string,
    params: SqlValue[],
    _pkColumn: string,
  ): Promise<{ insertedPk: unknown; changes: number }> {
    const r = await this.run(sql, params);
    return { insertedPk: Number(r.lastInsertRowid), changes: r.changes };
  }
  sqlInsertIgnore(table: string, columns: string[]): string {
    const cols = columns.map((c) => this.quoteName(c)).join(", ");
    const ph = columns.map(() => "?").join(", ");
    return `INSERT IGNORE INTO ${this.quoteName(table)} (${cols}) VALUES (${ph})`;
  }
  sqlEmptyInsert(table: string): string {
    return `INSERT INTO ${this.quoteName(table)} () VALUES ()`;
  }
  sqlNow(): string {
    return "NOW(6)";
  }
  sqlRegex(column: string, placeholder: string, caseInsensitive: boolean): string {
    return `REGEXP_LIKE(${column}, ${placeholder}, '${caseInsensitive ? "i" : "c"}')`;
  }
  sqlDateOnly(column: string, placeholder: string): string {
    return `DATE(${column}) = ${placeholder}`;
  }
  sqlDatePart(part: "year" | "month" | "day", column: string): string {
    return `EXTRACT(${part.toUpperCase()} FROM ${column})`;
  }
  sqlSensitiveLike(): string {
    return "LIKE BINARY"; // plain LIKE is case-insensitive under default collations
  }
  sqlLikeEscape(): string {
    return " ESCAPE '\\\\'"; // backslash must be doubled inside a MySQL string literal
  }
  sqlConcat(parts: string[]): string {
    return `CONCAT(${parts.join(", ")})`; // || is logical OR on MySQL
  }
  sqlLimitForOffsetOnly(): string | null {
    return "18446744073709551615"; // MySQL requires LIMIT before OFFSET
  }
  sqlExplain(sql: string): string {
    return `EXPLAIN ${sql}`;
  }
  sqlForUpdate(): string {
    return " FOR UPDATE";
  }
  sqlAutoPkDdl(): string {
    return `${this.quoteName("id")} BIGINT AUTO_INCREMENT PRIMARY KEY`;
  }
  async disableForeignKeys(): Promise<void> {
    await this.exec("SET FOREIGN_KEY_CHECKS = 0");
  }
  async enableForeignKeys(): Promise<void> {
    await this.exec("SET FOREIGN_KEY_CHECKS = 1");
  }

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
    if (this.conn) await this.conn.end();
  }
}
