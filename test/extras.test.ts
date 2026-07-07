/**
 * QuerySet extras: only/defer, union/intersection/difference, inBulk, iterator,
 * explain, bulkUpdate, selectForUpdate, DB functions, and window functions.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import {
  defineModel,
  fields,
  connect,
  closeAll,
  getConnection,
  Lower,
  Upper,
  Length,
  Concat,
  Coalesce,
  Value,
  Cast,
  Round,
  F,
  Sum,
  Window,
  Rank,
  RowNumber,
} from "../src/index.ts";

const Product = defineModel("Product", {
  name: fields.CharField({ maxLength: 100 }),
  nickname: fields.CharField({ maxLength: 100, null: true }),
  price: fields.FloatField(),
  category: fields.CharField({ maxLength: 50 }),
});

const anyOf = (x: unknown) => x as Record<string, any>;

before(async () => {
  await connect({ engine: "sqlite", name: ":memory:" });
  await getConnection().schema.createTable(Product.meta);
  await Product.objects.bulkCreate([
    { name: "Widget", nickname: "Widgy", price: 9.99, category: "tools" },
    { name: "Gadget", nickname: null, price: 24.5, category: "tools" },
    { name: "Gizmo", nickname: null, price: 99.0, category: "toys" },
    { name: "Doohickey", nickname: "Doo", price: 5.0, category: "toys" },
  ]);
});

after(async () => {
  await closeAll();
});

describe("using() — multi-DB routing", () => {
  test("queryset routes to the aliased connection", async () => {
    await connect({ engine: "sqlite", name: ":memory:" }, "other");
    const other = getConnection("other");
    await other.schema.createTable(Product.meta);
    await other.run(
      `INSERT INTO "product" ("name", "nickname", "price", "category") VALUES (?, ?, ?, ?)`,
      ["OnlyInOther", null, 1, "x"],
    );

    assert.equal(await Product.objects.using("other").count(), 1);
    assert.equal(
      (await Product.objects.using("other").get({ name: "OnlyInOther" })).name,
      "OnlyInOther",
    );
    // The default connection is unaffected.
    assert.equal(await Product.objects.filter({ name: "OnlyInOther" }).exists(), false);
  });
});

describe("only / defer", () => {
  test("only() loads pk + listed fields; others are undefined", async () => {
    const p = (await Product.objects.only("name").get({ name: "Widget" })) as Record<
      string,
      unknown
    >;
    assert.equal(p.name, "Widget");
    assert.equal(p.price, undefined);
    assert.ok(p.id);
  });

  test("defer() skips listed fields", async () => {
    const p = (await Product.objects.defer("price", "nickname").get({ name: "Gadget" })) as Record<
      string,
      unknown
    >;
    assert.equal(p.name, "Gadget");
    assert.equal(p.price, undefined);
    assert.equal(p.category, "tools");
  });

  test("refreshFromDb restores deferred fields", async () => {
    const p = await Product.objects.only("name").get({ name: "Gizmo" });
    await p.refreshFromDb();
    assert.equal(p.price, 99.0);
  });
});

describe("set operations", () => {
  test("union combines and dedupes; orderBy + count work", async () => {
    const tools = Product.objects.filter({ category: "tools" });
    const cheap = Product.objects.filter({ price__lt: 10 });
    const u = tools.union(cheap).orderBy("name");
    const names = (await u).map((p) => p.name);
    assert.deepEqual(names, ["Doohickey", "Gadget", "Widget"]); // Widget in both, deduped
    assert.equal(await tools.union(cheap).count(), 3);
  });

  test("union all keeps duplicates", async () => {
    const tools = Product.objects.filter({ category: "tools" });
    const cheap = Product.objects.filter({ price__lt: 10 });
    assert.equal(await tools.union(cheap, { all: true }).count(), 4); // Widget twice
  });

  test("intersection and difference", async () => {
    const tools = Product.objects.filter({ category: "tools" });
    const cheap = Product.objects.filter({ price__lt: 10 });
    assert.deepEqual(
      (await tools.intersection(cheap)).map((p) => p.name),
      ["Widget"],
    );
    assert.deepEqual(
      (await tools.difference(cheap)).map((p) => p.name),
      ["Gadget"],
    );
  });

  test("slice and first on combined querysets", async () => {
    const all = Product.objects.filter({ price__gte: 0 });
    const none = Product.objects.filter({ price__lt: 0 });
    const u = all.union(none).orderBy("price");
    const first = await u.first();
    assert.equal(first!.name, "Doohickey");
    assert.equal((await u.slice(1, 3)).length, 2);
  });
});

describe("terminal extras", () => {
  test("inBulk by pk and by field", async () => {
    const byPk = await Product.objects.inBulk();
    assert.equal(byPk.size, 4);
    const w = await Product.objects.get({ name: "Widget" });
    assert.equal(byPk.get(w.pk)!.name, "Widget");

    const byName = await Product.objects.inBulk(["Widget", "Gizmo"], { field: "name" });
    assert.deepEqual([...byName.keys()].sort(), ["Gizmo", "Widget"]);
  });

  test("iterator() yields rows", async () => {
    let n = 0;
    for await (const p of Product.objects.iterator()) {
      assert.ok(p.name);
      n++;
    }
    assert.equal(n, 4);
  });

  test("explain() returns a plan", async () => {
    const plan = await Product.objects.filter({ name: "Widget" }).explain();
    assert.ok(plan.length > 0);
  });

  test("bulkUpdate persists listed fields only", async () => {
    const prods = await Product.objects.filter({ category: "tools" }).orderBy("name");
    for (const p of prods) {
      p.price = p.price + 1;
      p.name = `${p.name}-CHANGED`;
    }
    const n = await Product.objects.bulkUpdate(prods, ["price"]);
    assert.equal(n, 2);
    const reloaded = await Product.objects.filter({ category: "tools" }).orderBy("name");
    assert.deepEqual(
      reloaded.map((p) => p.name),
      ["Gadget", "Widget"],
    ); // names NOT persisted
    assert.deepEqual(
      reloaded.map((p) => p.price),
      [25.5, 10.99],
    );
    // restore
    for (const p of reloaded) p.price = p.price - 1;
    await Product.objects.bulkUpdate(reloaded, ["price"]);
  });

  test("selectForUpdate chains and evaluates (no-op on sqlite)", async () => {
    const rows = await Product.objects.selectForUpdate().filter({ category: "toys" });
    assert.equal(rows.length, 2);
  });
});

describe("DB functions in annotate", () => {
  test("Lower / Upper / Length", async () => {
    const p = (await Product.objects
      .annotate({ lower: Lower("name"), upper: Upper("name"), len: Length("name") })
      .get({ name: "Widget" })) as Record<string, unknown>;
    assert.equal(p.lower, "widget");
    assert.equal(p.upper, "WIDGET");
    assert.equal(p.len, 6);
  });

  test("Coalesce falls back across columns and literals", async () => {
    const rows = await Product.objects
      .annotate({ display: Coalesce("nickname", "name", Value("anon")) })
      .orderBy("name");
    const map = Object.fromEntries(rows.map((r) => [r.name, anyOf(r).display]));
    assert.equal(map.Widget, "Widgy");
    assert.equal(map.Gadget, "Gadget"); // null nickname -> name
  });

  test("Concat with Value literals", async () => {
    const p = (await Product.objects
      .annotate({ label: Concat("category", Value(": "), "name") })
      .get({ name: "Gizmo" })) as Record<string, unknown>;
    assert.equal(p.label, "toys: Gizmo");
  });

  test("Cast and Round; F in annotate; orderBy annotation", async () => {
    const rows = await Product.objects
      .annotate({ cents: Round(F("price").mul(100)), int: Cast("price", "INTEGER") })
      .orderBy("-cents");
    assert.equal(anyOf(rows[0]).int, 99);
    assert.equal(anyOf(rows[0]).cents, 9900);
    assert.equal(rows[0]!.name, "Gizmo");
  });
});

describe("window functions", () => {
  test("Rank partitioned by category, ordered by price", async () => {
    const rows = await Product.objects
      .annotate({ rank: Window(Rank(), { partitionBy: ["category"], orderBy: ["-price"] }) })
      .orderBy("category", "name");
    const got = rows.map((r) => `${r.category}/${r.name}:${anyOf(r).rank}`);
    assert.deepEqual(got, ["tools/Gadget:1", "tools/Widget:2", "toys/Doohickey:2", "toys/Gizmo:1"]);
  });

  test("RowNumber and windowed Sum (running total)", async () => {
    const rows = await Product.objects
      .annotate({
        n: Window(RowNumber(), { orderBy: ["price"] }),
        running: Window(Sum("price"), { orderBy: ["price"] }),
      })
      .orderBy("price");
    assert.deepEqual(
      rows.map((r) => anyOf(r).n),
      [1, 2, 3, 4],
    );
    const running = rows.map((r) => Math.round(anyOf(r).running * 100) / 100);
    assert.deepEqual(running, [5.0, 14.99, 39.49, 138.49]);
  });
});
