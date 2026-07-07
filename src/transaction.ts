/**
 * Transactions (design §8) — the analogue of `django.db.transaction`.
 *
 *   await transaction.atomic(async () => {
 *     await Author.objects.create({ ... });
 *     await Book.objects.create({ ... });
 *     // throw -> full rollback; nested atomic() -> savepoints
 *   });
 *
 * Deviation (design §14): Django's `atomic` is a decorator + context manager;
 * here it's a callback. `AsyncLocalStorage` carries the nesting depth, so nested
 * ORM calls join the active transaction automatically — no connection threading.
 *
 * Top-level atomics on the same backend are serialized through the backend's
 * lock; queries issued *outside* any atomic while one is running share the
 * connection and therefore observe (and join) it — same as Django on SQLite.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Backend } from "./backends/base.ts";
import { getConnection } from "./connection.ts";

/** Per-async-context transaction depth, keyed by backend. */
const als = new AsyncLocalStorage<Map<Backend, number>>();

/** True when the current async context is inside an atomic block on `backend`. */
export function inAtomicBlock(backend?: Backend): boolean {
  const store = als.getStore();
  if (!store) return false;
  if (backend) return (store.get(backend) ?? 0) > 0;
  for (const depth of store.values()) if (depth > 0) return true;
  return false;
}

/** Run `fn` atomically on a specific backend (savepoints when already inside one). */
export async function atomicOn<T>(backend: Backend, fn: () => Promise<T> | T): Promise<T> {
  const store = als.getStore();
  const depth = store?.get(backend) ?? 0;

  if (depth === 0) {
    return backend.lock(async () => {
      await backend.begin();
      try {
        const result = await als.run(new Map([[backend, 1]]), () => fn());
        await backend.commit();
        return result;
      } catch (err) {
        await backend.rollback();
        throw err;
      }
    });
  }

  // Nested: savepoint instead of BEGIN, so an inner failure rolls back only itself.
  const sp = `dorm_sp_${depth}`;
  await backend.savepoint(sp);
  const next = new Map(store);
  next.set(backend, depth + 1);
  try {
    const result = await als.run(next, () => fn());
    await backend.releaseSavepoint(sp);
    return result;
  } catch (err) {
    await backend.rollbackToSavepoint(sp);
    await backend.releaseSavepoint(sp);
    throw err;
  }
}

/** Run `fn` atomically on a configured connection (default alias unless `using`). */
export function atomic<T>(fn: () => Promise<T> | T, opts: { using?: string } = {}): Promise<T> {
  return atomicOn(getConnection(opts.using ?? "default"), fn);
}

export const transaction = { atomic, atomicOn, inAtomicBlock };
