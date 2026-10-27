import { canonicalDatabasePath, describeOwner, inspectOwner } from "../../storage-json/src/index.ts";
import type { OwnerInspection, OwnerKind } from "../../storage-json/src/index.ts";
import { AccessError, assertMadeFor } from "./access.ts";
import type { AccessInfo, BrowseRequest, BrowseResult, ChangeResult, EventsResult, RequestOptions, RowKey, RowResult, RuntimeAccess, SchemaInfo, SnapshotRequest, SnapshotResult, SqlRequest, SqlResult, ClearRequest, ClearResult } from "./access.ts";
import { ControlClient } from "./control-client.ts";
import type { ControlClientOptions } from "./control-client.ts";

/*
 * Access to a database that another process has open (D-042), for as long
 * as some process has it open: it outlasts a restart of that process.
 *
 * It never opens the database. It finds the process that has it by the
 * record next to the database (`writer-owner.ts`), makes sure that what
 * answers there is that owner and has this database, and asks it. When the
 * owner is gone, it is attached to no one until another process has the
 * database, and says so meanwhile. It does not become the owner itself:
 * that would keep the process out that is about to come back.
 *
 * What it does by itself, and what it does not:
 *
 * - A request that changes nothing, and finds the owner gone, is asked
 *   again of the owner that has the database now.
 * - A request that changes the database is sent to the owner this access is
 *   attached to at that moment, once. It is never sent again, by whatever
 *   ended it; and this access does not look for another owner in order to
 *   send it. Whoever asked for the change decides, after looking.
 * - A request that names the owner it was made for (`RequestOptions.owner`)
 *   is carried out by that owner or by none.
 */

/** The process an access is attached to. */
export interface AttachedOwner {
  instance: string;
  pid: number;
  kind: OwnerKind;
  startedAt: string;
}

export interface AttachedAccessOptions {
  /** The database, by any path that leads to it. */
  database: string;
  /** How the owner's record is read and its owner asked whether it is there. Default: the storage's own (`inspectOwner`). */
  inspect?: (database: string) => Promise<OwnerInspection>;
  /** How long an answer may take, and how much of one is read. */
  client?: ControlClientOptions;
}

const NOTHING_SENT = "Nothing was sent, and nothing was done.";

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Whether a failure says that the owner is not there, or is not the owner: nothing about what was asked. */
function ownerIsGone(error: unknown): error is AccessError {
  return error instanceof AccessError && (error.code === "OWNER_UNREACHABLE" || error.code === "OWNER_CHANGED" || error.code === "UNAUTHORIZED");
}

export class AttachedRuntimeAccess implements RuntimeAccess {
  /** The database, by its canonical path: what an owner has to say it has open. */
  readonly database: string;
  readonly #inspect: (database: string) => Promise<OwnerInspection>;
  readonly #clientOptions: ControlClientOptions | undefined;
  #client: ControlClient | undefined;
  #owner: AttachedOwner | undefined;
  #reason: string | undefined = "The process that has the database open was not looked for yet.";
  /** One search at a time: whoever else asks meanwhile gets its outcome. */
  #finding: Promise<ControlClient | undefined> | undefined;

  constructor(options: AttachedAccessOptions) {
    this.database = canonicalDatabasePath(options.database);
    this.#inspect = options.inspect ?? ((database) => inspectOwner(database));
    this.#clientOptions = options.client;
  }

  /** The process this access is attached to; `undefined` while it is attached to none. */
  get owner(): AttachedOwner | undefined {
    return this.#owner === undefined ? undefined : { ...this.#owner };
  }

  /** Why this access is attached to no process; `undefined` while it is attached to one. */
  get disconnected(): string | undefined {
    return this.#owner === undefined ? this.#reason : undefined;
  }

  /**
   * Looks whether the owner still answers, and for the database's owner when
   * there is none. Resolves with whether the access is attached to an owner
   * now. Never rejects, and changes nothing anywhere.
   */
  async check(): Promise<boolean> {
    const client = this.#client;
    if (client !== undefined) {
      try {
        await client.health();
        return true;
      } catch (error) {
        this.#lose(client, error);
      }
    }
    return (await this.#find()) !== undefined;
  }

  // --- finding the owner, and losing it ------------------------------------------------------------------

  #detached(reason: string): undefined {
    this.#client = undefined;
    this.#owner = undefined;
    this.#reason = reason;
    return undefined;
  }

  /** The owner it was attached to did not answer as the owner. Not said of an owner that another search has found since. */
  #lose(client: ControlClient, error: unknown): void {
    if (this.#client !== client) {
      return;
    }
    this.#detached(
      error instanceof AccessError && error.code === "OUTCOME_UNKNOWN"
        ? "A change was sent to the process that had the database open, and no answer came: whether it was carried out is not known."
        : "The process that had the database open does not answer any more.",
    );
  }

  #find(): Promise<ControlClient | undefined> {
    this.#finding ??= this.#look().finally(() => (this.#finding = undefined));
    return this.#finding;
  }

  async #look(): Promise<ControlClient | undefined> {
    let found: OwnerInspection;
    try {
      found = await this.#inspect(this.database);
    } catch (error) {
      return this.#detached(`The record of the database's owner cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (found.state === "none") {
      return this.#detached("No process has the database open.");
    }
    if (found.state === "stale") {
      return this.#detached(`The process that had the database open is gone (${found.reason}).`);
    }
    const record = found.record;
    if (record === undefined) {
      return this.#detached("A process is opening the database right now.");
    }
    // A record is of the database it lies next to. One that says otherwise was put there, and is no one's to follow.
    if (record.database !== this.database) {
      return this.#detached(`The record next to the database is of another database (${record.database}).`);
    }
    if (record.control === undefined) {
      return this.#detached(`${sentence(describeOwner(record))} has the database open, and does not serve its runtime.`);
    }
    if (!found.responsive) {
      return this.#detached(`${sentence(describeOwner(record))} has the database open, and does not answer.`);
    }
    let client: ControlClient;
    let info: AccessInfo;
    try {
      client = new ControlClient({ url: record.control.url, token: record.control.token, instance: record.instance }, this.#clientOptions);
      info = await client.info();
    } catch (error) {
      return this.#detached(error instanceof AccessError && error.code === "OWNER_UNREACHABLE" ? error.message : `What answers at ${record.control.url} is not the owner of this database.`);
    }
    // Before anything is asked of it: it is the owner the record names, and what it has open is this database.
    if (info?.instance !== record.instance || info.database !== this.database) {
      return this.#detached(`What answers at ${record.control.url} is not the owner of this database.`);
    }
    this.#client = client;
    this.#owner = { instance: record.instance, pid: record.pid, kind: record.kind, startedAt: record.startedAt };
    this.#reason = undefined;
    return client;
  }

  // --- asking it ----------------------------------------------------------------------------------------------

  /** A request that changes nothing: asked again of the owner that has the database now, when the one it was sent to is gone. */
  async #read<T>(options: RequestOptions | undefined, ask: (client: ControlClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const client = this.#client ?? (await this.#find());
      if (client === undefined) {
        throw new AccessError("OWNER_UNREACHABLE", this.#reason ?? "No process has the database open.");
      }
      // Whoever asks for another owner than the one that is there is told so, and the access stays attached.
      assertMadeFor(client.instance, options);
      try {
        return await ask(client);
      } catch (error) {
        if (!ownerIsGone(error)) {
          throw error;
        }
        this.#lose(client, error);
        if (attempt > 0) {
          throw error;
        }
      }
    }
  }

  /** A request that changes the database: sent once, to the owner this access is attached to now. */
  async #write<T>(options: RequestOptions | undefined, ask: (client: ControlClient) => Promise<T>): Promise<T> {
    const client = this.#client;
    if (client === undefined) {
      throw new AccessError("OWNER_UNREACHABLE", `${this.#reason ?? "No process has the database open."} ${NOTHING_SENT}`);
    }
    assertMadeFor(client.instance, options);
    try {
      return await ask(client);
    } catch (error) {
      if (ownerIsGone(error) || (error instanceof AccessError && error.code === "OUTCOME_UNKNOWN")) {
        this.#lose(client, error);
      }
      throw error;
    }
  }

  info(options?: RequestOptions): Promise<AccessInfo> {
    return this.#read(options, (client) => client.info());
  }

  schema(options?: RequestOptions): Promise<SchemaInfo> {
    return this.#read(options, (client) => client.schema());
  }

  browse(request: BrowseRequest, options?: RequestOptions): Promise<BrowseResult> {
    return this.#read(options, (client) => client.browse(request));
  }

  row(request: { table: string; key: RowKey }, options?: RequestOptions): Promise<RowResult> {
    return this.#read(options, (client) => client.row(request));
  }

  insert(request: { table: string; values: Record<string, unknown> }, options?: RequestOptions): Promise<ChangeResult> {
    return this.#write(options, (client) => client.insert(request));
  }

  update(request: { table: string; key: RowKey; values: Record<string, unknown> }, options?: RequestOptions): Promise<ChangeResult> {
    return this.#write(options, (client) => client.update(request));
  }

  delete(request: { table: string; key: RowKey }, options?: RequestOptions): Promise<ChangeResult> {
    return this.#write(options, (client) => client.delete(request));
  }

  sql(request: SqlRequest, options?: RequestOptions): Promise<SqlResult> {
    // Allowed to change the database or not: the request says so itself.
    return request?.mode === "write" ? this.#write(options, (client) => client.sql(request)) : this.#read(options, (client) => client.sql(request));
  }

  events(request?: { after?: number }, options?: RequestOptions): Promise<EventsResult> {
    return this.#read(options, (client) => client.events(request));
  }

  snapshot(request: SnapshotRequest, options?: RequestOptions): Promise<SnapshotResult> {
    return this.#read(options, (client) => client.snapshot(request));
  }

  clear(request: ClearRequest, options?: RequestOptions): Promise<ClearResult> {
    return this.#write(options, (client) => client.clear(request));
  }
}
