/**
 * Lifecycle signals (design §7.1) — the analogue of `django.db.models.signals`.
 *
 *   import { signals } from "dorm";
 *   signals.postSave.connect(Author, ({ instance, created }) => { ... });
 *   signals.postSave.connect(receiver);            // all models
 *   signals.postSave.disconnect(receiver);
 *
 * Deviation (design §14): receivers may be sync or async; async receivers are
 * awaited in registration order before the triggering operation returns.
 */
import type { ModelInstance } from "./types.ts";

export type Receiver<P> = (payload: P) => void | Promise<void>;

export class Signal<P = Record<string, unknown>> {
  private receivers: Array<{ model: unknown; fn: Receiver<P> }> = [];

  /** Connect for one model — `connect(Author, fn)` — or for all models — `connect(fn)`. */
  connect(modelOrReceiver: unknown, fn?: Receiver<P>): void {
    if (fn === undefined) {
      this.receivers.push({ model: null, fn: modelOrReceiver as Receiver<P> });
    } else {
      this.receivers.push({ model: modelOrReceiver, fn });
    }
  }

  disconnect(fn: Receiver<P>): void {
    this.receivers = this.receivers.filter((r) => r.fn !== fn);
  }

  /** Dispatch to matching receivers, awaiting each in registration order. */
  async send(model: unknown, payload: P): Promise<void> {
    for (const r of this.receivers) {
      if (r.model === null || r.model === model) await r.fn(payload);
    }
  }

  get hasReceivers(): boolean {
    return this.receivers.length > 0;
  }
}

export interface SavePayload {
  instance: ModelInstance;
  /** True when the save was an INSERT. */
  created: boolean;
  updateFields: string[] | undefined;
}

export interface DeletePayload {
  instance: ModelInstance;
}

export interface M2MChangedPayload {
  instance: ModelInstance;
  /** Which mutation ran. `set()` fires "clear" then "add". */
  action: "add" | "remove" | "clear";
  /** Primary keys involved (empty for "clear"). */
  pks: unknown[];
}

export const signals = {
  /** Before INSERT/UPDATE. `created` is what the save is about to do. */
  preSave: new Signal<SavePayload>(),
  /** After INSERT/UPDATE; the instance has its PK. */
  postSave: new Signal<SavePayload>(),
  preDelete: new Signal<DeletePayload>(),
  postDelete: new Signal<DeletePayload>(),
  /** After an M2M mutation (post-action only; Django also has pre-action variants). */
  m2mChanged: new Signal<M2MChangedPayload>(),
};
