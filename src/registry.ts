/**
 * The model registry.
 *
 * Django auto-registers models via a metaclass and lets you reference them by
 * string ("app.Model"). We have no metaclasses (design §4.2), so registration is
 * explicit (`Model.register()` / `defineModel()`), but the registry still backs
 * string relation refs and lets the (future) migration autoloader find every model.
 */
import type { ModelClass } from "./types.ts";
import { FieldError } from "./errors.ts";

const models = new Map<string, ModelClass>();

export function registerModel(model: ModelClass): void {
  const name = model.modelName;
  const existing = models.get(name);
  if (existing && existing !== model) {
    throw new FieldError(`A different model named "${name}" is already registered.`);
  }
  models.set(name, model);
}

export function getModel(name: string): ModelClass {
  const m = models.get(name);
  if (!m) {
    throw new FieldError(
      `No model named "${name}" is registered. Known models: ${[...models.keys()].join(", ") || "(none)"}.`,
    );
  }
  return m;
}

export function hasModel(name: string): boolean {
  return models.has(name);
}

export function allModels(): ModelClass[] {
  return [...models.values()];
}

/** Test/teardown helper: drop all registrations. */
export function clearRegistry(): void {
  models.clear();
}
