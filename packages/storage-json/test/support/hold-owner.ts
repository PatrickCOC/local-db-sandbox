// A process that claims a database and holds it until it is told to let go (a line on stdin) or is killed.
// It prints one line of JSON: whether it got the database. Used by the tests of writer ownership.
//
//   node hold-owner.ts <database> <kind> [startAt: a time in ms to wait for before claiming]
import { DatabaseOwnedError, claimDatabase } from "../../src/index.ts";

const [database, kind, startAt] = process.argv.slice(2) as [string, string, string | undefined];
if (startAt !== undefined) {
  // Several of these are started together and claim at the same moment.
  while (Date.now() < Number(startAt)) {
    // Spin: a timer would put them out of step.
  }
}
try {
  const claim = await claimDatabase(database, { kind: kind as "studio" });
  console.log(JSON.stringify({ claimed: true, instance: claim.record.instance, pid: process.pid }));
  process.stdin.once("data", () => {
    claim.release();
    process.exit(0);
  });
  // Held until then.
  setInterval(() => undefined, 1000);
} catch (error) {
  console.log(JSON.stringify({ claimed: false, owned: error instanceof DatabaseOwnedError, message: error instanceof Error ? error.message : String(error) }));
}
