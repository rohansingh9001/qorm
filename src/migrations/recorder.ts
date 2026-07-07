/**
 * Migration recorder: the `dorm_migrations` bookkeeping table (design §10.3 —
 * Django's `django_migrations`). Records `(app, name, applied)` per applied
 * migration; the single implicit app is "main".
 */
import type { Backend } from "../backends/base.ts";

export const MIGRATIONS_TABLE = "dorm_migrations";
export const DEFAULT_APP = "main";

export class MigrationRecorder {
  private readonly backend: Backend;
  constructor(backend: Backend) {
    this.backend = backend;
  }

  private q(s: string): string {
    return this.backend.quoteName(s);
  }

  async ensureTable(): Promise<void> {
    await this.backend.exec(
      `CREATE TABLE IF NOT EXISTS ${this.q(MIGRATIONS_TABLE)} (` +
        `${this.backend.sqlAutoPkDdl()}, ` +
        `${this.q("app")} TEXT NOT NULL, ` +
        `${this.q("name")} TEXT NOT NULL, ` +
        `${this.q("applied")} TEXT NOT NULL)`,
    );
  }

  /** Names of applied migrations, in application order. */
  async applied(app = DEFAULT_APP): Promise<string[]> {
    await this.ensureTable();
    const rows = await this.backend.execute(
      `SELECT ${this.q("name")} AS name FROM ${this.q(MIGRATIONS_TABLE)} WHERE ${this.q("app")} = ? ORDER BY ${this.q("id")}`,
      [app],
    );
    return rows.map((r) => String(r.name));
  }

  async record(name: string, app = DEFAULT_APP): Promise<void> {
    await this.ensureTable();
    await this.backend.run(
      `INSERT INTO ${this.q(MIGRATIONS_TABLE)} (${this.q("app")}, ${this.q("name")}, ${this.q("applied")}) VALUES (?, ?, ?)`,
      [app, name, new Date().toISOString()],
    );
  }

  async unrecord(name: string, app = DEFAULT_APP): Promise<void> {
    await this.ensureTable();
    await this.backend.run(
      `DELETE FROM ${this.q(MIGRATIONS_TABLE)} WHERE ${this.q("app")} = ? AND ${this.q("name")} = ?`,
      [app, name],
    );
  }
}
