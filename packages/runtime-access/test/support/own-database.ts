// A process that has a database open as a sandbox has it: it claims the database, opens it on the relational
// runtime, and serves the runtime's control. It prints one line of JSON when it is ready, and then carries out
// what it is told on stdin, one JSON value to a line, and answers each with one line:
//
//   { "sql": "<statement>" }     -> { "rows": [...], "affectedRows": n }    as the application runs its own SQL
//   { "begin": true }, { "commit": true }, { "rollback": true }             -> { "ok": true }
//   { "stop": true }             -> stops serving, lets go of the database, and ends
//
// Killed, it leaves its record behind, as a sandbox does that is killed. Used by the tests of attached access.
//
//   node own-database.ts <database> [kind]
import { createInterface } from "node:readline";
import { SqliteRuntime } from "../../../runtime/src/index.ts";
import { claimDatabase, openDatabaseStorage } from "../../../storage-json/src/index.ts";
import { serveRuntime } from "../../src/index.ts";

const [database, kind = "postgrest"] = process.argv.slice(2) as [string, string | undefined];
const say = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value)}\n`);

try {
  const claim = await claimDatabase(database, { kind: kind as "postgrest", persistence: "json" });
  const storage = openDatabaseStorage(database);
  const state = await storage.load();
  const runtime = await SqliteRuntime.open({ schema: storage.schema ?? [], storage, state, persistence: "json", context: () => ({ requestId: "application" }) });
  const served = await serveRuntime({ claim, runtime, format: storage.format });
  say({ ready: true, instance: claim.record.instance, pid: process.pid, startedAt: claim.record.startedAt, url: served.url });

  for await (const line of createInterface({ input: process.stdin })) {
    const told = JSON.parse(line) as { sql?: string; begin?: true; commit?: true; rollback?: true; stop?: true };
    try {
      if (told.stop) {
        await served.close();
        runtime.close();
        claim.release();
        say({ ok: true });
        process.exit(0);
      } else if (told.sql !== undefined) {
        const result = runtime.execute(told.sql);
        say({ rows: result.rows, affectedRows: result.affectedRows });
      } else {
        if (told.begin) {
          runtime.begin();
        } else if (told.commit) {
          runtime.commit();
        } else if (told.rollback) {
          runtime.rollback();
        }
        say({ ok: true });
      }
    } catch (error) {
      say({ error: error instanceof Error ? error.message : String(error) });
    }
  }
} catch (error) {
  say({ ready: false, message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
