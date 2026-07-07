/**
 * End-to-end tests for the Phase 1 core, run against an in-memory SQLite DB via
 * the built-in node:sqlite driver. These exercise the full stack: model
 * definition -> schema -> QuerySet -> compiler -> backend.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { Model, defineModel, fields, Q, connect, closeAll, getConnection } from "../src/index.ts";

/* ----- models ----------------------------------------------------------- */

const Author = defineModel(
  "Author",
  {
    name: fields.CharField({ maxLength: 100 }),
    email: fields.EmailField({ unique: true }),
    age: fields.IntegerField({ null: true }),
    active: fields.BooleanField({ default: true }),
    createdAt: fields.DateTimeField({ autoNowAdd: true }),
  },
  { ordering: ["name"], dbTable: "authors" },
);

const Book = defineModel("Book", {
  title: fields.CharField({ maxLength: 200 }),
  price: fields.DecimalField({ maxDigits: 8, decimalPlaces: 2 }),
  meta: fields.JSONField({ null: true }),
  author: fields.ForeignKey(() => Author, { onDelete: "CASCADE", relatedName: "books" }),
});

// Static-property class style + Model.register() (design 4.2).
class Tag extends Model {
  static label = fields.CharField({ maxLength: 50 });
  static slug = fields.CharField({ maxLength: 50, unique: true });
}
Tag.register({ name: "Tag", ordering: ["slug"] });

before(async () => {
  await connect({ engine: "sqlite", name: ":memory:" });
  const backend = getConnection();
  await backend.schema.createTable(Author.meta);
  await backend.schema.createTable(Book.meta);
  await backend.schema.createTable((Tag as unknown as { meta: typeof Author.meta }).meta);
});

after(async () => {
  await closeAll();
});

/* ----- model meta ------------------------------------------------------- */

describe("model definition", () => {
  test("auto id PK is added and table name honored", () => {
    assert.equal(Author.meta.dbTable, "authors");
    assert.equal(Author.meta.pk.name, "id");
    assert.equal(Author.meta.pk.column, "id");
    assert.deepEqual(
      [...Author.meta.fields.keys()],
      ["id", "name", "email", "age", "active", "createdAt"],
    );
  });

  test("ForeignKey uses an <name>Id attribute and column", () => {
    const fk = Book.meta.fields.get("author")!;
    assert.equal(fk.attname, "authorId");
    assert.equal(fk.column, "authorId");
    assert.ok(fk.isRelation);
  });

  test("per-model DoesNotExist subclasses are distinct", () => {
    assert.notEqual(Author.DoesNotExist, Book.DoesNotExist);
    assert.ok(new Author.DoesNotExist() instanceof Error);
  });
});

/* ----- create / save ---------------------------------------------------- */

describe("create & save", () => {
  test("create() inserts and populates the PK", async () => {
    const a = await Author.objects.create({ name: "Jane", email: "jane@x.com", age: 30 });
    assert.ok(typeof a.pk === "number" && a.pk > 0);
    assert.equal(a.name, "Jane");
    assert.equal(a.active, true); // default applied
    assert.ok(a.createdAt instanceof Date); // auto_now_add
  });

  test("new + save() then dirty UPDATE", async () => {
    const a = new Author({ name: "Bob", email: "bob@x.com" });
    await a.save();
    const id = a.pk;
    a.name = "Bobby";
    await a.save();
    const reloaded = await Author.objects.get({ pk: id });
    assert.equal(reloaded.name, "Bobby");
  });

  test("save({ updateFields }) only writes listed fields", async () => {
    const a = await Author.objects.create({ name: "Carl", email: "carl@x.com", age: 40 });
    a.name = "Carlos";
    a.age = 99;
    await a.save({ updateFields: ["age"] });
    const reloaded = await Author.objects.get({ pk: a.pk });
    assert.equal(reloaded.age, 99);
    assert.equal(reloaded.name, "Carl"); // name change was not persisted
  });
});

/* ----- lookups & querysets --------------------------------------------- */

describe("querysets & lookups", () => {
  before(async () => {
    await Author.objects.create({ name: "Alice", email: "alice@x.com", age: 25 });
    await Author.objects.create({ name: "Alfred", email: "alfred@x.com", age: 60 });
    await Author.objects.create({ name: "Zoe", email: "zoe@x.com", age: null });
  });

  test("await qs is thenable and returns instances", async () => {
    const all = await Author.objects.all();
    assert.ok(Array.isArray(all));
    assert.ok(all.length >= 3);
    assert.ok(all[0] instanceof Author);
  });

  test("for await iterates", async () => {
    let n = 0;
    for await (const a of Author.objects.filter({ name__startswith: "Al" })) {
      assert.ok(a.name.startsWith("Al"));
      n++;
    }
    assert.equal(n, 2);
  });

  test("filter with multiple lookups (AND)", async () => {
    const rows = await Author.objects.filter({ name__icontains: "al", age__gte: 30 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, "Alfred");
  });

  test("exclude negates", async () => {
    const rows = await Author.objects.exclude({ name__startswith: "Al" });
    assert.ok(rows.every((a) => !a.name.startsWith("Al")));
  });

  test("isnull lookup", async () => {
    const rows = await Author.objects.filter({ age__isnull: true });
    assert.ok(rows.some((a) => a.name === "Zoe"));
    assert.ok(rows.every((a) => a.age === null));
  });

  test("in lookup and empty-in returns nothing", async () => {
    const some = await Author.objects.filter({ name__in: ["Alice", "Zoe"] });
    assert.equal(some.length, 2);
    const none = await Author.objects.filter({ name__in: [] });
    assert.equal(none.length, 0);
  });

  test("range lookup", async () => {
    const rows = await Author.objects.filter({ age__range: [20, 30] });
    assert.ok(rows.some((a) => a.name === "Alice"));
    assert.ok(rows.every((a) => a.age! >= 20 && a.age! <= 30));
  });

  test("regex lookup (case-sensitive) via registered function", async () => {
    const rows = await Author.objects.filter({ name__regex: "^Al" });
    assert.equal(rows.length, 2);
    const none = await Author.objects.filter({ name__regex: "^al" });
    assert.equal(none.length, 0);
    const iany = await Author.objects.filter({ name__iregex: "^al" });
    assert.equal(iany.length, 2);
  });

  test("orderBy, reverse, first, last", async () => {
    const asc = await Author.objects.orderBy("name").values("name");
    const names = asc.map((r) => r.name);
    assert.deepEqual(names, [...names].sort());
    const firstByAge = await Author.objects.orderBy("age").first(); // nulls sort first in SQLite
    assert.ok(firstByAge);
    const last = await Author.objects.orderBy("name").last();
    assert.equal(last!.name, "Zoe");
  });

  test("count & exists", async () => {
    assert.ok((await Author.objects.count()) >= 3);
    assert.equal(await Author.objects.filter({ name: "Alice" }).exists(), true);
    assert.equal(await Author.objects.filter({ name: "Nobody" }).exists(), false);
  });

  test("get raises DoesNotExist / MultipleObjectsReturned", async () => {
    await assert.rejects(() => Author.objects.get({ name: "Ghost" }), Author.DoesNotExist);
    await assert.rejects(
      () => Author.objects.get({ name__startswith: "Al" }),
      Author.MultipleObjectsReturned,
    );
  });

  test("values / valuesList(flat) projections", async () => {
    const vals = await Author.objects.filter({ name: "Alice" }).values("name", "email");
    assert.deepEqual(vals, [{ name: "Alice", email: "alice@x.com" }]);
    const flat = await Author.objects.orderBy("name").valuesList(["name"], { flat: true });
    assert.ok(flat.includes("Alice"));
  });

  test("slice is lazy LIMIT/OFFSET", async () => {
    const page = await Author.objects.orderBy("name").slice(0, 2);
    assert.equal(page.length, 2);
  });
});

/* ----- Q objects -------------------------------------------------------- */

describe("Q objects", () => {
  test("or / and / not compose", async () => {
    const rows = await Author.objects.filter(Q({ name: "Alice" }).or(Q({ name: "Zoe" })));
    const names = rows.map((r) => r.name).sort();
    assert.deepEqual(names, ["Alice", "Zoe"]);

    const negated = await Author.objects.filter(Q({ name__startswith: "Al" }).not());
    assert.ok(negated.every((a) => !a.name.startsWith("Al")));
  });
});

/* ----- bulk update / delete -------------------------------------------- */

describe("bulk update & delete", () => {
  test("queryset.update returns rows changed", async () => {
    await Author.objects.create({ name: "Temp1", email: "t1@x.com", age: 1 });
    await Author.objects.create({ name: "Temp2", email: "t2@x.com", age: 1 });
    const changed = await Author.objects.filter({ age: 1 }).update({ active: false });
    assert.equal(changed, 2);
    const inactive = await Author.objects.filter({ active: false });
    assert.equal(inactive.length, 2);
  });

  test("queryset.delete returns count and removes rows", async () => {
    const { count } = await Author.objects.filter({ age: 1 }).delete();
    assert.equal(count, 2);
    assert.equal(await Author.objects.filter({ age: 1 }).exists(), false);
  });

  test("instance.delete removes the row", async () => {
    const a = await Author.objects.create({ name: "Doomed", email: "doom@x.com" });
    const id = a.pk;
    await a.delete();
    await assert.rejects(() => Author.objects.get({ pk: id }), Author.DoesNotExist);
  });
});

/* ----- relations -------------------------------------------------------- */

describe("foreign keys", () => {
  test("create with related instance, forward .get(), and filter by FK", async () => {
    const author = await Author.objects.create({ name: "Tolkien", email: "jrr@x.com" });
    const book = await Book.objects.create({
      title: "The Hobbit",
      price: "12.99",
      meta: { genre: "fantasy" },
      author,
    });
    assert.equal(book.authorId, author.pk);

    // forward relation is an awaitable descriptor
    const fetched = await book.author.get();
    assert.ok(fetched);
    assert.equal(fetched!.name, "Tolkien");

    // JSON round-trips
    const reloaded = await Book.objects.get({ pk: book.pk });
    assert.deepEqual(reloaded.meta, { genre: "fantasy" });
    assert.equal(reloaded.price, "12.99"); // decimal stays a string

    // filter by FK value or by the relation field
    const byId = await Book.objects.filter({ authorId: author.pk });
    assert.equal(byId.length, 1);
    const byRel = await Book.objects.filter({ author: author.pk });
    assert.equal(byRel.length, 1);
  });

  test("getOrCreate returns [obj, created]", async () => {
    const [a1, created1] = await Author.objects.getOrCreate(
      { email: "goc@x.com" },
      { defaults: { name: "GOC" } },
    );
    assert.equal(created1, true);
    const [a2, created2] = await Author.objects.getOrCreate(
      { email: "goc@x.com" },
      { defaults: { name: "OTHER" } },
    );
    assert.equal(created2, false);
    assert.equal(a2.pk, a1.pk);
  });
});

/* ----- validation ------------------------------------------------------- */

describe("validation", () => {
  test("fullClean rejects bad email and over-long char", async () => {
    const bad = new Author({ name: "x".repeat(200), email: "not-an-email" });
    await assert.rejects(() => bad.fullClean());
  });

  test("fullClean passes for valid data", async () => {
    const ok = new Author({ name: "Fine", email: "fine@x.com" });
    await ok.fullClean();
  });
});

/* ----- class-style registration ---------------------------------------- */

describe("Model.register() class style", () => {
  // register() attaches statics dynamically; cast to reach them in the test.
  const TagModel = Tag as unknown as {
    modelName: string;
    meta: { dbTable: string; ordering: string[] };
    objects: { create(d: Record<string, unknown>): Promise<{ pk: unknown; label: string }> };
  };

  test("static fields are picked up and the model works", async () => {
    assert.equal(TagModel.modelName, "Tag");
    assert.equal(TagModel.meta.dbTable, "tag");
    assert.deepEqual(TagModel.meta.ordering, ["slug"]);

    const t = await TagModel.objects.create({ label: "Fantasy", slug: "fantasy" });
    assert.ok(typeof t.pk === "number");
    assert.equal(t.label, "Fantasy");
  });
});
