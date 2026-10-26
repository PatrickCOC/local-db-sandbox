#!/usr/bin/env node
import { runCli } from "./cli.ts";

// Setting exitCode (not calling exit) lets pending output flush before the process ends.
process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  signals: process,
});
