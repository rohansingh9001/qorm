/**
 * Backend contract.
 *
 * A backend is the dialect-specific seam (design 3): it executes parameterized
 * SQL, exposes identifier quoting, and owns a `SchemaEditor` that turns model
 * metadata into DDL. The QuerySet/compiler never talk to a driver directly — they
 * go through this interface, so adding Postgres/MySQL is a matter of another impl.
 */
import type { SqlValue } from "../query/ast.ts";
import type { ModelMeta } from "../types.ts";
import type { Field } from "../fields.ts";

export interface RunResult {
  /** Rows affected by an INSERT/UPDATE/DELETE. */
  changes: number;
  /** Auto-generated PK from the last INSERT (driver-dependent width). */
  lastInsertRowid: number | bigint;
}

/** Translates model metadata into dialect DDL (Django's `SchemaEditor`). */
export interface SchemaEditor {
  /** Create the model's table (+ indexes and auto M2M through-tables unless disabled). */
  createTable(
    meta: ModelMeta,
    opts?: { indexes?: boolean; through?: boolean; tableName?: string },
  ): Promise<void>;
  dropTable(meta: ModelMeta, opts?: { ifExists?: boolean }): Promise<void>;
  /** ALTER TABLE ADD COLUMN; NOT NULL columns need a serializable default to backfill. */
  addColumn(meta: ModelMeta, field: Field): Promise<void>;
  /** ALTER TABLE DROP COLUMN, falling back to a table rebuild where unsupported. */
  removeColumn(meta: ModelMeta, field: Field): Promise<void>;
  /** Change a column's definition — on SQLite this is the rebuild dance (design 10.4). */
  alterColumn(newMeta: ModelMeta, oldField: Field, newField: Field): Promise<void>;
  renameColumn(table: string, oldColumn: string, newColumn: string): Promise<void>;
  renameTable(oldName: string, newName: string): Promise<void>;
  /** Create / drop the auto through-table of an M2M field. */
  createManyToMany(meta: ModelMeta, field: Field): Promise<void>;
  dropManyToMany(meta: ModelMeta, field: Field, opts?: { ifExists?: boolean }): Promise<void>;
  /**
   * Record the SQL the callback would execute instead of executing it
   * (powers `dorm sqlmigrate`). Returns the collected statements.
   */
  collect(fn: (editor: SchemaEditor) => Promise<void>): Promise<string[]>;
}

export interface Backend {
  readonly vendor: string;
  readonly schema: SchemaEditor;

  /** Run a query and return result rows as plain objects. */
  execute(sql: string, params?: SqlValue[]): Promise<Record<string, unknown>[]>;
  /** Run a statement that mutates rows; returns affected-row / insert-id info. */
  run(sql: string, params?: SqlValue[]): Promise<RunResult>;
  /** Run raw DDL / pragmas (no parameters, no result). Sync on sqlite, async on servers. */
  exec(sql: string): void | Promise<void>;

  /** Quote an identifier (table or column name) for this dialect. */
  quoteName(name: string): string;

  /* ----- dialect surface (consumed by the compiler & shared layers) -------- */

  /** INSERT and return the auto-generated PK (RETURNING on PG; insert id elsewhere). */
  runInsert(
    sql: string,
    params: SqlValue[],
    pkColumn: string,
  ): Promise<{ insertedPk: unknown; changes: number }>;
  /** Full duplicate-ignoring INSERT statement with one placeholder per column. */
  sqlInsertIgnore(table: string, columns: string[]): string;
  /** INSERT with no explicit columns (all defaults). */
  sqlEmptyInsert(table: string): string;
  /** Current timestamp expression. */
  sqlNow(): string;
  /** Regex-match predicate over an already-quoted column and a bound placeholder. */
  sqlRegex(column: string, placeholder: string, caseInsensitive: boolean): string;
  /** Predicate comparing the date part of a column to a placeholder. */
  sqlDateOnly(column: string, placeholder: string): string;
  /** Integer year/month/day extraction expression for a column. */
  sqlDatePart(part: "year" | "month" | "day", column: string): string;
  /** The LIKE operator that compares case-SENSITIVELY in this dialect. */
  sqlSensitiveLike(): string;
  /** The ESCAPE clause spelling for LIKE patterns escaped with backslash. */
  sqlLikeEscape(): string;
  /** String concatenation of pre-rendered SQL fragments. */
  sqlConcat(parts: string[]): string;
  /** LIMIT literal required when only OFFSET is present, or null if none needed. */
  sqlLimitForOffsetOnly(): string | null;
  /** Wrap a SELECT in this dialect's EXPLAIN form. */
  sqlExplain(sql: string): string;
  /** `FOR UPDATE` suffix for selectForUpdate(), or "" where row locks don't exist. */
  sqlForUpdate(): string;
  /** Auto-increment PK column DDL fragment (for the migrations recorder table). */
  sqlAutoPkDdl(): string;
  /** Toggle FK enforcement around migrations (no-op where unsupported/unneeded). */
  disableForeignKeys(): Promise<void>;
  enableForeignKeys(): Promise<void>;

  /* ----- transactions (used by `transaction.atomic`) ---------------------- */
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  savepoint(name: string): Promise<void>;
  releaseSavepoint(name: string): Promise<void>;
  rollbackToSavepoint(name: string): Promise<void>;
  /** Serialize top-level transactions on this connection (simple async mutex). */
  lock<T>(fn: () => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/** Map a field's `onDelete` to the SQL referential action (shared across SQL backends). */
export function mapOnDelete(action: string): string {
  switch (action) {
    case "CASCADE":
      return "CASCADE";
    case "PROTECT":
      return "RESTRICT";
    case "SET_NULL":
      return "SET NULL";
    case "SET_DEFAULT":
      return "SET DEFAULT";
    case "DO_NOTHING":
    default:
      return "NO ACTION";
  }
}
