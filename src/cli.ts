/**
 * The `dorm` CLI — the `manage.py` analogue (design §10.1).
 *
 *   dorm makemigrations [--name n] [--empty] [--dry-run] [--check]
 *   dorm migrate [target|zero] [--fake] [--plan]
 *   dorm showmigrations
 *   dorm sqlmigrate <name>
 *   dorm check
 *   dorm flush [--yes]
 *   dorm shell
 *   dorm dbshell
 *   dorm inspectdb
 *
 * Config is discovered as dorm.config.{ts,js,mjs} in the working directory
 * (or via --config <path>). `models` globs are imported so model modules
 * register themselves; `migrations.dir` locates the migration files.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import repl from "node:repl";

import { configure, closeAll, type DormConfig } from "./connection.ts";
import { getConnection } from "./connection.ts";
import { allModels } from "./registry.ts";
import { ProjectState, StateApps } from "./migrations/state.ts";
import { autodetectChanges, noAsker, type Asker } from "./migrations/autodetector.ts";
import { writeMigration, writeSquashedMigration, renderMigration, nextMigrationName } from "./migrations/writer.ts";
import { loadMigrations, finalState, resolveSquashes } from "./migrations/loader.ts";
import { MigrationExecutor } from "./migrations/executor.ts";
import { MigrationRecorder, MIGRATIONS_TABLE } from "./migrations/recorder.ts";
import { Q, F, Count, Sum, Avg, Min, Max } from "./expressions.ts";
import { transaction } from "./transaction.ts";
import type { SqliteBackend } from "./backends/sqlite.ts";
import { ManyToManyField } from "./fields.ts";

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--") && ["config", "name"].includes(key)) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

/* ----------------------------------------------------------------------------
 * Config + model loading
 * ------------------------------------------------------------------------- */

const CONFIG_NAMES = ["dorm.config.ts", "dorm.config.js", "dorm.config.mjs"];

function findConfigPath(flag: string | undefined): string {
  if (flag) {
    const p = resolve(flag);
    if (!existsSync(p)) fail(`Config file not found: ${p}`);
    return p;
  }
  for (const name of CONFIG_NAMES) {
    const p = resolve(process.cwd(), name);
    if (existsSync(p)) return p;
  }
  fail(`No ${CONFIG_NAMES.join(" / ")} found in ${process.cwd()} (or pass --config <path>).`);
}

async function loadConfig(flag: string | undefined): Promise<{ config: DormConfig; dir: string }> {
  const path = findConfigPath(flag);
  const mod = (await import(pathToFileURL(path).href)) as { default?: DormConfig };
  if (!mod.default || typeof mod.default !== "object" || !("databases" in mod.default)) {
    fail(`${path} must default-export a defineConfig({ databases, ... }) object.`);
  }
  return { config: mod.default, dir: dirname(path) };
}

/**
 * Minimal glob over a base directory (skips node_modules and dotdirs).
 * `**` / matches zero or more directories; `*` matches within one segment.
 */
function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, "");
  // Tokenize the wildcards first so escaping can't mangle them.
  const GLOBSTAR_SLASH = "";
  const GLOBSTAR = "";
  const STAR = "";
  const tokenized = normalized.replaceAll("**/", GLOBSTAR_SLASH).replaceAll("**", GLOBSTAR).replaceAll("*", STAR);
  const escaped = tokenized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replaceAll(GLOBSTAR_SLASH, "(?:.*/)?") // zero or more whole directories
    .replaceAll(GLOBSTAR, ".*")
    .replaceAll(STAR, "[^/]*");
  return new RegExp(`^${body}$`);
}

function expandGlob(pattern: string, baseDir: string): string[] {
  const regex = globToRegex(pattern);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (regex.test(relative(baseDir, full).replaceAll("\\", "/"))) out.push(full);
    }
  };
  walk(baseDir);
  return out.sort();
}

async function loadModels(config: DormConfig, configDir: string): Promise<void> {
  for (const pattern of config.models ?? []) {
    const files = expandGlob(pattern, configDir);
    for (const file of files) await import(pathToFileURL(file).href);
  }
}

function migrationsDir(config: DormConfig, configDir: string): string {
  const dir = config.migrations?.dir ?? "./migrations";
  return isAbsolute(dir) ? dir : resolve(configDir, dir);
}

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function ttyAsker(): Asker {
  if (!process.stdin.isTTY) return noAsker;
  return (question) =>
    new Promise((res) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${question} [y/N] `, (answer) => {
        rl.close();
        res(/^y(es)?$/i.test(answer.trim()));
      });
    });
}

/* ----------------------------------------------------------------------------
 * Commands
 * ------------------------------------------------------------------------- */

async function cmdMakemigrations(args: Args, config: DormConfig, configDir: string): Promise<void> {
  const dir = migrationsDir(config, configDir);
  const loaded = await loadMigrations(dir);
  // Replay through squashes (either branch yields the same state; prefer the squash).
  const { active } = resolveSquashes(loaded, new Set());
  const fromState = finalState(active);
  const toState = ProjectState.fromModels(allModels());

  if (args.flags.get("empty")) {
    const { path, name } = writeMigration(dir, [], { name: (args.flags.get("name") as string) ?? "custom" });
    console.log(`Created empty migration ${name} at ${path}`);
    return;
  }

  const changes = await autodetectChanges(fromState, toState, ttyAsker());
  if (changes.length === 0) {
    console.log("No changes detected.");
    if (args.flags.get("check")) process.exit(0);
    return;
  }
  if (args.flags.get("check")) {
    console.log(`Changes detected (${changes.length} operations).`);
    process.exit(1);
  }
  if (args.flags.get("dry-run")) {
    const { name } = nextMigrationName(dir, args.flags.get("name") as string | undefined);
    console.log(`Would create ${name}:`);
    for (const op of changes) console.log(`  - ${op.describe()}`);
    console.log("\n" + renderMigration(changes, []));
    return;
  }
  const { path, name } = writeMigration(dir, changes, { name: args.flags.get("name") as string | undefined });
  console.log(`Migrations for 'main':\n  ${path}`);
  for (const op of changes) console.log(`    - ${op.describe()}`);
  void name;
}

async function cmdMigrate(args: Args, config: DormConfig, configDir: string): Promise<void> {
  const backend = getConnection();
  const dir = migrationsDir(config, configDir);
  const migrations = await loadMigrations(dir);
  const executor = new MigrationExecutor(backend, migrations);
  const target = args.positional[0];

  if (args.flags.get("plan")) {
    const plan = await executor.plan(target);
    if (plan.length === 0) console.log("No planned migration operations.");
    for (const step of plan) {
      console.log(`  ${step.direction === "forward" ? "Apply" : "Unapply"} ${step.migration.name}`);
    }
    return;
  }

  const fake = args.flags.get("fake") === true;
  const result = await executor.migrate({ target, fake });
  if (result.applied.length === 0 && result.unapplied.length === 0) {
    console.log("No migrations to apply.");
    return;
  }
  for (const name of result.unapplied) console.log(`  Unapplying ${name}...${fake ? " FAKED" : " OK"}`);
  for (const name of result.applied) console.log(`  Applying ${name}...${fake ? " FAKED" : " OK"}`);
}

async function cmdShowmigrations(config: DormConfig, configDir: string): Promise<void> {
  const backend = getConnection();
  const dir = migrationsDir(config, configDir);
  const all = await loadMigrations(dir);
  const applied = new Set(await new MigrationRecorder(backend).applied());
  const { active, impliedApplied } = resolveSquashes(all, applied);
  console.log("main");
  if (active.length === 0) console.log("  (no migrations)");
  for (const m of active) {
    const mark = applied.has(m.name) || impliedApplied.has(m.name) ? "X" : " ";
    const note = m.replaces.length > 0 ? ` (${m.replaces.length} squashed)` : "";
    console.log(`  [${mark}] ${m.name}${note}`);
  }
}

async function cmdSquashmigrations(config: DormConfig, configDir: string): Promise<void> {
  const dir = migrationsDir(config, configDir);
  const all = await loadMigrations(dir);
  const normals = all.filter((m) => m.replaces.length === 0);
  if (all.some((m) => m.replaces.length > 0)) {
    fail("A squashed migration already exists. Delete the replaced files once fully migrated, then squash again.");
  }
  if (normals.length < 2) fail("Need at least two migrations to squash.");

  // The squash recreates the final state from scratch: createModel ops in dependency order.
  const target = finalState(normals);
  const operations = await autodetectChanges(new ProjectState(), target, noAsker);
  const replaces = normals.map((m) => m.name);
  const { path, name } = writeSquashedMigration(dir, operations, replaces);
  console.log(`Created squashed migration ${name} at ${path}`);
  console.log(`It replaces: ${replaces.join(", ")}`);
  console.log(
    "Databases with the full history applied will switch to it automatically;\n" +
      "fresh databases will apply only the squash. Once every database has\n" +
      "transitioned, you can delete the replaced migration files.",
  );
}

async function cmdSqlmigrate(args: Args, config: DormConfig, configDir: string): Promise<void> {
  const name = args.positional[0];
  if (!name) fail("Usage: dorm sqlmigrate <migration-name-or-prefix>");
  const backend = getConnection();
  const migrations = await loadMigrations(migrationsDir(config, configDir));
  const executor = new MigrationExecutor(backend, migrations);
  const sqls = await executor.collectSql(name);
  console.log("BEGIN;");
  for (const sql of sqls) console.log(`${sql};`);
  console.log("COMMIT;");
}

async function cmdCheck(config: DormConfig, configDir: string): Promise<void> {
  const models = allModels();
  for (const model of models) {
    for (const f of model.meta.fieldList) {
      if (f.isRelation) {
        (f as unknown as { getRelatedModel(): unknown }).getRelatedModel(); // throws on bad refs
      }
    }
  }
  // Validate the state machinery can synthesize every model.
  const state = ProjectState.fromModels(models);
  const apps = new StateApps(state);
  for (const model of models) apps.metaFor(model.modelName);
  void config;
  void configDir;
  console.log(`System check identified no issues (${models.length} models).`);
}

async function cmdFlush(args: Args): Promise<void> {
  const backend = getConnection();
  if (args.flags.get("yes") !== true) {
    fail("This will delete ALL rows from every model table. Re-run with --yes to confirm.");
  }
  const q = (s: string) => backend.quoteName(s);
  const tables: string[] = [];
  for (const model of allModels()) {
    tables.push(model.meta.dbTable);
    for (const f of model.meta.fieldList) {
      if (f instanceof ManyToManyField) tables.push(f.throughTable());
    }
  }
  await backend.disableForeignKeys();
  await transaction.atomicOn(backend, async () => {
    for (const t of tables) await backend.run(`DELETE FROM ${q(t)}`);
    if (backend.vendor === "sqlite") {
      // Reset SQLite's AUTOINCREMENT counters too.
      const seq = await backend.execute(`SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'`);
      if (seq.length > 0) {
        await backend.run(
          `DELETE FROM sqlite_sequence WHERE name IN (${tables.map(() => "?").join(", ")})`,
          tables,
        );
      }
    }
  });
  await backend.enableForeignKeys();
  console.log(`Flushed ${tables.length} tables.`);
}

async function cmdShell(): Promise<void> {
  const models = allModels();
  console.log(`dorm shell — models: ${models.map((m) => m.modelName).join(", ") || "(none)"}`);
  console.log(`Also available: Q, F, Count, Sum, Avg, Min, Max, transaction, db`);
  const server = repl.start({ prompt: "dorm> " });
  for (const model of models) server.context[model.modelName] = model;
  Object.assign(server.context, { Q, F, Count, Sum, Avg, Min, Max, transaction, db: getConnection() });
}

function cmdDbshell(config: DormConfig): void {
  const db = config.databases.default;
  if (!db) fail("No default database configured.");
  let cmd: string;
  let args: string[];
  let env = process.env;
  switch (db.engine) {
    case "sqlite":
      cmd = "sqlite3";
      args = [db.name];
      break;
    case "postgres":
      cmd = "psql";
      args = ["-h", db.host ?? "127.0.0.1", "-p", String(db.port ?? 5432), "-U", db.user ?? "postgres", db.name];
      if (db.password) env = { ...process.env, PGPASSWORD: db.password };
      break;
    case "mysql":
      cmd = "mysql";
      args = ["-h", db.host ?? "127.0.0.1", "-P", String(db.port ?? 3306), "-u", db.user ?? "root", db.name];
      if (db.password) args.splice(args.length - 1, 0, `-p${db.password}`);
      break;
    default:
      fail(`dbshell does not support engine "${(db as { engine?: string }).engine}".`);
  }
  const r = spawnSync(cmd, args, { stdio: "inherit", env });
  if (r.error) fail(`Could not launch ${cmd}: ${r.error.message}`);
  process.exit(r.status ?? 0);
}

async function cmdInspectdb(): Promise<void> {
  if (getConnection().vendor !== "sqlite") {
    fail(`inspectdb currently supports sqlite only (got "${getConnection().vendor}").`);
  }
  const backend = getConnection() as SqliteBackend;
  const tables = await backend.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ?`,
    [MIGRATIONS_TABLE],
  );
  console.log(`// Auto-generated by \`dorm inspectdb\` — inspect and edit before use.`);
  console.log(`import { defineModel, fields } from "dorm";\n`);
  for (const { name } of tables as Array<{ name: string }>) {
    const cols = backend.pragmaTableInfo(name);
    const fks = await backend.execute(`PRAGMA foreign_key_list(${backend.quoteName(name)})`);
    const fkByCol = new Map((fks as Array<Record<string, unknown>>).map((f) => [String(f.from), f]));
    const modelName = name.charAt(0).toUpperCase() + name.slice(1);
    console.log(`export const ${modelName} = defineModel("${modelName}", {`);
    for (const col of cols) {
      const colName = String(col.name);
      const type = String(col.type ?? "").toUpperCase();
      const notNull = Number(col.notnull) === 1;
      const isPk = Number(col.pk) > 0;
      if (isPk && type === "INTEGER") continue; // implicit auto id
      const fk = fkByCol.get(colName);
      let def: string;
      if (fk) {
        const target = String(fk.table);
        def = `fields.ForeignKey("${target.charAt(0).toUpperCase() + target.slice(1)}", { dbColumn: "${colName}" })`;
      } else if (type.includes("INT")) def = `fields.IntegerField()`;
      else if (type === "REAL" || type.includes("FLOA") || type.includes("DOUB")) def = `fields.FloatField()`;
      else def = `fields.TextField()`;
      const opts = notNull ? "" : " /* null: true */";
      console.log(`  ${colName.replace(/Id$/, "")}: ${def},${opts}`);
    }
    console.log(`}, { dbTable: "${name}" });\n`);
  }
}

function printHelp(): void {
  console.log(`dorm — a Django-style ORM for Node.js

Usage: dorm <command> [options]

Commands:
  makemigrations   Diff models vs. migration state and write a migration file
                   (--name <slug>, --empty, --dry-run, --check)
  migrate          Apply (or unapply, given a target) migrations
                   (dorm migrate [target|zero] [--fake] [--plan])
  showmigrations   List migrations and their applied state
  squashmigrations Collapse the migration history into one squashed migration
  sqlmigrate       Print the SQL for one migration (dorm sqlmigrate <name>)
  check            Validate models and configuration
  flush            Delete all rows from all model tables (--yes)
  shell            REPL with models preloaded
  dbshell          Open the sqlite3 CLI on the configured database
  inspectdb        Generate model code from an existing database

Options:
  --config <path>  Path to dorm.config.{ts,js,mjs} (default: search cwd)
`);
}

/* ----------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------- */

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "help" || args.command === "--help") {
    printHelp();
    return;
  }

  const { config, dir: configDir } = await loadConfig(args.flags.get("config") as string | undefined);
  await configure(config);
  await loadModels(config, configDir);

  // Server-backend sockets keep the event loop alive; close them when the
  // command finishes so the process exits. Interactive commands keep theirs:
  // the shell needs its connection, and dbshell replaces the process.
  const interactive = args.command === "shell" || args.command === "dbshell";
  try {
    switch (args.command) {
      case "makemigrations":
        return await cmdMakemigrations(args, config, configDir);
      case "migrate":
        return await cmdMigrate(args, config, configDir);
      case "showmigrations":
        return await cmdShowmigrations(config, configDir);
      case "squashmigrations":
        return await cmdSquashmigrations(config, configDir);
      case "sqlmigrate":
        return await cmdSqlmigrate(args, config, configDir);
      case "check":
        return await cmdCheck(config, configDir);
      case "flush":
        return await cmdFlush(args);
      case "shell":
        return await cmdShell();
      case "dbshell":
        return cmdDbshell(config);
      case "inspectdb":
        return await cmdInspectdb();
      default:
        printHelp();
        fail(`Unknown command "${args.command}".`);
    }
  } finally {
    if (!interactive) await closeAll();
  }
}

// Run when invoked directly (bin/dorm.js imports and calls main()).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
