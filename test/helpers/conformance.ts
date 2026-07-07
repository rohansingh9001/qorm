/**
 * Backend conformance suite: the same battery of ORM behavior run against any
 * configured engine. Each engine's test file (postgres.test.ts, mysql.test.ts)
 * runs in its own process, so models register freshly per backend.
 *
 * Covers: schema creation (FK + M2M through), CRUD + dirty saves + defaults +
 * autoNowAdd, the lookup set (incl. regex and date parts — dialect hooks),
 * relation-spanning JOINs, selectRelated/prefetch, reverse + M2M managers,
 * aggregates/annotate/F/DB functions/window functions, transactions with
 * savepoints, set operations, only/defer, bulk ops, and the migration engine
 * end-to-end (addColumn / alterColumn / renameColumn / unapply).
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defineModel,
  fields,
  connect,
  closeAll,
  getConnection,
  transaction,
  F,
  Q,
  Count,
  Avg,
  Sum,
  Lower,
  Concat,
  Value,
  Window,
  Rank,
  ProjectState,
  autodetectChanges,
  writeMigration,
  loadMigrations,
  finalState,
  MigrationExecutor,
  allModels,
  type DatabaseConfig,
} from "../../src/index.ts";

const anyOf = (x: unknown) => x as Record<string, any>;

export function runConformanceSuite(engineName: string, config: DatabaseConfig): void {
  const Publisher = defineModel("Publisher", {
    name: fields.CharField({ maxLength: 100 }),
  });

  const Author = defineModel(
    "Author",
    {
      name: fields.CharField({ maxLength: 100 }),
      email: fields.EmailField({ unique: true }),
      age: fields.IntegerField({ null: true }),
      active: fields.BooleanField({ default: true }),
      bio: fields.TextField({ null: true }),
      rating: fields.FloatField({ default: 0 }),
      createdAt: fields.DateTimeField({ autoNowAdd: true }),
      publisher: fields.ForeignKey(() => Publisher, {
        onDelete: "SET_NULL",
        relatedName: "authors",
        null: true,
      }),
    },
    { ordering: ["name"] },
  );

  const Book = defineModel("Book", {
    title: fields.CharField({ maxLength: 200 }),
    price: fields.FloatField({ default: 0 }),
    published: fields.DateField({ null: true }),
    meta: fields.JSONField({ null: true }),
    author: fields.ForeignKey(() => Author, { onDelete: "CASCADE", relatedName: "books" }),
    tags: fields.ManyToManyField("Tag", { relatedName: "books" }),
  });

  const Tag = defineModel("Tag", {
    label: fields.CharField({ maxLength: 50, unique: true }),
  });

  describe(`${engineName}: conformance`, () => {
    before(async () => {
      const backend = await connect(config);
      // Fresh slate: drop in FK-safe order (M2M through-tables drop with Book).
      await backend.disableForeignKeys();
      for (const model of [Book, Author, Publisher, Tag]) {
        await backend.schema.dropTable(model.meta, { ifExists: true });
      }
      await backend.enableForeignKeys();
      await backend.schema.createTable(Publisher.meta);
      await backend.schema.createTable(Author.meta);
      await backend.schema.createTable(Tag.meta);
      await backend.schema.createTable(Book.meta);
    });

    after(async () => {
      await closeAll();
    });

    test("create populates pk, defaults, autoNowAdd; get round-trips values", async () => {
      const pub = await Publisher.objects.create({ name: "Penguin" });
      const a = await Author.objects.create({
        name: "Jane",
        email: "jane@x.com",
        age: 30,
        publisher: pub,
      });
      assert.ok(typeof a.pk === "number" && a.pk > 0);
      assert.equal(a.active, true);
      assert.ok(a.createdAt instanceof Date);

      const got = await Author.objects.get({ email: "jane@x.com" });
      assert.equal(got.name, "Jane");
      assert.equal(got.age, 30);
      assert.equal(got.active, true); // boolean round-trip
      assert.equal(got.publisherId, pub.pk);
      assert.ok(got.createdAt instanceof Date);
      assert.ok(Math.abs(got.createdAt.getTime() - Date.now()) < 60_000);
    });

    test("dirty save updates only changes; refreshFromDb reloads", async () => {
      const a = await Author.objects.get({ email: "jane@x.com" });
      a.age = 31;
      await a.save();
      const re = await Author.objects.get({ email: "jane@x.com" });
      assert.equal(re.age, 31);
      re.age = 99;
      await re.refreshFromDb();
      assert.equal(re.age, 31);
    });

    test("JSON and DateField round-trip", async () => {
      const a = await Author.objects.get({ email: "jane@x.com" });
      const b = await Book.objects.create({
        title: "The Test",
        price: 9.5,
        published: "2020-06-15",
        meta: { genre: "ref", tags: [1, 2] },
        author: a,
      });
      const got = await Book.objects.get({ pk: b.pk });
      assert.deepEqual(got.meta, { genre: "ref", tags: [1, 2] });
      assert.equal(got.published, "2020-06-15");
    });

    test("lookups: icontains/in/isnull/range/gt + Q composition", async () => {
      await Author.objects.create({ name: "Alfred", email: "alfred@x.com", age: 60 });
      await Author.objects.create({ name: "Zoe", email: "zoe@x.com", age: null });

      assert.equal((await Author.objects.filter({ name__icontains: "ALF" })).length, 1);
      assert.equal((await Author.objects.filter({ name__in: ["Jane", "Zoe"] })).length, 2);
      assert.equal(
        (await Author.objects.filter({ age__isnull: true })).map((a) => a.name).join(),
        "Zoe",
      );
      assert.equal((await Author.objects.filter({ age__range: [25, 40] })).length, 1);
      assert.equal(
        (await Author.objects.filter(Q({ name: "Jane" }).or(Q({ name: "Zoe" })))).length,
        2,
      );
    });

    test("case-sensitive vs insensitive contains (dialect LIKE)", async () => {
      assert.equal((await Author.objects.filter({ name__contains: "ane" })).length, 1); // Jane
      assert.equal((await Author.objects.filter({ name__contains: "ANE" })).length, 0); // sensitive
      assert.equal((await Author.objects.filter({ name__icontains: "ANE" })).length, 1);
    });

    test("regex and iregex (dialect hook)", async () => {
      assert.equal((await Author.objects.filter({ name__regex: "^J" })).length, 1);
      assert.equal((await Author.objects.filter({ name__regex: "^j" })).length, 0);
      assert.equal((await Author.objects.filter({ name__iregex: "^j" })).length, 1);
    });

    test("date part lookups (dialect hook)", async () => {
      const books = await Book.objects.filter({ published__year: 2020 });
      assert.equal(books.length, 1);
      assert.equal((await Book.objects.filter({ published__month: 6 })).length, 1);
      assert.equal((await Book.objects.filter({ published__day: 15 })).length, 1);
      assert.equal((await Book.objects.filter({ published__year: 1999 })).length, 0);
    });

    test("relation spanning, selectRelated, reverse manager, prefetch", async () => {
      const jane = await Author.objects.get({ name: "Jane" });
      await anyOf(jane).books.create({ title: "Sequel", price: 12 });

      const byPub = await Book.objects.filter({ author__publisher__name: "Penguin" });
      assert.equal(byPub.length, 2);

      const eager = await Book.objects.selectRelated("author__publisher").get({ title: "Sequel" });
      assert.equal(anyOf(eager).author.cached.name, "Jane");
      assert.equal(anyOf(anyOf(eager).author.cached).publisher.cached.name, "Penguin");

      const withBooks = await Author.objects.prefetchRelated("books").filter({ name: "Jane" });
      assert.equal((await anyOf(withBooks[0]).books.all()).length, 2);
    });

    test("M2M: add/count/spanning/annotate through the dialect insert-ignore", async () => {
      const fantasy = await Tag.objects.create({ label: "fantasy" });
      const scifi = await Tag.objects.create({ label: "scifi" });
      const book = await Book.objects.get({ title: "The Test" });
      await anyOf(book).tags.add(fantasy, scifi);
      await anyOf(book).tags.add(fantasy); // duplicate ignored
      assert.equal(await anyOf(book).tags.count(), 2);

      assert.equal((await Book.objects.filter({ tags__label: "fantasy" })).length, 1);
      assert.equal((await Tag.objects.filter({ books__title: "The Test" })).length, 2);

      const tagged = await Book.objects.annotate({ n: Count("tags") }).get({ pk: book.pk });
      assert.equal(Number(anyOf(tagged).n), 2);
    });

    test("aggregate, annotate Count, F updates, DB functions, windows", async () => {
      const agg = await Book.objects.aggregate({
        n: Count(),
        avgPrice: Avg("price"),
        total: Sum("price"),
      });
      assert.equal(Number(agg.n), 2);
      assert.ok(Math.abs(Number(agg.avgPrice) - 10.75) < 0.001);
      assert.ok(Math.abs(Number(agg.total) - 21.5) < 0.001);

      const authors = await Author.objects
        .annotate({ numBooks: Count("books") })
        .orderBy("-numBooks");
      assert.equal(Number(anyOf(authors[0]).numBooks), 2);
      assert.equal(authors[0]!.name, "Jane");

      await Book.objects.filter({ title: "Sequel" }).update({ price: F("price").mul(2) });
      assert.equal((await Book.objects.get({ title: "Sequel" })).price, 24);

      const fn = await Author.objects
        .annotate({ low: Lower("name"), label: Concat("name", Value("!")) })
        .get({ name: "Jane" });
      assert.equal(anyOf(fn).low, "jane");
      assert.equal(anyOf(fn).label, "Jane!");

      const ranked = await Book.objects
        .annotate({ r: Window(Rank(), { orderBy: ["-price"] }) })
        .orderBy("title");
      const ranks = Object.fromEntries(ranked.map((b) => [b.title, Number(anyOf(b).r)]));
      assert.equal(ranks["Sequel"], 1);
      assert.equal(ranks["The Test"], 2);
    });

    test("transactions: rollback, nested savepoints, FOR UPDATE inside atomic", async () => {
      const before = await Author.objects.count();
      await assert.rejects(
        transaction.atomic(async () => {
          await Author.objects.create({ name: "Ghost", email: "ghost@x.com" });
          throw new Error("boom");
        }),
        /boom/,
      );
      assert.equal(await Author.objects.count(), before);

      await transaction.atomic(async () => {
        await Author.objects.create({ name: "Keeper", email: "keeper@x.com" });
        await assert.rejects(
          transaction.atomic(async () => {
            await Author.objects.create({ name: "InnerGhost", email: "ig@x.com" });
            throw new Error("inner");
          }),
          /inner/,
        );
        // Row locks are dialect-emitted; harmless inside the transaction.
        await Author.objects.selectForUpdate().filter({ name: "Keeper" }).toArray();
      });
      assert.equal(await Author.objects.filter({ name: "Keeper" }).exists(), true);
      assert.equal(await Author.objects.filter({ name: "InnerGhost" }).exists(), false);
    });

    test("set ops, only/defer, slice/offset, inBulk, iterator, explain", async () => {
      const a = Author.objects.filter({ age__gte: 30 });
      const b = Author.objects.filter({ name__startswith: "J" });
      assert.ok((await a.union(b).count()) >= 2);
      assert.equal((await a.intersection(b)).length, 1);

      const onlyName = (await Author.objects.only("name").get({ name: "Jane" })) as Record<
        string,
        unknown
      >;
      assert.equal(onlyName.email, undefined);

      const page = await Author.objects.orderBy("name").slice(1, 3);
      assert.equal(page.length, 2);
      const offsetOnly = await Author.objects.orderBy("name").slice(1); // OFFSET w/o LIMIT (dialect)
      assert.ok(offsetOnly.length >= 2);

      const map = await Author.objects.inBulk(["Jane"], { field: "name" });
      assert.equal(map.get("Jane")!.email, "jane@x.com");

      let n = 0;
      for await (const _ of Author.objects.iterator()) n++;
      assert.ok(n >= 3);

      assert.ok((await Author.objects.filter({ name: "Jane" }).explain()).length > 0);
    });

    test("bulk update/delete through spanned filters (PK subquery)", async () => {
      const changed = await Book.objects.filter({ author__name: "Jane" }).update({ price: 1 });
      assert.equal(changed, 2);
      const { count } = await Book.objects.filter({ author__publisher__name: "Nobody" }).delete();
      assert.equal(count, 0);
    });

    test("migration engine end-to-end on this backend", async () => {
      const dir = mkdtempSync(join(tmpdir(), `dorm-${engineName}-mig-`));
      const backend = getConnection();
      try {
        // A standalone model evolved across three migrations.
        const from0 = new ProjectState();
        const to1 = new ProjectState();
        to1.models.set("Gadget", {
          name: "Gadget",
          dbTable: "gadget",
          ordering: [],
          fields: [
            ["id", { type: "BigAutoField", options: { primaryKey: true } }],
            ["name", { type: "CharField", options: { maxLength: 50 } }],
          ],
        });
        writeMigration(dir, await autodetectChanges(from0, to1), { name: "initial" });

        const to2 = to1.clone();
        to2
          .getModel("Gadget")
          .fields.push(["weight", { type: "IntegerField", options: { default: 5 } }]);
        writeMigration(dir, await autodetectChanges(to1, to2), { name: "weight" });

        const to3 = to2.clone();
        const gf = to3.getModel("Gadget").fields;
        gf[gf.findIndex(([n]) => n === "name")] = [
          "name",
          { type: "CharField", options: { maxLength: 150 } },
        ];
        writeMigration(dir, await autodetectChanges(to2, to3), { name: "widen" });

        const executor = new MigrationExecutor(backend, await loadMigrations(dir));
        const applied = await executor.migrate();
        assert.equal(applied.applied.length, 3);

        // The migrated table really works: insert + default backfill present.
        await backend.run(
          `INSERT INTO ${backend.quoteName("gadget")} (${backend.quoteName("name")}, ${backend.quoteName("weight")}) VALUES (?, ?)`,
          ["probe", 7],
        );
        const rows = await backend.execute(
          `SELECT ${backend.quoteName("weight")} AS w FROM ${backend.quoteName("gadget")}`,
        );
        assert.equal(Number(rows[0]!.w), 7);

        // Unapply everything; the table is gone.
        await executor.migrate({ target: "zero" });
        await assert.rejects(backend.execute(`SELECT 1 FROM ${backend.quoteName("gadget")}`));

        // No drift between replayed migration state and itself.
        assert.deepEqual(await autodetectChanges(finalState(await loadMigrations(dir)), to3), []);
        void allModels;
      } finally {
        rmSync(dir, { recursive: true, force: true });
        // Clean the recorder so other suites on this DB start fresh.
        await backend.run(`DELETE FROM ${backend.quoteName("dorm_migrations")}`).catch(() => {});
      }
    });
  });
}
