# Design Doc: dorm — A Django-Style ORM for Node.js

> **Status:** Draft
> **Target runtime:** Node.js 20+ (LTS), TypeScript-first, usable from plain JS
> **Goal:** A 1:1 port of Django's ORM ergonomics — declarative model classes, a lazy chainable `QuerySet`, related managers, and a `manage`-style CLI for migrations — without requiring any web framework.

---

## 1. Motivation

Node.js has many ORMs (Prisma, Sequelize, TypeORM, Objection), but none replicate Django's ORM exactly. Django's ORM is loved for:

- **Declarative models** — a class defines schema, behavior, and metadata in one place.
- **Lazy, chainable `QuerySet`** — queries build up and only hit the DB when evaluated.
- **Related managers** — `author.books.filter(...)` traverses relations naturally.
- **Auto-generated migrations** — schema changes are diffed from models, not hand-written.
- **A single integrated CLI** (`manage.py`) for migrate / makemigrations / shell / dbshell.

This project (`dorm`) aims to reproduce that experience faithfully in Node.js. The mental model, method names, lookup syntax, and migration workflow should feel identical to a Django developer. Where JavaScript language constraints differ from Python, we document the deviation explicitly rather than inventing a new paradigm.

### Non-goals

- We are **not** building a web framework, admin site, templating, or auth. Just the ORM + migrations + a shell.
- We are **not** targeting 100% feature parity on day one — see the phased roadmap (§12). We target *API-shape* parity so code reads like Django.

---

## 2. Guiding Principles

1. **Parity over novelty.** When in doubt, copy Django's name and behavior (`filter`, `exclude`, `get`, `values`, `annotate`, `F`, `Q`, `__gte`).
2. **Lazy by default.** A `QuerySet` is never executed until iterated, awaited, or sliced.
3. **Explicit deviations.** Every place JS forces a divergence (no metaclasses, no operator overloading, no `__init_subclass__`) is documented and given the closest idiomatic equivalent.
4. **Zero web dependencies.** The core package depends only on a DB driver and a query builder; nothing HTTP-related.
5. **Type-safe but optional.** Full TypeScript inference for fields and relations, but the library runs untyped in plain JS too.

---

## 3. High-Level Architecture

```
+-------------------------------------------------------------+
|                          User Code                          |
|   models/*.ts   migrations/*.ts   dorm.config.ts         |
+-----------------------------+-------------------------------+
                              |
            +-----------------v-----------------+
            |            Public API             |
            |  Model, Field types, Q, F, Func   |
            +-----------------+-----------------+
                              |
   +-----------+--------------+--------------+-------------+
   |           |              |              |             |
+--v---+  +----v----+   +-----v-----+  +-----v-----+  +----v-----+
|Model |  |QuerySet |   |  Manager  |  | Migration |  |   CLI    |
|Meta  |  | (lazy)  |   |  / Related|  |  Engine   |  | (dorm)|
+--+---+  +----+----+   +-----+-----+  +-----+-----+  +----+-----+
   |           |              |              |             |
   +-----------+------+-------+--------------+-------------+
                      |
              +-------v--------+
              | Query Compiler |   (AST -> SQL per backend)
              +-------+--------+
                      |
              +-------v--------+
              |   Backends     |  postgres | mysql | sqlite
              +-------+--------+
                      |
              +-------v--------+
              |   DB Driver    |  pg | mysql2 | better-sqlite3
              +----------------+
```

**Layer responsibilities**

- **Public API:** what users import. Mirrors `django.db.models`.
- **Model + Meta:** registry of fields, options, and the bound default manager.
- **QuerySet:** immutable, lazy, chainable query representation.
- **Manager / RelatedManager:** entry point to querysets; relation traversal.
- **Query Compiler:** turns the internal query AST into parameterized SQL.
- **Backends:** dialect-specific SQL generation and type mapping.
- **Migration Engine:** model-state diffing, migration files, dependency graph, apply/unapply.
- **CLI:** the `manage.py` analogue.

---

## 4. Defining Models

### 4.1 Django reference

```python
from django.db import models

class Author(models.Model):
    name = models.CharField(max_length=100)
    email = models.EmailField(unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]
        db_table = "authors"

    def __str__(self):
        return self.name
```

### 4.2 dorm equivalent

JavaScript has no metaclasses, so model fields are declared as **static class properties** and the base `Model` class wires them up at definition time (via a registration call). We use a decorator-free, explicit style so it works in plain JS and TS alike.

```typescript
import { Model, fields, Meta } from "dorm";

class Author extends Model {
  static name = fields.CharField({ maxLength: 100 });
  static email = fields.EmailField({ unique: true });
  static createdAt = fields.DateTimeField({ autoNowAdd: true });

  static meta: Meta = {
    ordering: ["name"],
    dbTable: "authors",
  };

  toString() {
    return this.name;
  }
}

Author.register(); // binds manager, validates fields, adds to app registry
```

**Deviation note:** Django uses a metaclass to auto-register models and inject the `objects` manager. JS lacks metaclasses, so we require an explicit `Model.register()` (or a `defineModel()` factory — see §4.4) call. The CLI's `makemigrations` autoloads every file under the configured `models/` dir, so registration always runs.

Instance field access (`author.name`) returns values, exactly like Django. The static declaration is the *field descriptor*; the instance holds the *value*. The base class implements this split with per-instance data storage and getters/setters keyed off the registered field map.

### 4.3 Field types (parity table)

| Django | dorm | Notes |
|---|---|---|
| `AutoField` / `BigAutoField` | `AutoField` / `BigAutoField` | implicit `id` PK by default |
| `CharField` | `CharField({ maxLength })` | `maxLength` required |
| `TextField` | `TextField()` | |
| `IntegerField` | `IntegerField()` | |
| `BigIntegerField` | `BigIntegerField()` | maps to JS `bigint` optionally |
| `FloatField` | `FloatField()` | |
| `DecimalField` | `DecimalField({ maxDigits, decimalPlaces })` | string-backed to avoid float drift |
| `BooleanField` | `BooleanField()` | |
| `DateField` | `DateField()` | |
| `DateTimeField` | `DateTimeField({ autoNow, autoNowAdd })` | |
| `EmailField` | `EmailField()` | `CharField` + validator |
| `UUIDField` | `UUIDField()` | |
| `JSONField` | `JSONField()` | native JSON on PG/MySQL, text on SQLite |
| `ForeignKey` | `ForeignKey(() => Author, { onDelete, relatedName })` | lazy ref via thunk |
| `OneToOneField` | `OneToOneField(() => Profile, {...})` | |
| `ManyToManyField` | `ManyToManyField(() => Tag, { through? })` | auto through-table |

**Common field options** mirror Django: `null`, `blank` → `blank` (validation-only), `default`, `unique`, `dbIndex`, `choices`, `primaryKey`, `editable`, `validators`, `verboseName`, `helpText`.

**Deviation note:** Django distinguishes `null` (DB) from `blank` (validation). We keep both with the same meaning. Field thunks (`() => Author`) are required for relations to handle circular imports — Django solves this with string references (`"app.Author"`); we support both the thunk and a string form.

### 4.4 Optional factory style

For teams who dislike static-property classes, a `defineModel` factory provides the same result with cleaner inference:

```typescript
const Author = defineModel("Author", {
  name: fields.CharField({ maxLength: 100 }),
  email: fields.EmailField({ unique: true }),
}, {
  ordering: ["name"],
  dbTable: "authors",
});
```

Both styles compile to the same internal model descriptor. The class style stays closer to Django source; the factory style gives better automatic TS typing of instances.

---

## 5. The QuerySet

The heart of the parity effort. A `QuerySet` is **immutable**, **lazy**, and **chainable**, just like Django.

### 5.1 Laziness & evaluation

A queryset does nothing until it is *evaluated*. In Django evaluation triggers are: iteration, `len()`, slicing with a step, `list()`, `bool()`, pickling, `repr()`. In JS we map these to:

| Django trigger | dorm trigger |
|---|---|
| `for x in qs` | `for await (const x of qs)` (async iterator) |
| `list(qs)` | `await qs` (thenable) or `await qs.all()` |
| `len(qs)` | `await qs.count()` (explicit; no implicit length) |
| `bool(qs)` | `await qs.exists()` |
| slicing `qs[5:10]` | `qs.slice(5, 10)` (still lazy; LIMIT/OFFSET) |
| `qs[0]` | `await qs.at(0)` / `await qs.first()` |

**Deviation note:** JS has no operator overloading and no synchronous blocking I/O, so every *materializing* call is `async`. A `QuerySet` is **thenable** — `await qs` returns the array of rows, making `await qs` the analogue of `list(qs)`. Chaining methods (`filter`, `exclude`, …) stays synchronous and returns a new lazy `QuerySet`.

```typescript
const qs = Author.objects
  .filter({ name__startswith: "A" })   // lazy
  .exclude({ email__isnull: true })    // lazy
  .orderBy("-createdAt");              // lazy

const authors = await qs;              // executes now -> Author[]
```

### 5.2 Field lookups

Django's double-underscore lookups are reproduced verbatim as object keys:

```typescript
Author.objects.filter({ age__gte: 18, name__icontains: "smith" });
Book.objects.filter({ author__name__exact: "Tolkien" }); // relation spanning
```

Supported lookups (Phase 1): `exact`, `iexact`, `contains`, `icontains`, `in`, `gt`, `gte`, `lt`, `lte`, `startswith`, `istartswith`, `endswith`, `iendswith`, `range`, `date`, `year`, `month`, `day`, `isnull`, `regex`, `iregex`.

**Deviation note:** Python kwargs become a single options object. `filter(name="x")` → `filter({ name: "x" })`. Relation spanning (`author__name`) works identically as a string key.

### 5.3 Core QuerySet methods (parity)

**Return new querysets (lazy):**
`filter`, `exclude`, `annotate`, `alias`, `orderBy`, `reverse`, `distinct`, `values`, `valuesList`, `none`, `all`, `union`, `intersection`, `difference`, `selectRelated`, `prefetchRelated`, `extra`, `defer`, `only`, `using`, `selectForUpdate`.

**Evaluate / return non-queryset:**
`get`, `create`, `getOrCreate`, `updateOrCreate`, `bulkCreate`, `bulkUpdate`, `count`, `exists`, `update`, `delete`, `aggregate`, `first`, `last`, `at`, `inBulk`, `iterator`, `explain`.

```typescript
// get — raises DoesNotExist / MultipleObjectsReturned like Django
const a = await Author.objects.get({ email: "x@y.com" });

// getOrCreate -> [instance, created]
const [author, created] = await Author.objects.getOrCreate(
  { email: "x@y.com" },
  { defaults: { name: "X" } },
);

// aggregate
const { avgAge } = await Author.objects.aggregate({ avgAge: Avg("age") });
```

**Deviation note:** `get()` throwing typed exceptions is preserved — each model exposes `Author.DoesNotExist` and `Author.MultipleObjectsReturned` error subclasses, mirroring Django exactly.

### 5.4 `Q` objects and `F` expressions

```typescript
import { Q, F } from "dorm";

Author.objects.filter(Q({ name__startswith: "A" }).or(Q({ name__startswith: "B" })));
Author.objects.filter(Q({ active: true }).and(Q({ age__gte: 18 }).not()));

Book.objects.update({ price: F("price").mul(1.1) });
Book.objects.filter({ stock__lt: F("threshold") });
```

`Q` supports `.and()`, `.or()`, `.not()` (Django uses `&`, `|`, `~`; JS can't overload, so we use methods). `F` supports arithmetic via `.add().sub().mul().div()` and is usable in `filter`, `annotate`, `update`, and aggregates.

**Deviation note:** Operator overloading is impossible in JS, so boolean composition and arithmetic become method chains. Semantics are identical.

### 5.5 Aggregation & annotation functions

`Count`, `Sum`, `Avg`, `Min`, `Max`, `StdDev`, `Variance`, plus database functions `Coalesce`, `Concat`, `Length`, `Lower`, `Upper`, `Now`, `Cast`, `Extract`, `Trunc`, and window support via `Window(...)` with `partitionBy` / `orderBy`. Names match Django's `django.db.models.functions`.

---

## 6. Relations & Related Managers

### 6.1 Forward & reverse access

```typescript
class Book extends Model {
  static title = fields.CharField({ maxLength: 200 });
  static author = fields.ForeignKey(() => Author, {
    onDelete: "CASCADE",
    relatedName: "books",
  });
}

const book = await Book.objects.get({ id: 1 });
const author = await book.author.get();        // forward FK (lazy descriptor)
const books = await author.books.all();        // reverse manager -> QuerySet
await author.books.filter({ title__icontains: "ring" }); // chainable
await author.books.create({ title: "New Book" });        // create through relation
```

**Deviation note:** In Django, `book.author` is the related object directly (lazy DB hit on attribute access). JS has no transparent lazy attribute I/O, so a forward relation is a *descriptor* you await: `await book.author.get()`, or you preload it with `selectRelated("author")` and then access `book.author_cached`. We provide both:

- `await book.author.get()` — explicit fetch.
- After `selectRelated("author")`, the related instance is materialized and accessible synchronously as `book.author` (the descriptor detects the preloaded cache).

### 6.2 ManyToMany

```typescript
class Post extends Model {
  static tags = fields.ManyToManyField(() => Tag, { relatedName: "posts" });
}

await post.tags.add(tag1, tag2);
await post.tags.remove(tag1);
await post.tags.set([tag2, tag3]);
await post.tags.clear();
await post.tags.all();          // QuerySet
```

The through-table is auto-generated unless a `through` model is supplied — identical to Django.

### 6.3 `selectRelated` / `prefetchRelated`

`selectRelated` → SQL JOIN for FK/O2O (single query). `prefetchRelated` → separate query + in-memory join for M2M / reverse FK. Both behave like Django, including nested spanning (`selectRelated("author__publisher")`).

---

## 7. Model Instances: Save, Delete, Lifecycle

```typescript
const a = new Author({ name: "Jane", email: "j@x.com" });
await a.save();                 // INSERT, then a.id populated
a.name = "Jane Doe";
await a.save();                 // UPDATE (dirty-field tracking)
await a.save({ updateFields: ["name"] });
await a.delete();
await a.refreshFromDb();
```

- **Dirty tracking:** `save()` issues UPDATE only for changed fields when possible; full insert on new instances (no PK).
- **`save({ updateFields })`** mirrors Django's `update_fields`.
- **`auto_now` / `auto_now_add`** handled on save.
- **Validation:** `await a.fullClean()` runs field validators and `clean()` hooks (Django's `full_clean`).

### 7.1 Signals (lifecycle hooks)

Django ships `pre_save`, `post_save`, `pre_delete`, `post_delete`, `m2m_changed`, etc. We replicate a `signals` module:

```typescript
import { signals } from "dorm";

signals.postSave.connect(Author, ({ instance, created }) => {
  if (created) console.log("new author", instance.id);
});
```

**Deviation note:** Django signals are global and synchronous; ours support both sync and async receivers (awaited in registration order) since most Node side effects are async.

---

## 8. Transactions

```typescript
import { transaction } from "dorm";

await transaction.atomic(async () => {
  const a = await Author.objects.create({ name: "X", email: "x@y.com" });
  await Book.objects.create({ title: "T", author: a });
  // throws -> full rollback; nested atomic() -> savepoints
});
```

- `transaction.atomic()` maps to Django's `atomic` (with savepoint nesting).
- `selectForUpdate()` for row locks.
- Per-call `using("replica")` selects a configured DB alias.

**Deviation note:** Django's `atomic` works as both decorator and context manager; JS gets the callback form (and an optional explicit `begin()/commit()/rollback()` low-level API). Async context propagation uses `AsyncLocalStorage` so nested ORM calls join the active transaction automatically — no need to thread a connection object through every call.

---

## 9. Configuration

A single config file, analogous to Django's `DATABASES` setting, with no other Django settings required.

```typescript
// dorm.config.ts
import { defineConfig } from "dorm";

export default defineConfig({
  databases: {
    default: {
      engine: "postgres",        // postgres | mysql | sqlite
      name: "mydb",
      user: "postgres",
      password: process.env.DB_PASSWORD,
      host: "127.0.0.1",
      port: 5432,
      options: { pool: { min: 2, max: 10 } },
    },
    replica: { engine: "postgres", name: "mydb", host: "replica.host" },
  },
  models: ["./models/**/*.{ts,js}"],   // autoload globs for registration
  migrations: { dir: "./migrations" },
  apps: ["blog", "accounts"],          // optional logical grouping (Django apps)
});
```

**Deviation note:** Django couples models to "apps" with `INSTALLED_APPS`. Apps are optional here; by default everything is one implicit app. Declaring `apps` enables per-app migration directories and namespacing, matching Django when you want it.

---

## 10. Migrations & the CLI

The `manage.py` analogue is a binary, `dorm`, installed by the package. It auto-discovers `dorm.config.ts`.

### 10.1 Command parity

| Django | dorm | Purpose |
|---|---|---|
| `makemigrations` | `dorm makemigrations` | diff models vs. migration state → new migration file |
| `migrate` | `dorm migrate` | apply unapplied migrations |
| `migrate app 0003` | `dorm migrate <app> <name>` | migrate to a target (forward/back) |
| `sqlmigrate` | `dorm sqlmigrate <app> <name>` | print SQL for a migration |
| `showmigrations` | `dorm showmigrations` | list migrations & applied state |
| `makemigrations --empty` | `dorm makemigrations --empty` | hand-written migration scaffold |
| `migrate --fake` | `dorm migrate --fake` | mark applied without running |
| `squashmigrations` | `dorm squashmigrations` | collapse a range |
| `dbshell` | `dorm dbshell` | open the DB CLI |
| `shell` | `dorm shell` | REPL with models preloaded |
| `inspectdb` | `dorm inspectdb` | generate models from existing schema |
| `flush` | `dorm flush` | empty all tables |
| `check` | `dorm check` | validate models & config |

### 10.2 Migration files

Generated migrations are code (not raw SQL), mirroring Django's operation objects, so they're DB-agnostic and reversible.

```typescript
// migrations/0001_initial.ts
import { Migration, ops } from "dorm";

export default class extends Migration {
  static dependencies = [];

  static operations = [
    ops.createModel("Author", {
      id: ops.fields.BigAutoField({ primaryKey: true }),
      name: ops.fields.CharField({ maxLength: 100 }),
      email: ops.fields.EmailField({ unique: true }),
      createdAt: ops.fields.DateTimeField({ autoNowAdd: true }),
    }, { dbTable: "authors", ordering: ["name"] }),

    ops.createModel("Book", {
      id: ops.fields.BigAutoField({ primaryKey: true }),
      title: ops.fields.CharField({ maxLength: 200 }),
      author: ops.fields.ForeignKey("Author", { onDelete: "CASCADE", relatedName: "books" }),
    }),
  ];
}
```

**Operation types** parity: `createModel`, `deleteModel`, `renameModel`, `addField`, `removeField`, `alterField`, `renameField`, `addIndex`, `removeIndex`, `addConstraint`, `removeConstraint`, `runSql`, `runPython` → `runJs`.

### 10.3 The autodetector

`makemigrations` works exactly like Django: it builds a **project state** by replaying all existing migrations, builds a **current state** from the model definitions, diffs them, and emits operations. It detects renames interactively ("Did you rename `Author.fullName` to `Author.name`? [y/N]"), handles dependency ordering across apps, and writes a numbered file with a dependency link to the previous migration.

State is tracked in a `dorm_migrations` table (Django uses `django_migrations`) recording `(app, name, applied_at)`.

**Deviation note:** Django migrations are Python and can call arbitrary Python in `RunPython`. Ours are TS/JS modules; `runJs(forwardFn, backwardFn)` receives a schema-editor + ORM handle for data migrations. Reversibility rules match Django (irreversible if no backward function).

### 10.4 Schema editor

Each backend implements a `SchemaEditor` (Django's term) translating operations into dialect SQL: `createTable`, `addColumn`, `alterColumnType`, `addForeignKey`, `createIndex`, etc. SQLite's limited `ALTER` is handled via the table-rebuild dance, exactly like Django does.

---

## 11. TypeScript Type Inference

Where Django relies on runtime dynamism, we add compile-time safety **without** changing the API shape:

- Field declarations infer instance value types: `CharField` → `string`, `IntegerField` → `number`, `ForeignKey(() => Author)` → related descriptor typed to `Author`.
- `values(["name", "email"])` returns `{ name: string; email: string }[]`.
- Lookup keys are checked against known fields + lookups where feasible (best-effort; relation spanning may fall back to `string`).
- `create()` / `new Model()` argument objects are typed to required/optional fields based on `null`, `default`, and `autoNow*`.

**Deviation note:** This is purely additive over Django (which is dynamically typed). Plain-JS users lose the checks but keep the full runtime API.

---

## 12. Phased Roadmap

**Phase 1 — Core ORM (MVP)**
Models, fields (scalar + FK/O2O), QuerySet (filter/exclude/get/create/update/delete/orderBy/values), basic lookups, save/delete with dirty tracking, SQLite + Postgres backends, transactions.

**Phase 2 — Relations & migrations**
M2M, related managers, `selectRelated`/`prefetchRelated`, the migration engine + autodetector + CLI (`makemigrations`/`migrate`/`showmigrations`), MySQL backend.

**Phase 3 — Expressions & parity polish**
`Q`/`F`, aggregates, annotations, DB functions, window functions, `getOrCreate`/`updateOrCreate`/`bulkCreate`/`bulkUpdate`, signals, `selectForUpdate`, multi-DB routing.

**Phase 4 — Advanced**
`inspectdb`, `squashmigrations`, deferred/only loading, custom managers & querysets, `extra`/raw SQL escape hatches, `explain`, partial indexes & constraints, schema-level check constraints.

---

## 13. Open Questions

1. **Forward relation access** — should we invest in a Proxy-based scheme to make `book.author` awaitable *and* property-like, or keep the explicit `.get()` to avoid magic? (Leaning explicit + `selectRelated` cache.)
2. **Custom managers** — Django subclasses `Manager` and `QuerySet.as_manager()`. Mirror exactly, or offer a lighter composition API?
3. **Sync facade** — `better-sqlite3` is synchronous; do we expose an optional sync API for SQLite-only use (scripts/tests), or keep everything async for uniformity? (Leaning async-only for parity simplicity.)
4. **Validation depth** — how much of Django's validators / `clean()` ecosystem ships in core vs. a companion package?
5. **App boundaries** — do we enforce Django-style app namespacing for migrations, or keep a flat default and make apps opt-in?

---

## 14. Summary of Intentional Deviations

| Area | Django | dorm | Reason |
|---|---|---|---|
| Model registration | Metaclass auto-register | `Model.register()` / `defineModel()` | No metaclasses in JS |
| Materializing a queryset | Sync (`list(qs)`) | Async (`await qs`) | No blocking I/O |
| Boolean composition | `&` `|` `~` | `.and()` `.or()` `.not()` | No operator overloading |
| `F` arithmetic | `+ - * /` | `.add()` `.sub()` `.mul()` `.div()` | No operator overloading |
| Forward FK access | Attribute lazy-load | `await fk.get()` or `selectRelated` cache | No transparent lazy attr I/O |
| Relation refs | String `"app.Model"` | Thunk `() => Model` or string | Circular imports |
| Data migrations | `RunPython` | `runJs(fwd, back)` | Language |
| Transactions | Decorator + context mgr | Callback + `AsyncLocalStorage` | Async context |
| Signals | Sync global | Sync **or** async receivers | Async side effects |

Everything not in this table is intended to match Django's names and semantics as closely as the language allows.