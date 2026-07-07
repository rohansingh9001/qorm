/**
 * Connection configuration and the connection registry.
 *
 * Mirrors Django's `DATABASES` setting (design §9): a map of named aliases, each
 * describing one database. Models resolve their backend by alias ("default"
 * unless `Meta.using` says otherwise). Phase 1 ships the SQLite backend; the
 * Postgres/MySQL engines are recognized but throw until implemented.
 */
import type { Backend } from "./backends/base.ts";
import { SqliteBackend } from "./backends/sqlite.ts";
import { ConnectionError, NotSupportedError } from "./errors.ts";

export type Engine = "sqlite" | "postgres" | "mysql";

export interface DatabaseConfig {
  engine: Engine;
  /** File path (sqlite, or ":memory:") or database name (postgres/mysql). */
  name: string;
  user?: string;
  password?: string;
  host?: string;
  port?: number;
  options?: Record<string, unknown>;
}

export interface DormConfig {
  databases: Record<string, DatabaseConfig>;
  /** Autoload globs for model registration (used by the CLI; design §9). */
  models?: string[];
  migrations?: { dir: string };
  /** Optional Django-style app grouping. */
  apps?: string[];
}

/** Identity helper that gives `dorm.config.ts` full type-checking (design §9). */
export function defineConfig(config: DormConfig): DormConfig {
  return config;
}

const connections = new Map<string, Backend>();

export function setConnection(alias: string, backend: Backend): void {
  connections.set(alias, backend);
}

export function getConnection(alias = "default"): Backend {
  const c = connections.get(alias);
  if (!c) {
    throw new ConnectionError(
      `No database connection registered for alias "${alias}". ` +
        `Call connect(...) or configure(...) before using the ORM.`,
    );
  }
  return c;
}

export function hasConnection(alias = "default"): boolean {
  return connections.has(alias);
}

/**
 * Build a backend for one database config. Server backends load lazily so the
 * core stays dependency-free: `pg` / `mysql2` are only imported (and only
 * required to be installed) when their engine is actually configured.
 */
export async function createBackend(cfg: DatabaseConfig): Promise<Backend> {
  switch (cfg.engine) {
    case "sqlite":
      return new SqliteBackend(cfg.name || ":memory:");
    case "postgres": {
      const mod = await importBackend("./backends/postgres.ts", "postgres", "pg");
      return new (mod as typeof import("./backends/postgres.ts")).PostgresBackend({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: cfg.name,
      });
    }
    case "mysql": {
      const mod = await importBackend("./backends/mysql.ts", "mysql", "mysql2");
      return new (mod as typeof import("./backends/mysql.ts")).MysqlBackend({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: cfg.name,
      });
    }
    default:
      throw new NotSupportedError(`Unknown database engine "${(cfg as { engine?: string }).engine}".`);
  }
}

async function importBackend(path: string, engine: string, driver: string): Promise<unknown> {
  try {
    return await import(path);
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
      throw new NotSupportedError(
        `The "${engine}" engine requires the "${driver}" package. Install it with: npm install ${driver}`,
      );
    }
    throw e;
  }
}

/** Build every connection in a config and return the default backend. */
export async function configure(config: DormConfig): Promise<Backend> {
  for (const [alias, cfg] of Object.entries(config.databases)) {
    setConnection(alias, await createBackend(cfg));
  }
  return getConnection("default");
}

/** Convenience for scripts/tests: register a single connection under one alias. */
export async function connect(cfg: DatabaseConfig, alias = "default"): Promise<Backend> {
  const backend = await createBackend(cfg);
  setConnection(alias, backend);
  return backend;
}

/** Close and forget all connections (test teardown). */
export async function closeAll(): Promise<void> {
  for (const c of connections.values()) await c.close();
  connections.clear();
}
