# dorm

A Django-style ORM for Node.js — declarative models, a lazy chainable `QuerySet`,
related managers, auto-generated migrations, and a `manage.py`-style CLI. See
[design_doc.md](design_doc.md) for the full design.

**Three backends:** SQLite (zero-dependency, via Node's built-in `node:sqlite`),
**PostgreSQL** (`pg`), and **MySQL** (`mysql2`) — the server drivers are optional
peer dependencies, loaded only when their engine is configured. Ships as compiled
JavaScript with TypeScript declarations. Requires **Node.js ≥ 22** (the SQLite
backend uses the built-in `node:sqlite`).

## Installation

```bash
npm install dormjs
# Optional server drivers — only for the backend you use:
npm install pg        # PostgreSQL
npm install mysql2    # MySQL 8
```

## Development

```bash
npm ci              # install dev dependencies
npm test            # 140 tests: full stack on SQLite + conformance on PG/MySQL
npm run typecheck   # strict type-check (tsc --noEmit)
npm run build       # compile src/ -> dist/ (.js + .d.ts)
node bin/dorm.js    # the CLI (after npm run build)
```

The Postgres/MySQL conformance suites run against real servers and skip cleanly
when unreachable:

```bash
docker run -d --name dorm-pg -e POSTGRES_USER=dorm -e POSTGRES_PASSWORD=dorm \
  -e POSTGRES_DB=dorm -p 5433:5432 postgres
docker run -d --name dorm-mysql -e MYSQL_ROOT_PASSWORD=dorm -e MYSQL_DATABASE=dorm \
  -e MYSQL_USER=dorm -e MYSQL_PASSWORD=dorm -p 3307:3306 mysql:8
npm test
```

## Quick start

```ts
import { defineModel, fields, Q, F, Count, connect, getConnection } from "dormjs";

const Author = defineModel(
  "Author",
  {
    name: fields.CharField({ maxLength: 100 }),
    email: fields.EmailField({ unique: true }),
    age: fields.IntegerField({ null: true }),
    createdAt: fields.DateTimeField({ autoNowAdd: true }),
  },
  { ordering: ["name"], dbTable: "authors" },
);

const Book = defineModel("Book", {
  title: fields.CharField({ maxLength: 200 }),
  price: fields.DecimalField({ maxDigits: 8, decimalPlaces: 2 }),
  author: fields.ForeignKey(() => Author, { onDelete: "CASCADE", relatedName: "books" }),
  tags: fields.ManyToManyField("Tag", { relatedName: "books" }),
});

await connect({ engine: "sqlite", name: "app.sqlite" });

// Lazy, chainable querysets — nothing runs until you await / iterate
const qs = Author.objects
  .filter({ name__startswith: "J" })     // lazy
  .exclude({ email__isnull: true })      // lazy
  .orderBy("-createdAt");                // lazy
const authors = await qs;                          // executes -> Author[]
for await (const a of qs) console.log(a.name);     // async iteration

// get() raises Author.DoesNotExist / Author.MultipleObjectsReturned
const jane = await Author.objects.get({ email: "jane@x.com" });

// Relation spanning plans JOINs for you — forward, reverse, and M2M
await Book.objects.filter({ author__name: "Tolkien" });
await Author.objects.filter({ books__title__icontains: "ring" });
await Book.objects.filter({ tags__label: "fantasy" });

// Related managers
await jane.books.create({ title: "New Book", price: "9.99" });
await book.tags.add(tag1, tag2);                  // M2M: add/remove/set/clear
await Author.objects.selectRelated("books__author");   // JOIN eager-load
await Author.objects.prefetchRelated("books", "tags"); // batched, no N+1

// Expressions, aggregates, annotations, window functions
await Book.objects.update({ price: F("price").mul(1.1) });
await Book.objects.filter({ stock__lt: F("threshold") });
const { avgPrice } = await Book.objects.aggregate({ avgPrice: Avg("price") });
await Author.objects.annotate({ numBooks: Count("books"), display: Coalesce("nickname", "name") });
await Book.objects.annotate({ rank: Window(Rank(), { partitionBy: ["authorId"], orderBy: ["-price"] }) });

// Transactions with savepoint nesting (AsyncLocalStorage-propagated)
await transaction.atomic(async () => {
  const a = await Author.objects.create({ name: "X", email: "x@y.com" });
  await Book.objects.create({ title: "T", price: "5", author: a });
  // throw -> full rollback; nested atomic() -> savepoints
});

// Signals
signals.postSave.connect(Author, ({ instance, created }) => {
  if (created) console.log("new author", instance.id);
});
```

## Migrations & the CLI

```bash
dorm makemigrations            # diff models vs. migration state -> migration file
dorm makemigrations --name x   #   (--empty, --dry-run, --check also supported)
dorm migrate                   # apply unapplied migrations
dorm migrate 0002              # migrate to a target (forward or backward)
dorm migrate zero              # unapply everything
dorm migrate --fake            # record without running
dorm migrate --plan            # show what would run
dorm showmigrations            # [X] applied / [ ] pending
dorm squashmigrations          # collapse history into one squashed migration
dorm sqlmigrate 0001           # print a migration's SQL without running it
dorm check                     # validate models & config
dorm flush --yes               # empty all model tables
dorm shell                     # REPL with models, Q/F/aggregates, db preloaded
dorm dbshell                   # open sqlite3 on the configured database
dorm inspectdb                 # generate model code from an existing database
```

Configuration lives in `dorm.config.ts` (or `.js`/`.mjs`):

```ts
import { defineConfig } from "dormjs";

export default defineConfig({
  databases: {
    default: {
      engine: "postgres",            // sqlite | postgres | mysql
      name: "mydb",
      user: "postgres",
      password: process.env.DB_PASSWORD,
      host: "127.0.0.1",
      port: 5432,
    },
    replica: { engine: "sqlite", name: "replica.sqlite" },   // Model.objects.using("replica")
  },
  models: ["./models/**/*.{ts,js,mjs}"],   // autoloaded so models register
  migrations: { dir: "./migrations" },
});
```

Migration files are plain code (no imports needed — the `ops` namespace is injected):

```ts
// migrations/0001_initial.ts — generated by `dorm makemigrations`
export default {
  dependencies: [],
  operations: (ops) => [
    ops.createModel("Author", {
      id: ops.fields.BigAutoField({ primaryKey: true }),
      name: ops.fields.CharField({ maxLength: 100 }),
      email: ops.fields.EmailField({ unique: true, maxLength: 254 }),
    }, { dbTable: "authors", ordering: ["name"] }),
    ops.addField("Book", "isbn", ops.fields.CharField({ maxLength: 13, null: true })),
    ops.runSql("UPDATE ...", "REVERSE SQL ..."),                  // raw escape hatch
    ops.runJs(async ({ db }) => { /* data migration */ }),        // Django's RunPython
  ],
};
```

The autodetector handles created/deleted/renamed models and fields (renames ask
interactively, like Django), `alterField` runs SQLite's table-rebuild dance with
data preserved, every operation is reversible (`migrate <older-target>` works),
and state is tracked in a `dorm_migrations` table.

## Feature matrix

**Models & fields** — `defineModel` (typed) or class + `Model.register()`; auto `id`
PK; Auto/BigAuto, Char, Text, Email, UUID, Integer, BigInteger, Float, Decimal
(string-backed), Boolean, Date, DateTime (`autoNow`/`autoNowAdd`), JSON,
ForeignKey, OneToOne, **ManyToMany** (auto through-table, self-referential
supported); validation via `fullClean()`.

**QuerySet** — immutable, lazy, thenable, async-iterable. `filter`, `exclude`,
`orderBy`, `reverse`, `distinct`, `values`, `valuesList`, `none`, `all`, `slice`,
`only`, `defer`, `union`, `intersection`, `difference`, `selectRelated`,
`prefetchRelated`, `annotate`, `using`, `selectForUpdate`; `get`, `first`, `last`,
`at`, `count`, `exists`, `update`, `delete`, `aggregate`, `inBulk`, `iterator`,
`explain`, `create`, `getOrCreate`, `updateOrCreate`, `bulkCreate`, `bulkUpdate`.

**Lookups** — `exact iexact contains icontains in gt gte lt lte startswith
istartswith endswith iendswith range date year month day isnull regex iregex`,
all spanning relations (`author__publisher__name`, `tags__label`, reverse too).

**Expressions** — `Q` (`.and/.or/.not`), `F` (`.add/.sub/.mul/.div`),
`Count/Sum/Avg/Min/Max`, `Lower/Upper/Length/Abs/Round/Coalesce/Concat/Now/Cast/Value`,
`Window` + `RowNumber/Rank/DenseRank` with `partitionBy`/`orderBy`.

**Relations** — forward descriptors (`await book.author.get()`, `.cached` after
`selectRelated`), reverse managers (`author.books.create/add/remove/set/clear`),
M2M managers both directions, prefetch everywhere.

**Runtime** — transactions (`atomic` + savepoints), signals (`preSave/postSave/
preDelete/postDelete/m2mChanged`, sync or async receivers), multi-DB routing
(`using`), dirty-field saves, `save({ updateFields })`, `refreshFromDb`.

**Migrations** — autodetector (incl. interactive renames), reversible operations
(`createModel deleteModel renameModel addField removeField alterField renameField
alterModelTable alterModelOptions runSql runJs`), squashing with `replaces`
semantics, `--fake`, targets, SQL preview, recorder table, historical-state
schema generation.

## Intentional deviations from Django (design 14)

| Area | Django | dorm | Why |
| --- | --- | --- | --- |
| Registration | metaclass | `defineModel()` / `register()` | no metaclasses in JS |
| Materialize | `list(qs)` | `await qs` (thenable) | no sync I/O |
| Boolean composition | `&` `\|` `~` | `.and()` `.or()` `.not()` | no operator overloading |
| `F` arithmetic | `+ - * /` | `.add()` `.sub()` `.mul()` `.div()` | no operator overloading |
| Forward FK | lazy attribute | `await fk.get()` / `selectRelated` cache | no lazy attribute I/O |
| Relation refs | `"app.Model"` | `() => Model` thunk or `"Model"` string | circular imports |
| Migration files | class + imports | import-free `{ dependencies, operations: (ops) => [...] }` | portability |
| Transactions | decorator/context mgr | `atomic(callback)` + `AsyncLocalStorage` | async context |
| Signals | sync | sync **or** async receivers (awaited) | async side effects |

## Backends

| | SQLite | PostgreSQL | MySQL 8 |
| --- | --- | --- | --- |
| Driver | `node:sqlite` (built-in) | `pg` (optional peer dep) | `mysql2` (optional peer dep) |
| Placeholders | `?` | `?` → `$n` rewrite | `?` |
| Auto PK | `AUTOINCREMENT` + rowid | `bigserial` + `RETURNING` | `AUTO_INCREMENT` + insertId |
| `alterField` | table-rebuild dance | native `ALTER COLUMN` | `MODIFY COLUMN` |
| Regex lookups | registered JS function | `~` / `~*` | `REGEXP_LIKE(…, 'c'/'i')` |
| Case-sensitive LIKE | `LIKE` | `LIKE` | `LIKE BINARY` |
| Row locks | accepted, no-op | `FOR UPDATE` | `FOR UPDATE` |
| DDL in transactions | yes | yes | auto-commits (MySQL limitation, as in Django) |

All three run the same conformance suite (CRUD, lookups, JOINs, M2M, aggregates,
window functions, transactions/savepoints, and the migration engine end-to-end).

## Known limits

- **Custom M2M `through` models** throw `NotSupportedError` (auto through-table only).
- **`inspectdb`** supports SQLite only (PG/MySQL introspection not implemented).
- On PG, `SUM`/`AVG` over `numeric`/`bigint` come back as strings (exact-precision
  driver behavior — coerce with `Number(...)` where float precision suffices).
- **only()/defer()** load fields lazily as `undefined` (no transparent re-fetch
  on access — JS has no sync attribute I/O); `refreshFromDb()` restores them.
- **Filtering on annotations** (HAVING) and `alias()`/`extra()` are not implemented;
  raw SQL via `getConnection().execute(sql, params)` is the escape hatch.
- Combined querysets (`union`/…) support `orderBy`/`slice`/`count`/iteration but
  not further `filter()` — same restriction as Django.

## Layout

```text
src/
  index.ts            public API (mirrors django.db.models)
  model.ts            Model base, lifecycle, defineModel/register, relations wiring
  manager.ts          Manager, RelatedManager, ManyRelatedManager
  queryset.ts         lazy QuerySet + CombinedQuerySet (union/intersect/except)
  fields.ts           field descriptors, serialization, the `fields` factory
  expressions.ts      Q, F, aggregates, DB functions, window expressions
  signals.ts          preSave/postSave/preDelete/postDelete/m2mChanged
  transaction.ts      atomic() + savepoints over AsyncLocalStorage
  connection.ts       config + named connection registry
  relations.ts        reverse-relation registry
  registry.ts         model registry (string relation refs)
  errors.ts, types.ts
  query/
    ast.ts            immutable QueryState
    lookups.ts        __ lookup parsing
    compiler.ts       QueryState -> parameterized SQL (JOIN planner, aggregates, windows)
  backends/
    base.ts           Backend + SchemaEditor contracts + the dialect hook surface
    sqlite.ts         node:sqlite backend + schema editor (rebuild dance, SQL collection)
    postgres.ts       pg backend + schema editor (native ALTERs, RETURNING)
    mysql.ts          mysql2 backend + schema editor (MODIFY COLUMN, LIKE BINARY)
  migrations/
    state.ts          ProjectState + historical model synthesis
    operations.ts     all operations + the `ops` namespace
    autodetector.ts   state diffing (+ interactive renames)
    writer.ts         migration file generation (+ squash)
    loader.ts         file loading, state replay, squash resolution
    recorder.ts       dorm_migrations table
    executor.ts       plan/apply/unapply/--fake/sqlmigrate
  cli.ts              the `dorm` command
bin/dorm.js           CLI launcher
test/                 140 tests: core, relations, expressions, m2m, transactions,
                      extras, migrations, CLI end-to-end, and a backend
                      conformance suite run against dockerized Postgres + MySQL
```
