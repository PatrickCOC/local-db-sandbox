import type { RelationalRuntime } from "../../runtime/src/index.ts";
import type { DatabaseClaim, DatabaseFormat } from "../../storage-json/src/index.ts";
import type { AccessLimits } from "./access.ts";
import { startControlServer } from "./control-server.ts";
import { LocalRuntimeAccess } from "./local-access.ts";

/*
 * What a process does that has a database open on the relational runtime,
 * so that others can look into it (D-042): it gives access to its runtime,
 * serves that on this machine, and says where in its owner's record. Every
 * such process does it this one way: the PostgREST endpoint, the NestJS
 * sandbox, and Studio when it has a database to itself.
 *
 * The claim is made by the caller, before it loads the database, and stays
 * the caller's to let go of: a database is someone's before it is read.
 */

export interface ServeRuntimeOptions {
  /** The claim this process has on the database. Where the runtime is served is written into its record. */
  claim: DatabaseClaim;
  runtime: RelationalRuntime;
  format: DatabaseFormat;
  /** Why nothing may be changed through the access, when that is so. A single-file database never is. */
  readOnly?: string;
  limits?: Partial<AccessLimits>;
}

export interface ServedRuntime {
  /** The access that is served: the same one for whoever asks in this process. */
  readonly access: LocalRuntimeAccess;
  /** Where it is served. The token is in the owner's record, and nowhere else. */
  readonly url: string;
  /**
   * Stops serving, and takes where it served out of the record. The runtime
   * is not closed and the database is not let go of: both are the caller's.
   * Harmless when done twice.
   */
  close(): Promise<void>;
}

/** Serves a runtime that this process has open to the other processes of this machine. */
export async function serveRuntime(options: ServeRuntimeOptions): Promise<ServedRuntime> {
  const { claim } = options;
  const access = new LocalRuntimeAccess({
    runtime: options.runtime,
    identity: { instance: claim.record.instance, pid: claim.record.pid, kind: claim.record.kind, database: claim.record.database, format: options.format },
    ...(options.readOnly !== undefined && { readOnly: options.readOnly }),
    ...(options.limits !== undefined && { limits: options.limits }),
  });
  let server;
  try {
    server = await startControlServer({ access });
    claim.publish({ url: server.url, token: server.token });
  } catch (error) {
    access.close();
    await server?.close();
    throw error;
  }
  const serving = server;
  let closed: Promise<void> | undefined;
  return {
    access,
    url: serving.url,
    close() {
      closed ??= (async () => {
        try {
          // First, so that no one is sent where nothing answers any more.
          claim.publish(undefined);
        } catch {
          // The database was let go of already, and its record with it.
        }
        access.close();
        await serving.close();
      })();
      return closed;
    },
  };
}
