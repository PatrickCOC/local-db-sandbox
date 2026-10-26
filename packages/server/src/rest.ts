import { SandboxError } from "../../core/src/index.ts";
import type { Database, FilterSpec, QuerySpec, Row, SandboxErrorCode, SortSpec } from "../../core/src/index.ts";

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Failure that originates in the HTTP layer itself, not in a core operation. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, headers?: Record<string, string>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const statusByCode: Record<SandboxErrorCode, number> = {
  COLLECTION_NOT_FOUND: 404,
  ROW_NOT_FOUND: 404,
  DUPLICATE_ID: 409,
  INVALID_ROW: 400,
  INVALID_QUERY: 400,
  // 507 Insufficient Storage: the write was refused because the database would be too large.
  SANDBOX_SIZE_LIMIT: 507,
};

function errorBody(code: string, message: string): unknown {
  return { error: { code, message } };
}

export function errorResponse(error: unknown): RestResponse {
  if (error instanceof SandboxError) {
    return { status: statusByCode[error.code], body: errorBody(error.code, error.message) };
  }
  if (error instanceof HttpError) {
    return { status: error.status, headers: error.headers, body: errorBody(error.code, error.message) };
  }
  return { status: 500, body: errorBody("INTERNAL_ERROR", "The sandbox failed to complete the request.") };
}

/** Splits a URL path into decoded segments. */
export function splitPath(pathname: string): string[] {
  try {
    return pathname.split("/").filter((segment) => segment !== "").map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "INVALID_PATH", "The request path is not valid.");
  }
}

function methodNotAllowed(allowed: string): HttpError {
  return new HttpError(405, "METHOD_NOT_ALLOWED", `Allowed methods: ${allowed}.`, { allow: allowed });
}

/** Unparseable numbers become NaN so the core, not this layer, rejects them. */
function toCount(text: string): number {
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

/**
 * Translates a URL query string into the core query model.
 *
 *   _sort=name,-age   sort by name ascending, then age descending
 *   _limit, _offset   pagination
 *   anything else     equality filter on that field
 */
export function toQuerySpec(collection: string, params: URLSearchParams): QuerySpec {
  const filters: FilterSpec[] = [];
  const sort: SortSpec[] = [];
  const spec: QuerySpec = { collection, filters, sort };

  for (const [key, value] of params) {
    if (key === "_sort") {
      for (const part of value.split(",")) {
        const descending = part.startsWith("-");
        sort.push({ field: descending ? part.slice(1) : part, direction: descending ? "desc" : "asc" });
      }
    } else if (key === "_limit") {
      spec.limit = toCount(value);
    } else if (key === "_offset") {
      spec.offset = toCount(value);
    } else {
      filters.push({ field: key, op: "eq", value });
    }
  }
  return spec;
}

/**
 * Maps one REST request onto a core operation. All data rules (validation,
 * IDs, missing rows) are the core's; failures surface as thrown errors.
 */
export async function handleRest(
  database: Database,
  method: string,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<RestResponse> {
  const segments = splitPath(url.pathname);
  const [collection, id] = segments;

  if (collection === undefined) {
    if (method !== "GET") {
      throw methodNotAllowed("GET");
    }
    return { status: 200, body: { collections: database.listCollections() } };
  }

  if (id === undefined) {
    switch (method) {
      case "GET": {
        const { rows, total } = database.query(toQuerySpec(collection, url.searchParams));
        return { status: 200, headers: { "x-total-count": String(total) }, body: rows };
      }
      case "POST":
        return { status: 201, body: await database.insert(collection, (await readBody()) as Row) };
      default:
        throw methodNotAllowed("GET, POST");
    }
  }

  if (segments.length > 2) {
    throw new HttpError(404, "NOT_FOUND", `No route for ${url.pathname}.`);
  }

  switch (method) {
    case "GET":
      return { status: 200, body: database.findById(collection, id) };
    case "PUT":
      return { status: 200, body: await database.replace(collection, id, (await readBody()) as Row) };
    case "PATCH":
      return { status: 200, body: await database.patch(collection, id, (await readBody()) as Row) };
    case "DELETE":
      return { status: 200, body: await database.remove(collection, id) };
    default:
      throw methodNotAllowed("GET, PUT, PATCH, DELETE");
  }
}
