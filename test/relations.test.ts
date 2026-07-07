/**
 * Relation tests: JOIN-based relation spanning, selectRelated, reverse related
 * managers, and prefetchRelated — Phase 2 (design 6).
 *
 * Model graph: Publisher 1—* Author 1—* Book.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { defineModel, fields, connect, closeAll, getConnection } from "../src/index.ts";

const Publisher = defineModel("Publisher", {
  name: fields.CharField({ maxLength: 100 }),
});

const Author = defineModel("Author", {
  name: fields.CharField({ maxLength: 100 }),
  publisher: fields.ForeignKey(() => Publisher, {
    onDelete: "SET_NULL",
    relatedName: "authors",
    null: true,
  }),
});

const Book = defineModel("Book", {
  title: fields.CharField({ maxLength: 200 }),
  author: fields.ForeignKey(() => Author, { onDelete: "CASCADE", relatedName: "books" }),
});

// Reach dynamically-added reverse managers / relation descriptors without TS noise.
const anyOf = (x: unknown) => x as Record<string, any>;

before(async () => {
  await connect({ engine: "sqlite", name: ":memory:" });
  const db = getConnection();
  await db.schema.createTable(Publisher.meta);
  await db.schema.createTable(Author.meta);
  await db.schema.createTable(Book.meta);

  const allenUnwin = await Publisher.objects.create({ name: "Allen & Unwin" });
  const penguin = await Publisher.objects.create({ name: "Penguin" });
  const tolkien = await Author.objects.create({ name: "Tolkien", publisher: allenUnwin });
  const orwell = await Author.objects.create({ name: "Orwell", publisher: penguin });
  await Book.objects.create({ title: "The Hobbit", author: tolkien });
  await Book.objects.create({ title: "The Lord of the Rings", author: tolkien });
  await Book.objects.create({ title: "1984", author: orwell });
});

after(async () => {
  await closeAll();
});

describe("relation spanning (JOINs)", () => {
  test("single-level: filter across a FK", async () => {
    const books = await Book.objects.filter({ author__name: "Tolkien" }).orderBy("title");
    assert.deepEqual(
      books.map((b) => b.title),
      ["The Hobbit", "The Lord of the Rings"],
    );
  });

  test("single-level with a lookup suffix", async () => {
    const books = await Book.objects.filter({ author__name__startswith: "Orw" });
    assert.deepEqual(
      books.map((b) => b.title),
      ["1984"],
    );
  });

  test("multi-level: Book -> Author -> Publisher", async () => {
    const books = await Book.objects
      .filter({ author__publisher__name: "Allen & Unwin" })
      .orderBy("title");
    assert.equal(books.length, 2);
    assert.ok(books.every((b) => b.title.includes("The")));
  });

  test("order by a spanned relation", async () => {
    const books = await Book.objects.orderBy("author__name", "title");
    // Orwell < Tolkien, so 1984 first
    assert.equal(books[0]!.title, "1984");
  });

  test("count & exists honor joins", async () => {
    assert.equal(await Book.objects.filter({ author__name: "Tolkien" }).count(), 2);
    assert.equal(await Book.objects.filter({ author__publisher__name: "Penguin" }).exists(), true);
  });

  test("bulk update through a spanned filter (PK subquery)", async () => {
    const n = await Book.objects
      .filter({ author__name: "Orwell" })
      .update({ title: "Nineteen Eighty-Four" });
    assert.equal(n, 1);
    assert.equal(await Book.objects.filter({ title: "Nineteen Eighty-Four" }).count(), 1);
    // restore
    await Book.objects.filter({ title: "Nineteen Eighty-Four" }).update({ title: "1984" });
  });

  test("spanning a non-relation throws a clear error", async () => {
    await assert.rejects(
      () => Book.objects.filter({ title__author: "x" }).toArray(),
      /Cannot span/,
    );
  });
});

describe("selectRelated", () => {
  test("single FK: related instance is cached (no extra query)", async () => {
    const book = await Book.objects.selectRelated("author").get({ title: "The Hobbit" });
    assert.ok(anyOf(book).author.cached);
    assert.equal(anyOf(book).author.cached.name, "Tolkien");
    // get() returns the very same cached object — proves no second query was issued.
    const fetched = await anyOf(book).author.get();
    assert.equal(fetched, anyOf(book).author.cached);
  });

  test("nested: author__publisher hydrates both levels", async () => {
    const book = await Book.objects.selectRelated("author__publisher").get({ title: "The Hobbit" });
    const author = anyOf(book).author.cached;
    assert.equal(author.name, "Tolkien");
    assert.equal(anyOf(author).publisher.cached.name, "Allen & Unwin");
  });

  test("LEFT join: null relation hydrates as null", async () => {
    const a = await Author.objects.create({ name: "Anon" }); // no publisher
    const reloaded = await Author.objects.selectRelated("publisher").get({ pk: a.pk });
    assert.equal(anyOf(reloaded).publisher.cached, null);
    await a.delete();
  });
});

describe("reverse related managers", () => {
  test("author.books.all() / filter() / create()", async () => {
    const tolkien = await Author.objects.get({ name: "Tolkien" });
    const books = await anyOf(tolkien).books.all().orderBy("title");
    assert.deepEqual(
      books.map((b: any) => b.title),
      ["The Hobbit", "The Lord of the Rings"],
    );

    const filtered = await anyOf(tolkien).books.filter({ title__icontains: "hobbit" });
    assert.equal(filtered.length, 1);

    const created = await anyOf(tolkien).books.create({ title: "Silmarillion" });
    assert.equal(created.authorId, tolkien.pk);
    assert.equal(await anyOf(tolkien).books.all().count(), 3);
    await created.delete();
  });

  test("publisher.authors set/remove/clear (nullable FK)", async () => {
    const penguin = await Publisher.objects.get({ name: "Penguin" });
    const a1 = await Author.objects.create({ name: "Set1" });
    const a2 = await Author.objects.create({ name: "Set2" });

    await anyOf(penguin).authors.set([a1, a2]);
    assert.equal(await anyOf(penguin).authors.all().filter({ name__startswith: "Set" }).count(), 2);

    await anyOf(penguin).authors.remove(a1);
    await a1.refreshFromDb();
    assert.equal(a1.publisherId, null);

    await anyOf(penguin).authors.clear();
    await a2.refreshFromDb();
    assert.equal(a2.publisherId, null);

    await a1.delete();
    await a2.delete();
  });
});

describe("prefetchRelated", () => {
  test("reverse FK is batch-loaded and cached", async () => {
    const authors = await Author.objects
      .filter({ name__in: ["Tolkien", "Orwell"] })
      .prefetchRelated("books")
      .orderBy("name");

    const orwell = authors.find((a) => a.name === "Orwell")!;
    const tolkien = authors.find((a) => a.name === "Tolkien")!;

    // .all() now resolves from the prefetch cache.
    const orwellBooks = await anyOf(orwell).books.all();
    const tolkienBooks = await anyOf(tolkien).books.all();
    assert.equal(orwellBooks.length, 1);
    assert.equal(tolkienBooks.length, 2);
  });
});

describe("updateOrCreate / bulkCreate", () => {
  test("updateOrCreate creates then updates", async () => {
    const [p1, created1] = await Publisher.objects.updateOrCreate(
      { name: "UoC" },
      { defaults: { name: "UoC" } },
    );
    assert.equal(created1, true);
    const [p2, created2] = await Publisher.objects.updateOrCreate({ name: "UoC" });
    assert.equal(created2, false);
    assert.equal(p2.pk, p1.pk);
    await p1.delete();
  });

  test("bulkCreate inserts many", async () => {
    const created = await Publisher.objects.bulkCreate([{ name: "BC1" }, { name: "BC2" }]);
    assert.equal(created.length, 2);
    assert.ok(created.every((p) => typeof p.pk === "number"));
    await Publisher.objects.filter({ name__startswith: "BC" }).delete();
  });
});
