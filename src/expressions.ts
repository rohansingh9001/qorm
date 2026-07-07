/**
 * `Q` objects — composable WHERE conditions.
 *
 * Django composes Q objects with the `&`, `|`, `~` operators. JS has no operator
 * overloading (design 5.4), so we expose `.and()`, `.or()`, `.not()` methods with
 * identical semantics. `Q` is callable without `new`, matching the design's
 * `Q({ ... }).or(Q({ ... }))` style.
 *
 *   Q({ name__startswith: "A" }).or(Q({ name__startswith: "B" }))
 *   Q({ active: true }).and(Q({ age__gte: 18 }).not())
 */
import type { Condition } from "./query/ast.ts";
import { conditionFromObject, type FilterObject } from "./query/lookups.ts";

export interface QExpr {
  readonly __isQ: true;
  readonly condition: Condition;
  and(other: QExpr | FilterObject): QExpr;
  or(other: QExpr | FilterObject): QExpr;
  not(): QExpr;
}

export function isQ(value: unknown): value is QExpr {
  return (
    typeof value === "object" && value !== null && (value as { __isQ?: unknown }).__isQ === true
  );
}

/** Coerce a Q or a plain filter object to a condition node. */
export function toCondition(arg: QExpr | FilterObject): Condition {
  return isQ(arg) ? arg.condition : conditionFromObject(arg);
}

function make(condition: Condition): QExpr {
  return {
    __isQ: true,
    condition,
    and(other) {
      return make({ kind: "and", children: [condition, toCondition(other)] });
    },
    or(other) {
      return make({ kind: "or", children: [condition, toCondition(other)] });
    },
    not() {
      return make({ kind: "not", child: condition });
    },
  };
}

export function Q(arg: QExpr | FilterObject): QExpr {
  return make(toCondition(arg));
}

/* ----------------------------------------------------------------------------
 * F() expressions — reference a column inside a query (design 5.4).
 *
 *   Book.objects.filter({ stock__lt: F("threshold") })   // column vs column
 *   Book.objects.update({ price: F("price").mul(1.1) })   // arithmetic in SQL
 *
 * JS can't overload `+ - * /`, so arithmetic is `.add()/.sub()/.mul()/.div()`.
 * ------------------------------------------------------------------------- */

export type FAst =
  | { t: "col"; name: string }
  | { t: "lit"; value: unknown }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; l: FAst; r: FAst };

export interface FExpression {
  readonly __isF: true;
  readonly ast: FAst;
  add(other: FExpression | number): FExpression;
  sub(other: FExpression | number): FExpression;
  mul(other: FExpression | number): FExpression;
  div(other: FExpression | number): FExpression;
}

export function isF(value: unknown): value is FExpression {
  return (
    typeof value === "object" && value !== null && (value as { __isF?: unknown }).__isF === true
  );
}

function operandAst(other: FExpression | number): FAst {
  return isF(other) ? other.ast : { t: "lit", value: other };
}

function makeF(ast: FAst): FExpression {
  const bin =
    (op: "+" | "-" | "*" | "/") =>
    (other: FExpression | number): FExpression =>
      makeF({ t: "bin", op, l: ast, r: operandAst(other) });
  return { __isF: true, ast, add: bin("+"), sub: bin("-"), mul: bin("*"), div: bin("/") };
}

/** Reference the column `name` (relation spanning allowed: `F("author__age")`). */
export function F(name: string): FExpression {
  return makeF({ t: "col", name });
}

/* ----------------------------------------------------------------------------
 * Aggregate functions (design 5.5) — used in `aggregate()` and `annotate()`.
 *
 *   Author.objects.aggregate({ avgAge: Avg("age") })
 *   Author.objects.annotate({ numBooks: Count("books") })   // reverse relation
 * ------------------------------------------------------------------------- */

export type AggFn = "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";

export interface AggregateExpr {
  readonly __isAgg: true;
  readonly fn: AggFn;
  /** Field path / reverse-relation accessor, or "*" for `Count()`. */
  readonly source: string;
  readonly distinct: boolean;
}

export function isAggregate(value: unknown): value is AggregateExpr {
  return (
    typeof value === "object" && value !== null && (value as { __isAgg?: unknown }).__isAgg === true
  );
}

function agg(fn: AggFn, source: string, distinct = false): AggregateExpr {
  return { __isAgg: true, fn, source, distinct };
}

/** `Count("*")` counts rows; `Count("books")` counts a related set; `{ distinct: true }` for COUNT(DISTINCT …). */
export function Count(source = "*", opts: { distinct?: boolean } = {}): AggregateExpr {
  return agg("COUNT", source, opts.distinct ?? false);
}
export function Sum(source: string): AggregateExpr {
  return agg("SUM", source);
}
export function Avg(source: string): AggregateExpr {
  return agg("AVG", source);
}
export function Min(source: string): AggregateExpr {
  return agg("MIN", source);
}
export function Max(source: string): AggregateExpr {
  return agg("MAX", source);
}

/* ----------------------------------------------------------------------------
 * Database functions (design 5.5) — usable in `annotate()`.
 *
 *   Author.objects.annotate({ lower: Lower("name") })
 *   Author.objects.annotate({ display: Coalesce("nickname", "name", Value("anon")) })
 *
 * String args are column references (relation spanning allowed); numbers and
 * booleans are literals; use `Value(...)` for string literals.
 * ------------------------------------------------------------------------- */

export interface ValueExpr {
  readonly __isValue: true;
  readonly value: unknown;
}

export function Value(value: unknown): ValueExpr {
  return { __isValue: true, value };
}

export function isValue(v: unknown): v is ValueExpr {
  return typeof v === "object" && v !== null && (v as { __isValue?: unknown }).__isValue === true;
}

export type FuncArg = string | number | boolean | ValueExpr | FExpression | FuncExpr;

export interface FuncExpr {
  readonly __isFunc: true;
  readonly kind: string;
  readonly args: FuncArg[];
  /** Only for Cast(). */
  readonly castType?: string;
}

export function isFunc(v: unknown): v is FuncExpr {
  return typeof v === "object" && v !== null && (v as { __isFunc?: unknown }).__isFunc === true;
}

function func(kind: string, args: FuncArg[], castType?: string): FuncExpr {
  return castType === undefined
    ? { __isFunc: true, kind, args }
    : { __isFunc: true, kind, args, castType };
}

export function Lower(arg: FuncArg): FuncExpr {
  return func("LOWER", [arg]);
}
export function Upper(arg: FuncArg): FuncExpr {
  return func("UPPER", [arg]);
}
export function Length(arg: FuncArg): FuncExpr {
  return func("LENGTH", [arg]);
}
export function Abs(arg: FuncArg): FuncExpr {
  return func("ABS", [arg]);
}
export function Round(arg: FuncArg, digits?: number): FuncExpr {
  return func("ROUND", digits === undefined ? [arg] : [arg, digits]);
}
export function Coalesce(...args: FuncArg[]): FuncExpr {
  return func("COALESCE", args);
}
/** String concatenation; compiles to `a || b || ...`. */
export function Concat(...args: FuncArg[]): FuncExpr {
  return func("CONCAT", args);
}
/** Current timestamp; compiles to `datetime('now')` on SQLite. */
export function Now(): FuncExpr {
  return func("NOW", []);
}
export function Cast(arg: FuncArg, castType: string): FuncExpr {
  return func("CAST", [arg], castType);
}

/* ----------------------------------------------------------------------------
 * Window functions (design 5.5).
 *
 *   Book.objects.annotate({
 *     rank: Window(Rank(), { partitionBy: ["authorId"], orderBy: ["-price"] }),
 *     runningTotal: Window(Sum("price"), { orderBy: ["id"] }),
 *   })
 * ------------------------------------------------------------------------- */

export interface WindowExpr {
  readonly __isWindow: true;
  readonly expr: AggregateExpr | FuncExpr;
  readonly partitionBy: string[];
  readonly orderBy: string[];
}

export function isWindow(v: unknown): v is WindowExpr {
  return typeof v === "object" && v !== null && (v as { __isWindow?: unknown }).__isWindow === true;
}

export function Window(
  expr: AggregateExpr | FuncExpr,
  opts: { partitionBy?: string[]; orderBy?: string[] } = {},
): WindowExpr {
  return {
    __isWindow: true,
    expr,
    partitionBy: opts.partitionBy ?? [],
    orderBy: opts.orderBy ?? [],
  };
}

/** Pure window functions (no argument). */
export function RowNumber(): FuncExpr {
  return func("ROW_NUMBER", []);
}
export function Rank(): FuncExpr {
  return func("RANK", []);
}
export function DenseRank(): FuncExpr {
  return func("DENSE_RANK", []);
}

/** Anything `annotate()` accepts. */
export type AnnotationExpr = AggregateExpr | FuncExpr | FExpression | WindowExpr;
