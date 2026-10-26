/** A single record in a collection. */
export type Row = Record<string, unknown>;

export interface DatabaseMeta {
  version: number;
}

/**
 * In-memory database state used by the core.
 *
 * This is deliberately not the on-disk JSON document: storage adapters
 * translate between their own format and this model.
 */
export interface DatabaseState {
  meta: DatabaseMeta;
  collections: Record<string, Row[]>;
}

/** Value of a row's `id` field. */
export type RowId = string | number;
