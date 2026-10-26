import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { PersistenceMode } from "../../runtime/src/index.ts";
import { isRunning } from "./directory-files.ts";
import { JsonStorageError } from "./storage-error.ts";

/*
 * One process has a database open to write at a time (D-042).
 *
 * The storage alone cannot keep a second writer out: a directory refuses the
 * save of whoever is behind (D-025), which is after the fact, and a single
 * file refuses nothing. So a process that opens a database to write says so
 * first, in a record next to the database:
 *
 *   <database>.owner.json
 *   { "version", "pid", "startedAt", "instance", "kind", "database", "persistence"?, "control"? }
 *
 * Whoever finds a record of a live owner does not open the database to
 * write. A record whose owner is gone was left behind by a process that
 * ended without a chance to remove it, and is taken over. A live owner's is
 * never taken, and a record is removed only by the claim that made it.
 *
 * A command that replaces a database claims it in the same way, for as long
 * as that takes (`init --force`, D-043): one that a process has open is not
 * replaced under it.
 *
 * The record is no part of the database: it is beside it, not in it, and no
 * database format knows of it. An owner that serves its runtime to others
 * (the runtime's control, `packages/runtime-access`) says where in
 * `control`; that is also how a record is told from one whose process number
 * another process has by now.
 */

export const OWNER_RECORD_VERSION = 1;
/** After a database's path: its owner's record. */
export const OWNER_RECORD_SUFFIX = ".owner.json";
/** After a database's path: the mark of the process that is claiming or letting go right now. */
export const OWNER_MARK_SUFFIX = ".owner.lock";

/**
 * What a process that has a database open is. `init` is the command that
 * replaces a database (`init --force`): it has the database for as long as
 * that takes, so that it is replaced under no one (D-043).
 */
export type OwnerKind = "init" | "nest" | "postgrest" | "rest" | "simulate" | "sql" | "studio";

/** The kinds of owner that serve their runtime once they have started, so that Studio attaches to them. The others never do. */
export const SERVING_OWNER_KINDS: ReadonlySet<OwnerKind> = new Set(["nest", "postgrest", "studio"]);

/** Where an owner serves its runtime: on this machine only, to whoever has the token. */
export interface OwnerControl {
  url: string;
  token: string;
}

export interface OwnerRecord {
  version: typeof OWNER_RECORD_VERSION;
  pid: number;
  /** When the database was claimed. */
  startedAt: string;
  /** A name for this one claim, which nothing can guess: another run of the same program has another. */
  instance: string;
  kind: OwnerKind;
  /** The database, by its canonical path. */
  database: string;
  /** Whether the owner writes what is committed back (`json`), or keeps it in its memory. */
  persistence?: PersistenceMode;
  /** Absent while the owner starts, and for an owner that has no runtime to serve. */
  control?: OwnerControl;
}

/**
 * Whether the owner of a record answers where it says it serves: `alive`,
 * it does; `unresponsive`, something is there and does not answer in time;
 * `gone`, nothing listens there; `other`, what answers is not this owner.
 */
export type OwnerProbe = (record: OwnerRecord) => Promise<"alive" | "unresponsive" | "gone" | "other">;

export type OwnerInspection =
  | { state: "none" }
  /** `record` is absent for a record that is being written this moment. */
  | { state: "live"; record?: OwnerRecord; responsive: boolean }
  | { state: "stale"; record?: OwnerRecord; reason: string };

export interface OwnerOptions {
  /** How an owner that serves is asked whether it is there. Default: over HTTP, `GET <control.url>/health`. */
  probe?: OwnerProbe;
  /** How long to wait for another process that is claiming or letting go at this moment. Default: 2000 ms. */
  waitMs?: number;
}

export interface DatabaseClaim {
  /** The record as it is now. */
  readonly record: OwnerRecord;
  /** Says where this owner serves its runtime; `undefined`: nowhere any more. The database stays this owner's. */
  publish(control: OwnerControl | undefined): void;
  /** Lets go of the database: removes the record, if it is still this claim's. Harmless when done twice. */
  release(): void;
}

const KINDS: Record<string, string> = {
  init: "the init command, which is replacing it",
  nest: "the NestJS sandbox",
  postgrest: "the PostgREST endpoint",
  rest: "the REST sandbox",
  simulate: "the simulate command, which is writing a copy there",
  sql: "the SQL console",
  studio: "Local DB Studio",
};

/** What a kind of owner is called. */
export function describeOwnerKind(kind: string): string {
  return KINDS[kind] ?? `a sandbox process ("${String(kind)}")`;
}

/** What an owner is, in words. */
export function describeOwner(record: Pick<OwnerRecord, "kind" | "pid" | "startedAt">): string {
  return `${describeOwnerKind(record.kind)} (pid ${record.pid}, since ${record.startedAt})`;
}

/**
 * How a database goes from a Studio that has it to itself to a sandbox: in
 * three steps, each of them taken by whoever runs the two. Nothing lets go of
 * a database for another process, and nothing starts one.
 */
const STUDIO_HANDOVER =
  " That Studio has the database to itself. To run the sandbox on it: stop that Studio (Ctrl+C in its terminal), start the sandbox, and start Studio again. It then attaches to the sandbox, and both show the same rows.";

/** An owner's record without where it serves, which holds the owner's token. */
function withoutControl(record: OwnerRecord): Omit<OwnerRecord, "control"> {
  const { control: _served, ...who } = record;
  return who;
}

/** Another process has the database open to write. */
export class DatabaseOwnedError extends JsonStorageError {
  /**
   * Who has the database. Absent when the record is being written this moment.
   *
   * Never where that owner serves (`control`): whoever has the token there is
   * served the owner's runtime, and an error is printed with all it holds by
   * whoever catches it last (NestJS's exception handler, or Node itself).
   * That stays in the owner's record, where `inspectOwner` reads it.
   */
  readonly owner: Omit<OwnerRecord, "control"> | undefined;
  readonly recordPath: string;

  /** `claimer`: what the process that was refused is, when that is known. */
  constructor(database: string, owner: OwnerRecord | undefined, recordPath: string, claimer?: OwnerKind) {
    super(
      owner === undefined
        ? `${database} is being opened by another process right now. One process has a database open to write at a time. If no such process is there, delete ${recordPath}.`
        : `${database} is open in ${describeOwner(owner)}. One process has a database open to write at a time: stop that one first.` +
            // An owner that serves is asked whether it is there; of one that does not, only its process number is known.
            (owner.control === undefined ? ` If that process is gone, delete ${recordPath}.` : "") +
            // A sandbox that Studio attaches to is told how the database comes to it, and that Studio is not lost by it.
            (owner.kind === "studio" && claimer !== undefined && claimer !== "studio" && SERVING_OWNER_KINDS.has(claimer) ? STUDIO_HANDOVER : ""),
    );
    this.name = "DatabaseOwnedError";
    this.owner = owner === undefined ? undefined : withoutControl(owner);
    this.recordPath = recordPath;
  }
}

/** A record that cannot be read may be one that is being written: for this long. */
const UNREADABLE_GRACE_MS = 2000;
/** A mark that names no process and was not touched for this long was left by a process that did not finish. */
const MARK_STALE_MS = 5000;
const PROBE_TIMEOUT_MS = 1500;
const DEFAULT_WAIT_MS = 2000;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The one path of a database, whatever path led to it: links resolved, and
 * in the letters the file system has it in. Of a path that is not there, the
 * place it would be in.
 */
export function canonicalDatabasePath(database: string): string {
  const path = resolve(database);
  try {
    return realpathSync.native(path);
  } catch {
    try {
      return join(realpathSync.native(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/** Where the record of a database's owner is. */
export function ownerRecordPath(database: string): string {
  return `${canonicalDatabasePath(database)}${OWNER_RECORD_SUFFIX}`;
}

function isRecord(value: unknown): value is OwnerRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const control = record.control as Record<string, unknown> | undefined;
  return (
    record.version === OWNER_RECORD_VERSION &&
    Number.isInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.startedAt === "string" &&
    typeof record.instance === "string" &&
    record.instance.length > 0 &&
    typeof record.kind === "string" &&
    typeof record.database === "string" &&
    (control === undefined || (typeof control === "object" && control !== null && typeof control.url === "string" && typeof control.token === "string"))
  );
}

interface Seen {
  /** The record's text; `undefined` when there is none. */
  text: string | undefined;
  record?: OwnerRecord;
  /** For a record that cannot be read: how long it has not been touched. */
  untouchedMs?: number;
}

function look(recordPath: string): Seen {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const text = readFileSync(recordPath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (isRecord(parsed)) {
        return { text, record: parsed };
      }
      return { text, untouchedMs: Date.now() - statSync(recordPath).mtimeMs };
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { text: undefined };
      }
      // Being replaced this moment (Windows refuses a read then): look again.
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        throw cause;
      }
      pause(5);
    }
  }
}

function refused(error: unknown): boolean {
  for (let cause: unknown = error; typeof cause === "object" && cause !== null; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      return true;
    }
  }
  return false;
}

/** Where an owner serves: this machine's own address, on a port. A record is a file, and may say anything. */
const OWN_ADDRESS = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

/** Asks an owner that serves whether it is there: `GET <control.url>/health`, which answers with the owner's `instance`. */
export const probeOwnerControl: OwnerProbe = async (record) => {
  if (record.control === undefined) {
    return "alive";
  }
  if (!OWN_ADDRESS.test(record.control.url)) {
    // No owner serves anywhere else, so nothing is asked there, and the token goes nowhere.
    return "other";
  }
  try {
    // A connection of its own each time. One that is kept from the last time ends with a reset when the owner has gone
    // since, which reads as an owner that is there and does not answer.
    const response = await fetch(`${record.control.url}/health`, { headers: { authorization: `Bearer ${record.control.token}`, connection: "close" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = response.ok ? ((await response.json().catch(() => undefined)) as { instance?: unknown } | undefined) : undefined;
    return body?.instance === record.instance ? "alive" : "other";
  } catch (error) {
    // Nothing listens: the process that served there has ended. Anything else is an owner that is busy, or slow.
    return refused(error) ? "gone" : "unresponsive";
  }
};

async function assess(seen: Seen, probe: OwnerProbe): Promise<OwnerInspection> {
  if (seen.text === undefined) {
    return { state: "none" };
  }
  const record = seen.record;
  if (record === undefined) {
    return (seen.untouchedMs ?? 0) < UNREADABLE_GRACE_MS ? { state: "live", responsive: false } : { state: "stale", reason: "it cannot be read, and has not been touched for a while" };
  }
  if (!isRunning(record.pid)) {
    return { state: "stale", record, reason: `its process (pid ${record.pid}) is gone` };
  }
  if (record.control === undefined) {
    return { state: "live", record, responsive: true };
  }
  const answer = await probe(record);
  if (answer === "gone" || answer === "other") {
    const what = answer === "gone" ? "nothing listens where the owner served" : "what answers where the owner served is not the owner";
    return { state: "stale", record, reason: `its process number (${record.pid}) is another process's by now: ${what}` };
  }
  return { state: "live", record, responsive: answer === "alive" };
}

/** Who has a database open to write, if anyone. Changes nothing. */
export async function inspectOwner(database: string, options: OwnerOptions = {}): Promise<OwnerInspection> {
  return assess(look(ownerRecordPath(database)), options.probe ?? probeOwnerControl);
}

/**
 * Runs `action` as the one process that is claiming or letting go of the
 * database at this moment. The mark is held for file operations only, never
 * while anything is waited for.
 */
function marked<T>(markPath: string, database: string, waitMs: number, action: () => T): T {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const mark = openSync(markPath, "wx");
      try {
        writeSync(mark, String(process.pid));
      } finally {
        closeSync(mark);
      }
      break;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      // EPERM: Windows, while the mark of another process is being removed.
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") {
        throw cause;
      }
    }
    let holder = Number.NaN;
    let untouchedMs = 0;
    try {
      untouchedMs = Date.now() - statSync(markPath).mtimeMs;
      holder = Number(readFileSync(markPath, "utf8").trim() || Number.NaN);
    } catch {
      // Gone since it was found.
      continue;
    }
    const named = Number.isInteger(holder) && holder > 0;
    if (named ? !isRunning(holder) : untouchedMs > MARK_STALE_MS) {
      // Left by a process that did not finish.
      rmSync(markPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new JsonStorageError(`${database} is being claimed by another process (pid ${named ? holder : "unknown"}) and that has not ended. Try again; if no such process is there, delete ${markPath}.`);
    }
    pause(10);
  }
  try {
    return action();
  } finally {
    rmSync(markPath, { force: true });
  }
}

function write(recordPath: string, record: OwnerRecord): void {
  // Put in place in one step, so that whoever reads the record never finds half of one. Readable by its owner only, where the file system knows such a thing.
  const draft = `${recordPath}.${process.pid}.tmp`;
  writeFileSync(draft, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(draft, recordPath);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      // Windows: someone is reading the record this moment.
      if (attempt >= 50 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        rmSync(draft, { force: true });
        throw cause;
      }
      pause(5);
    }
  }
}

/** The claims of this process that have not been let go of: a process that ends lets go of them. */
const held = new Set<DatabaseClaim>();
let exitHandled = false;

/**
 * `claimDatabase` for whoever is about to open a database and says in its
 * own words when one is missing: a database that is not there is claimed by
 * no one, and `undefined` is returned.
 */
export async function claimDatabaseIfThere(database: string, owner: { kind: OwnerKind; persistence?: PersistenceMode }, options: OwnerOptions = {}): Promise<DatabaseClaim | undefined> {
  return existsSync(database) ? claimDatabase(database, owner, options) : undefined;
}

/**
 * Claims a database for this process: from now on no other process opens it
 * to write, until `release()`, or until this process is gone. Throws
 * `DatabaseOwnedError` when another process has it.
 */
export async function claimDatabase(database: string, owner: { kind: OwnerKind; persistence?: PersistenceMode }, options: OwnerOptions = {}): Promise<DatabaseClaim> {
  if (!existsSync(database)) {
    throw new JsonStorageError(`Database not found: ${database}`);
  }
  const canonical = canonicalDatabasePath(database);
  const recordPath = `${canonical}${OWNER_RECORD_SUFFIX}`;
  const markPath = `${canonical}${OWNER_MARK_SUFFIX}`;
  const probe = options.probe ?? probeOwnerControl;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  let current: OwnerRecord = {
    version: OWNER_RECORD_VERSION,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    instance: randomBytes(24).toString("hex"),
    kind: owner.kind,
    database: canonical,
    ...(owner.persistence !== undefined && { persistence: owner.persistence }),
  };

  let taken = false;
  for (let attempt = 0; attempt < 8 && !taken; attempt += 1) {
    const seen = look(recordPath);
    const found = await assess(seen, probe);
    if (found.state === "live") {
      throw new DatabaseOwnedError(database, found.record, recordPath, owner.kind);
    }
    // No record, or one that was left behind. What is there when the mark is held has to be what was looked at: another process may have claimed since.
    taken = marked(markPath, database, waitMs, () => {
      if (look(recordPath).text !== seen.text) {
        return false;
      }
      write(recordPath, current);
      return true;
    });
  }
  if (!taken) {
    throw new JsonStorageError(`${database} is being claimed by several processes at once. Try again.`);
  }

  const isMine = (): boolean => look(recordPath).record?.instance === current.instance;
  let released = false;
  const claim: DatabaseClaim = {
    get record() {
      return current;
    },
    publish(control) {
      marked(markPath, database, waitMs, () => {
        if (released || !isMine()) {
          throw new JsonStorageError(`${database} is not this process's any more: its owner's record (${recordPath}) is another's, or gone.`);
        }
        const { control: _served, ...rest } = current;
        current = control === undefined ? rest : { ...rest, control: { url: control.url, token: control.token } };
        write(recordPath, current);
      });
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      held.delete(claim);
      try {
        marked(markPath, database, waitMs, () => {
          // Only the record this claim made: another owner may have it by now.
          if (isMine()) {
            rmSync(recordPath, { force: true });
          }
        });
      } catch {
        // Left behind, as by a process that was killed: whoever comes next finds that its owner is gone.
      }
    },
  };
  held.add(claim);
  if (!exitHandled) {
    exitHandled = true;
    process.once("exit", () => [...held].forEach((each) => each.release()));
  }
  return claim;
}
