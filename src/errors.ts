/**
 * Error types mirroring Django's ORM exceptions.
 *
 * Django attaches `DoesNotExist` and `MultipleObjectsReturned` as subclasses on
 * every model (e.g. `Author.DoesNotExist`). We reproduce that in `model.ts` by
 * minting per-model subclasses of these bases at registration time.
 */

/** Base class for all dorm errors, so `catch (e) { if (e instanceof DormError) }` works. */
export class DormError extends Error {}

/** Raised by `get()` / `getOrCreate()` when no row matches — Django's `Model.DoesNotExist`. */
export class DoesNotExist extends DormError {}

/** Raised by `get()` when more than one row matches — Django's `Model.MultipleObjectsReturned`. */
export class MultipleObjectsReturned extends DormError {}

/** Raised for misconfiguration: unknown field, missing manager, bad relation, etc. */
export class FieldError extends DormError {}

/** Raised when the ORM is used before a database connection has been configured. */
export class ConnectionError extends DormError {}

/** Raised by the schema/compiler layer when an operation is not supported by a backend. */
export class NotSupportedError extends DormError {}
