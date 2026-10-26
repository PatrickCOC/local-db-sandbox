import { SandboxLimitError } from "../../core/src/index.ts";
import type { ColumnSchema, ComparisonOperator, Condition, Query, RelationalRuntime, SqlValue, TableSchema } from "../../runtime/src/index.ts";
import { PostgrestError, parseFailure, unsupported } from "./errors.ts";
import { bodyValue, filterValue, responseValue } from "./values.ts";

/*
 * The PostgREST endpoint without HTTP: one request for one table in, one
 * response out. It reads the request with an allowlist, turns it into the
 * shared Query IR, and runs that on the relational runtime. It knows the
 * tables only from the runtime's schema.
 *
 * Supported (see docs/COMPATIBILITY.md, "PostgREST endpoint"):
 *
 *   GET     select=<columns>, filters eq / gte / lt, offset, limit,
 *           Accept: application/vnd.pgrst.object+json (one row, else 406)
 *   POST    Prefer: resolution=merge-duplicates (upsert on the primary key),
 *           an object or an array of objects, columns=, on_conflict=<primary key>
 *   DELETE  with at least one filter
 *
 * Everything else that PostgREST accepts is refused with
 * SANDBOX_POSTGREST_UNSUPPORTED rather than ignored or approximated.
 */

export interface PostgrestRequest {
  method: string;
  /** The table named by the path, decoded. */
  table: string;
  query: URLSearchParams;
  /** Header values by lower-case name. */
  headers: Record<string, string | undefined>;
  /** The request body as text. */
  body?: string;
}

export interface PostgrestResponse {
  status: number;
  headers: Record<string, string>;
  /** Empty for a response without a body. */
  body: string;
}

export interface PostgrestHandlerOptions {
  /**
   * Most rows a read returns, whatever limit it asks for: PostgREST's
   * `db-max-rows`, which is 1000 on Supabase. `null` for no cap. Default 1000.
   */
  maxRows?: number | null;
}

export const DEFAULT_MAX_ROWS = 1000;

const SUPPORTED_OPERATORS: Record<string, ComparisonOperator> = { eq: "eq", gte: "gte", lt: "lt" };
/** PostgREST's other operators: known, and refused as unsupported rather than as unparseable. */
const OTHER_OPERATORS = new Set(["neq", "gt", "lte", "like", "ilike", "match", "imatch", "in", "is", "isdistinct", "fts", "plfts", "phfts", "wfts", "cs", "cd", "ov", "sl", "sr", "nxr", "nxl", "adj"]);
/** SQLite binds at most 32766 values in one statement; an upsert of many rows is split below that. */
const MAX_BOUND_VALUES = 30000;

const JSON_TYPE = "application/json; charset=utf-8";
const OBJECT_TYPE = "application/vnd.pgrst.object+json; charset=utf-8";

function json(status: number, body: unknown, headers: Record<string, string> = {}): PostgrestResponse {
  return { status, headers: { "content-type": JSON_TYPE, ...headers }, body: JSON.stringify(body) };
}

export function errorResponse(error: PostgrestError): PostgrestResponse {
  return json(error.status, error.body);
}

function tableOf(runtime: RelationalRuntime, name: string): TableSchema {
  const table = runtime.schema.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new PostgrestError(404, "PGRST205", `Could not find the table 'public.${name}' in the schema cache`);
  }
  return table;
}

/** A column name as PostgREST takes it: bare, or in double quotes. */
function unquote(name: string): string {
  return name.length >= 2 && name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;
}

function columnOf(table: TableSchema, name: string): ColumnSchema {
  const column = table.columns.find((candidate) => candidate.name === name);
  if (column === undefined) {
    throw new PostgrestError(400, "42703", `column ${table.name}.${name} does not exist`);
  }
  return column;
}

/** `select=a,b` or `*`. Anything that is not a plain column is refused by name. */
function selectedColumns(table: TableSchema, select: string | undefined): ColumnSchema[] {
  if (select === undefined) {
    return [...table.columns];
  }
  const columns: ColumnSchema[] = [];
  for (const item of select.split(",")) {
    if (item === "") {
      throw parseFailure("select parameter", `(${select})`);
    }
    if (item === "*") {
      columns.push(...table.columns);
      continue;
    }
    if (/^\w+\(\)/.test(item) || /\.\w+\(\)$/.test(item)) {
      throw unsupported(`Aggregate functions in select ("${item}")`);
    }
    if (item.includes("(") || item.includes(")") || item.includes("!") || item.startsWith("...")) {
      throw unsupported(`Embedded resources in select ("${item}")`, "Query the related table with a request of its own.");
    }
    if (item.includes("::")) {
      throw unsupported(`Casts in select ("${item}")`);
    }
    if (item.includes("->")) {
      throw unsupported(`JSON paths in select ("${item}")`);
    }
    if (item.includes(":")) {
      throw unsupported(`Renamed columns in select ("${item}")`);
    }
    columns.push(columnOf(table, unquote(item)));
  }
  // PostgREST gives a column named twice once.
  return columns.filter((column, index) => columns.indexOf(column) === index);
}

function count(name: string, text: string): number {
  if (!/^\d+$/.test(text)) {
    throw parseFailure(`${name} parameter`, `(${text})`);
  }
  return Number(text);
}

interface ParsedQuery {
  select?: string;
  where: Condition[];
  offset?: number;
  limit?: number;
  columns?: string;
  onConflict?: string;
}

function readQuery(table: TableSchema, query: URLSearchParams): ParsedQuery {
  const parsed: ParsedQuery = { where: [] };
  const once = (key: string, value: string): string => {
    if (query.getAll(key).length > 1) {
      throw parseFailure(`${key} parameter`, `"${key}" is given more than once`);
    }
    return value;
  };
  for (const [key, value] of query) {
    switch (key) {
      case "select":
        parsed.select = once(key, value);
        break;
      case "offset":
        parsed.offset = count("offset", once(key, value));
        break;
      case "limit":
        parsed.limit = count("limit", once(key, value));
        break;
      case "columns":
        parsed.columns = once(key, value);
        break;
      case "on_conflict":
        parsed.onConflict = once(key, value);
        break;
      case "order":
        throw unsupported("Ordering (order=)", "Sort the rows in the application, or use a filter.");
      case "or":
      case "and":
      case "not.or":
      case "not.and":
        throw unsupported(`Logical filters (${key}=)`);
      default:
        parsed.where.push(condition(table, key, value));
    }
  }
  return parsed;
}

/** One `column=operator.value` parameter. */
function condition(table: TableSchema, key: string, value: string): Condition {
  if (key.includes("->")) {
    throw unsupported(`JSON paths in filters ("${key}")`);
  }
  if (key.includes(".")) {
    // `table.limit`, `table.order`, `table.column=...`: options of an embedded resource.
    throw unsupported(`The query parameter "${key}" (embedded resources)`);
  }
  const column = columnOf(table, unquote(key));
  const dot = value.indexOf(".");
  const operator = dot < 0 ? value : value.slice(0, dot);
  if (operator === "not") {
    throw unsupported(`Negated filters ("${key}=${value}")`);
  }
  if (/^\w+\((any|all)\)$/.test(operator)) {
    throw unsupported(`Filter modifiers ("${operator}")`);
  }
  const op = Object.hasOwn(SUPPORTED_OPERATORS, operator) ? SUPPORTED_OPERATORS[operator] : undefined;
  if (op === undefined) {
    if (OTHER_OPERATORS.has(operator)) {
      throw unsupported(`The filter operator "${operator}"`, `Supported operators: ${Object.keys(SUPPORTED_OPERATORS).join(", ")}.`);
    }
    throw parseFailure(`filter (${value})`, `unknown operator "${operator}" in ${key}=${value}`);
  }
  if (dot < 0) {
    throw parseFailure(`filter (${value})`, `expected "${operator}.<value>"`);
  }
  return { column: column.name, op, value: filterValue(column, value.slice(dot + 1)) };
}

/** The tokens of all `Prefer` headers, which arrive joined with commas. */
function preferences(header: string | undefined): string[] {
  return (header ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
}

function refusePreference(token: string): never {
  if (token.startsWith("count=")) {
    throw unsupported(`Counting rows (Prefer: ${token})`);
  }
  if (token.startsWith("return=")) {
    throw unsupported(`Prefer: ${token}`, "Writes answer with an empty body (return=minimal). Read the rows with a request of their own.");
  }
  throw unsupported(`Prefer: ${token}`);
}

/** How a read answers: `array` (PostgREST's default) or `object` (`.single()`). */
function responseShape(accept: string | undefined): "array" | "object" {
  if (accept === undefined || accept.trim() === "") {
    return "array";
  }
  for (const entry of accept.split(",")) {
    const [media = "", ...parameters] = entry.split(";").map((part) => part.trim().toLowerCase());
    const options = parameters.filter((parameter) => !parameter.startsWith("q="));
    const shape =
      media === "application/vnd.pgrst.object+json"
        ? "object"
        : ["application/json", "application/vnd.pgrst.array+json", "application/*", "*/*"].includes(media)
          ? "array"
          : undefined;
    if (shape !== undefined) {
      if (options.length > 0) {
        throw unsupported(`Accept: ${entry.trim()}`);
      }
      return shape;
    }
  }
  throw unsupported(`Responses as ${accept}`, "The sandbox answers with JSON only.");
}

function refuseProfile(request: PostgrestRequest): void {
  for (const name of ["accept-profile", "content-profile"]) {
    const schema = request.headers[name];
    if (schema !== undefined && schema !== "public") {
      throw new PostgrestError(406, "PGRST106", "The schema must be one of the following: public", `The sandbox has one schema; ${name}: ${schema} was asked for.`);
    }
  }
}

function read(runtime: RelationalRuntime, table: TableSchema, request: PostgrestRequest, maxRows: number | null): PostgrestResponse {
  const query = readQuery(table, request.query);
  if (query.columns !== undefined || query.onConflict !== undefined) {
    throw unsupported(`${query.columns !== undefined ? "columns=" : "on_conflict="} on a read`);
  }
  const token = preferences(request.headers.prefer)[0];
  if (token !== undefined) {
    refusePreference(token);
  }
  const shape = responseShape(request.headers.accept);
  const columns = selectedColumns(table, query.select);
  const offset = query.offset ?? 0;
  const limit = maxRows === null ? query.limit : Math.min(query.limit ?? maxRows, maxRows);
  const select: Query = { kind: "select", table: table.name, columns: columns.map((column) => column.name), where: query.where };
  if (limit !== undefined) {
    select.limit = limit;
  }
  if (offset > 0) {
    select.offset = offset;
  }
  const rows = runtime.run(select).rows.map((row) => Object.fromEntries(columns.map((column) => [column.name, responseValue(column, row[column.name])])));
  const range = rows.length === 0 ? "*/*" : `${offset}-${offset + rows.length - 1}/*`;
  if (shape === "object") {
    if (rows.length !== 1) {
      throw new PostgrestError(406, "PGRST116", "Cannot coerce the result to a single JSON object", `The result contains ${rows.length} rows`);
    }
    return { status: 200, headers: { "content-type": OBJECT_TYPE, "content-range": range }, body: JSON.stringify(rows[0]) };
  }
  return json(200, rows, { "content-range": range });
}

function columnList(text: string): string[] {
  return text.split(",").map((name) => unquote(name.trim()));
}

/** The rows of a JSON request body. */
function bodyRows(text: string | undefined): Record<string, unknown>[] {
  let body: unknown;
  try {
    body = JSON.parse(text ?? "");
  } catch {
    throw new PostgrestError(400, "PGRST102", "Empty or invalid json");
  }
  const rows = Array.isArray(body) ? body : [body];
  if (rows.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
    throw new PostgrestError(400, "PGRST102", "Empty or invalid json", "The body must be a JSON object or an array of JSON objects.");
  }
  return rows as Record<string, unknown>[];
}

function upsert(runtime: RelationalRuntime, table: TableSchema, request: PostgrestRequest): PostgrestResponse {
  const query = readQuery(table, request.query);
  if (query.select !== undefined) {
    throw unsupported("Returning the written rows (select= on a write)", "Writes answer with an empty body (return=minimal). Read the rows with a request of their own.");
  }
  if (query.where.length > 0 || query.limit !== undefined || query.offset !== undefined) {
    throw unsupported("Filters, limit, or offset on an insert");
  }
  const tokens = preferences(request.headers.prefer);
  let merge = false;
  for (const token of tokens) {
    if (token === "resolution=merge-duplicates") {
      merge = true;
    } else if (token !== "return=minimal") {
      refusePreference(token);
    }
  }
  if (!merge) {
    throw unsupported("An insert without Prefer: resolution=merge-duplicates", "The sandbox supports upsert on the primary key (supabase-js: .upsert()); .insert() is not part of this spike.");
  }

  const key = table.columns.filter((column) => column.primary).map((column) => column.name);
  if (key.length === 0) {
    throw unsupported(`An upsert into "${table.name}", which has no primary key`);
  }
  if (query.onConflict !== undefined) {
    const named = columnList(query.onConflict);
    if (named.length !== key.length || named.some((name) => !key.includes(name))) {
      throw unsupported(`on_conflict=${query.onConflict}`, `The v0 subset upserts on the primary key (${key.join(", ")}) only.`);
    }
  }

  const rows = bodyRows(request.body);
  let names: string[];
  if (query.columns !== undefined) {
    // Keys outside columns= are ignored, and a key that a row lacks is NULL, as in PostgREST.
    names = columnList(query.columns);
  } else {
    names = Object.keys(rows[0] ?? {});
    const expected = [...names].sort().join("\0");
    if (rows.some((row) => Object.keys(row).sort().join("\0") !== expected)) {
      throw new PostgrestError(400, "PGRST102", "All object keys must match");
    }
  }
  const columns = names.map((name) => {
    const column = table.columns.find((candidate) => candidate.name === name);
    if (column === undefined) {
      throw new PostgrestError(400, "PGRST204", `Could not find the '${name}' column of '${table.name}' in the schema cache`);
    }
    return column;
  });

  const preferenceApplied = ["resolution=merge-duplicates", ...(tokens.includes("return=minimal") ? ["return=minimal"] : [])].join(", ");
  const done: PostgrestResponse = { status: 201, headers: { "content-range": "*/*", "preference-applied": preferenceApplied }, body: "" };
  if (rows.length === 0 || columns.length === 0) {
    return done;
  }
  const values = rows.map((row) => Object.fromEntries(columns.map((column) => [column.name, bodyValue(column, row[column.name])])) as Record<string, SqlValue>);
  const perStatement = Math.max(1, Math.floor(MAX_BOUND_VALUES / columns.length));
  transaction(runtime, () => {
    for (let start = 0; start < values.length; start += perStatement) {
      runtime.run({ kind: "upsert", table: table.name, rows: values.slice(start, start + perStatement), conflict: key, action: "update" });
    }
  });
  return done;
}

function remove(runtime: RelationalRuntime, table: TableSchema, request: PostgrestRequest): PostgrestResponse {
  const query = readQuery(table, request.query);
  if (query.select !== undefined) {
    throw unsupported("Returning the deleted rows (select= on a write)");
  }
  if (query.limit !== undefined || query.offset !== undefined || query.columns !== undefined || query.onConflict !== undefined) {
    throw unsupported("limit, offset, columns, or on_conflict on a delete");
  }
  for (const token of preferences(request.headers.prefer)) {
    if (token !== "return=minimal") {
      refusePreference(token);
    }
  }
  if (query.where.length === 0) {
    // Supabase runs PostgREST with pg-safeupdate, which refuses this.
    throw new PostgrestError(400, "21000", "DELETE requires a WHERE clause");
  }
  transaction(runtime, () => runtime.run({ kind: "delete", table: table.name, where: query.where }));
  return { status: 204, headers: { "content-range": "*/*" }, body: "" };
}

/** One request is one transaction, as in PostgREST: a write that fails leaves nothing behind. */
function transaction(runtime: RelationalRuntime, work: () => void): void {
  runtime.begin();
  try {
    work();
    runtime.commit();
  } catch (error) {
    if (runtime.inTransaction) {
      runtime.rollback();
    }
    throw error;
  }
}

/** A failure of the runtime, as PostgREST would report the same failure of PostgreSQL. */
function runtimeFailure(error: unknown, table: string): PostgrestError {
  if (error instanceof PostgrestError) {
    return error;
  }
  if (error instanceof SandboxLimitError) {
    return new PostgrestError(507, error.code, error.message, null, "The sandbox refused the write because the database would be larger than its size limit.");
  }
  const message = error instanceof Error ? error.message : String(error);
  const notNull = /NOT NULL constraint failed: [^.]+\.(\S+)/.exec(message);
  if (notNull !== null) {
    return new PostgrestError(400, "23502", `null value in column "${notNull[1]}" of relation "${table}" violates not-null constraint`, message);
  }
  if (/UNIQUE constraint failed|PRIMARY KEY/.test(message)) {
    return new PostgrestError(409, "23505", "duplicate key value violates unique constraint", message);
  }
  if (/FOREIGN KEY constraint failed/.test(message)) {
    return new PostgrestError(409, "23503", `insert or update on table "${table}" violates foreign key constraint`, message);
  }
  if (/CHECK constraint failed/.test(message)) {
    return new PostgrestError(400, "23514", `new row for relation "${table}" violates check constraint`, message);
  }
  return new PostgrestError(500, "SANDBOX_RUNTIME_ERROR", message);
}

/** Answers one PostgREST request for a table. Never throws: failures are responses. */
export function handlePostgrestRequest(runtime: RelationalRuntime, request: PostgrestRequest, options: PostgrestHandlerOptions = {}): PostgrestResponse {
  const maxRows = options.maxRows === undefined ? DEFAULT_MAX_ROWS : options.maxRows;
  try {
    if (request.headers.range !== undefined) {
      throw unsupported("The Range header", "Use offset and limit (supabase-js: .range()).");
    }
    refuseProfile(request);
    const table = tableOf(runtime, request.table);
    try {
      switch (request.method) {
        case "GET":
          return read(runtime, table, request, maxRows);
        case "POST":
          return upsert(runtime, table, request);
        case "DELETE":
          return remove(runtime, table, request);
        case "HEAD":
          throw unsupported("HEAD requests (supabase-js: select with head or count)");
        case "PATCH":
          throw unsupported("Updating rows (PATCH, supabase-js: .update())", "Use .upsert() on the primary key.");
        case "PUT":
          throw unsupported("PUT (single-row upsert)", "Use .upsert() (POST).");
        default:
          throw new PostgrestError(405, "PGRST117", `Unsupported HTTP method: ${request.method}`);
      }
    } catch (error) {
      throw runtimeFailure(error, table.name);
    }
  } catch (error) {
    return errorResponse(runtimeFailure(error, request.table));
  }
}
