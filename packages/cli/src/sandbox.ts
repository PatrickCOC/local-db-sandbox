import { Database } from "../../core/src/index.ts";
import { SandboxServer } from "../../server/src/index.ts";
import type { RequestListener } from "../../server/src/index.ts";
import { DatabaseOwnedError, claimDatabase, claimDatabaseIfThere, formatNotice, openDatabaseStorage } from "../../storage-json/src/index.ts";
import type { DatabaseClaim, DatabaseFormat, SizeWarningListener } from "../../storage-json/src/index.ts";
import { parseSandboxConfig } from "./config.ts";

export interface StartSandboxOptions {
  /** Path to the JSON database: a single file or a database directory. */
  file: string;
  /** Overrides `$config.server.host`. */
  host?: string;
  /** Overrides `$config.server.port`. Use 0 for any free port. */
  port?: number;
  /** Receives one structured event per request. */
  onRequest?: RequestListener;
  /**
   * Largest database to accept, in MB (default 150, at most 250).
   * `limits.maxFileSizeMb` in the database's configuration can lower this,
   * not raise it.
   */
  maxFileSizeMb?: number;
  /** Receives a structured warning when the database is large. */
  onSizeWarning?: SizeWarningListener;
}

export interface RunningSandbox {
  url: string;
  host: string;
  port: number;
  database: Database;
  /** Whether the database is a single file or a directory. */
  format: DatabaseFormat;
  /** False when the database declares `"persistence": "memory"`: changes stay in this process. */
  saves: boolean;
  /** Set when the database is not in the format this build writes and was opened without saving: what that means, in a line. */
  formatNotice?: string;
  /** Stops the server; resolves once in-flight requests have finished. */
  stop(): Promise<void>;
}

/**
 * Loads a JSON database, a single file or a directory, and serves it over
 * local HTTP.
 *
 * A sandbox that saves has its database to itself while it runs (D-042): it
 * claims the database before it reads it, is refused one that another
 * process has open, and lets go of it when it stops. One that does not save
 * changes nothing another process could write over, and claims nothing.
 */
export async function startSandbox(options: StartSandboxOptions): Promise<RunningSandbox> {
  // Whether the database is saved to is known once it is loaded. Until then a refusal is kept, and raised only if it is.
  let claim: DatabaseClaim | undefined;
  let refusal: DatabaseOwnedError | undefined;
  try {
    claim = await claimDatabaseIfThere(options.file, { kind: "rest" });
  } catch (error) {
    if (!(error instanceof DatabaseOwnedError)) {
      throw error;
    }
    refusal = error;
  }
  try {
    const storage = openDatabaseStorage(options.file, {
      maxFileSizeMb: options.maxFileSizeMb,
      onSizeWarning: options.onSizeWarning,
    });
    // A database that declares memory persistence is loaded and never written to. What it declares is known once it is loaded.
    const discards = (): boolean => storage.persistence === "memory";
    const database = await Database.open({
      load: () => storage.load(),
      save: async (state) => {
        if (!discards()) {
          await storage.save(state);
        }
      },
    });
    const saves = !discards();
    if (saves) {
      if (refusal !== undefined) {
        throw refusal;
      }
      // A database in another format is refused now, with what to do about it, and not at the first change.
      storage.assertWritable();
      // One that was not there a moment ago, and is now, is claimed like any other.
      claim ??= await claimDatabase(options.file, { kind: "rest" });
    } else {
      claim?.release();
      claim = undefined;
    }
    const notice = storage.formatStatus === undefined ? undefined : formatNotice(storage.formatStatus, options.file);
    const config = parseSandboxConfig(storage.config);

    const server = new SandboxServer({
      database,
      host: options.host ?? config.host,
      port: options.port ?? config.port,
      simulation: config.simulation,
      onRequest: options.onRequest,
    });
    const address = await server.start();
    const held = claim;
    return {
      ...address,
      database,
      format: storage.format,
      saves,
      ...(notice !== undefined && { formatNotice: notice }),
      async stop() {
        try {
          await server.stop();
        } finally {
          // Last: the database is this process's for as long as a request may still save.
          held?.release();
        }
      },
    };
  } catch (error) {
    claim?.release();
    throw error;
  }
}
