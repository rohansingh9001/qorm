/**
 * Transactions (design §8) and lifecycle signals (design §7.1).
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { defineModel, fields, transaction, atomic, signals, connect, closeAll, getConnection } from "../src/index.ts";

const Account = defineModel("Account", {
  name: fields.CharField({ maxLength: 50 }),
  balance: fields.IntegerField({ default: 0 }),
});

before(async () => {
  await connect({ engine: "sqlite", name: ":memory:" });
  await getConnection().schema.createTable(Account.meta);
});

after(async () => {
  await closeAll();
});

describe("transaction.atomic", () => {
  test("commits on success and returns the callback's value", async () => {
    const result = await transaction.atomic(async () => {
      await Account.objects.create({ name: "A", balance: 100 });
      await Account.objects.create({ name: "B", balance: 200 });
      return "done";
    });
    assert.equal(result, "done");
    assert.equal(await Account.objects.count(), 2);
  });

  test("rolls back everything on throw", async () => {
    const beforeCount = await Account.objects.count();
    await assert.rejects(
      atomic(async () => {
        await Account.objects.create({ name: "C", balance: 1 });
        assert.equal(await Account.objects.count(), beforeCount + 1); // visible inside
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await Account.objects.count(), beforeCount); // gone after rollback
  });

  test("nested atomic uses savepoints: inner failure, outer survives", async () => {
    const start = await Account.objects.count();
    await atomic(async () => {
      await Account.objects.create({ name: "Outer", balance: 5 });
      await assert.rejects(
        atomic(async () => {
          await Account.objects.create({ name: "Inner", balance: 6 });
          throw new Error("inner-fail");
        }),
        /inner-fail/,
      );
    });
    assert.equal(await Account.objects.count(), start + 1);
    assert.equal(await Account.objects.filter({ name: "Inner" }).exists(), false);
    assert.equal(await Account.objects.filter({ name: "Outer" }).exists(), true);
  });

  test("concurrent top-level atomics serialize (no interleaving)", async () => {
    const order: string[] = [];
    await Promise.all([
      atomic(async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("a-end");
      }),
      atomic(async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  });

  test("update + F-style flows inside a transaction persist atomically", async () => {
    await atomic(async () => {
      await Account.objects.filter({ name: "A" }).update({ balance: 150 });
      await Account.objects.filter({ name: "B" }).update({ balance: 150 });
    });
    const balances = await Account.objects.filter({ name__in: ["A", "B"] }).valuesList(["balance"], { flat: true });
    assert.deepEqual(balances, [150, 150]);
  });
});

describe("signals", () => {
  test("preSave/postSave fire with created flag; model filter works", async () => {
    const log: string[] = [];
    const pre = ({ created }: { created: boolean }) => {
      log.push(`pre:${created}`);
    };
    const post = ({ created }: { created: boolean }) => {
      log.push(`post:${created}`);
    };
    signals.preSave.connect(Account, pre);
    signals.postSave.connect(Account, post);
    try {
      const acc = await Account.objects.create({ name: "Sig", balance: 1 });
      acc.balance = 2;
      await acc.save();
      assert.deepEqual(log, ["pre:true", "post:true", "pre:false", "post:false"]);
      await acc.delete();
    } finally {
      signals.preSave.disconnect(pre);
      signals.postSave.disconnect(post);
    }
  });

  test("preDelete/postDelete fire around deletion; async receivers awaited", async () => {
    const log: string[] = [];
    const pre = async ({ instance }: { instance: Record<string, unknown> }) => {
      await new Promise((r) => setTimeout(r, 5));
      log.push(`pre:${instance.name}`);
    };
    const post = ({ instance }: { instance: Record<string, unknown> }) => {
      log.push(`post:${instance.name}`);
    };
    signals.preDelete.connect(Account, pre);
    signals.postDelete.connect(Account, post);
    try {
      const acc = await Account.objects.create({ name: "Doomed" });
      await acc.delete();
      assert.deepEqual(log, ["pre:Doomed", "post:Doomed"]); // async pre awaited before delete returns
    } finally {
      signals.preDelete.disconnect(pre);
      signals.postDelete.disconnect(post);
    }
  });

  test("disconnect stops delivery; unfiltered receiver sees all models", async () => {
    let calls = 0;
    const recv = () => {
      calls++;
    };
    signals.postSave.connect(recv); // all models
    const acc = await Account.objects.create({ name: "X" });
    signals.postSave.disconnect(recv);
    acc.name = "Y";
    await acc.save();
    assert.equal(calls, 1);
    await acc.delete();
  });
});
