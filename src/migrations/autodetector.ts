/**
 * The autodetector (design §10.3): diff two project states into operations.
 *
 * Like Django: new/removed models, added/removed/altered fields, table and
 * ordering changes — with rename detection that asks before assuming. The
 * `ask` callback abstracts the interactive "Did you rename X to Y? [y/N]"
 * prompt (the CLI wires it to stdin; tests inject answers; non-TTY says no).
 */
import type { SerializedField } from "../fields.ts";
import { ProjectState, type ModelState } from "./state.ts";
import { ops, sameFieldDef, type Operation } from "./operations.ts";

export type Asker = (question: string) => Promise<boolean>;

/** Default asker: never assume a rename (Django's --noinput behavior). */
export const noAsker: Asker = async () => false;

/** Order createModel ops so FK/M2M targets come before the models that point at them. */
function topoSortNewModels(names: string[], to: ProjectState): string[] {
  const inSet = new Set(names);
  const visited = new Set<string>();
  const out: string[] = [];
  const visit = (name: string, trail: Set<string>) => {
    if (visited.has(name) || !inSet.has(name)) return;
    if (trail.has(name)) return; // cycle — emit in encounter order; SQLite tolerates it
    trail.add(name);
    for (const [, def] of to.getModel(name).fields) {
      if (def.to && def.to !== name) visit(def.to, trail);
    }
    trail.delete(name);
    visited.add(name);
    out.push(name);
  };
  for (const n of names) visit(n, new Set());
  return out;
}

function fieldMap(m: ModelState): Map<string, SerializedField> {
  return new Map(m.fields);
}

/** Diff `from` -> `to` and return the operations that transform one into the other. */
export async function autodetectChanges(
  from: ProjectState,
  to: ProjectState,
  ask: Asker = noAsker,
): Promise<Operation[]> {
  const operations: Operation[] = [];
  const fromNames = new Set(from.models.keys());
  const toNames = new Set(to.models.keys());

  let added = [...toNames].filter((n) => !fromNames.has(n));
  let removed = [...fromNames].filter((n) => !toNames.has(n));

  // --- model renames: a removed model whose fields exactly match an added one.
  for (const oldName of [...removed]) {
    const oldModel = from.getModel(oldName);
    for (const newName of added) {
      const newModel = to.getModel(newName);
      const sameFields =
        oldModel.fields.length === newModel.fields.length &&
        oldModel.fields.every(
          ([n, def], i) => newModel.fields[i]![0] === n && sameFieldDef(def, newModel.fields[i]![1]),
        );
      if (sameFields && (await ask(`Did you rename model ${oldName} to ${newName}?`))) {
        operations.push(ops.renameModel(oldName, newName));
        removed = removed.filter((n) => n !== oldName);
        added = added.filter((n) => n !== newName);
        break;
      }
    }
  }

  // --- new models, dependency-ordered
  for (const name of topoSortNewModels(added, to)) {
    const m = to.getModel(name);
    operations.push(
      ops.createModel(name, Object.fromEntries(m.fields), { dbTable: m.dbTable, ordering: m.ordering }),
    );
  }

  // --- removed models
  for (const name of removed) {
    operations.push(ops.deleteModel(name));
  }

  // --- common models: field-level changes
  for (const name of toNames) {
    if (!fromNames.has(name)) continue;
    const oldModel = from.getModel(name);
    const newModel = to.getModel(name);
    const oldFields = fieldMap(oldModel);
    const newFields = fieldMap(newModel);

    let addedFields = [...newFields.keys()].filter((f) => !oldFields.has(f));
    let removedFields = [...oldFields.keys()].filter((f) => !newFields.has(f));

    // field renames: identical def removed+added under a different name
    for (const oldField of [...removedFields]) {
      const oldDef = oldFields.get(oldField)!;
      for (const newField of addedFields) {
        if (
          sameFieldDef(oldDef, newFields.get(newField)!) &&
          (await ask(`Did you rename ${name}.${oldField} to ${name}.${newField}?`))
        ) {
          operations.push(ops.renameField(name, oldField, newField));
          removedFields = removedFields.filter((f) => f !== oldField);
          addedFields = addedFields.filter((f) => f !== newField);
          break;
        }
      }
    }

    for (const f of addedFields) operations.push(ops.addField(name, f, newFields.get(f)!));
    for (const f of removedFields) operations.push(ops.removeField(name, f));

    // altered fields
    for (const [f, newDef] of newFields) {
      const oldDef = oldFields.get(f);
      if (oldDef && !sameFieldDef(oldDef, newDef)) {
        operations.push(ops.alterField(name, f, newDef));
      }
    }

    // model-option changes
    if (oldModel.dbTable !== newModel.dbTable) {
      operations.push(ops.alterModelTable(name, newModel.dbTable));
    }
    if (JSON.stringify(oldModel.ordering) !== JSON.stringify(newModel.ordering)) {
      operations.push(ops.alterModelOptions(name, { ordering: newModel.ordering }));
    }
  }

  return operations;
}
