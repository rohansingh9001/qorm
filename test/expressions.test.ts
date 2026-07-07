/**
 * F() expressions, aggregate(), and annotate() — design §5.4/§5.5.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { defineModel, fields, F, Count, Sum, Avg, Max, Min, connect, closeAll, getConnection } from "../src/index.ts";

const Store = defineModel("Store", {
  name: fields.CharField({ maxLength: 100 }),
});

const Product = defineModel("Product", {
  name: fields.CharField({ maxLength: 100 }),
  price: fields.FloatField(),
  stock: fields.IntegerField(),
  threshold: fields.IntegerField(),
  store: fields.ForeignKey(() => Store, { onDelete: "CASCADE", relatedName: "products" }),
});

const anyOf = (x: unknown) => x as Record<string, any>;

before(async () => {
  await connect({ engine: "sqlite", name: ":memory:" });
  const db = getConnection();
  await db.schema.createTable(Store.meta);
  await db.schema.createTable(Product.meta);

  const acme = await Store.objects.create({ name: "Acme" });
  const empty = await Store.objects.create({ name: "Empty" });
  void empty; // no products — exercises LEFT join / count 0
  await Product.objects.create({ name: "Widget", price: 10, stock: 3, threshold: 5, store: acme });
  await Product.objects.create({ name: "Gadget", price: 20, stock: 50, threshold: 5, store: acme });
  await Product.objects.create({ name: "Gizmo", price: 30, stock: 5, threshold: 5, store: acme });
});

after(async () => {
  await closeAll();
});

describe("F() expressions", () => {
  test("column-vs-column filter", async () => {
    const low = await Product.objects.filter({ stock__lt: F("threshold") });
    assert.deepEqual(low.map((p) => p.name), ["Widget"]); // 3 < 5
  });

  test("column-vs-column with gte", async () => {
    const ok = await Product.objects.filter({ stock__gte: F("threshold") }).orderBy("name");
    assert.deepEqual(ok.map((p) => p.name), ["Gadget", "Gizmo"]); // 50>=5, 5>=5
  });

  test("arithmetic in update: increment", async () => {
    await Product.objects.filter({ name: "Widget" }).update({ stock: F("stock").add(10) });
    const w = await Product.objects.get({ name: "Widget" });
    assert.equal(w.stock, 13);
    // restore
    await Product.objects.filter({ name: "Widget" }).update({ stock: F("stock").sub(10) });
  });

  test("arithmetic in update: multiply float", async () => {
    await Product.objects.filter({ name: "Gizmo" }).update({ price: F("price").mul(2) });
    const g = await Product.objects.get({ name: "Gizmo" });
    assert.equal(g.price, 60);
    await Product.objects.filter({ name: "Gizmo" }).update({ price: F("price").div(2) });
  });
});

describe("aggregate()", () => {
  test("count / avg / min / max / sum over the table", async () => {
    const r = await Product.objects.aggregate({
      n: Count(),
      avgPrice: Avg("price"),
      minPrice: Min("price"),
      maxPrice: Max("price"),
      totalStock: Sum("stock"),
    });
    assert.equal(r.n, 3);
    assert.equal(r.avgPrice, 20);
    assert.equal(r.minPrice, 10);
    assert.equal(r.maxPrice, 30);
    assert.equal(r.totalStock, 58);
  });

  test("aggregate honors a filter", async () => {
    const r = await Product.objects.filter({ stock__gte: 5 }).aggregate({ n: Count() });
    assert.equal(r.n, 2); // Gadget (50), Gizmo (5)
  });
});

describe("annotate()", () => {
  test("Count over a reverse relation, grouped per row", async () => {
    const stores = await Store.objects.annotate({ numProducts: Count("products") }).orderBy("name");
    const byName = Object.fromEntries(stores.map((s) => [s.name, anyOf(s).numProducts]));
    assert.equal(byName["Acme"], 3);
    assert.equal(byName["Empty"], 0); // LEFT join -> 0, not missing
  });

  test("Sum over a spanned reverse relation", async () => {
    const stores = await Store.objects.annotate({ totalStock: Sum("products__stock") }).orderBy("name");
    const acme = stores.find((s) => s.name === "Acme")!;
    assert.equal(anyOf(acme).totalStock, 58);
  });

  test("annotate composes with filter", async () => {
    const stores = await Store.objects
      .annotate({ numProducts: Count("products") })
      .filter({ name: "Acme" });
    assert.equal(stores.length, 1);
    assert.equal(anyOf(stores[0]).numProducts, 3);
  });
});
