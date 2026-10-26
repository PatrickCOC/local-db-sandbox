import { AccessError } from "./access.ts";
import type { AccessInfo, BrowseRequest, BrowseResult, ChangeResult, EventsResult, RequestOptions, RowKey, RowResult, RuntimeAccess, SchemaInfo, SqlRequest, SqlResult } from "./access.ts";

/**
 * An access through which nothing is changed, whatever the access behind it
 * would allow (D-042): what whoever was started to look only has of a
 * runtime. A change is refused here and never reaches the access behind it;
 * a request to the console is passed on only to read, where SQLite refuses
 * whatever would write.
 */
export class ReadOnlyAccess implements RuntimeAccess {
  readonly #access: RuntimeAccess;
  readonly #reason: string;

  constructor(access: RuntimeAccess, reason: string) {
    this.#access = access;
    this.#reason = reason;
  }

  #refuse(): Promise<never> {
    return Promise.reject(new AccessError("READ_ONLY", this.#reason));
  }

  async info(options?: RequestOptions): Promise<AccessInfo> {
    return { ...(await this.#access.info(options)), readOnly: this.#reason };
  }

  schema(options?: RequestOptions): Promise<SchemaInfo> {
    return this.#access.schema(options);
  }

  browse(request: BrowseRequest, options?: RequestOptions): Promise<BrowseResult> {
    return this.#access.browse(request, options);
  }

  row(request: { table: string; key: RowKey }, options?: RequestOptions): Promise<RowResult> {
    return this.#access.row(request, options);
  }

  insert(_request: { table: string; values: Record<string, unknown> }, _options?: RequestOptions): Promise<ChangeResult> {
    return this.#refuse();
  }

  update(_request: { table: string; key: RowKey; values: Record<string, unknown> }, _options?: RequestOptions): Promise<ChangeResult> {
    return this.#refuse();
  }

  delete(_request: { table: string; key: RowKey }, _options?: RequestOptions): Promise<ChangeResult> {
    return this.#refuse();
  }

  sql(request: SqlRequest, options?: RequestOptions): Promise<SqlResult> {
    return request?.mode === "write" ? this.#refuse() : this.#access.sql(request, options);
  }

  events(request?: { after?: number }, options?: RequestOptions): Promise<EventsResult> {
    return this.#access.events(request, options);
  }
}
