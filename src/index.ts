/**
 * Public API — mirrors what you'd import from `django.db.models` (design §3).
 *
 *   import { Model, fields, defineModel, Q, connect } from "dorm";
 */

// Models & fields
export { Model, defineModel } from "./model.ts";
export type { Meta, RegisterOptions, DefinedModel } from "./model.ts";
export { fields, Field } from "./fields.ts";
export type { FieldOptions, OnDelete, RelatedRef, ForeignKeyOptions } from "./fields.ts";

// Querying
export { QuerySet, CombinedQuerySet } from "./queryset.ts";
export { Manager, RelatedManager, ManyRelatedManager } from "./manager.ts";
export {
  Q,
  F,
  Value,
  Count,
  Sum,
  Avg,
  Min,
  Max,
  Lower,
  Upper,
  Length,
  Abs,
  Round,
  Coalesce,
  Concat,
  Now,
  Cast,
  Window,
  RowNumber,
  Rank,
  DenseRank,
} from "./expressions.ts";
export type { QExpr, FExpression, AggregateExpr, FuncExpr, WindowExpr, AnnotationExpr } from "./expressions.ts";

// Transactions & signals
export { transaction, atomic } from "./transaction.ts";
export { signals, Signal } from "./signals.ts";
export type { SavePayload, DeletePayload, M2MChangedPayload } from "./signals.ts";

// Migrations (programmatic API; the `dorm` CLI is the usual entry point)
export { ops } from "./migrations/operations.ts";
export type { Operation, Ops } from "./migrations/operations.ts";
export { ProjectState, StateApps } from "./migrations/state.ts";
export { autodetectChanges } from "./migrations/autodetector.ts";
export { writeMigration, writeSquashedMigration, renderMigration, listMigrationFiles } from "./migrations/writer.ts";
export { loadMigrations, finalState, buildStates, resolveSquashes } from "./migrations/loader.ts";
export { MigrationExecutor } from "./migrations/executor.ts";
export { MigrationRecorder } from "./migrations/recorder.ts";

// Configuration & connections
export { defineConfig, connect, configure, createBackend, getConnection, closeAll } from "./connection.ts";
export type { DormConfig, DatabaseConfig, Engine } from "./connection.ts";

// Backends (for advanced use / custom wiring)
export { SqliteBackend } from "./backends/sqlite.ts";
export type { Backend, SchemaEditor, RunResult } from "./backends/base.ts";

// Errors (per-model subclasses of DoesNotExist/MultipleObjectsReturned are minted at registration)
export {
  DormError,
  DoesNotExist,
  MultipleObjectsReturned,
  FieldError,
  ConnectionError,
  NotSupportedError,
} from "./errors.ts";

// Registry & shared types
export { getModel, allModels, clearRegistry } from "./registry.ts";
export type { ModelClass, ModelInstance, ModelMeta } from "./types.ts";
