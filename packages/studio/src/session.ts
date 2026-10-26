import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AttachedRuntimeAccess, LocalRuntimeAccess, ReadOnlyAccess, SINGLE_FILE_READ_ONLY, serveRuntime } from "../../runtime-access/src/index.ts";
import type { AccessInfo, RuntimeAccess } from "../../runtime-access/src/index.ts";
import { SqlConsole } from "../../sql-console/src/index.ts";
import { DatabaseFormatError, DatabaseOwnedError, JsonStorageError, SERVING_OWNER_KINDS, canonicalDatabasePath, claimDatabase, databaseFormatFor, describeOwner, inspectOwner, ownerRecordPath } from "../../storage-json/src/index.ts";
import type { DatabaseFormat, OwnerInspection, OwnerRecord, SizeWarningListener } from "../../storage-json/src/index.ts";

/*
 * How Local DB Studio has a database (D-042). There are three ways, and
 * which one it is follows from the database and from who has it open:
 *
 * - A directory that no process has open: Studio has it to itself
 *   (`standalone`). It claims it, opens it on the relational runtime, and may
 *   change it. It serves the runtime like every owner does, so a second
 *   Studio attaches to the first.
 * - A database that a process has open and serves: Studio looks into it
 *   through that process (`attached`), and never opens it. Attached it stays:
 *   while the process is away, it is connected to no one, and does not take
 *   the database for itself, which would keep out the process that is about
 *   to come back.
 * - To look only (a single file, always; a directory with `readOnly`):
 *   through the process that has the database open when one serves it, and
 *   otherwise what is stored, opened without claiming it and never written.
 *
 * It is never a second writer. A directory that a process has open which
 * serves no runtime is refused to a Studio that would change it.
 *
 * Nothing here executes anything: every operation is the runtime's, through
 * its access (`packages/runtime-access`).
 */

export type StudioMode = "standalone" | "attached";

export const READ_ONLY_REQUESTED = "Studio was started with --read-only.";

export interface StudioSessionOptions {
  /** The database: a directory or a single file. */
  database: string;
  /** Change nothing, whatever the database is. */
  readOnly?: boolean;
  /** How long to wait for a sandbox that has claimed the database and has not said yet where it serves, in ms (default 5000). */
  attachWaitMs?: number;
  /** Largest database to accept when Studio opens it itself, in MB (default 150, at most 250). */
  maxFileSizeMb?: number;
  onSizeWarning?: SizeWarningListener;
}

export interface StudioStatus {
  /** The database, by its canonical path. */
  database: string;
  format: DatabaseFormat;
  mode: StudioMode;
  /** Whether a runtime answers now. Always, when Studio opened the database itself. */
  connected: boolean;
  /** Why none does, while none does. */
  disconnected?: string;
  /** What the runtime's access says of itself: whose it is, whether it can be changed, how many tables. Absent while not connected. */
  info?: AccessInfo;
  /** What Studio has to say about how it opened the database. */
  notices: string[];
}

export interface StudioSession {
  readonly mode: StudioMode;
  /** The database, by its canonical path. */
  readonly database: string;
  readonly format: DatabaseFormat;
  /** The access to the runtime: every operation of Studio is one of its operations. */
  readonly access: RuntimeAccess;
  readonly notices: string[];
  /** How things are now. Attached, it looks whether the process still answers, and for the one that has taken its place. Never rejects. */
  status(): Promise<StudioStatus>;
  /** Ends the session. A database Studio had to itself is let go of. Harmless when done twice. */
  close(): Promise<void>;
}

const DEFAULT_ATTACH_WAIT_MS = 5000;

/**
 * What a Studio that has a directory to itself says of it: a sandbox that is
 * started meanwhile is refused the database, and the database comes to a
 * sandbox in three steps that whoever runs Studio takes. Studio lets go of
 * nothing by itself, and starts nothing.
 */
export const STANDALONE_OWNER_NOTICE =
  "Studio has this database to itself. While it runs, a sandbox that is started on the database is refused: one process has a database open to write at a time. " +
  "To use the database with an application, stop Studio (Ctrl+C in its terminal), start the sandbox, and start Studio again. It then attaches to the sandbox, and both show the same rows.";

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Who has the database, once a sandbox that is just starting has had time to say where it serves. */
async function ownerOf(database: string, waitMs: number): Promise<OwnerInspection> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = await inspectOwner(database);
    const starting = found.state === "live" && (found.record === undefined || (found.record.control === undefined && SERVING_OWNER_KINDS.has(found.record.kind)));
    if (!starting || Date.now() >= deadline) {
      return found;
    }
    await delay(100);
  }
}

/** Why a Studio that would change the database does not open one that a process has which cannot be asked. */
function owned(path: string, record: OwnerRecord | undefined): DatabaseOwnedError {
  const error = new DatabaseOwnedError(path, record, ownerRecordPath(path));
  error.message +=
    record !== undefined && SERVING_OWNER_KINDS.has(record.kind)
      ? "\nThat process has not said where it serves its runtime: it may still be starting. Try again in a moment."
      : "\nThat process does not serve its runtime, so Studio cannot look into the database through it. With --read-only, Studio shows the database as it is stored.";
  return error;
}

interface Opened {
  mode: StudioMode;
  access: RuntimeAccess;
  attached?: AttachedRuntimeAccess;
  notices: string[];
  close(): Promise<void>;
}

/** Opens what is stored, to read it: nothing is claimed, and nothing is ever written. `reason`: why it is only read, when that is not the database's own format. */
async function look(path: string, database: string, format: DatabaseFormat, reason: string | undefined, notices: string[], options: StudioSessionOptions): Promise<Opened> {
  const opened = await SqlConsole.open({ file: path, readOnly: true, ...(options.maxFileSizeMb !== undefined && { maxFileSizeMb: options.maxFileSizeMb }), ...(options.onSizeWarning !== undefined && { onSizeWarning: options.onSizeWarning }) });
  const access = new LocalRuntimeAccess({
    runtime: opened.runtime,
    identity: { instance: randomBytes(24).toString("hex"), kind: "studio", database, format },
    readOnly: reason ?? opened.formatNotice ?? READ_ONLY_REQUESTED,
  });
  return {
    mode: "standalone",
    access,
    notices: [...notices, ...(opened.formatNotice === undefined ? [] : [opened.formatNotice])],
    async close() {
      access.close();
      opened.close();
    },
  };
}

/** Takes a directory that no process has: claims it before it is read, opens it on the runtime, and serves the runtime. */
async function own(path: string, database: string, format: DatabaseFormat, options: StudioSessionOptions): Promise<Opened> {
  const claim = await claimDatabase(path, { kind: "studio" });
  let opened: SqlConsole | undefined;
  try {
    opened = await SqlConsole.open({ file: path, ...(options.maxFileSizeMb !== undefined && { maxFileSizeMb: options.maxFileSizeMb }), ...(options.onSizeWarning !== undefined && { onSizeWarning: options.onSizeWarning }) });
    const served = await serveRuntime({ claim, runtime: opened.runtime, format });
    const console = opened;
    return {
      mode: "standalone",
      access: served.access,
      notices: [STANDALONE_OWNER_NOTICE],
      async close() {
        try {
          await served.close();
          console.close();
        } finally {
          claim.release();
        }
      },
    };
  } catch (error) {
    opened?.close();
    claim.release();
    // A format this build reads and does not write (D-028): nothing upgrades a database as a side effect of opening it.
    if (error instanceof DatabaseFormatError && (error.code === "DATABASE_MIGRATION_REQUIRED" || error.code === "DATABASE_FORMAT_READ_ONLY")) {
      return look(path, database, format, undefined, [], options);
    }
    throw error;
  }
}

/** Opens a session of Studio on a database. See the head of this file for which way. */
export async function openStudioSession(options: StudioSessionOptions): Promise<StudioSession> {
  const path = resolve(options.database);
  if (!existsSync(path)) {
    throw new JsonStorageError(`Database not found: ${path}`);
  }
  const database = canonicalDatabasePath(path);
  const format = databaseFormatFor(path);
  // Why nothing is changed through this session, when that is so from the start.
  const lookOnly = options.readOnly === true ? READ_ONLY_REQUESTED : format === "file" ? SINGLE_FILE_READ_ONLY : undefined;

  let opened: Opened | undefined;
  for (let attempt = 0; opened === undefined; attempt += 1) {
    const found = await ownerOf(database, options.attachWaitMs ?? DEFAULT_ATTACH_WAIT_MS);
    if (found.state === "live" && found.record?.control !== undefined) {
      const attached = new AttachedRuntimeAccess({ database });
      if (await attached.check()) {
        opened = { mode: "attached", attached, access: lookOnly === undefined ? attached : new ReadOnlyAccess(attached, lookOnly), notices: [], close: async () => undefined };
      } else if (attempt >= 2) {
        throw new JsonStorageError(`${attached.disconnected ?? "The process that has the database open does not answer."} Studio did not start.`);
      }
      // Else: it went away, or was replaced, between the two looks. Looked at again.
    } else if (found.state === "live") {
      if (lookOnly === undefined) {
        throw owned(path, found.record);
      }
      const whose = found.record === undefined ? "A process is opening the database right now." : `${sentence(describeOwner(found.record))} has the database open.`;
      opened = await look(path, database, format, lookOnly, [`${whose} What is shown is the database as it was stored when Studio opened it.`], options);
    } else if (lookOnly !== undefined) {
      opened = await look(path, database, format, lookOnly, [], options);
    } else {
      try {
        opened = await own(path, database, format, options);
      } catch (error) {
        // Another process took the database between the look and the claim: looked at again, to attach to it.
        if (!(error instanceof DatabaseOwnedError) || attempt >= 2) {
          throw error;
        }
      }
    }
  }

  const { mode, access, attached, notices } = opened;
  const close = opened.close;
  let closed: Promise<void> | undefined;
  return {
    mode,
    database,
    format,
    access,
    notices,
    async status() {
      const base = { database, format, mode, notices: [...notices] };
      if (attached !== undefined && !(await attached.check())) {
        return { ...base, connected: false, disconnected: attached.disconnected ?? "The process that has the database open does not answer." };
      }
      try {
        return { ...base, connected: true, info: await access.info() };
      } catch (error) {
        return { ...base, connected: false, disconnected: error instanceof Error ? error.message : String(error) };
      }
    },
    close() {
      closed ??= close();
      return closed;
    },
  };
}
