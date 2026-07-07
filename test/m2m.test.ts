/**
 * ManyToManyField tests (design §6.2): auto through-table, add/remove/set/clear,
 * spanning filters in both directions, prefetch, annotate, and m2mChanged.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { defineModel, fields, Count, connect, closeAll, getConnection, signals } from "../src/index.ts";

const Tag = defineModel("Tag", {
  label: fields.CharField({ maxLength: 50, unique: true }),
});

const Post = defineModel("Post", {
  title: fields.CharField({ maxLength: 200 }),
  tags: fields.ManyToManyField(() => Tag, { relatedName: "posts" }),
});

const anyOf = (x: unknown) => x as Record<string, any>;

before(async () => {
  await connect({ engine: "sqlite", name: ":memory:" });
  const db = getConnection();
  await db.schema.createTable(Tag.meta);
  await db.schema.createTable(Post.meta);
});

after(async () => {
  await closeAll();
});

describe("through-table & basic ops", () => {
  test("through table exists with expected columns", async () => {
    const db = getConnection();
    const rows = await db.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'post_tags'`);
    assert.equal(rows.length, 1);
    const cols = await db.execute(`PRAGMA table_info("post_tags")`);
    const names = cols.map((c) => c.name);
    assert.deepEqual(names, ["id", "postId", "tagId"]);
  });

  test("add / all / remove / set / clear / count", async () => {
    const post = await Post.objects.create({ title: "Hello" });
    const t1 = await Tag.objects.create({ label: "news" });
    const t2 = await Tag.objects.create({ label: "tech" });
    const t3 = await Tag.objects.create({ label: "life" });

    await anyOf(post).tags.add(t1, t2);
    assert.equal(await anyOf(post).tags.count(), 2);

    // add is idempotent (INSERT OR IGNORE)
    await anyOf(post).tags.add(t1);
    assert.equal(await anyOf(post).tags.count(), 2);

    const labels = (await anyOf(post).tags.all().orderBy("label")).map((t: any) => t.label);
    assert.deepEqual(labels, ["news", "tech"]);

    await anyOf(post).tags.remove(t1);
    assert.equal(await anyOf(post).tags.count(), 1);

    await anyOf(post).tags.set([t2, t3]);
    const after = (await anyOf(post).tags.all().orderBy("label")).map((t: any) => t.label);
    assert.deepEqual(after, ["life", "tech"]);

    await anyOf(post).tags.clear();
    assert.equal(await anyOf(post).tags.count(), 0);

    await post.delete();
    await Tag.objects.all().delete();
  });

  test("create() through the relation links automatically", async () => {
    const post = await Post.objects.create({ title: "CreateThrough" });
    const tag = await anyOf(post).tags.create({ label: "auto" });
    assert.equal(await anyOf(post).tags.filter({ label: "auto" }).count(), 1);
    await post.delete();
    await tag.delete();
  });

  test("passing an m2m field to the constructor throws helpfully", () => {
    assert.throws(() => new Post({ title: "x", tags: [1] }), /ManyToManyField/);
  });
});

describe("reverse accessor & spanning", () => {
  before(async () => {
    const news = await Tag.objects.create({ label: "news" });
    const tech = await Tag.objects.create({ label: "tech" });
    const a = await Post.objects.create({ title: "About AI" });
    const b = await Post.objects.create({ title: "Daily digest" });
    const c = await Post.objects.create({ title: "Untagged" });
    void c;
    await anyOf(a).tags.add(news, tech);
    await anyOf(b).tags.add(news);
  });

  test("reverse manager: tag.posts", async () => {
    const news = await Tag.objects.get({ label: "news" });
    const titles = (await anyOf(news).posts.all().orderBy("title")).map((p: any) => p.title);
    assert.deepEqual(titles, ["About AI", "Daily digest"]);
  });

  test("forward spanning: posts by tag label", async () => {
    const posts = await Post.objects.filter({ tags__label: "tech" });
    assert.deepEqual(posts.map((p) => p.title), ["About AI"]);
  });

  test("reverse spanning: tags by post title", async () => {
    const tags = await Tag.objects.filter({ posts__title__icontains: "digest" });
    assert.deepEqual(tags.map((t) => t.label), ["news"]);
  });

  test("annotate Count over m2m in both directions", async () => {
    const tags = await Tag.objects.annotate({ n: Count("posts") }).orderBy("label");
    const byLabel = Object.fromEntries(tags.map((t) => [t.label, anyOf(t).n]));
    assert.equal(byLabel.news, 2);
    assert.equal(byLabel.tech, 1);

    const posts = await Post.objects.annotate({ n: Count("tags") }).orderBy("title");
    const byTitle = Object.fromEntries(posts.map((p) => [p.title, anyOf(p).n]));
    assert.equal(byTitle["About AI"], 2);
    assert.equal(byTitle["Untagged"], 0); // LEFT join keeps zero-tag posts
  });

  test("prefetchRelated on m2m (forward and reverse)", async () => {
    const posts = await Post.objects.prefetchRelated("tags").orderBy("title");
    const ai = posts.find((p) => p.title === "About AI")!;
    const cached = await anyOf(ai).tags.all();
    assert.equal(cached.length, 2);

    const tags = await Tag.objects.prefetchRelated("posts");
    const news = tags.find((t) => t.label === "news")!;
    assert.equal((await anyOf(news).posts.all()).length, 2);
  });
});

describe("m2mChanged signal", () => {
  test("fires for add/remove/clear with pks", async () => {
    const events: Array<{ action: string; n: number }> = [];
    const receiver = ({ action, pks }: { action: string; pks: unknown[] }) => {
      events.push({ action, n: pks.length });
    };
    signals.m2mChanged.connect(receiver);
    try {
      const post = await Post.objects.create({ title: "SignalPost" });
      const t = await Tag.objects.create({ label: "sig" });
      await anyOf(post).tags.add(t);
      await anyOf(post).tags.remove(t);
      await anyOf(post).tags.clear();
      assert.deepEqual(events, [
        { action: "add", n: 1 },
        { action: "remove", n: 1 },
        { action: "clear", n: 0 },
      ]);
      await post.delete();
      await t.delete();
    } finally {
      signals.m2mChanged.disconnect(receiver);
    }
  });
});

describe("self-referential m2m", () => {
  test("from/to column naming and round trip", async () => {
    // String ref avoids the self-referential thunk (both forms are supported).
    const Person = defineModel("Person", {
      name: fields.CharField({ maxLength: 50 }),
      friends: fields.ManyToManyField("Person", { relatedName: "friendOf" }),
    });
    const db = getConnection();
    await db.schema.createTable(Person.meta);

    const cols = await db.execute(`PRAGMA table_info("person_friends")`);
    assert.deepEqual(cols.map((c) => c.name), ["id", "fromPersonId", "toPersonId"]);

    const ada = await Person.objects.create({ name: "Ada" });
    const bob = await Person.objects.create({ name: "Bob" });
    await anyOf(ada).friends.add(bob);
    assert.deepEqual((await anyOf(ada).friends.all()).map((p: any) => p.name), ["Bob"]);
    // Directional, like Django: Bob hasn't added Ada.
    assert.equal(await anyOf(bob).friends.count(), 0);
    assert.deepEqual((await anyOf(bob).friendOf.all()).map((p: any) => p.name), ["Ada"]);
  });
});
