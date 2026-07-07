/**
 * Migration loader: import every migration file in a directory, in order, and
 * replay their operations into ProjectStates.
 *
 * A migration file default-exports `{ dependencies, operations }` where
 * `operations` is either an Operation[] or a factory `(ops) => Operation[]`
 * (what the writer emits). Within the single implicit app, order is the file
 * number; `dependencies` is validated to point at the preceding migration.
 */
import { pathToFileURL } from "node:url";
import { ProjectState } from "./state.ts";
import { ops as opsNamespace, type Operation, type Ops } from "./operations.ts";
import { listMigrationFiles } from "./writer.ts";
import { DormError } from "../errors.ts";

export interface LoadedMigration {
  name: string;
  number: number;
  file: string;
  dependencies: string[];
  operations: Operation[];
  /** Names this squashed migration stands in for (empty for normal migrations). */
  replaces: string[];
}

interface MigrationModuleShape {
  dependencies?: string[];
  replaces?: string[];
  operations: Operation[] | ((ops: Ops) => Operation[]);
}

export async function loadMigrations(dir: string): Promise<LoadedMigration[]> {
  const files = listMigrationFiles(dir);
  const out: LoadedMigration[] = [];
  for (const { number, name, file } of files) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: MigrationModuleShape };
    const def = mod.default;
    if (!def || typeof def !== "object" || !("operations" in def)) {
      throw new DormError(`Migration ${file} must default-export { dependencies, operations }.`);
    }
    const operations =
      typeof def.operations === "function" ? def.operations(opsNamespace) : def.operations;
    if (!Array.isArray(operations)) {
      throw new DormError(
        `Migration ${name}: operations must be (ops) => Operation[] or an array.`,
      );
    }
    out.push({
      name,
      number,
      file,
      dependencies: def.dependencies ?? [],
      operations,
      replaces: def.replaces ?? [],
    });
  }
  return out;
}

/**
 * Resolve squashed migrations against the applied set (design 10.1).
 *
 * For each squash: if every replaced migration is applied, the squash counts as
 * applied and supersedes them (`impliedApplied`); if none are applied (fresh
 * database, or originals deleted), the squash is used directly; if only some
 * are applied, the originals stay active and the squash waits — exactly
 * Django's transition behavior.
 */
export function resolveSquashes(
  migrations: LoadedMigration[],
  applied: ReadonlySet<string>,
): { active: LoadedMigration[]; impliedApplied: Set<string> } {
  const impliedApplied = new Set<string>();
  let active = [...migrations];
  for (const squash of migrations.filter((m) => m.replaces.length > 0)) {
    const present = new Set(migrations.map((m) => m.name));
    const replacedOnDisk = squash.replaces.filter((n) => present.has(n));
    const appliedReplaced = squash.replaces.filter((n) => applied.has(n));

    if (appliedReplaced.length === squash.replaces.length) {
      // Fully applied history: squash supersedes the originals.
      active = active.filter((m) => !squash.replaces.includes(m.name));
      impliedApplied.add(squash.name);
    } else if (appliedReplaced.length === 0) {
      // Fresh database (or originals already deleted): use the squash.
      active = active.filter((m) => !squash.replaces.includes(m.name));
    } else if (replacedOnDisk.length > 0) {
      // Partially applied: keep using the originals; the squash waits.
      active = active.filter((m) => m.name !== squash.name);
    }
  }
  return { active, impliedApplied };
}

/**
 * Replay migrations into states. Returns the state *after* each migration —
 * `statesAfter[i]` is the schema once `migrations[i]` has run; index -1
 * (conceptually) is the empty state.
 */
export function buildStates(migrations: LoadedMigration[]): ProjectState[] {
  const states: ProjectState[] = [];
  let current = new ProjectState();
  for (const mig of migrations) {
    current = current.clone();
    for (const op of mig.operations) op.stateForwards(current);
    states.push(current);
  }
  return states;
}

/** The final state after every migration (empty when there are none). */
export function finalState(migrations: LoadedMigration[]): ProjectState {
  const states = buildStates(migrations);
  return states.length > 0 ? states[states.length - 1]! : new ProjectState();
}
