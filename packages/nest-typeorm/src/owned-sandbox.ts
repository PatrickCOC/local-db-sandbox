import { serveRuntime } from "../../runtime-access/src/index.ts";
import { claimDatabase, claimDatabaseIfThere, databaseFormatFor } from "../../storage-json/src/index.ts";
import { openTypeormSandbox } from "./typeorm-runtime.ts";
import type { TypeormSandbox, TypeormSandboxOptions } from "./typeorm-runtime.ts";

/*
 * The sandbox of an application that runs (D-042): its database is the
 * application's process's while it runs, and other processes of this machine
 * look into it through that process, which serves its runtime for that.
 *
 * `openTypeormSandbox` itself claims nothing: it is what a script or a test
 * opens a database with, for a moment. This is what `SandboxModule` opens,
 * for as long as an application lives.
 */

export interface OwnedTypeormSandbox extends TypeormSandbox {
  /**
   * Ends the sandbox: no one is sent to its runtime any more, the DataSource
   * is closed, and with it the runtime, and the database is let go of.
   * Harmless when done twice.
   */
  close(): Promise<void>;
}

export async function openOwnedTypeormSandbox(options: TypeormSandboxOptions): Promise<OwnedTypeormSandbox> {
  // What is known of saving before the database is read is what was asked for.
  const owner = { kind: "nest" as const, ...(options.persistence !== undefined && { persistence: options.persistence }) };
  // Claimed before it is read: what another process saved meanwhile would otherwise be written over.
  let claim = await claimDatabaseIfThere(options.file, owner);
  let sandbox: TypeormSandbox | undefined;
  try {
    sandbox = await openTypeormSandbox(options);
    // A database that was not there a moment ago, and is now, is claimed like any other.
    claim ??= await claimDatabase(options.file, owner);
    const served = await serveRuntime({ claim, runtime: sandbox.runtime, format: databaseFormatFor(options.file) });
    const { dataSource } = sandbox;
    const held = claim;
    let closed: Promise<void> | undefined;
    return {
      ...sandbox,
      close() {
        closed ??= (async () => {
          try {
            await served.close();
            if (dataSource.isInitialized) {
              await dataSource.destroy();
            }
          } finally {
            // Last: the database is this process's for as long as anything of it may still be written.
            held.release();
          }
        })();
        return closed;
      },
    };
  } catch (error) {
    if (sandbox?.dataSource.isInitialized) {
      await sandbox.dataSource.destroy().catch(() => undefined);
    }
    claim?.release();
    throw error;
  }
}
