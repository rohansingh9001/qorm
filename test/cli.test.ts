/**
 * End-to-end CLI test: a real temp project (config + models + sqlite file)
 * driven through `node src/cli.ts` subprocesses — makemigrations, migrate,
 * showmigrations, model evolution, sqlmigrate, check, flush, and migrate zero.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const CLI = resolve("src/cli.ts");
const SRC_INDEX = pathToFileURL(resolve("src/index.ts")).href;

let projectDir: string;
let dbPath: string;

function run(args: string[]): string {
  return execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Run expecting a nonzero exit; returns combined stdout+stderr. */
function runExpectFail(args: string[]): string {
  try {
    run(args);
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    assert.notEqual(err.status, 0);
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  assert.fail(`Expected \`dorm ${args.join(" ")}\` to exit nonzero.`);
}

function writeModels(withBio: boolean): void {
  writeFileSync(
    join(projectDir, "models", "models.mjs"),
    `import { defineModel, fields } from ${JSON.stringify(SRC_INDEX)};

export const Author = defineModel("Author", {
  name: fields.CharField({ maxLength: 100 }),${withBio ? `\n  bio: fields.TextField({ null: true }),` : ""}
}, { dbTable: "authors" });

export const Book = defineModel("Book", {
  title: fields.CharField({ maxLength: 200 }),
  author: fields.ForeignKey("Author", { onDelete: "CASCADE", relatedName: "books" }),
});
`,
  );
}

function tables(): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

before(() => {
  projectDir = mkdtempSync(join(tmpdir(), "dorm-cli-"));
  dbPath = join(projectDir, "app.sqlite");
  mkdirSync(join(projectDir, "models"));
  writeFileSync(
    join(projectDir, "dorm.config.mjs"),
    `export default {
  databases: { default: { engine: "sqlite", name: ${JSON.stringify(dbPath)} } },
  models: ["models/**/*.mjs"],
  migrations: { dir: "./migrations" },
};
`,
  );
  writeModels(false);
});

after(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("dorm CLI", () => {
  test("makemigrations writes 0001_initial", () => {
    const out = run(["makemigrations"]);
    assert.match(out, /0001_initial/);
    assert.match(out, /Create model Author/);
    assert.match(out, /Create model Book/);
    assert.deepEqual(readdirSync(join(projectDir, "migrations")), ["0001_initial.ts"]);
  });

  test("makemigrations again: no changes", () => {
    assert.match(run(["makemigrations"]), /No changes detected/);
  });

  test("migrate applies and creates tables", () => {
    const out = run(["migrate"]);
    assert.match(out, /Applying 0001_initial... OK/);
    assert.deepEqual(tables(), ["authors", "book", "dorm_migrations"]);
  });

  test("showmigrations marks applied", () => {
    assert.match(run(["showmigrations"]), /\[X\] 0001_initial/);
  });

  test("model change -> makemigrations --name -> migrate", () => {
    writeModels(true); // add Author.bio
    const out = run(["makemigrations", "--name", "author_bio"]);
    assert.match(out, /Add field bio to Author/);

    run(["migrate"]);
    const db = new DatabaseSync(dbPath);
    const cols = db.prepare(`PRAGMA table_info("authors")`).all() as Array<{ name: string }>;
    db.close();
    assert.ok(cols.some((c) => c.name === "bio"));
  });

  test("sqlmigrate prints SQL without applying", () => {
    const out = run(["sqlmigrate", "0001"]);
    assert.match(out, /BEGIN;/);
    assert.match(out, /CREATE TABLE "authors"/);
    assert.match(out, /COMMIT;/);
  });

  test("migrate --plan and migrate zero / re-apply", () => {
    assert.match(run(["migrate", "--plan", "zero"]), /Unapply 0002_author_bio[\s\S]*Unapply 0001_initial/);
    const out = run(["migrate", "zero"]);
    assert.match(out, /Unapplying 0002_author_bio... OK/);
    assert.match(out, /Unapplying 0001_initial... OK/);
    assert.deepEqual(tables(), ["dorm_migrations"]);

    run(["migrate"]);
    assert.deepEqual(tables(), ["authors", "book", "dorm_migrations"]);
  });

  test("check passes", () => {
    assert.match(run(["check"]), /no issues \(2 models\)/);
  });

  test("flush requires --yes, then empties tables", () => {
    const db = new DatabaseSync(dbPath);
    db.prepare(`INSERT INTO "authors" ("name") VALUES (?)`).run("Jane");
    db.close();

    assert.match(runExpectFail(["flush"]), /--yes/);
    assert.match(run(["flush", "--yes"]), /Flushed/);

    const db2 = new DatabaseSync(dbPath);
    const n = db2.prepare(`SELECT COUNT(*) AS n FROM "authors"`).get() as { n: number };
    db2.close();
    assert.equal(n.n, 0);
  });

  test("inspectdb emits model code from the live schema", () => {
    const out = run(["inspectdb"]);
    assert.match(out, /defineModel\("Authors"\)?/);
    assert.match(out, /fields\.ForeignKey/);
  });

  test("squashmigrations collapses history; applied DB switches over; fresh DB uses squash", () => {
    const out = run(["squashmigrations"]);
    assert.match(out, /Created squashed migration 0001_squashed_0002_author_bio/);

    // Fully-applied database: squash counts as applied, originals superseded.
    const show = run(["showmigrations"]);
    assert.match(show, /\[X\] 0001_squashed_0002_author_bio \(2 squashed\)/);
    assert.doesNotMatch(show, /\[X\] 0001_initial/);
    assert.match(run(["migrate"]), /No migrations to apply/);

    // Fresh database: only the squash is applied.
    const fresh = join(projectDir, "fresh.sqlite");
    writeFileSync(
      join(projectDir, "dorm.fresh.mjs"),
      `export default {
  databases: { default: { engine: "sqlite", name: ${JSON.stringify(fresh)} } },
  models: ["models/**/*.mjs"],
  migrations: { dir: "./migrations" },
};
`,
    );
    const out2 = run(["migrate", "--config", "dorm.fresh.mjs"]);
    assert.match(out2, /Applying 0001_squashed_0002_author_bio... OK/);
    assert.doesNotMatch(out2, /Applying 0001_initial/);
    const db = new DatabaseSync(fresh);
    const names = (db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>).map((r) => r.name);
    db.close();
    assert.deepEqual(names, ["authors", "book", "dorm_migrations"]);
  });

  test("makemigrations --check exits 1 when changes pending", () => {
    writeFileSync(
      join(projectDir, "models", "extra.mjs"),
      `import { defineModel, fields } from ${JSON.stringify(SRC_INDEX)};
export const Tag = defineModel("Tag", { label: fields.CharField({ maxLength: 30 }) });
`,
    );
    assert.match(runExpectFail(["makemigrations", "--check"]), /Changes detected/);
    rmSync(join(projectDir, "models", "extra.mjs"));
    run(["makemigrations", "--check"]); // exits 0 again
  });
});
