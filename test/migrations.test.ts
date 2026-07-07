/**
 * Migration engine tests (design 10): autodetector, writer round-trip, executor
 * forward/backward, --fake, sqlmigrate SQL collection, alter/rename with data
 * preserved.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defineModel,
  fields,
  connect,
  closeAll,
  getConnection,
  ProjectState,
  autodetectChanges,
  writeMigration,
  loadMigrations,
  finalState,
  MigrationExecutor,
  MigrationRecorder,
  allModels,
} from "../src/index.ts";

// The "current models" for this test project.
const Author = defineModel(
  "Author",
  {
    name: fields.CharField({ maxLength: 100 }),
    email: fields.EmailField({ unique: true }),
  },
  { dbTable: "authors", ordering: ["name"] },
);

const Book = defineModel("Book", {
  title: fields.CharField({ maxLength: 200 }),
  author: fields.ForeignKey(() => Author, { onDelete: "CASCADE", relatedName: "books" }),
});

let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "dorm-migrations-"));
  await connect({ engine: "sqlite", name: ":memory:" });
});

after(async () => {
  await closeAll();
  rmSync(dir, { recursive: true, force: true });
});

async function tableNames(): Promise<string[]> {
  const rows = await getConnection().execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  return rows.map((r) => String(r.name));
}

async function columnNames(table: string): Promise<string[]> {
  const rows = await getConnection().execute(`PRAGMA table_info("${table}")`);
  return rows.map((r) => String(r.name));
}

describe("autodetector + writer + executor", () => {
  test("initial makemigrations detects createModel in dependency order", async () => {
    const changes = await autodetectChanges(
      new ProjectState(),
      ProjectState.fromModels(allModels()),
    );
    assert.deepEqual(
      changes.map((op) => op.kind),
      ["createModel", "createModel"],
    );
    // Author (FK target) must be created before Book.
    assert.match(changes[0]!.describe(), /Author/);
    assert.match(changes[1]!.describe(), /Book/);

    const { name, path } = writeMigration(dir, changes);
    assert.equal(name, "0001_initial");
    assert.match(readFileSync(path, "utf8"), /ops\.createModel\("Author"/);
  });

  test("the written file loads and replays to a state equal to the models", async () => {
    const loaded = await loadMigrations(dir);
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0]!.dependencies, []);
    const replayed = finalState(loaded);
    const current = ProjectState.fromModels(allModels());
    // No further changes detected -> states are equivalent.
    const changes = await autodetectChanges(replayed, current);
    assert.deepEqual(changes, []);
  });

  test("migrate applies the migration: tables + recorder rows exist", async () => {
    const backend = getConnection();
    const executor = new MigrationExecutor(backend, await loadMigrations(dir));
    const result = await executor.migrate();
    assert.deepEqual(result.applied, ["0001_initial"]);

    assert.deepEqual(await tableNames(), ["authors", "book", "dorm_migrations"]);
    assert.deepEqual(await new MigrationRecorder(backend).applied(), ["0001_initial"]);

    // Re-running is a no-op.
    const again = await executor.migrate();
    assert.deepEqual(again.applied, []);
  });

  test("addField is detected, applied, and reversible; data survives", async () => {
    const backend = getConnection();
    await backend.run(`INSERT INTO "authors" ("name", "email") VALUES (?, ?)`, [
      "Jane",
      "jane@x.com",
    ]);

    // Simulate adding Author.age to the models by mutating a copy of the state.
    const to = ProjectState.fromModels(allModels());
    to.getModel("Author").fields.push(["age", { type: "IntegerField", options: { null: true } }]);

    const changes = await autodetectChanges(finalState(await loadMigrations(dir)), to);
    assert.deepEqual(
      changes.map((op) => op.kind),
      ["addField"],
    );
    writeMigration(dir, changes, { name: "author_age" });

    const executor = new MigrationExecutor(backend, await loadMigrations(dir));
    await executor.migrate();
    assert.ok((await columnNames("authors")).includes("age"));

    // Backward to 0001: column removed, data still present.
    await executor.migrate({ target: "0001" });
    assert.ok(!(await columnNames("authors")).includes("age"));
    const rows = (await backend.execute(`SELECT name FROM "authors"`)).map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ name: "Jane" }]);

    // Forward again for later tests.
    await executor.migrate();
  });

  test("alterField triggers the rebuild dance and preserves rows", async () => {
    const backend = getConnection();
    const from = finalState(await loadMigrations(dir));
    const to = from.clone();
    const fieldsArr = to.getModel("Author").fields;
    const nameIdx = fieldsArr.findIndex(([n]) => n === "name");
    fieldsArr[nameIdx] = ["name", { type: "CharField", options: { maxLength: 255 } }];

    const changes = await autodetectChanges(from, to);
    assert.deepEqual(
      changes.map((op) => op.kind),
      ["alterField"],
    );
    writeMigration(dir, changes, { name: "widen_name" });

    const executor = new MigrationExecutor(backend, await loadMigrations(dir));
    await executor.migrate();
    const rows = (await backend.execute(`SELECT name, email FROM "authors"`)).map((r) => ({
      ...r,
    }));
    assert.deepEqual(rows, [{ name: "Jane", email: "jane@x.com" }]);
  });

  test("renameField (with asker) renames the column and keeps data", async () => {
    const backend = getConnection();
    const from = finalState(await loadMigrations(dir));
    const to = from.clone();
    const fieldsArr = to.getModel("Author").fields;
    const idx = fieldsArr.findIndex(([n]) => n === "age");
    fieldsArr[idx] = ["years", fieldsArr[idx]![1]];

    const changes = await autodetectChanges(from, to, async (q) => {
      assert.match(q, /rename Author\.age to Author\.years/);
      return true;
    });
    assert.deepEqual(
      changes.map((op) => op.kind),
      ["renameField"],
    );
    writeMigration(dir, changes, { name: "rename_age" });

    const executor = new MigrationExecutor(backend, await loadMigrations(dir));
    await executor.migrate();
    const cols = await columnNames("authors");
    assert.ok(cols.includes("years") && !cols.includes("age"));
  });

  test("declined rename falls back to remove + add", async () => {
    const from = finalState(await loadMigrations(dir));
    const to = from.clone();
    const fieldsArr = to.getModel("Author").fields;
    const idx = fieldsArr.findIndex(([n]) => n === "years");
    fieldsArr[idx] = ["seasons", fieldsArr[idx]![1]];

    const changes = await autodetectChanges(from, to); // noAsker says no
    assert.deepEqual(changes.map((op) => op.kind).sort(), ["addField", "removeField"]);
  });

  test("migrate --fake records without touching the schema", async () => {
    const backend = getConnection();
    const from = finalState(await loadMigrations(dir));
    const to = from.clone();
    to.getModel("Book").fields.push([
      "isbn",
      { type: "CharField", options: { maxLength: 13, null: true } },
    ]);
    writeMigration(dir, await autodetectChanges(from, to), { name: "fake_isbn" });

    const executor = new MigrationExecutor(backend, await loadMigrations(dir));
    await executor.migrate({ fake: true });
    assert.ok(!(await columnNames("book")).includes("isbn")); // schema untouched
    const applied = await new MigrationRecorder(backend).applied();
    assert.ok(applied.some((n) => n.includes("fake_isbn"))); // but recorded

    // Clean up the fake so later tests see a consistent state.
    await executor.migrate({ target: "0004", fake: true });
  });

  test("sqlmigrate collects CREATE TABLE SQL without executing", async () => {
    const backend = getConnection();
    const executor = new MigrationExecutor(backend, await loadMigrations(dir));
    const sqls = await executor.collectSql("0001");
    assert.ok(sqls.some((s) => s.includes(`CREATE TABLE "authors"`)));
    assert.ok(sqls.some((s) => s.includes(`CREATE TABLE "book"`)));
  });

  test("migrate zero unapplies everything in reverse", async () => {
    const backend = getConnection();
    const executor = new MigrationExecutor(backend, await loadMigrations(dir));
    await executor.migrate({ target: "zero" });
    assert.deepEqual(await tableNames(), ["dorm_migrations"]);
    assert.deepEqual(await new MigrationRecorder(backend).applied(), []);

    // And forward all the way back up.
    const res = await executor.migrate();
    assert.equal(res.applied.length, readdirSync(dir).length);
    assert.ok((await tableNames()).includes("authors"));
  });
});
