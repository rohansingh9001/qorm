/**
 * Migration executor: plan and apply/unapply migrations against a backend.
 *
 * Forward: run each unapplied migration's operations in order, each migration
 * inside a transaction, then record it. Backward (`migrate <target>` /
 * `migrate zero`): invert each applied migration's operations (reversed) using
 * the state *before* that migration — Django's exact model.
 *
 * SQLite specifics: `PRAGMA foreign_keys` is toggled OFF around each migration
 * (it is a no-op inside a transaction, so it happens outside BEGIN) to keep the
 * table-rebuild dance safe.
 */
import type { Backend } from "../backends/base.ts";
import { ProjectState } from "./state.ts";
import { type Operation, type OpContext } from "./operations.ts";
import { buildStates, resolveSquashes, type LoadedMigration } from "./loader.ts";
import { MigrationRecorder } from "./recorder.ts";
import { atomicOn } from "../transaction.ts";
import { DormError } from "../errors.ts";

export interface MigrationPlanStep {
  migration: LoadedMigration;
  direction: "forward" | "backward";
}

export interface MigrateOptions {
  /** Migration name, unique prefix (e.g. "0002"), or "zero" to unapply everything. */
  target?: string;
  /** Record/unrecord without touching the schema (Django's --fake). */
  fake?: boolean;
}

export interface MigrateResult {
  plan: MigrationPlanStep[];
  applied: string[];
  unapplied: string[];
}

function resolveTarget(migrations: LoadedMigration[], target: string): number {
  if (target === "zero") return -1;
  const matches = migrations.filter((m) => m.name === target || m.name.startsWith(target));
  if (matches.length === 0) throw new DormError(`No migration matches "${target}".`);
  if (matches.length > 1) {
    throw new DormError(`"${target}" is ambiguous: ${matches.map((m) => m.name).join(", ")}.`);
  }
  return migrations.indexOf(matches[0]!);
}

/** The state in effect *before* migration index i (empty state for i = 0). */
function stateBefore(statesAfter: ProjectState[], i: number): ProjectState {
  return i === 0 ? new ProjectState() : statesAfter[i - 1]!;
}

export class MigrationExecutor {
  private readonly backend: Backend;
  private readonly allMigrations: LoadedMigration[];
  private readonly recorder: MigrationRecorder;
  private migrations: LoadedMigration[];
  private statesAfter: ProjectState[];
  private resolved = false;

  constructor(backend: Backend, migrations: LoadedMigration[]) {
    this.backend = backend;
    this.allMigrations = migrations;
    this.migrations = migrations;
    this.recorder = new MigrationRecorder(backend);
    this.statesAfter = [];
  }

  /** Resolve squashed migrations against the recorder, then build states. */
  private async resolve(): Promise<void> {
    if (this.resolved) return;
    const recorded = new Set(await this.recorder.applied());
    const { active, impliedApplied } = resolveSquashes(this.allMigrations, recorded);
    this.migrations = active;
    this.statesAfter = buildStates(active);
    // Bookkeeping: a squash whose entire history is applied counts as applied.
    for (const name of impliedApplied) {
      if (!recorded.has(name)) await this.recorder.record(name);
    }
    this.resolved = true;
  }

  /** Validate recorded names against files; returns applied names in file order. */
  private async appliedInOrder(): Promise<string[]> {
    await this.resolve();
    const recorded = new Set(await this.recorder.applied());
    const replaced = new Set(this.allMigrations.flatMap((m) => m.replaces));
    for (const name of recorded) {
      // Superseded-by-squash names may remain recorded; everything else needs a file.
      if (!this.migrations.some((m) => m.name === name) && !replaced.has(name)) {
        throw new DormError(`Applied migration "${name}" has no file on disk.`);
      }
    }
    return this.migrations.filter((m) => recorded.has(m.name)).map((m) => m.name);
  }

  /** Compute the plan to reach `target` (default: latest). */
  async plan(target?: string): Promise<MigrationPlanStep[]> {
    await this.resolve();
    const applied = new Set(await this.appliedInOrder());
    const targetIndex = target === undefined ? this.migrations.length - 1 : resolveTarget(this.migrations, target);

    const steps: MigrationPlanStep[] = [];
    // Backward: unapply everything after the target, latest first.
    for (let i = this.migrations.length - 1; i > targetIndex; i--) {
      const mig = this.migrations[i]!;
      if (applied.has(mig.name)) steps.push({ migration: mig, direction: "backward" });
    }
    // Forward: apply everything up to and including the target.
    for (let i = 0; i <= targetIndex; i++) {
      const mig = this.migrations[i]!;
      if (!applied.has(mig.name)) steps.push({ migration: mig, direction: "forward" });
    }
    return steps;
  }

  /** Execute the plan. */
  async migrate(opts: MigrateOptions = {}): Promise<MigrateResult> {
    await this.resolve();
    const plan = await this.plan(opts.target);
    const applied: string[] = [];
    const unapplied: string[] = [];

    for (const step of plan) {
      const i = this.migrations.indexOf(step.migration);
      const before = stateBefore(this.statesAfter, i);
      const after = this.statesAfter[i]!;

      if (!opts.fake) {
        if (step.direction === "forward") {
          await this.runOperations(step.migration.operations, before, after);
        } else {
          // Invert against the state each op saw: replay forward to get per-op
          // before-states, then run the inverses latest-op-first.
          const inverses: Array<{ op: Operation; before: ProjectState; after: ProjectState }> = [];
          let cursor = before.clone();
          for (const op of step.migration.operations) {
            const opBefore = cursor.clone();
            op.stateForwards(cursor);
            inverses.push({ op: op.inverse(opBefore), before: cursor.clone(), after: opBefore });
          }
          for (const { op, before: b, after: a } of inverses.reverse()) {
            await this.runOps([op], b, a);
          }
        }
      }

      if (step.direction === "forward") {
        await this.recorder.record(step.migration.name);
        applied.push(step.migration.name);
      } else {
        await this.recorder.unrecord(step.migration.name);
        unapplied.push(step.migration.name);
      }
    }
    return { plan, applied, unapplied };
  }

  /** Run one migration's ops forward, tracking intermediate states per op. */
  private async runOperations(operations: Operation[], before: ProjectState, _after: ProjectState): Promise<void> {
    let cursor = before.clone();
    for (const op of operations) {
      const opBefore = cursor.clone();
      op.stateForwards(cursor);
      await this.runOps([op], opBefore, cursor.clone());
    }
  }

  /** Execute ops inside a transaction with FK enforcement off (rebuild safety). */
  private async runOps(operations: Operation[], before: ProjectState, after: ProjectState): Promise<void> {
    const ctx: OpContext = {
      backend: this.backend,
      exec: async (sql: string) => {
        await this.backend.exec(sql);
      },
      collecting: false,
    };
    await this.backend.disableForeignKeys();
    try {
      await atomicOn(this.backend, async () => {
        for (const op of operations) await op.databaseForwards(ctx, before, after);
      });
    } finally {
      await this.backend.enableForeignKeys();
    }
  }

  /** The SQL one migration would run forward, without executing it (sqlmigrate). */
  async collectSql(name: string): Promise<string[]> {
    await this.resolve();
    const i = resolveTarget(this.migrations, name);
    if (i < 0) throw new DormError("Cannot collect SQL for 'zero'.");
    const mig = this.migrations[i]!;
    const before = stateBefore(this.statesAfter, i);

    const collected: string[] = [];
    let cursor = before.clone();
    for (const op of mig.operations) {
      const opBefore = cursor.clone();
      op.stateForwards(cursor);
      const opAfter = cursor.clone();
      const sqls = await this.backend.schema.collect(async () => {
        const ctx: OpContext = {
          backend: this.backend,
          exec: async (sql: string) => {
            collected.push(sql);
          },
          collecting: true,
        };
        await op.databaseForwards(ctx, opBefore, opAfter);
      });
      collected.push(...sqls);
    }
    return collected;
  }
}
