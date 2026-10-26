/*
 * How far a step of a migration plan can be written as SQL for PostgreSQL
 * without knowing the rows (D-039). Every step of a plan is one of four:
 *
 * - `safe`: written as it is. It leaves every row as it is, and either cannot
 *   fail because of the rows, or is a key, constraint, or index, which
 *   PostgreSQL checks against the rows and refuses as a whole when they do
 *   not fit.
 * - `requiresExplicitCast`: a column's type changes, and PostgreSQL has no
 *   conversion of its values that is known to keep every one of them: it has
 *   none at all (`text` to `integer`), or the one it has rounds, cuts, or
 *   depends on the session. How the values are to be converted (`USING`) is
 *   the author's to say. Never written.
 * - `requiresDataMigration`: the statement is the right one for the schema,
 *   and whether it can be carried out depends on the rows: a column that
 *   becomes NOT NULL, a type made narrower, a value taken out of an
 *   enumerated type. Rows that do not fit have to be changed first, and
 *   nothing here makes up what to change them to. Written only on the
 *   caller's word that the rows fit, and marked; PostgreSQL then still
 *   refuses the statement as a whole when they do not, and changes none.
 * - `unsupported`: what the canonical schema does not say, or what
 *   PostgreSQL cannot have. Never written.
 *
 * `safe` says nothing of what a change is meant to do: a dropped table is
 * gone with its rows, and a statement that drops them says so (`dropsData`).
 */

export type SafetyClass = "safe" | "requiresExplicitCast" | "requiresDataMigration" | "unsupported";

/** Why a step is not `safe`, as a word a program can read. Each belongs to one class (`CLASS_OF`). */
export type SafetyReason =
  /** PostgreSQL has no conversion between the two types that is known to keep every value. */
  | "no-safe-conversion"
  /** A column becomes NOT NULL: no row may hold NULL in it. */
  | "rows-may-hold-null"
  /** A NOT NULL column without a default is added: a table with rows has no value for it. */
  | "rows-need-a-value"
  /** A column's type becomes narrower: PostgreSQL refuses a value that does not fit. */
  | "values-may-not-fit"
  /** Values go from an enumerated type: no row may hold one of them. */
  | "rows-may-hold-removed-value"
  /** The schema does not say what the type is, only how it was spelled. */
  | "no-canonical-type"
  /** A type of another database, or one whose PostgreSQL spelling the schema does not hold. */
  | "type-not-representable"
  /** A constant that is no value of its type, or that the schema does not hold exactly. */
  | "value-not-representable"
  /** A name PostgreSQL would not keep as it is: empty, with a NUL, or longer than 63 bytes. */
  | "name-not-representable"
  /** An expression with nothing in it, or with a NUL. */
  | "expression-not-representable"
  /** Numbering that the schema does not hold enough of: on a column that takes NULL or is no whole number, or given to a column that is there already. */
  | "numbering-not-representable"
  /** A constraint without a name is dropped, or has to go and come back: PostgreSQL drops a constraint by its name. */
  | "constraint-name-unknown"
  /** An index over columns and expressions both: the schema does not say in which order. */
  | "index-elements-order-unknown"
  /** An index of which the schema only says that there is more to it than it holds (`sourceClauses`). */
  | "index-not-representable"
  /** A key or a constraint of which the schema only says that there is more to it than it holds (`sourceClauses`). */
  | "constraint-not-representable"
  /** An expression whose text names something that was renamed since it was written, or may: the text is not what its database has. */
  | "stale-expression-after-rename"
  /** An action of a foreign key that PostgreSQL does not have. */
  | "unknown-referential-action"
  /** A column of a primary key that the schema says takes NULL: in PostgreSQL it cannot. */
  | "primary-key-column-takes-null"
  /** A foreign key to columns that no primary key, unique constraint, or unique index is over. */
  | "foreign-key-without-key"
  /** A default that is no value of its column's enumerated type, which nothing in the plan changes. */
  | "default-not-a-value-of-its-type"
  /** Two objects whose names PostgreSQL keeps in one place would have one name. */
  | "name-conflict";

/** The reasons that say something of the rows: those of `requiresDataMigration`. */
export type DataReason = "rows-may-hold-null" | "rows-need-a-value" | "values-may-not-fit" | "rows-may-hold-removed-value";

/** The reasons a step is never written for, whatever is said of the rows. */
export type RefusalReason = Exclude<SafetyReason, DataReason>;

export const CLASS_OF: { readonly [Reason in SafetyReason]: Reason extends DataReason ? "requiresDataMigration" : "requiresExplicitCast" | "unsupported" } = {
  "no-safe-conversion": "requiresExplicitCast",
  "rows-may-hold-null": "requiresDataMigration",
  "rows-need-a-value": "requiresDataMigration",
  "values-may-not-fit": "requiresDataMigration",
  "rows-may-hold-removed-value": "requiresDataMigration",
  "no-canonical-type": "unsupported",
  "type-not-representable": "unsupported",
  "value-not-representable": "unsupported",
  "name-not-representable": "unsupported",
  "expression-not-representable": "unsupported",
  "numbering-not-representable": "unsupported",
  "constraint-name-unknown": "unsupported",
  "index-elements-order-unknown": "unsupported",
  "index-not-representable": "unsupported",
  "constraint-not-representable": "unsupported",
  "stale-expression-after-rename": "unsupported",
  "unknown-referential-action": "unsupported",
  "primary-key-column-takes-null": "unsupported",
  "foreign-key-without-key": "unsupported",
  "default-not-a-value-of-its-type": "unsupported",
  "name-conflict": "unsupported",
};

/**
 * Something that cannot be written as SQL, found while a step is written:
 * thrown where it is found, and caught by the generator, which reports it as
 * what the step is refused for.
 *
 * It is never for what rests on the rows. Such a step is written whole and
 * marked, and whether the plan is refused for it is decided after the last
 * step: so a step that was left half written is always one that refuses the
 * plan.
 */
export class Refusal extends Error {
  readonly safety: "requiresExplicitCast" | "unsupported";
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason, detail: string) {
    super(detail);
    this.name = "Refusal";
    this.reason = reason;
    this.safety = CLASS_OF[reason];
  }
}

export function refuse(reason: RefusalReason, detail: string): never {
  throw new Refusal(reason, detail);
}
